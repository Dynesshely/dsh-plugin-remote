// Unit test for the ask_user_question model: argument parsing, answer parsing, and how the store
// attaches both to the transcript item.
//
// Run (from the plugin directory): node tools/test-remote-ui-questions.mjs
import assert from 'node:assert/strict'
import {
  allAnswered,
  answerOf,
  initialDraft,
  isAnswered,
  normalizeQuestions,
  parseQuestionArgs,
  parseQuestionResult,
  splitRecommended,
} from '../ui/src/lib/questions.js'
import { state, transcriptItems } from '../ui/src/lib/store.js'

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

const ARGS = JSON.stringify({
  questions: [
    {
      id: 'scope',
      header: '确认范围',
      question: '这次改动包含哪些部分？',
      options: [
        { label: '只改 UI（Recommended）', description: '先动前端' },
        { label: '前后端都改' },
      ],
    },
    {
      id: 'targets',
      question: '要同步到哪些设备？',
      multi_select: true,
      options: [{ label: '桌面' }, { label: '手机' }],
    },
  ],
})

console.log('Remote Control question model')

check('the "(Recommended)" marker becomes a flag', () => {
  assert.deepEqual(splitRecommended('只改 UI（Recommended）'), { label: '只改 UI', recommended: true })
  assert.deepEqual(splitRecommended('前后端都改 (recommended)'), { label: '前后端都改', recommended: true })
  assert.deepEqual(splitRecommended('先做 P0 骨架（推荐）'), { label: '先做 P0 骨架', recommended: true }, 'the Chinese marker counts too')
  assert.deepEqual(splitRecommended('普通选项'), { label: '普通选项', recommended: false })
})

check('tool arguments become normalized questions', () => {
  const questions = parseQuestionArgs('ask_user_question', ARGS)
  assert.equal(questions.length, 2)
  assert.deepEqual(questions[0], {
    id: 'scope',
    question: '这次改动包含哪些部分？',
    header: '确认范围',
    multiSelect: false,
    options: [
      { label: '只改 UI', recommended: true, description: '先动前端' },
      { label: '前后端都改', recommended: false },
    ],
  })
  assert.equal(questions[1].multiSelect, true, 'multi_select maps to multiSelect')
  assert.equal(questions[1].options.length, 2)
})

check('only question tools are parsed', () => {
  assert.deepEqual(parseQuestionArgs('pwsh', ARGS), [])
  assert.deepEqual(parseQuestionArgs('read', '{"file_path":"x"}'), [])
  assert.equal(parseQuestionArgs('request_user_input', ARGS).length, 2, 'the older name works too')
})

check('malformed arguments are ignored instead of throwing', () => {
  assert.deepEqual(parseQuestionArgs('ask_user_question', '{not json'), [])
  assert.deepEqual(parseQuestionArgs('ask_user_question', ''), [])
  assert.deepEqual(parseQuestionArgs('ask_user_question', '{"questions":"nope"}'), [])
  assert.deepEqual(parseQuestionArgs('ask_user_question', 'null'), [])
  assert.deepEqual(parseQuestionArgs('ask_user_question', JSON.stringify({ questions: [{ id: '' }] })), [])
})

check('a pending record from the Host normalizes the same way', () => {
  const questions = normalizeQuestions([
    { id: 'a', question: '选一个', multiSelect: false, options: [{ label: 'X（Recommended）' }, { label: 'Y', description: 'why not' }] },
  ])
  assert.equal(questions[0].options[0].recommended, true)
  assert.equal(questions[0].options[1].description, 'why not')
  assert.equal(questions[0].header, undefined, 'an absent header stays absent')
})

check('answers are read back in every shape the tool can produce', () => {
  const inside = parseQuestionResult('{"answers":[{"id":"scope","selected":["只改 UI"],"custom":"备注"}]}')
  assert.deepEqual(inside, [{ id: 'scope', selected: ['只改 UI'], custom: '备注' }])

  const bare = parseQuestionResult('[{"id":"scope","selected":[]}]')
  assert.deepEqual(bare, [{ id: 'scope', selected: [] }])

  const prefixed = parseQuestionResult('Tool finished.\n{"answers":[{"id":"a","selected":["x"]}]}\n')
  assert.deepEqual(prefixed, [{ id: 'a', selected: ['x'] }])

  assert.deepEqual(parseQuestionResult(''), [])
  assert.deepEqual(parseQuestionResult('no json here'), [])
  assert.deepEqual(parseQuestionResult('{"other":1}'), [])
  assert.deepEqual(parseQuestionResult('{"answers":[{"id":"a","selected":["x"],"custom":""}]}'), [{ id: 'a', selected: ['x'] }], 'an empty custom is dropped')
})

check('answer lookups drive the card state', () => {
  const questions = parseQuestionArgs('ask_user_question', ARGS)
  const partial = [{ id: 'scope', selected: ['只改 UI'] }]
  assert.equal(isAnswered(questions[0], answerOf(partial, 'scope')), true)
  assert.equal(isAnswered(questions[1], answerOf(partial, 'targets')), false)
  assert.equal(allAnswered(questions, partial), false)
  assert.equal(allAnswered(questions, [...partial, { id: 'targets', selected: ['桌面', '手机'] }]), true)
  assert.equal(isAnswered(questions[1], { id: 'targets', selected: [], custom: '都不要' }), true, 'free text counts')
})

check('the store turns the tool call into a question item', () => {
  state.events = [
    { type: 'tool/call', seq: 1, data: { callId: 'call-1', name: 'ask_user_question', arguments: ARGS } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'call-1', content: [{ type: 'text', text: '{"answers":[{"id":"scope","selected":["只改 UI"]},{"id":"targets","selected":["桌面"]}]}' }] } } },
  ]
  const [item] = transcriptItems.value
  assert.equal(item.kind, 'tool')
  assert.equal(item.callId, 'call-1')
  assert.equal(item.questions.length, 2, 'the card can render before the answer arrives')
  assert.deepEqual(item.answers, [
    { id: 'scope', selected: ['只改 UI'] },
    { id: 'targets', selected: ['桌面'] },
  ])
})

check('an ordinary tool call carries no questions', () => {
  state.events = [
    { type: 'tool/call', seq: 1, data: { callId: 'call-2', name: 'pwsh', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'call-2', content: [{ type: 'text', text: 'ok' }] } } },
  ]
  const [item] = transcriptItems.value
  assert.deepEqual(item.questions, [])
  assert.deepEqual(item.answers, [])
})

check('the recommended first option starts pre-selected', () => {
  const [single, multi] = parseQuestionArgs('ask_user_question', ARGS)
  assert.deepEqual(initialDraft(single), { id: 'scope', selected: ['只改 UI'], custom: '' })
  assert.deepEqual(initialDraft(multi), { id: 'targets', selected: [], custom: '' }, 'no marker, no draft')
  const late = normalizeQuestions([
    { id: 'x', question: 'q', options: [{ label: 'A' }, { label: 'B（Recommended）' }] },
  ])[0]
  assert.deepEqual(initialDraft(late).selected, [], 'only the first option counts, like the Desktop')
})

if (failures === 0) {
  console.log('\nAll question model checks passed.')
  process.exit(0)
}
console.log(`\n${failures} check(s) failed.`)
process.exit(1)
