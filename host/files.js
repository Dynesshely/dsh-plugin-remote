/**
 * A file manager over the workspace, with read-only previews on the side.
 *
 * The page cannot touch the filesystem, so the Host does it: listing directories, reading small text or
 * raw bytes, and applying the mutations the browser asks for. Every path is resolved against a workspace
 * root and rejected if the result escapes, for reads and writes alike — the client is never trusted to
 * stay inside.
 *
 * Hot-reloaded like the other route modules (see `hot.js`), so an edit here needs no DSH restart.
 */

import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

/** A directory listing stops here, so a huge folder cannot stall the request. */
const MAX_ENTRIES = 500
/** Text previews stop here; the file is reported as truncated instead of being refused. */
const MAX_PREVIEW_BYTES = 512 * 1024
/** Uploads stop here (decoded bytes). */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024
/** Folders that are never worth scrolling through in a sidebar. */
const HIDDEN = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', '.turbo'])
/** Extensions that are safe to show as text, plus a few extension-less names worth allowing. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini',
  '.cfg', '.conf', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.py', '.rs', '.go', '.java', '.kt',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.lua', '.sql', '.csv', '.tsv', '.log',
  '.diff', '.patch', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.env', '.lock',
])
/** Content types the raw route will claim, by extension. Anything else is served as a download. */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8',
}

/**
 * @param api - the shell context.
 * @param workspaceId - the requested workspace, or an empty string for the first one.
 * @returns `{ root, id, name }`, or undefined when no workspace has a path.
 */
async function resolveRoot (api, workspaceId) {
  const items = await api.workspaceTree()
  const list = Array.isArray(items) ? items : []
  const chosen = workspaceId === ''
    ? list.find((workspace) => String(workspace?.path ?? '') !== '') ?? list[0]
    : list.find((workspace) => String(workspace?.id ?? '') === String(workspaceId))
  if (chosen === undefined || String(chosen?.path ?? '') === '') return undefined
  const root = resolve(String(chosen.path))
  return {
    root,
    id: String(chosen?.id ?? ''),
    name: String(chosen?.title ?? chosen?.name ?? basename(root)),
  }
}

/**
 * @param root - the workspace root.
 * @param relative - a workspace-relative path, or absolute inside the root.
 * @returns the resolved path, or undefined when it would escape the root.
 */
function inside (root, relative) {
  const cleaned = String(relative ?? '').replace(/^[/\\]+/u, '')
  if (cleaned.split(/[/\\]+/u).includes('..')) return undefined
  const target = resolve(root, cleaned)
  if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined
  return target
}

/** @returns a workspace-relative path, with forward slashes, for the page to send back. */
function relativeTo (root, target) {
  return target === root ? '' : target.slice(root.length + 1).split(sep).join('/')
}

