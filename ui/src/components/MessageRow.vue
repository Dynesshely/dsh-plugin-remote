<script setup>
import { computed, ref, watchEffect } from 'vue'
import { renderMarkdown } from '../lib/markdown.js'
import { attachmentImage, ensureAttachmentImage, state } from '../lib/store.js'
import ToolCard from './ToolCard.vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({ item: { type: Object, required: true } })

const showReasoning = ref(false)
const showNote = ref(false)
/** Index of the in-bubble context note that is expanded, or -1. */
const openNote = ref(-1)
const groupOpen = ref(false)
const zoom = ref('')

const html = computed(() => (props.item.kind === 'assistant' ? renderMarkdown(props.item.text) : ''))
const reasoning = computed(() => String(props.item.reasoning ?? '').trim())
/** The reasoning chain renders as markdown too, computed only while it is open. */
const reasoningHtml = computed(() => (showReasoning.value ? renderMarkdown(reasoning.value) : ''))
const images = computed(() => props.item.images ?? [])

// Pull the bytes for any image this message carries; the Host reads them from the Session log.
watchEffect(() => {
  for (const image of props.item.images ?? []) ensureAttachmentImage(state.selected, image.attachmentId)
})

/** @returns the cached data URL for one image, or '' while it loads. */
function srcOf (image) {
  return attachmentImage(state.selected, image.attachmentId)
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
  <!-- user -->
  <div v-if="item.kind === 'user'" class="rise flex justify-end">
    <div class="max-w-[92%] rounded-3xl rounded-br-lg border border-blue-300/50 bg-gradient-to-b from-blue-500 to-blue-600 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-white shadow-[0_10px_30px_-14px_rgb(37_99_235/0.9)]">
      <div v-if="images.length" class="mb-1.5 flex flex-wrap gap-2">
        <button
          v-for="image in images"
          :key="image.attachmentId"
          type="button"
          class="h-24 w-24 overflow-hidden rounded-xl border border-white/40"
          @click="zoom = srcOf(image)"
        >
          <img v-if="srcOf(image)" :src="srcOf(image)" :alt="image.name ?? ''" class="h-full w-full object-cover" />
          <span v-else class="flex h-full w-full items-center justify-center text-[11px] text-blue-50/80">加载中…</span>
        </button>
      </div>
      <span v-if="item.text">{{ item.text }}</span>
      <div v-if="item.files?.length" class="mt-1 flex flex-wrap gap-1 text-[11px] text-blue-50/90">
        <span v-for="file in item.files" :key="file">{{ file }}</span>
      </div>

      <!-- Harness metadata for this turn: folded into the bubble's bottom-right corner, collapsed. -->
      <div v-if="item.notes?.length" class="mt-1.5 flex flex-wrap justify-end gap-1">
        <button
          v-for="(note, index) in item.notes"
          :key="index"
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-white/30 bg-white/15 px-2 py-0.5 text-[10px] text-blue-50/90 transition-colors hover:bg-white/25"
          @click="openNote = openNote === index ? -1 : index"
        >
          <AppIcon name="info" :size="10" />
          <span>上下文{{ item.notes.length > 1 ? ` ×${item.notes.length}` : '' }}</span>
          <AppIcon name="chevron" :size="9" :class="openNote === index ? 'rotate-180' : ''" class="transition-transform" />
        </button>
      </div>
      <div
        v-if="openNote >= 0 && item.notes?.[openNote]"
        class="mt-1 rounded-xl bg-black/15 px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap text-blue-50/85"
      >
        {{ item.notes[openNote].text }}
        <span v-if="item.notes[openNote].sourceKind" class="mt-1 block text-[9px] tracking-wide text-blue-50/60">
          source: {{ item.notes[openNote].sourceKind }}
        </span>
      </div>
    </div>
  </div>

  <!-- Harness-injected context: metadata, so it stays a subdued collapsed note. -->
  <div v-else-if="item.kind === 'context'" class="rise">
    <button
      type="button"
      class="chip text-[11px] text-zinc-500 dark:text-zinc-400"
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
      class="card pop mt-1.5 border-dashed px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-500 dark:text-zinc-400"
    >
      {{ item.text }}
      <span v-if="item.sourceKind" class="mt-1 block text-[10px] tracking-wide text-zinc-400">source: {{ item.sourceKind }}</span>
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
      <div v-if="showReasoning" class="card pop mt-2 border-dashed px-3 py-2">
        <div class="md break-words text-[13px] text-zinc-500 dark:text-zinc-400" v-html="reasoningHtml" />
      </div>
    </div>
    <div class="md break-words" v-html="html" />
    <div v-if="images.length" class="mt-2 flex flex-wrap gap-2">
      <button
        v-for="image in images"
        :key="image.attachmentId"
        type="button"
        class="h-32 w-32 overflow-hidden rounded-xl border border-white/60 dark:border-white/10"
        @click="zoom = srcOf(image)"
      >
        <img v-if="srcOf(image)" :src="srcOf(image)" :alt="image.name ?? ''" class="h-full w-full object-cover" />
        <span v-else class="flex h-full w-full items-center justify-center text-[11px] text-zinc-400">加载中…</span>
      </button>
    </div>
    <div v-if="item.files?.length" class="mt-1 flex flex-wrap gap-2">
      <span v-for="file in item.files" :key="file" class="chip">{{ file }}</span>
    </div>
  </div>

  <!-- a run of identical tools: second-level grouping -->
  <div v-else-if="item.kind === 'toolGroup'" class="rise card overflow-hidden">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/50 dark:hover:bg-white/[0.06]"
      @click="groupOpen = !groupOpen"
    >
      <AppIcon name="chevronRight" :size="13" class="text-zinc-400 transition-transform" :class="groupOpen ? 'rotate-90' : ''" />
      <AppIcon name="layers" :size="13" class="text-zinc-400" />
      <span class="rounded-lg bg-zinc-900/[0.06] px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/10">
        {{ item.count }} × {{ item.name }}
      </span>
      <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-400">连续调用，点击展开</span>
      <span v-if="groupState.failed > 0" class="shrink-0 text-[11px] text-rose-500">{{ groupState.failed }} 失败</span>
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :class="groupState.failed > 0 ? 'bg-rose-500' : groupState.running ? 'bg-amber-400 pulse' : 'bg-emerald-500'"
      />
    </button>
    <div v-if="groupOpen" class="space-y-1.5 border-t border-white/50 p-2 dark:border-white/10">
      <ToolCard v-for="entry in item.items" :key="entry.key" :item="entry" />
    </div>
  </div>

  <!-- one tool call -->
  <ToolCard v-else-if="item.kind === 'tool'" :item="item" class="rise" />

  <!-- notice -->
  <div v-else class="rise flex justify-center">
    <span class="chip text-[11px]">{{ item.text }}</span>
  </div>

  <!-- image viewer -->
  <Teleport to="body">
    <div
      v-if="zoom"
      class="fixed inset-0 z-[130] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      @click="zoom = ''"
    >
      <img :src="zoom" alt="" class="max-h-full max-w-full rounded-2xl shadow-2xl" />
    </div>
  </Teleport>
</template>
