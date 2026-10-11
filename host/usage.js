/**
 * Balance and usage, aggregated for the sidebar card.
 *
 * Two sources, in order of preference:
 *
 * 1. **The gateway** — one URL that answers for every provider behind it. This is the right place for the
 *    integration: the gateway already holds the provider credentials and already knows the token usage of
 *    everything it proxies, so no vendor API has to be re-implemented per client.
 * 2. **Direct providers** — the per-vendor entries, kept for anyone pointing the page at vendors without a
 *    gateway in front of them.
 *
 * Items are returned **structured** rather than pre-formatted: balances stay numbers with their unit, and
 * rolling windows stay used/total pairs, so the card can draw tiles and progress bars instead of parsing
 * strings back apart.
 *
 * Configuration is stored beside the auth token, because it can hold API keys: written 0600, never
 * returned to the page — the page only learns whether a key is set, plus a masked hint. The gateway key is
 * normally *not* stored here at all: it is read from DSH's own credential file, where the provider
 * already keeps it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The aggregated endpoint the gateway offers. Editable in the settings sheet. */
const GATEWAY_DEFAULT = 'https://portara.services.local/v1/usage'
/** The credential DSH stores the gateway key under. */
const GATEWAY_CREDENTIAL = 'PORTARA_AI_GATEWAY_API_KEY'

/**
 * Direct providers the card knows out of the box.
 *
 * DeepSeek and Kimi publish a balance endpoint, so theirs are prefilled. MiniMax, CommandCode and
 * OpenCode are left blank: their endpoints could not be verified, and the generic parser shows whatever
 * numbers a response contains, so a pasted URL works without a bespoke implementation.
 */
const DEFAULTS = [
  { id: 'deepseek', label: 'DeepSeek', kind: 'deepseek', url: 'https://api.deepseek.com/user/balance', key: '', enabled: false },
  { id: 'kimi', label: 'Kimi', kind: 'kimi', url: 'https://api.moonshot.cn/v1/users/me/balance', key: '', enabled: false },
  { id: 'minimax', label: 'MiniMax', kind: 'generic', url: '', key: '', enabled: false },
  { id: 'commandcode', label: 'CommandCode', kind: 'generic', url: '', key: '', enabled: false },
  { id: 'opencode', label: 'OpenCode', kind: 'generic', url: '', key: '', enabled: false },
]

/** Window keys the gateway uses, in the words the card shows. */
const WINDOW_LABELS = { fiveHour: '5 小时', weekly: '本周', monthly: '本月', daily: '今日', hourly: '本小时' }

/** @returns the configuration file path. */
function configFile () {
  return join(homedir(), '.dsh', 'remote-control', 'usage.json')
}

/** @returns the DSH credential file path. */
function credentialFile () {
  return join(homedir(), '.dsh', '.credentials.yaml')
}

/** @returns the stored configuration, merged over the defaults so new entries appear after an upgrade. */
export function readConfig () {
  let stored = {}
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf8'))
    if (Array.isArray(parsed?.providers)) {
      stored = Object.fromEntries(parsed.providers.map((provider) => [String(provider?.id ?? ''), provider]))
    }
    if (parsed?.gateway !== null && typeof parsed?.gateway === 'object') stored.__gateway = parsed.gateway
  } catch {
    /* first run, or an unreadable file */
  }
  const gateway = stored.__gateway ?? {}
  return {
    gateway: {
      url: typeof gateway.url === 'string' && gateway.url !== '' ? gateway.url : GATEWAY_DEFAULT,
      key: typeof gateway.key === 'string' ? gateway.key : '',
      enabled: gateway.enabled !== false,
    },
    providers: DEFAULTS.map((fallback) => {
      const provider = stored[fallback.id] ?? {}
      return {
        ...fallback,
        label: typeof provider.label === 'string' && provider.label !== '' ? provider.label : fallback.label,
        url: typeof provider.url === 'string' ? provider.url : fallback.url,
        key: typeof provider.key === 'string' ? provider.key : fallback.key,
        enabled: provider.enabled === true,
      }
    }),
  }
}

