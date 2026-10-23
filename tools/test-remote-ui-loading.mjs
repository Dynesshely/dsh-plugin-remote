/**
 * Loading-phase checks, runnable without a browser.
 *
 * The thresholds themselves are the contract with the feature request: a slow link is announced at five
 * seconds, and a load is given up on at fifteen — never silently.
 */

import assert from 'node:assert/strict'
import { canCancel, canRetry, FAIL_AFTER_MS, loadMessage, loadPhase, SLOW_AFTER_MS } from '../ui/src/lib/loading.js'

let checks = 0

/** @param name - the check being made. @param run - its body. */
function check (name, run) {
  try {
    run()
    checks += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${String(error?.message ?? error)}`)
    process.exitCode = 1
  }
}

check('慢网阈值早于失败阈值，且都在 issue 要求的时间尺度上', () => {
  assert.ok(SLOW_AFTER_MS >= 3_000 && SLOW_AFTER_MS <= 5_000, 'slow threshold should be 3-5s')
  assert.ok(FAIL_AFTER_MS > SLOW_AFTER_MS, 'failure must come after the slow warning')
  assert.equal(FAIL_AFTER_MS, 15_000)
})

check('空闲时不渲染任何加载态', () => {
  assert.equal(loadPhase(false, false, false), 'idle')
  assert.equal(loadMessage('idle', '会话'), '')
  assert.equal(canRetry('idle'), false)
  assert.equal(canCancel('idle'), false)
})

check('刚开始加载时只显示骨架，不加文字', () => {
  assert.equal(loadPhase(true, false, false), 'loading')
  assert.equal(loadMessage('loading', '会话'), '')
  assert.equal(canCancel('loading'), true)
  assert.equal(canRetry('loading'), false)
})

check('超过阈值后承认网络慢，并仍可取消', () => {
  assert.equal(loadPhase(true, true, false), 'slow')
  assert.match(loadMessage('slow', '会话'), /网络较慢/u)
  assert.match(loadMessage('slow', '会话'), /会话/u)
  assert.equal(canCancel('slow'), true)
})

check('失败时给出原因与重试，不再显示取消', () => {
  assert.equal(loadPhase(true, true, true), 'failed')
  assert.equal(loadPhase(false, false, true), 'failed', 'a failure outranks a finished request')
  assert.match(loadMessage('failed', '会话'), /失败/u)
  assert.equal(canRetry('failed'), true)
  assert.equal(canCancel('failed'), false)
})

check('失败优先于慢网，避免同时出现两种状态', () => {
  assert.equal(loadPhase(true, true, true), 'failed')
})

check('标签被带入提示文案，三类加载可共用同一套判断', () => {
  for (const label of ['会话', '更早的消息', '应用状态']) {
    assert.ok(loadMessage('slow', label).includes(label), label)
    assert.ok(loadMessage('failed', label).includes(label), label)
  }
})

if (process.exitCode === 1) {
  console.error(`${String(checks)} check(s) passed before the first failure.`)
} else {
  console.log(`All loading checks passed (${String(checks)}).`)
}
