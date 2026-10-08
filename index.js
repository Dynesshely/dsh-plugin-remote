/**
 * Remote Control — a small authenticated page that drives this Harness from another device.
 *
 * Shape
 * -----
 * The plugin owns its OWN HTTP listener; it never touches the Desktop shell's loopback carrier
 * (that one is token-gated and assumes its visitor is the Electron window). That keeps this plugin
 * free of any Electron coupling: the page is plain HTML served from here, and it speaks only to
 * this plugin's JSON+SSE API.
 *
 * It exposes three Host capabilities, all through official services:
 *
 *   - `ctx.sessionController.list()`   — the visible Session catalog (running, blank, cwd, title projection)
 *   - `ctx.sessionController.follow()` — one Session's opening snapshot plus its durable event frames
 *                                        and live assistant-stream frames, forwarded as SSE
 *   - `ctx.sessionController.prompt()` — admit one prompt exactly as the desktop composer does,
 *                                        so a remote message is a normal user message in the log
 *
 * Pending interactions come from the two answerer waterfalls, registered on each agent's own
 * context (`agent.ctx`) as the framework requires:
 *
 *   - `user-questions/request` — observed (`next()` is always called, so the desktop panel still
 *     works) and answerable remotely through `ctx.userQuestions.answer()`, which is the same call
 *     the desktop UI makes.
 *   - `approval/request`       — observed only. That waterfall is a single-slot decision owned by
 *     the answering chain; hijacking it would leave the desktop panel unresolved, so the remote
 *     page shows the request and asks the user to confirm in the desktop window.
 *
 * Security
 * --------
 * A 32-byte token gates everything. It is read from `config.token`, else from
 * `<DSH home>/remote-control/auth.json` (created on first start, 0600), else generated. The page
 * turns `?k=<token>` into an HttpOnly `SameSite=Strict` cookie so the token stops travelling in
 * URLs. Failed logins are rate-limited per peer, bodies are capped, and every mutating route
 * requires a JSON content type. Binding to anything but loopback is an explicit opt-in.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This plugin cannot do anything useful without the Session Controller. */
export const inject = ['sessionController']

/** The legacy single-file page, kept as the fallback when the SPA has not been built. */
const PAGE_PATH = fileURLToPath(new URL('./page.html', import.meta.url))
/** The built Vue SPA (`ui/dist`), served as the primary UI. */
const DIST_ROOT = fileURLToPath(new URL('./ui/dist', import.meta.url))
const DIST_INDEX = join(DIST_ROOT, 'index.html')
/** Content types for the few extensions a Vite bundle produces. */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
})
const COOKIE_NAME = 'dsh_rc'
/** Largest JSON body accepted, in bytes. */
const MAX_BODY = 64 * 1024
/**
 * Attachment uploads carry base64 image bytes, and a pasted screenshot is easily a few hundred
 * kilobytes; the general cap would reject every paste with a parse failure. Prompts share this cap
 * because image bytes travel inside the prompt itself.
 */
const MAX_UPLOAD_BODY = 16 * 1024 * 1024
/** Concurrent SSE clients. */
const MAX_CLIENTS = 8
/** Failed logins per peer per window. */
const LOGIN_LIMIT = 6
const LOGIN_WINDOW_MS = 60_000
/**
 * History window requested from `follow` for a freshly opened Session.
 *
 * The Host walks back until the FIRST turn boundary where both lower bounds hold (capped at
 * `maxMessages`, or when history runs out), so the two numbers decide how much the page can show:
 * with a small window a long Session opened on its last few turns only.
 */
const FOLLOW_WINDOW = Object.freeze({ maxMessages: 500, turnWindow: { minMessages: 320, minTurns: 20 } })
/** One backward page for "load earlier": smaller, so paging stays responsive. */
const OLDER_WINDOW = Object.freeze({ maxMessages: 200, turnWindow: { minMessages: 150, minTurns: 10 } })
/** Attachment media types this plugin is willing to stage. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** @returns the sanitized plugin configuration. */
function resolveConfig (input) {
  const config = typeof input === 'object' && input !== null ? input : {}
  const port = Number.isInteger(config.port) && config.port >= 0 && config.port < 65_536 ? config.port : 19_400
  const bind = typeof config.bind === 'string' && config.bind.trim() !== '' ? config.bind.trim() : '127.0.0.1'
  const token = typeof config.token === 'string' && config.token.length >= 16 ? config.token : undefined
  return { port, bind, token }
}

