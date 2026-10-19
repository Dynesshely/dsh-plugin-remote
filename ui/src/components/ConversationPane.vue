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
import GLightbox from 'glightbox'
import { setScrollRoot } from '../lib/lazy-render.js'
import 'glightbox/dist/css/glightbox.min.css'

/**
 * Click any picture in the transcript to enlarge it.
 *
 * Delegated from the document rather than bound per image: pictures arrive with every streaming message,
 * and a listener per element would have to be re-attached on each of them. Guarded by a window flag so a
 * remount cannot stack duplicates.
 */
if (typeof window !== 'undefined' && window.__rcFancyboxBound !== true) {
  window.__rcFancyboxBound = true
  document.addEventListener('click', (event) => {
    const target = event.target
    // `.transcript` covers the conversation; `[data-zoom]` covers the composer's staged attachments, which
    // sit outside it. Anything else — the brand mark, icons — is left alone.
    if (!(target instanceof HTMLImageElement) || target.closest('.transcript, [data-zoom]') === null) return
    event.preventDefault()
    // One instance per open, destroyed on close: pictures arrive continuously and an instance held open
    // would keep a stale element list.
    const box = GLightbox({
      elements: [{ href: target.currentSrc === '' ? target.src : target.currentSrc, type: 'image', title: target.alt }],
    })
    box.on('close', () => box.destroy())
    box.open()
  })
}

/** Settings sheet: a centred modal opened from the header. */
const settingsOpen = ref(false)
/** Dense transcript, remembered locally because it is a reading preference, not Host state. */
const dense = ref(window.localStorage.getItem('rc.dense') === '1')

watch(dense, (value) => {
  try {
    window.localStorage.setItem('rc.dense', value ? '1' : '0')
  } catch {
    /* a blocked storage keeps the in-memory value */
  }
})

/** Usage configuration being edited, loaded when the sheet opens. */
const usageDraft = ref([])
/** The aggregated gateway source, edited alongside the direct providers. */
const usageGateway = ref({ url: '', enabled: true, hasKey: false, hint: '', resolvedFrom: '', resolvedHint: '', key: '' })
const usageSaving = ref(false)
const usageSaved = ref('')

/** Load the usage providers, which arrive with keys reduced to a hint. */
async function loadUsageConfig () {
  try {
    const payload = await api('/api/usage/config')
    usageGateway.value = {
      url: String(payload.gateway?.url ?? ''),
      enabled: payload.gateway?.enabled !== false,
      hasKey: payload.gateway?.hasKey === true,
      hint: String(payload.gateway?.hint ?? ''),
      resolvedFrom: String(payload.gateway?.resolvedFrom ?? ''),
      resolvedHint: String(payload.gateway?.resolvedHint ?? ''),
      key: '',
    }
    usageDraft.value = (payload.providers ?? []).map((provider) => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      url: provider.url,
      enabled: provider.enabled === true,
      hasKey: provider.hasKey === true,
      hint: provider.hint ?? '',
      key: '',
    }))
  } catch (error) {
    state.actionError = String(error.message ?? error)
  }
}

/** Save the usage providers. A blank key field keeps whatever the Host already stores. */
async function saveUsageConfig () {
  usageSaving.value = true
  usageSaved.value = ''
  try {
    await api('/api/usage/config', {
      method: 'POST',
      body: {
        gateway: {
          url: usageGateway.value.url,
          enabled: usageGateway.value.enabled,
          // Omitted when untouched, which is what "keep the stored key" means.
          ...(usageGateway.value.key === '' ? {} : { key: usageGateway.value.key }),
        },
        providers: usageDraft.value.map((provider) => ({
          id: provider.id,
          label: provider.label,
          url: provider.url,
          enabled: provider.enabled,
          // Omitted entirely when untouched, which is what "keep the stored key" means.
          ...(provider.key === '' ? {} : { key: provider.key }),
        })),
      },
    })
    usageSaved.value = '已保存'
    await loadUsageConfig()
  } catch (error) {
    state.actionError = String(error.message ?? error)
  } finally {
    usageSaving.value = false
  }
}

watch(settingsOpen, (open) => {
  if (open) {
    usageSaved.value = ''
    void loadUsageConfig()
  }
})

const props = defineProps({ theme: { type: String, default: 'system' } })
const emit = defineEmits(['toggleSidebar', 'update:theme'])

const scroller = ref(null)

// The transcript rows correct the scroll offset for their own height changes, so they need to know what
// scrolls them.
watch(scroller, (element) => setScrollRoot(element), { immediate: true })
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

/**
 * The prompt the current run is working on: the last user row while the turn is running, which is the
 * one the animated ring marks. Empty when nothing is running.
 */
const activePromptKey = computed(() => {
  if (state.telemetry.running !== true) return ''
  const last = [...transcriptItems.value].reverse().find((item) => item.kind === 'user')
  return last?.key ?? ''
})

