<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../lib/api.js'
import AppIcon from './AppIcon.vue'

/**
 * Balance and usage for the configured providers, as a collapsible glass card.
 *
 * The Host does the fetching: provider APIs are cross-origin, and the page's CSP only allows same-origin
 * requests. It also means API keys live on the Host and never reach the browser.
 *
 * Items arrive structured, so the layout is chosen by shape: a provider with a balance becomes a tile in
 * the row, a provider with rolling windows becomes a small block of progress bars, and one with both gets
 * both. Facts that used to be text rows are drawn where they belong — the gateway's cache flag becomes an
 * icon on the tile, and a reset moment sits on the bar line it applies to.
 *
 * A provider the gateway could not read is dropped rather than explained: a row saying "this one failed"
 * is noise in a card whose whole job is to show numbers.
 */
const items = ref([])
/** Which source answered: the gateway, or the direct providers. */
const source = ref('')
const loading = ref(false)
const error = ref('')
/** Collapsed state is a reading preference, so it is remembered locally. */
const open = ref(window.localStorage.getItem('rc.usageOpen') !== '0')

/** @returns the providers worth drawing: readable, and with something to show. */
const visible = computed(() => items.value.filter((item) => item.ok !== false
  && ((item.balances?.length ?? 0) > 0 || (item.windows?.length ?? 0) > 0)))

/** Toggle the card and remember the choice. */
function toggle () {
  open.value = !open.value
  try {
    window.localStorage.setItem('rc.usageOpen', open.value ? '1' : '0')
  } catch {
    /* a blocked storage keeps the in-memory value */
  }
}

/** @returns a number as text, trimmed to what is worth reading. */
function short (value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return '0'
  if (Math.abs(number) >= 1000) return number.toFixed(1)
  return String(Math.round(number * 100) / 100)
}

/** @returns the tile's value text, unit included. */
function amount (balance) {
  const value = short(balance?.remaining)
  return balance?.unit === '' || balance?.unit === undefined ? value : `${value} ${String(balance.unit)}`
}

/** @returns the bar's tone, from how full the window is. */
function tone (window) {
  if (window.exceeded || window.ratio > 0.85) return 'bg-rose-500'
  if (window.ratio > 0.6) return 'bg-amber-400'
  return 'bg-blue-500'
}

/** @returns a window's numbers. */
function windowText (window) {
  return `${short(window.used)} / ${short(window.total)}`
}

