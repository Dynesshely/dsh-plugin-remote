import { computed, reactive } from 'vue'
import { api, openStream, UnauthorizedError } from './api.js'
import { parseQuestionArgs, parseQuestionResult } from './questions.js'
import {
  EMPTY_SNAPSHOT_PROGRESS,
  FAIL_AFTER_MS,
  nextSnapshotProgress,
  SLOW_AFTER_MS,
} from './loading.js'

/** Everything the shell renders; Session events are folded into `events` and `telemetry` here. */
export const state = reactive({
  /** Fingerprint of the Session list, so an unchanged catalog is not re-applied. */
  sessionFingerprint: '',
  /** Set once the boot request has failed, so the page can offer a retry instead of a blank screen. */
  bootError: '',
  /** True once a Session switch has been waiting long enough to be worth admitting. */
  sessionSlow: false,
  /** True once a Session switch has been given up on; the page offers a retry. */
  sessionFailed: false,
  /** Message from the last failed "load earlier" attempt. */
  olderError: '',
  /** True once paging backwards has been waiting long enough to be worth admitting. */
  olderSlow: false,
  /** Text-only mode: fewer bytes moved, no glass, no motion. */
  lightweight: false,
  /** How much of the opening snapshot has arrived, for the progress pill. */
  snapshotProgress: { ...EMPTY_SNAPSHOT_PROGRESS },
  /** When the current snapshot started, on the monotonic clock. */
  snapshotStartedAt: 0,
  /** How long the opening snapshot took, in milliseconds. */
  snapshotMs: 0,
  /** True for a short while after a slow load finishes, so the completion notice is actually seen. */
  snapshotFlash: false,
  booted: false,
  unauthorized: false,
  bootError: '',
  bind: '',
  workspaces: [],
  sessions: [],
  /** Pinned/archived Session ids, mirrored from the same workspace controller the desktop reads. */
  pinnedSessionIds: [],
  archivedSessionIds: [],
  /** True once the workspace controller mirror is live, so the menu knows management is available. */
  managed: false,
  /** Agent presets ("模式") the create dialog offers. */
  presets: [],
  /** Per-Session telemetry snapshots the Host keeps, keyed by Session id. */
  telemetryBySession: {},
  selected: undefined,
  /** True from switching to a Session until its first snapshot arrives. */
  sessionLoading: false,
  pending: { questions: [], approvals: [] },
  events: [],
  /** True while another backward history page is in flight. */
  loadingOlder: false,
  /** Cleared once a backward page comes back empty, so the button disappears at the start of a log. */
  hasOlder: true,
  live: { attemptId: undefined, text: '', reasoning: '' },
  streamError: '',
  actionError: '',
  models: { groups: [], defaultSelection: undefined },
  selection: undefined,
  permissions: { options: [], defaultPreset: '', current: undefined },
  telemetry: {
    turn: 0,
    step: 0,
    running: false,
    provider: '',
    model: '',
    contextWindow: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalReasoning: 0,
    lastInput: 0,
    tokensPerSecond: 0,
    streamStartedAt: 0,
  },
})

/** The Session the sidebar should show as active. */
export const selectedSession = computed(() => state.sessions.find((session) => session.id === state.selected))

/** Sessions grouped by workspace, in the deployment's workspace order. */
export const groupedSessions = computed(() => {
  const byWorkspace = new Map()
  for (const workspace of state.workspaces) {
    byWorkspace.set(workspace.id, { ...workspace, sessions: [] })
  }
  const orphans = { id: '__none__', title: '未归档', path: '', sessions: [] }
  // Archived Sessions stay reachable but out of the way, like the desktop's archived section.
  const archived = []
  for (const session of state.sessions) {
    if (state.archivedSessionIds.includes(session.id)) {
      archived.push(session)
      continue
    }
    const group = byWorkspace.get(session.workspaceId)
    if (group === undefined) orphans.sessions.push(session)
    else group.sessions.push(session)
  }
  const groups = [...byWorkspace.values()].filter((group) => group.sessions.length > 0)
  // Pinned first, then most recently used — the ordering the desktop list uses.
  const order = (left, right) => (pinnedRank(right) - pinnedRank(left)) || (right.updatedAt - left.updatedAt)
  for (const group of groups) group.sessions.sort(order)
  if (orphans.sessions.length > 0) {
    orphans.sessions.sort(order)
    groups.push(orphans)
  }
  archived.sort(order)
  return { groups, archived }
})

/** @returns 1 for a pinned Session, 0 otherwise, so a plain sort floats pins to the top. */
function pinnedRank (session) {
  return state.pinnedSessionIds.includes(session.id) ? 1 : 0
}

/** @returns whether a Session is pinned. */
export function isPinned (sessionId) {
  return state.pinnedSessionIds.includes(String(sessionId))
}

/**
 * Render items for the transcript: messages, paired tool calls, and turn notices.
 * Tool results are attached to the call they answer, so one card shows both halves.
 */
/**
 * Reused item objects, keyed by item key.
 *
 * `transcriptItems` runs on every appended event. Rebuilding the items is cheap; re-rendering them is
 * not — each row re-runs Markdown, highlighting and sanitising. Vue skips a child update when its
 * props are unchanged, so handing back the *same* objects for unchanged rows is what keeps a long
 * transcript cheap. Signatures only ever look at append-only quantities (lengths, counts, flags),
 * which is exactly how these items change.
 */
