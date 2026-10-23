/**
 * The loading phases a surface goes through, and what to say in each.
 *
 * Split out of the components so the policy is testable rather than scattered across three templates: a
 * slow link is normal, and the page should say so once, at a threshold, instead of spinning silently for
 * half a minute.
 */

/** How long a load may run before the page admits the link is slow. */
export const SLOW_AFTER_MS = 5_000
/** How long before the load is treated as failed, with a retry offered instead of an endless skeleton. */
export const FAIL_AFTER_MS = 15_000

/**
 * @param loading - whether a request is in flight.
 * @param slow - whether it has already been flagged slow.
 * @param failed - whether it has been given up on.
 * @returns the phase to render: `idle`, `loading`, `slow` or `failed`.
 */
export function loadPhase (loading, slow, failed) {
  if (failed) return 'failed'
  if (loading !== true) return 'idle'
  return slow === true ? 'slow' : 'loading'
}

/**
 * @param phase - the value from `loadPhase`.
 * @param label - what is being loaded, e.g. `会话`.
 * @returns the line to show above the skeleton, or an empty string for no line.
 *
 * `idle` and plain `loading` say nothing: a skeleton is already the message. Only the awkward states get
 * words — a link that is clearly slow, or a load that failed.
 */
export function loadMessage (phase, label) {
  if (phase === 'slow') return `网络较慢，正在继续载入${label}…`
  if (phase === 'failed') return `${label}载入失败`
  return ''
}

/** An empty progress record, for a Session that is about to load. */
export const EMPTY_SNAPSHOT_PROGRESS = Object.freeze({
  index: 0,
  count: 0,
  loaded: 0,
  total: 0,
  done: false,
})

/**
 * Fold one snapshot chunk into the progress record.
 *
 * The Host sends a snapshot as several frames on a long Session, and the transcript starts filling while
 * they arrive — so without this the reader cannot tell "still arriving" from "everything is here". A Host
 * that sends one unchunked snapshot omits `last`, which counts as complete.
 * @param previous - the current record.
 * @param frame - a `snapshot` or `snapshot-append` frame.
 * @returns the next record.
 */
export function nextSnapshotProgress (previous, frame) {
  const first = frame?.type === 'snapshot'
  const records = Array.isArray(frame?.records) ? frame.records.length : 0
  const index = Number(frame?.chunkIndex)
  const count = Number(frame?.chunkCount)
  const total = Number(frame?.totalRecords)
  const loaded = (first ? 0 : Number(previous?.loaded) || 0) + records
  return {
    index: Number.isFinite(index) && index >= 0 ? index : first ? 0 : (Number(previous?.index) || 0) + 1,
    count: Number.isFinite(count) && count > 0 ? count : Number(previous?.count) || 0,
    loaded,
    total: Number.isFinite(total) && total > 0 ? total : first ? records : Math.max(Number(previous?.total) || 0, loaded),
    done: frame?.last !== false,
  }
}

/** @returns a compact count: 2100 → "2.1k". */
export function compactCount (value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '0'
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`
  return String(Math.round(number))
}

/**
 * @param progress - the record from `nextSnapshotProgress`.
 * @param elapsedMs - how long the load took, for the finished line.
 * @returns the one line the progress pill shows.
 */
export function snapshotLine (progress, elapsedMs) {
  const seconds = Number.isFinite(elapsedMs) && elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : ''
  if (progress?.done === true) {
    const parts = ['载入完成', `${compactCount(progress.loaded)} 条`]
    if (seconds !== '') parts.push(seconds)
    return parts.join(' · ')
  }
  const chunks = progress?.count > 1 ? `${Number(progress.index) + 1}/${String(progress.count)}` : ''
  const loaded = Number(progress?.loaded) > 0 ? `${compactCount(progress.loaded)} 条` : ''
  const detail = [chunks, loaded].filter((part) => part !== '').join(' · ')
  return detail === '' ? '正在载入历史…' : `正在载入历史 · ${detail}`
}

/**
 * @param phase - the value from `loadPhase`.
 * @returns whether a retry action belongs next to the message.
 */
export function canRetry (phase) {
  return phase === 'failed'
}

/**
 * @param phase - the value from `loadPhase`.
 * @returns whether the load can still be cancelled.
 */
export function canCancel (phase) {
  return phase === 'loading' || phase === 'slow'
}
