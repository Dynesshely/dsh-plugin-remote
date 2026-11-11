<script setup>
import { computed, ref, watchEffect } from 'vue'
import { useLazyRender } from '../lib/lazy-render.js'
import { extractFileReferences, renderMarkdown } from '../lib/markdown.js'
import { attachmentImage, attachmentImageFailed, ensureAttachmentImage, state } from '../lib/store.js'
import ToolCard from './ToolCard.vue'
import QuestionCard from './QuestionCard.vue'
import FileCard from './FileCard.vue'
import AppIcon from './AppIcon.vue'

/** Compact number formatting: 1234 → 1.2k. */
function compact (value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return '0'
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}k`
  return String(Math.round(number))
}

const props = defineProps({
  item: { type: Object, required: true },
  /** True while the run is working on this prompt, which adds the iridescent ring. */
  active: { type: Boolean, default: false },
})

/** Observed so the expensive markdown work happens only near the viewport. */
const root = ref(null)
const { rendered } = useLazyRender(root)

const showReasoning = ref(false)
const showNote = ref(false)
/** Index of the in-bubble context note that is expanded, or -1. */
const openNote = ref(-1)
const groupOpen = ref(false)

// Both sides of the conversation render Markdown: what the user typed is Markdown source. Gated on
// `rendered`: off-screen rows show their text as-is, which costs nothing and still reads.
//
// 消息里只有 `<path>…</path>` 标签与"整行就是本地路径"这两类会摘成文件卡片；图片引用照旧留在
// markdown 里渲染成内联大图（`preparseLocalImages` / `proxyLocalImages` 的链路不动）。
const segments = computed(() => {
  if (!rendered.value) return []
  if (props.item.kind !== 'assistant' && props.item.kind !== 'user') return []
  const { parts } = extractFileReferences(props.item.text)
  return parts.map((part) => (part.type === 'file' ? part : { type: 'text', html: renderMarkdown(part.value) }))
})
const reasoning = computed(() => String(props.item.reasoning ?? '').trim())
/** The reasoning chain renders as markdown too, computed only while it is open. */
const reasoningHtml = computed(() => (showReasoning.value ? renderMarkdown(reasoning.value) : ''))
const images = computed(() => props.item.images ?? [])

// Pull the bytes for any image this message carries; the Host reads them from the Session log.
// `image` 的元信息（bytes/mediaType/name）也一起传过去：本页刚发出的图片可以直接用本地 blob 回显。
watchEffect(() => {
  for (const image of props.item.images ?? []) ensureAttachmentImage(state.selected, image.attachmentId, image)
})

/** @returns the cached data URL for one image, or '' while it loads. */
function srcOf (image) {
  return attachmentImage(state.selected, image.attachmentId)
}

/** @returns whether that attachment failed to load (so the bubble stops saying "加载中"). */
function failedOf (image) {
  return attachmentImageFailed(state.selected, image.attachmentId)
}

/** @returns the call id while that question is still pending, otherwise '' (a read-only card). */
function pendingCallId (item) {
  if (item.result !== undefined) return ''
  return state.pending.questions.some((record) => record.callId === item.callId) ? item.callId : ''
}

/** @returns how many calls in a group failed, and whether any is still running. */
const groupState = computed(() => {
  const entries = props.item.items ?? []
  return {
    failed: entries.filter((entry) => entry.error !== undefined).length,
    running: entries.some((entry) => entry.result === undefined && entry.error === undefined),
  }
})
</script>

<template>
  <!-- The wrapper is what the observer watches; the row's own layout stays inside it. -->
  <div ref="root" class="flex flex-col">
  <!-- user -->
  <div v-if="item.kind === 'user'" class="rise flex justify-end">
    <div
      class="prompt-glass max-w-[92%] px-4 py-2.5 text-[15px] leading-relaxed break-words"
      :class="active ? 'is-running' : ''"
    >
      <div v-if="images.length" class="mb-1.5 flex flex-wrap gap-2">
        <button
          v-for="image in images"
          :key="image.attachmentId"
          type="button"
          class="h-24 w-24 overflow-hidden rounded-xl border border-white/40"
         
        >
          <img v-if="srcOf(image)" :src="srcOf(image)" :alt="image.name ?? ''" class="h-full w-full object-cover" />
          <span v-else-if="failedOf(image)" class="flex h-full w-full items-center justify-center text-[11px] text-tertiary text-subtle">图片不可用</span>
          <span v-else class="flex h-full w-full items-center justify-center text-[11px] text-on-primary">加载中…</span>
        </button>
      </div>
      <template v-if="item.text && rendered">
        <template v-for="(part, index) in segments" :key="index">
          <div v-if="part.type === 'text'" class="md" v-html="part.html" />
          <FileCard v-else :file="part.file" />
        </template>
      </template>
      <div v-else-if="item.text" class="md md-plain">{{ item.text }}</div>
      <div v-if="item.files?.length" class="mt-1 flex flex-wrap gap-1 text-[11px] text-secondary">
        <span v-for="file in item.files" :key="file">{{ file }}</span>
      </div>

      <!-- Harness metadata for this turn: folded into the bubble's bottom-right corner, collapsed. -->
      <div v-if="item.notes?.length" class="mt-1.5 flex flex-wrap justify-end gap-1">
        <button
          v-for="(note, index) in item.notes"
          :key="index"
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-outline bg-white/60 px-2 py-0.5 text-[10px] text-secondary transition-colors hover:bg-white/80 dark:bg-white/[0.08]"
          @click="openNote = openNote === index ? -1 : index"
        >
          <AppIcon name="info" :size="10" />
          <span>上下文{{ item.notes.length > 1 ? ` ×${item.notes.length}` : '' }}</span>
          <AppIcon name="chevron" :size="9" :class="openNote === index ? 'rotate-180' : ''" class="transition-transform" />
        </button>
      </div>
      <div
        v-if="openNote >= 0 && item.notes?.[openNote]"
        class="mt-1 rounded-xl bg-white/60 px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap text-secondary dark:bg-black/25"
      >
        {{ item.notes[openNote].text }}
        <span v-if="item.notes[openNote].sourceKind" class="mt-1 block text-[9px] tracking-wide text-on-primary">
          source: {{ item.notes[openNote].sourceKind }}
        </span>
      </div>
    </div>
  </div>

  <!-- One finished turn: what it cost, under the answer it produced. -->
  <div v-else-if="item.kind === 'turnStats'" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-tertiary text-subtle">
    <span class="inline-flex items-center gap-1" title="本轮用时">
      <AppIcon name="clock" :size="11" />{{ item.seconds.toFixed(1) }}s
    </span>
    <span class="inline-flex items-center gap-1" title="输出 tokens">
      <AppIcon name="cpu" :size="11" />{{ compact(item.output) }} tok
    </span>
    <span v-if="item.perSecond > 0" class="inline-flex items-center gap-1" title="本轮平均生成速度">
      ≈{{ item.perSecond.toFixed(1) }} tok/s
    </span>
    <span title="输入 tokens（其中缓存读取）">↑{{ compact(item.input) }}<template v-if="item.cache > 0">（缓存 {{ compact(item.cache) }}）</template></span>
    <span v-if="item.steps > 0" title="步数">{{ item.steps }} 步</span>
  </div>

  <!-- Harness-injected context: metadata, so it stays a subdued collapsed note. -->
  <div v-else-if="item.kind === 'context'" class="rise">
    <button
      type="button"
      class="chip text-[11px] text-secondary"
      :class="{ 'chip-strong': showNote }"
      @click="showNote = !showNote"
    >
      <AppIcon name="info" :size="12" />
      <span>上下文信息</span>
      <span class="opacity-60">{{ item.text.length }} 字</span>
      <AppIcon name="chevron" :size="11" :class="showNote ? 'rotate-180' : ''" class="transition-transform" />
    </button>
    <div
      v-if="showNote"
      class="card pop mt-1.5 border-dashed px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-secondary"
    >
      {{ item.text }}
      <span v-if="item.sourceKind" class="mt-1 block text-[10px] tracking-wide text-tertiary">source: {{ item.sourceKind }}</span>
    </div>
  </div>

  <!-- assistant -->
  <div v-else-if="item.kind === 'assistant'" class="rise">
    <!-- Reasoning stays collapsed by default, like the Desktop client. -->
    <div v-if="reasoning" class="mb-2">
      <button
        type="button"
        class="chip"
        :class="{ 'chip-strong': showReasoning }"
        @click="showReasoning = !showReasoning"
      >
        <AppIcon name="brain" :size="13" />
        <span>思维链</span>
        <span class="opacity-60">{{ reasoning.length }} 字</span>
        <AppIcon name="chevron" :size="11" :class="showReasoning ? 'rotate-180' : ''" class="transition-transform" />
      </button>
      <div v-if="showReasoning" class="card reasoning-card pop mt-2 border-dashed px-3 py-2">
        <div class="md break-words text-[13px] text-secondary" v-html="reasoningHtml" />
      </div>
    </div>
    <template v-if="rendered">
      <template v-for="(part, index) in segments" :key="index">
        <div v-if="part.type === 'text'" class="md break-words" v-html="part.html" />
        <FileCard v-else :file="part.file" />
      </template>
    </template>
    <div v-else class="md md-plain break-words">{{ item.text }}</div>
    <div v-if="images.length" class="mt-2 flex flex-wrap gap-2">
      <button
        v-for="image in images"
        :key="image.attachmentId"
        type="button"
        class="h-32 w-32 overflow-hidden rounded-xl border border-outline"
       
      >
        <img v-if="srcOf(image)" :src="srcOf(image)" :alt="image.name ?? ''" class="h-full w-full object-cover" />
        <span v-else-if="failedOf(image)" class="flex h-full w-full items-center justify-center text-[11px] text-tertiary">图片不可用</span>
        <span v-else class="flex h-full w-full items-center justify-center text-[11px] text-tertiary">加载中…</span>
      </button>
    </div>
    <div v-if="item.files?.length" class="mt-1 flex flex-wrap gap-2">
      <span v-for="file in item.files" :key="file" class="chip">{{ file }}</span>
    </div>
  </div>

  <!-- a run of identical tools: second-level grouping -->
  <div v-else-if="item.kind === 'toolGroup'" class="rise card tool-group overflow-hidden">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-fill-chip"
      @click="groupOpen = !groupOpen"
    >
      <AppIcon name="chevronRight" :size="13" class="text-tertiary transition-transform" :class="groupOpen ? 'rotate-90' : ''" />
      <AppIcon name="layers" :size="13" class="text-tertiary" />
      <span class="rounded-lg bg-fill-muted px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/10">
        {{ item.count }} × {{ item.name }}
      </span>
      <span class="min-w-0 flex-1 truncate text-[11px] text-tertiary">连续调用，点击展开</span>
      <span v-if="groupState.failed > 0" class="shrink-0 text-[11px] text-danger">{{ groupState.failed }} 失败</span>
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :class="groupState.failed > 0 ? 'bg-danger' : groupState.running ? 'bg-warning pulse' : 'bg-success'"
      />
    </button>
    <div v-if="groupOpen" class="space-y-1.5 border-t border-outline-medium p-2 dark:border-white/10">
      <ToolCard v-for="entry in item.items" :key="entry.key" :item="entry" />
    </div>
  </div>

  <!-- a question tool call renders as the Desktop-style question card, answerable in place -->
  <QuestionCard
    v-else-if="item.kind === 'tool' && item.questions?.length"
    class="rise"
    :questions="item.questions"
    :answers="item.answers"
    :call-id="pendingCallId(item)"
  />

  <!-- one tool call -->
  <ToolCard v-else-if="item.kind === 'tool'" :item="item" class="rise" />

  <!-- notice -->
  <div v-else class="rise flex justify-center">
    <span class="chip text-[11px]">{{ item.text }}</span>
  </div>

  </div>
</template>
