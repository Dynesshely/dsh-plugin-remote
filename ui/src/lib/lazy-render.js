/**
 * Render a row when it is near the viewport, and stop when it is far away.
 *
 * The transcript used to parse every message as soon as the first snapshot arrived: with a window of up
 * to 500 messages that is hundreds of marked + highlight.js + DOMPurify passes inside one or two frames,
 * which is what froze the page a couple of seconds after loading. Only the rows a reader can actually
 * reach need that work.
 *
 * Two margins rather than one give it hysteresis: a row starts rendering a little before it scrolls into
 * view, and only gives up its rendered output once it is well out of range — so scrolling back and forth
 * over the same area does not re-parse anything.
 *
 * Parses are also rate-limited per frame. A fast scroll can bring a dozen rows into range at once, and
 * doing all of them in a single frame would just move the stall somewhere else.
 *
 * The last piece is keeping the reader's place. Rendering a row that sits *above* the viewport makes the
 * content above them taller, which shifts everything they are looking at; releasing one does the reverse.
 * A browser's own scroll anchoring is supposed to absorb exactly that, but not reliably when the change
 * lands in the same frame as a scroll — which is where the visible twitch between two offsets came from.
 * So each batch measures the height change above the viewport and corrects the offset itself, unless the
 * browser got there first (the offset will already have moved on its own), which is what keeps the two
 * mechanisms from adding up.
 */

import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

/** How far outside the viewport a row starts rendering. */
const PRELOAD_MARGIN = '800px 0px'
/** How far it has to leave before its rendered output is dropped. */
const RELEASE_MARGIN = '2500px 0px'
/** How many rows may start rendering in one frame. */
const BUDGET_PER_FRAME = 4

/** Rows waiting for their turn in the frame budget. */
const queue = new Set()
/** Element → its render state, so the shared observers can find it. */
const watched = new WeakMap()
let frame
let near
let far
/** The element the rows scroll inside, published by the pane that owns them. */
let scrollRoot
/** Serialises height-changing batches, so two of them cannot measure the same layout. */
let chain = Promise.resolve()

/**
 * @param element - the scrolling container the rows live in.
 *
 * The rows need it to correct the scroll offset; nothing else about the module depends on it, so a row
 * used outside a scroller simply skips the correction.
 */
export function setScrollRoot (element) {
  scrollRoot = element ?? undefined
}

/**
 * Toggle a batch of rows and keep the reader's place.
 * @param entries - the rows to toggle.
 * @param value - whether they should be rendered.
 * @returns a promise that settles once the scroll offset has been corrected.
 */
function toggle (entries, value) {
  chain = chain.then(async () => {
    const box = scrollRoot
    const viewportTop = box === undefined ? 0 : box.getBoundingClientRect().top
    const measured = entries.map((entry) => {
      const rect = entry.node.getBoundingClientRect()
      return {
        // Only a row above the reader moves what they are looking at.
        above: rect.top < viewportTop,
        height: entry.node.offsetHeight,
      }
    })
    const scrollBefore = box?.scrollTop ?? 0
    for (const entry of entries) {
      if (entry.alive) entry.rendered.value = value
    }
    if (box === undefined) return
    await nextTick()
    // Reading the offset now forces the pending layout, which is where the browser's own anchoring, if it
    // ran, will already be visible.
    const anchored = box.scrollTop !== scrollBefore
    let shift = 0
    entries.forEach((entry, index) => {
      if (!measured[index].above) return
      shift += entry.node.offsetHeight - measured[index].height
    })
    if (!anchored && shift !== 0) box.scrollTop = scrollBefore + shift
  }).catch(() => {})
  return chain
}

/** Run the queue, a few rows per frame. */
function schedule () {
  if (frame !== undefined) return
  frame = window.requestAnimationFrame(() => {
    frame = undefined
    const batch = []
    for (const entry of [...queue]) {
      if (batch.length >= BUDGET_PER_FRAME) break
      queue.delete(entry)
      if (entry.alive) batch.push(entry)
    }
    if (batch.length > 0) void toggle(batch, true)
    if (queue.size > 0) schedule()
  })
}

/** @returns the two shared observers, created on first use. */
function observers () {
  if (near !== undefined && far !== undefined) return { near, far }
  // Entering the preload band queues the row; leaving it does nothing, which is where the hysteresis
  // comes from.
  near = new IntersectionObserver((entries) => {
    for (const record of entries) {
      const state = watched.get(record.target)
      if (state === undefined || !record.isIntersecting) continue
      queue.add(state)
    }
    schedule()
  }, { rootMargin: PRELOAD_MARGIN })
  // Leaving the wide band is the only thing that releases a row.
  far = new IntersectionObserver((entries) => {
    const batch = []
    for (const record of entries) {
      const state = watched.get(record.target)
      if (state === undefined || record.isIntersecting) continue
      queue.delete(state)
      if (state.alive) batch.push(state)
    }
    if (batch.length > 0) void toggle(batch, false)
  }, { rootMargin: RELEASE_MARGIN })
  return { near, far }
}

/**
 * @param element - a template ref to the element that represents the row.
 * @returns `{ rendered }` — true while the row should do its expensive rendering.
 */
export function useLazyRender (element) {
  const rendered = ref(false)
  let state

  onMounted(() => {
    const node = element.value
    // Without IntersectionObserver every row simply renders, which is the old behaviour.
    if (node === null || node === undefined || typeof IntersectionObserver === 'undefined') {
      rendered.value = true
      return
    }
    state = { node, rendered, alive: true }
    watched.set(node, state)
    const shared = observers()
    shared.near.observe(node)
    shared.far.observe(node)
  })

  onBeforeUnmount(() => {
    if (state === undefined) return
    state.alive = false
    queue.delete(state)
    watched.delete(state.node)
    if (near !== undefined) near.unobserve(state.node)
    if (far !== undefined) far.unobserve(state.node)
    state = undefined
  })

  return { rendered }
}
