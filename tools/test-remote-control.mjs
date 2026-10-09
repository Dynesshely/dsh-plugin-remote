// Integration test for the Remote Control plugin.
// Boots the real plugin against a fake Host context, then drives it over real HTTP on loopback:
// authentication, the SPA bundle, the Session catalog with workspace grouping, prompt submission
// (text and images), model/permission switching, question answering, and the SSE feed.
//
// This is not a device test: the phone/browser step stays with the user.
// Run (from the plugin directory): node tools/test-remote-control.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const TOKEN = 'test-token-0123456789abcdef'
// Keep the token file out of the real Harness home.
const HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-control-test-'))
process.env.DSH_HOME = HOME

/** A 1×1 transparent PNG. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** @returns a Host-like context plus the knobs this test drives. */
function createHost () {
  const handlers = new Map()
  const effects = []
  const logs = []
  const calls = { list: 0, prompt: [], cancel: [], follow: [], page: [], answer: [], saveImages: [], selectModel: [], setPreset: [], attachments: [] }
  const sessionObject = { id: 's1', requestHeader: () => ({ config: { provider: 'pi', model: 'test-model' } }) }

  /**
   * Agents that are already live when the plugin is applied.
   *
   * This mirrors the desktop: it reopens the Session the user is looking at during startup, so that
   * Session's agent exists before the profile's bundles finish applying and `agent/created` never
   * fires for it again.
   */
  const agentScopes = new Map()
  const liveAgents = []
  /** @returns an agent handle with a per-agent event scope, like a real AgentContext. */
  function makeAgent (id) {
    const scoped = new Map()
    agentScopes.set(id, scoped)
    const agent = {
      id,
      ctx: {
        on: (name, fn) => {
          const set = scoped.get(name) ?? new Set()
          set.add(fn)
          scoped.set(name, set)
          return () => set.delete(fn)
        },
      },
    }
    liveAgents.push(agent)
    return agent
  }
  /** Question call ids the fake Host service considers already continued (answerable in place). */
  const continuedQuestions = new Set()
  makeAgent('s1')

  // Stands in for the desktop answerer: registered before the plugin (so a listener that does not
  // prepend ends up behind it) and returning the user's answer WITHOUT calling `next()`, which vetoes
  // the rest of the waterfall — exactly the live behaviour that hid every question from this plugin.
  const DESKTOP_ANSWER = 'desktop-answer'
  handlers.set('user-questions/request', [() => Promise.resolve(DESKTOP_ANSWER)])
  handlers.set('approval/request', [() => Promise.resolve('allowed-once')])

  const sessions = [
    { sessionId: 's1', running: true, blank: false, updatedAt: 3, cwd: 'C:\\work\\alpha', projections: { values: { title: 'Alpha session' } } },
    { sessionId: 's2', running: false, blank: false, updatedAt: 2, cwd: '/home/u/beta' },
    { sessionId: 'sub1', running: false, blank: false, updatedAt: 1, origin: 'subagent', parentSessionId: 's1' },
  ]

  const permissionPresets = {
    catalog: () => ({ options: [{ value: 'read-only', name: '只读' }, { value: 'workspace-write', name: '可写' }], defaultPreset: 'workspace-write' }),
    current: () => 'workspace-write',
    set: (session, name) => { calls.setPreset.push({ sessionId: session.id, name }) },
  }

  async function * follow (request, signal) {
    calls.follow.push(request)
    yield {
      type: 'snapshot',
      header: { version: 1, id: request.address.sessionId, createdAt: 0, isSeeded: false },
      cursor: 2,
      records: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text: 'hello from the log' }] } } }],
      hasMore: false,
      projections: { asOfSeq: 2, values: {} },
      assistantStream: { revision: 1 },
    }
    yield { type: 'event', event: { type: 'assistant/message', seq: 2, time: 1, data: { message: { content: [{ type: 'text', text: 'reply from the log' }] } } } }
    await new Promise((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', resolve, { once: true })
    })
  }

  const ctx = {
    logger: { info: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) },
    effect: (fn) => { const off = fn(); effects.push(off) },
    on: (name, fn, options) => {
      const list = handlers.get(name) ?? []
      handlers.set(name, list)
      // Cordis semantics: `prepend` unshifts, so the listener runs outermost-first.
      if (options === true || options?.prepend === true) list.unshift(fn)
      else list.push(fn)
      return () => {
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    get: (key) => {
      if (key === 'agents') return { list: () => liveAgents, get: (id) => liveAgents.find((agent) => agent.id === id) }
      if (key === 'userQuestions') {
        return {
          // The real service only accepts a question that already timed out into `continued(agent)`;
          // everything else must go through the waterfall race.
          answer: (agent, callId, answer) => {
            calls.answer.push({ agentId: agent.id, callId, answer })
            return continuedQuestions.has(String(callId))
          },
        }
      }
      if (key === 'workspaceRegistry') {
        return { list: async () => [{ id: 'w1', title: 'Work', path: 'C:\\work', sessionIds: ['s1'] }] }
      }
      if (key === 'attachments') {
        return {
          saveImages: async (inputs) => {
            calls.saveImages.push(inputs)
            return inputs.map((input, index) => ({
              attachmentId: `att-${String(index)}`,
              mediaType: input.mediaType,
              bytes: input.data.length,
              width: 1,
              height: 1,
            }))
          },
        }
      }
      if (key === 'permissionPresets') return permissionPresets
      if (key === 'sessions') return { get: (id) => (id === 's1' ? sessionObject : undefined) }
      return undefined
    },
    sessionController: {
      list: async () => { calls.list += 1; return { items: sessions } },
      follow,
      prompt: async (request) => { calls.prompt.push(request); return { accepted: true } },
      cancel: (request) => { calls.cancel.push(request); return { accepted: true } },
      modelCatalog: async () => ({
        default: { provider: 'pi', model: 'test-model' },
        groups: [{ id: 'pi', name: 'Pi', models: [{ id: 'test-model', name: 'Test Model' }] }],
        failures: [],
      }),
      selectModel: async (request) => { calls.selectModel.push(request); return { selected: { provider: request.provider, model: request.model } } },
      resolveAgent: async () => ({ agent: { id: 's1' } }),
      page: async (request) => {
        calls.page.push(request)
        return {
          records: [{ type: 'event', event: { type: 'user/message', seq: 118, time: 0, data: { content: [{ type: 'text', text: 'older prompt' }] } } }],
          hasMore: true,
        }
      },
      attachment: async (request) => {
        calls.attachments.push(request)
        if (request.attachmentId === 'missing') throw new Error('attachment not reachable')
        return {
          attachment: { attachmentId: request.attachmentId, mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
          data: PIXEL.slice(PIXEL.indexOf(',') + 1),
        }
      },
    },
  }

  return {
    ctx,
    logs,
    calls,
    effects,
    liveAgents,
    agentScopes,
    makeAgent,
    DESKTOP_ANSWER,
    /** Mark a question as already continued, so the Host service accepts a remote answer for it. */
    markContinued: (callId) => continuedQuestions.add(String(callId)),
    /** Swap the simulated desktop answerer (the last-registered listener of a waterfall). */
    replaceBridge: (name, fn) => {
      const list = handlers.get(name) ?? []
      if (list.length === 0) list.push(fn)
      else list[list.length - 1] = fn
      handlers.set(name, list)
    },
    /** Emit one root-scope event to the plugin's listeners. */
    emit: (name, ...payload) => {
      for (const fn of handlers.get(name) ?? []) fn(...payload)
    },
    /** Run one waterfall exactly like Cordis: outermost-first, and a listener that skips `next()` wins. */
    emitWaterfall: (name, payload) => {
      const list = [...(handlers.get(name) ?? [])]
      const next = () => {
        const fn = list.shift()
        if (fn === undefined) return Promise.resolve(undefined)
        return Promise.resolve(fn(payload, next))
      }
      return next()
    },
    /** @returns the plugin's listener on the root scope — first, because the plugin prepends. */
    rootListener: (name) => (handlers.get(name) ?? [])[0],
    /** @returns the plugin's listener registered on one live agent's scope. */
    agentListener: (agentId, name) => [...(agentScopes.get(agentId)?.get(name) ?? [])][0],
  }
}

/** Wait until the startup log reports the bound port. */
async function boot (host) {
  apply(host.ctx, { bind: '127.0.0.1', port: 0, token: TOKEN })
  for (let i = 0; i < 100; i += 1) {
    const line = host.logs.find((entry) => entry.includes('listening on 127.0.0.1:'))
    if (line !== undefined) {
      const port = Number(/listening on 127\.0\.0\.1:(\d+)/u.exec(line)[1])
      return `http://127.0.0.1:${String(port)}`
    }
    await sleep(20)
  }
  throw new Error('the listener never reported a port')
}

let failures = 0
async function check (name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

console.log('Remote Control integration')

const host = createHost()
const base = await boot(host)
const cookie = { cookie: `dsh_rc=${TOKEN}` }
const distIndex = new URL('../ui/dist/index.html', import.meta.url)
const hasDist = existsSync(distIndex)

await check('serves the shell with a strict CSP and no auth', async () => {
  const response = await fetch(`${base}/`)
  assert.equal(response.status, 200)
  const csp = response.headers.get('content-security-policy') ?? ''
  assert.match(csp, /default-src 'none'/u)
  assert.match(csp, /frame-ancestors 'none'/u)
  const html = await response.text()
  if (hasDist) assert.match(html, /<div id="app"/u)
  else assert.match(html, /DSH 遥控/u)
})

await check('serves built SPA assets with the right content type', async () => {
  if (!hasDist) {
    console.log('       (skipped: ui/dist is not built)')
    return
  }
  const index = await (await fetch(`${base}/`)).text()
  const match = /\.\/assets\/([^"']+\.js)/u.exec(index)
  assert.ok(match !== null, 'the shell references a bundled script')
  const asset = await fetch(`${base}/assets/${match[1]}`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type') ?? '', /javascript/u)
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/u)
})

await check('a deep link falls back to the SPA shell', async () => {
  const response = await fetch(`${base}/some/deep/link`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/u)
})

await check('healthz reports ok without auth', async () => {
  const response = await fetch(`${base}/healthz`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
})

await check('the API refuses unauthenticated access', async () => {
  const response = await fetch(`${base}/api/state`)
  assert.equal(response.status, 401)
})

await check('a wrong token is refused and the right one becomes a cookie', async () => {
  const bad = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token-wrong-token' }),
  })
  assert.equal(bad.status, 401)
  const good = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  })
  assert.equal(good.status, 200)
  const setCookie = good.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /dsh_rc=/u)
  assert.match(setCookie, /HttpOnly/u)
  assert.match(setCookie, /SameSite=Strict/u)
})

