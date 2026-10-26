/**
 * Hot-reloadable routes: session management (pin / rename / fork / archive).
 *
 * `index.js` imports this module with an mtime-derived query string, so an edit here takes effect on
 * the next HTTP request instead of needing a DSH restart. Deliberately state-free: the mirrored
 * workspace sets and the session list stay in the shell and are passed in per request.
 *
 * The four actions go through the same Remotes the desktop client uses, and the mirrored sets come
 * back as complete lists — so a pin made here is instantly visible on the desktop, and one made there
 * arrives here through the shell's `workspaceController.follow()` subscription.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { handleModelMeta } from './model-meta.js'
/**
 * The usage module, re-imported whenever its file changes.
 *
 * It is a sibling module rather than part of this file, and Node caches modules by URL — so importing it
 * statically would freeze it for the life of the process. The mtime query is the same trick the shell
 * uses on this file, which is what makes an edit to the usage code take effect without a DSH restart.
 */
let usageModule = { module: undefined, mtimeMs: 0 }

/** @returns the freshly imported usage module. */
async function loadUsage () {
  const url = new URL('./usage.js', import.meta.url)
  const info = statSync(fileURLToPath(url))
  if (usageModule.module === undefined || usageModule.mtimeMs !== info.mtimeMs) {
    const fresh = new URL(url.href)
    fresh.searchParams.set('v', String(info.mtimeMs))
    usageModule = { module: await import(fresh.href), mtimeMs: info.mtimeMs }
  }
  return usageModule.module
}

/**
 * @param api - the shell context.
 * @returns whether the usage module handled the request.
 */
async function usageRoutes (api) {
  try {
    const module = await loadUsage()
    return await module.handleUsage(api)
  } catch (error) {
    api.json(500, { error: `usage module failed: ${String(error?.message ?? error)}` })
    return true
  }
}

/**
 * The file browser, re-imported whenever that module changes — the same trick the usage module uses, so
 * editing the browser does not need a DSH restart either.
 */
let filesModule = { module: undefined, mtimeMs: 0 }

/** @returns the freshly imported file-browser module. */
async function loadFiles () {
  const url = new URL('./files.js', import.meta.url)
  const info = statSync(fileURLToPath(url))
  if (filesModule.module === undefined || filesModule.mtimeMs !== info.mtimeMs) {
    const fresh = new URL(url.href)
    fresh.searchParams.set('v', String(info.mtimeMs))
    filesModule = { module: await import(fresh.href), mtimeMs: info.mtimeMs }
  }
  return filesModule.module
}

/**
 * @param api - the shell context.
 * @returns whether the file module handled the request.
 */
async function fileRoutes (api) {
  try {
    const module = await loadFiles()
    return await module.handleFiles(api)
  } catch (error) {
    api.json(500, { error: `files module failed: ${String(error?.message ?? error)}` })
    return true
  }
}

/** The desktop app's executable name, used when the Host does not run as the app itself. */
const APP_NAME = 'DeepSeek Harness.exe'

/** @returns the launcher this machine would start, so the page can show it and be trusted about it. */
function launcherPath () {
  const running = process.execPath
  if (running.toLowerCase().endsWith(APP_NAME.toLowerCase())) return running
  const local = process.env.LOCALAPPDATA ?? ''
  return local === '' ? running : `${local}\\Programs\\DeepSeek Harness\\${APP_NAME}`
}

/**
 * Start the out-of-process helper that closes (and optionally relaunches) DSH.
 *
 * It has to be a separate process: quitting DSH takes this Host down with it, so nothing inside would be
 * left to bring it back. The helper is detached and its stdio is ignored, which is what lets it outlive
 * the app it is about to close.
 * @param mode - `restart` or `exit`.
 * @param port - the remote-control port to watch, so the helper can tell the old instance is really gone.
 * @returns the helper's process id.
 */
