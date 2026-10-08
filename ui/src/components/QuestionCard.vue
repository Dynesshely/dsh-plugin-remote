<script setup>
import { computed, ref, watch } from 'vue'
import { answerOf, normalizeQuestions } from '../lib/questions.js'
import { answerQuestion } from '../lib/store.js'
import AppIcon from './AppIcon.vue'

/**
 * The question card, laid out like the Desktop's `ask_user_question` surface.
 *
 * Used in two places with the same markup: inline in the transcript (where the tool call happened)
 * and in the dock above the composer. With a `callId` it is answerable; once the call stops being
 * pending — answered here, on the Desktop, or by a timeout — it renders the same card read-only as a
 * record of the answer.
 */
const props = defineProps({
  /** Questions from `parseQuestionArgs` or from a pending record; both are normalized here. */
  questions: { type: Array, default: () => [] },
  /** Parsed answers (`parseQuestionResult`), for the answered state. */
  answers: { type: Array, default: () => [] },
  /** Pending call id; omit to render read-only. */
  callId: { type: String, default: '' },
  /** Small line above the question. */
  eyebrow: { type: String, default: '提问' },
  /** Note shown when the question belongs to another Session. */
  elsewhere: { type: Boolean, default: false },
})

const model = computed(() => normalizeQuestions(props.questions))
/** Local drafts, one per question: this device's in-progress answer. */
const drafts = ref(model.value.map((question) => ({ id: question.id, selected: [], custom: '' })))
const index = ref(0)
const busy = ref(false)
const error = ref('')
/** Set once this card's answer was accepted, so it keeps showing the choice it sent. */
const submitted = ref(false)

const readOnly = computed(() => props.callId === '' || submitted.value)
const current = computed(() => model.value[index.value])

watch(() => model.value.map((question) => question.id).join('|'), () => {
  drafts.value = model.value.map((question) => ({ id: question.id, selected: [], custom: '' }))
  index.value = 0
})

/** @returns the local draft for one question. */
function draftOf (id) {
  return drafts.value.find((draft) => draft.id === id) ?? { id, selected: [], custom: '' }
}

/**
 * The answer to display: the durable one when the tool replied, otherwise this device's draft.
 * @param question - a normalized question.
 * @returns `{ selected, custom }`.
 */
function effective (question) {
  const record = answerOf(props.answers, question.id)
  if (record !== undefined && (record.selected.length > 0 || (record.custom ?? '') !== '')) {
    return { selected: record.selected, custom: record.custom ?? '' }
  }
  const draft = draftOf(question.id)
  return { selected: draft.selected, custom: draft.custom }
}

/** @returns whether one option is shown as picked. */
function isPicked (question, label) {
  return effective(question).selected.includes(label)
}

/** @returns the free-text answer shown for a question, if any. */
function customOf (question) {
  return effective(question).custom
}

/** @returns whether one question counts as answered. */
function answered (question) {
  const { selected, custom } = effective(question)
  return selected.length > 0 || custom.trim() !== ''
}

const complete = computed(() => model.value.every((question) => answered(question)))

/** Pick an option: toggle for multi-select, replace-and-advance for single select. */
function choose (question, option) {
  if (readOnly.value) return
  const draft = drafts.value.find((entry) => entry.id === question.id)
  if (draft === undefined) return
  error.value = ''
  if (question.multiSelect) {
    draft.selected = draft.selected.includes(option.label)
      ? draft.selected.filter((label) => label !== option.label)
      : [...draft.selected, option.label]
    return
  }
  draft.selected = [option.label]
  draft.custom = ''
  const next = index.value + 1
  if (next < model.value.length) index.value = next
}

/** Record free text as the answer for a question. */
function writeCustom (question, value) {
  const draft = drafts.value.find((entry) => entry.id === question.id)
  if (draft === undefined) return
  draft.custom = value
  if (value !== '') draft.selected = []
  error.value = ''
}

/** Send every answered question back as one batch. */
async function submit () {
  if (readOnly.value || busy.value) return
  const missing = model.value.findIndex((question) => !answered(question))
  if (missing >= 0) {
    index.value = missing
    error.value = '还有问题没有回答'
    return
  }
  busy.value = true
  try {
    const answers = drafts.value.map((draft) => ({
      id: draft.id,
      selected: draft.selected,
      ...(draft.custom.trim() === '' ? {} : { custom: draft.custom.trim() }),
    }))
    const accepted = await answerQuestion(props.callId, answers)
    submitted.value = accepted
    if (!accepted) error.value = '提交失败，请重试'
  } finally {
    busy.value = false
  }
}

/** Enter inside the card submits, like the Desktop's option rows. */
function onKeydown (event) {
  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()
  void submit()
}
</script>