/** @returns a reset moment as `MM-DD HH:mm`, when one is known. */
function resetText (value) {
  if (typeof value !== 'string' || value === '') return ''
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const pad = (number) => String(number).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** @returns the one-line summary shown while collapsed. */
function summary () {
  return visible.value
    .filter((item) => (item.balances?.length ?? 0) > 0)
    .map((item) => amount(item.balances[0]))
    .join(' · ')
}

/** Load every enabled provider at once. */
async function load () {
  loading.value = true
  error.value = ''
  try {
    const payload = await api('/api/usage')
    items.value = Array.isArray(payload.items) ? payload.items : []
    source.value = String(payload.source ?? '')
    if (payload.error !== undefined && payload.error !== null) error.value = String(payload.error)
  } catch (problem) {
    error.value = String(problem.message ?? problem)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <!-- A glass card of its own, inset from the sidebar edge rather than fused to its footer. -->
  <div class="card m-2 rounded-2xl p-2">
    <!-- One row, never wrapped: a squeezed header was the whole problem with the collapsed state. -->
    <button type="button" class="flex w-full flex-nowrap items-center gap-1.5 text-left" @click="toggle">
      <span
        class="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-white/50 text-zinc-500 transition-transform duration-200 dark:bg-white/10 dark:text-zinc-300"
        :class="open ? 'rotate-90' : ''"
      >
        <!-- Drawn here rather than borrowed: the affordance has to be big enough to read. -->
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
      <AppIcon name="spark" :size="11" class="shrink-0 text-zinc-400" />
      <span class="shrink-0 text-[11px] font-medium whitespace-nowrap text-zinc-500 dark:text-zinc-300">用量与余额</span>
      <span
        v-if="source === 'gateway'"
        class="shrink-0 rounded-full bg-white/60 px-1.5 py-px text-[9px] leading-none whitespace-nowrap text-zinc-500 dark:bg-white/10 dark:text-zinc-400"
      >
        网关
      </span>
      <span
        v-if="!open && summary() !== ''"
        class="ml-auto min-w-0 truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-400"
        :title="summary()"
      >
        {{ summary() }}
      </span>
      <span
        v-else-if="open"
        class="ml-auto shrink-0 text-[10px] text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-200"
        :class="loading ? 'opacity-40' : ''"
        title="刷新"
        @click.stop="load"
      >
        {{ loading ? '刷新中…' : '刷新' }}
      </span>
    </button>

    <div v-if="open" class="mt-2 border-t border-white/50 pt-2 dark:border-white/10">
      <p v-if="error !== ''" class="text-[10px] leading-relaxed text-rose-500">{{ error }}</p>

      <template v-else-if="visible.length > 0">
        <!-- Balances first, as one row of tiles: channel above, amount below. -->
        <div
          v-if="visible.some((item) => (item.balances?.length ?? 0) > 0)"
          class="flex flex-wrap gap-1.5"
          :class="visible.some((item) => (item.windows?.length ?? 0) > 0) ? 'mb-2' : ''"
        >
          <div
            v-for="item in visible.filter((entry) => (entry.balances?.length ?? 0) > 0)"
            :key="`tile-${item.id}`"
            class="usage-tile min-w-[6.5rem] flex-1 rounded-xl px-2 py-1.5"
          >
            <p class="flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
              <span class="truncate" :title="item.label">{{ item.label }}</span>
              <!-- The gateway serves cached numbers; an icon says so without taking a row. -->
              <AppIcon v-if="item.cached" name="clock" :size="9" class="shrink-0 opacity-60" title="网关缓存的数据" />
            </p>
            <p class="truncate font-mono text-[13px] text-zinc-700 dark:text-zinc-100">{{ amount(item.balances[0]) }}</p>
            <p v-if="item.balances.length > 1" class="truncate text-[9px] text-zinc-400">
              <span v-for="(balance, index) in item.balances.slice(1, 3)" :key="index">
                <template v-if="index > 0"> · </template>{{ amount(balance) }}
              </span>
            </p>
          </div>
        </div>

        <!-- Providers with rolling windows get bars, one per window. -->
        <div v-for="item in visible.filter((entry) => (entry.windows?.length ?? 0) > 0)" :key="`bars-${item.id}`">
          <p class="mb-1 truncate text-[10px] text-zinc-500 dark:text-zinc-400" :title="item.label">{{ item.label }}</p>
          <div v-for="window in item.windows" :key="window.key" class="mb-1.5 last:mb-0">
            <!-- Label, quota and reset moment all share the line above the bar. -->
            <div class="flex flex-nowrap items-baseline gap-1.5 text-[10px]">
              <span class="shrink-0 text-zinc-500 dark:text-zinc-400">{{ window.label }}</span>
              <span class="ml-auto shrink-0 font-mono text-zinc-600 dark:text-zinc-300">{{ windowText(window) }}</span>
              <span
                v-if="resetText(window.resetAt ?? item.resetAt) !== ''"
                class="shrink-0 text-[9px] text-zinc-400"
                :title="`${resetText(window.resetAt ?? item.resetAt)} 重置`"
              >
                · {{ resetText(window.resetAt ?? item.resetAt) }} 重置
              </span>
            </div>
            <div class="usage-bar mt-0.5 h-1 w-full overflow-hidden rounded-full">
              <div
                class="usage-bar-fill h-full rounded-full"
                :class="tone(window)"
                :style="{ width: `${String(Math.round(window.ratio * 100))}%` }"
              />
            </div>
          </div>
        </div>
      </template>

      <p v-else class="text-[10px] leading-relaxed text-zinc-400">网关未返回可用的余额。</p>
    </div>
  </div>
</template>
