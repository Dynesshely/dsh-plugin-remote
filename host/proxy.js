import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { overlayMarkup } from './overlay.js'

/**
 * Reverse proxy for the DeepSeek Harness Web GUI.
 *
 * The plugin serves its own page under `/remote`; everything else is forwarded to the DSH web app running in the
 * same process, so a phone that can reach this plugin can also use the full desktop interface.
 *
 * Authentication is the reason this file exists. DSH authenticates with a cookie whose *name* is derived from the
 * request's `Host` and whose *value* is signed by a per-process secret. Two consequences follow, and both are
 * handled here:
 *
 * 1. The `Host` header is rewritten to the upstream authority, because the cookie is bound to it.
 * 2. The browser holds no DSH cookie at all. The proxy obtains one itself, once, using the launch token that
 *    `ctx.connection.authenticatedUrl()` appends, and reuses it. That means the proxy never reads the credential
 *    file and never needs the signing secret.
 *
 * WebSocket works because after the handshake a WebSocket is a plain TCP stream: the upgrade request is rewritten
 * the same way and the two sockets are piped together. No frame parsing is involved.
 */

/**
 * Markup appended to every proxied HTML document.
 *
 * The desktop interface has no idea it is being proxied, so without this the only way back to the plugin page is
 * editing the URL. It is inline-styled on purpose: DSH ships no CSP today, but depending on its class names or
 * stylesheet would break the moment its bundle changes.
 *
 * The label carries both languages rather than reading the page's locale: this element is the only thing here that
 * does not belong to DSH, and a stuck label is worse than a slightly redundant one.
 */

/** Query key DSH reads the launch token from. */
const TOKEN_QUERY = 'token'

/** Headers that must not be forwarded between hops. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

/**
 * @param headers - incoming request headers.
 * @param authority - the upstream `host:port`.
 * @param cookie - the DSH cookie to send, when one has been obtained.
 * @returns headers suitable for the upstream request.
 *
 * `Host` is replaced rather than forwarded: the cookie DSH accepts is derived from this exact value, so forwarding
 * the browser's `10.0.30.81:19400` would make every request look unauthenticated.
 */
function upstreamHeaders (headers, authority, cookie, origin) {
  const next = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    if (name.toLowerCase() === 'host') continue
    next[name] = value
  }
  next.host = authority
  if (cookie !== undefined) next.cookie = cookie
  // Only a document request has to arrive decompressed, because that response gets rewritten. Dropping compression
  // for everything would force the ~1 MB bundle across the wire uncompressed on every load.
  if (String(headers.accept ?? '').includes('text/html')) delete next['accept-encoding']
  // Rewriting Host alone is not enough: DSH rejects a request whose Origin does not match the authority it is
  // serving, which is exactly what a proxy creates — the browser says `http://<lan>:19400`, the Host says
  // `127.0.0.1:64230`. Both have to describe the same upstream, or every RPC answers 403.
  if (origin !== undefined) {
    if (headers.origin !== undefined) next.origin = origin
    if (headers.referer !== undefined) next.referer = `${origin}/`
  }
  return next
}

/**
 * Rewrite upstream `set-cookie` values so the browser will accept them.
 *
 * DSH sets its cookie for the authority it believes it is serving. The browser is talking to this proxy on a
 * different origin, so `Domain` must go (it would be rejected as a foreign domain) and `Secure` must go too when
 * the proxy itself is reached over plain HTTP on the LAN.
 * @param values - the upstream header values.
 * @param secure - whether the proxy is being read over HTTPS.
 * @returns header values safe to hand to the browser.
 */
function downstreamCookies (values, secure) {
  return values.map((value) => value
    .split(';')
    .filter((part) => {
      const name = part.trim().toLowerCase()
      if (name.startsWith('domain=')) return false
      if (!secure && name.startsWith('secure')) return false
      return true
    })
    .join(';'))
}

/**
 * @param options - proxy configuration.
 * @param options.baseUrl - a function returning the upstream base URL (`http://127.0.0.1:52027`).
 * @param options.authenticatedUrl - a function turning a URL into one carrying the launch token.
 * @param options.logger - optional logger for upstream failures.
 * @returns `{ handle, handleUpgrade, warmUp, status }`.
 */
