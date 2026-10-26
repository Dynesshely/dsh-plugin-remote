<script setup>
import { computed, ref } from 'vue'
import { prettyArguments } from '../lib/markdown.js'
import { codeHtml } from '../lib/highlight.js'
import AppIcon from './AppIcon.vue'
import { imageReferencesIn } from '../lib/markdown.js'
import { proxiedImageSrc } from '../lib/marked-setup.js'

/** One tool call, collapsed to a single summary line until the reader opens it. */
const props = defineProps({ item: { type: Object, required: true } })

const expanded = ref(false)

/** 折叠头显示的字符数。 */
const COLLAPSED_PREVIEW = 96
/** 展开态做美化前的长度闸门：超过就只显示原文前一段。 */
const MAX_PRETTY_CHARS = 20_000
/** 超长参数在展开态仍然显示的原文字符数。 */
const RAW_PREVIEW_CHARS = 4_000

const rawArgs = computed(() => String(props.item.args ?? ''))

/**
 * 折叠头的一行摘要。
 *
 * 只用原串的前 96 个字符：参数的 JSON 美化（`JSON.parse` + `JSON.stringify(…, null, 2)`）和整串
 * 空白替换，对 `write`/`edit` 这类带着整篇文件正文的参数是单行 50–200ms，而折叠态只需要开头几个
 * 词。所以这里不解析、不美化、不跑正则，最多再把开头的空白跳过（循环也只走 96 个字符）。
 */
const argsPreview = computed(() => {
  const raw = rawArgs.value
  let start = 0
  while (start < raw.length && start < COLLAPSED_PREVIEW && raw.charCodeAt(start) <= 32) start += 1
  const head = raw.slice(start, start + COLLAPSED_PREVIEW)
  return start + COLLAPSED_PREVIEW < raw.length ? `${head}…` : head
})

/**
 * 展开态的完整参数文本。
 *
 * 美化只在展开时发生（`argsHtml` 是 computed，模板里的 `v-if="expanded"` 不成立就不会求值），
 * 而且先过长度闸门：超长参数原文比美化结果更有用，也便宜得多。
 */
const argsText = computed(() => {
  const raw = rawArgs.value
  if (raw.length > MAX_PRETTY_CHARS) {
    return `${raw.slice(0, RAW_PREVIEW_CHARS)}\n…（参数过长，仅显示前 ${String(RAW_PREVIEW_CHARS)} 字符）`
  }
  return prettyArguments(raw)
})

// Escaped/highlighted HTML for the expanded body: arguments are JSON for most tools (hinted as such,
// which beats detection), results are auto-detected by highlight.js.
const argsHtml = computed(() => codeHtml(argsText.value, 'json'))
const resultHtml = computed(() => codeHtml(props.item.result))

const failed = computed(() => props.item.error !== undefined)
const pending = computed(() => props.item.result === undefined && props.item.error === undefined)
/** Pictures the tool wrote and named in its output, shown under the text. */
const resultImages = computed(() => (props.item.result === undefined ? [] : imageReferencesIn(props.item.result).map(proxiedImageSrc)))
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
        <!-- A tool that wrote a screenshot usually just names the file: show it, not only the path. -->
        <div v-if="resultImages.length > 0" class="mt-2 flex flex-wrap gap-2">
          <img
            v-for="source in resultImages"
            :key="source"
            :src="source"
            alt=""
            loading="lazy"
            decoding="async"
            class="max-h-64 rounded-xl border border-white/50 object-contain dark:border-white/10"
          />
        </div>
      </div>
      <p v-if="item.error" class="text-[12px] text-rose-500">失败：{{ item.error }}</p>
    </div>
  </div>
</template>