/** @returns the token file path under the Harness home. */
function authFile () {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'remote-control', 'auth.json')
}

/**
 * Resolve the shared secret: configured first, then the persisted one, then a fresh one.
 * @param configured - token from the plugin config, when present.
 * @returns the token plus where it came from.
 */
function resolveToken (configured) {
  if (configured !== undefined) return { token: configured, file: undefined, generated: false }
  const file = authFile()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed?.token === 'string' && parsed.token.length >= 16) {
      return { token: parsed.token, file, generated: false }
    }
  } catch {
    /* absent or unreadable: mint a new one */
  }
  const token = randomBytes(32).toString('base64url')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  } catch {
    /* a read-only home still yields a usable in-memory token */
  }
  return { token, file, generated: true }
}

/** @returns whether two secrets match, in constant time. */
function secretMatches (expected, candidate) {
  if (typeof candidate !== 'string') return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(candidate, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** @returns the cookie value for a request, if any. */
function cookieOf (request, name) {
  const header = request.headers.cookie
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

/** @returns the presented secret from the cookie or the Authorization header. */
function presentedSecret (request) {
  const cookie = cookieOf(request, COOKIE_NAME)
  if (typeof cookie === 'string' && cookie !== '') return cookie
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  return undefined
}

/** @returns the request body parsed as JSON, or throws a tagged error. */
async function readJson (request, limit = MAX_BODY) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function sendJson (response, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(payload)
}

/** @returns the Session catalog shaped for the page. */
function sessionsOf (ctx) {
  const listed = ctx.sessionController.list({}, new AbortController().signal)
  return Promise.resolve(listed).then((value) => {
    const items = Array.isArray(value?.items) ? value.items : []
    return items.map((item) => {
      const projections = item?.projections?.values ?? {}
      const title = typeof projections.title === 'string' && projections.title !== ''
        ? projections.title
        : undefined
      const cwd = typeof item?.cwd === 'string' ? item.cwd : undefined
      return {
        id: String(item.sessionId),
        title: title ?? (cwd === undefined ? undefined : basename(cwd)),
        running: item.running === true,
        blank: item.blank === true,
        parentId: typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined,
        origin: item.origin === 'subagent' ? 'subagent' : 'main',
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
      }
    })
  })
}

/** @returns the last path segment of a Windows or POSIX path. */
function basename (path) {
  const parts = path.split(/[\\/]/u).filter((part) => part !== '')
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/** @returns the URLs a client could use, so the README and the page can show them. */
function candidateUrls (bind, port) {
  const urls = [`http://127.0.0.1:${String(port)}`]
  if (bind !== '0.0.0.0' && bind !== '::' && bind !== '127.0.0.1') {
    urls.push(`http://${bind}:${String(port)}`)
    return urls
  }
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && entry.internal !== true) urls.push(`http://${entry.address}:${String(port)}`)
      }
    }
  } catch {
    /* interface enumeration is best effort */
  }
  return urls
}

/**
 * Read one file from the built SPA.
 * @param pathname - the request path.
 * @returns the bytes and their content type, or undefined when nothing matches.
 */
function readAsset (pathname) {
  if (!existsSync(DIST_ROOT)) return undefined
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/u, '')
  const target = resolve(DIST_ROOT, relative === '' ? 'index.html' : relative)
  // Never serve anything outside the bundle directory.
  if (target !== DIST_ROOT && !target.startsWith(`${DIST_ROOT}${sep}`)) return undefined
  try {
    const info = statSync(target)
    if (!info.isFile()) return undefined
    return { body: readFileSync(target), type: MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', immutable: /^assets[/\\]/u.test(relative) }
  } catch {
    return undefined
  }
}