const itemCache = new Map()
const groupCache = new Map()

/**
 * @returns a signature that changes whenever the rendered content of an item would change.
 *
 * Every field is read defensively. This runs over the whole transcript on every pass, so one unexpected
 * shape — an item built by a different branch — would otherwise throw and leave the reader with nothing
 * at all, which is exactly what an orphan tool result used to do.
 */
function signatureOf (item) {
  if (item.kind === 'user') {
    return `user|${String(item.text ?? '')}|${String(item.notes?.length ?? 0)}|${String(item.images?.length ?? 0)}|${String(item.files?.length ?? 0)}`
  }
  if (item.kind === 'assistant') {
    return `assistant|${String(item.text?.length ?? 0)}|${String(item.reasoning?.length ?? 0)}|${String(item.images?.length ?? 0)}|${String(item.files?.length ?? 0)}`
  }
  if (item.kind === 'tool') {
    return `tool|${String(item.name ?? '')}|${String(item.args?.length ?? 0)}|${String(item.result?.length ?? -1)}|${String(item.error ?? '')}|${String(item.answers?.length ?? 0)}`
  }
  return `${String(item.kind)}|${String(item.text ?? '')}`
}

/**
 * @param item - a freshly built item.
 * @returns the cached object when nothing about it changed, otherwise the new one.
 */
function stabilize (item) {
  const previous = itemCache.get(item.key)
  if (previous !== undefined && previous.signature === signatureOf(item)) return previous.item
  const record = { signature: signatureOf(item), item }
  itemCache.set(item.key, record)
  return item
}

/** Groups are rebuilt each pass, so they are matched by name, count and child identity. */
function stabilizeGroup (group) {
  const previous = groupCache.get(group.key)
  const same = previous !== undefined
    && previous.group.name === group.name
    && previous.group.count === group.count
    && previous.group.items.length === group.items.length
    && previous.group.items.every((child, index) => child === group.items[index])
  if (same) return previous.group
  groupCache.set(group.key, { group })
if (groupCache.size > 4000) groupCache.clear()
  return group
}

/** Drop cached objects for a transcript that is being replaced wholesale. */
function resetTranscriptCache () {
  itemCache.clear()
  groupCache.clear()
}

/** Parsed message parts, keyed by the message object they came from. */
const partsCache = new WeakMap()

/** How many events are kept in memory before the oldest are dropped. */
const MAX_EVENTS = 2000

/**
 * @param sessions - the Session list from the Host.
 * @param pinned - pinned ids.
 * @param archived - archived ids.
 * @returns a fingerprint of everything the sidebar draws from.
 */
function sessionFingerprint (sessions, pinned, archived) {
  const rows = sessions.map((session) => `${session.id}:${String(session.updatedAt ?? '')}:${String(session.title ?? '')}:${session.running === true ? '1' : '0'}`)
  return `${rows.join('|')}~${pinned.join(',')}~${archived.join(',')}`
}