await check('state maps the Session catalog and groups it by workspace', async () => {
  const response = await fetch(`${base}/api/state`, { headers: cookie })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.deepEqual(payload.workspaces, [{ id: 'w1', title: 'Work', path: 'C:\\work', sessionIds: ['s1'] }])
  assert.deepEqual(payload.sessions, [
    { id: 's1', title: 'Alpha session', running: true, blank: false, origin: 'main', updatedAt: 3, workspaceId: 'w1' },
    { id: 's2', title: 'beta', running: false, blank: false, origin: 'main', updatedAt: 2 },
    { id: 'sub1', running: false, blank: false, parentId: 's1', origin: 'subagent', updatedAt: 1 },
  ])
  assert.equal(payload.bind, '127.0.0.1')
})

await check('models and the current selection are exposed', async () => {
  const models = await (await fetch(`${base}/api/models`, { headers: cookie })).json()
  assert.equal(models.groups[0].models[0].name, 'Test Model')
  const selection = await (await fetch(`${base}/api/selection?sessionId=s1`, { headers: cookie })).json()
  assert.deepEqual(selection.selected, { provider: 'pi', model: 'test-model' })
  const empty = await (await fetch(`${base}/api/selection?sessionId=cold`, { headers: cookie })).json()
  assert.equal(empty.selected, null)
})

