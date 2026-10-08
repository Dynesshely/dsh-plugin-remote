// Unit test for the Remote Control UI store: message part splitting and tool-call grouping.
// The store is plain Vue reactivity, so it runs in Node without a DOM.
//
// Run (from the plugin directory): node tools/test-remote-ui-store.mjs
import assert from 'node:assert/strict'
import { isContextNote, messageParts, state, transcriptItems } from '../ui/src/lib/store.js'
import { promptTicks } from '../ui/src/lib/rail.js'

let failures = 0
function check (name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

const toolCall = (seq, name, callId) => ({ type: 'tool/call', seq, data: { callId, name, arguments: '{"file_path":"C:\\\\x"}' } })
const toolResult = (seq, callId, text = 'ok') => ({
  type: 'tool/result',
  seq,
  data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } },
})

console.log('Remote Control UI store')

check('tool calls never leak into the assistant text', () => {
  const parts = messageParts({
    content: [
      { type: 'reasoning', text: 'thinking about it' },
      { type: 'text', text: 'Reading the files now.' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
    ],
  })
  assert.equal(parts.text, 'Reading the files now.')
  assert.equal(parts.reasoning, 'thinking about it')
  assert.ok(!parts.text.includes('read'), 'the tool name must not be repeated in the text')
})

check('consecutive identical tools collapse into one group', () => {
  state.events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'go' }] } },
    {
      type: 'assistant/message',
      seq: 2,
      data: {
        message: {
          content: [
            { type: 'text', text: 'Reading the files now.' },
            { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
            { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
          ],
        },
      },
    },
    toolCall(3, 'read', 'c1'), toolResult(4, 'c1', 'file one'),
    toolCall(5, 'read', 'c2'), toolResult(6, 'c2', 'file two'),
    toolCall(7, 'read', 'c3'), toolResult(8, 'c3', 'file three'),
    toolCall(9, 'bash', 'c4'), toolResult(10, 'c4', 'shell out'),
  ]
  const items = transcriptItems.value

  const assistant = items.find((item) => item.kind === 'assistant')
  assert.equal(assistant.text, 'Reading the files now.')
  assert.ok(!assistant.text.includes('read'))

  const groups = items.filter((item) => item.kind === 'toolGroup')
  assert.equal(groups.length, 1, 'exactly one run of identical tools')
  assert.equal(groups[0].name, 'read')
  assert.equal(groups[0].count, 3, 'the run holds all three read calls')
  assert.equal(groups[0].items.length, 3)
  assert.deepEqual(groups[0].items.map((entry) => entry.result), ['file one', 'file two', 'file three'])
  assert.deepEqual(groups[0].items.map((entry) => entry.args), ['{"file_path":"C:\\\\x"}', '{"file_path":"C:\\\\x"}', '{"file_path":"C:\\\\x"}'])

  const looseTools = items.filter((item) => item.kind === 'tool')
  assert.equal(looseTools.length, 1, 'the different tool stays its own card')
  assert.equal(looseTools[0].name, 'bash')
})

check('a different tool in between keeps the runs apart', () => {
  state.events = [
    toolCall(1, 'read', 'c1'), toolResult(2, 'c1'),
    toolCall(3, 'bash', 'c2'), toolResult(4, 'c2'),
    toolCall(5, 'read', 'c3'), toolResult(6, 'c3'),
  ]
  const items = transcriptItems.value
  const groups = items.filter((item) => item.kind === 'toolGroup')
  assert.equal(groups.length, 0, 'two isolated calls are not a run')
  assert.equal(items.filter((item) => item.kind === 'tool').length, 3)
})

check('a run of two is already a group', () => {
  state.events = [
    toolCall(1, 'pwsh', 'c1'), toolResult(2, 'c1'),
    toolCall(3, 'pwsh', 'c2'), toolResult(4, 'c2'),
  ]
  const groups = transcriptItems.value.filter((item) => item.kind === 'toolGroup')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].name, 'pwsh')
})

check('a failed call inside a run keeps its error for the card', () => {
  state.events = [
    toolCall(1, 'pwsh', 'c1'), toolResult(2, 'c1'),
    toolCall(3, 'pwsh', 'c2'),
    { type: 'tool/result', seq: 4, data: { message: { toolCallId: 'c2', content: [] }, error: { name: 'ExitCode', code: '1' } } },
  ]
  const group = transcriptItems.value.find((item) => item.kind === 'toolGroup')
  assert.equal(group.count, 2)
  assert.equal(group.items[1].error, 'ExitCode')
  assert.equal(group.items[0].error, undefined)
})

