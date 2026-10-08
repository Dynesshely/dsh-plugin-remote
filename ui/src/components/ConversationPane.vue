<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { loadModels, loadOlder, loadPermissions, loadState, selectedSession, state, transcriptItems } from '../lib/store.js'
import { mobile } from '../lib/layout.js'
import { activeTick, promptTicks } from '../lib/rail.js'
import { renderMarkdown } from '../lib/markdown.js'
import MessageRow from './MessageRow.vue'
import ComposerBar from './ComposerBar.vue'
import PendingPanel from './PendingPanel.vue'
import PromptRail from './PromptRail.vue'
import ComboBox from './ComboBox.vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({ theme: { type: String, default: 'system' } })
const emit = defineEmits(['toggleSidebar', 'update:theme'])

const scroller = ref(null)
const sticky = ref(true)
const showLiveReasoning = ref(false)
/** Index of the prompt currently being read, for the rail's active tick. */
const activePrompt = ref(-1)

/** Theme choices for the self-drawn combobox in the top bar. */
const THEMES = [
  { value: 'system', name: '跟随系统', icon: 'monitor' },
  { value: 'light', name: '浅色', icon: 'sun' },
  { value: 'dark', name: '深色', icon: 'moon' },
]

/** One rail tick per user prompt. */
const prompts = computed(() => promptTicks(transcriptItems.value))

/** @returns the transcript item element for one key, if it is rendered. */
function itemElement (key) {
  const node = scroller.value
  if (node === null) return null
  return node.querySelector(`[data-item-key="${CSS.escape(key)}"]`)
}

/** Recompute which prompt is being read. */
function syncActivePrompt () {
  const node = scroller.value
  if (node === null) return
  const box = node.getBoundingClientRect()
  const tops = prompts.value.map((tick) => {
    const element = itemElement(tick.key)
    if (element === null) return Number.POSITIVE_INFINITY
    return element.getBoundingClientRect().top - box.top + node.scrollTop
  })
  // The last prompt is the one being read once the transcript is scrolled to its end.
  const bottomGap = node.scrollHeight - node.scrollTop - node.clientHeight
  activePrompt.value = activeTick(tops, node.scrollTop, 80, bottomGap)
}

/** Scroll one prompt to the top of the transcript. */
function jumpToPrompt (key) {
  const node = scroller.value
  const target = itemElement(key)
  if (node === null || target === null) return
  sticky.value = false
  const top = target.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - 12
  node.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' })
  activePrompt.value = prompts.value.findIndex((tick) => tick.key === key)
}

/** Page one screen of older history in, keeping the reader's place (the content grows above them). */
async function loadEarlier () {
  const node = scroller.value
  const heightBefore = node?.scrollHeight ?? 0
  const topBefore = node?.scrollTop ?? 0
  sticky.value = false
  await loadOlder()
  await nextTick()
  if (node !== null) node.scrollTop = topBefore + (node.scrollHeight - heightBefore)
}

/** Jump to the newest content only while the reader is already at the bottom. */
function onScroll () {
  const node = scroller.value
  if (node === null) return
  sticky.value = node.scrollHeight - node.scrollTop - node.clientHeight < 60
  syncActivePrompt()
}

watch([() => transcriptItems.value.length, () => state.selected], async () => {
  await nextTick()
  syncActivePrompt()
})

watch([() => transcriptItems.value.length, () => state.live.text], async () => {
  if (!sticky.value) return
  await nextTick()
  const node = scroller.value
  if (node !== null) node.scrollTop = node.scrollHeight
})

watch(() => state.selected, async () => {
  showLiveReasoning.value = false
  await Promise.all([loadPermissions(state.selected), loadModels()])
})

/** Live output rendered as markdown, throttled so a fast stream does not re-parse every token. */
const liveHtml = ref('')
const liveReasoningHtml = ref('')
let liveTimer
let liveReasoningTimer

watch(() => state.live.text, (text) => {
  if (text === '') {
    liveHtml.value = ''
    return
  }
  if (liveTimer !== undefined) return
  liveTimer = window.setTimeout(() => {
    liveTimer = undefined
    liveHtml.value = renderMarkdown(state.live.text)
  }, 140)
})

// The live reasoning chain is markdown as well, with the same throttle.
watch(() => state.live.reasoning, (text) => {
  if (text === '') {
    liveReasoningHtml.value = ''
    return
  }
  if (liveReasoningTimer !== undefined) return
  liveReasoningTimer = window.setTimeout(() => {
    liveReasoningTimer = undefined
    liveReasoningHtml.value = renderMarkdown(state.live.reasoning)
  }, 140)
})

