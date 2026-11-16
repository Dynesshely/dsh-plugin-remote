<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../lib/api.js'
import { codeHtml } from '../lib/highlight.js'
import { renderMarkdown } from '../lib/markdown.js'
import { state } from '../lib/store.js'
import AppIcon from './AppIcon.vue'
import ComboBox from './ComboBox.vue'

/**
 * File preview tool.
 *
 * A browser over one workspace plus a viewer chosen by the file's kind. The viewers are the browser's own —
 * `<img>`, `<video>`, `<audio>`, a PDF frame — because those already handle seeking, zooming and captions
 * correctly; only text and Markdown are rendered here.
 *
 * Binary bytes come from `/api/files/raw`, which sends the right content type and honours Range requests, so a
 * video can seek and a PDF renders inline instead of downloading.
 */

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg'])
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'])
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.mka'])
const TEXT = new Set([
  '.txt', '.log', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue',
  '.css', '.scss', '.html', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.ps1', '.bat', '.cmd', '.py', '.rs', '.go', '.java', '.kt', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.rb', '.php', '.sql', '.csv', '.tsv', '.gitignore', '.env', '.lock',
])

/** Formats a browser will accept a stream for but frequently cannot decode. */
const OFTEN_UNPLAYABLE = new Set(['.mkv', '.avi'])

/** The workspace being browsed. */
const workspaceId = ref('')
/** Current directory, relative to the workspace root. */
const path = ref('')
/** The listing for the current directory. */
const listing = ref(undefined)
/** The file being previewed: `{ name, path, kind }`, or undefined while the list shows. */
const preview = ref(undefined)
/** Text or Markdown body of the previewed file. */
const body = ref('')
/** True while a listing or a file body is in flight. */
const loading = ref(false)
/** Readable failure for the list or the preview. */
const error = ref('')
/** True once the browser reported that it cannot play the file's container. */
const unplayable = ref(false)

/** @returns the workspace root path, for display. */
const workspaceRoot = computed(() => {
  const found = (state.workspaces ?? []).find((entry) => String(entry.id) === workspaceId.value)
  return String(found?.path ?? '').replace(/\\/gu, '/')
})

/** @returns the breadcrumb segments of the current directory, root first. */
const crumbs = computed(() => {
  const trail = [{ name: workspaceRoot.value.split('/').filter((part) => part !== '').pop() ?? '工作区', path: '' }]
  let accumulated = ''
  for (const segment of String(path.value).split('/').filter((part) => part !== '')) {
    accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
    trail.push({ name: segment, path: accumulated })
  }
  return trail
})

/** @returns the workspace choices for the picker. */
const workspaces = computed(() => (state.workspaces ?? []).map((workspace) => ({
  value: String(workspace.id),
  name: String(workspace.title ?? workspace.name ?? workspace.id),
  description: String(workspace.path ?? ''),
})))

/** @returns the lower-cased extension of a file name, including the dot. */
function extensionOf (name) {
  const dot = String(name).lastIndexOf('.')
  return dot < 0 ? '' : String(name).slice(dot).toLowerCase()
}

/**
 * @param name - a file name.
 * @returns which viewer should render it.
 */
function kindOf (name) {
  const extension = extensionOf(name)
  if (IMAGE.has(extension)) return 'image'
  if (extension === '.pdf') return 'pdf'
  if (VIDEO.has(extension)) return 'video'
  if (AUDIO.has(extension)) return 'audio'
  if (extension === '.md') return 'markdown'
  if (TEXT.has(extension)) return 'text'
  return 'unsupported'
}

/** @returns the raw URL for the file being previewed. */
const rawUrl = computed(() => {
  const target = preview.value?.path ?? ''
  const query = new URLSearchParams({ workspaceId: workspaceId.value, path: target })
  return `/api/files/raw?${query.toString()}`
})

/** @returns the workspace-relative path of an entry in the current directory. */
function entryPath (entry) {
  return path.value === '' ? entry.name : `${path.value}/${entry.name}`
}

