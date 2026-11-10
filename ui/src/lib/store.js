import { computed, reactive } from 'vue'
import { api, openStream, UnauthorizedError, uploadImage } from './api.js'
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
  /**
   * 更旧的分片前插到窗口头部的**累计条数**（单调递增）。
   *
   * 宿主按「从新到旧」发分片（见 index.js 的 `pumpSession`）：第一块就是最新窗口，后续每块更旧、前插到
   * 头部。前插会改变内容总高度，界面必须据此做滚动补偿 —— 计数器只是为了触发那个 watcher，DOM 上的
   * 差值由 ConversationPane 自己读。
   */
  snapshotPrepend: 0,
  /** 最近一次前插的事件条数。 */
  snapshotPrepended: 0,
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
  /**
   * 事件窗口是否被裁剪过（见 `trimEvents`）。
   *
   * 为 true 表示内存里只保留了最近的 `MAX_EVENTS` 条事件：更早的内容已经不在页面上，需要通过「加载
   * 更早」重新向宿主拉取。页面靠这个标志解释"为什么历史开头不见了"。
   */
  eventsTrimmed: false,
  /** True while another backward history page is in flight. */
  loadingOlder: false,
  /** Cleared once a backward page comes back empty, so the button disappears at the start of a log. */
  hasOlder: true,
  live: { attemptId: undefined, text: '', reasoning: '' },
  streamError: '',
  /**
   * 被**无损合并**掉的流帧数量。
   *
   * 流帧是增量 delta，合并只是把连续的同类 delta 串成一条（结果逐字相同），所以这个数字变大
   * 不代表丢了内容。只有极端交错到合并后仍超上限时才会真的丢帧，那种情况会同时置 `needsResync`。
   */
  streamDropped: 0,
  /** foldStream 抛异常的累计次数；坏帧被跳过，页面靠这个数字说明发生过几次。 */
  streamErrors: 0,
  /** 待折叠事件队列的当前长度，用来确认「后台攒了多少」。 */
  eventBacklog: 0,
  /** 因事件队列到上限而被拒收的帧数（这些帧不会丢——它们由 `needsResync` 的重拉补回来）。 */
  eventsDeferred: 0,
  /**
   * 需要重新拉一份当前会话快照。
   *
   * 置位的唯一理由：队列里确实有帧没能进入状态（事件队列顶到上限，或流帧合并后仍超限）。
   * 事件帧不是累积型，缺一条就是永久缺一行，所以只能整份对账，而不是悄悄少一段。
   */
  needsResync: false,
  /** 已执行的重拉次数，纯可观测。 */
  resyncs: 0,
  /** 页面进入隐藏的时刻（0 表示可见），用来衡量后台时长。 */
  hiddenSince: 0,
  /** 最近一次「隐藏 → 恢复」经过的毫秒数。 */
  hiddenMs: 0,
  /** 最近一条运行期错误的可读描述；App 顶部据此显示错误条。 */
  lastError: '',
  /** 最近一条错误的时间戳与累计条数。 */
  lastErrorAt: 0,
  errorCount: 0,
  /** 转写折叠失败过，页面正显示降级内容。 */
  transcriptDegraded: false,
  /**
   * SSE 自动重连的次数，以及最近一次收到 `host hello` 的时间戳（毫秒，0 表示尚未连上）。
   *
   * 纯可观测字段：EventSource 断线会自己重连，宿主每接受一条新连接都会立刻重发整份快照，所以
   * 「没发消息却重新载入」这类症状到底是重连造成的还是别的原因，先看这两个数。
   */
  streamReconnects: 0,
  lastHelloAt: 0,
  /** 因「快照与当前窗口一致/更旧」被整个跳过的重连快照数量，用来确认去重真的生效。 */
  snapshotSkips: 0,
  actionError: '',
  /**
   * 成功发出（宿主已接受）一条 prompt 的次数。
   *
   * 为什么用计数而不是时间戳：转录面板只需要「刚刚有一次发送成功」这一个事件，计数天然去重
   * （同毫秒两次发送也能分辨），也不用担心时钟回拨。面板据此把自己贴回底部。
   */
  promptSendCount: 0,
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

/** 内存中保留的事件条数上限。事件是有序数组，超出后从头部（最旧的一端）丢弃。 */
const MAX_EVENTS = 2000

/**
 * 一次裁剪超过这么多条时才清空转写缓存。
 *
 * 到上限之后，每个动画帧只会溢出几条事件；而 `resetTranscriptCache()` 会让整段转写重新生成 item 并
 * 全量重渲染——每帧一次全量重渲染正是这次要消灭的卡顿。少量裁剪是安全的：缓存键由 `seq` 派生、内容
 * 靠签名比较，丢掉几条旧事件不会让留下来的 item 错位。只有批量裁剪（加载更早、超大快照）才值得付一次
 * 全量失效的代价。
 */
const TRIM_CACHE_RESET_THRESHOLD = 32

/**
 * 把事件窗口压回 `MAX_EVENTS` 条，从头部截断、保留最近的记录。
 *
 * 这个上限以前只是声明、没有任何地方引用，于是 `loadOlder`、`snapshot-append`、`flushEvents` 都在无
 * 上限追加；而 `transcriptItems` 每帧都要全量重算，翻几页历史后单帧就要 100–300ms。三个追加点之后都
 * 要调用这里，上限才算真的生效。
 *
 * 截断会让缓存里留下已经不在窗口内的事件的 key，所以必须让转写缓存失效（批量裁剪时清空，见
 * `TRIM_CACHE_RESET_THRESHOLD`），否则 itemCache/groupCache 会继续持有旧条目。
 */
function trimEvents () {
  // 先比较再算余量：绝大多数帧都远不到上限，这个早退让稳态路径没有额外开销。
  if (state.events.length <= MAX_EVENTS) return
  const overflow = state.events.length - MAX_EVENTS
  state.events.splice(0, overflow)
  // 更早的内容已经不在内存里，页面据此提示「需要重新拉取」，而不是让人以为日志就这么多。
  state.eventsTrimmed = true
  if (overflow >= TRIM_CACHE_RESET_THRESHOLD) resetTranscriptCache()
}

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

/**
 * 转写条目的公开计算属性。
 *
 * 折叠会在每次事件窗口变化时跑一遍，任何一个意外形状都可能让它抛异常 —— 而一个抛异常的
 * computed 会把整棵组件树带下水（Vue 在渲染中抛错时，读者看到的就是白/黑屏）。这里把它降级成
 * 「空转写 + 错误条」：内容暂时不全，但页面还活着、错误可见、状态可恢复。
 */
export const transcriptItems = computed(() => {
  try {
    const items = buildTranscriptItems()
    state.transcriptDegraded = false
    return items
  } catch (error) {
    state.transcriptDegraded = true
    reportError(error, 'transcript')
    return []
  }
})