/** @param config - the configuration to persist. */
function writeConfig (config) {
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ gateway: config.gateway, providers: config.providers }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * @returns the gateway key: the one configured here, else the one DSH already stores for its provider.
 *
 * Reading DSH's own credential file is what keeps this feature from asking the user to paste a key the
 * machine already has.
 */
function resolveGatewayKey (configured) {
  if (configured !== '') return { key: configured, source: 'config' }
  try {
    const text = readFileSync(credentialFile(), 'utf8')
    const pattern = new RegExp(`^\\s*${GATEWAY_CREDENTIAL}\\s*:\\s*(.+)$`, 'mu')
    const match = pattern.exec(text)
    const value = match?.[1]?.trim().replace(/^["']|["']$/gu, '') ?? ''
    if (value !== '') return { key: value, source: 'dsh' }
  } catch {
    /* no credential file, or nothing stored yet */
  }
  return { key: '', source: 'none' }
}

/** @returns a masked hint, enough to recognise a key without revealing it. */
function keyHint (key) {
  if (key === '') return ''
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

/** @returns a number when the value looks like one. */
function asNumber (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** @returns a compact number: 1234 → 1.2k, 6770116138 → 6.8G. */
function compact (value) {
  const number = asNumber(value)
  if (number === undefined) return String(value ?? '')
  if (Math.abs(number) >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}G`
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}k`
  return String(Math.round(number * 100) / 100)
}

/** @returns a date as `MM-DD`, when the value parses. */
function shortDate (value) {
  const time = Date.parse(String(value ?? ''))
  if (!Number.isFinite(time)) return undefined
  const date = new Date(time)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Map one gateway provider entry onto the card's shape.
 *
 * The gateway answers with a rich object — balances, rolling windows, the billing period, a plan, and the
 * upstream payloads it derived them from. Balances and windows are handed over as data (so the card can
 * draw tiles and bars); the rest becomes a few labelled lines, and the raw blobs are deliberately dropped.
 * @param entry - one element of the gateway's `providers` array.
 * @param index - its position, for a fallback id.
 * @returns the card item.
 */
function mapGatewayProvider (entry, index) {
  const label = String(entry?.channelName ?? entry?.label ?? entry?.adapter ?? `来源 ${String(index + 1)}`)
  const id = String(entry?.channelId ?? entry?.adapter ?? `gateway-${String(index)}`)
  const warnings = Array.isArray(entry?.warnings) ? entry.warnings.map(String) : []
  const ok = entry?.ok !== false
  if (!ok) {
    const reason = warnings[0]
      ?? (typeof entry?.error === 'string' ? entry.error : undefined)
      ?? (typeof entry?.message === 'string' ? entry.message : undefined)
      ?? (typeof entry?.reason === 'string' ? entry.reason : undefined)
    return { id, label, ok: false, error: reason ?? '网关报告该来源暂不可用', balances: [], windows: [], lines: [] }
  }

  const balances = []
  for (const balance of Array.isArray(entry?.balances) ? entry.balances : []) {
    const remaining = asNumber(balance?.remaining)
    if (remaining === undefined) continue
    balances.push({ unit: String(balance?.unit ?? balance?.currency ?? ''), remaining })
  }

  /**
   * @returns an ISO moment, from a number (seconds or milliseconds) or a date string.
   *
   * The gateway reports plan renewal as a formatted date and window resets as epoch numbers, so both have
   * to be understood — a numeric-only reading silently dropped the renewal time, which is exactly the
   * moment the progress bars are supposed to show.
   */
  const resetMoment = (value) => {
    const raw = asNumber(value)
    if (raw !== undefined) {
      if (raw <= 0) return undefined
      return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString()
    }
    const parsed = Date.parse(String(value ?? ''))
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
  }

  const windows = []
  for (const window of Array.isArray(entry?.windows) ? entry.windows : []) {
    const used = asNumber(window?.used) ?? 0
    const total = asNumber(window?.total)
    if (total === undefined) continue
    const ratio = total <= 0 ? 0 : Math.min(1, Math.max(0, used / total))
    windows.push({
      key: String(window?.key ?? ''),
      label: WINDOW_LABELS[String(window?.key ?? '')] ?? String(window?.key ?? '窗口'),
      used,
      total,
      ratio,
      exceeded: window?.exceeded === true,
      // Printed on the bar itself, so a reset moment never becomes another text row.
      resetAt: resetMoment(window?.resetAt),
    })
  }

  const lines = []
  const plan = entry?.plan
  let planReset
  if (plan !== undefined && plan !== null) {
    const renew = shortDate(plan.renewAt)
    // The renewal moment is the reset the windows roll against; the period end is the fallback.
    planReset = resetMoment(plan.renewAt) ?? resetMoment(period?.end)
    lines.push({
      label: '套餐',
      value: `${String(plan.id ?? plan.status ?? '')}${renew === undefined ? '' : ` · ${renew} 续期`}`.trim(),
    })
  }
  const period = entry?.period
  if (period !== undefined && period !== null) {
    const requests = asNumber(period.requests)
    const rate = asNumber(period.successRate)
    if (requests !== undefined) {
      lines.push({ label: '本周期', value: `${compact(requests)} 请求${rate === undefined ? '' : ` · ${rate.toFixed(1)}% 成功`}` })
    }
    const tokensIn = asNumber(period.tokensIn)
    const tokensOut = asNumber(period.tokensOut)
    const cost = asNumber(period.cost)
    if (tokensIn !== undefined || tokensOut !== undefined) {
      const money = cost === undefined ? '' : ` · ${compact(cost)} ${String(period.costCurrency ?? '')}`.trimEnd()
      lines.push({ label: 'tokens', value: `↑${compact(tokensIn)} ↓${compact(tokensOut)}${money}` })
    }
  }
  if (warnings.length > 0) lines.push({ label: '提示', value: warnings[0] })

  if (balances.length === 0 && windows.length === 0 && lines.length === 0) {
    return { id, label, ok: false, error: '该来源没有返回可显示的余额', balances: [], windows: [], lines: [] }
  }
  return {
    id,
    label,
    ok: true,
    balances,
    windows,
    lines,
    // Facts the card draws as icons and captions rather than as extra text rows.
    cached: entry?.cached === true,
    resetAt: planReset,
  }
}

/** @returns balances, windows and lines for DeepSeek's own response shape. */
function parseDeepseek (json) {
  const lines = []
  const balances = []
  for (const info of Array.isArray(json?.balance_infos) ? json.balance_infos : []) {
    const unit = String(info?.currency ?? '')
    const total = asNumber(info?.total_balance)
    if (total !== undefined) balances.push({ unit, remaining: total })
    const granted = asNumber(info?.granted_balance)
    const topped = asNumber(info?.topped_up_balance)
    if (granted !== undefined) lines.push({ label: '赠金', value: String(granted) })
    if (topped !== undefined) lines.push({ label: '充值', value: String(topped) })
  }
  if (json?.is_available === false) lines.unshift({ label: '状态', value: '不可用' })
  return { balances, windows: [], lines }
}

/** @returns balances, windows and lines for Kimi's own response shape. */
function parseKimi (json) {
  const data = json?.data ?? {}
  const balances = []
  const lines = []
  const available = asNumber(data?.available_balance)
  if (available !== undefined) balances.push({ unit: '', remaining: available })
  for (const [label, raw] of [['代金券', data?.voucher_balance], ['现金', data?.cash_balance]]) {
    const value = asNumber(raw)
    if (value !== undefined) lines.push({ label, value: String(value) })
  }
  return { balances, windows: [], lines }
}

/**
 * @param json - any JSON response.
 * @returns balances, windows and lines scraped from whatever shape it has.
 *
 * The fallback for anything unrecognised: it does not need the schema, only the numbers worth showing.
 */
function parseGeneric (json) {
  const lines = []
  const balances = []
  const interesting = /balance|credit|quota|remain|amount|usage|used|limit|total|left|available/i
  const walk = (node, prefix, depth) => {
    if (lines.length >= 6 || depth > 4 || node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (lines.length >= 6) return
      const label = prefix === '' ? key : `${prefix}.${key}`
      if (value !== null && typeof value === 'object') {
        walk(value, label, depth + 1)
        continue
      }
      if (!interesting.test(key)) continue
      const number = asNumber(value)
      if (number !== undefined) lines.push({ label, value: String(number) })
      else if (typeof value === 'string' && value.length <= 40) lines.push({ label, value })
    }
  }
  walk(json, '', 0)
  // A generic source has no headline of its own, so the first scraped number becomes the tile.
  if (lines.length > 0) {
    const number = asNumber(lines[0].value)
    if (number !== undefined) {
      balances.push({ unit: '', remaining: number })
      lines.shift()
    }
  }
  return { balances, windows: [], lines }
}

/**
 * Read the gateway's aggregated answer.
 * @param gateway - the configured gateway.
 * @param key - the resolved key.
 * @returns `{ ok, items, error }`.
 */
async function fetchGateway (gateway, key) {
  if (gateway.url === '') return { ok: false, items: [], error: '未填写网关用量地址' }
  if (key === '') return { ok: false, items: [], error: `没有可用的网关密钥（${GATEWAY_CREDENTIAL}）` }
  try {
    const response = await fetch(gateway.url, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.text()
    if (!response.ok) {
      return { ok: false, items: [], error: `HTTP ${String(response.status)}${body === '' ? '' : `: ${body.slice(0, 160)}`}` }
    }
    let json
    try {
      json = JSON.parse(body)
    } catch {
      return { ok: false, items: [], error: '响应不是 JSON' }
    }
    const raw = Array.isArray(json?.providers) ? json.providers
      : Array.isArray(json?.items) ? json.items
        : Array.isArray(json?.data?.items) ? json.data.items
          : Array.isArray(json?.data) ? json.data
            : undefined
    if (raw === undefined) {
      const scraped = parseGeneric(json)
      if (scraped.balances.length === 0 && scraped.lines.length === 0) {
        return { ok: false, items: [], error: '响应里没有可显示的数值' }
      }
      return { ok: true, items: [{ id: 'gateway', label: '网关', ok: true, ...scraped }] }
    }
    return { ok: true, items: raw.map(mapGatewayProvider), error: undefined }
  } catch (error) {
    return { ok: false, items: [], error: String(error?.message ?? error) }
  }
}

/**
 * Ask one direct provider for its balance.
 * @param provider - a configured entry.
 * @returns `{ ok, balances, windows, lines, error }`.
 */
async function fetchUsage (provider) {
  const empty = { balances: [], windows: [], lines: [] }
  if (provider.url === '') return { ok: false, error: '未填写接口地址', ...empty }
  if (provider.key === '') return { ok: false, error: '未填写 API Key', ...empty }
  try {
    const response = await fetch(provider.url, {
      headers: { authorization: `Bearer ${provider.key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    const body = await response.text()
    if (!response.ok) {
      return { ok: false, error: `HTTP ${String(response.status)}${body === '' ? '' : `: ${body.slice(0, 120)}`}`, ...empty }
    }
    let json
    try {
      json = JSON.parse(body)
    } catch {
      return { ok: false, error: '响应不是 JSON', ...empty }
    }
    const parsed = provider.kind === 'deepseek'
      ? parseDeepseek(json)
      : provider.kind === 'kimi' ? parseKimi(json) : parseGeneric(json)
    if (parsed.balances.length === 0 && parsed.windows.length === 0 && parsed.lines.length === 0) {
      return { ok: false, error: '响应里没有可显示的数值', ...empty }
    }
    return { ok: true, ...parsed }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), ...empty }
  }
}

/** @returns the card's data, from the gateway when it is enabled, otherwise from the direct providers. */
async function usage (api) {
  const config = readConfig()
  if (config.gateway.enabled) {
    const resolved = resolveGatewayKey(config.gateway.key)
    const result = await fetchGateway(config.gateway, resolved.key)
    api.json(200, {
      ok: true,
      source: 'gateway',
      url: config.gateway.url,
      keySource: resolved.source,
      items: result.items,
      error: result.ok ? undefined : result.error,
    })
    return true
  }
  const enabled = config.providers.filter((provider) => provider.enabled)
  const items = await Promise.all(enabled.map(async (provider) => ({
    id: provider.id,
    label: provider.label,
    ...(await fetchUsage(provider)),
  })))
  api.json(200, { ok: true, source: 'direct', items, enabled: enabled.length, known: config.providers.length })
  return true
}

/** @returns the configuration, with every key reduced to a hint. */
function usageConfig (api) {
  const config = readConfig()
  const resolved = resolveGatewayKey(config.gateway.key)
  api.json(200, {
    ok: true,
    file: configFile(),
    credentialFile: credentialFile(),
    gateway: {
      url: config.gateway.url,
      enabled: config.gateway.enabled,
      hasKey: config.gateway.key !== '',
      hint: keyHint(config.gateway.key),
      // Where the key would come from right now, so the sheet can say so instead of demanding one.
      resolvedFrom: resolved.source,
      resolvedHint: keyHint(resolved.key),
    },
    providers: config.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      url: provider.url,
      enabled: provider.enabled,
      hasKey: provider.key !== '',
      hint: keyHint(provider.key),
    })),
  })
  return true
}

/** Save the configuration. An omitted `key` keeps the stored one; an empty string clears it. */
async function saveUsageConfig (api) {
  let body
  try {
    body = await api.readJson(api.request)
  } catch {
    api.json(400, { error: 'bad request' })
    return true
  }
  const config = readConfig()
  if (body?.gateway !== null && typeof body?.gateway === 'object') {
    const incoming = body.gateway
    if (typeof incoming.url === 'string') config.gateway.url = incoming.url.trim()
    if (typeof incoming.key === 'string') config.gateway.key = incoming.key.trim()
    if (typeof incoming.enabled === 'boolean') config.gateway.enabled = incoming.enabled
  }
  if (Array.isArray(body?.providers)) {
    const current = Object.fromEntries(config.providers.map((provider) => [provider.id, provider]))
    const next = []
    for (const incoming of body.providers) {
      const id = String(incoming?.id ?? '')
      const base = current[id]
      if (base === undefined) continue
      next.push({
        id,
        label: typeof incoming.label === 'string' && incoming.label.trim() !== '' ? incoming.label.trim() : base.label,
        kind: base.kind,
        url: typeof incoming.url === 'string' ? incoming.url.trim() : base.url,
        key: typeof incoming.key === 'string' ? incoming.key.trim() : base.key,
        enabled: incoming.enabled === true,
      })
    }
    for (const [id, provider] of Object.entries(current)) {
      if (!next.some((entry) => entry.id === id)) next.push(provider)
    }
    config.providers = next
  }
  try {
    writeConfig(config)
    api.json(200, { ok: true })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/**
 * Handle the usage routes.
 * @param api - the shell context.
 * @returns whether the request was handled.
 */
export async function handleUsage (api) {
  const { method } = api.request
  if (method === 'GET' && api.url.pathname === '/api/usage') return await usage(api)
  if (method === 'GET' && api.url.pathname === '/api/usage/config') return usageConfig(api)
  if (method === 'POST' && api.url.pathname === '/api/usage/config') return await saveUsageConfig(api)
  return false
}
