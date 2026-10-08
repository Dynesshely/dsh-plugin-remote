// Manual smoke probe for a running Remote Control plugin.
// Reads the token from the Harness home, opens a Session stream for a few seconds, and prints what
// came back. Useful after installing the plugin or changing the page.
//
// Run (from the plugin directory): node tools/smoke-remote-control.mjs [baseUrl] [sessionId]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:19400'
const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
const token = JSON.parse(readFileSync(join(home, 'remote-control', 'auth.json'), 'utf8')).token

const health = await (await fetch(`${base}/healthz`)).json()
console.log('healthz:', health.ok === true ? 'ok' : health, '| urls:', (health.urls ?? []).length)

const state = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()
console.log('sessions:', state.sessions.length, '| bind:', state.bind)
for (const session of state.sessions.slice(0, 8)) {
  console.log(`  ${session.running ? 'RUN ' : '    '}${session.id}  ${session.origin === 'subagent' ? '[sub] ' : ''}${session.title ?? ''}`)
}
console.log('pending:', state.pending.questions.length, 'question(s),', state.pending.approvals.length, 'approval(s)')

const sessionId = process.argv[3] ?? state.sessions.find((session) => session.running)?.id ?? state.sessions[0]?.id
if (sessionId === undefined) {
  console.log('no session to stream')
  process.exit(0)
}

console.log(`\nstreaming ${sessionId} for 4s ...`)
const controller = new AbortController()
setTimeout(() => { controller.abort() }, 4000)
let seen = ''
try {
  const response = await fetch(`${base}/api/stream?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read()
    if (done === true) break
    seen += decoder.decode(value, { stream: true })
  }
} catch (error) {
  if (error?.name !== 'AbortError') throw error
}
const events = [...seen.matchAll(/^event: (\S+)$/gmu)].map((match) => match[1])
const counts = events.reduce((map, name) => map.set(name, (map.get(name) ?? 0) + 1), new Map())
console.log('sse events:', [...counts].map(([name, count]) => `${name}×${String(count)}`).join(' ') || '(none)')
const snapshot = /event: snapshot\ndata: (.+)/u.exec(seen)
if (snapshot !== null) {
  const frame = JSON.parse(snapshot[1])
  console.log('snapshot: records =', Array.isArray(frame.records) ? frame.records.length : 0, '| hasMore =', frame.hasMore)
}
const firstError = /event: stream-error\ndata: (.+)/u.exec(seen)
if (firstError !== null) console.log('stream-error:', firstError[1])
