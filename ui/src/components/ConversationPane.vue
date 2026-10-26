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
import { canCancel, canRetry, loadMessage, loadPhase, snapshotLine } from '../lib/loading.js'
import { cancelOlder, retrySession, setLightweight } from '../lib/store.js'
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

/** How the current Session load should read: skeleton, slow notice, or failure with a retry. */
const sessionPhase = computed(() => loadPhase(state.sessionLoading, state.sessionSlow, state.sessionFailed))
const sessionHint = computed(() => loadMessage(sessionPhase.value, '会话'))
/** Whether the snapshot notice should be on screen. */
const snapshotVisible = computed(() => state.snapshotFlash
  || (state.sessionLoading === true && state.snapshotProgress.loaded > 0))
/** What it says. */
const snapshotLabel = computed(() => snapshotLine(state.snapshotProgress, state.snapshotMs))
/** How full the progress bar is, in percent. */
const snapshotPercent = computed(() => {
  const count = state.snapshotProgress.count
  if (!(count > 0)) return 0
  return Math.min(100, Math.round(((state.snapshotProgress.index + 1) / count) * 100))
})

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
const emit = defineEmits(['toggleSidebar', 'toggleFiles', 'update:theme'])

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

/**
 * 贴到底部，只在内容真的变了之后调用。
 *
 * 读 `scrollHeight` 会强制一次同步布局；原来的 `watch` 里挂了 `state.live.text`，于是流式期间
 * 每来一个 token 就 nextTick + 强制布局一次，这是滚动发涩的直接来源。现在它跟着流式渲染的
 * 节流走（400ms 一次），频率降到不足原来的十分之一，读者看不出差别。
 */
async function scrollToBottomIfSticky () {
  if (!sticky.value) return
  await nextTick()
  const node = scroller.value
  if (node !== null) node.scrollTop = node.scrollHeight
}

// 只跟着「新的消息行」贴底；流式文本由下面的渲染回调负责。
watch(() => transcriptItems.value.length, () => {
  void scrollToBottomIfSticky()
})

watch(() => state.selected, async () => {
  showLiveReasoning.value = false
  await Promise.all([loadPermissions(state.selected), loadModels()])
})

/**
 * 流式输出渲染成 markdown 的窗口与节流。
 *
 * 原来的做法是每 140ms 把**整段** `state.live.text` 重跑一遍 `marked` → 每个围栏再走
 * highlight.js → `DOMPurify`，再用 `v-html` 整块替换，且没有长度上限。单次成本随字数线性增长，
 * 触发频率又固定，累计就是平方级：一万五千字、三个代码块时每次 50–150ms、约 7 次/秒，
 * 主线程基本被这条路径吃满 —— 「一边吐字一边点右侧栏就卡死」正是它。
 *
 * 所以：流式期间只解析末尾 `LIVE_WINDOW` 个字符，节流放宽到 `LIVE_INTERVAL`；收流
 * （`state.telemetry.running` 变 false）的那一帧取消节流、立刻整段渲染一次，保证最终视图完整。
 */
const LIVE_WINDOW = 8000
/** 流式期间的合并间隔。400ms 对人眼仍像「实时」，但把重渲染次数砍掉近三分之二。 */
const LIVE_INTERVAL = 400
/** 判定「窗口起点是否落在代码围栏内部」时，前缀扫描量的上限：不让防御本身变成新的卡顿源。 */
const LIVE_FENCE_SCAN_MAX = 200000
/**
 * 为「切在换行处」最多允许放大的字符数。
 *
 * 退到最近换行会让窗口比预算长出「本行已过去的部分」；单行本身就超过窗口时（压缩过的 JSON、
 * 一行的长 base64），这个放大可以到几千上万字，窗口也就重新失去了上限。超过这个额度就宁可
 * 切在行中间：代价只是首行被当成新段落，规模却仍然钉死在窗口大小上。
 */
const LIVE_SNAP_MAX = 2000
/** 窗口提示：内联样式，避免为一个临时提示去动样式表。 */
const LIVE_WINDOW_HINT = '<p style="margin:0 0 0.5em;font-size:11px;opacity:0.65">…（生成中，仅显示最新内容）</p>'

/** 渲染结果的容器，模板里用 `v-html` 挂上去。 */
const liveHtml = ref('')
const liveReasoningHtml = ref('')

/**
 * 每行开栏/闭栏标记（``` 或 ~~~）。围栏标记总是成对出现，所以「截断点之前的标记数为奇数」
 * 就等于「窗口起点落在围栏内部」。
 */
