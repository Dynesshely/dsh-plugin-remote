import { computed } from 'vue'
import { state, transcriptItems } from './store.js'
import { t } from './i18n.js'

/**
 * What the agent is doing right now, in words.
 *
 * A single dot said "something is happening" but not what, so a reader watching a slow turn could not tell
 * thinking from running a script. This derives a step from the data the page already has — the live stream for
 * reasoning and text, the transcript for the tool that is still open — and names it.
 *
 * Every step carries an icon so the state is recognisable before the label is read, and `busy` so the caller can
 * put a spinner on it.
 */

/** Tool names whose call means a shell is running, which is worth naming differently from a generic tool. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'sh', 'shell', 'cmd', 'powershell', 'zsh'])

/** @returns the last transcript item, or undefined. */
function lastItem () {
  const items = transcriptItems.value
  return items.length === 0 ? undefined : items[items.length - 1]
}

/**
 * @returns `{ key, label, icon, busy, tone }`, where `tone` matches the shared status vocabulary:
 * `running` while working, `attention` when the reader has to act, `done` when there is nothing left.
 */
export const activity = computed(() => {
  const items = state.pending
  const questions = Array.isArray(items?.questions) ? items.questions.length : 0
  const approvals = Array.isArray(items?.approvals) ? items.approvals.length : 0
  if (questions > 0 || approvals > 0) {
    return { key: 'run.waiting', label: t('run.waiting'), icon: 'help', busy: false, tone: 'attention' }
  }

  if (state.sessionFailed === true || state.streamError !== '') {
    return { key: 'run.failed', label: state.streamError || t('run.failed'), icon: 'info', busy: false, tone: 'failed' }
  }

  if (state.telemetry.running !== true) {
    return { key: 'run.done', label: t('run.done'), icon: 'check', busy: false, tone: 'done' }
  }

  // A tool call that has been issued but has not returned is the strongest signal: it means a process or a
  // request is in flight, which is a different wait from generating text.
  const item = lastItem()
  if (item?.kind === 'tool' && item.result === undefined && item.error === undefined) {
    const name = String(item.name ?? '')
    const key = SHELL_TOOLS.has(name) ? 'run.toolShell' : 'run.tool'
    return { key, label: t(key, { name }), icon: SHELL_TOOLS.has(name) ? 'cpu' : 'wrench', busy: true, tone: 'running' }
  }
  if (item?.kind === 'toolGroup') {
    const children = Array.isArray(item.items) ? item.items : []
    const open = children.find((child) => child.result === undefined && child.error === undefined)
    if (open !== undefined) {
      const name = String(item.name ?? open.name ?? '')
      const key = SHELL_TOOLS.has(name) ? 'run.toolShell' : 'run.tool'
      return { key, label: t(key, { name }), icon: SHELL_TOOLS.has(name) ? 'cpu' : 'wrench', busy: true, tone: 'running' }
    }
  }

  // Reasoning arrives before text; while only reasoning is streaming, the model is thinking rather than writing.
  if (String(state.live?.reasoning ?? '') !== '' && String(state.live?.text ?? '') === '') {
    return { key: 'run.thinking', label: t('run.thinking'), icon: 'brain', busy: true, tone: 'running' }
  }

  return { key: 'run.responding', label: t('run.responding'), icon: 'spark', busy: true, tone: 'running' }
})