await check('switching the model reaches the controller', async () => {
  const response = await fetch(`${base}/api/select-model`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', provider: 'pi', model: 'other' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(host.calls.selectModel, [{ sessionId: 's1', provider: 'pi', model: 'other' }])
})

await check('permission presets are listed and switchable', async () => {
  const catalog = await (await fetch(`${base}/api/permissions?sessionId=s1`, { headers: cookie })).json()
  assert.equal(catalog.options.length, 2)
  assert.equal(catalog.current, 'workspace-write')
  const response = await fetch(`${base}/api/permission`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', name: 'read-only' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(host.calls.setPreset, [{ sessionId: 's1', name: 'read-only' }])
})

await check('an image is staged into the attachment store', async () => {
  const response = await fetch(`${base}/api/attach`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: PIXEL, name: 'pixel.png' }),
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.attachment.attachmentId, 'att-0')
  assert.equal(payload.attachment.mediaType, 'image/png')
  assert.equal(host.calls.saveImages.length, 1)
  assert.equal(host.calls.saveImages[0][0].data.length > 0, true)
})

await check('an attachment is read back for the transcript preview', async () => {
  const response = await fetch(`${base}/api/attachment?sessionId=s1&attachmentId=att-0`, { headers: cookie })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.mediaType, 'image/png')
  assert.equal(payload.data.length > 0, true)
  assert.deepEqual(host.calls.attachments, [{ sessionId: 's1', attachmentId: 'att-0' }])

  const missing = await fetch(`${base}/api/attachment?sessionId=s1&attachmentId=missing`, { headers: cookie })
  assert.equal(missing.status, 404)

  const incomplete = await fetch(`${base}/api/attachment?sessionId=s1`, { headers: cookie })
  assert.equal(incomplete.status, 400)
})