export const transcriptItems = computed(() => {
  const items = []
  const toolIndex = new Map()
  /** The most recent prompt, so injected notes can be folded into its bubble. */
  let lastUser = null
  /** Accumulators for the turn being walked, emitted as one stats item when it ends. */
  let turnStats = null
  for (const event of state.events) {
    const type = event.type
    const data = event.data ?? {}
    if (type === 'user/message') {
      const parts = messageParts(data)
      // Harness-injected context (time readings, runtime snapshots) is a user turn in the log, but it
      // is metadata: it belongs in the bubble of the prompt it belongs to, never as its own prompt.
      if (isContextNote(data, parts.text)) {
        const note = {
          text: parts.text,
          ...(typeof data.source?.kind === 'string' ? { sourceKind: data.source.kind } : {}),
        }
        if (lastUser !== null) lastUser.notes.push(note)
        else items.push({ kind: 'context', key: `context-${String(event.seq)}`, ...note })
        continue
      }
      const item = {
        kind: 'user',
        key: `user-${String(event.seq)}`,
        text: parts.text,
        files: parts.files,
        images: parts.images,
        notes: [],
      }
      items.push(item)
      lastUser = item
      continue
    }
    if (type === 'turn/start') {
      turnStats = {
        turn: Number(data.turn ?? 0),
        startedAt: typeof event.time === 'number' ? event.time : Date.now(),
        output: 0,
        input: 0,
        cache: 0,
        steps: 0,
      }
      continue
    }
    if (type === 'step/start' && turnStats !== null) {
      turnStats.steps = Math.max(turnStats.steps, Number(data.step ?? 0))
      continue
    }
    if (type === 'assistant/message') {
      if (turnStats !== null && data.usage !== undefined) {
        turnStats.output += Number(data.usage.outputTokens ?? 0)
        turnStats.input += Number(data.usage.inputTokens ?? 0)
        turnStats.cache += Number(data.usage.cacheReadTokens ?? 0) + Number(data.usage.cacheWriteTokens ?? 0)
      }
      const parts = messageParts(data.message)
      // A step that only calls tools carries no text, reasoning, or media. Rendering it would add
      // an invisible item between two tool calls and break their run into separate cards.
      if (parts.text === '' && parts.reasoning === '' && parts.images.length === 0 && parts.files.length === 0) continue
      items.push({
        kind: 'assistant',
        key: `assistant-${String(event.seq)}`,
        text: parts.text,
        reasoning: parts.reasoning,
        files: parts.files,
        images: parts.images,
      })
      continue
    }
    if (type === 'tool/call') {
      const name = String(data.name ?? 'tool')
      const args = String(data.arguments ?? '')
      const item = {
        kind: 'tool',
        key: `tool-${String(event.seq)}`,
        callId: String(data.callId ?? event.seq),
        name,
        args,
        // `ask_user_question` renders as a question card instead of a JSON tool card.
        questions: parseQuestionArgs(name, args),
        answers: [],
        result: undefined,
        error: undefined,
      }
      toolIndex.set(item.callId, item)
      items.push(item)
      continue
    }
    if (type === 'tool/result') {
      const callId = String(data.message?.toolCallId ?? '')
      const item = toolIndex.get(callId)
      if (item !== undefined) {
        item.result = blocksToText(data.message)
        item.answers = item.questions.length > 0 ? parseQuestionResult(item.result) : []
        item.error = data.error === undefined ? undefined : String(data.error.name ?? 'error')
      } else {
        // A result whose call is not in the window — which is normal when a long Session opens part-way
        // through a run — still has to be a complete tool item: the renderer and the identity cache both
        // read every field, and a missing one used to take the whole transcript down.
        items.push({
          kind: 'tool',
          key: `tool-result-${String(event.seq)}`,
          callId,
          name: 'tool',
          args: '',
          questions: [],
          answers: [],
          result: blocksToText(data.message),
          error: data.error === undefined ? undefined : String(data.error.name ?? 'error'),
        })
      }
      continue
    }
    if (type === 'turn/end') {
      const reason = data.reason?.kind
      if (reason !== undefined && reason !== 'completed') {
        items.push({ kind: 'notice', key: `turn-${String(event.seq)}`, text: `本轮结束：${String(reason)}` })
      }
      // One stats row per finished turn, so each answer carries what it cost.
      if (turnStats !== null) {
        const endedAt = typeof event.time === 'number' ? event.time : Date.now()
        const seconds = Math.max(0, (endedAt - turnStats.startedAt) / 1000)
        items.push({
          kind: 'turnStats',
          key: `turn-stats-${String(event.seq)}`,
          seconds,
          output: turnStats.output,
          input: turnStats.input,
          cache: turnStats.cache,
          steps: turnStats.steps,
          perSecond: seconds > 0.2 && turnStats.output > 0 ? turnStats.output / seconds : 0,
        })
        turnStats = null
      }
      continue
    }
    if (type === 'model-retry' || type === 'turn-error') {
      items.push({ kind: 'notice', key: `error-${String(event.seq)}`, text: `${type}：${JSON.stringify(data).slice(0, 300)}` })
    }
  }
  // Consecutive calls of one tool second-level collapse into a group card, so a run of five
  // `read` calls reads as "5 × read" (expandable to the five cards) instead of five rows.
  const grouped = []
  for (const item of items) {
    const previous = grouped.at(-1)
    if (item.kind === 'tool' && previous?.kind === 'toolGroup' && previous.name === item.name) {
      previous.items.push(item)
      previous.count = previous.items.length
      continue
    }
    if (item.kind === 'tool' && previous?.kind === 'tool' && previous.name === item.name) {
      grouped[grouped.length - 1] = {
        kind: 'toolGroup',
        key: `tool-group-${previous.key}`,
        name: item.name,
        count: 2,
        items: [previous, item],
      }
      continue
    }
    grouped.push(item)
  }
  // Prune first: the caches only need to outlive the transcript window.
  if (itemCache.size > 4000) resetTranscriptCache()
  return grouped.map((item) => (item.kind === 'toolGroup' ? stabilizeGroup(item) : stabilize(item)))
})

/* ---------------------------------------------------------------- context notes */

/**
 * Opening lines of context snapshots the Harness injects into a Session log as user turns.
 * Only used as a fallback: injections normally mark themselves through `source.kind`.
 */
const CONTEXT_NOTE_PREFIXES = [
  'Time sampled while preparing turn ',
  'Elapsed since the preceding ',
  'Current runtime context. This snapshot supersedes',
]

/**
 * Whether a `user/message` entry is Harness-injected context rather than something the user typed.
 *
 * Injections identify their producer with a `source.kind` other than `user` (the time-context plugin
 * uses `time-context`), which is authoritative. A few well-known snapshots are also recognised by
 * their exact opening line, in case a producer forwards them without that marker.
 * @param data - the `user/message` event payload.
 * @param text - the text already extracted from it.
 * @returns true when the entry should render as a subdued note and stay out of the prompt rail.
 */
export function isContextNote (data, text = '') {
  const kind = data?.source?.kind
  if (typeof kind === 'string' && kind !== 'user') return true
  const opening = String(text).trimStart()
  return CONTEXT_NOTE_PREFIXES.some((prefix) => opening.startsWith(prefix))
}

