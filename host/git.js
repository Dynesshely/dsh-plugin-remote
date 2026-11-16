import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Git state of a workspace, for the right column.
 *
 * Runs the real `git` binary rather than re-implementing the index: the working tree in a workspace is whatever
 * the user's own tooling says it is, and a partial re-implementation would disagree with it exactly where the
 * answer matters.
 */

/** @returns whether `dir` is inside a Git working tree. */
function findRepository (dir) {
  let current = resolve(dir)
  for (let depth = 0; depth < 40; depth += 1) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * @param root - directory to run in.
 * @param args - git arguments.
 * @returns `{ ok, stdout, stderr }`, never throwing.
 *
 * `windowsHide` and a synchronous call: git is a console program, and a console window flashing up on every
 * status refresh would be worse than the wait.
 */
function git (root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, stdout: '', stderr: String(result.error.message ?? result.error) }
  }
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * @param value - a `git status` path, which is quoted and escaped when it contains unusual characters.
 * @returns the plain path.
 *
 * Git quotes paths that contain spaces, quotes or non-ASCII bytes, and the quoting is C-style. Renaming a file
 * to something with a space would otherwise show up as `"a b.txt"` with the quotes in the list.
 */
function unquote (value) {
  if (!value.startsWith('"')) return value
  const body = value.slice(1, value.endsWith('"') ? -1 : undefined)
  try {
    return JSON.parse(`"${body.replace(/"/gu, '\\"')}"`)
  } catch {
    return body
  }
}

/**
 * @param root - repository root.
 * @returns the parsed branch header from `git status --porcelain=v2 --branch`.
 */
function readBranch (root) {
  const result = git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'])
  if (!result.ok) return {}
  const header = {}
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('# ')) continue
    const [key, ...rest] = line.slice(2).split(' ')
    header[key] = rest.join(' ')
  }
  return {
    branch: header['branch.head'],
    upstream: header['branch.upstream'],
    ahead: Number(header['branch.ab']?.split(' ')[0]?.replace('+', '') ?? 0) || 0,
    behind: Math.abs(Number(header['branch.ab']?.split(' ')[1]?.replace('-', '') ?? 0)) || 0,
    detached: header['branch.head'] === '(detached)',
    unborn: header['branch.oid'] === '(initial)',
  }
}

/**
 * @param root - repository root.
 * @returns every changed path, staged or not.
 *
 * `-z` keeps paths verbatim (no quoting, no escaping) and is the only form that survives a path containing a
 * newline, so the parsing below splits on NUL rather than on lines.
 */
function readChanges (root) {
  const result = git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  if (!result.ok) return undefined
  const parts = result.stdout.split('\u0000')
  const files = []
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]
    if (entry === '') continue
    const kind = entry[0]
    if (kind === '1') {
      // `<XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      const fields = entry.split(' ')
      if (fields.length < 9) continue
      const xy = fields[1]
      files.push({
        path: unquote(fields.slice(8).join(' ')),
        index: xy[0],
        worktree: xy[1],
      })
    } else if (kind === '2') {
      // Renames and copies carry the original path as the next NUL-separated part.
      const fields = entry.split(' ')
      if (fields.length < 10) continue
      const xy = fields[1]
      const original = unquote(parts[index + 1] ?? '')
      index += 1
      files.push({
        path: unquote(fields.slice(9).join(' ')),
        index: xy[0],
        worktree: xy[1],
        from: original,
      })
    } else if (kind === 'u') {
      const fields = entry.split(' ')
      if (fields.length < 11) continue
      files.push({ path: unquote(fields.slice(10).join(' ')), index: 'U', worktree: 'U', conflicted: true })
    } else if (kind === '?') {
      files.push({ path: unquote(entry.slice(2)), index: '?', worktree: '?', untracked: true })
    } else if (kind === '!') {
      files.push({ path: unquote(entry.slice(2)), index: '!', worktree: '!', ignored: true })
    }
  }
  return files
}

/**
 * @param api - request context carrying the workspace tree.
 * @returns the workspace the caller asked for, or the first one with a path.
 */