await check('a rejected attachment payload never reaches the store', async () => {
  const response = await fetch(`${base}/api/attach`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: 'data:text/plain;base64,aGk=' }),
  })
  assert.equal(response.status, 400)
  assert.equal(host.calls.saveImages.length, 1)
})

await check('a screenshot-sized attachment payload is accepted', async () => {
  // A pasted screenshot is a few hundred kilobytes of base64 — far past the general 64 KiB cap,
  // which used to fail the JSON parse and surface as "bad request".
  const base64 = PIXEL.slice(PIXEL.indexOf(',') + 1)
  // A valid, padding-free base64 body of the size a pasted screenshot produces (~300 KB decoded).
  const payload = `data:image/png;base64,${'A'.repeat(400_000)}`
  const response = await fetch(`${base}/api/attach`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: payload, name: 'screenshot.png' }),
  })
  assert.equal(response.status, 200, await response.text())
  const saved = host.calls.saveImages.at(-1)[0]
  assert.ok(saved.data.length > 250_000, `the bytes reached the attachment store (${saved.data.length} bytes)`)
})

await check('a route outside the upload paths keeps the small body cap', async () => {
  const response = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'x', answers: [{ id: 'x'.repeat(100_000) }] }),
  })
  assert.equal(response.status, 400, 'an oversized body is still refused')
})

await check('send forwards an inline image exactly like the Desktop composer', async () => {
  const response = await fetch(`${base}/api/send`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
        { type: 'text', text: '  remote hello  ' },
        { type: 'image', mediaType: 'application/pdf', data: 'AAAA' },
        { type: 'nonsense', value: 1 },
      ],
    }),
  })
  assert.equal(response.status, 200)
  const request = host.calls.prompt.at(-1)
  assert.equal(request.sessionId, 's1')
  assert.equal(request.mode, 'queue')
  assert.deepEqual(request.content, [
    { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
    { type: 'text', text: 'remote hello' },
  ])
  assert.equal(typeof request.requestId, 'string')
})

await check('a prompt carrying a screenshot-sized image is accepted', async () => {
  const response = await fetch(`${base}/api/send`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'A'.repeat(400_000) },
        { type: 'text', text: 'look at this' },
      ],
    }),
  })
  assert.equal(response.status, 200, await response.text())
  const request = host.calls.prompt.at(-1)
  assert.equal(request.content[0].data.length, 400_000)
  assert.equal(request.content[1].text, 'look at this')
})