/**
 * Split a message's content blocks into the parts the transcript renders separately.
 *
 * Reasoning is kept out of the visible text so the transcript can collapse it by default, and
 * tool calls are dropped entirely: the transcript already renders each one as its own card, so
 * repeating the names in the text would print "read read read…" under the answer.
 * @param message - a wire message carrying `content` blocks.
 * @returns `{ text, reasoning, files }`.
 */
export function messageParts (message) {
  const cached = partsCache.get(message)
  if (cached !== undefined) return cached
  const parts = computeMessageParts(message)
  partsCache.set(message, parts)
  return parts
}

/** @returns the parsed parts, computed once per message object. */
function computeMessageParts (message) {
  const text = []
  const reasoning = []
  const files = []
  const images = []
  if (message === null || message === undefined) return { text: '', reasoning: '', files, images }
  if (typeof message === 'string') return { text: message, reasoning: '', files, images }
  const content = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content
  if (!Array.isArray(content)) return { text: '', reasoning: '', files, images }
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') text.push(String(block.text ?? ''))
    else if (block.type === 'reasoning') reasoning.push(String(block.text ?? ''))
    else if (block.type === 'image') {
      const attachment = block.attachment ?? {}
      images.push({
        attachmentId: String(attachment.attachmentId ?? ''),
        mediaType: String(attachment.mediaType ?? 'image/png'),
        name: attachment.name,
      })
      // No "🖼 图片" label: images render as thumbnails in the bubble itself.
    } else if (block.type === 'file') files.push(`📎 ${String(block.attachment?.name ?? '文件')}`)
  }
  return { text: text.join('\n'), reasoning: reasoning.join('\n'), files, images }
}

/* ---------------------------------------------------------------- attachment images */

/** Fetched attachment data URLs, keyed by `<sessionId>:<attachmentId>`. */
const attachmentImages = reactive(new Map())
/** Keys with a fetch in flight, so one image is requested once. */
const attachmentPending = new Set()

/**
 * Fetch one attachment's bytes through the Host and remember them.
 * Idempotent, so a component can call it from a watcher on every change.
 * @param sessionId - the Session whose log proves the attachment.
 * @param attachmentId - durable attachment identity.
 */
export function ensureAttachmentImage (sessionId, attachmentId) {
  // Text-only mode moves no image bytes at all: attachments are base64 payloads and the most expensive
  // thing the page can ask for over a slow link.
  if (state.lightweight) return
  if (sessionId === undefined || sessionId === null || attachmentId === '') return
  const key = `${sessionId}:${attachmentId}`
  if (attachmentImages.has(key) || attachmentPending.has(key)) return
  attachmentPending.add(key)
  api(`/api/attachment?sessionId=${encodeURIComponent(sessionId)}&attachmentId=${encodeURIComponent(attachmentId)}`)
    .then((payload) => {
      attachmentImages.set(key, payload.data === '' ? '' : `data:${payload.mediaType};base64,${payload.data}`)
    })
    .catch(() => {
      attachmentImages.set(key, '')
    })
    .finally(() => {
      attachmentPending.delete(key)
    })
}

/** @returns the cached data URL for an attachment, or an empty string while it loads. */
export function attachmentImage (sessionId, attachmentId) {
  return attachmentImages.get(`${String(sessionId)}:${String(attachmentId)}`) ?? ''
}

/** @returns the joined text of a message's content blocks (tool results and other summaries). */
export function blocksToText (message) {
  const parts = messageParts(message)
  return [parts.text, ...parts.files].filter((part) => part !== '').join('\n')
}

/** Load the Session catalog, workspaces, and pending interactions. */
export async function loadState () {
  try {
    const payload = await api('/api/state')
    state.bind = payload.bind ?? ''
    // Replacing the array re-renders the whole sidebar, and the Host's status broadcasts fire this
    // loader repeatedly. When nothing the sidebar draws from has changed, the array is left alone.
    const sessions = payload.sessions ?? []
    installManagement(payload)
    const fingerprint = sessionFingerprint(sessions, state.pinnedSessionIds, state.archivedSessionIds)
    if (fingerprint !== state.sessionFingerprint) {
      state.sessionFingerprint = fingerprint
      state.sessions = sessions
    }
    state.workspaces = payload.workspaces ?? []
    state.pending = payload.pending ?? { questions: [], approvals: [] }
    if (payload.telemetry !== undefined) state.telemetryBySession = payload.telemetry
    state.unauthorized = false
    state.bootError = ''
    state.booted = true
    if (state.selected === undefined) {
      const running = state.sessions.find((session) => session.running)
      const first = running ?? state.sessions[0]
      // Restore where the page was left, when that Session is still in the list. A remembered id that has
    // since been archived away falls back to the first Session, so a reload can never land on nothing.
    const remembered = rememberedSession()
    const restored = remembered === ''
      ? undefined
      : state.sessions.find((session) => session.id === remembered)
    const initial = restored ?? first
    if (initial !== undefined) await selectSession(initial.id)
    }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      state.unauthorized = true
      state.booted = true
      return
    }
    state.bootError = String(error.message ?? error)
    state.booted = true
  }
}

/** Load the model catalog once. */
export async function loadModels () {
  try {
    const payload = await api('/api/models')
    state.models = { groups: payload.groups ?? [], defaultSelection: payload.default }
  } catch {
    /* the catalog is optional */
  }
}

