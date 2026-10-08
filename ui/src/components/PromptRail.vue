<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { previewCentre, tickCellHeight } from '../lib/rail.js'
import AppIcon from './AppIcon.vue'

/**
 * Prompt navigator: a compact cluster of ticks on the right edge of the transcript.
 *
 * One tick per user prompt, gathered in the vertical centre of the stream. Hovering previews the
 * prompt, clicking jumps to it. Only the ticks take pointer events, so the native scrollbar next to
 * them stays draggable.
 */
const props = defineProps({
  /** Prompt ticks from `promptTicks()`. */
  ticks: { type: Array, default: () => [] },
  /** Index of the prompt that is currently being read, or -1. */
  active: { type: Number, default: -1 },
})

const emit = defineEmits(['jump'])

const rail = ref(null)
const cluster = ref(null)
const height = ref(0)
/** Index whose dash is lit — follows the pointer immediately, so sweeping lights each one in turn. */
const hovered = ref(-1)
/** Index whose preview card is shown — also immediate, so a fast sweep still previews every prompt. */
const previewed = ref(-1)
/** The hovered tick's centre inside the rail, in px — the preview follows it exactly. */
const anchor = ref(0)
let observer

const cell = computed(() => tickCellHeight(props.ticks.length, height.value))
const preview = computed(() => (previewed.value < 0 ? undefined : props.ticks[previewed.value]))
const previewTop = computed(() => previewCentre(anchor.value, height.value))

/** @returns the tick whose cell contains `clientY`, clamped into the column. */
function indexAt (clientY) {
  const node = cluster.value
  if (node === null || props.ticks.length === 0) return -1
  const rect = node.getBoundingClientRect()
  if (rect.height <= 0) return -1
  const raw = Math.floor((clientY - rect.top) / cell.value)
  return Math.min(Math.max(raw, 0), props.ticks.length - 1)
}

/** @returns the centre of one tick's cell inside the rail, in px. */
function centreOf (index) {
  const node = cluster.value?.children?.[index]
  return node instanceof HTMLElement ? node.offsetTop + node.offsetHeight / 2 : 0
}

/**
 * Track the pointer across the whole column, with no intent delay at all.
 *
 * The cells tile the column, so the hovered index is a division rather than a per-cell enter/leave
 * race, and both the dash and the card react in the same frame. The card is mounted once and only
 * has its content and `top` updated, so a fast sweep reads as one card gliding down the column
 * instead of a flicker of mounts — that is what makes every prompt reviewable while moving.
 */
function onPointerMove (event) {
  const index = indexAt(event.clientY)
  if (index < 0 || index === hovered.value) return
  hovered.value = index
  anchor.value = centreOf(index)
  previewed.value = index
}

/** Keyboard focus behaves like the pointer: immediate. */
function onFocus (index) {
  hovered.value = index
  anchor.value = centreOf(index)
  previewed.value = index
}

function onLeave () {
  hovered.value = -1
  previewed.value = -1
}

// The root is behind a `v-if`, so it can appear after mount: observe it whenever it shows up.
watch(rail, (element) => {
  observer?.disconnect()
  observer = undefined
  if (element === null) return
  observer = new ResizeObserver(() => {
    height.value = element.clientHeight
  })
  observer.observe(element)
  height.value = element.clientHeight
}, { immediate: true })

onBeforeUnmount(() => {
  observer?.disconnect()
  onLeave()
})

watch(() => props.ticks.length, onLeave)
</script>

<template>
  <div
    v-if="ticks.length > 0"
    ref="rail"
    class="pointer-events-none absolute flex w-7 select-none flex-col justify-center"
    aria-label="prompt 快速导航"
    role="navigation"
    @pointermove="onPointerMove"
    @pointerleave="onLeave"
  >
    <!-- Cells tile the cluster with no margin, so the whole column is clickable; the visible gap is
         just the part of each cell the dash leaves empty. Dashes are right-aligned inside their cell,
         so a longer (active) dash grows to the left and the column's right edge stays true. -->
    <div ref="cluster" class="flex max-h-full flex-col items-end justify-center overflow-hidden">
      <button
        v-for="tick in ticks"
        :key="tick.key"
        type="button"
        class="pointer-events-auto flex w-full shrink-0 items-center justify-end pr-px"
        :style="{ height: `${cell}px` }"
        :aria-label="`${tick.label}${tick.images > 0 ? `（含 ${tick.images} 张图片）` : ''}`"
        :title="tick.preview === '' ? tick.label : tick.preview"
        @focus="onFocus(tick.index)"
        @blur="onLeave"
        @click="emit('jump', tick.key)"
      >
        <span
          class="rounded-full transition-all duration-75"
          :class="tick.index === hovered || tick.index === active
            ? 'h-[3px] w-6 bg-zinc-500/80 dark:bg-zinc-200/85'
            : 'h-[1.5px] w-[18px] bg-zinc-400/45 hover:bg-zinc-500/70 dark:bg-zinc-500/50 dark:hover:bg-zinc-300/80'"
        />
      </button>
    </div>

    <!-- Preview of the prompt under the pointer; mounted once and then only moved/updated, so a fast
         sweep reads as one card gliding down the column. -->
    <div
      v-if="preview !== undefined"
      class="card pointer-events-none absolute right-full mr-2 w-72 p-2.5 transition-[top] duration-100 ease-out"
      :style="{ top: `${previewTop}px`, transform: 'translateY(-50%)' }"
    >
      <div class="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-400">
        <AppIcon name="send" :size="11" />
        <span>{{ preview.label }}</span>
        <span v-if="preview.images > 0" class="ml-auto">🖼 {{ preview.images }}</span>
      </div>
      <p v-if="preview.preview !== ''" class="line-clamp-6 text-[12px] leading-relaxed whitespace-pre-wrap break-words">
        {{ preview.preview }}
      </p>
      <p v-else class="text-[12px] text-zinc-400 italic">（仅图片）</p>
    </div>
  </div>
</template>