/** @returns 真正做折叠的那一遍（纯函数式，不碰 DOM）。 */
function buildTranscriptItems () {
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
}

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
        // 这几项只是给"回显刚发出的图片"做匹配用，不参与渲染。
        bytes: Number.isFinite(Number(attachment.bytes)) ? Number(attachment.bytes) : undefined,
        width: Number.isFinite(Number(attachment.width)) ? Number(attachment.width) : undefined,
        height: Number.isFinite(Number(attachment.height)) ? Number(attachment.height) : undefined,
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
/** 拉取失败的 key：界面据此显示「图片不可用」，而不是永远停在「加载中」。 */
const attachmentFailures = reactive(new Set())

/**
 * 本页刚上传（还没发送）的图片字节，键是宿主返回的 `uploadId`。
 *
 * 用途：宿主 `GET /api/attachment` 在部分 DSH 版本上读不到记录（返回 404，见
 * `attachmentFailures` 的说明），而页面手里正好有刚发出的这份 blob —— 直接本地显示，
 * 读者发完图片立刻就能看到，不必等一个注定失败的请求。
 */
const stagedImageBlobs = new Map()
/** 本页刚发出去的图片（丢弃用来显示的 object URL 之外不占空间）。 */
const recentSentImages = []
/** 只留最近几张：多发的图片没有必要一直占着 blob。 */
const MAX_RECENT_SENT_IMAGES = 8

/** 记住一张刚发出的图片，供它对应的附件事件回显。 */
function rememberSentImage (staged) {
  const url = URL.createObjectURL(staged.blob)
  recentSentImages.push({
    mediaType: staged.mediaType,
    name: staged.name,
    size: staged.size,
    url,
  })
  while (recentSentImages.length > MAX_RECENT_SENT_IMAGES) {
    const evicted = recentSentImages.shift()
    if (typeof evicted?.url === 'string') URL.revokeObjectURL(evicted.url)
  }
}

/**
 * @param meta - 事件里那颗 image block 的附件信息（`mediaType`/`bytes`/`name`）。
 * @returns 本页刚发出的、能对上的那张图片；对上就把它从队列里取走（一次事件只消费一张）。
 */
function takeSentImage (meta) {
  const size = Number(meta?.bytes)
  if (!Number.isFinite(size)) return undefined
  const mediaType = String(meta?.mediaType ?? '')
  const name = typeof meta?.name === 'string' ? meta.name : undefined
  const index = recentSentImages.findIndex((entry) => entry.size === size
    && entry.mediaType === mediaType
    && (name === undefined || entry.name === name))
  if (index < 0) return undefined
  return recentSentImages.splice(index, 1)[0]
}

/**
 * Fetch one attachment's bytes through the Host and remember them.
 * Idempotent, so a component can call it from a watcher on every change.
 * @param sessionId - the Session whose log proves the attachment.
 * @param attachmentId - durable attachment identity.
 * @param meta - optional image-block metadata, used to reuse a blob this page just sent.
 */
export function ensureAttachmentImage (sessionId, attachmentId, meta) {
  // Text-only mode moves no image bytes at all: attachments are base64 payloads and the most expensive
  // thing the page can ask for over a slow link.
  if (state.lightweight) return
  if (sessionId === undefined || sessionId === null || attachmentId === '') return
  const key = `${sessionId}:${attachmentId}`
  if (attachmentImages.has(key) || attachmentPending.has(key)) return
  // 刚由本页发出的图片：直接用它自己的 blob，不依赖宿主能不能按 id 读回来。
  const local = takeSentImage(meta)
  if (local !== undefined) {
    attachmentImages.set(key, local.url)
    return
  }
  attachmentPending.add(key)
  api(`/api/attachment?sessionId=${encodeURIComponent(sessionId)}&attachmentId=${encodeURIComponent(attachmentId)}`)
    .then((payload) => {
      attachmentImages.set(key, payload.data === '' ? '' : `data:${payload.mediaType};base64,${payload.data}`)
    })
    .catch(() => {
      attachmentImages.set(key, '')
      attachmentFailures.add(key)
    })
    .finally(() => {
      attachmentPending.delete(key)
    })
}

/** @returns the cached data URL for an attachment, or an empty string while it loads. */
export function attachmentImage (sessionId, attachmentId) {
  return attachmentImages.get(`${String(sessionId)}:${String(attachmentId)}`) ?? ''
}

/** @returns whether fetching that attachment has already failed (so the UI can stop saying "加载中"). */
export function attachmentImageFailed (sessionId, attachmentId) {
  return attachmentFailures.has(`${String(sessionId)}:${String(attachmentId)}`)
}

/** @returns the joined text of a message's content blocks (tool results and other summaries). */
export function blocksToText (message) {
  const parts = messageParts(message)
  return [parts.text, ...parts.files].filter((part) => part !== '').join('\n')
}

/**
 * @param signal - 可选的取消信号；切换会话时上一条会话的这些附属请求会被中止（D）。
 */