/** Load the permission catalog once. */
export async function loadPermissions (sessionId) {
  try {
    const payload = await api(`/api/permissions?sessionId=${encodeURIComponent(sessionId ?? '')}`)
    state.permissions = {
      options: payload.options ?? [],
      defaultPreset: payload.defaultPreset ?? '',
      current: payload.current,
    }
  } catch {
    /* the catalog is optional */
  }
}

let source
let refreshTimer

/**
 * Re-read the catalog soon, coalescing bursts.
 *
 * The status broadcast carries no workspace membership, so the grouped sidebar is re-listed from
 * `/api/state` shortly after it fires.
 */
function refreshSoon () {
  if (refreshTimer !== undefined) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined
    void loadState()
  }, 1200)
}

/** Timers for "this is taking a while" notices, one per surface. */
const slowTimers = new Map()

/**
 * @param key - the surface, e.g. `session`.
 * @param onSlow - called once after SLOW_AFTER_MS, unless cancelled first.
 */
function watchSlow (key, onSlow) {
  clearSlowWatch(key)
  slowTimers.set(key, window.setTimeout(() => {
    slowTimers.delete(key)
    onSlow()
  }, SLOW_AFTER_MS))
}

/** @param key - the surface to stop watching. */
function clearSlowWatch (key) {
  const timer = slowTimers.get(key)
  if (timer === undefined) return
  window.clearTimeout(timer)
  slowTimers.delete(key)
}

/** Timer that hides the completion notice again. */
let snapshotFlashTimer