await check('an attachment-style image part still passes through', async () => {
  const response = await fetch(`${base}/api/send`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      content: [{ type: 'image', attachment: { attachmentId: 'att-0', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } }],
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(host.calls.prompt.at(-1).content, [
    { type: 'image', attachment: { attachmentId: 'att-0', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } },
  ])
})

await check('the legacy text body still works', async () => {
  const response = await fetch(`${base}/api/send`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', text: 'plain body' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(host.calls.prompt.at(-1).content, [{ type: 'text', text: 'plain body' }])
})

await check('send rejects an empty message', async () => {
  const before = host.calls.prompt.length
  const response = await fetch(`${base}/api/send`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', content: [{ type: 'text', text: '   ' }] }),
  })
  assert.equal(response.status, 400)
  assert.equal(host.calls.prompt.length, before, 'no extra prompt was admitted')
})

await check('cancel asks the controller to stop the turn', async () => {
  const response = await fetch(`${base}/api/cancel`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(host.calls.cancel, [{ sessionId: 's1' }])
})

await check('the SSE feed forwards the opening snapshot and later frames', async () => {
  const controller = new AbortController()
  const response = await fetch(`${base}/api/stream?sessionId=s1`, { headers: cookie, signal: controller.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done === true) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.includes('reply from the log')) break
  }
  controller.abort()
  assert.match(buffer, /event: hello/u)
  assert.match(buffer, /event: pending/u)
  assert.match(buffer, /event: frame/u)
  assert.match(buffer, /hello from the log/u)
  assert.match(buffer, /reply from the log/u)
  assert.equal(host.calls.follow[0].address.sessionId, 's1')
  assert.equal(host.calls.follow[0].assistantStream, true)
  // A long Session must open with real depth, not the last couple of turns.
  assert.equal(host.calls.follow[0].maxMessages, 500)
  assert.equal(host.calls.follow[0].turnWindow.minTurns, 20)
})

await check('older history pages backwards from the loaded window', async () => {
  const response = await fetch(`${base}/api/older?sessionId=s1&beforeSeq=120`, { headers: cookie })
  const body = await response.text()
  assert.equal(response.status, 200, body)
  const payload = JSON.parse(body)
  assert.equal(payload.records.length, 1)
  assert.equal(payload.records[0].event.seq, 118)
  assert.equal(payload.hasMore, true)
  const request = host.calls.page.at(-1)
  assert.deepEqual(request.address, { kind: 'session', sessionId: 's1' })
  assert.equal(request.beforeSeq, 120)
  assert.equal(request.throughSeq, 120)
  assert.equal(request.maxMessages, 200)

  const bad = await fetch(`${base}/api/older?sessionId=s1`, { headers: cookie })
  assert.equal(bad.status, 400)
})

await check('a question tool call is captured from the session log feed', async () => {
  // The primary path, and the one that cannot be vetoed: a durable `tool/call` event is enough.
  host.emit('session/event', { id: 's1' }, {
    type: 'tool/call',
    seq: 42,
    data: {
      callId: 'call-8',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'pick', header: '选一个', question: '哪个？', options: [{ label: 'A（Recommended）' }, { label: 'B' }] }] }),
    },
  })
  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  const record = state.pending.questions.find((question) => question.callId === 'call-8')
  assert.notEqual(record, undefined, 'captured from the log without any waterfall')
  assert.equal(record.sessionId, 's1')
  assert.equal(record.answerable, true, 'the live agent routes the answer')
  assert.equal(record.questions[0].multiSelect, false)
  assert.equal(record.questions[0].options.length, 2)

  // A question captured only from the log has no live waterfall, so answering it goes through the
  // Host service — which accepts it once it has continued (timed mode).
  host.markContinued('call-8')
  const answered = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-8', answers: [{ id: 'pick', selected: ['A（Recommended）'] }] }),
  })
  assert.equal(answered.status, 200, await answered.clone().text())
  assert.equal(host.calls.answer.at(-1).agentId, 's1')
  assert.equal((await (await fetch(`${base}/api/diagnose`, { headers: cookie })).json()).capture.sessionCalls >= 1, true)

  // A question answered elsewhere (or timed out) leaves the pending list when its result lands.
  host.emit('session/event', { id: 's1' }, {
    type: 'tool/call',
    seq: 44,
    data: { callId: 'call-7', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'x', question: 'q', options: [] }] }) },
  })
  let after = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  assert.equal(after.pending.questions.some((question) => question.callId === 'call-7'), true)
  host.emit('session/event', { id: 's1' }, { type: 'tool/result', seq: 45, data: { message: { toolCallId: 'call-7', content: [] } } })
  after = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  assert.equal(after.pending.questions.some((question) => question.callId === 'call-7'), false, 'a settled tool call leaves the pending list')

  const diagnose = await (await fetch(`${base}/api/diagnose`, { headers: cookie })).json()
  assert.equal(diagnose.capture.sessionCalls, 2)
})

