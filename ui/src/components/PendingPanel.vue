<script setup>
import { state } from '../lib/store.js'
import QuestionCard from './QuestionCard.vue'
import AppIcon from './AppIcon.vue'
import { t } from '../lib/i18n.js'

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
      :eyebrow="question.answerable === false ? t('pending.eyebrowDesktop') : t('question.eyebrow')"
      :elsewhere="question.sessionId !== state.selected"
    />

    <div
      v-for="approval in state.pending.approvals"
      :key="approval.key"
      class="card rise border-warning-on bg-warning-soft p-3 border-warning-on bg-warning-soft"
    >
      <div class="flex items-center gap-2 text-[13px] font-medium text-warning-on text-warning-on">
        <AppIcon name="shield" :size="14" />
        {{ t('pending.approval', { name: approval.toolName }) }}
      </div>
      <p v-if="approval.reason" class="mt-1 text-[13px]">{{ approval.reason }}</p>
      <p class="mt-1 text-[11px] text-secondary">
        {{ t('pending.approvalHint') }}
      </p>
    </div>
  </div>
</template>