async function choseWorkspace (api, workspaceId) {
  const items = await api.workspaceTree()
  const list = Array.isArray(items) ? items : []
  if (workspaceId === '') {
    return list.find((workspace) => String(workspace?.path ?? '') !== '') ?? list[0]
  }
  return list.find((workspace) => String(workspace?.id ?? '') === String(workspaceId))
}

/** Directories never worth walking into: dependency trees and build output can hold thousands of entries. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'obj', 'bin', '.next', '.nuxt', '.cache',
  '.venv', 'venv', '__pycache__', 'vendor', '.gradle', '.idea', '.vs', 'coverage',
])

/** @returns whether `dir` itself is the root of a repository (a `.git` directory or a submodule file). */
function isRepositoryRoot (dir) {
  const marker = join(dir, '.git')
  try {
    // A submodule records `.git` as a file pointing at the parent's modules directory, so both shapes count.
    return existsSync(marker)
  } catch {
    return false
  }
}

/**
 * @param root - directory to walk.
 * @param limit - maximum number of repositories to return.
 * @returns every repository found inside `root`, including `root` itself.
 *
 * The walk is bounded on purpose: a workspace can hold a dependency tree with tens of thousands of directories,
 * and an unbounded scan would turn one request into a long stall. Depth, entry count and the usual build-output
 * folder names are all capped, and the result is sorted so the order is stable between refreshes.
 */
function scanRepositories (root, limit = 100) {
  const found = []
  let visited = 0
  const walk = (dir, depth) => {
    if (found.length >= limit || visited > 20000 || depth > 5) return
    visited += 1
    if (isRepositoryRoot(dir)) {
      found.push(dir)
      // A repository's own subdirectories can still contain other repositories, and those are wanted: a
      // workspace often holds several checkouts side by side.
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '.git' || SKIP_DIRECTORIES.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      walk(join(dir, entry.name), depth + 1)
      if (found.length >= limit || visited > 20000) return
    }
  }
  walk(root, 0)
  return found.sort((left, right) => left.localeCompare(right))
}

/**
 * @param api - request context.
 * @param workspaceId - the workspace to scan.
 * @returns `{ root, repositories: [{ path, name, relative }] }`.
 */
async function workspaceRepositories (api, workspaceId) {
  const workspace = await choseWorkspace(api, workspaceId)
  const path = String(workspace?.path ?? '')
  if (path === '') return { root: '', repositories: [], reason: '这个工作区没有路径' }
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) return { root: path, repositories: [], reason: '工作区目录不存在' }
  const repositories = scanRepositories(resolve(path)).map((repoPath) => ({
    path: repoPath,
    // A bare folder name is enough to tell two checkouts apart in the picker.
    name: repoPath === resolve(path) ? (workspace?.title || repoPath.split(/[\\/]/u).pop() || repoPath) : repoPath.split(/[\\/]/u).pop(),
    relative: repoPath === resolve(path) ? '' : repoPath.slice(resolve(path).length).replace(/^[\\/]/u, ''),
  }))
  return { root: resolve(path), repositories }
}

/**
 * `GET /api/git/repos?workspaceId=` — every repository inside the workspace.
 *
 * The right column needs this because a workspace is a folder, not a checkout: one workspace can hold several
 * repositories, and "which one" is the first thing a reader has to answer before any status means anything.
 */
export async function handleGitRepos (api) {
  if (api.request.method !== 'GET') return false
  if (api.url.pathname !== '/api/git/repos') return false
  const workspaceId = api.url.searchParams.get('workspaceId') ?? ''
  const tree = await api.workspaceTree()
  const list = Array.isArray(tree) ? tree : []
  const chosen = workspaceId === ''
    ? list.find((workspace) => String(workspace?.path ?? '') !== '') ?? list[0]
    : list.find((workspace) => String(workspace?.id ?? '') === String(workspaceId))
  const path = String(chosen?.path ?? '')
  if (path === '') {
    api.json(200, { ok: true, root: '', repositories: [], reason: '这个工作区没有路径' })
    return true
  }
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    api.json(200, { ok: true, root: path, repositories: [], reason: '工作区目录不存在' })
    return true
  }
  const repositories = scanRepositories(resolve(path)).map((repoPath) => ({
    path: repoPath,
    name: repoPath === resolve(path)
      ? String(chosen?.title ?? '')
      : repoPath.split(/[\\/]/u).pop(),
    relative: repoPath === resolve(path) ? '' : repoPath.slice(resolve(path).length).replace(/^[\\/]/u, ''),
  }))
  api.json(200, { ok: true, root: resolve(path), repositories })
  return true
}

