<script setup>
import { computed } from 'vue'
import { state } from '../lib/store.js'
import AppIcon from './AppIcon.vue'

/** Compact number formatting: 1234 → 1.2k, 1234567 → 1.2M. */
function compact (value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return '0'
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}k`
  return String(Math.round(number))
}

const telemetry = computed(() => state.telemetry)

/** Cached share of the total input, which is what "cache hit" means here. */
const cacheRate = computed(() => {
  const total = telemetry.value.totalCacheRead + telemetry.value.totalInput
  return total === 0 ? 0 : (telemetry.value.totalCacheRead / total) * 100
})

/** Context occupancy of the newest request against the model's window. */
const occupancy = computed(() => {
  const window = telemetry.value.contextWindow
  if (!Number.isFinite(window) || window <= 0) return undefined
  return Math.min(100, (telemetry.value.lastInput / window) * 100)
})

/** Ring geometry for the self-drawn occupancy meter. */
const RING = 2 * Math.PI * 11
const ringOffset = computed(() => RING * (1 - (occupancy.value ?? 0) / 100))
const ringTone = computed(() => {
  const value = occupancy.value ?? 0
  if (value > 85) return 'stroke-rose-500'
  if (value > 60) return 'stroke-amber-400'
  return 'stroke-blue-500'
})
</script>

<template>
  <!-- One line, exact toolbar height, horizontally scrollable rather than wrapping. The run state
       itself lives in the conversation header, so this row only carries measurements. -->
  <div class="glass-soft no-scrollbar flex h-9 items-center gap-x-3 overflow-x-auto rounded-xl px-3 text-[11px] whitespace-nowrap text-zinc-500 dark:text-zinc-400">

    <span
      v-if="occupancy !== undefined"
      class="flex shrink-0 items-center gap-1.5"
      :title="`上下文占用 ${compact(telemetry.lastInput)} / ${compact(telemetry.contextWindow)}`"
    >
      <svg width="20" height="20" viewBox="0 0 28 28">
        <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" stroke-width="3" class="opacity-20" />
        <circle
          cx="14"
          cy="14"
          r="11"
          fill="none"
          stroke-width="3"
          stroke-linecap="round"
          :stroke-dasharray="RING"
          :stroke-dashoffset="ringOffset"
          :class="ringTone"
          transform="rotate(-90 14 14)"
        />
      </svg>
      {{ occupancy.toFixed(0) }}%
    </span>

    <span class="flex shrink-0 items-center gap-1" title="本步生成速度">
      <AppIcon name="clock" :size="12" />{{ telemetry.tokensPerSecond > 0 ? telemetry.tokensPerSecond.toFixed(1) : '—' }} tok/s
    </span>

    <!-- Secondary metrics appear as the row gets room. -->
    <span v-if="telemetry.turn > 0" class="hidden shrink-0 items-center gap-1 sm:flex">
      <AppIcon name="layers" :size="12" />{{ telemetry.turn }}–{{ telemetry.step }}
    </span>
    <span class="hidden shrink-0 items-center gap-1 sm:flex" title="输入 / 输出 tokens">
      ↑{{ compact(telemetry.totalInput) }} ↓{{ compact(telemetry.totalOutput) }}
    </span>
    <span v-if="telemetry.model" class="hidden shrink-0 items-center gap-1 wide:flex">
      <AppIcon name="cpu" :size="12" /><span class="max-w-[9rem] truncate">{{ telemetry.model }}</span>
    </span>
    <span class="hidden shrink-0 items-center gap-1 wide:flex" title="缓存读取与命中率">
      <AppIcon name="spark" :size="12" />{{ compact(telemetry.totalCacheRead) }} · {{ cacheRate.toFixed(0) }}%
    </span>
    <span v-if="telemetry.totalReasoning > 0" class="hidden shrink-0 items-center gap-1 wide:flex" title="推理 tokens">
      <AppIcon name="brain" :size="12" />{{ compact(telemetry.totalReasoning) }}
    </span>
  </div>
</template>
