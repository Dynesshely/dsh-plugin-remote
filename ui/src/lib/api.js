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
 * @param options - optional method and JSON body.
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
 * 解析响应正文。
 *
 * 走 Worker 的理由：`/api/older` 单次 2.8MB、`/api/state` 也有几十 KB，在主线程 `JSON.parse`
 * 就是一次实打实的长任务（输入、滚动、高亮全部停摆）。单例维护在 worker-client.js 内部，
 * 所以这里直接取即可，不再自己缓存一份——两处各缓存会得到两个 Worker。
 * @param text - 已经读成文本的响应正文。
 * @returns 解析出的值。
 */
async function parseResponseBody (text) {
  const { value, error } = await createJsonParser().parse(text)
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
  const payload = text === '' ? {} : await parseResponseBody(text)
  // 用 `?.` 是因为合法 JSON 也可能是 `null`：那不该变成一条 TypeError。
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
  return payload
}

/**
 * Exchange a token from the URL for the session cookie.
 * @param token - the `?k=` value.
 */
export async function login (token) {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rc': '1' },
    body: JSON.stringify({ token }),
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
