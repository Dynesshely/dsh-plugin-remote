<script setup>
import { state } from '../lib/store.js'
import QuestionCard from './QuestionCard.vue'
import AppIcon from './AppIcon.vue'

/**
 * The dock above the composer: pending questions even when their tool call is scrolled out of the
 * transcript, plus approvals (which the remote side only reports).
 *
 * The question itself is rendered by {@link QuestionCard}, the same component the transcript uses,
 * so both surfaces look and behave identically.
 */
</script>

<template>
  <div
    v-if="state.pending.questions.length > 0 || state.pending.approvals.length > 0"
    class="mx-2 mb-2 space-y-2"
  >
    <QuestionCard
      v-for="question in state.pending.questions"
      :key="question.callId"
      class="rise"
      :questions="question.questions"
      :call-id="question.answerable === false ? '' : question.callId"
      :eyebrow="question.answerable === false ? '提问 · 只能在桌面端作答' : '提问'"
      :elsewhere="question.sessionId !== state.selected"
    />

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