/** @returns a monotonic millisecond reading, for load durations. */
function nowMs () {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/** Clear the completion notice and its timer. */
function clearSnapshotNotice () {
  if (snapshotFlashTimer !== undefined) {
    window.clearTimeout(snapshotFlashTimer)
    snapshotFlashTimer = undefined
  }
  state.snapshotFlash = false
}

/** Record one snapshot chunk and, on the last one, decide whether the completion notice is worth showing. */
function trackSnapshot (frame) {
  const wasDone = state.snapshotProgress.done === true
  if (frame.type === 'snapshot') {
    state.snapshotStartedAt = nowMs()
    state.snapshotMs = 0
    clearSnapshotNotice()
  }
  state.snapshotProgress = nextSnapshotProgress(state.snapshotProgress, frame)
  if (state.snapshotProgress.done !== true || wasDone) return
  state.snapshotMs = Math.max(0, nowMs() - (state.snapshotStartedAt || nowMs()))
  // A switch that finishes instantly needs no announcement; one the reader waited on does.
  if (state.snapshotMs < 600) return
  state.snapshotFlash = true
  if (snapshotFlashTimer !== undefined) window.clearTimeout(snapshotFlashTimer)
  snapshotFlashTimer = window.setTimeout(() => {
    snapshotFlashTimer = undefined
    state.snapshotFlash = false
  }, 2800)
}

/** The key this page remembers the open Session under. */
const SESSION_KEY = 'rc.session'

/** @returns the remembered Session id, or an empty string when there is none. */
function rememberedSession () {
  try {
    return window.localStorage.getItem(SESSION_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * @param sessionId - the Session to remember.
 *
 * A blocked storage must not break switching, so a failure here is silent: the page simply forgets.
 */
function rememberSession (sessionId) {
  try {
    window.localStorage.setItem(SESSION_KEY, sessionId)
  } catch {
    /* nothing to do */
  }
}

/**
 * Safety net for a snapshot that never arrives.
 *
 * The flag is normally cleared by the snapshot itself; this only exists so a dropped connection cannot
 * leave a spinner running forever.
 */
let sessionTimer

/** Mark the Session content as loaded, whatever the reason. */
function finishSessionLoad () {
  if (sessionTimer !== undefined) {
    window.clearTimeout(sessionTimer)
    sessionTimer = undefined
  }
  clearSlowWatch('session')
  state.sessionLoading = false
  state.sessionSlow = false
  state.sessionFailed = false
}

/** Try the current Session again after a failed or timed-out load. */
export async function retrySession () {
  const sessionId = state.selected
  if (sessionId === undefined) return
  state.sessionFailed = false
  await selectSession(sessionId)
}

/** Follow one Session: reset the transcript, then stream frames into the store. */
export async function selectSession (sessionId) {
  state.selected = sessionId
  // One place records the choice, so every path into a Session — sidebar, restore, Host push — is kept.
  rememberSession(sessionId)
  // The transcript is empty from here until the snapshot lands, which is worth saying out loud: an empty
  // transcript and a loading one look identical otherwise.
  state.sessionLoading = true
  state.sessionSlow = false
  state.sessionFailed = false
  // A new Session starts its own load, so the previous one's progress and notice are meaningless.
  state.snapshotProgress = { ...EMPTY_SNAPSHOT_PROGRESS }
  state.snapshotStartedAt = 0
  state.snapshotMs = 0
  clearSnapshotNotice()
  watchSlow('session', () => {
    if (state.sessionLoading) state.sessionSlow = true
  })
  if (sessionTimer !== undefined) window.clearTimeout(sessionTimer)
  // Giving up is a visible state with a retry, not a silent return to an empty transcript.
  sessionTimer = window.setTimeout(() => {
    sessionTimer = undefined
    if (!state.sessionLoading) return
    clearSlowWatch('session')
    state.sessionLoading = false
    state.sessionSlow = false
    state.sessionFailed = true
  }, FAIL_AFTER_MS)
  state.events = []
  resetTranscriptCache()
  state.live = { attemptId: undefined, text: '', reasoning: '' }
  state.streamError = ''
  state.hasOlder = true
  state.loadingOlder = false
  resetTelemetry()
  // An idle Session still shows what its last turn produced: the Host keeps the counters, and this
  // only overrides the run flag with the Session's own state.
  const snapshot = state.telemetryBySession[sessionId]
  if (snapshot !== undefined) {
    Object.assign(state.telemetry, snapshot, { running: selectedSession.value?.running === true })
  }
  source?.close()
  source = openStream(sessionId, {
    onFrame: handleFrame,
    onPending: (pending) => { state.pending = pending },
    onSessions: (payload) => {
      // The payload also carries the pinned/archived sets, which is how a desktop-side pin shows up here.
      const sessions = Array.isArray(payload) ? payload : (payload?.sessions ?? [])
      const known = new Map(state.sessions.map((session) => [session.id, session]))
      state.sessions = sessions.map((session) => ({ ...session, workspaceId: known.get(session.id)?.workspaceId }))
      if (Array.isArray(payload) === false) installManagement(payload)
      refreshSoon()
    },
    onError: (message) => {
      state.streamError = message
      // A failed stream is not a pending one; the note explains it, and the reader gets a retry.
      finishSessionLoad()
      if (state.events.length === 0) state.sessionFailed = true
    },
    onOpen: () => { state.streamError = '' },
  })
  await Promise.all([loadPermissions(sessionId), refreshSelection()])
}

/**
 * Fetch one backward page of history and prepend it.
 *
 * The opening window is bounded (the Host stops at a turn boundary once its lower bounds are met),
 * so this is what lets a long Session be read all the way back. Resolves to the height the content
 * grew by, so the caller can keep the reader's scroll anchor.
 * @returns the added content height in px.
 */
let olderAbort

export async function loadOlder () {
  if (state.loadingOlder || !state.hasOlder) return 0
  const first = state.events[0]
  const sessionId = state.selected
  if (first === undefined || sessionId === undefined) {
    state.hasOlder = false
    return 0
  }
  state.loadingOlder = true
  state.olderError = ''
  const controller = new AbortController()
  olderAbort = controller
  watchSlow('older', () => {
    if (state.loadingOlder) state.olderSlow = true
  })
  try {
    const payload = await api(`/api/older?sessionId=${encodeURIComponent(sessionId)}&beforeSeq=${String(first.seq)}`, {
      signal: controller.signal,
      timeoutMs: 30_000,
    })
    const records = Array.isArray(payload.records) ? payload.records : []
    const older = records
      .filter((record) => record?.type === 'event' && record.event?.seq < first.seq)
      .map((record) => record.event)
    if (older.length === 0) {
      state.hasOlder = false
      return 0
    }
    const known = new Set(state.events.map((event) => event.seq))
    const fresh = older.filter((event) => !known.has(event.seq))
    state.events = [...fresh, ...state.events]
    if (payload.hasMore !== true) state.hasOlder = false
    return fresh.length
  } catch (error) {
    const message = String(error.message ?? error)
    // Cancelling is not a failure, so it must not be reported as one.
    if (message !== '已取消') state.olderError = message
    return 0
  } finally {
    clearSlowWatch('older')
    olderAbort = undefined
    state.olderSlow = false
    state.loadingOlder = false
  }
}

/** Abort an in-flight "load earlier" without waiting for the network. */
export function cancelOlder () {
  olderAbort?.abort()
  olderAbort = undefined
  state.olderSlow = false
  state.loadingOlder = false
}

/**
 * @param value - whether to run in text-only mode.
 *
 * Turns the page into something usable on a bad link: attachment bytes are not fetched at all, and the
 * CSS drops the glass and the motion.
 */
export function setLightweight (value) {
  state.lightweight = value === true
  try {
    window.localStorage.setItem('rc.lightweight', state.lightweight ? '1' : '0')
  } catch {
    /* a blocked storage keeps the in-memory value */
  }
}

/** Resolve which model the Session is currently using. */
async function refreshSelection () {  try {
    const payload = await api(`/api/selection?sessionId=${encodeURIComponent(state.selected ?? '')}`)
    state.selection = payload.selected
  } catch {
    state.selection = undefined
  }
}

/** Reset the per-Session telemetry counters. */
function resetTelemetry () {
  Object.assign(state.telemetry, {
    turn: 0,
    step: 0,
    running: selectedSession.value?.running === true,
    provider: '',
    model: '',
    contextWindow: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalReasoning: 0,
    lastInput: 0,
    tokensPerSecond: 0,
    streamStartedAt: 0,
  })
}

/** Events waiting for the next animation frame, so a burst costs one recompute rather than dozens. */
let pendingEvents = []
let pendingFlush

/** Append the buffered events in one go. */
function flushEvents () {
  pendingFlush = undefined
  if (pendingEvents.length === 0) return
  state.events.push(...pendingEvents)
  pendingEvents = []
}

/** Fold one SSE frame into the transcript and the telemetry counters. */
/**
 * Streaming frames, batched to one fold per animation frame.
 *
 * A running turn emits many assistant-stream frames per second; folding each one synchronously as it
 * arrived kept the main thread busy for the whole reply, which is what made sending a prompt feel like a
 * freeze. The frames are still folded one by one, so the result is identical — only the timing changes.
 */
let pendingStreams = []
let streamFlush

/** Fold every queued stream frame, once per frame. */
function flushStreams () {
  streamFlush = undefined
  const frames = pendingStreams
  pendingStreams = []
  for (const frame of frames) foldStream(frame)
}

function handleFrame (frame) {
  if (frame === null || typeof frame !== 'object') return
  if (frame.type === 'snapshot') {
    pendingEvents = []
    trackSnapshot(frame)
    state.events = (frame.records ?? [])
      .filter((record) => record?.type === 'event')
      .map((record) => record.event)
    resetTranscriptCache()
    // A chunked snapshot is only complete once the last chunk says so; an unchunked one is complete
    // immediately (an earlier Host sent exactly one snapshot frame).
    if (frame.last !== false) finishSessionLoad()
    state.telemetry.running = selectedSession.value?.running === true
    return
  }
  if (frame.type === 'snapshot-append') {
    trackSnapshot(frame)
    // The rest of a large snapshot, folded as it lands.
    const more = (frame.records ?? [])
      .filter((record) => record?.type === 'event')
      .map((record) => record.event)
    if (more.length > 0) state.events.push(...more)
    if (frame.last === true) finishSessionLoad()
    return
  }
  if (frame.type === 'event') {
    // Telemetry folds immediately (it is a handful of counters), but the transcript is appended on the
    // next frame: a streaming turn emits many events per second and each append used to re-render every
    // row, which is what made a long Session freeze the tab.
    foldTelemetry(frame.event)
    pendingEvents.push(frame.event)
    if (pendingFlush === undefined) pendingFlush = window.requestAnimationFrame(flushEvents)
    return
  }
  if (frame.type === 'assistant-stream') {
    pendingStreams.push(frame.frame)
    if (streamFlush === undefined) streamFlush = window.requestAnimationFrame(flushStreams)
  }
}

/** Track turns, steps, usage, model, and context occupancy from durable events. */
function foldTelemetry (event) {
  const data = event.data ?? {}
  const telemetry = state.telemetry
  if (event.type === 'turn/start') {
    telemetry.turn = Number(data.turn ?? telemetry.turn)
    telemetry.running = true
    return
  }
  if (event.type === 'turn/end') {
    telemetry.running = false
    return
  }
  if (event.type === 'step/start') {
    telemetry.step = Number(data.step ?? telemetry.step)
    return
  }
  if (event.type === 'assistant/message') {
    const usage = data.usage
    if (usage !== undefined) {
      telemetry.totalInput += Number(usage.inputTokens ?? 0)
      telemetry.totalOutput += Number(usage.outputTokens ?? 0)
      telemetry.totalCacheRead += Number(usage.cacheReadTokens ?? 0)
      telemetry.totalCacheWrite += Number(usage.cacheWriteTokens ?? 0)
      telemetry.totalReasoning += Number(usage.reasoningTokens ?? 0)
      telemetry.lastInput = Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0)
      const elapsed = telemetry.streamStartedAt === 0 ? 0 : (Date.now() - telemetry.streamStartedAt) / 1000
      if (elapsed > 0.2 && Number(usage.outputTokens ?? 0) > 0) {
        telemetry.tokensPerSecond = Number(usage.outputTokens) / elapsed
      }
    }
    return
  }
  if (event.type === 'request/context') {
    telemetry.provider = String(data.provider ?? telemetry.provider)
    telemetry.model = String(data.model ?? telemetry.model)
    if (typeof data.contextWindow === 'number') telemetry.contextWindow = data.contextWindow
    return
  }
  if (event.type === 'request/header') {
    const config = data.header?.config
    if (config !== undefined) {
      telemetry.provider = String(config.provider ?? telemetry.provider)
      telemetry.model = String(config.model ?? telemetry.model)
    }
  }
}

/** Track the live assistant stream so text appears while the model is still writing. */
function foldStream (frame) {
  const telemetry = state.telemetry
  if (frame.type === 'start') {
    state.live = { attemptId: frame.attemptId, text: '', reasoning: '' }
    telemetry.streamStartedAt = Date.now()
    telemetry.running = true
    return
  }
  if (frame.type === 'chunk') {
    const chunk = frame.chunk ?? {}
    if (chunk.type === 'text-delta') state.live.text += String(chunk.text ?? '')
    else if (chunk.type === 'reasoning-delta') state.live.reasoning += String(chunk.text ?? '')
    return
  }
  if (frame.type === 'end') {
    state.live = { attemptId: undefined, text: '', reasoning: '' }
  }
}

/**
 * Send a message into the selected Session.
 * @param content - prompt content parts (`text`, optional `image` attachments).
 * @param mode - `queue` or `steer`.
 */
export async function sendPrompt (content, mode = 'queue') {
  state.actionError = ''
  try {
    await api('/api/send', { method: 'POST', body: { sessionId: state.selected, content, mode } })
  } catch (error) {
    state.actionError = String(error.message ?? error)
    throw error
  }
}

/** Stop the running turn. */
export async function cancelTurn () {
  try {
    await api('/api/cancel', { method: 'POST', body: { sessionId: state.selected } })
  } catch (error) {
    state.actionError = String(error.message ?? error)
  }
}

/**
 * Answer one pending question.
 * @param callId - the pending question's call id.
 * @param answers - `{id, selected, custom?}` items.
 * @returns true when the Host accepted the batch.
 */
export async function answerQuestion (callId, answers) {
  try {
    await api('/api/answer', { method: 'POST', body: { callId, answers } })
    state.pending.questions = state.pending.questions.filter((question) => question.callId !== callId)
    return true
  } catch (error) {
    state.actionError = String(error.message ?? error)
    return false
  }
}

/** Switch the Session's model. */
export async function selectModel (selection) {
  try {
    await api('/api/select-model', { method: 'POST', body: { sessionId: state.selected, ...selection } })
    state.selection = selection
    state.actionError = ''
  } catch (error) {
    state.actionError = String(error.message ?? error)
  }
}

/** Switch the Session's permission preset. */
export async function selectPermission (name) {
  try {
    await api('/api/permission', { method: 'POST', body: { sessionId: state.selected, name } })
    state.permissions.current = name
    state.actionError = ''
  } catch (error) {
    state.actionError = String(error.message ?? error)
  }
}

/** Media types the Host admits as prompt images. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Read one picked or pasted image into the shape the Host admits.
 *
 * Image bytes travel *inside* the prompt (`{ type: 'image', mediaType, data, name? }`), exactly as
 * the Desktop composer submits them, and the Host stores them while admitting the submission. No
 * pre-upload round trip is involved, so there is nothing to clean up when the draft is discarded.
 * @param file - the picked or pasted image.
 * @returns the staged attachment: bytes, media type, and a local preview URL.
 */
export async function stageImage (file) {
  if (!IMAGE_MEDIA_TYPES.has(file.type)) throw new Error(`不支持的图片类型：${file.type === '' ? '未知' : file.type}`)
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result)) }
    reader.onerror = () => { reject(new Error('读取图片失败')) }
    reader.readAsDataURL(file)
  })
  return {
    mediaType: file.type,
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    name: file.name === '' ? undefined : file.name,
    preview: dataUrl,
  }
}

