<script setup>
import { answerQuestion, state } from '../lib/store.js'
import AppIcon from './AppIcon.vue'

/** Send one option (or a custom answer) back for a question item. */
function answer (callId, id, selected, custom) {
  const item = custom === undefined ? { id, selected } : { id, selected: [], custom }
  void answerQuestion(callId, [item])
}

/** Ask for free text when none of the options fit. */
function answerCustom (callId, id) {
  const value = window.prompt('你的回答：')
  if (value !== null && value !== '') answer(callId, id, [], value)
}
</script>

<template>
  <div
    v-if="state.pending.questions.length > 0 || state.pending.approvals.length > 0"
    class="mx-2 mb-2 space-y-2"
  >
    <div
      v-for="question in state.pending.questions"
      :key="question.callId"
      class="card rise border-amber-300/70 bg-amber-50/70 p-3 dark:border-amber-400/30 dark:bg-amber-500/10"
    >
      <div class="mb-1 flex items-center gap-2 text-[13px] font-medium text-amber-700 dark:text-amber-300">
        <AppIcon name="spark" :size="14" />
        需要你回答
        <span v-if="question.sessionId !== state.selected" class="text-[11px] font-normal opacity-70">（其它会话）</span>
      </div>
      <div v-for="item in question.questions" :key="item.id" class="mt-2">
        <p class="text-[13px]">{{ item.question }}</p>
        <p v-if="item.detail" class="text-[11px] text-zinc-500 dark:text-zinc-400">{{ item.detail }}</p>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          <button
            v-for="option in item.options"
            :key="option.label"
            type="button"
            class="chip hover:border-amber-400"
            :title="option.description"
            @click="answer(question.callId, item.id, [option.label])"
          >
            {{ option.label }}
          </button>
          <button type="button" class="chip" @click="answerCustom(question.callId, item.id)">其它…</button>
        </div>
      </div>
    </div>

    <div
      v-for="approval in state.pending.approvals"
      :key="approval.key"
      class="card rise border-amber-300/70 bg-amber-50/70 p-3 dark:border-amber-400/30 dark:bg-amber-500/10"
    >
      <div class="flex items-center gap-2 text-[13px] font-medium text-amber-700 dark:text-amber-300">
        <AppIcon name="shield" :size="14" />
        等待确认：{{ approval.toolName }}
      </div>
      <p v-if="approval.reason" class="mt-1 text-[13px]">{{ approval.reason }}</p>
      <p class="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        远程端只展示、不代答，请在桌面窗口确认。
      </p>
    </div>
  </div>
</template>