async function spawnControl (mode, port) {
  const helper = fileURLToPath(new URL('../tools/dsh-control.mjs', import.meta.url))
  const launcher = launcherPath()
  const runtime = await nodeRuntime()
  const env = { ...process.env }
  // When the Host *is* the Electron binary, it must be told to behave like plain node to run a script.
  if (runtime === process.execPath && process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(runtime, [helper, mode, '--exe', launcher, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  })
  child.unref()
  return child.pid
}

/**
 * @returns a plain node executable to run the helper with.
 *
 * This matters more than it looks. The helper's job is to run `taskkill /IM "DeepSeek Harness.exe"`, which
 * matches by image name — so a helper started as the app's own executable would kill *itself* before it
 * could relaunch anything. That was the original bug: the app quit, and nothing came back. The bundled
 * node runtime has a different image name, so it survives the kill.
 *
 * The import is dynamic because the Host is the Electron binary: this is the only place that needs to
 * enumerate directories.
 */
async function nodeRuntime () {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home !== '') {
    try {
      const { readdirSync } = await import('node:fs')
      const root = `${home}\\.dsh\\dsh-runtimes`
      for (const name of readdirSync(root)) {
        const candidate = `${root}\\${name}\\dependencies\\node\\bin\\node.exe`
        if (existsSync(candidate)) return candidate
      }
    } catch {
      /* fall through to the app binary, which the helper will refuse and log */
    }
  }
  return process.execPath
}

/** @returns the parsed body, or undefined after the shell replied 400. */
async function bodyOf (api) {
  try {
    return await api.readJson(api.request)
  } catch {
    api.json(400, { error: 'bad request' })
    return undefined
  }
}

/** @returns the `workspaceController` service, or undefined when the Harness does not expose it. */
function controllerOf (api) {
  const controller = api.ctx.get('workspaceController')
  if (controller === undefined) api.json(503, { error: 'workspaceController 不可用（Harness 版本不支持会话管理）' })
  return controller
}

/**
 * Publish the new session list and the management sets to every open page.
 * @param api - the shell context.
 */
async function publish (api) {
  const payload = await api.sessionsPayload()
  api.broadcast('sessions', payload)
  return payload
}