<template>
  <div class="card overflow-hidden" @keydown="onKeydown">
    <header class="flex items-start justify-between gap-4 px-4 pt-4">
      <div class="min-w-0">
        <p class="mb-1 text-[11px] leading-4 text-zinc-400">
          {{ eyebrow }}<span v-if="elsewhere" class="ml-1 opacity-70">（其它会话）</span>
        </p>
        <h3 class="text-[16px] leading-[22px] font-medium">
          {{ current?.header ?? current?.question ?? '' }}
        </h3>
        <p v-if="current?.header && current?.question" class="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          {{ current.question }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <span v-if="readOnly" class="text-[12px] leading-6 whitespace-nowrap text-zinc-400">已作答</span>
        <span v-else class="text-[12px] leading-6 whitespace-nowrap text-zinc-400">
          {{ busy ? '提交中…' : '等待你的回答' }}
        </span>
      </div>
    </header>

    <!-- Options: number badges for a single choice, checkboxes for several, like the Desktop. -->
    <div class="min-h-0 overflow-y-auto overscroll-contain" :class="model.length > 1 ? 'max-h-[46dvh]' : ''">
      <div
        v-if="current"
        class="mt-2 flex flex-col gap-px px-3 py-1"
        :role="current.multiSelect ? 'group' : 'radiogroup'"
      >
        <button
          v-for="(option, optionIndex) in current.options"
          :key="option.label"
          type="button"
          class="flex w-full shrink-0 items-start gap-2 rounded-xl border px-2 py-2 pr-3 text-left transition-colors"
          :class="isPicked(current, option.label)
            ? 'border-sky-400/60 bg-white/70 dark:border-sky-400/40 dark:bg-white/[0.10]'
            : 'border-transparent hover:bg-white/50 dark:hover:bg-white/[0.07]'"
          :role="current.multiSelect ? 'checkbox' : 'radio'"
          :aria-checked="isPicked(current, option.label)"
          :disabled="readOnly"
          @click="choose(current, option)"
        >
          <span
            v-if="current.multiSelect"
            class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border border-zinc-300/80 dark:border-white/20"
            :class="isPicked(current, option.label) ? 'border-sky-400 bg-sky-500/90 text-white' : ''"
            aria-hidden="true"
          >
            <AppIcon v-if="isPicked(current, option.label)" name="check" :size="12" />
          </span>
          <span
            v-else
            class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-zinc-900/[0.06] text-[12px] leading-[18px] font-medium text-zinc-500 dark:bg-white/10 dark:text-zinc-400"
            aria-hidden="true"
          >
            {{ optionIndex + 1 }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="text-[13px] leading-5">{{ option.label }}</span>
              <span v-if="option.recommended" class="chip px-1.5 py-0 text-[10px] leading-4">推荐</span>
            </span>
            <span v-if="option.description" class="mt-0.5 block text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
              {{ option.description }}
            </span>
          </span>
        </button>

        <!-- Free text, for answers the options do not cover. -->
        <label
          v-if="!readOnly"
          class="mt-1 flex items-center gap-2 rounded-xl border border-transparent px-2 py-1.5 hover:bg-white/40 dark:hover:bg-white/[0.05]"
        >
          <AppIcon name="pencil" :size="13" class="shrink-0 text-zinc-400" />
          <input
            :value="draftOf(current.id).custom"
            type="text"
            class="w-full bg-transparent text-[13px] outline-none placeholder:text-zinc-400"
            placeholder="其他…（自行输入）"
            @input="writeCustom(current, $event.target.value)"
          />
        </label>
        <p v-else-if="customOf(current)" class="mt-1 flex items-start gap-2 px-2 py-1.5 text-[13px]">
          <AppIcon name="pencil" :size="13" class="mt-0.5 shrink-0 text-zinc-400" />
          <span>{{ customOf(current) }}</span>
        </p>
      </div>
    </div>

    <footer class="mt-2 flex shrink-0 items-center justify-end gap-3 px-4 pb-3">
      <p v-if="error" class="mr-auto text-[12px] text-rose-500">{{ error }}</p>
      <div v-if="model.length > 1" class="flex items-center gap-1.5">
        <button
          type="button"
          class="grid h-6 w-6 place-items-center rounded-full text-zinc-400 transition-colors hover:bg-white/60 hover:text-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/10 dark:hover:text-zinc-100"
          :disabled="index === 0"
          title="上一个问题"
          @click="index -= 1"
        >
          <AppIcon name="chevron" :size="13" class="-rotate-90" />
        </button>
        <span class="px-1 text-[14px] leading-6 font-medium whitespace-nowrap tabular-nums">
          {{ index + 1 }}/{{ model.length }}
        </span>
        <button
          type="button"
          class="grid h-6 w-6 place-items-center rounded-full text-zinc-400 transition-colors hover:bg-white/60 hover:text-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/10 dark:hover:text-zinc-100"
          :disabled="index >= model.length - 1"
          title="下一个问题"
          @click="index += 1"
        >
          <AppIcon name="chevron" :size="13" class="rotate-90" />
        </button>
      </div>
      <button
        v-if="!readOnly"
        type="button"
        class="btn btn-primary"
        :disabled="busy || !complete"
        :title="complete ? '提交回答' : '还有问题没有回答'"
        @click="submit"
      >
        <AppIcon name="send" :size="13" />
        <span>提交</span>
      </button>
    </footer>
  </div>
</template>