await check('a question is captured even though the desktop answerer vetoes the rest', async () => {
  // Regression for the live failure: the desktop answerer is registered first and returns without
  // calling `next()`, so a listener that is merely appended never runs. The plugin must prepend.
  const outcome = await host.emitWaterfall('user-questions/request', {
    agent: host.liveAgents[0],
    questions: [{ id: 'q3', question: 'Chain order?', options: [{ label: 'A' }, { label: 'B' }] }],
    wait: { callId: 'call-3', timed: true },
  })
  assert.equal(outcome, host.DESKTOP_ANSWER, 'the desktop answerer still owns the decision')

  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  const record = state.pending.questions.find((question) => question.callId === 'call-3')
  assert.equal(record !== undefined, true, 'the question was captured before the veto')
  assert.equal(record.sessionId, 's1')

  const diagnose = await (await fetch(`${base}/api/diagnose`, { headers: cookie })).json()
  assert.equal(diagnose.questions.some((question) => question.callId === 'call-3'), true)

  // The desktop answered, so it won the race: a later remote answer is refused instead of pretending
  // to be accepted.
  const late = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-3', answers: [{ id: 'q3', selected: ['B'] }] }),
  })
  assert.equal(late.status, 200)
  assert.equal((await late.json()).ok, false, 'the settled waterfall no longer accepts answers')

  // Its result retires the record, which is what happens live moments later.
  host.emit('session/event', { id: 's1' }, { type: 'tool/result', seq: 46, data: { message: { toolCallId: 'call-3', content: [] } } })
  const cleared = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  assert.equal(cleared.pending.questions.some((question) => question.callId === 'call-3'), false)
})

await check('a question from an already-running agent is captured and answerable', async () => {
  // Regression: the desktop reopens its Session before profile bundles apply, so its agent never
  // emits `agent/created`. Capture must work anyway — the plugin attaches to live agents it finds.
  assert.equal(host.liveAgents.length, 1)
  const listener = host.agentListener('s1', 'user-questions/request')
  assert.equal(typeof listener, 'function', 'the plugin subscribed to the live agent’s waterfall')

  let passedThrough = false
  const outcome = await listener({
    questions: [{ id: 'q1', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }],
    wait: { callId: 'call-1' },
  }, () => { passedThrough = true; return Promise.resolve('local-answer') })
  assert.equal(outcome, 'local-answer', 'the desktop answerer keeps the decision by default')
  assert.equal(passedThrough, true)

  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  assert.equal(state.pending.questions.length, 1, `pending: ${state.pending.questions.map((question) => question.callId).join(',')}`)
  assert.deepEqual(state.pending.questions[0].questions[0].options, [{ label: 'A' }, { label: 'B' }])

  // This listener was reached directly, so no waterfall is being raced here: the Host service is the
  // route, which accepts the question once it has continued.
  host.markContinued('call-1')
  const answered = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-1', answers: [{ id: 'q1', selected: ['B'] }] }),
  })
  assert.equal(answered.status, 200, await answered.text())
  assert.equal(host.calls.answer.at(-1).callId, 'call-1')
  assert.equal(host.calls.answer.at(-1).agentId, 's1')
  assert.deepEqual(host.calls.answer.at(-1).answer, { answers: [{ id: 'q1', selected: ['B'] }] })

  const after = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  assert.equal(after.pending.questions.length, 0, 'the answered question left the pending list')
})