/**
 * `GET /api/git/status?workspaceId=` — branch, tracking state and every changed path.
 *
 * Answers 200 with `isRepo: false` rather than an error when the workspace is not a repository: "no repository
 * here" is a normal answer for a folder the user happens to have open, not a failure to report.
 */
export async function handleGit (api) {
  if (api.request.method !== 'GET') return false
  if (api.url.pathname !== '/api/git/status') return false
  const workspace = await choseWorkspace(api, api.url.searchParams.get('workspaceId') ?? '')
  const requested = api.url.searchParams.get('repo') ?? ''
  const path = String(workspace?.path ?? '')
  if (path === '') {
    api.json(200, { ok: true, isRepo: false, reason: '这个工作区没有路径' })
    return true
  }
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    api.json(200, { ok: true, isRepo: false, reason: '工作区目录不存在' })
    return true
  }
  // A chosen repository wins: the workspace may hold several checkouts, and the reader picked one.
  const root = requested !== '' ? findRepository(requested) : findRepository(path)
  if (root === undefined) {
    api.json(200, { ok: true, isRepo: false, reason: requested !== '' ? '这个目录不在 Git 仓库中' : '这个工作区不在 Git 仓库中' })
    return true
  }
  const changes = readChanges(root)
  if (changes === undefined) {
    const failure = git(root, ['status'])
    api.json(200, { ok: false, isRepo: true, root, error: failure.stderr.trim() || 'git status 执行失败' })
    return true
  }
  api.json(200, {
    ok: true,
    isRepo: true,
    root,
    relativeRoot: root === resolve(path) ? '' : path.slice(root.length).replace(/^[\\/]/u, ''),
    ...readBranch(root),
    files: changes,
  })
  return true
}

/**
 * `GET /api/git/diff?workspaceId=&path=&staged=` — the patch for one file.
 *
 * Reading a diff is what turns the status list into something actionable: which lines changed, and whether a
 * change is already staged.
 */
export async function handleGitDiff (api) {
  if (api.request.method !== 'GET') return false
  if (api.url.pathname !== '/api/git/diff') return false
  const target = api.url.searchParams.get('path') ?? ''
  if (target === '') {
    api.json(400, { error: 'path is required' })
    return true
  }
  const workspace = await choseWorkspace(api, api.url.searchParams.get('workspaceId') ?? '')
  const requested = api.url.searchParams.get('repo') ?? ''
  const root = findRepository(requested !== '' ? requested : String(workspace?.path ?? ''))
  if (root === undefined) {
    api.json(200, { ok: false, error: '这个工作区不在 Git 仓库中' })
    return true
  }
  const staged = api.url.searchParams.get('staged') === '1'
  const args = staged ? ['diff', '--cached', '--', target] : ['diff', '--', target]
  let result = git(root, args)
  // An untracked file has no diff; show its contents instead, which is what a reader wants to look at.
  if (result.ok && result.stdout.trim() === '') {
    const file = join(root, target)
    try {
      if (statSync(file).isFile() && statSync(file).size <= 512 * 1024) {
        result = git(root, ['diff', '--no-index', '--', '/dev/null', target])
      }
    } catch {
      /* not a file: leave the empty diff alone */
    }
  }
  api.json(200, {
    ok: result.ok,
    patch: result.stdout,
    error: result.ok ? undefined : result.stderr.trim() || '无法读取差异',
  })
  return true
}
