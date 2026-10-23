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
  const payload = text === '' ? {} : JSON.parse(text)
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`)
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
export function openStream (sessionId, handlers) {
  const source = new EventSource(`/api/stream?sessionId=${encodeURIComponent(sessionId)}`)
  source.addEventListener('frame', (event) => {
    try {
      handlers.onFrame?.(JSON.parse(event.data))
    } catch (error) {
      // A frame that cannot be read has to be said out loud: keeping the previous transcript in silence is
      // exactly how a Session ends up looking empty.
      handlers.onError?.('数据帧解析失败（' + String(event.data.length) + ' 字节）：' + String(error?.message ?? error))
    }
  })
  source.addEventListener('pending', (event) => {
    handlers.onPending?.(JSON.parse(event.data))
  })
  source.addEventListener('sessions', (event) => {
    handlers.onSessions?.(JSON.parse(event.data).sessions ?? [])
  })
  source.addEventListener('stream-error', (event) => {
    handlers.onError?.(JSON.parse(event.data).message)
  })
  source.addEventListener('hello', () => {
    handlers.onOpen?.()
  })
  source.onerror = () => {
    handlers.onError?.('连接中断，正在重连…')
  }
  return source
}