await check('the root listener is a safety net for unannounced agents', async () => {
  const listener = host.rootListener('user-questions/request')
  assert.equal(typeof listener, 'function', 'the plugin also subscribed on its own context')
  const agent = host.makeAgent('s9')
  assert.equal(host.agentListener('s9', 'user-questions/request'), undefined, 'never announced, so no per-agent listener')
  const outcome = await listener({
    agent,
    questions: [{ id: 'q2', question: 'Root path?', options: [{ label: 'Yes' }] }],
    wait: { callId: 'call-2', timed: true },
  }, () => Promise.resolve('local-answer'))
  assert.equal(outcome, 'local-answer')
  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  const record = state.pending.questions.find((question) => question.callId === 'call-2')
  assert.equal(record?.sessionId, 's9', 'the request’s own agent identified the Session')
  assert.equal(record?.answerable, true)

  const diagnose = await (await fetch(`${base}/api/diagnose`, { headers: cookie })).json()
  assert.deepEqual(diagnose.capture.attached, ['s1'])
  assert.equal(diagnose.capture.rootQuestions > 0, true)
  assert.equal(diagnose.questions.some((question) => question.callId === 'call-2'), true)
  assert.equal(diagnose.liveAgents.includes('s1'), true)

  await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-2', answers: [{ id: 'q2', selected: ['Yes'] }] }),
  })
})

await check('a question the desktop is still waiting on is answerable from the remote page', async () => {
  // The live case: `userQuestions.answer()` refuses a question that has not timed out, so the only
  // way to answer is to resolve the waterfall this plugin races. The desktop bridge here never
  // resolves, which leaves the remote page as the only possible answerer.
  host.replaceBridge('user-questions/request', () => new Promise(() => {}))
  const waiting = host.emitWaterfall('user-questions/request', {
    agent: host.liveAgents[0],
    questions: [{ id: 'pick', question: '谁来答？', options: [{ label: '远程' }, { label: '桌面' }] }],
    wait: { callId: 'call-race' },
  })

  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  const record = state.pending.questions.find((question) => question.callId === 'call-race')
  assert.notEqual(record, undefined, 'the question is displayed while the waterfall waits')
  assert.equal(record.answerable, true, 'the racing waterfall makes it answerable')

  const answered = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-race', answers: [{ id: 'pick', selected: ['远程'] }] }),
  })
  const body = await answered.text()
  assert.equal(answered.status, 200, body)
  assert.equal(JSON.parse(body).ok, true)

  // The answer travels back through the waterfall the tool is awaiting.
  assert.deepEqual(await waiting, { answers: [{ id: 'pick', selected: ['远程'] }] })
  const after = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  assert.equal(after.pending.questions.some((question) => question.callId === 'call-race'), false)
  host.replaceBridge('user-questions/request', () => Promise.resolve(host.DESKTOP_ANSWER))
})

await check('a waiting waterfall that carries no call id is matched to the log record', async () => {
  // The live shape: observers receive `{questions, agent, signal}` with no `wait`, so the call id can
  // only come from the Session log — the record is matched by Session plus question signature.
  host.emit('session/event', { id: 's1' }, {
    type: 'tool/call',
    seq: 70,
    data: { callId: 'call-sig', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'sig', question: '签名匹配', options: [{ label: 'A' }] }] }) },
  })
  host.replaceBridge('user-questions/request', () => new Promise(() => {}))
  const waiting = host.emitWaterfall('user-questions/request', {
    agent: host.liveAgents[0],
    questions: [{ id: 'sig', question: '签名匹配', options: [{ label: 'A' }] }],
  })

  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  const record = state.pending.questions.find((question) => question.callId === 'call-sig')
  assert.notEqual(record, undefined)
  assert.equal(record.answerable, true, 'the waiting waterfall bound itself to the logged call id')

  const answered = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-sig', answers: [{ id: 'sig', selected: ['A'] }] }),
  })
  const body = await answered.text()
  assert.equal(JSON.parse(body).ok, true, body)
  assert.deepEqual(await waiting, { answers: [{ id: 'sig', selected: ['A'] }] }, 'the answer travelled back through the waterfall')
  host.replaceBridge('user-questions/request', () => Promise.resolve(host.DESKTOP_ANSWER))
})