/** @returns one directory listing. */
function listing (rootInfo, relative) {
  const target = inside(rootInfo.root, relative)
  if (target === undefined) return { status: 400, body: { error: '路径超出了工作区' } }
  let info
  try {
    info = statSync(target)
  } catch {
    return { status: 404, body: { error: '目录不存在' } }
  }
  if (!info.isDirectory()) return { status: 400, body: { error: '不是一个目录' } }

  const entries = []
  let truncated = false
  let names
  try {
    names = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    return { status: 403, body: { error: String(error?.message ?? error) } }
  }
  for (const dirent of names) {
    if (HIDDEN.has(dirent.name)) continue
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const child = resolve(target, dirent.name)
    let stat
    try {
      stat = statSync(child)
    } catch {
      continue
    }
    const directory = stat.isDirectory()
    entries.push({
      name: dirent.name,
      kind: directory ? 'dir' : 'file',
      size: directory ? 0 : stat.size,
      mtime: stat.mtimeMs,
      ext: directory ? '' : extname(dirent.name).toLowerCase(),
    })
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  return {
    status: 200,
    body: {
      ok: true,
      root: { id: rootInfo.id, name: rootInfo.name },
      path: relativeTo(rootInfo.root, target),
      parent: target === rootInfo.root ? undefined : relativeTo(rootInfo.root, dirname(target)),
      entries,
      truncated,
    },
  }
}

/** @returns a text preview of one file, truncated when it is large. */
function preview (rootInfo, relative) {
  const target = inside(rootInfo.root, relative)
  if (target === undefined) return { status: 400, body: { error: '路径超出了工作区' } }
  let info
  try {
    info = statSync(target)
  } catch {
    return { status: 404, body: { error: '文件不存在' } }
  }
  if (!info.isFile()) return { status: 400, body: { error: '不是一个文件' } }
  const extension = extname(target).toLowerCase()
  const name = basename(target).toLowerCase()
  if (!TEXT_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(name)) {
    return { status: 415, body: { error: '这个类型不支持文本预览' } }
  }
  try {
    const bytes = readFileSync(target)
    const slice = bytes.subarray(0, MAX_PREVIEW_BYTES)
    return {
      status: 200,
      body: {
        ok: true,
        path: relativeTo(rootInfo.root, target),
        size: bytes.length,
        truncated: bytes.length > MAX_PREVIEW_BYTES,
        text: slice.toString('utf8'),
      },
    }
  } catch (error) {
    return { status: 403, body: { error: String(error?.message ?? error) } }
  }
}

/**
 * Serve raw bytes, with Range support so `<video>` can seek and a browser can render a PDF inline.
 * @returns the response, or undefined when the path is not a readable file.
 */
function raw (rootInfo, relative, request, response) {
  const target = inside(rootInfo.root, relative)
  if (target === undefined) {
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: '路径超出了工作区' }))
    return
  }
  let info
  try {
    info = statSync(target)
  } catch {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: '文件不存在' }))
    return
  }
  if (!info.isFile()) {
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: '不是一个文件' }))
    return
  }
  const extension = extname(target).toLowerCase()
  const type = MIME[extension] ?? 'application/octet-stream'
  const name = basename(target)
  const download = request.headers['x-rc-download'] === '1'
  const range = request.headers.range
  const headers = {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    ...(download ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
  }
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim())
    const start = match?.[1] === '' || match?.[1] === undefined ? undefined : Number(match[1])
    const end = match?.[2] === '' || match?.[2] === undefined ? undefined : Number(match[2])
    if (match !== null && (start !== undefined || end !== undefined)) {
      const from = start ?? Math.max(0, info.size - (end ?? 0))
      const to = Math.min(info.size - 1, end ?? info.size - 1)
      if (from <= to) {
        response.writeHead(206, {
          ...headers,
          'content-range': `bytes ${String(from)}-${String(to)}/${String(info.size)}`,
          'content-length': String(to - from + 1),
        })
        response.end(readFileSync(target).subarray(from, to + 1))
        return
      }
    }
  }
  response.writeHead(200, { ...headers, 'content-length': String(info.size) })
  response.end(readFileSync(target))
}

/**
 * Apply one mutation. Each branch re-validates every path against the root.
 * @returns a status and body for the page.
 */
async function mutate (api, rootInfo, body) {
  const action = String(body?.action ?? '')
  const source = inside(rootInfo.root, String(body?.path ?? ''))
  if (source === undefined) return { status: 400, body: { error: '路径超出了工作区' } }

  if (action === 'mkdir') {
    if (source === rootInfo.root) return { status: 400, body: { error: '不能在这里创建' } }
    mkdirSync(source, { recursive: false })
    return { status: 200, body: { ok: true } }
  }

  if (action === 'create') {
    if (source === rootInfo.root) return { status: 400, body: { error: '不能在这里创建' } }
    if (!source.startsWith(rootInfo.root)) return { status: 400, body: { error: '路径超出了工作区' } }
    writeFileSync(source, '', { flag: 'wx' })
    return { status: 200, body: { ok: true } }
  }

  if (action === 'rename' || action === 'move' || action === 'copy') {
    const target = inside(rootInfo.root, String(body?.to ?? ''))
    if (target === undefined || target === rootInfo.root) return { status: 400, body: { error: '目标路径无效' } }
    if (action === 'copy') {
      cpSync(source, target, { recursive: true, force: false })
    } else {
      // `renameSync` moves within a volume; across volumes the caller is asking for a move too.
      renameSync(source, target)
    }
    return { status: 200, body: { ok: true, path: relativeTo(rootInfo.root, target) } }
  }

  if (action === 'delete') {
    if (source === rootInfo.root) return { status: 400, body: { error: '不能删除工作区根目录' } }
    rmSync(source, { recursive: body?.recursive === true, force: false })
    return { status: 200, body: { ok: true } }
  }

  if (action === 'upload') {
    if (source === rootInfo.root) return { status: 400, body: { error: '不能覆盖工作区根目录' } }
    const match = /^data:[^;]+;base64,(.+)$/u.exec(String(body?.data ?? ''))
    if (match === null) return { status: 400, body: { error: '上传内容无效' } }
    const bytes = Buffer.from(match[1], 'base64')
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return { status: 413, body: { error: '文件超过 24 MB' } }
    writeFileSync(source, bytes)
    return { status: 200, body: { ok: true } }
  }

  if (action === 'save') {
    if (typeof body?.text !== 'string') return { status: 400, body: { error: '缺少内容' } }
    if (Buffer.byteLength(body.text) > MAX_PREVIEW_BYTES) return { status: 413, body: { error: '内容过长' } }
    writeFileSync(source, body.text, 'utf8')
    return { status: 200, body: { ok: true } }
  }

  return { status: 400, body: { error: `未知操作：${action}` } }
}