/**
 * List the deployment's workspaces so the sidebar can group Sessions the way the desktop does.
 * @param ctx - Host context.
 * @returns `{ id, title, path, sessionIds }` per workspace.
 */
async function workspacesOf (ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return []
  try {
    const list = await registry.list()
    return (Array.isArray(list) ? list : []).map((workspace) => ({
      id: String(workspace.id),
      title: String(workspace.title ?? ''),
      path: String(workspace.path ?? ''),
      sessionIds: (workspace.sessionIds ?? []).map(String),
    }))
  } catch {
    return []
  }
}

/**
 * Resolve a live Session, resuming a cold one only when the caller needs a live object.
 * @param ctx - Host context.
 * @param sessionId - durable Session identity.
 * @returns the live Session, or undefined when it cannot be activated.
 */
async function liveSessionOf (ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  const existing = sessions.get(sessionId)
  if (existing !== undefined) return existing
  try {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if (resolved?.error !== undefined) return undefined
    return sessions.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Normalize a submitted message into prompt content parts.
 *
 * Image bytes travel inside the prompt (`{type:'image', mediaType, data, name?}`), which is exactly
 * what the Desktop composer submits: the Host admits and stores them with the submission. The
 * legacy page sends `text`, which stays supported.
 * @param body - the parsed request body.
 * @returns the accepted content parts.
 */
function promptContentOf (body) {
  const parts = []
  if (Array.isArray(body?.content)) {
    for (const part of body.content) {
      if (part === null || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
        parts.push({ type: 'text', text: part.text.trim() })
        continue
      }
      if (part.type === 'image' && typeof part.data === 'string' && typeof part.mediaType === 'string') {
        if (!IMAGE_TYPES.has(part.mediaType)) continue
        parts.push({
          type: 'image',
          mediaType: part.mediaType,
          data: part.data,
          ...(typeof part.name === 'string' && part.name !== '' ? { name: part.name } : {}),
        })
        continue
      }
      if ((part.type === 'image' || part.type === 'file') && typeof part.attachment === 'object' && part.attachment !== null) {
        parts.push({ type: part.type, attachment: part.attachment })
      }
    }
    return parts
  }
  if (typeof body?.text === 'string' && body.text.trim() !== '') parts.push({ type: 'text', text: body.text.trim() })
  return parts
}

/**
 * Install the remote control listener for this profile.
 * @param ctx - Host plugin context.
 * @param config - the row's configuration.
 */
export function apply (ctx, config) {
  const settings = resolveConfig(config)
  const secret = resolveToken(settings.token)
  const legacyPage = readFileSync(PAGE_PATH, 'utf8')
  /** Live SSE clients. */
  const clients = new Set()
  /** Pending questions, keyed by tool-call id. */
  const questions = new Map()
  /** Pending approvals, keyed by a synthetic key. */
  const approvals = new Map()
  /** Failed-login counters keyed by peer address. */
  const attempts = new Map()

  /** Push one event to every connected client. */
  const broadcast = (event, data) => {
    for (const client of clients) writeEvent(client, event, data)
  }

  /** Write one SSE event, dropping the client when the socket is gone. */
  function writeEvent (client, event, data) {
    try {
      client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      dropClient(client)
    }
  }

  /** Remove one SSE client and stop its Session stream. */
  function dropClient (client) {
    if (client.closed) return
    client.closed = true
    clients.delete(client)
    try {
      client.sessionAbort?.abort()
    } catch {
      /* already aborted */
    }
    try {
      client.response.end()
    } catch {
      /* already ended */
    }
  }

  /** @returns the pending-interaction payload shared by `/api/state` and the SSE feed. */
  const pendingPayload = () => ({
    questions: [...questions.values()],
    approvals: [...approvals.values()],
  })

  /**
   * Follow one Session into an SSE client until it is replaced or the client leaves.
   * @param client - the SSE client.
   * @param sessionId - the Session to stream.
   */
  async function pumpSession (client, sessionId) {
    try {
      client.sessionAbort?.abort()
    } catch {
      /* nothing to abort */
    }
    const controller = new AbortController()
    client.sessionAbort = controller
    client.sessionId = sessionId
    try {
      const stream = ctx.sessionController.follow({
        address: { kind: 'session', sessionId },
        assistantStream: true,
        ...FOLLOW_WINDOW,
      }, controller.signal)
      for await (const frame of stream) {
        if (client.closed || client.sessionAbort !== controller) return
        writeEvent(client, 'frame', frame)
      }
    } catch (error) {
      if (client.closed || controller.signal.aborted) return
      writeEvent(client, 'stream-error', { message: String(error?.message ?? error) })
    }
  }

  /** @returns whether this peer may try a login right now. */
  function loginAllowed (peer) {
    const now = Date.now()
    const record = attempts.get(peer)
    if (record === undefined || now - record.start > LOGIN_WINDOW_MS) {
      attempts.set(peer, { start: now, count: 1 })
      return true
    }
    record.count += 1
    return record.count <= LOGIN_LIMIT
  }

  /** Route one request. */
  const handle = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://remote-control.invalid')
    const peer = request.socket.remoteAddress ?? 'unknown'
    const authorized = secretMatches(secret.token, presentedSecret(request))
    const json = (status, body, headers) => sendJson(response, status, body, headers)

    if (request.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/healthz') {
      // The built SPA is the primary UI; the legacy page is the fallback when it is absent.
      const asset = readAsset(url.pathname)
      const isShellRequest = url.pathname === '/' || url.pathname === '/index.html' || asset === undefined
      const body = isShellRequest ? (existsSync(DIST_INDEX) ? readFileSync(DIST_INDEX) : Buffer.from(legacyPage, 'utf8')) : asset.body
      const type = isShellRequest ? MIME['.html'] : asset.type
      response.writeHead(200, {
        'content-type': type,
        'cache-control': isShellRequest || asset?.immutable !== true ? 'no-store' : 'public, max-age=31536000, immutable',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        // The shell needs its own bundle plus inline styles; everything else stays blocked.
        'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      })
      response.end(body)
      return
    }
    if (request.method === 'GET' && url.pathname === '/healthz') {
      json(200, { ok: true, product: 'dsh-remote-control', urls: candidateUrls(settings.bind, boundPort) })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      if (!loginAllowed(peer)) {
        json(429, { error: 'too many attempts' })
        return
      }
      let body
      try {
        body = await readJson(request)
      } catch {
        json(400, { error: 'bad request' })
        return
      }
      if (!secretMatches(secret.token, typeof body.token === 'string' ? body.token : undefined)) {
        json(401, { error: 'bad token' })
        return
      }
      attempts.delete(peer)
      json(200, { ok: true }, {
        'set-cookie': `${COOKIE_NAME}=${secret.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      json(200, { ok: true }, { 'set-cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
      return
    }

    if (!url.pathname.startsWith('/api/')) {
      json(404, { error: 'not found' })
      return
    }
    if (!authorized) {
      json(401, { error: 'unauthorized' })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      try {
        const [sessions, workspaces] = await Promise.all([sessionsOf(ctx), workspacesOf(ctx)])
        // A Session belongs to the workspace that lists it; cwd is the fallback for older rows.
        const byMembership = new Map()
        for (const workspace of workspaces) {
          for (const sessionId of workspace.sessionIds) byMembership.set(sessionId, workspace.id)
        }
        for (const session of sessions) {
          const direct = byMembership.get(session.id)
          if (direct !== undefined) {
            session.workspaceId = direct
            continue
          }
          const owner = session.cwd === undefined
            ? undefined
            : workspaces.find((workspace) => workspace.path !== '' && session.cwd.startsWith(workspace.path))
          if (owner !== undefined) session.workspaceId = owner.id
        }
        json(200, {
          sessions,
          workspaces,
          pending: pendingPayload(),
          urls: candidateUrls(settings.bind, boundPort),
          bind: settings.bind,
        })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/models') {
      try {
        const catalog = await ctx.sessionController.modelCatalog()
        json(200, { default: catalog?.default, groups: catalog?.groups ?? [], failures: catalog?.failures ?? [] })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/selection') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const session = ctx.get('sessions')?.get(sessionId)
      const header = session?.requestHeader?.()
      json(200, {
        selected: header === undefined
          ? null
          : { provider: header.config.provider, model: header.config.model, reasoningEffort: header.config.reasoningEffort },
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/select-model') {
      let body
      try {
        body = await readJson(request)
      } catch {
        json(400, { error: 'bad request' })
        return
      }
      if (typeof body.sessionId !== 'string' || typeof body.provider !== 'string' || typeof body.model !== 'string') {
        json(400, { error: 'sessionId, provider and model are required' })
        return
      }
      try {
        const value = await ctx.sessionController.selectModel({
          sessionId: body.sessionId,
          provider: body.provider,
          model: body.model,
          ...(typeof body.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort } : {}),
        })
        json(200, { selected: value?.selected })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/permissions') {
      const presets = ctx.get('permissionPresets')
      if (presets === undefined) {
        json(200, { options: [], defaultPreset: '', current: undefined })
        return
      }
      try {
        const catalog = presets.catalog()
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const session = sessionId === '' ? undefined : ctx.get('sessions')?.get(sessionId)
        json(200, {
          options: catalog?.options ?? [],
          defaultPreset: catalog?.defaultPreset ?? '',
          current: session === undefined ? undefined : presets.current(session),
        })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/permission') {
      let body
      try {
        body = await readJson(request)
      } catch {
        json(400, { error: 'bad request' })
        return
      }
      if (typeof body.sessionId !== 'string' || typeof body.name !== 'string' || body.name === '') {
        json(400, { error: 'sessionId and name are required' })
        return
      }
      const presets = ctx.get('permissionPresets')
      if (presets === undefined) {
        json(503, { error: 'permission presets are unavailable in this profile' })
        return
      }
      try {
        // Switching a preset needs the live Session object, so a cold Session is resumed first.
        const session = await liveSessionOf(ctx, body.sessionId)
        if (session === undefined) {
          json(409, { error: '会话尚未激活，先发一条消息再切换权限' })
          return
        }
        presets.set(session, body.name)
        json(200, { current: presets.current(session) })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/older') {
      // One backward page of history, so a long Session can be read past its opening window.
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const beforeSeq = Number(url.searchParams.get('beforeSeq'))
      if (sessionId === '' || !Number.isSafeInteger(beforeSeq) || beforeSeq <= 0) {
        json(400, { error: 'sessionId and a positive beforeSeq are required' })
        return
      }
      try {
        const page = await ctx.sessionController.page({
          address: { kind: 'session', sessionId },
          throughSeq: beforeSeq,
          beforeSeq,
          ...OLDER_WINDOW,
        })
        const records = Array.isArray(page?.records) ? page.records : []
        json(200, { records, hasMore: page?.hasMore === true && records.length > 0 })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/attachment') {
      // Image bytes for the transcript and the composer preview: the page cannot reach the
      // attachment store itself, so the Host reads the one attachment a Session log proves.
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const attachmentId = url.searchParams.get('attachmentId') ?? ''
      if (sessionId === '' || attachmentId === '') {
        json(400, { error: 'sessionId and attachmentId are required' })
        return
      }
      try {
        const value = await ctx.sessionController.attachment({ sessionId, attachmentId })
        json(200, {
          mediaType: value?.attachment?.mediaType ?? 'image/png',
          data: value?.data ?? '',
          name: value?.attachment?.name,
          width: value?.attachment?.width,
          height: value?.attachment?.height,
        })
      } catch (error) {
        json(404, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/attach') {
      let body
      try {
        body = await readJson(request, MAX_UPLOAD_BODY)
      } catch (error) {
        const tooLarge = String(error?.message) === 'body too large'
        if (tooLarge) json(413, { error: '图片太大（上限 16 MB），请压缩后再试' })
        else json(400, { error: 'bad request' })
        return
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        json(503, { error: 'attachments are unavailable in this profile' })
        return
      }
      const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/u.exec(String(body.dataUrl ?? ''))
      if (match === null || !IMAGE_TYPES.has(match[1])) {
        json(400, { error: 'unsupported image payload' })
        return
      }
      try {
        const bytes = Buffer.from(match[2], 'base64')
        const [ref] = await attachments.saveImages([{ data: bytes, mediaType: match[1], ...(typeof body.name === 'string' ? { name: body.name } : {}) }])
        json(200, { attachment: ref })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/stream') {
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      if (clients.size >= MAX_CLIENTS) {
        json(503, { error: 'too many clients' })
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const client = { response, closed: false, sessionAbort: undefined, sessionId: undefined }
      clients.add(client)
      request.on('close', () => {
        dropClient(client)
      })
      writeEvent(client, 'hello', { urls: candidateUrls(settings.bind, boundPort) })
      writeEvent(client, 'pending', pendingPayload())
      if (sessionId !== undefined && sessionId !== '') await pumpSession(client, sessionId)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/session') {
      let body
      try {
        body = await readJson(request)
      } catch {
        json(400, { error: 'bad request' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      if (sessionId === undefined || sessionId === '') {
        json(400, { error: 'sessionId required' })
        return
      }
      const client = [...clients].find((candidate) => candidate.response === response)
      if (client === undefined) {
        json(409, { error: 'open /api/stream first' })
        return
      }
      void pumpSession(client, sessionId)
      json(200, { ok: true, sessionId })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/send') {
      let body
      try {
        // Prompts carry image bytes inline, so this route shares the upload-sized cap.
        body = await readJson(request, MAX_UPLOAD_BODY)
      } catch (error) {
        const tooLarge = String(error?.message) === 'body too large'
        if (tooLarge) json(413, { error: '消息太大（图片上限 16 MB），请压缩后再试' })
        else json(400, { error: 'bad request' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const content = promptContentOf(body)
      if (sessionId === '' || content.length === 0) {
        json(400, { error: 'sessionId and some content are required' })
        return
      }
      try {
        const value = await ctx.sessionController.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: body.mode === 'steer' ? 'steer' : 'queue',
          content,
        }, new AbortController().signal)
        json(200, { ok: value?.accepted === true })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/cancel') {
      let body
      try {
        body = await readJson(request)
      } catch {
        json(400, { error: 'bad request' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') {
        json(400, { error: 'sessionId required' })
        return
      }
      try {
        ctx.sessionController.cancel({ sessionId })
        json(200, { ok: true })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/answer') {
      let body
      try {
        body = await readJson(request)
      } catch {
        json(400, { error: 'bad request' })
        return
      }
      const callId = typeof body.callId === 'string' ? body.callId : ''
      const answers = Array.isArray(body.answers) ? body.answers : []
      const record = questions.get(callId)
      if (record === undefined) {
        json(404, { error: 'no pending question for that call' })
        return
      }
      if (answers.length === 0) {
        json(400, { error: 'answers required' })
        return
      }
      try {
        const accepted = await answerQuestion(ctx, record, answers)
        if (accepted === true) questions.delete(callId)
        broadcast('pending', pendingPayload())
        json(200, { ok: accepted === true })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
      return
    }

    json(404, { error: 'not found' })
  }

  /**
   * Answer one pending question through the same Host call the desktop UI makes.
   * @param ctx - Host context.
   * @param record - the captured request.
   * @param answers - `AskUserQuestionAnswerItem[]` from the page.
   * @returns whether the Host accepted the answer.
   */
  async function answerQuestion (ctx, record, answers) {
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions === undefined) throw new Error('userQuestions service is unavailable')
    return userQuestions.answer(record.agent, record.callId, { answers })
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      try {
        sendJson(response, 500, { error: String(error?.message ?? error) })
      } catch {
        /* the response may already be gone */
      }
    })
  })
  /** The port actually bound, filled in once `listen` reports it. */
  let boundPort = settings.port

  ctx.effect(() => {
    server.on('error', (error) => {
      ctx.logger?.warn?.(`remote-control: listener failed: ${String(error?.message ?? error)}`)
    })
    server.listen(settings.port, settings.bind, () => {
      const address = server.address()
      boundPort = typeof address === 'object' && address !== null ? address.port : settings.port
      const urls = candidateUrls(settings.bind, boundPort)
      const hint = urls.map((url) => `${url}/?k=${secret.token}`).join('\n  ')
      ctx.logger?.info?.([
        `remote-control: listening on ${settings.bind}:${String(boundPort)}`,
        `  open once (the token becomes a cookie, then the URL is clean):\n  ${hint}`,
        secret.file === undefined
          ? '  token source: plugin config'
          : `  token file: ${secret.file}${secret.generated ? ' (newly generated)' : ''}`,
        settings.bind === '127.0.0.1'
          ? '  reachable from loopback only — use a tunnel/VPN from other devices'
          : '  WARNING: reachable from the network; put TLS or a tunnel in front of it',
      ].join('\n'))
    })
    return () => new Promise((resolve) => {
      for (const client of [...clients]) dropClient(client)
      server.close(() => {
        resolve()
      })
    })
  }, 'remote-control: listener')

  // Pending interactions are scoped to an Agent, so they are observed on each agent's own context.
  const agentDisposers = new Map()
  ctx.effect(() => {
    const onCreated = ({ agent }) => {
      const disposers = []
      disposers.push(agent.ctx.on('user-questions/request', (request, next) => {
        const callId = request?.wait?.callId
        if (callId !== undefined) {
          questions.set(String(callId), {
            callId: String(callId),
            sessionId: String(agent.id),
            questions: (request.questions ?? []).map((item) => ({
              id: String(item.id),
              question: String(item.question ?? ''),
              header: typeof item.header === 'string' ? item.header : undefined,
              detail: typeof item.detail === 'string' ? item.detail : undefined,
              multiSelect: item.multiSelect === true,
              options: Array.isArray(item.options)
                ? item.options.map((option) => ({ label: String(option.label ?? ''), description: option.description }))
                : [],
            })),
            at: Date.now(),
            agent,
          })
          broadcast('pending', pendingPayload())
        }
        return next()
      }))
      disposers.push(agent.ctx.on('approval/request', (request, next) => {
        const key = `${String(agent.id)}:${String(request?.callId ?? request?.toolName ?? 'approval')}`
        approvals.set(key, {
          key,
          sessionId: String(agent.id),
          toolName: String(request?.toolName ?? 'tool'),
          reason: typeof request?.reason === 'string' ? request.reason : undefined,
          at: Date.now(),
        })
        broadcast('pending', pendingPayload())
        // Observed only: the decision chain stays with the desktop answerer.
        return next()
      }))
      agentDisposers.set(agent, disposers)
    }
    const onDisposed = ({ agent }) => {
      for (const dispose of agentDisposers.get(agent) ?? []) {
        try {
          dispose()
        } catch {
          /* already released */
        }
      }
      agentDisposers.delete(agent)
      let changed = false
      for (const [callId, record] of [...questions]) {
        if (String(record.sessionId) === String(agent.id)) {
          questions.delete(callId)
          changed = true
        }
      }
      for (const [key, record] of [...approvals]) {
        if (String(record.sessionId) === String(agent.id)) {
          approvals.delete(key)
          changed = true
        }
      }
      if (changed) broadcast('pending', pendingPayload())
    }
    const offCreated = ctx.on('agent/created', onCreated)
    const offDisposed = ctx.on('agent/disposed', onDisposed)
    const offStatus = ctx.on('api-session/status', () => {
      void sessionsOf(ctx).then((sessions) => {
        broadcast('sessions', { sessions })
      }, () => {})
    })
    return () => {
      offCreated()
      offDisposed()
      offStatus()
      for (const disposers of agentDisposers.values()) {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* already released */
          }
        }
      }
      agentDisposers.clear()
      questions.clear()
      approvals.clear()
    }
  }, 'remote-control: pending interactions')
}
