<script setup>
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import FilePane from './FilePane.vue'

/**
 * The right sidebar, as a host for several containers.
 *
 * Opening it lists what can go there rather than guessing: the column is meant to hold more than the file
 * browser soon. Choosing one opens a tab; tabs can be added with `+` (which returns to the list) and
 * closed individually, so several containers can be switched between without reopening the column.
 */
const emit = defineEmits(['close'])

/** The containers this column can host. Adding one is a component plus an entry here. */
const CONTAINERS = [
  {
    id: 'files',
    name: '文件资源管理器',
    icon: 'folder',
    detail: '浏览工作区、管理文件、预览常见格式',
  },
]

/**
 * Open tabs, in the order they were opened.
 *
 * A tab is an *instance* of a container, not the container itself: opening the file browser twice gives
 * two tabs with their own directory and selection, which is the point of having tabs at all.
 */
const tabs = ref([])
/** The visible tab, by instance key. */
const active = ref(undefined)
/** Monotonic key source, so two tabs of one container stay distinct. */
let nextKey = 1
/** True while the container list is showing, either on first open or via the `+` button. */
const picking = ref(true)

/** @returns the container entry for an id. */
function containerOf (id) {
  return CONTAINERS.find((entry) => entry.id === id)
}

/** The visible tab, if any. */
const activeTab = computed(() => tabs.value.find((tab) => tab.key === active.value))

/** The tabs that still resolve to a container. */
const openTabs = computed(() => tabs.value.filter((tab) => containerOf(tab.containerId) !== undefined))

/**
 * @returns how many tabs of a container are open, used to number the labels.
 * @param containerId - the container.
 */
function countOf (containerId) {
  return tabs.value.filter((tab) => tab.containerId === containerId).length
}

/** Open a new tab for a container, every time. */
function choose (containerId) {
  const entry = containerOf(containerId)
  if (entry === undefined) return
  const key = `${containerId}-${String(nextKey)}`
  nextKey += 1
  const total = countOf(containerId) + 1
  tabs.value = [...tabs.value, { key, containerId, label: total > 1 ? `${entry.name} #${String(total)}` : entry.name }]
  active.value = key
  picking.value = false
}

/** Close one tab, falling back to a neighbour or to the list. */
function closeTab (key) {
  const remaining = tabs.value.filter((tab) => tab.key !== key)
  tabs.value = remaining
  if (active.value !== key) return
  active.value = remaining[remaining.length - 1]?.key
  picking.value = remaining.length === 0
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Picker: what this column can show, before committing to one. -->
    <template v-if="picking">
      <header class="flex shrink-0 items-center gap-1.5 px-1.5 pt-1 pb-2">
        <AppIcon name="sidebar" :size="13" class="shrink-0 text-zinc-400" />
        <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-600 dark:text-zinc-300">可用容器</span>
        <button class="icon-btn h-7 w-7 shrink-0" type="button" title="关闭" @click="emit('close')">
          <AppIcon name="close" :size="13" />
        </button>
      </header>
      <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1.5 pb-2">
        <button
          v-for="entry in CONTAINERS"
          :key="entry.id"
          type="button"
          class="flex w-full items-start gap-2 rounded-xl border border-white/50 px-2 py-2 text-left transition-colors hover:bg-white/60 dark:border-white/10 dark:hover:bg-white/[0.08]"
          @click="choose(entry.id)"
        >
          <AppIcon :name="entry.icon" :size="14" class="mt-0.5 shrink-0 text-blue-500/80" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12px] text-zinc-700 dark:text-zinc-200">{{ entry.name }}</span>
            <span class="mt-0.5 block text-[10px] leading-relaxed text-zinc-400">{{ entry.detail }}</span>
          </span>
          <AppIcon name="chevronRight" :size="11" class="mt-1 shrink-0 opacity-50" />
        </button>
      </div>
    </template>

    <template v-else>
      <!-- Tabs: one per open container, a `+` to add another, and the column's close button. -->
      <header class="flex shrink-0 items-center gap-1 px-1.5 pt-1 pb-1.5">
        <div class="min-w-0 flex-1 overflow-x-auto">
          <div class="flex w-max items-center gap-1">
            <div
              v-for="tab in openTabs"
              :key="tab.key"
              class="flex shrink-0 items-center rounded-full transition-colors"
              :class="active === tab.key
                ? 'bg-blue-500 text-white'
                : 'bg-white/60 text-zinc-500 dark:bg-white/10 dark:text-zinc-300'"
            >
              <button
                type="button"
                class="flex items-center gap-1 py-1 pr-1 pl-2 text-[11px]"
                @click="active = tab.key"
              >
                <AppIcon :name="containerOf(tab.containerId).icon" :size="11" />
                <span class="max-w-[6.5rem] truncate">{{ tab.label }}</span>
              </button>
              <button
                type="button"
                class="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors"
                :class="active === tab.key ? 'hover:bg-white/25' : 'hover:bg-black/10 dark:hover:bg-white/15'"
                :title="`关闭 ${tab.label}`"
                @click.stop="closeTab(tab.key)"
              >
                <AppIcon name="close" :size="9" />
              </button>
            </div>
          </div>
        </div>
        <button class="icon-btn h-7 w-7 shrink-0" type="button" title="新增标签页" @click="picking = true">
          <AppIcon name="plus" :size="13" />
        </button>
        <button class="icon-btn h-7 w-7 shrink-0" type="button" title="关闭" @click="emit('close')">
          <AppIcon name="close" :size="13" />
        </button>
      </header>

      <!--
        Only the active tab renders; the rest are kept alive, so switching back keeps their directory and
        selection without every open tab re-rendering on each interaction.
      -->
      <div class="min-h-0 flex-1">
        <KeepAlive>
          <FilePane v-if="activeTab?.containerId === 'files'" :key="activeTab.key" />
        </KeepAlive>
      </div>
    </template>
  </div>
</template>