const FENCE_LINE = /(?:^|\n)([ \t]*(?:`{3,}|~{3,})[^\n]*)/gu

/**
 * 取末尾窗口。
 *
 * 截断点向后找最近的换行：从行中间切开会让尾巴的第一行变成新的段落 / 表格/ 列表项，显示会碎掉。
 * 注意这里切的是**原始文本**，不是已生成的 HTML —— 半开合的 HTML 粘不回合法状态，而文本可以。
 * @param text - 完整流式文本。
 * @returns 交给 `renderMarkdown` 的文本，以及是否发生了裁剪。
 */
function liveWindow (text) {
  if (text.length <= LIVE_WINDOW) return { text, clipped: false }
  let start = text.length - LIVE_WINDOW
  const lineStart = text.lastIndexOf('\n', start)
  if (lineStart >= 0 && text.length - (lineStart + 1) <= LIVE_WINDOW + LIVE_SNAP_MAX) start = lineStart + 1
  return { text: fenceOpenerBefore(text, start) + text.slice(start), clipped: true }
}

/**
 * 窗口起点若落在代码围栏内部，补回那一行的开栏标记。
 *
 * 不补的话，尾巴的第一个闭合 ``` 会被 marked 当成开栏，把收流前的所有正文都吞进一个代码块 ——
 * 恰好是最新、最该看的那一段。补一行开栏标记只是把缺的上下文补上，不涉及对渲染结果的二次截断，
 * 因此不会出现「渲染半个 HTML 标签」。
 * @param text - 完整流式文本。
 * @param start - 窗口起点（一定落在某个换行之后）。
 * @returns 需要前置的开栏行（含换行），没有则空串。
 */
function fenceOpenerBefore (text, start) {
  // 前缀过长时放弃判定：宁可少一点防御，也不让扫描本身随字数变成新的卡顿来源。
  if (start > LIVE_FENCE_SCAN_MAX) return ''
  FENCE_LINE.lastIndex = 0
  let count = 0
  let opener = ''
  let match
  while ((match = FENCE_LINE.exec(text)) !== null && match.index < start) {
    count += 1
    opener = match[1]
  }
  return count % 2 === 1 ? `${opener}\n` : ''
}

/**
 * 渲染一段流式文本。
 *
 * 流式期间给 `renderMarkdown` 的只有窗口；不在流式期间（或调用方在收流时）则原样交给它，
 * 因此最终视图一定是完整的整段内容，不会停在窗口上。
 * @param text - 完整流式文本。
 * @returns 净化后的 HTML；发生裁剪时前面带一行提示。
 */
function renderStream (text) {
  if (text === '') return ''
  const windowed = state.telemetry.running === true ? liveWindow(text) : { text, clipped: false }
  const html = renderMarkdown(windowed.text)
  return windowed.clipped ? LIVE_WINDOW_HINT + html : html
}

/**
 * 把一个流式文本接到一个 HTML ref 上：节流渲染，收流后立刻整段渲染。
 *
 * 答案和思维链走同一条路径，所以抽成一处 —— 两处各写一份节流曾经漏过清理：收流后残留的
 * 定时器还会再跑一次整段渲染，正好落在最不该慢的那一帧。
 * @param read - 读取当前文本。
 * @param target - 接收 HTML 的 ref。
 * @param afterCommit - 内容确实变了之后的回调（贴底滚动）。
 * @returns 解绑函数，供组件卸载时清理。
 */
function bindStream (read, target, afterCommit) {
  let timer
  const cancel = () => {
    if (timer === undefined) return
    window.clearTimeout(timer)
    timer = undefined
  }
  const commitNow = () => {
    const html = renderStream(read())
    // 内容没变就不动 DOM：v-html 换一个相同的字符串同样会重建整棵子树。
    if (html === target.value) return
    target.value = html
    afterCommit?.()
  }
  const stopText = watch(read, (text) => {
    if (text === '') {
      cancel()
      target.value = ''
      return
    }
    if (timer !== undefined) return
    timer = window.setTimeout(() => {
      timer = undefined
      commitNow()
    }, LIVE_INTERVAL)
  })
  // 收流：节流待处理的那一次已经没有意义，取消它并按整段文本渲染一次（只付这一帧的完整成本）。
  const stopRunning = watch(() => state.telemetry.running, (running) => {
    if (running === true) return
    cancel()
    if (read() !== '') commitNow()
  })
  return () => {
    stopText()
    stopRunning()
    cancel()
  }
}

const unbindLive = bindStream(() => state.live.text, liveHtml, () => {
  void scrollToBottomIfSticky()
})
const unbindLiveReasoning = bindStream(() => state.live.reasoning, liveReasoningHtml)

onBeforeUnmount(() => {
  unbindLive()
  unbindLiveReasoning()
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
      <button class="icon-btn" type="button" title="右侧栏" @click="emit('toggleFiles')">
        <AppIcon name="sidebar" :size="15" />
      </button>
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
          <label class="mb-3 flex items-start justify-between gap-3 text-[13px]">
            <span class="min-w-0">
              省流模式
              <span class="mt-0.5 block text-[11px] text-zinc-400">不加载图片附件，并关闭毛玻璃与动效，适合弱网</span>
            </span>
            <input
              :checked="state.lightweight"
              type="checkbox"
              class="mt-0.5 h-3.5 w-3.5"
              @change="setLightweight($event.target.checked)"
            />
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

    <div
      v-if="state.streamError"
      class="mx-2 mt-2 flex items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-100/70 px-3 py-1 text-[12px] text-amber-800 backdrop-blur-xl dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-200"
    >
      <span class="min-w-0 flex-1">{{ state.streamError }}</span>
      <button class="shrink-0 underline" type="button" @click="retrySession">重试</button>
    </div>

    <div class="relative min-h-0 flex-1">
      <!-- The transcript fills chunk by chunk, so the page has to say when the history is complete. -->
      <div
        v-if="snapshotVisible"
        class="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3"
        role="status"
        aria-live="polite"
      >
        <div
          class="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] shadow-lg backdrop-blur-xl"
          :class="state.snapshotProgress.done
            ? 'border-emerald-300/70 bg-emerald-100/90 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/20 dark:text-emerald-200'
            : 'border-white/60 bg-white/85 text-zinc-600 dark:border-white/15 dark:bg-zinc-900/85 dark:text-zinc-200'"
        >
          <AppIcon v-if="state.snapshotProgress.done" name="check" :size="13" class="shrink-0" />
          <AppIcon v-else name="refresh" :size="13" class="shrink-0 animate-spin" />
          <span class="truncate">{{ snapshotLabel }}</span>
          <span
            v-if="!state.snapshotProgress.done && state.snapshotProgress.count > 1"
            class="relative h-1 w-16 shrink-0 overflow-hidden rounded-full bg-black/10 dark:bg-white/15"
          >
            <span
              class="absolute inset-y-0 left-0 rounded-full bg-blue-500 transition-all duration-300"
              :style="{ width: snapshotPercent + '%' }"
            />
          </span>
        </div>
      </div>
      <div
        ref="scroller"
        class="h-full overflow-y-auto py-4"
        :class="mobile ? 'px-3' : 'pl-3 pr-8'"
        @scroll="onScroll"
      >
        <div class="transcript mx-auto flex max-w-3xl flex-col"
      :class="dense ? 'gap-2' : 'gap-4'">
          <!-- The opening window is bounded, so a long Session pages backwards from here. -->
          <div v-if="state.hasOlder && transcriptItems.length > 0" class="flex flex-col items-center gap-1.5">
            <div class="flex items-center gap-2">
              <button class="chip" type="button" :disabled="state.loadingOlder" @click="loadEarlier">
                <AppIcon
                  :name="state.loadingOlder ? 'refresh' : 'chevron'"
                  :size="12"
                  :class="state.loadingOlder ? 'animate-spin' : 'rotate-90'"
                />
                <span>{{ state.loadingOlder ? (state.olderSlow ? '网络较慢，仍在加载…' : '加载中…') : '加载更早的消息' }}</span>
              </button>
              <!-- A slow link should not trap the reader in a request they cannot stop. -->
              <button v-if="state.loadingOlder" class="chip" type="button" @click="cancelOlder">取消</button>
            </div>
            <p v-if="state.olderError !== ''" class="text-[12px] text-rose-500">
              {{ state.olderError }}
              <button class="ml-1 underline" type="button" @click="loadEarlier">重试</button>
            </p>
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
              <span>{{ sessionHint === '' ? '正在载入会话…' : sessionHint }}</span>
            </p>
            <div class="card rc-shimmer space-y-2 p-3">
              <div class="h-2.5 w-2/3 rounded-full bg-black/10 dark:bg-white/10" />
              <div class="h-2.5 w-5/6 rounded-full bg-black/10 dark:bg-white/10" />
              <div class="h-2.5 w-1/3 rounded-full bg-black/10 dark:bg-white/10" />
            </div>
            <div class="flex justify-end">
              <div class="prompt-glass rc-shimmer w-1/2 space-y-2 px-4 py-2.5">
                <div class="h-2.5 w-3/4 rounded-full bg-black/10 dark:bg-white/10" />
                <div class="h-2.5 w-1/2 rounded-full bg-black/10 dark:bg-white/10" />
              </div>
            </div>
          </div>
          <!-- Events that fold into nothing is a different situation from an empty Session, and saying
               which one it is saves a lot of guessing. -->
          <div
            v-else-if="canRetry(sessionPhase) && transcriptItems.length === 0"
            class="flex flex-col items-center gap-3 py-16 text-center"
          >
            <p class="text-sm text-amber-600 dark:text-amber-300">{{ sessionHint }}</p>
            <button class="btn btn-primary" type="button" @click="retrySession">重试</button>
          </div>
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
