<script setup>
import { computed, ref } from 'vue'
import { groupedSessions, selectSession, state } from '../lib/store.js'
import AppIcon from './AppIcon.vue'

const emit = defineEmits(['select', 'close'])

const COLLAPSE_KEY = 'rc.collapsed'
const query = ref('')

/** Collapsed workspace ids, stored as a plain array so a malformed value can never break setup. */
function readCollapsed () {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

const collapsed = ref(readCollapsed())

/** @returns whether the workspace's Session list is folded away. */
function isCollapsed (id) {
  return collapsed.value.includes(id)
}

function toggle (id) {
  collapsed.value = isCollapsed(id)
    ? collapsed.value.filter((candidate) => candidate !== id)
    : [...collapsed.value, id]
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed.value))
  } catch {
    /* a full or blocked storage keeps the in-memory state */
  }
}

/** Workspace groups filtered by the search box, with empty groups dropped while searching. */
const groups = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (needle === '') return groupedSessions.value
  return groupedSessions.value
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) =>
        `${session.title ?? ''} ${session.id}`.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.sessions.length > 0)
})

function open (id) {
  void selectSession(id)
  emit('select')
}

/** @returns a coarse "how long ago" label for a Session row. */
function ago (updatedAt) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return ''
  const minutes = Math.floor((Date.now() - updatedAt) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 px-3 py-3">
      <!-- Brand tile: a rounded rectangle whose 10px radius reads as the sidebar's own 18px corner
           at this size. The source icon ships its own rounded-square backdrop, so the image is
           scaled up inside the clipped tile to cut that backdrop away. -->
      <span class="brand-tile h-8 w-8">
        <img src="/app-icon.png" alt="" class="h-full w-full scale-125 object-cover" />
      </span>
      <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide">DSH REMOTE</span>
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="state.streamError ? 'bg-amber-400 pulse' : 'bg-emerald-500'"
        :title="state.streamError || '已连接'"
      />
      <button class="icon-btn h-7 w-7" type="button" title="收起侧栏" @click="emit('close')">
        <AppIcon name="close" :size="13" />
      </button>
    </div>

    <div class="px-3 pb-2">
      <div class="relative">
        <AppIcon name="search" :size="14" class="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-zinc-400" />
        <input v-model="query" class="field pl-9" placeholder="搜索会话" />
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div v-for="group in groups" :key="group.id" class="mt-2 first:mt-0">
        <!-- Workspace level: bigger, bolder, clearly the parent of the rows below. -->
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/50 dark:hover:bg-white/[0.06]"
          :aria-expanded="!isCollapsed(group.id)"
          @click="toggle(group.id)"
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-white/80 to-white/40 text-zinc-500 shadow-[0_2px_8px_-6px_rgb(15_23_42/0.6)] dark:from-white/[0.14] dark:to-white/[0.06] dark:text-zinc-300">
            <AppIcon name="layers" :size="13" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px] font-semibold text-zinc-700 dark:text-zinc-100">
              {{ group.title || group.path || '工作区' }}
            </span>
            <span v-if="group.path" class="block truncate text-[10px] font-normal text-zinc-400">
              {{ group.path }}
            </span>
          </span>
          <span class="shrink-0 rounded-full bg-white/60 px-1.5 text-[10px] text-zinc-500 dark:bg-white/10 dark:text-zinc-400">
            {{ group.sessions.length }}
          </span>
          <AppIcon
            name="chevron"
            :size="13"
            class="shrink-0 text-zinc-400 transition-transform duration-200"
            :class="isCollapsed(group.id) ? '-rotate-90' : ''"
          />
        </button>

        <!-- Session level: indented behind a guide line so the hierarchy reads at a glance. -->
        <div
          v-if="!isCollapsed(group.id)"
          class="mt-1 ml-[1.15rem] space-y-0.5 border-l border-zinc-900/10 pl-2.5 dark:border-white/10"
        >
          <button
            v-for="session in group.sessions"
            :key="session.id"
            type="button"
            class="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[13px] transition-all duration-200"
            :class="session.id === state.selected
              ? 'bg-white/80 shadow-[0_4px_16px_-10px_rgb(15_23_42/0.5)] dark:bg-white/[0.12]'
              : 'hover:bg-white/50 dark:hover:bg-white/[0.06]'"
            @click="open(session.id)"
          >
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              :class="session.running ? 'bg-emerald-500 pulse' : session.origin === 'subagent' ? 'bg-violet-400' : 'bg-zinc-300 dark:bg-zinc-600'"
            />
            <span class="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">{{ session.title || session.id }}</span>
            <span class="shrink-0 text-[10px] text-zinc-400">{{ ago(session.updatedAt) }}</span>
          </button>
        </div>
      </div>
      <p v-if="groups.length === 0" class="px-3 py-6 text-center text-xs text-zinc-400">没有匹配的会话</p>
    </div>

    <div class="border-t border-white/50 px-3 py-2 dark:border-white/10">
      <p class="flex items-center gap-1.5 truncate text-[10px] text-zinc-400">
        <AppIcon name="shield" :size="11" />
        监听 {{ state.bind || '—' }}
      </p>
    </div>
  </div>
</template>
