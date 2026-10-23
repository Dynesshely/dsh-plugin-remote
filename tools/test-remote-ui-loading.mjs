/**
 * Loading-phase checks, runnable without a browser.
 *
 * The thresholds themselves are the contract with the feature request: a slow link is announced at five
 * seconds, and a load is given up on at fifteen — never silently.
 */

import assert from 'node:assert/strict'
import {
  canCancel,
  canRetry,
  compactCount,
  EMPTY_SNAPSHOT_PROGRESS,
  FAIL_AFTER_MS,
  loadMessage,
  loadPhase,
  nextSnapshotProgress,
  SLOW_AFTER_MS,
  snapshotLine,
} from '../ui/src/lib/loading.js'

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

/* ---------------------------------------------------------------- snapshot progress */

const chunk = (index, count, size, last) => ({
  type: index === 0 ? 'snapshot' : 'snapshot-append',
  chunkIndex: index,
  chunkCount: count,
  totalRecords: count * size,
  records: new Array(size).fill(null),
  last,
})

check('首块建立进度：序号、总块数、已载入条数都对', () => {
  const progress = nextSnapshotProgress(EMPTY_SNAPSHOT_PROGRESS, chunk(0, 3, 300, false))
  assert.equal(progress.index, 0)
  assert.equal(progress.count, 3)
  assert.equal(progress.loaded, 300)
  assert.equal(progress.total, 900)
  assert.equal(progress.done, false)
})

check('中间块累加，不重置已载入条数', () => {
  let progress = nextSnapshotProgress(EMPTY_SNAPSHOT_PROGRESS, chunk(0, 3, 300, false))
  progress = nextSnapshotProgress(progress, chunk(1, 3, 300, false))
  progress = nextSnapshotProgress(progress, chunk(2, 3, 300, true))
  assert.equal(progress.index, 2)
  assert.equal(progress.loaded, 900)
  assert.equal(progress.done, true, 'the last chunk completes the snapshot')
})

check('未分块的单帧（旧宿主）立即算完成，且不显示块序号', () => {
  const progress = nextSnapshotProgress(EMPTY_SNAPSHOT_PROGRESS, {
    type: 'snapshot',
    records: new Array(120).fill(null),
  })
  assert.equal(progress.done, true)
  assert.equal(progress.count, 0)
  assert.equal(progress.loaded, 120)
  assert.equal(snapshotLine(progress, 0).includes('/'), false, 'no chunk counter without chunk metadata')
})

check('宿主没给进度字段时，序号按到达顺序自增', () => {
  let progress = nextSnapshotProgress(EMPTY_SNAPSHOT_PROGRESS, { type: 'snapshot', records: [null], last: false })
  progress = nextSnapshotProgress(progress, { type: 'snapshot-append', records: [null], last: true })
  assert.equal(progress.index, 1)
  assert.equal(progress.loaded, 2)
  assert.equal(progress.done, true)
})

check('紧凑计数：千位以上才缩写', () => {
  assert.equal(compactCount(0), '0')
  assert.equal(compactCount(999), '999')
  assert.equal(compactCount(2100), '2.1k')
  assert.equal(compactCount(1_500_000), '1.5M')
})

check('进度文案：加载中给出块序号与条数，完成时给出耗时', () => {
  const loading = { index: 0, count: 3, loaded: 300, total: 900, done: false }
  const line = snapshotLine(loading, 0)
  assert.match(line, /正在载入历史/u)
  assert.match(line, /1\/3/u)
  assert.match(line, /300 条/u)

  const done = { index: 2, count: 3, loaded: 1800, total: 1800, done: true }
  const finished = snapshotLine(done, 1234)
  assert.match(finished, /载入完成/u)
  assert.match(finished, /1\.8k 条/u)
  assert.match(finished, /1\.2s/u)
})

if (process.exitCode === 1) {
  console.error(`${String(checks)} check(s) passed before the first failure.`)
} else {
  console.log(`All loading checks passed (${String(checks)}).`)
}
