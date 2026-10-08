// Unit test for the prompt-rail helpers (tick list, active tick, tick geometry).
//
// Run (from the plugin directory): node tools/test-remote-ui-rail.mjs
import assert from 'node:assert/strict'
import { BOTTOM_SNAP, activeTick, previewCentre, promptTicks, tickCellHeight } from '../ui/src/lib/rail.js'

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

console.log('Remote Control prompt rail')

check('one tick per user prompt, in order', () => {
  const ticks = promptTicks([
    { kind: 'user', key: 'user-1', text: 'first prompt', images: [] },
    { kind: 'assistant', key: 'assistant-2', text: 'answer' },
    { kind: 'tool', key: 'tool-3', name: 'read' },
    { kind: 'user', key: 'user-4', text: 'second prompt', images: [{ attachmentId: 'a' }, { attachmentId: 'b' }] },
  ])
  assert.equal(ticks.length, 2)
  assert.deepEqual(ticks.map((tick) => tick.key), ['user-1', 'user-4'])
  assert.deepEqual(ticks.map((tick) => tick.index), [0, 1])
  assert.deepEqual(ticks.map((tick) => tick.label), ['第 1 条 prompt', '第 2 条 prompt'])
  assert.equal(ticks[1].images, 2)
  assert.equal(ticks[1].preview, 'second prompt')
})

check('an image-only prompt keeps an empty preview', () => {
  const [tick] = promptTicks([{ kind: 'user', key: 'user-9', text: '   ', images: [{ attachmentId: 'a' }] }])
  assert.equal(tick.preview, '')
  assert.equal(tick.images, 1)
})

check('no prompts means no ticks', () => {
  assert.deepEqual(promptTicks([]), [])
  assert.deepEqual(promptTicks(undefined), [])
  assert.deepEqual(promptTicks([{ kind: 'assistant', key: 'a' }]), [])
})

check('the active tick is the last prompt that reached the read line', () => {
  const tops = [0, 500, 1000]
  assert.equal(activeTick(tops, 0), 0)
  assert.equal(activeTick(tops, 10), 0)
  // 450 + the 80px lead has not reached the second prompt yet.
  assert.equal(activeTick(tops, 419), 0)
  assert.equal(activeTick(tops, 421), 1)
  assert.equal(activeTick(tops, 900), 1)
  assert.equal(activeTick(tops, 999), 2)
})

check('the last prompt is active once the transcript is scrolled to its end', () => {
  const tops = [0, 500, 1000]
  assert.equal(activeTick(tops, 300, 80, 0), 2, 'bottom reached')
  assert.equal(activeTick(tops, 300, 80, BOTTOM_SNAP), 2, 'within the snap distance')
  assert.equal(activeTick(tops, 300, 80, BOTTOM_SNAP + 1), 0, 'just outside it, the read line decides')
  assert.equal(activeTick([0], 0, 80, 0), 0, 'a single prompt at the end')
  assert.equal(activeTick([], 0, 80, 0), -1, 'nothing to highlight without prompts')
})

check('missing elements never become active', () => {
  // `Infinity` is what the caller passes for a prompt whose element is not rendered.
  assert.equal(activeTick([0, Number.POSITIVE_INFINITY, 900], 1000), 2)
  assert.equal(activeTick([], 0), -1)
})

check('cells tile the column and shrink only when they must', () => {
  assert.equal(tickCellHeight(0, 700), 12, 'no ticks: the preferred cell')
  assert.equal(tickCellHeight(5, 700), 12, 'a handful of prompts keeps the comfortable cell')
  assert.equal(tickCellHeight(60, 700), 11, 'a long session shrinks the cells')
  assert.equal(tickCellHeight(100, 700), 7)
  assert.equal(tickCellHeight(200, 700), 4, 'never below the minimum, which still separates dashes')
})

check('an unmeasured rail still renders a centred cluster', () => {
  assert.equal(tickCellHeight(5, 0), 6, 'a dense-but-safe fallback; the layout centres it')
  assert.equal(tickCellHeight(5, undefined), 6)
})

check('the preview card stays inside the rail and follows its tick', () => {
  assert.equal(previewCentre(0, 800), 90, 'clamped at the top')
  assert.equal(previewCentre(800, 800), 710, 'clamped at the bottom')
  assert.equal(previewCentre(400, 800), 400, 'follows the tick in the middle')
  // Regression: an unmeasured (or very short) rail must follow the tick, NOT jump to the top of the
  // page — that was the "preview at the top-right corner" bug.
  assert.equal(previewCentre(400, 0), 400)
  assert.equal(previewCentre(400, 100), 400)
})

if (failures === 0) {
  console.log('\nAll prompt rail checks passed.')
  process.exit(0)
}
console.log(`\n${failures} check(s) failed.`)
process.exit(1)
