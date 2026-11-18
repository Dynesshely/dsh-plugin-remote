<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../lib/api.js'
import { state } from '../lib/store.js'
import { t } from '../lib/i18n.js'
import AppIcon from './AppIcon.vue'
import ComboBox from './ComboBox.vue'

/**
 * Git status tool.
 *
 * Shows the workspace's branch and every changed path, and opens the patch for whichever file is clicked. The
 * data comes from the real `git` binary through `/remote/api/git/status`, so what the panel shows is what the user's own
 * tooling would say.
 */

/** The workspace being inspected. */
const workspaceId = ref('')
/** Every repository found inside the workspace. */
const repos = ref([])
/** The repository being inspected, as an absolute path; empty means "work out from the workspace". */
const repo = ref('')
/** The last status payload. */
const status = ref(undefined)
/** True while a request is in flight. */
const loading = ref(false)
/** Readable failure. */
const error = ref('')
/** The file whose patch is open: `{ path, staged }`. */
const selected = ref(undefined)
/** The patch text for the open file. */
const patch = ref('')
/** True while the patch is loading. */
const patchLoading = ref(false)
/** Failure while reading the patch. */
const patchError = ref('')

/** @returns the repository choices, labelled by their folder inside the workspace. */
const repoChoices = computed(() => repos.value.map((entry) => ({
  value: entry.path,
  name: entry.relative === '' ? t('git.root', { name: entry.name }) : entry.relative,
  description: entry.path,
})))

/** @returns the workspace choices for the picker. */
const workspaces = computed(() => (state.workspaces ?? []).map((workspace) => ({
  value: String(workspace.id),
  name: String(workspace.title ?? workspace.name ?? workspace.id),
  description: String(workspace.path ?? ''),
})))

/** @returns every changed path, staged changes first. */
const files = computed(() => {
  const list = Array.isArray(status.value?.files) ? status.value.files : []
  return [...list].sort((left, right) => {
    const staged = (entry) => (entry.index !== '.' && entry.index !== '?' && entry.index !== ' ' ? 0 : 1)
    return staged(left) - staged(right) || left.path.localeCompare(right.path)
  })
})

/** @returns how many paths are untracked. */
const untrackedCount = computed(() => files.value.filter((file) => file.untracked === true).length)

/** @returns how many paths have staged changes. */
const stagedCount = computed(() => files.value.filter((file) => file.index !== '.' && file.index !== '?' && file.index !== ' ').length)

/**
 * @param file - one changed path.
 * @returns what its two status letters mean.
 *
 * Porcelain v2 reports two independent states — index and worktree — so the label has to read both: `M ` is
 * staged, ` M` is not, `MM` is both.
 */
function describe (file) {
  if (file.conflicted === true) return { label: t('git.conflicted'), tone: 'text-danger' }
  if (file.untracked === true) return { label: t('git.added'), tone: 'text-success' }
  if (file.index === 'R' || file.worktree === 'R') return { label: t('git.renamed'), tone: 'text-primary' }
  if (file.index === 'D' || file.worktree === 'D') return { label: t('git.deleted'), tone: 'text-danger' }
  const staged = file.index !== '.' && file.index !== ' '
  const worktree = file.worktree !== '.' && file.worktree !== ' '
  if (staged && worktree) return { label: t('git.stagedAndUnstaged'), tone: 'text-warning-on' }
  if (staged) return { label: t('git.staged'), tone: 'text-primary' }
  return { label: t('git.unstaged'), tone: 'text-warning-on' }
}

/**
 * Find every repository inside the workspace.
 *
 * A workspace is a folder, not a checkout: several repositories commonly live inside one, so the panel has to ask
 * which one before a status means anything.
 */
async function loadRepos () {
  try {
    const query = new URLSearchParams({ workspaceId: workspaceId.value })
    const payload = await api(`/remote/api/git/repos?${query.toString()}`, { timeoutMs: 30_000 })
    repos.value = Array.isArray(payload.repositories) ? payload.repositories : []
    // Keep the selection when it still exists, otherwise take the first — a workspace root repository first,
    // since that is the common case for a single checkout.
    const existing = repos.value.find((entry) => entry.path === repo.value)
    repo.value = existing !== undefined ? existing.path : (repos.value[0]?.path ?? '')
  } catch (problem) {
    repos.value = []
    repo.value = ''
    error.value = String(problem.message ?? problem)
  }
}