check('a tool-only assistant step never splits a run', () => {
  state.events = [
    toolCall(1, 'read', 'c1'), toolResult(2, 'c1'),
    // What the log actually contains between two calls: an assistant message whose blocks are all
    // tool calls, so it must not produce a visible (empty) item.
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }] } } },
    toolCall(4, 'read', 'c2'), toolResult(5, 'c2'),
    { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'tool-call', id: 'c3', name: 'read', arguments: '{}' }] } } },
    toolCall(7, 'read', 'c3'), toolResult(8, 'c3'),
  ]
  const items = transcriptItems.value
  assert.equal(items.filter((item) => item.kind === 'assistant').length, 0, 'no empty assistant items')
  const groups = items.filter((item) => item.kind === 'toolGroup')
  assert.equal(groups.length, 1, 'the run stayed one group')
  assert.equal(groups[0].count, 3)
})

check('an assistant step with only reasoning does split the run (it is visible)', () => {
  state.events = [
    toolCall(1, 'pwsh', 'c1'), toolResult(2, 'c1'),
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'reasoning', text: 'thinking' }] } } },
    toolCall(4, 'pwsh', 'c2'), toolResult(5, 'c2'),
  ]
  const items = transcriptItems.value
  assert.equal(items.filter((item) => item.kind === 'assistant').length, 1)
  assert.equal(items.filter((item) => item.kind === 'toolGroup').length, 0, 'a visible chip keeps them apart')
  assert.equal(items.filter((item) => item.kind === 'tool').length, 2)
})

check('injected context becomes a note, not a user prompt', () => {
  state.events = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'real prompt' }] } },
    {
      type: 'user/message',
      seq: 2,
      data: {
        source: { kind: 'time-context' },
        content: [{ type: 'text', text: 'Time sampled while preparing turn 3, step 1: 2026-10-08T20:13:47+08:00[Asia/Hong_Kong]\nBrowser time zone for this request: unavailable.\nElapsed since the preceding model-visible message: 19m 43s.' }],
      },
    },
    {
      type: 'user/message',
      seq: 3,
      data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nbody' }] },
    },
  ]
  const items = transcriptItems.value
  assert.deepEqual(items.map((item) => item.kind), ['user'], 'notes are folded into the prompt bubble')
  assert.equal(items[0].text, 'real prompt')
  assert.equal(items[0].notes.length, 2)
  assert.equal(items[0].notes[0].sourceKind, 'time-context')
  assert.ok(items[0].notes[0].text.startsWith('Time sampled while preparing turn 3'))
  assert.equal(items[0].notes[1].sourceKind, undefined)
  // The rail counts prompts, so injected metadata must not take a tick.
  assert.deepEqual(promptTicks(items).map((tick) => tick.key), ['user-1'])
})

check('a context note with no prompt above it stands alone', () => {
  state.events = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: x' }] } },
  ]
  const items = transcriptItems.value
  assert.deepEqual(items.map((item) => item.kind), ['context'])
  assert.deepEqual(promptTicks(items), [])
})

check('context notes are not counted as prompt ticks and images carry no label', () => {
  const parts = messageParts({ content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }] })
  assert.equal(parts.images.length, 1)
  assert.deepEqual(parts.files, [], 'no "🖼 图片" placeholder: the thumbnail is the label')
  const withFile = messageParts({ content: [{ type: 'file', attachment: { name: 'notes.pdf' } }] })
  assert.deepEqual(withFile.files, ['📎 notes.pdf'])
})

check('a prompt the user really wrote is never treated as context', () => {
  assert.equal(isContextNote({ source: { kind: 'user', rpcId: 'r' } }, 'Time is money, but not a snapshot'), false)
  assert.equal(isContextNote({ source: { kind: 'user' } }, 'Elapsed since the preceding meeting: 5m.'), true, 'exact prefix fallback')
  assert.equal(isContextNote({}, 'Current runtime context. This snapshot supersedes earlier ones.'), true)
  assert.equal(isContextNote({}, 'hello'), false)
})

if (failures === 0) {
  console.log('\nAll UI store checks passed.')
  process.exit(0)
}
console.log(`\n${failures} check(s) failed.`)
process.exit(1)