onBeforeUnmount(() => {
  if (liveTimer !== undefined) window.clearTimeout(liveTimer)
})
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <header class="z-10 m-2 mb-0 flex items-center gap-2 rounded-[18px] border border-white/50 bg-white/25 px-2.5 py-2 dark:border-white/10 dark:bg-white/[0.03]">
      <button class="icon-btn" type="button" title="展开/收起侧栏" @click="emit('toggleSidebar')">
        <AppIcon name="menu" :size="16" />
      </button>
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="state.telemetry.running ? 'bg-emerald-500 pulse' : 'bg-zinc-300 dark:bg-zinc-600'"
      />
      <h1 class="min-w-0 flex-1 truncate text-sm font-medium">
        {{ selectedSession?.title ?? '未选择会话' }}
      </h1>
      <ComboBox
        :model-value="theme"
        :items="THEMES"
        icon="monitor"
        align="right"
        :width="mobile ? 'w-12 justify-center gap-1 px-1.5' : 'max-w-[8.5rem]'"
        :label-class="mobile ? 'hidden' : ''"
        @update:model-value="emit('update:theme', $event)"
      />
      <button class="icon-btn" type="button" title="刷新会话列表" @click="loadState()">
        <AppIcon name="refresh" :size="15" />
      </button>
    </header>

    <p
      v-if="state.streamError"
      class="mx-2 mt-2 rounded-xl border border-amber-300/60 bg-amber-100/70 px-3 py-1 text-[12px] text-amber-800 backdrop-blur-xl dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-200"
    >
      {{ state.streamError }}
    </p>

    <div class="relative min-h-0 flex-1">
      <div
        ref="scroller"
        class="h-full overflow-y-auto py-4"
        :class="mobile ? 'px-3' : 'pl-3 pr-8'"
        @scroll="onScroll"
      >
        <div class="mx-auto flex max-w-3xl flex-col gap-4">
          <!-- The opening window is bounded, so a long Session pages backwards from here. -->
          <div v-if="state.hasOlder && transcriptItems.length > 0" class="flex justify-center">
            <button class="chip" type="button" :disabled="state.loadingOlder" @click="loadEarlier">
              <AppIcon
                :name="state.loadingOlder ? 'refresh' : 'chevron'"
                :size="12"
                :class="state.loadingOlder ? 'animate-spin' : 'rotate-90'"
              />
              <span>{{ state.loadingOlder ? '加载中…' : '加载更早的消息' }}</span>
            </button>
          </div>
          <p v-if="transcriptItems.length === 0 && !state.live.text" class="py-16 text-center text-sm text-zinc-400">
            {{ state.selected === undefined ? '从左侧选择一个会话' : '这个会话还没有消息' }}
          </p>
          <div v-for="item in transcriptItems" :key="item.key" :data-item-key="item.key">
            <MessageRow :item="item" />
          </div>

          <!-- live attempt: reasoning stays collapsed, the answer streams in place -->
          <div v-if="state.live.text || state.live.reasoning" class="rise">
            <div v-if="state.live.reasoning" class="mb-2">
              <button
                type="button"
                class="chip"
                :class="{ 'chip-strong': showLiveReasoning }"
                @click="showLiveReasoning = !showLiveReasoning"
              >
                <AppIcon name="brain" :size="13" />
                <span>思维链</span>
                <span class="opacity-60">{{ state.live.reasoning.length }} 字 · 生成中</span>
                <AppIcon name="chevron" :size="11" :class="showLiveReasoning ? 'rotate-180' : ''" class="transition-transform" />
              </button>
              <div
                v-if="showLiveReasoning"
                class="card pop mt-2 border-dashed px-3 py-2"
              >
                <div class="md break-words text-[13px] text-zinc-500 dark:text-zinc-400" v-html="liveReasoningHtml" />
              </div>
            </div>
            <div class="md break-words" v-html="liveHtml" />
            <span class="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-blue-500 align-middle" />
          </div>
        </div>
      </div>

      <!-- Prompt navigator: hover previews a prompt, click jumps to it. -->
      <PromptRail
        v-if="!mobile"
        :ticks="prompts"
        :active="activePrompt"
        class="absolute inset-y-4 right-2.5"
        @jump="jumpToPrompt"
      />
    </div>

    <PendingPanel />
    <ComposerBar />
  </section>
</template>
