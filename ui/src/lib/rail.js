/**
 * Pure helpers behind the prompt rail (the tick column on the right edge of the transcript).
 *
 * Kept free of the DOM so the navigation logic can be unit-tested without a browser.
 */

/** Preferred height of one tick's interaction cell in px (dash + the space around it). */
export const CELL_HEIGHT = 12
/** Smallest cell that still keeps neighbouring dashes apart. */
export const MIN_CELL_HEIGHT = 4
/** Used while the rail's height is still unknown. */
const FALLBACK_CELL_HEIGHT = 6

/**
 * Build one tick per user prompt, in transcript order.
 * @param items - transcript items (`{kind, key, text, images}`).
 * @returns `{ key, index, label, preview, images }` per prompt.
 */
export function promptTicks (items) {
  const ticks = []
  for (const item of items ?? []) {
    if (item?.kind !== 'user') continue
    const images = item.images?.length ?? 0
    const text = String(item.text ?? '').trim()
    ticks.push({
      key: String(item.key),
      index: ticks.length,
      label: `第 ${ticks.length + 1} 条 prompt`,
      preview: text,
      images,
    })
  }
  return ticks
}

/** Distance from the bottom that already counts as "at the end", in px. */
export const BOTTOM_SNAP = 24

/**
 * Which tick is active for a scroll position.
 *
 * At the end of the transcript the last prompt is the one being read, even when its top never
 * reached the read line (a short tail, or content that does not scroll at all). Otherwise the active
 * prompt is the last one whose top edge has reached the read line — a little below the scroller's
 * top edge, so a message is already "current" while it is being read.
 * @param tops - each prompt element's offset from the scroller's content top, in px.
 * @param scrollTop - the scroller's current scroll offset.
 * @param lead - how far below the top edge still counts as reached.
 * @param bottomGap - distance from the bottom of the scroll range (0 when fully scrolled).
 * @returns the active index, or -1 when there is nothing to highlight.
 */
export function activeTick (tops, scrollTop, lead = 80, bottomGap = Number.POSITIVE_INFINITY) {
  const list = tops ?? []
  if (list.length === 0) return -1
  if (bottomGap <= BOTTOM_SNAP) return list.length - 1
  let active = -1
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] <= scrollTop + lead) active = index
  }
  return active
}

/**
 * Height of one tick's interaction cell.
 *
 * The cells tile the cluster without any margin, so every pixel of the column is clickable; the
 * visible "margin" between dashes is just the part of each cell the dash does not fill. The cell
 * shrinks only when a huge session would otherwise overflow, and the cluster as a whole stays
 * centred because the layout centres itself.
 * @param count - number of ticks.
 * @param height - the rail's height in px (0 while unknown).
 * @param preferred - the comfortable cell height in px.
 * @param minimum - the smallest cell height in px.
 * @returns the cell height in px.
 */
export function tickCellHeight (count, height, preferred = CELL_HEIGHT, minimum = MIN_CELL_HEIGHT) {
  if (count <= 0) return preferred
  if (!(height > 0)) return Math.min(preferred, FALLBACK_CELL_HEIGHT)
  return Math.max(minimum, Math.min(preferred, Math.floor(height / count)))
}

/**
 * Clamp the preview card's centre so it stays inside the rail and keeps following its tick.
 * @param centre - the tick's centre offset inside the rail, in px.
 * @param height - the rail's height in px (0 while unknown).
 * @param margin - half the card's height plus a gap.
 * @returns the card centre in px.
 */
export function previewCentre (centre, height, margin = 90) {
  const target = Math.max(centre, 0)
  if (!(height > 2 * margin)) return target
  return Math.min(Math.max(target, margin), height - margin)
}