/** Load the chosen repository's status. */
async function load () {
  loading.value = true
  error.value = ''
  selected.value = undefined
  patch.value = ''
  try {
    const query = new URLSearchParams({ workspaceId: workspaceId.value })
    if (repo.value !== '') query.set('repo', repo.value)
    status.value = await api(`/remote/api/git/status?${query.toString()}`, { timeoutMs: 20_000 })
  } catch (problem) {
    error.value = String(problem.message ?? problem)
  } finally {
    loading.value = false
  }
}

/** Switch workspace: rescan for repositories, then load the first one's status. */
async function switchWorkspace (value) {
  workspaceId.value = String(value ?? '')
  repo.value = ''
  await loadRepos()
  await load()
}

/** Switch repository and reload. */
async function switchRepo (value) {
  repo.value = String(value ?? '')
  await load()
}

/**
 * Open one file's patch.
 * @param file - the changed path.
 */
async function showPatch (file) {
  selected.value = { path: file.path, staged: file.index !== '.' && file.index !== '?' && file.index !== ' ' }
  patch.value = ''
  patchError.value = ''
  patchLoading.value = true
  try {
    const query = new URLSearchParams({
      workspaceId: workspaceId.value,
      path: file.path,
      staged: selected.value.staged ? '1' : '0',
    })
    if (repo.value !== '') query.set('repo', repo.value)
    const payload = await api(`/remote/api/git/diff?${query.toString()}`, { timeoutMs: 20_000 })
    if (payload.ok === false) patchError.value = String(payload.error ?? t('git.diffFailed'))
    else patch.value = String(payload.patch ?? '')
  } catch (problem) {
    patchError.value = String(problem.message ?? problem)
  } finally {
    patchLoading.value = false
  }
}

/** Close the patch and go back to the list. */
function closePatch () {
  selected.value = undefined
  patch.value = ''
  patchError.value = ''
}

/**
 * @param line - one line of a unified diff.
 * @returns a class that colours it the way a diff viewer does.
 */
function lineTone (line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-tertiary'
  if (line.startsWith('@@')) return 'text-primary'
  if (line.startsWith('+')) return 'text-success'
  if (line.startsWith('-')) return 'text-danger'
  return 'text-secondary'
}