export function createDshProxy (options) {
  const { baseUrl, authenticatedUrl, logger } = options

  /** The DSH cookie obtained from the launch token, reused for every downstream request. */
  let cookie
  /** Pending cookie acquisition, so a burst of first requests does not mint several. */
  let pending
  /** Last upstream failure, exposed for diagnostics. */
  let failure

  /**
   * Exchange the launch token for a DSH cookie.
   *
   * DSH mints the cookie when the launch token arrives as a root query parameter and answers with a redirect, so
   * this follows exactly one hop and reads the cookie off it.
   * @returns the cookie, or undefined when the exchange failed.
   */
  async function acquire () {
    const base = baseUrl()
    if (base === undefined || base === '') return undefined
    const target = new URL(authenticatedUrl(base))
    target.pathname = '/'
    return await new Promise((resolve) => {
      const request = httpRequest({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { host: target.host },
      }, (response) => {
        const values = response.headers['set-cookie']
        response.resume()
        if (!Array.isArray(values) || values.length === 0) {
          failure = `upstream answered ${String(response.statusCode)} without a cookie`
          resolve(undefined)
          return
        }
        // Only the name=value pair matters upstream; attributes are recomputed on the way down.
        const pairs = values.map((value) => value.split(';')[0].trim())
        failure = undefined
        resolve(pairs.join('; '))
      })
      request.on('error', (error) => {
        failure = String(error?.message ?? error)
        resolve(undefined)
      })
      request.setTimeout(10_000, () => {
        failure = 'upstream timed out'
        request.destroy()
      })
      request.end()
    })
  }

  /** @returns a cookie, acquiring one on first use. */
  function cookieFor () {
    if (cookie !== undefined) return Promise.resolve(cookie)
    if (pending === undefined) {
      pending = acquire().then((value) => {
        pending = undefined
        if (value !== undefined) cookie = value
        return value
      })
    }
    return pending
  }

  /**
   * Forward one ordinary request.
   * @param request - the browser's request.
   * @param response - the browser's response.
   * @param pathname - path to request upstream, with the plugin's own prefix already removed.
   * @returns whether the request was forwarded.
   */
  async function handle (request, response, pathname) {
    const base = baseUrl()
    if (base === undefined || base === '') {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('DSH 的 Web 界面还没有启动，暂时无法转发。\n')
      return true
    }
    const target = new URL(base)
    const authority = target.host
    const current = await cookieFor()
    const search = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
    const upstream = httpRequest({
      host: target.hostname,
      port: target.port,
      path: `${pathname}${search}`,
      method: request.method,
      headers: upstreamHeaders(request.headers, authority, current, `${target.protocol}//${target.host}`),
    }, (reply) => {
      const headers = {}
      for (const [name, value] of Object.entries(reply.headers)) {
        if (value === undefined) continue
        if (HOP_BY_HOP.has(name.toLowerCase())) continue
        headers[name] = value
      }
      if (Array.isArray(reply.headers['set-cookie'])) {
        headers['set-cookie'] = downstreamCookies(reply.headers['set-cookie'], false)
      }
      // Only the document that boots the app gets the way back; assets stream through untouched.
      const type = String(reply.headers['content-type'] ?? '')
      if (!type.includes('text/html')) {
        response.writeHead(reply.statusCode ?? 502, headers)
        reply.pipe(response)
        return
      }
      const chunks = []
      reply.on('data', (chunk) => chunks.push(chunk))
      reply.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const patched = body.includes('</body>')
          ? body.replace('</body>', `${overlayMarkup()}</body>`)
          : `${body}${overlayMarkup()}`
        const payload = Buffer.from(patched, 'utf8')
        delete headers['content-length']
        headers['content-length'] = String(payload.byteLength)
        response.writeHead(reply.statusCode ?? 502, headers)
        response.end(payload)
      })
      reply.on('error', () => {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('上游在传输页面时中断。\n')
        } else {
          response.destroy()
        }
      })
    })
    upstream.on('error', (error) => {
      failure = String(error?.message ?? error)
      logger?.warn?.(`[remote-control] proxy failed: ${failure}`)
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(`无法转发到 DSH 的 Web 界面：${failure}\n`)
      } else {
        response.destroy()
      }
    })
    request.pipe(upstream)
    return true
  }

  /**
   * Forward a WebSocket upgrade.
   * @param request - the upgrade request.
   * @param socket - the browser's socket.
   * @param head - bytes already read from it.
   * @returns whether the upgrade was forwarded.
   *
   * The handshake is replayed upstream with the same headers (including `sec-websocket-key`) plus the rewritten
   * `Host` and cookie; once DSH answers, both sockets are piped raw. A WebSocket after its handshake is TCP, so
   * frames need no interpretation and binary payloads pass through untouched.
   */
  async function handleUpgrade (request, socket, head) {
    const base = baseUrl()
    if (base === undefined || base === '') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      return true
    }
    const target = new URL(base)
    const current = await cookieFor()
    const upstream = netConnect({
      host: target.hostname,
      port: Number(target.port === '' ? 80 : target.port),
    })
    upstream.on('error', (error) => {
      failure = String(error?.message ?? error)
      logger?.warn?.(`[remote-control] proxy upgrade failed: ${failure}`)
      socket.destroy()
    })
    upstream.on('connect', () => {
      const headers = {
        ...upstreamHeaders(request.headers, target.host, current, `${target.protocol}//${target.host}`),
        connection: 'Upgrade',
        upgrade: request.headers.upgrade ?? 'websocket',
      }
      const lines = [`${request.method ?? 'GET'} ${request.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        lines.push(`${name}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    socket.on('error', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    return true
  }

  /**
   * Obtain the cookie ahead of the first browser request.
   *
   * Best effort and deliberately unawaited by the caller: a failure here is retried on the first real request, and
   * a slow upstream must not delay the plugin's own page.
   */
  function warmUp () {
    void cookieFor()
  }

  /** @returns diagnostics for `/remote/api/diagnose`. */
  function status () {
    const base = baseUrl()
    return {
      upstream: base ?? '',
      hasCookie: cookie !== undefined,
      failure,
    }
  }

  return { handle, handleUpgrade, warmUp, status }
}
