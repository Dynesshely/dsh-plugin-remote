// Unit test for the layout-mode probe: mobile mode is the OR of "narrow viewport" and "the composer
// toolbar reported that its desktop controls no longer fit".
//
// Run (from the plugin directory): node tools/test-remote-ui-layout.mjs
import assert from 'node:assert/strict'

const MODULE = '../ui/src/lib/layout.js'

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

/** @returns a fresh module instance with `window.matchMedia` answering `matches`. */
async function load (matches, tag) {
  globalThis.window = {
    matchMedia: () => ({ matches, addEventListener: () => {} }),
  }
  return import(`${MODULE}?case=${tag}`)
}

console.log('Remote Control layout probe')

await check('a wide viewport alone stays in desktop mode', async () => {
  const layout = await load(true, 'wide')
  assert.equal(layout.mobile.value, false)
})

await check('an overflowing composer turns a wide viewport into mobile mode', async () => {
  const layout = await load(true, 'overflow')
  assert.equal(layout.mobile.value, false)
  layout.reportComposerOverflow(true)
  assert.equal(layout.mobile.value, true, 'the composer signal alone is enough')
  layout.reportComposerOverflow(false)
  assert.equal(layout.mobile.value, false, 'and clearing it restores desktop mode')
})

await check('a narrow viewport is mobile even when the composer fits', async () => {
  const layout = await load(false, 'narrow')
  assert.equal(layout.mobile.value, true)
  layout.reportComposerOverflow(false)
  assert.equal(layout.isBelowWide.value, true)
  assert.equal(layout.mobile.value, true)
})

await check('clearing the composer signal cannot escape a narrow viewport', async () => {
  const layout = await load(false, 'narrow-sticky')
  layout.reportComposerOverflow(true)
  layout.reportComposerOverflow(false)
  assert.equal(layout.mobile.value, true)
})

if (failures === 0) {
  console.log('\nAll layout probe checks passed.')
  process.exit(0)
}
console.log(`\n${failures} check(s) failed.`)
process.exit(1)
