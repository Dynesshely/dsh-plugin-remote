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

/**
 * One request from the shell.
 * @param api - `{ctx, request, url, json, readJson, broadcast, sessionsPayload, managementState, setPinned, setArchived}`.
 * @returns whether this module handled the request.
 */
export async function handle (api) {
  const method = api.request.method
  if (method === 'GET') {
    if (api.url.pathname === '/api/presets') return await presets(api)
    return false
  }
  if (method !== 'POST') return false
  switch (api.url.pathname) {
    case '/api/session/pin': return await pin(api)
    case '/api/session/rename': return await rename(api)
    case '/api/session/fork': return await fork(api)
    case '/api/session/archive': return await archive(api)
    case '/api/session/create': return await create(api)
    default: return false
  }
}