/** @returns a size in the shortest readable form. */
function formatSize (bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

/**
 * Load one directory.
 * @param target - workspace-relative directory.
 */
async function open (target) {
  loading.value = true
  error.value = ''
  preview.value = undefined
  body.value = ''
  try {
    const query = new URLSearchParams({ workspaceId: workspaceId.value, path: target })
    listing.value = await api(`/api/files?${query.toString()}`, { timeoutMs: 20_000 })
    path.value = String(listing.value.path ?? target)
  } catch (problem) {
    error.value = String(problem.message ?? problem)
  } finally {
    loading.value = false
  }
}

/** Switch workspace and return to its root. */
async function switchWorkspace (value) {
  workspaceId.value = String(value ?? '')
  path.value = ''
  await open('')
}

/**
 * Preview one file.
 * @param entry - the row that was activated.
 */
async function show (entry) {
  if (entry.kind === 'dir') {
    await open(entryPath(entry))
    return
  }
  const kind = kindOf(entry.name)
  preview.value = { name: entry.name, path: entryPath(entry), kind, size: entry.size }
  body.value = ''
  unplayable.value = false
  error.value = ''
  if (kind !== 'markdown' && kind !== 'text') return
  loading.value = true
  try {
    const query = new URLSearchParams({ workspaceId: workspaceId.value, path: preview.value.path })
    const payload = await api(`/api/files/text?${query.toString()}`, { timeoutMs: 20_000 })
    body.value = String(payload.text ?? '')
  } catch (problem) {
    error.value = String(problem.message ?? problem)
  } finally {
    loading.value = false
  }
}

/** Leave the preview and return to the list. */
function back () {
  preview.value = undefined
  body.value = ''
  error.value = ''
  unplayable.value = false
}

/** @returns the rendered Markdown of the previewed file. */
const markdownHtml = computed(() => (preview.value?.kind === 'markdown' ? renderMarkdown(body.value) : ''))

/** @returns highlighted HTML for the previewed text file. */
const codeMarkup = computed(() => {
  if (preview.value?.kind !== 'text') return ''
  const extension = extensionOf(preview.value.name).slice(1)
  const language = extension === 'vue' || extension === 'js' || extension === 'mjs' ? 'javascript' : extension
  return codeHtml(body.value, language)
})

/** The browser reported it cannot decode this container. */
function onMediaError () {
  unplayable.value = true
}

onMounted(async () => {
  // Start on the Session's own workspace, which is what the reader is most likely looking at.
  const current = (state.sessions ?? []).find((session) => session.id === state.selected)
  const fromSession = String(current?.workspaceId ?? '')
  const first = (state.workspaces ?? []).find((entry) => String(entry.path ?? '') !== '')
  workspaceId.value = fromSession !== '' ? fromSession : String(first?.id ?? (state.workspaces ?? [])[0]?.id ?? '')
  await open('')
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex shrink-0 items-center gap-1.5 px-1.5 pt-1 pb-1">
      <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-muted">文件预览</span>
      <button class="icon-btn h-7 w-7 shrink-0" type="button" title="刷新" @click="preview === undefined ? open(path) : show({ name: preview.name, kind: 'file', size: preview.size })">
        <AppIcon name="refresh" :size="13" />
      </button>
    </header>

    <div class="flex shrink-0 items-center gap-2 px-1.5 pb-1.5 [&_.control]:h-7 [&_.control]:py-0">
      <div class="min-w-0 max-w-[11rem] shrink">
        <ComboBox
          :model-value="workspaceId"
          :items="workspaces"
          icon="layers"
          width="w-full"
          class="w-full"
          @update:model-value="switchWorkspace"
        />
      </div>
      <button class="icon-btn h-7 w-7 shrink-0" type="button" title="上一级" :disabled="path === ''" @click="open(path.split('/').slice(0, -1).join('/'))">
        <AppIcon name="arrowUp" :size="13" />
      </button>
    </div>

    <!-- Path row: the same framed location bar the file manager uses. -->
    <div class="flex shrink-0 items-center px-1.5 pb-1">
      <div class="file-path-frame flex min-w-0 flex-1 items-center gap-1">
        <nav class="file-crumbs flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[11px] text-tertiary">
          <template v-for="(crumb, index) in crumbs" :key="crumb.path">
            <AppIcon v-if="index > 0" name="chevronRight" :size="10" class="shrink-0 opacity-60" />
            <button
              type="button"
              class="file-crumb max-w-[9rem] shrink-0 truncate rounded px-1 py-0.5 transition-colors"
              :class="index === crumbs.length - 1 ? 'file-crumb-current' : ''"
              :title="crumb.path"
              @click="open(crumb.path)"
            >
              {{ crumb.name }}
            </button>
          </template>
        </nav>
      </div>
    </div>

    <p v-if="error !== ''" class="shrink-0 px-2 pb-1 text-[11px] text-danger">{{ error }}</p>

    <!-- Preview -->
    <div v-if="preview !== undefined" class="flex min-h-0 flex-1 flex-col px-1.5 pb-2">
      <div class="mb-1.5 flex shrink-0 items-center gap-1.5">
        <button class="icon-btn h-6 w-6 shrink-0" type="button" title="返回列表" @click="back">
          <AppIcon name="arrowLeft" :size="12" />
        </button>
        <span class="min-w-0 flex-1 truncate text-[11px] text-secondary" :title="preview.path">{{ preview.name }}</span>
        <span class="shrink-0 text-[10px] text-tertiary">{{ formatSize(preview.size) }}</span>
        <a class="icon-btn h-6 w-6 shrink-0" :href="rawUrl" download :title="'下载'">
          <AppIcon name="download" :size="12" />
        </a>
      </div>

      <div class="min-h-0 flex-1 overflow-auto rounded-xl bg-fill-muted">
        <img
          v-if="preview.kind === 'image'"
          :src="rawUrl"
          :alt="preview.name"
          class="mx-auto block max-h-full max-w-full object-contain"
        />

        <iframe
          v-else-if="preview.kind === 'pdf'"
          :src="rawUrl"
          :title="preview.name"
          class="h-full min-h-[24rem] w-full rounded-xl border-0 bg-white"
        />

        <div v-else-if="preview.kind === 'video'" class="flex h-full flex-col">
          <video
            :src="rawUrl"
            controls
            preload="metadata"
            class="mx-auto max-h-full w-full"
            @error="onMediaError"
          />
          <p v-if="unplayable" class="shrink-0 px-2 py-1 text-[10px] text-warning-on">
            这个视频容器浏览器无法解码（{{ preview.name.split('.').pop() }}）。可以用上面的下载按钮本地播放。
          </p>
        </div>

        <audio
          v-else-if="preview.kind === 'audio'"
          :src="rawUrl"
          controls
          preload="metadata"
          class="w-full px-2 py-2"
          @error="onMediaError"
        />

        <div
          v-else-if="preview.kind === 'markdown'"
          class="md px-3 py-2 text-[13px]"
          v-html="markdownHtml"
        />

        <pre
          v-else-if="preview.kind === 'text'"
          class="px-3 py-2 font-mono text-[11px] leading-relaxed"
          v-html="codeMarkup"
        />

        <p v-else class="px-3 py-6 text-center text-[11px] text-tertiary">
          这个类型还没有预览，可以用上面的下载按钮打开。
        </p>

        <p v-if="loading" class="px-3 py-2 text-[11px] text-tertiary">读取中…</p>
      </div>
    </div>

    <!-- List -->
    <div v-else class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
      <p v-if="loading" class="px-2 py-2 text-[11px] text-tertiary">读取中…</p>
      <p v-else-if="(listing?.entries ?? []).length === 0" class="px-2 py-6 text-center text-[11px] text-tertiary">
        这个目录是空的。
      </p>
      <ul v-else class="space-y-0.5">
        <li v-for="entry in listing.entries" :key="entry.name">
          <button
            type="button"
            class="file-row-button flex w-full items-center gap-1.5 px-1.5 py-1 text-left transition-colors hover:bg-fill-chip active:bg-fill-hover"
            @dblclick="show(entry)"
            @click="show(entry)"
          >
            <AppIcon
              :name="entry.kind === 'dir' ? 'folder' : 'file'"
              :size="12"
              class="shrink-0"
              :class="entry.kind === 'dir' ? 'text-primary' : 'text-tertiary'"
            />
            <span class="min-w-0 flex-1 truncate text-[12px] text-muted">{{ entry.name }}</span>
            <span v-if="entry.kind === 'file'" class="shrink-0 text-[10px] text-tertiary">{{ formatSize(entry.size) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