export async function loadState (signal) {
  try {
    const payload = await api('/api/state', { signal })
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
    // 两处都「先比指纹再换对象」：`pending` 被每一行消息读（判断这行是不是待回答问题），换一次
    // 对象就是整段转写重算；`telemetryBySession` 换一次则要把整份嵌套对象重新包成响应式代理。
    installPending(payload.pending)
    if (payload.telemetry !== undefined) installTelemetry(payload.telemetry)
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
    // 被后一次加载取消：这次的结果已经没人要了，也不能当成启动失败去亮错误页。
    if (String(error?.message ?? error) === '已取消') return
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

/**
 * Load the permission catalog once.
 * @param sessionId - the Session.
 * @param signal - 可选的取消信号（切会话/切模型时旧请求作废）。
 */
export async function loadPermissions (sessionId, signal) {
  try {
    const payload = await api(`/api/permissions?sessionId=${encodeURIComponent(sessionId ?? '')}`, { signal })
    state.permissions = {
      options: payload.options ?? [],
      defaultPreset: payload.defaultPreset ?? '',
      current: payload.current,
    }
  } catch {
    /* the catalog is optional */
  }
}

/** 当前会话切换的取消器：再次切换时上一次的附属请求（权限/模型选择）被中止（D）。 */
let sessionAbort
let source
let refreshTimer
/** 正在进行的目录加载；新的加载会中止旧的，弱网下不堆叠重复请求。 */
let catalogAbort
/** 隐藏期间被推迟的目录刷新，恢复可见时补一次。 */
let refreshOnResume = false

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
    // 隐藏期间不做网络与状态工作：没有渲染需求，白耗流量与电量；恢复时补一次即可。
    if (!pageVisible()) {
      refreshOnResume = true
      return
    }
    catalogAbort?.abort()
    catalogAbort = new AbortController()
    void loadState(catalogAbort.signal)
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

/**
 * 重试当前会话。
 *
 * 分两种：真正载入失败（或窗口里还没有内容）要重新加载整份快照；只是流断了则只重新打开连接，
 * 免得一次网络抖动把整段转写清空重建。
 */
export async function retrySession () {
  const sessionId = state.selected
  if (sessionId === undefined) return
  if (state.events.length > 0 && state.sessionFailed !== true) {
    reopenStream()
    return
  }
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
  // Frames of the previous turn must not be folded into the new session's transcript.
  dropPendingFrames()
  // 「加载更早」是绑在旧会话上的：中途切走还让它落地，就会把旧会话的历史拼进新转写。
  olderAbort?.abort()
  olderAbort = undefined
  state.loadingOlder = false
  pendingSnapshot = undefined
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
  state.eventsTrimmed = false
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
  // 切会话时把上一条会话的积压清掉：这些帧属于旧会话，折叠进新转写只会写错文本。
  dropPendingFrames()
  state.needsResync = false
  forceSnapshotReplace = false
  sessionAbort?.abort()
  sessionAbort = new AbortController()
  const signal = sessionAbort.signal
  source = openStream(sessionId, streamHandlers())
  await Promise.all([loadPermissions(sessionId, signal), refreshSelection(signal)])
}

/**
 * @returns 交给 `openStream` 的帧处理器。
 *
 * 抽成工厂是因为「切换会话」和「只重连」要用同一套处理器，两条路径的差别只在会话状态怎么重置。
 */
function streamHandlers () {
  return {
    onFrame: handleFrame,
    onPending: installPending,
    onSessions: (payload) => {
      // The payload also carries the pinned/archived sets, which is how a desktop-side pin shows up here.
      const sessions = Array.isArray(payload) ? payload : (payload?.sessions ?? [])
      if (Array.isArray(payload) === false) installManagement(payload)
      // 与 `loadState` 同一套指纹守卫：侧栏画的所有东西都没变时整条广播直接丢弃，不为一次状态广播
      // 换掉数组和每一行对象、再重排一遍（几百个会话时那是几十毫秒的无谓 patch）。
      const fingerprint = sessionFingerprint(sessions, state.pinnedSessionIds, state.archivedSessionIds)
      if (fingerprint === state.sessionFingerprint) return
      state.sessionFingerprint = fingerprint
      const known = new Map(state.sessions.map((session) => [session.id, session]))
      state.sessions = sessions.map((session) => ({ ...session, workspaceId: known.get(session.id)?.workspaceId }))
      refreshSoon()
    },
    onError: (message) => {
      // 断线不重新 selectSession：EventSource 自己会重连，宿主在新连接上重发一份快照，由 handleFrame
      // 的对账决定跳过/追加/替换。这里只收尾状态，绝不整表重载。
      pendingSnapshot = undefined
      state.streamError = message
      // A failed stream is not a pending one; the note explains it, and the reader gets a retry.
      finishSessionLoad()
      if (state.events.length === 0) state.sessionFailed = true
    },
    onOpen: (info) => {
      state.streamError = ''
      // `hello` 每建立一条新连接都会来一次：第一次是首连，之后每次都是浏览器的自动重连（宿主会立刻
      // 重发整份快照），所以这两个数就是「没操作却重新载入」的第一手证据。
      if (typeof info?.at === 'number') state.lastHelloAt = info.at
      if (Number(info?.reconnects) > 0) state.streamReconnects += 1
    },
  }
}

/**
 * 只重新打开流连接，不重载会话。
 *
 * 流错误横幅上的「重试」过去直接走 `selectSession`：清空 events、`resetTranscriptCache()`、亮骨架屏，
 * 再等一份新快照 —— 那是第二条真正的整表重载路径，而断线重连的窗口里读者很容易点到它。断线并不
 * 意味着历史失效，需要的只是重新订阅：保留现有转写，只换一条连接。
 */
export function reopenStream () {
  const sessionId = state.selected
  if (sessionId === undefined) return
  state.streamError = ''
  pendingSnapshot = undefined
  source?.close()
  source = openStream(sessionId, streamHandlers())
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
    // 窗口有上限：满了以后仍然从头截断，所以长会话里「加载更早」只在窗口还有余量时能真正延长可见历史，
    // 一旦顶到上限，最旧的一端（含刚拉到的这一页）会被重新丢掉，由 eventsTrimmed 说明这件事。
    // Deliberately not trimmed here: paging backwards adds older events at the head, and trimming from
  // the head in the same tick would drop exactly what the reader just asked for, leaving the button
  // spinning with nothing to show for it. Real-time appends are what the cap is for.
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

/**
 * Resolve which model the Session is currently using.
 * @param signal - 可选的取消信号（切换会话时旧请求作废）。
 */
async function refreshSelection (signal) {
  try {
    const payload = await api(`/api/selection?sessionId=${encodeURIComponent(state.selected ?? '')}`, { signal })
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

/* ---------------------------------------------------------------- 帧调度闸门 */

/**
 * 页面是否可见。
 *
 * 隐藏标签页的 rAF **完全停摆**，而 SSE 一刻不停地把帧送进队列。旧实现把「什么时候消费」整个
 * 交给 rAF，于是隐藏期间消费全部停住、队列无限增长，切回来那一帧一次性清空 —— 那是不可切片的
 * 长任务，页面表现就是黑屏/假死。所以「可见」必须是显式的调度前提，而不是隐含假设。
 * @returns 非浏览器环境（单测/Node）视为可见。
 */
function pageVisible () {
  return typeof document === 'undefined' || document.hidden !== true
}

/** 待折叠事件；下一帧追加，使一串突发只触发一次重算，而不是每来一条重算一次。 */
let pendingEvents = []
let eventsFlush
/** 页面隐藏导致消费暂停时置位，恢复后据此重新起跑。 */
let eventsWaiting = false

/**
 * 事件队列上限。
 *
 * 事件帧**不是**累积型：中间丢一条，转写里就永久少一行。所以到上限时不再接收，而是置
 * `needsResync`，等可见后整份重拉——宁可多一次请求，也不能留下一份悄悄错了的转写。
 */
const MAX_PENDING_EVENTS = 600

/** 排一次事件折叠：可见才排，隐藏时只记一笔"恢复后继续"。 */
function scheduleEvents () {
  if (!pageVisible()) {
    if (pendingEvents.length > 0) eventsWaiting = true
    return
  }
  // 已经排过就不重复排：一次突发只需要一个句柄。
  if (eventsFlush !== undefined) return
  eventsWaiting = false
  eventsFlush = nextFrame(flushEvents)
}

/**
 * 消费一帧预算内的待折叠事件。
 *
 * 分片而不是一次性 `push(...all)`：一次恢复可能攒下几百条，全部追加会在同一个任务里触发整条
 * 转写的重算与整表 patch。切片保证每次主线程占用有上界，顺序仍与到达完全一致。
 */
function flushEvents () {
  eventsFlush = undefined
  if (pendingEvents.length === 0) return
  // 隐藏期间绝不消费：禁止在页面不可见时做渲染准备，也不让积压在这里被"悄悄清空"。
  if (!pageVisible()) {
    eventsWaiting = true
    return
  }
  const deadline = nowMs() + STREAM_SLICE_MS
  let done = 0
  // 先无条件追加一条，保证每片都有进展，否则续帧会变成空转。
  do {
    state.events.push(pendingEvents[done])
    done += 1
  } while (done < pendingEvents.length && nowMs() < deadline)
  pendingEvents = pendingEvents.slice(done)
  trimEvents()
  state.eventBacklog = pendingEvents.length
  if (pendingEvents.length > 0) {
    scheduleEvents()
    return
  }
  eventsWaiting = false
  // 排空了才轮到重拉：可见状态下顶到上限同样会发生（突发太快），不能等到"下次切后台"才修。
  if (state.needsResync) requestResync('事件队列曾顶到上限')
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
/** 页面隐藏导致消费暂停时置位，恢复后据此重新起跑。 */
let streamsWaiting = false

/**
 * 一次 flush 最多占用的毫秒数。
 *
 * 积压几百帧时，一帧内把它们全部折叠仍然可能占住主线程几十上百毫秒，页面照旧"未响应"。6ms 留出
 * 同一帧里 Vue 渲染和浏览器自身工作的余量，剩下的交给下一个动画帧继续。
 */
const STREAM_SLICE_MS = 6

/**
 * 流帧队列的上限。
 *
 * 流帧是**增量** delta（`chunk.text` 只是这一小段，见 dsh-agent-loop 的 `AssistantStreamAttempt`），
 * 所以队列不能靠"丢中间帧"来压缩——那会直接丢字。见 `compactStreamBacklog`：先无损合并，只有
 * 合并后仍超限的极端情况才丢帧，并立刻标记 `needsResync` 让整份重拉来补回。
 */
const MAX_PENDING_STREAMS = 400

/** 每 N 次 foldStream 异常才打一条警告：坏帧往往成串出现，逐条打印只会淹没真正有用的信息。 */
const STREAM_ERROR_LOG_EVERY = 50

/**
 * @param callback - 要在下一帧执行的工作。
 * @returns 排队句柄；这里只用它判断"是否已经排过队"，以及取消时区分 rAF / 定时器。
 *
 * 测试或非浏览器环境没有 requestAnimationFrame，退化成 16ms 定时器：节奏仍是一帧一次，只是
 * 不再与渲染对齐。这样本模块在没有 DOM 的进程里也能被加载和驱动。
 */
const rafHandles = new Set()

function nextFrame (callback) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    let handle = 0
    handle = window.requestAnimationFrame((time) => {
      // 执行过就从表里摘掉：这张表只用来区分句柄来自哪一路，不该无限增长。
      rafHandles.delete(handle)
      callback(time)
    })
    rafHandles.add(handle)
    return handle
  }
  return setTimeout(callback, 16)
}

/**
 * @returns 这一帧能不能与相邻帧合并，以及合并到哪一路；结构帧（start/end/其他）返回空串。
 *
 * 只认 `text-delta` / `reasoning-delta`：它们分别累加到 `state.live.text` 与 `.reasoning`，
 * 所以「连续的同类 delta 首尾相接」与「逐帧折叠」结果逐字相同。`index` 不参与判断——foldStream
 * 不看块序号，跨块拼接仍是同一个字符串。
 */
function mergeKeyOf (frame) {
  if (frame === null || typeof frame !== 'object') return ''
  if (frame.type !== 'chunk') return ''
  const chunk = frame.chunk
  if (chunk === null || typeof chunk !== 'object') return ''
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return String(chunk.type)
  return ''
}

/**
 * 把排队中的流帧**无损**合并，把队列压回上限。
 *
 * 旧实现（f224ad0）在这里丢最旧的中间帧，理由是"流帧是累积快照，保留最新即可收敛"。这个前提是
 * 错的：帧里带的是 delta，`foldStream` 做的是 `state.live.text += chunk.text`，丢掉一段就等于把那
 * 段回复的文字吞掉。合并是等价变形：连续的 text-delta 串成一段文本、reasoning-delta 同理，
 * `start` / `end` 这些结构帧保持原位，顺序完全不变 —— 帧数从上百条降到个位数，内容一字不少。
 *
 * 只有合并后仍然超上限（几百个结构帧交错，正常流里不会出现）才真的丢帧，此时同时置
 * `needsResync`：丢掉的 delta 无法重建，只能整份重拉。
 */
function compactStreamBacklog () {
  if (pendingStreams.length < 2) return
  const compacted = []
  let merged = 0
  for (const frame of pendingStreams) {
    const previous = compacted.length > 0 ? compacted[compacted.length - 1] : undefined
    const key = mergeKeyOf(frame)
    if (key !== '' && previous !== undefined && mergeKeyOf(previous) === key) {
      // 同一段回复里连续的同类 delta：拼成一条。文本相加 = 逐帧 += 的等价形式。
      const chunk = previous.chunk
      compacted[compacted.length - 1] = { ...previous, chunk: { ...chunk, text: chunk.text + frame.chunk.text } }
      merged += 1
      continue
    }
    compacted.push(frame)
  }
  pendingStreams = compacted
  state.streamDropped += merged
  const overflow = compacted.length - MAX_PENDING_STREAMS
  if (overflow <= 0) return
  // 到这里才是真的丢：合并后仍超上限说明帧结构异常，标记重拉而不是假装没事。
  pendingStreams = compacted.slice(overflow)
  state.streamDropped += overflow
  state.needsResync = true
}

/**
 * 取消一个已经排好的帧。
 *
 * 句柄可能来自 rAF，也可能来自 `nextFrame` 的 setTimeout 回退。必须分清是哪一路：浏览器里
 * rAF 的 id 与 setTimeout 的 id 都是小整数，用 clearTimeout 去取消一个 rAF id 有可能顺手取消掉
 * 一个毫不相干的定时器（比如快照进度条那个）。
 */
function cancelFrameHandle (handle) {
  if (handle === undefined) return
  if (rafHandles.delete(handle)) {
    window.cancelAnimationFrame(handle)
    return
  }
  clearTimeout(handle)
}

/**
 * 丢掉所有待折叠的帧（切换会话时用）。
 *
 * 这些帧属于上一个会话，折进新转写就是写错文本；已经排好的帧也要取消，否则恢复后它们还会
 * 再跑一遍。
 */
function dropPendingFrames () {
  pendingStreams = []
  pendingEvents = []
  eventsWaiting = false
  streamsWaiting = false
  state.eventBacklog = 0
  if (streamFlush !== undefined) {
    cancelFrameHandle(streamFlush)
    streamFlush = undefined
  }
  if (eventsFlush !== undefined) {
    cancelFrameHandle(eventsFlush)
    eventsFlush = undefined
  }
}

/** 排一次流帧折叠：可见才排，隐藏时只记一笔"恢复后继续"。 */
function scheduleStreams () {
  if (!pageVisible()) {
    if (pendingStreams.length > 0) streamsWaiting = true
    return
  }
  if (streamFlush !== undefined) return
  streamsWaiting = false
  streamFlush = nextFrame(flushStreams)
}

/**
 * 分片消费排队中的流帧。
 *
 * 严格按到达顺序消费，每片控制在 STREAM_SLICE_MS 以内；没排空就续一帧，排空了才把句柄复位。
 * 句柄只在"还有活没干完"时存在，handleFrame 靠它判断要不要重新起跑，所以中途新到的帧追加到
 * 队尾后一定能被同一批剩余工作接上，不会丢也不会乱序。隐藏期间一律不消费（见 `pageVisible`）。
 */
function flushStreams () {
  streamFlush = undefined
  if (pendingStreams.length === 0) return
  if (!pageVisible()) {
    streamsWaiting = true
    return
  }
  const deadline = nowMs() + STREAM_SLICE_MS
  // 用游标而不是 shift：一帧里要消费几十上百条，从头部反复搬家是没必要的开销。
  let done = 0
  // 先无条件处理一条，保证每片都有进展：一条都折叠不了的话，续帧会变成空转。
  do {
    const frame = pendingStreams[done]
    done += 1
    try {
      foldStream(frame)
    } catch (error) {
      // 单帧坏掉不能拖垮整条队列：这一帧计入错误数后跳过，后面还有几百帧等着折叠。
      state.streamErrors += 1
      if (state.streamErrors % STREAM_ERROR_LOG_EVERY === 1) {
        console.warn('[remote-control] 折叠流帧失败，已跳过该帧：', error, `（累计 ${String(state.streamErrors)} 次）`)
      }
    }
  } while (done < pendingStreams.length && nowMs() < deadline)
  if (done > 0) pendingStreams = pendingStreams.slice(done)
  if (pendingStreams.length > 0) scheduleStreams()
  else streamsWaiting = false
}

/* ---------------------------------------------------------------- 后台 / 恢复 */

/** 下一次完整快照强制走整表替换（见 `requestResync`）。 */
let forceSnapshotReplace = false

/**
 * 请求一次「轻量重拉」：不清空转写、不亮骨架，只丢掉无法安全保留的积压，并换一条连接。
 *
 * 只在确实丢过帧时调用。宿主每接受一条新连接都会立刻重发整份窗口快照，所以重连本身就是一次
 * 对账；`forceSnapshotReplace` 只是保证那份快照一定走整表替换——当前窗口可能中间缺过帧，
 * 增量对账无法证明它完整，硬追加会把缺口永久留在页面上。
 * @param reason - 触发原因，进错误条与可观测字段用。
 */
function requestResync (reason) {
  state.needsResync = false
  state.resyncs += 1
  pendingEvents = []
  pendingStreams = []
  pendingSnapshot = undefined
  state.eventBacklog = 0
  eventsWaiting = false
  streamsWaiting = false
  if (state.selected === undefined) {
    // 还没选中会话：没有"当前会话"可重拉，重读一次目录即可。
    void loadState()
    return
  }
  forceSnapshotReplace = true
  console.warn(`[remote-control] 队列积压丢失了帧，重新拉取当前会话快照：${reason}`)
  reopenStream()
}

/**
 * 页面隐藏 / 恢复的统一入口。
 *
 * 隐藏：立刻停止消费（不排任何帧）——rAF 本来就不执行，显式停摆是为了让"绝不积压任务"成立，
 * 而不是碰巧成立。同时把流帧合并到最小、事件队列封顶（封顶时由 `handleFrame` 置 needsResync）。
 * 恢复：**不**一次性清空积压。要么按片继续消费，要么先重拉一份快照——两者都不会产生长任务。
 */
function onVisibilityChange () {
  if (!pageVisible()) {
    state.hiddenSince = Date.now()
    if (pendingEvents.length > 0) eventsWaiting = true
    compactStreamBacklog()
    if (pendingStreams.length > 0) streamsWaiting = true
    return
  }
  state.hiddenMs = state.hiddenSince === 0 ? 0 : Math.max(0, Date.now() - state.hiddenSince)
  state.hiddenSince = 0
  if (state.needsResync) {
    requestResync('后台期间有帧未能进入状态')
    return
  }
  // 恢复时只起跑，不清空：每个循环仍然一次只跑一片（≤ STREAM_SLICE_MS）。
  if (eventsWaiting || pendingEvents.length > 0) scheduleEvents()
  if (streamsWaiting || pendingStreams.length > 0) scheduleStreams()
  // 隐藏期间被推迟的目录刷新，这时候补一次。
  if (refreshOnResume) {
    refreshOnResume = false
    refreshSoon()
  }
}

// 只有真浏览器才挂：单测/Node 里没有 document，这个守卫让 store 仍可被直接 import。
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', onVisibilityChange)
}

/* ---------------------------------------------------------------- 错误上报 */

/**
 * 记一条运行期错误，供 App 顶部错误条显示。
 *
 * 页面最怕的不是"报错"，而是"报错了但没人知道"：错误条 + 计数让白屏/半死状态一眼可辨，
 * 也让用户能把它复制出来，而不是只能说"它就卡住了"。
 * @param error - 错误对象或可读字符串。
 * @param source - 来源标签，例如 `vue:render`、`window.error`、`transcript`。
 * @returns 存进 state 的那段可读文本。
 */
export function reportError (error, source = 'runtime') {
  const message = typeof error === 'string'
    ? error
    : String(error?.message ?? error ?? '未知错误')
  const text = `[${source}] ${message}`.slice(0, 400)
  state.lastError = text
  state.lastErrorAt = Date.now()
  state.errorCount += 1
  return text
}

/** 关掉错误条（错误本身仍在控制台里）。 */
export function clearError () {
  state.lastError = ''
}

/** @returns 一帧快照/分片携带的 durable 事件。 */
function eventsOf (frame) {
  return (Array.isArray(frame?.records) ? frame.records : [])
    .filter((record) => record?.type === 'event')
    .map((record) => record.event)
}

/**
 * @returns 事件窗口的指纹：条数 + 首尾 `seq`。
 *
 * 事件日志按 `seq` 追加、从不原地改写，所以「条数 + 首尾 seq 相同」就是同一段窗口。比三个数字
 * 远比逐条比对便宜，而「同一段历史」正是可以安全跳过整表替换的前提。
 */
function eventsFingerprint (events) {
  if (events.length === 0) return '0'
  return `${String(events.length)}:${String(events[0]?.seq)}:${String(events[events.length - 1]?.seq)}`
}

/**
 * 决定「又收到一份快照」该怎么落地。
 *
 * 现场：EventSource 掉线后浏览器会自动重连，宿主在新连接上立刻重发整份窗口快照（见 index.js 的
 * `pumpSession`）。旧实现对此无条件 `state.events = 快照数组` + `resetTranscriptCache()`，几千行
 * 的会话于是整表重建、每行重跑 markdown 与高亮 —— 读者只是打了几个字，页面却像重新载入了一遍，
 * 大会话上这一次就能把主线程卡住数百毫秒到数秒。
 * @param current - 内存里已有的事件窗口。
 * @param incoming - 快照里的完整事件窗口（必须是完整的：分片会先拼齐再进来）。
 * @returns `same`（同一窗口或当前已经更全，什么都不做）、`append`（只多出尾部，就地追加）、
 *   `replace`（窗口确实变了，只能整表替换）。
 */
function reconcileSnapshot (current, incoming) {
  if (incoming.length === 0) {
    // 空快照：正等着首次快照的加载态必须走替换路径收尾，否则会一直停在 loading 直到超时。
    return current.length === 0 && state.sessionLoading !== true ? 'same' : 'replace'
  }
  if (current.length === 0) return 'replace'
  if (eventsFingerprint(current) === eventsFingerprint(incoming)) return 'same'
  const currentLast = Number(current[current.length - 1]?.seq)
  const incomingFirst = Number(incoming[0]?.seq)
  const incomingLast = Number(incoming[incoming.length - 1]?.seq)
  if (!Number.isFinite(currentLast) || !Number.isFinite(incomingFirst) || !Number.isFinite(incomingLast)) {
    return 'replace'
  }
  // 内存里已经覆盖到更后面（重连前刚收到的实时事件，或窗口被裁剪过）：快照没有新内容。
  if (incomingLast <= currentLast) return 'same'
  // 尾部更新但开头跳号了：中间那段既不在旧窗口也不在新窗口里，只有整表替换才不丢行。
  if (incomingFirst > currentLast + 1) return 'replace'
  return 'append'
}

/**
 * 正在等待拼齐的分片快照。
 *
 * 只在「窗口里已经有内容、宿主又送来一段分片快照（`last === false`）」时出现：先攒着，等最后
 * 一段到齐后一次性对账。这样做是因为拿一段残缺窗口去和当前窗口比较会误判 —— 旧窗口可能被当成
 * 「更旧」而跳过，随后剩余的 chunk 又被逐段追加，既重复又乱序。
 */
let pendingSnapshot

/** 整表替换：唯一会重建转写缓存、并置加载态的路径（真正的窗口变化或首次加载）。 */
function replaceEvents (frame, incoming) {
  pendingEvents = []
  state.eventBacklog = 0
  trackSnapshot(frame)
  state.events = incoming
  // 快照是宿主按窗口给的整表，这里不裁剪（裁剪只发生在追加路径上），只把上一次会话的裁剪标志复位。
  state.eventsTrimmed = false
  resetTranscriptCache()
  // A chunked snapshot is only complete once the last chunk says so; an unchunked one is complete
  // immediately (an earlier Host sent exactly one snapshot frame).
  if (frame.last !== false) finishSessionLoad()
  state.telemetry.running = selectedSession.value?.running === true
}

/**
 * 把一份**完整**快照装进状态：能跳过就跳过、能追加就追加，只有窗口真的变了才整表替换。
 *
 * 跳过与追加都不碰 `sessionLoading`、不走 `finishSessionLoad`、也不清转写缓存 —— 数组不换、行对象
 * 不变，Vue 就不会重渲染，滚动位置也不会被重置。
 * @param frame - 触发它的帧，用于进度与 `last` 判定。
 * @param incoming - 完整的事件窗口。
 */
function applySnapshot (frame, incoming) {
  // 重拉回来的第一份完整快照必须整表替换：当前窗口可能中间缺过帧（后台丢帧），增量对账无法
  // 证明它完整，硬追加会把缺口永久留在页面上。
  if (forceSnapshotReplace) {
    forceSnapshotReplace = false
    replaceEvents(frame, incoming)
    return
  }
  const decision = reconcileSnapshot(state.events, incoming)
  if (decision === 'same') {
    state.snapshotSkips += 1
    return
  }
  if (decision === 'append') {
    const boundary = Number(state.events[state.events.length - 1]?.seq)
    const tail = incoming.filter((event) => Number(event?.seq) > boundary)
    if (tail.length > 0) {
      state.events.push(...tail)
      // 尾部事件可能已经作为实时帧排进了待折叠队列：快照里已有的那些要丢掉，否则会重复插入。
      const last = Number(tail[tail.length - 1]?.seq)
      pendingEvents = pendingEvents.filter((event) => {
        const seq = Number(event?.seq)
        return !Number.isFinite(seq) || seq > last
      })
      state.eventBacklog = pendingEvents.length
    }
    state.telemetry.running = selectedSession.value?.running === true
    return
  }
  replaceEvents(frame, incoming)
}

/**
 * 把一块**更旧**的分片前插到事件窗口头部（宿主从新到旧发分片的落地路径）。
 *
 * 第一帧 `snapshot` 就是最新窗口，所以首屏一落地就能显示最新内容；后续的 `snapshot-append` 都比当前
 * 窗口更旧，只能插到头部，事件窗口必须始终保持 `seq` 升序且没有重复。
 *
 * 返回真正前插的条数；滚动补偿由 ConversationPane 用「前 scrollHeight / 后 scrollHeight」自己算，
 * 这里只负责数据与计数，不碰 DOM。
 * @param frame - 触发它的分片帧（用于进度与 `last` 判定）。
 * @param incoming - 这块分片里的事件（按 seq 升序）。
 * @returns 实际新增的条数。
 */
function prependOlderEvents (frame, incoming) {
  trackSnapshot(frame)
  if (!Array.isArray(incoming) || incoming.length === 0) return 0
  const firstSeq = Number(state.events[0]?.seq)
  // 只接受比窗口起点更旧的事件：重复块（重连后重发）在这里被无声丢掉。
  const older = Number.isFinite(firstSeq)
    ? incoming.filter((event) => {
      const seq = Number(event?.seq)
      return Number.isFinite(seq) && seq < firstSeq
    })
    : incoming
  if (older.length === 0) return 0
  const merged = mergeBySeq(older, state.events)
  if (merged === state.events) return 0
  const before = state.events.length
  state.events = merged
  // 窗口本身受 MAX_EVENTS 约束，前插同样要裁剪（裁剪从头部丢，语义仍是"最旧的先走"）。
  trimEvents()
  state.snapshotPrepended = state.events.length - before
  state.snapshotPrepend += older.length
  state.telemetry.running = selectedSession.value?.running === true
  return older.length
}

/**
 * 合并两段都按 `seq` 升序的事件列表：去重、升序、**已有对象优先**。
 *
 * 保留 `state.events` 里已有的对象身份很重要：Vue 的行、MessageRow 的本地状态都绑在对象上，
 * 能复用就不重建。没有任何新增时返回原数组（调用方据此跳过状态更新）。
 * @param older - 更旧的一段。
 * @param current - 当前窗口。
 */
function mergeBySeq (older, current) {
  const bySeq = new Map()
  const withoutSeq = []
  for (const event of current) {
    const seq = Number(event?.seq)
    if (Number.isFinite(seq)) bySeq.set(seq, event)
    else withoutSeq.push(event)
  }
  let added = 0
  for (const event of older) {
    const seq = Number(event?.seq)
    if (!Number.isFinite(seq)) {
      withoutSeq.unshift(event)
      added += 1
      continue
    }
    if (bySeq.has(seq)) continue
    bySeq.set(seq, event)
    added += 1
  }
  if (added === 0) return current
  const ordered = [...bySeq.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1])
  return [...withoutSeq, ...ordered]
}

function handleFrame (frame) {
  if (frame === null || typeof frame !== 'object') return
  if (frame.type === 'snapshot') {
    pendingSnapshot = undefined
    const chunk = eventsOf(frame)
    // 分片快照的第一帧是**最新**的一块（宿主从新到旧发）：立刻落地，首屏就是最新内容，不等旧的块。
    if (Number(frame.chunkCount) > 1) {
      replaceEvents(frame, chunk)
      return
    }
    applySnapshot(frame, chunk)
    return
  }
  if (frame.type === 'snapshot-append') {
    const more = eventsOf(frame)
    // `older: false` 是旧宿主（从旧到新）的语义；新宿主每块都更旧，前插到头部。
    if (frame.older === false) {
      trackSnapshot(frame)
      if (more.length > 0) {
        state.events.push(...more)
        trimEvents()
      }
    } else {
      prependOlderEvents(frame, more)
    }
    if (frame.last === true) finishSessionLoad()
    return
  }
  if (frame.type === 'event') {
    // Telemetry folds immediately (it is a handful of counters), but the transcript is appended on the
    // next frame: a streaming turn emits many events per second and each append used to re-render every
    // row, which is what made a long Session freeze the tab.
    foldTelemetry(frame.event)
    // 事件帧不可丢：到上限就不再接收，改标记 needsResync 由重拉补回（见 MAX_PENDING_EVENTS）。
    if (pendingEvents.length >= MAX_PENDING_EVENTS) {
      state.eventsDeferred += 1
      state.needsResync = true
      return
    }
    pendingEvents.push(frame.event)
    state.eventBacklog = pendingEvents.length
    scheduleEvents()
    return
  }
  if (frame.type === 'assistant-stream') {
    pendingStreams.push(frame.frame)
    // 隐藏期间或队列过长时就地无损合并：队列长度与"后台待了多久"无关，内容一字不丢。
    if (!pageVisible() || pendingStreams.length > MAX_PENDING_STREAMS) compactStreamBacklog()
    scheduleStreams()
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

/** 正在进行的发送请求，可被 `cancelSend` 中止。 */
let sendAbort

/**
 * 发送消息的等待上限。
 *
 * 比默认的 20 秒短：弱网下"发出去没有"必须尽快有结论，否则输入框会一直挂在"发送中"。
 * 失败时 `sendPrompt` 抛错、调用方（ComposerBar）保留草稿并恢复可点，读者重试即可。
 */
const SEND_TIMEOUT_MS = 12_000

/**
 * Send a message into the selected Session.
 * @param content - prompt content parts (`text`, optional `image` attachments).
 * @param mode - `queue` or `steer`.
 * @param options - `timeoutMs` to override the wait, `signal` to cancel from outside.
 */
export async function sendPrompt (content, mode = 'queue', options = {}) {
  state.actionError = ''
  const controller = new AbortController()
  sendAbort = controller
  // 外部信号与自己的取消器合成一个：任一方取消都立即结束等待。
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, options.signal])
  try {
    await api('/api/send', {
      method: 'POST',
      body: { sessionId: state.selected, content, mode },
      signal,
      timeoutMs: options.timeoutMs ?? SEND_TIMEOUT_MS,
    })
    // 发送成功（宿主已收下）：转录面板据此把自己贴回底部，读者马上能看到自己刚发的那条。
    state.promptSendCount += 1
    // 把这次发送的图片 blob 记成"最近发出的图片"：等它对应的附件事件回来时直接本地回显。
    for (const part of Array.isArray(content) ? content : []) {
      if (part === null || typeof part !== 'object' || part.type !== 'image') continue
      if (typeof part.uploadId !== 'string') continue
      const staged = stagedImageBlobs.get(part.uploadId)
      if (staged === undefined) continue
      stagedImageBlobs.delete(part.uploadId)
      rememberSentImage(staged)
    }
  } catch (error) {
    state.actionError = String(error.message ?? error)
    // 交给调用方处理：输入框的草稿还在，读者可以直接重试。
    throw error
  } finally {
    if (sendAbort === controller) sendAbort = undefined
  }
}

/**
 * 取消正在进行的发送。
 *
 * 弱网下读者可能不想再等一个已经超时的请求了；取消后 `sendPrompt` 以「已取消」失败，
 * 输入框按失败路径恢复，不会卡在「发送中」。
 */
export function cancelSend () {
  sendAbort?.abort()
  sendAbort = undefined
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
 * 图片硬上限：与宿主 `/api/attachment` 的 MAX_UPLOAD_BODY（16MB）保持一致。
 * 超过就直接拒绝，连读都不读 —— 先读进内存再报错，正是"卡死"的开始。
 */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** 超过这个字节数才做降采样；小图原样上传，省一次解码/编码。 */
const DOWNSCALE_OVER_BYTES = 1.5 * 1024 * 1024
/** 降采样后的最长边。1600 足够模型看清正文，也远低于手机照片的 4000+。 */
const MAX_IMAGE_EDGE = 1600
/** WebP 质量：0.9 对截图/文字几乎无损，体积通常只有原图的 1/3–1/8。 */
const IMAGE_QUALITY = 0.9

/** @returns 一位小数的 MB，用于可读报错。 */
function megabytes (bytes) {
  return (Number(bytes) / (1024 * 1024)).toFixed(1)
}

/**
 * 把一张大图压成「上传用」的小 blob。
 *
 * 一次 `createImageBitmap`（浏览器在后台线程解码）+ 一次 `drawImage` + 一次 `convertToBlob`
 * （编码也在后台线程），中间不产生额外的 JS 副本。相比「先 data URL 再让 <img> 解码全尺寸」，
 * 省掉了两次全量解码和数 MB 的字符串。失败就退回原始 blob：宁可传大一点，也不要让粘贴失败。
 * @param file - 原始图片。
 * @returns `{ blob, mediaType, width?, height? }`。
 */
async function shrinkImage (file) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    // 老浏览器没有这套 API：原样上传（仍然是二进制，绝不退回 base64）。
    return { blob: file, mediaType: file.type }
  }
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: IMAGE_QUALITY })
    // 压完反而更大（小图、或本来就压得很好的图）：保留原图。
    if (blob.size >= file.size) return { blob: file, mediaType: file.type, width: bitmap.width, height: bitmap.height }
    return { blob, mediaType: 'image/webp', width, height }
  } catch {
    return { blob: file, mediaType: file.type }
  } finally {
    bitmap.close?.()
  }
}