/* ---------------------------------------------------------------- session management */

/**
 * Install the pinned/archived sets a state or `sessions` payload carries.
 * @param payload - a `/api/state` reply or a `sessions` SSE payload.
 */
function installManagement (payload) {
  if (payload === null || payload === undefined) return
  if (Array.isArray(payload.pinnedSessionIds)) state.pinnedSessionIds = payload.pinnedSessionIds.map(String)
  if (Array.isArray(payload.archivedSessionIds)) state.archivedSessionIds = payload.archivedSessionIds.map(String)
  if (typeof payload.managed === 'boolean') state.managed = payload.managed
}

/**
 * Run one session-management action against the Host.
 * @param path - route under `/api/session/`.
 * @param body - its JSON body.
 * @returns the Host reply, or undefined after surfacing the error.
 */
async function manage (path, body) {
  state.actionError = ''
  try {
    const payload = await api(`/api/session/${path}`, { method: 'POST', body })
    installManagement(payload)
    // Re-read the list so titles, ordering, and pinned/archived rows all agree with the Host.
    await loadState()
    return payload
  } catch (error) {
    state.actionError = String(error.message ?? error)
    return undefined
  }
}

/**
 * Pin or unpin one Session.
 * @param sessionId - the Session.
 * @param pinned - false to unpin.
 */
