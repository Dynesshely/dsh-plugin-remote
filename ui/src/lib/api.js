import { createJsonParser, createStreamParser } from './worker-client.js'

/**
 * Transport for the Remote Control Host plugin: JSON over fetch plus the Session SSE feed.
 *
 * Authentication is cookie-based after the first `?k=` visit, so every request is same-origin and
 * carries the cookie automatically. A 401 bubbles up as `unauthorized` and the shell shows the
 * token form.
 */

/** Thrown when the Host rejects the request because the cookie is missing or stale. */
export class UnauthorizedError extends Error {
  constructor () {
    super('unauthorized')
    this.name = 'UnauthorizedError'
  }
}

/**
 * Perform one JSON request.
 * @param path - absolute path on this origin.
 * @param options - optional method, JSON body, `signal`（可取消）, `timeoutMs`, `project`（投影规格，
 *   默认按路由查 `PROJECTIONS`）。
 * @returns the parsed response body.
 */
/**
 * How long a request may stay unanswered.
 *
 * A fetch on a link that has silently died used to hang forever, which is what left the page spinning
 * with no way out. Failing here turns that into a retryable error the UI can offer.
 */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 响应正文的字符数上限，超过就不解析。
 *
 * 解析 8MB 的 JSON 即使搬进 Worker 也要占住那份 Worker 数百毫秒到数秒；而正常响应里
 * 出现这么大的正文基本只有异常这解释（`/api/older` 2.8MB 已是顶端）。宁可让这一次请求
 * 明确失败，也不要把页面拖进「未响应」。
 */
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024

/**
 * 各路由的投影规格：只保留页面真正会读的字段。
 *
 * 为什么在解析这一层做：Worker 解析完要把结果结构化克隆回主线程，克隆成本与对象体量成正比。
 * 先在 Worker 里裁掉今天没人读的字段，回传和克隆的就是裁完那一份。
 *
 * 规格是纯数据（可结构化克隆送进 Worker）：`true` = 整棵保留，对象 = 递归保留列出的键，数组的
 * 元素沿用同一个规格。不确定某个字段有没有人读时**保留它**——少省一点字节，比让页面读到 undefined
 * 便宜得多。没有列在这里的路由一律不裁剪（形状完全按宿主给的）。
 */
const PROJECTIONS = {
  // 页面读：bind / sessions / workspaces / pending / telemetry / 管理集合 / urls（候选地址展示）。
  '/api/state': {
    bind: true,
    // 会话行只读这 6 个字段（SidebarPane / FilePane / store 的访问点已逐个核对）：
    // id、title、updatedAt、running、origin、workspaceId。宿主还会额外带 cwd、日志路径、
    // 生命周期与调试元数据，那些一个都不进页面。
    sessions: { id: true, title: true, updatedAt: true, running: true, origin: true, workspaceId: true },
    workspaces: true,
    pending: true,
    telemetry: true,
    pinnedSessionIds: true,
    archivedSessionIds: true,
    managed: true,
    urls: true,
  },
  // 页面只读 records（每条只用到 type 与 event）和 hasMore；记录上的其它元数据没人读。
  '/api/older': {
    records: { type: true, event: true },
    hasMore: true,
  },
}

/** 投影表对外只读暴露，便于脚本量测「投影前后」的体积（不参与运行期逻辑）。 */
export const ROUTE_PROJECTIONS = PROJECTIONS

/**
 * 回传分片的字符预算：约 256 KB。
 *
 * 一次 structured clone 的耗时与体量近似线性。2.8MB 的 `/api/older` 一次性克隆是几十毫秒的长任务；
 * 切成十几片之后，每条消息只搬一小段，主线程每次回到事件循环的都很快（分片数量与单片上限见
 * `worker-client.js` 的 `splitValueForTransfer`，单片条目不超过 2000）。
 */
const TRANSFER_CHUNK_CHARS = 256 * 1024

/** @returns 去掉查询串的路由，用于查投影表。 */
function routeOf (path) {
  const at = path.indexOf('?')
  return at === -1 ? path : path.slice(0, at)
}

/**
 * 解析响应正文。
 *
 * 走 Worker 的理由：`/api/older` 单次 2.8MB、`/api/state` 也有几十 KB，在主线程 `JSON.parse`
 * 就是一次实打实的长任务（输入、滚动、高亮全部停摆）。单例维护在 worker-client.js 内部，
 * 所以这里直接取即可，不再自己缓存一份——两处各缓存会得到两个 Worker。
 * @param text - 已经读成文本的响应正文。
 * @param project - 投影规格；`undefined` 表示原样返回。
 * @returns 解析出的值。
 */