await check('a continued question is answered through the Host service', async () => {
  host.emit('session/event', { id: 's1' }, {
    type: 'tool/call',
    seq: 60,
    data: { callId: 'call-svc', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'late', question: '超时后答', options: [{ label: 'A' }] }] }) },
  })
  host.markContinued('call-svc')
  const answered = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-svc', answers: [{ id: 'late', selected: ['A'] }] }),
  })
  const body = await answered.text()
  assert.equal(answered.status, 200, body)
  assert.equal(JSON.parse(body).ok, true)
  assert.equal(host.calls.answer.at(-1).callId, 'call-svc')
  const after = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  assert.equal(after.pending.questions.some((question) => question.callId === 'call-svc'), false)
})

await check('an approval is surfaced but keeps the desktop decision', async () => {
  const listener = host.agentListener('s1', 'approval/request')
  assert.equal(typeof listener, 'function', 'the live agent is observed for approvals too')
  let passedThrough = false
  const outcome = await listener({ toolName: 'bash', reason: 'rm -rf build' }, () => {
    passedThrough = true
    return Promise.resolve('allowed-once')
  })
  assert.equal(outcome, 'allowed-once')
  assert.equal(passedThrough, true)
  const state = await (await fetch(`${base}/api/state`, { headers: cookie })).json()
  assert.equal(state.pending.approvals.length, 1)
  assert.equal(state.pending.approvals[0].toolName, 'bash')
})

await check('repeated bad logins are rate limited', async () => {
  let limited = false
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: `bad-token-${String(attempt)}-xxxxxxxx` }),
    })
    if (response.status === 429) { limited = true; break }
  }
  assert.equal(limited, true, 'expected a 429 after repeated failures')
})

await check('the startup log carries a usable ?k= URL', async () => {
  const joined = host.logs.join('\n')
  assert.match(joined, /listening on 127\.0\.0\.1:\d+/u)
  assert.match(joined, /http:\/\/127\.0\.0\.1:\d+\/\?k=/u)
  assert.match(joined, /token source: plugin config/u)
  assert.match(joined, /loopback only/u)
})

await check('without a configured token the plugin mints and persists one', async () => {
  const second = createHost()
  apply(second.ctx, { bind: '127.0.0.1', port: 0 })
  let url
  for (let i = 0; i < 100 && url === undefined; i += 1) {
    const line = second.logs.find((entry) => entry.includes('http://127.0.0.1:'))
    if (line !== undefined) url = /http:\/\/127\.0\.0\.1:\d+\/\?k=([A-Za-z0-9_-]+)/u.exec(line)?.[0]
    else await sleep(20)
  }
  assert.ok(url !== undefined, 'expected a generated token URL')
  const generated = url.slice(url.indexOf('?k=') + 3)
  const file = join(HOME, 'remote-control', 'auth.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored.token, generated, 'the persisted token is the one handed out')
  assert.match(second.logs.join('\n'), /token file: .*auth\.json \(newly generated\)/u)
  const port = /:(\d+)\//u.exec(url)[1]
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${generated}` } })
  assert.equal(response.status, 200)
  for (const dispose of second.effects.reverse()) {
    if (typeof dispose === 'function') await dispose()
  }
})

rmSync(HOME, { recursive: true, force: true })

for (const dispose of host.effects.reverse()) {
  if (typeof dispose === 'function') await dispose()
}

if (failures === 0) {
  console.log('\nAll remote-control checks passed.')
  process.exit(0)
}
console.log(`\n${failures} check(s) failed.`)
process.exit(1)