export async function setPinned (sessionId, pinned) {
  return manage('pin', { sessionId, pinned })
}

/**
 * Rename one Session.
 * @param sessionId - the Session.
 * @param title - the new title.
 */
export async function renameSession (sessionId, title) {
  return manage('rename', { sessionId, title })
}

/**
 * Fork one Session from its last ended turn, then open the child.
 * @param sessionId - the source Session.
 */
export async function forkSession (sessionId) {
  const payload = await manage('fork', { sessionId })
  if (typeof payload?.sessionId === 'string' && payload.sessionId !== '') await selectSession(payload.sessionId)
  return payload
}

/**
 * Archive or unarchive one Session.
 * @param sessionId - the Session.
 * @param archived - false to unarchive.
 * @param stopActivity - also stop work that is still running (never implied).
 */
export async function setArchived (sessionId, archived, stopActivity = false) {
  return manage('archive', { sessionId, archived, stopActivity })
}
/**
 * Load the agent presets ("模式") a new Session can be created with.
 */
export async function loadPresets () {
  try {
    const payload = await api('/api/presets')
    state.presets = Array.isArray(payload.presets) ? payload.presets : []
  } catch {
    state.presets = []
  }
}

/**
 * Create a Session in one workspace, optionally with an agent preset.
 * @param options - `{ workspaceId?, cwd?, agentPreset? }`.
 * @returns the new Session id, or undefined after surfacing the error.
 */
export async function createSession (options) {
  state.actionError = ''
  try {
    const payload = await api('/api/session/create', { method: 'POST', body: options })
    await loadState()
    return typeof payload.sessionId === 'string' ? payload.sessionId : undefined
  } catch (error) {
    state.actionError = String(error.message ?? error)
    return undefined
  }
}