async function parseResponseBody (text, project) {
  const { value, error } = await createJsonParser().parse(text, { project, chunkChars: TRANSFER_CHUNK_CHARS })
  // 失败一定要变成一条可读的 Error 抛给调用方，而不是让 SyntaxError 自己往上冒。
  if (error !== undefined) throw new Error(`响应解析失败：${error}`)
  return value
}

export async function api (path, options = {}) {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)]
  if (options.signal !== undefined) signals.push(options.signal)
  const init = {
    method: options.method ?? 'GET',
    headers: { 'x-rc': '1', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  }
  let response
  try {
    response = await fetch(path, init)
  } catch (error) {
    // Distinguish the three cases a caller cares about: cancelled, timed out, never reached the Host.
    if (options.signal?.aborted === true) throw new Error('已取消')
    if (error?.name === 'TimeoutError') throw new Error('请求超时，请重试')
    if (error?.name === 'AbortError') throw new Error('已取消')
    throw new Error('无法连接到宿主，请检查网络')
  }
  if (response.status === 401) throw new UnauthorizedError()
  const text = await response.text()
  // 上限必须在解析之前判断：一旦交给 JSON.parse，这份卡顿就已经花掉了。
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new Error(`响应过大（${(text.length / (1024 * 1024)).toFixed(1)} MB），已拒绝解析`)
  }
  const payload = text === '' ? {} : await parseResponseBody(text, options.project ?? PROJECTIONS[routeOf(path)])
  // 用 `?.` 是因为合法 JSON 也可能是 `null`：那不该变成一条 TypeError。
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
  return payload
}

/**
 * 上传一张图片的**原始字节**。
 *
 * 为什么单独一条路：`api()` 只会 `JSON.stringify` 一个 body，图片走那条路就必须先
 * `readAsDataURL` 变成数 MB 的字符串（10MB 图 ≈ 13.5M 字符 ≈ 27MB 堆上驻留，再被 stringify
 * 复制一次），主线程和 GC 一起遭殃。这里 body 直接是 `Blob`，浏览器负责流式发送，页面不经过
 * base64、也不拼 JSON；宿主回一个短小的 `{ uploadId, attachment }` 引用，发送时只引用它。
 * @param source - 图片字节（`File` / `Blob`）。
 * @param options - `{ mediaType?, name?, signal?, timeoutMs? }`。
 * @returns Host 的回执：`{ uploadId, attachment, mediaType, name, size, width?, height? }`。
 */