/** Pin or unpin one Session. */
async function pin (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const controller = controllerOf(api)
  if (controller === undefined) return true
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') {
    api.json(400, { error: 'sessionId is required' })
    return true
  }
  try {
    const value = body.pinned === false
      ? await controller.unpinSession({ sessionId })
      : await controller.pinSession({ sessionId })
    api.setPinned(Array.isArray(value?.pinnedSessionIds) ? value.pinnedSessionIds : [])
    await publish(api)
    api.json(200, { ok: true, pinnedSessionIds: api.managementState().pinnedSessionIds })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/** Rename one Session (the title lives in the Session's title projection). */
async function rename (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const sessionId = String(body.sessionId ?? '')
  const title = String(body.title ?? '').trim()
  if (sessionId === '' || title === '') {
    api.json(400, { error: 'sessionId and a non-empty title are required' })
    return true
  }
  if (title.length > 200) {
    api.json(400, { error: '标题过长（上限 200 字）' })
    return true
  }
  try {
    const value = await api.ctx.sessionController.rename({ sessionId, title })
    await publish(api)
    api.json(200, { ok: true, title: String(value?.title ?? title) })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/**
 * Fork one Session from the last ended turn.
 *
 * `atSeq` is optional; leaving it out is exactly the "fork after the last completed turn" behaviour,
 * which is the only mode the page offers.
 */
async function fork (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') {
    api.json(400, { error: 'sessionId is required' })
    return true
  }
  const atSeq = Number.isSafeInteger(body.atSeq) ? body.atSeq : undefined
  try {
    const value = await api.ctx.sessionController.fork({ sessionId, ...(atSeq === undefined ? {} : { atSeq }) })
    await publish(api)
    api.json(200, { ok: true, sessionId: String(value?.sessionId ?? '') })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/** Archive or unarchive one Session, unpinning it on the way in like the desktop client does. */
async function archive (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const controller = controllerOf(api)
  if (controller === undefined) return true
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') {
    api.json(400, { error: 'sessionId is required' })
    return true
  }
  const archived = body.archived !== false
  try {
    const value = archived
      // `stopActivity` defaults to false: archiving must not kill work the user did not ask to stop.
      ? await controller.archiveSession({ sessionId, stopActivity: body.stopActivity === true })
      : await controller.unarchiveSession({ sessionId })
    api.setArchived(Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : [])
    if (archived && api.managementState().pinnedSessionIds.includes(sessionId)) {
      // Mirrors the desktop client: an archived Session is no longer pinned.
      try {
        const unpinned = await controller.unpinSession({ sessionId })
        api.setPinned(Array.isArray(unpinned?.pinnedSessionIds) ? unpinned.pinnedSessionIds : [])
      } catch {
        /* the follow stream will correct the set anyway */
      }
    }
    await publish(api)
    const state = api.managementState()
    api.json(200, { ok: true, archivedSessionIds: state.archivedSessionIds, pinnedSessionIds: state.pinnedSessionIds })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}


/**
 * Localized labels for the built-in presets.
 *
 * The registry returns bare ids (its own \`name\` is the id), while the desktop picker shows these
 * labels — so the page uses the same wording and falls back to the registry for anything unknown.
 */
const PRESET_LABELS = {
  standard: {
    name: '标准模式',
    description: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
  },
  ptc: {
    name: 'PTC 模式',
    description: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  },
  minimal: {
    name: '极简模式',
    description: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
  },
  cordis: {
    name: '创造模式',
    description: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
  },
}

/**
 * List the agent presets — the desktop's "模式" choices (标准 / PTC / 极简 / 创造 …).
 * @param api - the shell context.
 */
async function presets (api) {
  const registry = api.ctx.get('agentPresets')
  if (typeof registry?.list !== 'function') {
    api.json(200, { presets: [] })
    return true
  }
  try {
    const list = await registry.list()
    const items = (Array.isArray(list) ? list : [])
      .map((preset) => {
        const id = String(preset?.id ?? '')
        const label = PRESET_LABELS[id]
        return {
          id,
          name: label?.name ?? String(preset?.name ?? id),
          description: label?.description
            ?? (typeof preset?.description === 'string' ? preset.description : undefined),
          order: typeof preset?.order === 'number' ? preset.order : 0,
          broken: typeof preset?.broken === 'string' ? preset.broken : undefined,
        }
      })
      .filter((preset) => preset.id !== '')
      .sort((left, right) => left.order - right.order)
    api.json(200, { presets: items })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/** Create one Session in a workspace, optionally with an agent preset ("模式"). */
async function create (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const request = {}
  if (typeof body.workspaceId === 'string' && body.workspaceId !== '') request.workspaceId = body.workspaceId
  if (typeof body.cwd === 'string' && body.cwd !== '') request.cwd = body.cwd
  if (typeof body.agentPreset === 'string' && body.agentPreset !== '') request.agentPreset = body.agentPreset
  if (request.workspaceId === undefined && request.cwd === undefined) {
    api.json(400, { error: 'workspaceId 或 cwd 至少需要一个' })
    return true
  }
  try {
    const value = await api.ctx.sessionController.create(request)
    await publish(api)
    api.json(200, {
      ok: true,
      sessionId: String(value?.sessionId ?? ''),
      ...(typeof value?.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/** Everything the page needs to describe this Host, and to be trusted about restarting it. */
function dshInfo (api) {
  const launcher = launcherPath()
  api.json(200, {
    ok: true,
    launcher,
    launcherExists: existsSync(launcher),
    execPath: process.execPath,
    pid: process.pid,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    platform: process.platform,
  })
  return true
}

/** Restart or quit DSH through the detached helper. */
async function dshControl (api, mode) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const port = Number.isSafeInteger(body.port) && body.port > 0 ? body.port : 19400
  try {
    const pid = await spawnControl(mode, port)
    api.json(200, { ok: true, mode, port, pid, launcher: launcherPath() })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/**
 * One request from the shell.
 * @param api - `{ctx, request, url, json, readJson, broadcast, sessionsPayload, managementState, setPinned, setArchived}`.
 * @returns whether this module handled the request.
 */
export async function handle (api) {
  // Balance and usage live in their own module: the routes, the parsers and the stored keys together.
  if (await usageRoutes(api)) return true
  // Model capacity metadata, joined from the gateway catalogue.
  if (await handleModelMeta(api)) return true
  // Read-only file browser over the workspace.
  if (await fileRoutes(api)) return true
  const method = api.request.method
  if (method === 'GET') {
    if (api.url.pathname === '/api/presets') return await presets(api)
    if (api.url.pathname === '/api/dsh/info') return dshInfo(api)
    return false
  }
  if (method !== 'POST') return false
  switch (api.url.pathname) {
    case '/api/session/pin': return await pin(api)
    case '/api/session/rename': return await rename(api)
    case '/api/session/fork': return await fork(api)
    case '/api/session/archive': return await archive(api)
    case '/api/session/create': return await create(api)
    case '/api/dsh/restart': return await dshControl(api, 'restart')
    case '/api/dsh/exit': return await dshControl(api, 'exit')
    default: return false
  }
}
