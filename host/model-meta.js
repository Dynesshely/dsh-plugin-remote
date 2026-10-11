/**
 * Model metadata the catalogue does not carry.
 *
 * DSH's own model catalogue lists ids and names, and nothing about capacity — but the gateway's
 * `/v1/models` reports `context_length` for exactly the same ids, so the two are joined here. The gateway
 * answer is cached: it changes slowly, and the browser modal asks for it on every open.
 *
 * Kept separate from the usage module because it answers a different question, and hot-reloaded the same
 * way (see `hot.js`), so an edit here needs no DSH restart.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the gateway lives, and the credential DSH keeps for it. */
const GATEWAY_DEFAULT = 'https://portara.services.local/v1'
const GATEWAY_CREDENTIAL = 'PORTARA_AI_GATEWAY_API_KEY'
/** How long a gateway answer is reused. */
const TTL_MS = 10 * 60 * 1000

let cache = { at: 0, windows: {}, source: '' }

/** @returns the gateway key from the configuration, else from DSH's credential file. */
function gatewayKey () {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.dsh', 'remote-control', 'usage.json'), 'utf8'))
    const configured = config?.gateway?.key
    if (typeof configured === 'string' && configured !== '') return configured
  } catch {
    /* no configuration yet */
  }
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = new RegExp(`^\\s*${GATEWAY_CREDENTIAL}\\s*:\\s*(.+)$`, 'mu').exec(text)
    return match?.[1]?.trim().replace(/^["']|["']$/gu, '') ?? ''
  } catch {
    return ''
  }
}

/** @returns the gateway base URL, from the usage configuration when it is set. */
function gatewayBase () {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.dsh', 'remote-control', 'usage.json'), 'utf8'))
    const url = config?.gateway?.url
    if (typeof url === 'string' && url.includes('/v1/')) return url.slice(0, url.indexOf('/v1/') + 4)
  } catch {
    /* fall through */
  }
  return GATEWAY_DEFAULT
}

/** @returns `{ id: contextLength }` from the gateway, cached. */
async function contextWindows () {
  if (Date.now() - cache.at < TTL_MS && Object.keys(cache.windows).length > 0) return cache
  const key = gatewayKey()
  if (key === '') return { at: Date.now(), windows: {}, source: 'no-key' }
  try {
    const response = await fetch(`${gatewayBase()}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return { at: Date.now(), windows: {}, source: `HTTP ${String(response.status)}` }
    const json = await response.json()
    const windows = {}
    for (const entry of Array.isArray(json?.data) ? json.data : []) {
      const id = String(entry?.id ?? '')
      const length = Number(entry?.context_length ?? entry?.context_window ?? entry?.contextWindow)
      if (id !== '' && Number.isFinite(length) && length > 0) windows[id] = length
    }
    cache = { at: Date.now(), windows, source: 'gateway' }
    return cache
  } catch (error) {
    return { at: Date.now(), windows: {}, source: String(error?.message ?? error) }
  }
}

/**
 * Handle `GET /api/model-meta`.
 * @param api - the shell context.
 * @returns whether the request was handled.
 */
export async function handleModelMeta (api) {
  if (api.request.method !== 'GET' || api.url.pathname !== '/api/model-meta') return false
  const meta = await contextWindows()
  api.json(200, {
    ok: true,
    source: meta.source,
    // Keyed by model id, which is what the catalogue and the gateway agree on.
    contextWindows: meta.windows,
  })
  return true
}