export async function uploadImage (source, options = {}) {
  const mediaType = options.mediaType ?? (typeof source.type === 'string' && source.type !== '' ? source.type : 'application/octet-stream')
  const query = new URLSearchParams({ mediaType })
  if (typeof options.name === 'string' && options.name !== '') query.set('name', options.name)
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 120_000)]
  if (options.signal !== undefined) signals.push(options.signal)
  let response
  try {
    response = await fetch(`/api/attachment?${query.toString()}`, {
      method: 'POST',
      headers: { 'x-rc': '1', 'content-type': mediaType },
      // 关键：body 就是 Blob 本身。浏览器按字节流发送，既不 base64 也不进 JS 堆。
      body: source,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
  } catch (error) {
    if (options.signal?.aborted === true) throw new Error('已取消')
    if (error?.name === 'TimeoutError') throw new Error('图片上传超时，请重试')
    if (error?.name === 'AbortError') throw new Error('已取消')
    throw new Error('无法连接到宿主，请检查网络')
  }
  if (response.status === 401) throw new UnauthorizedError()
  const text = await response.text()
  const payload = text === '' ? {} : await parseResponseBody(text)
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
  return payload
}

/**
 * Exchange a token from the URL for the session cookie.
 * @param token - the `?k=` value.
 *
 * 必须带超时：这一步在启动路径上，弱网下没有超时的 fetch 会一直挂着，页面就永远停在启动骨架里
 * （看起来就是一片黑）。失败就明确失败，调用方才能提示令牌无效或网络不可达。
 */
export async function login (token) {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc': '1' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('令牌不正确')
}

/** @returns whether a `?k=` token was present, after consuming it into a cookie. */
export async function consumeLinkToken () {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('k')
  if (token === null || token === '') return false
  await login(token)
  // The token must not stay in the address bar, history, or any later Referer.
  window.history.replaceState(null, '', window.location.pathname)
  return true
}

/**
 * Open the Session feed.
 * @param sessionId - the Session to follow.
 * @param handlers - `{ onFrame, onPending, onSessions, onError, onOpen }`.
 * @returns the EventSource, so the caller can close it when the selection changes.
 */
/**
 * The stream parser, shared by every connection.
 *
 * One Worker for the page. Creating one per stream leaked a Worker on every reconnect, and parsing each
 * frame through its own round trip put a growing queue behind a promise chain — with a reply arriving
 * dozens of frames per second that is what hung the tab (RESULT_CODE_HUNG).
 */
let sharedParser

/** @returns the shared parser, created on first use. */
function getParser () {
  if (sharedParser === undefined) sharedParser = createStreamParser()
  return sharedParser
}

/** The most frames parsed in a single Worker round trip. */
const PARSE_BATCH = 64

export function openStream (sessionId, handlers) {
  const parser = getParser()
  /**
   * One queue per event channel. Order inside a channel is all the page ever relied on, and batching
   * keeps the number of round trips proportional to wall-clock time rather than to frame count.
   */
  const queues = new Map()
  let draining = false
  /**
   * 这条连接是否已被调用方关掉。
   *
   * `EventSource.close()` 只停止接收，已经排进队列的帧还会被 drain 继续消费 —— 切换会话之后，旧
   * 会话的帧就会折进新会话的转写里。这个标志在关闭时清空队列并让消费循环退出，把那条路径截断。
   */
  let closed = false

  /** Keep draining channel queues until every one of them is empty. */
  const drain = async () => {
    if (closed || draining) return
    draining = true
    try {
      for (;;) {
        if (closed) break
        const busy = [...queues.values()].filter((entry) => entry.items.length > 0)
        if (busy.length === 0) break
        for (const entry of busy) {
          if (closed) break
          const batch = entry.items.splice(0, PARSE_BATCH)
          if (batch.length === 0) continue
          const result = await parser.parse(batch)
          if (closed) break
          for (const frame of result.frames) {
            try {
              entry.handler(entry.pick === undefined ? frame : entry.pick(frame))
            } catch (error) {
              handlers.onError?.(String(error?.message ?? error))
            }
          }
          if (result.errors.length > 0) handlers.onError?.(result.errors[0])
        }
      }
    } finally {
      draining = false
    }
  }

  /**
   * @param key - the event channel name.
   * @param handler - the callback for that channel.
   * @param payload - the raw `event.data` text.
   * @param pick - optional projection applied to each parsed frame.
   */
  const enqueue = (key, handler, payload, pick) => {
    if (closed || handler === undefined) return
    let entry = queues.get(key)
    if (entry === undefined) {
      entry = { handler, pick, items: [] }
      queues.set(key, entry)
    }
    entry.items.push(payload)
    if (!draining) void drain()
  }
  const source = new EventSource(`/api/stream?sessionId=${encodeURIComponent(sessionId)}`)
  /**
   * 这条连接上收到过多少次 `hello`。
   *
   * 宿主每接受一条新连接都会先发 `hello`，然后立刻重发整份会话快照（见 index.js 的 `pumpSession`）。
   * 所以 hello 次数就是重连次数 + 1，把它交给上层，页面才有办法说明「我什么都没做，为什么它自己
   * 重新载入了」。
   */
  let hellos = 0
  source.addEventListener('frame', (event) => {
    try {
      enqueue('frame', handlers.onFrame, event.data)
    } catch (error) {
      // A frame that cannot be read has to be said out loud: keeping the previous transcript in silence is
      // exactly how a Session ends up looking empty.
      handlers.onError?.('数据帧解析失败（' + String(event.data.length) + ' 字节）：' + String(error?.message ?? error))
    }
  })
  source.addEventListener('pending', (event) => {
    enqueue('pending', handlers.onPending, event.data)
  })
  source.addEventListener('sessions', (event) => {
    enqueue('sessions', handlers.onSessions, event.data, (frame) => frame.sessions ?? [])
  })
  source.addEventListener('stream-error', (event) => {
    enqueue('stream-error', handlers.onError, event.data, (frame) => frame.message)
  })
  source.addEventListener('hello', () => {
    if (closed) return
    hellos += 1
    handlers.onOpen?.({ reconnects: hellos - 1, at: Date.now() })
  })
  source.onerror = () => {
    // 浏览器会自己重连，所以这里只报状态，不触发任何重新加载：上层拿到消息只更新提示，
    // 真正的快照去重发生在 store 的 handleFrame 里。
    handlers.onError?.('连接中断，正在重连…')
  }
  // 关掉连接时顺手封死队列，见 `closed` 的说明。
  const nativeClose = source.close.bind(source)
  source.close = () => {
    if (closed) return
    closed = true
    queues.clear()
    nativeClose()
  }
  return source
}