/** @returns the transcript item element for one key, if it is rendered. */
function itemElement (key) {
  const node = scroller.value
  if (node === null) return null
  return node.querySelector(`[data-item-key="${CSS.escape(key)}"]`)
}

let syncFrame

/**
 * Recompute which prompt is being read, at most once per frame.
 *
 * This walks every prompt, so running it per scroll event means several DOM queries and a forced layout
 * for each one — which is what made scrolling stutter. One run per frame is indistinguishable to the
 * reader and costs a fraction as much.
 */
function schedulePromptSync () {
  if (syncFrame !== undefined) return
  syncFrame = window.requestAnimationFrame(() => {
    syncFrame = undefined
    syncActivePrompt()
  })
}

/** Recompute which prompt is being read. */
function syncActivePrompt () {
  const node = scroller.value
  if (node === null) return
  const box = node.getBoundingClientRect()
  // One pass over the document instead of one query per prompt: the queries were the expensive half.
  const elements = new Map()
  for (const element of node.querySelectorAll('[data-item-key]')) {
    const key = element.dataset.itemKey
    if (key !== undefined) elements.set(key, element)
  }
  const tops = prompts.value.map((tick) => {
    const element = elements.get(tick.key)
    if (element === undefined) return Number.POSITIVE_INFINITY
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
  schedulePromptSync()
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
      <!-- Run state lives here: the dot was already in this header, so the status strip below the
           composer no longer repeats it — it only gains the word while a turn is actually running. -->
      <span
        class="flex shrink-0 items-center gap-1.5"
        :class="state.telemetry.running ? 'text-emerald-600 dark:text-emerald-400' : ''"
        :title="state.telemetry.running ? '正在运行' : '空闲'"
      >
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          :class="state.telemetry.running ? 'bg-emerald-500 pulse' : 'bg-zinc-300 dark:bg-zinc-600'"
        />
        <span v-if="state.telemetry.running" class="text-[11px] font-medium">运行中</span>
      </span>
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
      <button class="icon-btn" type="button" title="设置" @click="settingsOpen = true">
        <AppIcon name="gear" :size="15" />
      </button>
      <button class="icon-btn" type="button" title="刷新会话列表" @click="loadState()">
        <AppIcon name="refresh" :size="15" />
      </button>
    </header>

    <!-- Settings: a centred modal, teleported so no ancestor can clip it. -->
    <Teleport to="body">
      <div
        v-if="settingsOpen"
        class="fixed inset-0 z-[126] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
        @click.self="settingsOpen = false"
      >
        <div class="panel pop max-h-[80dvh] w-full max-w-md overflow-y-auto p-4">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-sm font-medium">设置</h2>
            <button class="icon-btn h-7 w-7" type="button" title="关闭" @click="settingsOpen = false">
              <AppIcon name="close" :size="13" />
            </button>
          </div>

          <p class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400">外观</p>
          <div class="mb-3 flex items-center justify-between gap-3">
            <span class="text-[13px]">主题</span>
            <ComboBox
              :model-value="theme"
              :items="THEMES"
              icon="monitor"
              align="right"
              width="max-w-[9rem]"
              @update:model-value="emit('update:theme', $event)"
            />
          </div>
          <label class="mb-3 flex items-center justify-between gap-3 text-[13px]">
            <span>紧凑消息间距</span>
            <input v-model="dense" type="checkbox" class="h-3.5 w-3.5" />
          </label>

          <p class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400">连接</p>
          <dl class="mb-3 space-y-1 text-[12px] text-zinc-500 dark:text-zinc-400">
            <div class="flex justify-between gap-3">
              <dt>监听</dt>
              <dd class="truncate">{{ state.bind || '—' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt>流状态</dt>
              <dd>{{ state.streamError ? state.streamError : '已连接' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt>会话</dt>
              <dd class="truncate">{{ state.selected ?? '—' }}</dd>
            </div>
          </dl>

          <p class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400">用量与余额</p>
          <p class="mb-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            由宿主代为请求（浏览器受同源策略限制），密钥只存在宿主侧（<code class="font-mono">~/.dsh/remote-control/usage.json</code>，权限 0600），页面只会看到掩码。
          </p>
          <div class="mb-2 rounded-xl border border-sky-300/50 bg-sky-50/40 p-2 dark:border-sky-400/20 dark:bg-sky-500/[0.06]">
            <div class="mb-1.5 flex items-center gap-2">
              <input v-model="usageGateway.enabled" type="checkbox" class="h-3.5 w-3.5" />
              <span class="text-[13px]">网关聚合（推荐）</span>
              <span class="ml-auto text-[10px] text-zinc-400">
                {{ usageGateway.resolvedFrom === 'dsh' ? '密钥取自 DSH 凭据 ' + usageGateway.resolvedHint
                  : usageGateway.resolvedFrom === 'config' ? '密钥来自此处设置'
                    : '未找到密钥' }}
              </span>
            </div>
            <input v-model="usageGateway.url" class="field mb-1.5 py-1 text-[12px]" placeholder="聚合用量接口地址" />
            <input
              v-model="usageGateway.key"
              type="password"
              class="field py-1 text-[12px]"
              placeholder="留空则使用 DSH 中 PORTARA_AI_GATEWAY_API_KEY"
            />
            <p class="mt-1.5 text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              网关会代查各家余额与用量，并把它代理过的模型的实际用量一并汇总，因此这里只需一个地址。
            </p>
          </div>
          <p class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400">直连（网关关闭时使用）</p>
          <div v-for="provider in usageDraft" :key="provider.id" class="mb-2 rounded-xl border border-white/50 p-2 dark:border-white/10">
            <div class="mb-1.5 flex items-center gap-2">
              <input v-model="provider.enabled" type="checkbox" class="h-3.5 w-3.5" />
              <span class="text-[13px]">{{ provider.label }}</span>
              <span class="ml-auto text-[10px] text-zinc-400">
                {{ provider.hasKey ? `已存密钥 ${provider.hint}` : '未设置密钥' }}
              </span>
            </div>
            <input v-model="provider.url" class="field mb-1.5 py-1 text-[12px]" placeholder="用量接口地址，例如 https://…/user/balance" />
            <input
              v-model="provider.key"
              type="password"
              class="field py-1 text-[12px]"
              :placeholder="provider.hasKey ? '留空则保持现有密钥' : 'API Key'"
            />
          </div>
          <div class="mb-3 flex items-center gap-2">
            <button class="btn" type="button" :disabled="usageSaving" @click="saveUsageConfig">
              {{ usageSaving ? '保存中…' : '保存用量设置' }}
            </button>
            <span v-if="usageSaved !== ''" class="text-[11px] text-emerald-600 dark:text-emerald-400">{{ usageSaved }}</span>
          </div>

          <p class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400">DSH</p>
          <p class="mb-3 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            重启与退出在左侧 DSH 菜单里（点击侧栏顶部的图标）。它们由一个独立进程完成，因为退出会连同本页面所依赖的宿主一起结束。
          </p>

          <p class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400">关于</p>
          <p class="text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            远程遥控插件 v1.0.0 · 页面与宿主同源、由令牌保护。更多设置项待定，这里先放上已经可用的部分。
          </p>
        </div>
      </div>
    </Teleport>

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
        <div class="transcript mx-auto flex max-w-3xl flex-col"
      :class="dense ? 'gap-2' : 'gap-4'">
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
          <!-- Loading a Session looks like the shape of what is coming, rather than claiming the Session
               is empty while it is still being read. -->
          <div
            v-if="state.sessionLoading && transcriptItems.length === 0"
            class="flex flex-col gap-4"
            aria-busy="true"
            aria-live="polite"
          >
            <p class="flex items-center gap-2 text-[12px] text-zinc-400">
              <AppIcon name="refresh" :size="12" class="animate-spin" />
              <span>正在载入会话…</span>
            </p>
            <div class="card rc-skeleton animate-pulse space-y-2 p-3">
              <div class="h-2.5 w-2/3 rounded-full bg-black/10 dark:bg-white/10" />
              <div class="h-2.5 w-5/6 rounded-full bg-black/10 dark:bg-white/10" />
              <div class="h-2.5 w-1/3 rounded-full bg-black/10 dark:bg-white/10" />
            </div>
            <div class="flex justify-end">
              <div class="prompt-glass rc-skeleton animate-pulse w-1/2 space-y-2 px-4 py-2.5">
                <div class="h-2.5 w-3/4 rounded-full bg-black/10 dark:bg-white/10" />
                <div class="h-2.5 w-1/2 rounded-full bg-black/10 dark:bg-white/10" />
              </div>
            </div>
          </div>
          <!-- Events that fold into nothing is a different situation from an empty Session, and saying
               which one it is saves a lot of guessing. -->
          <p
            v-else-if="transcriptItems.length === 0 && state.events.length > 0 && !state.live.text"
            class="px-6 py-16 text-center text-sm text-amber-600 dark:text-amber-300"
          >
            已载入 {{ state.events.length }} 条事件，但没有可显示的内容（可能是解析异常）。
          </p>
          <p
            v-else-if="transcriptItems.length === 0 && !state.live.text"
            class="py-16 text-center text-sm text-zinc-400"
          >
            {{ state.selected === undefined ? '从左侧选择一个会话' : '这个会话还没有消息' }}
          </p>
          <div v-for="item in transcriptItems" :key="item.key" :data-item-key="item.key">
            <!-- The prompt the run is currently working on gets the animated iridescent ring. -->
            <MessageRow :item="item" :active="item.key === activePromptKey" />
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
