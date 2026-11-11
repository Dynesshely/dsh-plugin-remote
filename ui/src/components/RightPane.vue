<script setup>
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import FilePane from './FilePane.vue'

/**
 * The right sidebar, as a host for several containers.
 *
 * Every tab is a real tab from the start: the column opens with one blank tab whose body is the container
 * picker, so choosing a tool is a step inside the tab rather than a separate mode the column has to be in.
 * That keeps the tab strip meaningful at all times — there is never a state with zero tabs, and `+` always
 * means "another blank tab" instead of "leave whatever I was doing".
 */
const emit = defineEmits(['close'])

/** The containers a tab can host. Adding one is a component plus an entry here. */
const CONTAINERS = [
  {
    id: 'files',
    name: '文件资源管理器',
    icon: 'folder',
    detail: '浏览工作区、管理文件、预览常见格式',
  },
]

/** Montecito key source, so two tabs of one container stay distinct. */
let nextKey = 1

/** A blank tab: no container yet, its body is the picker. */
function blankTab () {
  const key = `blank-${String(nextKey)}`
  nextKey += 1
  return { key, containerId: undefined, label: '新标签页' }
}

/** Open tabs, in the order they were opened. Always at least one. */
const tabs = ref([blankTab()])
/** The visible tab, by instance key. */
const active = ref(tabs.value[0].key)

/** @returns the container entry for an id. */
function containerOf (id) {
  return CONTAINERS.find((entry) => entry.id === id)
}

/** The visible tab, if any. */
const activeTab = computed(() => tabs.value.find((tab) => tab.key === active.value))

/**
 * @returns how many tabs of a container are open, used to number the labels.
 * @param containerId - the container.
 */
function countOf (containerId) {
  return tabs.value.filter((tab) => tab.containerId === containerId).length
}

/**
 * Put a container into a tab.
 * @param tab - the tab to fill (usually the visible blank one).
 * @param containerId - which container.
 */
function fill (tab, containerId) {
  const entry = containerOf(containerId)
  if (entry === undefined) return
  const total = countOf(containerId) + 1
  tabs.value = tabs.value.map((candidate) => (candidate.key === tab.key
    ? { ...candidate, containerId, label: total > 1 ? `${entry.name} #${String(total)}` : entry.name }
    : candidate))
}

/**
 * Empty a tab again, so the same tab can host something else.
 * @param key - the tab to reset.
 */
function resetTab (key) {
  tabs.value = tabs.value.map((candidate) => (candidate.key === key
    ? { ...candidate, containerId: undefined, label: '新标签页' }
    : candidate))
}

/** Add a blank tab and switch to it. */
function addTab () {
  const tab = blankTab()
  tabs.value = [...tabs.value, tab]
  active.value = tab.key
}

/**
 * Close one tab.
 * @param key - the tab to close.
 *
 * Closing the last one leaves a blank tab behind: a hosted column with no tabs would need a separate empty
 * state, and the empty state is already a tab.
 */
function closeTab (key) {
  const remaining = tabs.value.filter((tab) => tab.key !== key)
  if (remaining.length === 0) {
    const replacement = blankTab()
    tabs.value = [replacement]
    active.value = replacement.key
    return
  }
  tabs.value = remaining
  if (active.value === key) active.value = remaining[remaining.length - 1].key
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Tab strip: always present, so the column never switches between two different shapes. -->
    <header class="flex shrink-0 items-center gap-1 px-1.5 pt-1 pb-1.5">
      <div class="min-w-0 flex-1 overflow-x-auto">
        <div class="flex w-max items-center gap-1">
          <div
            v-for="tab in tabs"
            :key="tab.key"
            class="flex shrink-0 items-center rounded-full transition-colors"
            :class="active === tab.key
              ? 'bg-primary text-on-primary'
              : 'bg-fill-tint text-secondary-strong'"
          >
            <button
              type="button"
              class="flex items-center gap-1 py-1 pr-1 pl-2 text-[11px]"
              @click="active = tab.key"
            >
              <AppIcon :name="tab.containerId === undefined ? 'plus' : containerOf(tab.containerId).icon" :size="11" />
              <span class="max-w-[6.5rem] truncate">{{ tab.label }}</span>
            </button>
            <button
              type="button"
              class="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors"
              :class="active === tab.key ? 'hover:bg-white/25' : 'hover:bg-fill-chip'"
              :title="`关闭 ${tab.label}`"
              @click.stop="closeTab(tab.key)"
            >
              <AppIcon name="close" :size="9" />
            </button>
          </div>
        </div>
      </div>
      <button
        class="icon-btn h-7 w-7 shrink-0"
        type="button"
        title="换一个工具"
        :disabled="activeTab === undefined || activeTab.containerId === undefined"
        @click="activeTab !== undefined && resetTab(activeTab.key)"
      >
        <AppIcon name="refresh" :size="13" />
      </button>
      <button class="icon-btn h-7 w-7 shrink-0" type="button" title="新建标签页" @click="addTab">
        <AppIcon name="plus" :size="13" />
      </button>
      <button class="icon-btn h-7 w-7 shrink-0" type="button" title="关闭侧栏" @click="emit('close')">
        <AppIcon name="close" :size="13" />
      </button>
    </header>

    <!-- The blank tab's body: pick what this tab should show. -->
    <div
      v-if="activeTab !== undefined && activeTab.containerId === undefined"
      class="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-3 pb-2"
    >
      <p class="px-1 pb-2 text-center text-[11px] text-tertiary">选择要在此标签页中打开的工具</p>
      <!-- A card stops at a readable width instead of spanning a wide column edge to edge. -->
      <div class="w-full max-w-[19rem] space-y-1.5">
        <button
          v-for="entry in CONTAINERS"
          :key="entry.id"
          type="button"
          class="flex w-full items-start gap-2 rounded-xl border border-outline-variant px-2 py-2 text-left transition-colors hover:bg-fill-chip"
          @click="fill(activeTab, entry.id)"
        >
          <AppIcon :name="entry.icon" :size="14" class="mt-0.5 shrink-0 text-primary" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12px] text-strong">{{ entry.name }}</span>
            <span class="mt-0.5 block text-[10px] leading-relaxed text-tertiary">{{ entry.detail }}</span>
          </span>
          <AppIcon name="chevronRight" :size="11" class="mt-1 shrink-0 opacity-50" />
        </button>
      </div>
    </div>

    <!--
      A filled tab renders its container. Only the active one is mounted per tab; the rest stay alive, so
      switching back keeps their directory and selection without re-rendering on every interaction.
    -->
    <div v-else class="flex min-h-0 flex-1 flex-col">
      <div class="min-h-0 flex-1">
        <KeepAlive>
          <FilePane v-if="activeTab?.containerId === 'files'" :key="activeTab.key" />
        </KeepAlive>
      </div>
    </div>
  </div>
</template>
