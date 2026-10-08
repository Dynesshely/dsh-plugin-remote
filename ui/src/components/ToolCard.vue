<script setup>
import { computed, ref } from 'vue'
import { prettyArguments } from '../lib/markdown.js'
import { codeHtml } from '../lib/highlight.js'
import AppIcon from './AppIcon.vue'

/** One tool call, collapsed to a single summary line until the reader opens it. */
const props = defineProps({ item: { type: Object, required: true } })

const expanded = ref(false)

/** Pretty-printed arguments, which are JSON for most tools. */
const argsText = computed(() => prettyArguments(props.item.args))

/** @returns a one-line summary of the arguments for the collapsed header. */
const argsPreview = computed(() => {
  const text = argsText.value.replace(/\s+/gu, ' ').trim()
  return text.length <= 96 ? text : `${text.slice(0, 95)}…`
})

// Escaped/highlighted HTML for the expanded body: arguments are JSON for most tools (hinted as such,
// which beats detection), results are auto-detected by highlight.js.
const argsHtml = computed(() => codeHtml(argsText.value, 'json'))
const resultHtml = computed(() => codeHtml(props.item.result))

const failed = computed(() => props.item.error !== undefined)
const pending = computed(() => props.item.result === undefined && props.item.error === undefined)
</script>

<template>
  <div class="card overflow-hidden">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/50 dark:hover:bg-white/[0.06]"
      @click="expanded = !expanded"
    >
      <AppIcon name="chevronRight" :size="13" class="text-zinc-400 transition-transform" :class="expanded ? 'rotate-90' : ''" />
      <AppIcon name="wrench" :size="13" class="text-zinc-400" />
      <span class="rounded-lg bg-zinc-900/[0.06] px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/10">{{ item.name }}</span>
      <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">{{ argsPreview }}</span>
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :class="failed ? 'bg-rose-500' : pending ? 'bg-amber-400 pulse' : 'bg-emerald-500'"
      />
    </button>
    <div v-if="expanded" class="border-t border-white/50 px-3 py-2 dark:border-white/10">
      <div v-if="item.args" class="mb-2">
        <div class="mb-1 text-[11px] text-zinc-400">参数</div>
        <pre class="max-h-64 overflow-auto rounded-xl bg-white/50 p-2 font-mono text-[12px] dark:bg-black/30" v-html="argsHtml" />
      </div>
      <div v-if="item.result !== undefined">
        <div class="mb-1 text-[11px] text-zinc-400">结果</div>
        <pre class="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-white/50 p-2 font-mono text-[12px] dark:bg-black/30" v-html="resultHtml" />
      </div>
      <p v-if="item.error" class="text-[12px] text-rose-500">失败：{{ item.error }}</p>
    </div>
  </div>
</template>