onMounted(async () => {
  const current = (state.sessions ?? []).find((session) => session.id === state.selected)
  const fromSession = String(current?.workspaceId ?? '')
  const first = (state.workspaces ?? []).find((entry) => String(entry.path ?? '') !== '')
  workspaceId.value = fromSession !== '' ? fromSession : String(first?.id ?? (state.workspaces ?? [])[0]?.id ?? '')
  await loadRepos()
  await load()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex shrink-0 items-center gap-1.5 px-1.5 pt-1 pb-1">
      <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-muted">{{ t('container.git') }}</span>
      <button class="icon-btn h-7 w-7 shrink-0" type="button" :title="t('action.refresh')" @click="load">
        <AppIcon name="refresh" :size="13" />
      </button>
    </header>

    <div class="flex shrink-0 items-center gap-2 px-1.5 pb-1.5 [&_.control]:h-7 [&_.control]:py-0">
      <div class="min-w-[7rem] max-w-[9rem] shrink">
        <ComboBox
          :model-value="workspaceId"
          :items="workspaces"
          icon="layers"
          width="w-full"
          class="w-full"
          @update:model-value="switchWorkspace"
        />
      </div>
      <!-- Which repository: a workspace can hold several, and the status is meaningless until one is chosen. -->
      <div v-if="repoChoices.length > 0" class="min-w-[7rem] max-w-[9rem] shrink">
        <ComboBox
          :model-value="repo"
          :items="repoChoices"
          icon="fork"
          width="w-full"
          class="w-full"
          @update:model-value="switchRepo"
        />
      </div>
      <span v-else-if="!loading" class="min-w-0 flex-1 truncate text-[10px] text-tertiary">{{ t('git.noRepos') }}</span>
    </div>

    <p v-if="error !== ''" class="shrink-0 px-2 pb-1 text-[11px] text-danger">{{ error }}</p>
    <p v-if="loading" class="shrink-0 px-2 pb-1 text-[11px] text-tertiary">{{ t('git.reading') }}</p>

    <!-- Not a repository: a normal answer, not a failure. -->
    <div v-else-if="status !== undefined && status.isRepo === false" class="px-3 py-6 text-center">
      <AppIcon name="layers" :size="20" class="mx-auto mb-2 text-tertiary opacity-60" />
      <p class="text-[12px] text-secondary">{{ status.reason ?? t('git.notRepo') }}</p>
    </div>

    <p v-else-if="status !== undefined && status.ok === false" class="px-2 py-4 text-[11px] text-danger">
      {{ status.error }}
    </p>

    <template v-else-if="status !== undefined">
      <!-- Branch header -->
      <div class="shrink-0 px-2 pb-1.5">
        <div class="flex items-center gap-1.5">
          <AppIcon name="fork" :size="12" class="shrink-0 text-primary" />
          <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-strong">{{ status.branch ?? t('git.noBranch') }}</span>
          <span v-if="status.detached" class="shrink-0 text-[10px] text-warning-on">{{ t('git.detached') }}</span>
        </div>
        <p v-if="status.upstream" class="mt-0.5 pl-5 text-[10px] text-tertiary">
          {{ status.upstream }}
          <span v-if="status.ahead > 0" class="text-success"> ↑{{ status.ahead }}</span>
          <span v-if="status.behind > 0" class="text-warning-on"> ↓{{ status.behind }}</span>
        </p>
        <p class="mt-0.5 pl-5 text-[10px] text-tertiary">
          {{ t('git.summary', { changed: files.length, staged: stagedCount, untracked: untrackedCount }) }}
        </p>
      </div>

      <!-- Patch view -->
      <div v-if="selected !== undefined" class="flex min-h-0 flex-1 flex-col px-1.5 pb-2">
        <div class="mb-1.5 flex shrink-0 items-center gap-1.5">
          <button class="icon-btn h-6 w-6 shrink-0" type="button" :title="t('git.back')" @click="closePatch">
            <AppIcon name="arrowLeft" :size="12" />
          </button>
          <span class="min-w-0 flex-1 truncate text-[11px] text-secondary" :title="selected.path">{{ selected.path }}</span>
        </div>
        <p v-if="patchLoading" class="px-2 text-[11px] text-tertiary">{{ t('git.reading') }}</p>
        <p v-else-if="patchError !== ''" class="px-2 text-[11px] text-danger">{{ patchError }}</p>
        <p v-else-if="patch.trim() === ''" class="px-2 text-[11px] text-tertiary">{{ t('git.noDiff') }}</p>
        <pre v-else class="min-h-0 flex-1 overflow-auto rounded-xl bg-fill-muted px-2 py-1.5 font-mono text-[10px] leading-relaxed"><span
          v-for="(line, index) in patch.split('\n')"
          :key="index"
          class="block"
          :class="lineTone(line)"
        >{{ line }}</span></pre>
      </div>

      <!-- Changed paths -->
      <div v-else class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <p v-if="files.length === 0" class="px-2 py-6 text-center text-[11px] text-tertiary">{{ t('git.clean') }}</p>
        <ul v-else class="space-y-0.5">
          <li v-for="file in files" :key="file.path">
            <button
              type="button"
              class="file-row-button flex w-full items-center gap-1.5 px-1.5 py-1 text-left transition-colors hover:bg-fill-chip active:bg-fill-hover"
              :title="file.from === undefined ? file.path : `${file.from} → ${file.path}`"
              @click="showPatch(file)"
            >
              <AppIcon name="file" :size="12" class="shrink-0 text-tertiary" />
              <span class="min-w-0 flex-1 truncate text-[12px] text-muted">{{ file.path }}</span>
              <span class="shrink-0 text-[10px]" :class="describe(file).tone">{{ describe(file).label }}</span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