/**
 * 暂存一张图片附件：全程不读 base64，只留 blob 引用 + 一个 object URL 供预览。
 *
 * 旧实现用 `readAsDataURL` 把 10MB 图变成 13.5M 字符的字符串（UTF-16 约 27MB 堆占用），再切一份
 * base64 给发送用；粘贴两三张就是几十上百 MB 的驻留，加上全尺寸 data URL 解码，主线程直接停住
 * （实测一张 10MB 图光 data URL 解码就占住主线程 24ms，且要重复一次用于预览）。
 * 现在：预览用 `URL.createObjectURL`（零拷贝）、发送走二进制、发送载荷里只带 uploadId。
 * @param file - the picked or pasted image.
 * @returns `{ uploadId, previewUrl, name, mediaType, size, width?, height? }`；previewUrl 用完必须 revoke。
 */
export async function stageImage (file) {
  if (!IMAGE_MEDIA_TYPES.has(file.type)) throw new Error(`不支持的图片类型：${file.type === '' ? '未知' : file.type}`)
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（${megabytes(file.size)} MB），上限 ${String(MAX_IMAGE_BYTES / (1024 * 1024))} MB`)
  }
  if (file.size === 0) throw new Error('这张图片是空的，无法发送')
  const name = file.name === '' ? undefined : file.name
  // GIF 不降采样：canvas 会把动图压成一张静帧。
  const prepared = file.type === 'image/gif' || file.size <= DOWNSCALE_OVER_BYTES
    ? { blob: file, mediaType: file.type }
    : await shrinkImage(file)
  // 预览和上传共用这一份 blob：一个 object URL，没有第二份字节。
  const previewUrl = URL.createObjectURL(prepared.blob)
  try {
    const uploaded = await uploadImage(prepared.blob, { mediaType: prepared.mediaType, name })
    const uploadId = typeof uploaded?.uploadId === 'string' ? uploaded.uploadId : ''
    if (uploadId === '') throw new Error('上传失败：宿主没有返回图片引用')
    // 留一份 blob 给发送后的回显：宿主读不回附件时（见 `ensureAttachmentImage`），页面自己就能画出来。
    stagedImageBlobs.set(uploadId, { blob: prepared.blob, mediaType: prepared.mediaType, name, size: prepared.blob.size })
    while (stagedImageBlobs.size > 12) {
      const oldest = stagedImageBlobs.keys().next().value
      stagedImageBlobs.delete(oldest)
    }
    return {
      uploadId,
      previewUrl,
      name,
      mediaType: prepared.mediaType,
      size: prepared.blob.size,
      ...(typeof prepared.width === 'number' ? { width: prepared.width } : {}),
      ...(typeof prepared.height === 'number' ? { height: prepared.height } : {}),
    }
  } catch (error) {
    // 上传失败就别留着 object URL，否则每失败一次漏一份 blob。
    URL.revokeObjectURL(previewUrl)
    throw error
  }
}

/** 释放一张附件的预览 URL（移除附件、发送成功或卸载时调用）。 */
export function releaseImagePreview (attachment) {
  const url = attachment?.previewUrl
  if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url)
}

/* ---------------------------------------------------------------- session management */

/**
 * @returns 两个字符串数组是否逐项相同。
 *
 * 用来在安装 pinned/archived/pending 这类列表前先比较：相同就不换数组，免得侧栏或待办面板为一个
 * 内容没变的广播重渲染。
 */
function sameStringArray (left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (String(left[index]) !== String(right[index])) return false
  }
  return true
}

/**
 * Install the pinned/archived sets a state or `sessions` payload carries.
 * @param payload - a `/api/state` reply or a `sessions` SSE payload.
 */
function installManagement (payload) {
  if (payload === null || payload === undefined) return
  // 列表内容相同时不赋值：`groupedSessions` 依赖这两个数组，换一次新数组就要整段重排一遍。
  if (Array.isArray(payload.pinnedSessionIds)) {
    const pinned = payload.pinnedSessionIds.map(String)
    if (!sameStringArray(state.pinnedSessionIds, pinned)) state.pinnedSessionIds = pinned
  }
  if (Array.isArray(payload.archivedSessionIds)) {
    const archived = payload.archivedSessionIds.map(String)
    if (!sameStringArray(state.archivedSessionIds, archived)) state.archivedSessionIds = archived
  }
  if (typeof payload.managed === 'boolean') state.managed = payload.managed
}

/** 上一次装进 `state.pending` 的载荷指纹。 */
let pendingSignature = ''
/** 上一次装进 `state.telemetryBySession` 的载荷指纹。 */
let telemetrySignature = ''

/**
 * @returns 一个载荷的稳定指纹。
 *
 * 这里可以放心用 `JSON.stringify`：两个载荷都只由标量和短字符串组成（待办几条、计数几十个），
 * 字符串化一两万个字符约几十微秒；而「换掉对象」的代价是把它们重新包成响应式代理、并让读取它们的
 * 面板与每一行消息重算 —— 那才是要省掉的部分。
 */
function payloadSignature (value) {
  try {
    return value === undefined ? '' : JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * 安装待办载荷：内容没变就整条丢弃。
 * @param pending - `{ questions, approvals }`，可能来自 `/api/state` 或 `pending` 事件。
 */
function installPending (pending) {
  const next = pending ?? { questions: [], approvals: [] }
  const signature = payloadSignature(next)
  if (signature === pendingSignature) return
  pendingSignature = signature
  state.pending = next
}

/**
 * 安装按会话切分的 telemetry 快照：内容没变就不换对象（免得整份嵌套对象重新变成响应式）。
 * @param bySession - `{ [sessionId]: counters }`。
 */
function installTelemetry (bySession) {
  const signature = payloadSignature(bySession)
  if (signature === telemetrySignature) return
  telemetrySignature = signature
  state.telemetryBySession = bySession
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