/**
 * 读取原始请求体，带上限。
 *
 * 上传路由的请求体就是文件字节本身，所以不能走 `readJson`：那会把整段 base64 正文先拼成字符串
 * 再 JSON.parse，宿主和页面各吃一次这份内存。超过上限立刻抛 `body too large`，调用方回 413。
 * 先看 `content-length` 是为了在客户端老实申报体积时直接拒绝，不必先把 20MB 收进内存。
 * @param request - 请求。
 * @param limit - 允许的最大字节数。
 * @returns 请求体字节。
 */
async function readBuffer (request, limit) {
  const declared = Number(request.headers['content-length'] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) throw new Error('body too large')
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Handle the file routes.
 * @param api - the shell context.
 * @returns whether the request was handled.
 */
export async function handleFiles (api) {
  const pathname = api.url.pathname
  const method = api.request.method ?? 'GET'
  if (!pathname.startsWith('/api/files')) return false
  if (method === 'GET' && pathname === '/api/files/raw') {
    const workspaceId = api.url.searchParams.get('workspaceId') ?? ''
    const rootInfo = await resolveRoot(api, workspaceId)
    if (rootInfo === undefined) {
      api.json(404, { error: '没有可浏览的工作区' })
      return true
    }
    raw(rootInfo, api.url.searchParams.get('path') ?? '', api.request, api.response)
    return true
  }
  // 二进制上传：请求体就是文件字节，绕开 data URL + JSON 那一整条主线程上的字符串路径。
  // 旧写法（`action: 'upload'` 加 data URL）保留在 `mutate` 里，老页面/旧链接照旧可用。
  if (method === 'POST' && pathname === '/api/files/upload') {
    const workspaceId = api.url.searchParams.get('workspaceId') ?? ''
    const rootInfo = await resolveRoot(api, workspaceId)
    if (rootInfo === undefined) {
      api.json(404, { error: '没有可浏览的工作区' })
      return true
    }
    const target = inside(rootInfo.root, api.url.searchParams.get('path') ?? '')
    if (target === undefined) {
      api.json(400, { error: '路径超出了工作区' })
      return true
    }
    if (target === rootInfo.root) {
      api.json(400, { error: '不能覆盖工作区根目录' })
      return true
    }
    let bytes
    try {
      bytes = await readBuffer(api.request, MAX_UPLOAD_BYTES)
    } catch (error) {
      if (String(error?.message ?? error) === 'body too large') {
        api.json(413, { error: '文件超过 24 MB' })
      } else {
        api.json(400, { error: '读取上传内容失败' })
      }
      return true
    }
    try {
      writeFileSync(target, bytes)
    } catch (error) {
      api.json(500, { error: String(error?.message ?? error) })
      return true
    }
    api.json(200, { ok: true })
    return true
  }
  if (method !== 'GET' && method !== 'POST') return false

  if (method === 'GET') {
    const workspaceId = api.url.searchParams.get('workspaceId') ?? ''
    const rootInfo = await resolveRoot(api, workspaceId)
    if (rootInfo === undefined) {
      api.json(404, { error: '没有可浏览的工作区' })
      return true
    }
    const relative = api.url.searchParams.get('path') ?? ''
    const result = pathname === '/api/files/text' ? preview(rootInfo, relative) : listing(rootInfo, relative)
    api.json(result.status, result.body)
    return true
  }

  // Mutations carry their workspace in the body, so it has to be read before the root is resolved.
  let body
  try {
    body = await api.readJson(api.request)
  } catch {
    api.json(400, { error: 'bad request' })
    return true
  }
  const rootInfo = await resolveRoot(api, String(body?.workspaceId ?? ''))
  if (rootInfo === undefined) {
    api.json(404, { error: '没有可浏览的工作区' })
    return true
  }
  try {
    const result = await mutate(api, rootInfo, body)
    api.json(result.status, result.body)
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}
