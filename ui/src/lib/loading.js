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
