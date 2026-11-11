<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { api } from '../lib/api.js'
import { codeHtml } from '../lib/highlight.js'
import { renderMarkdown } from '../lib/markdown.js'
import { mobileLayout as mobile } from '../lib/layout.js'
import { state } from '../lib/store.js'
import AppIcon from './AppIcon.vue'
import ComboBox from './ComboBox.vue'

/**
 * The name shown above the panel's own controls.
 *
 * Passed in rather than hard-coded: the tab strip already knows what this tab hosts, and two different names
 * for one panel is how the header and the tab drift apart.
 */
const props = defineProps({
  title: { type: String, default: '文件资源管理器' },
})

/**
 * Workspace file manager.
 *
 * Everything goes through the Host: the page has no filesystem access, and the Host resolves every path
 * inside a workspace root. The list doubles as the preview surface — clicking a name opens it — so the
 * panel never grows a second navigation layer.
 */
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico'])
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv'])
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'])
const MARKDOWN = new Set(['.md', '.markdown'])
const OFFICE_WORD = new Set(['.docx'])
const OFFICE_SHEET = new Set(['.xlsx', '.xls'])

/** The workspace being browsed; starts at the one the open Session belongs to. */
const workspaceId = ref('')
const path = ref('')
const listing = ref(undefined)
/**
 * 分片挂载的行数窗口。
 *
 * 实测（headless Chrome + 心跳探针）：500 行的目录点开后首帧 stall 41ms，其中「Vue 挂载 500 行 +
 * 500 个 AppIcon 组件」这一步同步就占 39ms，Layout/Paint 再多 12+9ms。首帧只挂 80 行、其余每帧追加
 * 120 行之后，这段同步长任务被摊到几帧里，首帧回到 10ms 级；行本身再加 `content-visibility: auto`，
 * 屏幕外的行不参与布局与绘制。
 */
const rowLimit = ref(0)
/** 首屏挂载的行数。 */
const ROW_FIRST_BATCH = 60
/** 之后每一帧追加的行数（一帧不超过 100 行：实测 200 行/帧仍会留下一段 ~35ms 的长任务）。 */
const ROW_BATCH_STEP = 100
/** 还在排队的分片追加帧。 */
let rowGrowFrame
/** 当前真正渲染的行（分片窗口）。 */
const visibleEntries = computed(() => (listing.value?.entries ?? []).slice(0, rowLimit.value))
const loading = ref(false)
const error = ref('')
/**
 * Names of the selected rows.
 *
 * A Set, not an array: the row template asks "is this selected?" once per row, so an array made every
 * render O(rows²) and a marquee drag over a 500-entry directory locked the page.
 */
const selection = ref(new Set())
/** The rubber band, in list coordinates, while the reader drags over empty space. */
const marquee = ref(undefined)
const listBox = ref(null)
/** The open preview, or undefined while the list is showing. */
const preview = ref(undefined)
/** Full-screen preview. */
const fullscreen = ref(false)
const busy = ref('')
/** One pending dialog: a name prompt, or a destructive confirmation. */
const ask = ref(undefined)
/** What is waiting to be pasted elsewhere: `{ mode: 'copy' | 'move', path, name }`. */
const clip = ref(undefined)

/** The workspace list, for the switcher. */
const workspaces = computed(() => (state.workspaces ?? []).map((workspace) => ({
  value: String(workspace.id),
  name: String(workspace.title ?? workspace.name ?? workspace.id),
})))

/** The workspace the open Session belongs to. */
const sessionWorkspace = computed(() => {
  const session = state.sessions.find((candidate) => candidate.id === state.selected)
  return String(session?.workspaceId ?? '')
})

/** The absolute directory of the workspace being browsed. */
const workspaceRoot = computed(() => {
  const found = (state.workspaces ?? []).find((entry) => String(entry.id) === workspaceId.value)
  return String(found?.path ?? '').replace(/\\/gu, '/')
})

/** Separators normalised, trailing slash dropped: absolute paths are compared, not displayed. */
function normalisePath (value) {
  return String(value ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '')
}

/**
 * @returns every path segment from the drive down to the current directory, each flagged with the workspace
 * it belongs to and the workspace-relative path to open.
 *
 * A breadcrumb that starts at the workspace root hides where the files actually live, and the file manager is
 * the one place in this app where knowing the real directory matters. So the trail starts at the drive letter:
 * segments above the workspace are shown for orientation and are only clickable when another workspace covers
 * them, while segments at or below the root open a relative path as usual.
 */
const crumbs = computed(() => {
  const root = workspaceRoot.value
  const relative = normalisePath(path.value)
  if (root === '') {
    // No workspace path known: fall back to the relative trail, still showing every segment.
    const trail = [{ name: listing.value?.root?.name ?? '工作区', path: '', absolute: '', inside: true }]
    let accumulated = ''
    for (const segment of relative.split('/').filter((part) => part !== '')) {
      accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
      trail.push({ name: segment, path: accumulated, absolute: accumulated, inside: true })
    }
    return trail
  }
  const rootSegments = root.split('/').filter((part) => part !== '')
  const trail = []
  let accumulated = ''
  for (const segment of rootSegments) {
    accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
    trail.push({
      name: segment,
      path: '',
      absolute: accumulated,
      inside: accumulated.length >= root.length,
    })
  }
  let relativePath = ''
  for (const segment of relative.split('/').filter((part) => part !== '')) {
    relativePath = relativePath === '' ? segment : `${relativePath}/${segment}`
    trail.push({ name: segment, path: relativePath, absolute: `${root}/${relativePath}`, inside: true })
  }
  return trail
})

/** The full absolute path of what the list is showing, for the editable field and for copying. */
const absolutePath = computed(() => {
  const root = workspaceRoot.value
  const relative = normalisePath(path.value)
  if (root === '') return relative
  return relative === '' ? root : `${root}/${relative}`
})

/** The editor element, focused when the row switches into text mode. */
const pathInput = ref(null)

/** True while the path is being edited as text instead of shown as a breadcrumb. */
const editingPath = ref(false)
/** The draft in the editor, seeded from the current absolute path. */
const pathDraft = ref('')

/** Switch the breadcrumb into a text field holding the absolute path. */
async function beginPathEdit () {
  pathDraft.value = absolutePath.value
  editingPath.value = true
  // Select the whole value: replacing a directory name should not require deleting the old one first.
  await nextTick()
  pathInput.value?.focus()
  pathInput.value?.select()
}

/**
 * Resolve an absolute (or workspace-relative) path to a workspace plus a relative path.
 * @param value - what the user typed.
 * @returns the target, or undefined when no workspace contains it.
 *
 * The file API only speaks `workspaceId + relative path`, so a typed absolute path is matched against the
 * workspaces the client already has: the deepest workspace that contains it wins, and anything above every
 * workspace is refused rather than guessed at.
 */
function resolvePath (value) {
  const typed = normalisePath(value.trim())
  if (typed === '') return { workspaceId: workspaceId.value, relative: '' }
  let best
  for (const workspace of state.workspaces ?? []) {
    const root = normalisePath(workspace.path)
    if (root === '') continue
    if (typed !== root && !typed.startsWith(`${root}/`)) continue
    if (best === undefined || root.length > best.root.length) {
      best = { workspaceId: String(workspace.id), root, relative: typed.slice(root.length).replace(/^\//u, '') }
    }
  }
  if (best !== undefined) return { workspaceId: best.workspaceId, relative: best.relative }
  // A relative path is still useful: it means "inside the workspace I am already showing".
  if (!/^[A-Za-z]:/u.test(typed) && !typed.startsWith('/')) {
    return { workspaceId: workspaceId.value, relative: typed }
  }
  return undefined
}

/** Apply the typed path, or explain why it cannot be reached. */
async function commitPathEdit () {
  // Enter hides the field, which fires blur, which would land here again. The first call owns the commit.
  if (!editingPath.value) return
  const target = resolvePath(pathDraft.value)
  editingPath.value = false
  if (target === undefined) {
    error.value = `无法定位：${pathDraft.value} 不在任何工作区内`
    return
  }
  error.value = ''
  if (target.workspaceId !== workspaceId.value) {
    workspaceId.value = target.workspaceId
  }
  await open(target.relative)
}

/** Abandon the edit without touching the listing. */
function cancelPathEdit () {
  // Mark it handled first: hiding the field fires blur, and that must not turn a cancel into a commit.
  editingPath.value = false
}

/**
 * Follow one breadcrumb segment.
 * @param crumb - the segment.
 *
 * Segments at or below the workspace open a relative path. A segment above the workspace is only followed when
 * another workspace starts exactly there, so a click never lands outside what the file API can serve.
 */
async function openCrumb (crumb) {
  if (crumb.inside) {
    await open(crumb.path)
    return
  }
  const match = (state.workspaces ?? []).find(
    (workspace) => normalisePath(workspace.path) === normalisePath(crumb.absolute),
  )
  if (match === undefined) return
  workspaceId.value = String(match.id)
  await open('')
}

/** @returns a size in the shortest readable form. */
function formatSize (bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

/** @returns whether a row is selected. */
function isSelected (entry) {
  return selection.value.has(entry.name)
}

/** Select exactly one row. */
function selectOnly (entry) {
  selection.value = new Set([entry.name])
}

/** @returns whether anything is selected. */
const hasSelection = computed(() => selection.value.size > 0)
/** @returns the selected entries, resolved against the current listing. */
const selectedEntries = computed(() => (listing.value?.entries ?? []).filter((entry) => isSelected(entry)))

/**
 * Act on a row: a single click selects it, a double click opens it. Touch has no double click, so there a
 * single tap opens, which is what a phone expects.
 * @param entry - the row.
 */
function tapRow (entry) {
  selectOnly(entry)
  // Phones have no double click, so a tap has to open. With a pointer, opening is the double click and a
  // single click is selection only — otherwise the first click of a double click would already navigate.
  if (mobile.value) void activate(entry)
}

/** @returns the workspace-relative path of an entry. */
function entryPath (entry) {
  return path.value === '' ? entry.name : `${path.value}/${entry.name}`
}

/** @returns the raw URL for one file, optionally as a download. */
function rawUrl (target) {
  const query = new URLSearchParams({ workspaceId: workspaceId.value, path: target })
  return `/api/files/raw?${query.toString()}`
}

/** Visited locations, oldest first, with the cursor pointing at the one on screen. */
const history = ref([])
const historyIndex = ref(-1)
/** True while stepping through history, so the resulting `open` does not push a new entry. */
let historyLock = false

/** Remember where the listing landed, unless it is already the current entry. */
function recordHistory () {
  if (historyLock) return
  const snapshot = { workspaceId: workspaceId.value, path: path.value }
  const current = history.value[historyIndex.value]
  if (current !== undefined && current.workspaceId === snapshot.workspaceId && current.path === snapshot.path) return
  // Going somewhere new discards the forward branch, which is what a browser does too.
  history.value = [...history.value.slice(0, historyIndex.value + 1), snapshot]
  historyIndex.value = history.value.length - 1
}

const canGoBack = computed(() => historyIndex.value > 0)
const canGoForward = computed(() => historyIndex.value < history.value.length - 1)
/** The host reports `parent` only when the directory has one above it. */
const canGoUp = computed(() => listing.value?.parent !== undefined)

/**
 * Step to one entry in the history.
 * @param index - the entry to show.
 */
async function goToHistory (index) {
  const target = history.value[index]
  if (target === undefined) return
  historyLock = true
  historyIndex.value = index
  try {
    if (target.workspaceId !== workspaceId.value) workspaceId.value = target.workspaceId
    await open(target.path)
  } finally {
    historyLock = false
  }
}

function goBack () {
  if (canGoBack.value) void goToHistory(historyIndex.value - 1)
}

function goForward () {
  if (canGoForward.value) void goToHistory(historyIndex.value + 1)
}

/** Go to the parent directory. This is a real navigation, so it is recorded like any other. */
async function goUp () {
  const parent = listing.value?.parent
  if (parent === undefined) return
  await open(parent)
}

/** Load one directory. */
async function open (target) {
  loading.value = true
  error.value = ''
  preview.value = undefined
  selection.value = new Set()
  try {
    const query = new URLSearchParams({ workspaceId: workspaceId.value, path: target })
    listing.value = await api(`/api/files?${query.toString()}`, { timeoutMs: 20_000 })
    path.value = String(listing.value.path ?? target)
    // 目录出现这一帧只挂首批行，剩下的分帧补：500 行一次性 patch 是一段 40ms 的同步长任务。
    rowLimit.value = Math.min(listing.value?.entries?.length ?? 0, ROW_FIRST_BATCH)
    scheduleRowGrow()
    recordHistory()
  } catch (problem) {
    error.value = String(problem.message ?? problem)
  } finally {
    loading.value = false
  }
}

/** 分帧把剩下的行挂上。 */
function growRows () {
  const total = listing.value?.entries?.length ?? 0
  if (rowLimit.value >= total) {
    rowGrowFrame = undefined
    return
  }
  rowLimit.value = Math.min(total, rowLimit.value + ROW_BATCH_STEP)
  rowGrowFrame = requestAnimationFrame(growRows)
}

/** 起跑行分片；切目录时先取消上一轮还没跑完的追加。 */
function scheduleRowGrow () {
  if (rowGrowFrame !== undefined) {
    cancelAnimationFrame(rowGrowFrame)
    rowGrowFrame = undefined
  }
  if (rowLimit.value >= (listing.value?.entries?.length ?? 0)) return
  rowGrowFrame = requestAnimationFrame(growRows)
}

/**
 * @returns the preview mode for a file, from its extension.
 */
function modeOf (name) {
  const dot = String(name).lastIndexOf('.')
  const extension = dot < 0 ? '' : String(name).slice(dot).toLowerCase()
  if (IMAGE.has(extension)) return { kind: 'image', extension }
  if (VIDEO.has(extension)) return { kind: 'video', extension }
  if (AUDIO.has(extension)) return { kind: 'audio', extension }
  if (extension === '.pdf') return { kind: 'pdf', extension }
  if (MARKDOWN.has(extension)) return { kind: 'markdown', extension }
  if (OFFICE_WORD.has(extension)) return { kind: 'docx', extension }
  if (OFFICE_SHEET.has(extension)) return { kind: 'sheet', extension }
  return { kind: 'text', extension }
}

/** Open one entry: directories navigate, files preview. */
async function activate (entry) {
  selection.value = new Set([entry.name])
  const target = entryPath(entry)
  if (entry.kind === 'dir') {
    await open(target)
    return
  }
  const mode = modeOf(entry.name)
  const base = { path: target, name: entry.name, size: entry.size, kind: mode.kind, loading: true }
  preview.value = base
  if (mode.kind === 'image' || mode.kind === 'video' || mode.kind === 'audio' || mode.kind === 'pdf') {
    preview.value = { ...base, loading: false, src: rawUrl(target) }
    return
  }
  if (mode.kind === 'docx') {
    try {
      const response = await fetch(rawUrl(target))
      const blob = await response.blob()
      const container = document.createElement('div')
      const { renderAsync } = await import('docx-preview')
      await renderAsync(blob, container)
      preview.value = { ...base, loading: false, kind: 'html', html: container.innerHTML }
    } catch (problem) {
      preview.value = { ...base, loading: false, kind: 'opaque', error: String(problem?.message ?? problem) }
    }
    return
  }
  if (mode.kind === 'sheet') {
    try {
      const response = await fetch(rawUrl(target))
      const buffer = await response.arrayBuffer()
      const { read, utils } = await import('xlsx')
      const book = read(buffer, { type: 'array' })
      const sheet = book.Sheets[book.SheetNames[0]]
      preview.value = { ...base, loading: false, kind: 'html', html: utils.sheet_to_html(sheet) }
    } catch (problem) {
      preview.value = { ...base, loading: false, kind: 'opaque', error: String(problem?.message ?? problem) }
    }
    return
  }
  try {
    const query = new URLSearchParams({ workspaceId: workspaceId.value, path: target })
    const payload = await api(`/api/files/text?${query.toString()}`, { timeoutMs: 20_000 })
    const text = String(payload.text ?? '')
    if (mode.kind === 'markdown') {
      preview.value = { ...base, loading: false, kind: 'html', html: renderMarkdown(text), size: payload.size }
    } else {
      preview.value = {
        ...base,
        loading: false,
        kind: 'code',
        size: payload.size,
        truncated: payload.truncated === true,
        html: codeHtml(text),
        lines: text.split('\n').length,
      }
    }
  } catch (problem) {
    preview.value = { ...base, loading: false, kind: 'opaque', error: String(problem.message ?? problem) }
  }
}

/** Reload whatever is on screen. */
function reload () {
  preview.value = undefined
  void open(path.value)
}

/**
 * Ask for a name in the panel's own dialog, which matches the rest of the UI.
 * @param title - what is being named.
 * @param initial - the value to start from.
 * @param confirmLabel - the verb on the button.
 * @param onConfirm - called with the trimmed name.
 */
function openPrompt (title, initial, confirmLabel, onConfirm) {
  ask.value = { mode: 'prompt', title, value: initial ?? '', confirmLabel, onConfirm }
}

/**
 * @param message - the question.
 * @param onConfirm - called when the reader agrees.
 */
function openConfirm (message, onConfirm) {
  ask.value = { mode: 'confirm', title: '请确认', message, confirmLabel: '删除', onConfirm }
}

/** Apply the pending dialog. */
function submitAsk () {
  const pending = ask.value
  if (pending === undefined) return
  const value = pending.mode === 'prompt' ? String(pending.value ?? '').trim() : ''
  if (pending.mode === 'prompt' && value === '') return
  ask.value = undefined
  pending.onConfirm(value)
}

/** Dismiss the pending dialog. */
function cancelAsk () {
  ask.value = undefined
}

/** Apply one mutation and reload the directory. */
async function mutate (action, body) {
  busy.value = action
  error.value = ''
  try {
    await api('/api/files', {
      method: 'POST',
      timeoutMs: 60_000,
      body: { workspaceId: workspaceId.value, action, ...body },
    })
    await open(path.value)
  } catch (problem) {
    error.value = String(problem.message ?? problem)
  } finally {
    busy.value = ''
  }
}

/** Create a folder or an empty file in the current directory. */
function create (kind) {
  openPrompt(kind === 'dir' ? '新建文件夹' : '新建文件', '', '创建', (name) => {
    const target = path.value === '' ? name : `${path.value}/${name}`
    void mutate(kind === 'dir' ? 'mkdir' : 'create', { path: target })
  })
}

/** Rename the selected entry. */
function renameSelected () {
  const entry = selectedEntries.value.length === 1 ? selectedEntries.value[0] : undefined
  if (entry === undefined) return
  openPrompt('重命名', entry.name, '确定', (name) => {
    if (name === entry.name) return
    const to = path.value === '' ? name : `${path.value}/${name}`
    void mutate('rename', { path: entryPath(entry), to })
  })
}

/** Delete the selected entry, after a confirmation that names it. */
async function deleteSelected () {
  const entries = selectedEntries.value
  if (entries.length === 0) return
  const label = entries.length === 1
    ? `${entries[0].kind === 'dir' ? '文件夹及其全部内容' : '文件'}「${entries[0].name}」`
    : `${String(entries.length)} 个条目`
  openConfirm(`删除${label}？这个操作不可撤销。`, () => {
    void (async () => {
      for (const entry of entries) {
        await mutate('delete', { path: entryPath(entry), recursive: entry.kind === 'dir' })
      }
    })()
  })
}

/** Remember the selected entry, to paste into another directory. */
function clipSelected (mode) {
  const entries = selectedEntries.value
  if (entries.length === 0) return
  clip.value = {
    mode,
    items: entries.map((entry) => ({ path: entryPath(entry), name: entry.name })),
  }
}

/** Paste the remembered entry into the directory on screen. */
async function pasteHere () {
  const pending = clip.value
  if (pending === undefined) return
  for (const item of pending.items) {
    const target = path.value === '' ? item.name : `${path.value}/${item.name}`
    // Pasting into its own directory is a no-op, not an error.
    if (target === item.path) continue
    await mutate(pending.mode === 'copy' ? 'copy' : 'move', { path: item.path, to: target })
  }
  if (pending.mode === 'move') clip.value = undefined
}

/** The frame that will re-run the hit test, if one is scheduled. */
let bandFrame
/** The previous hit set, so an unchanged selection is never written again. */
let bandKey = ''

/**
 * Start a rubber band from the blank area under the list.
 *
 * Every row's geometry is measured **once**, here. Measuring inside the drag loop forced a synchronous
 * layout per row per frame, which is what made the page stop responding.
 */
function startMarquee (event) {
  const box = listBox.value
  if (box === null) return
  const rect = box.getBoundingClientRect()
  const rows = []
  for (const row of box.querySelectorAll('[data-entry]')) {
    const name = row.getAttribute('data-entry')
    if (name === null) continue
    const rowRect = row.getBoundingClientRect()
    rows.push({
      name,
      top: rowRect.top - rect.top + box.scrollTop,
      bottom: rowRect.bottom - rect.top + box.scrollTop,
      left: rowRect.left - rect.left,
      right: rowRect.right - rect.left,
    })
  }
  marquee.value = {
    x0: event.clientX - rect.left,
    y0: event.clientY - rect.top + box.scrollTop,
    x1: event.clientX - rect.left,
    y1: event.clientY - rect.top + box.scrollTop,
    rows,
  }
  bandKey = ''
  event.currentTarget.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

/** Grow the band: the overlay follows the pointer, the hit test is batched into one frame. */
function moveMarquee (event) {
  const band = marquee.value
  const box = listBox.value
  if (band === undefined || box === null) return
  const rect = box.getBoundingClientRect()
  band.x1 = event.clientX - rect.left
  band.y1 = event.clientY - rect.top + box.scrollTop
  if (bandFrame !== undefined) return
  bandFrame = requestAnimationFrame(() => {
    bandFrame = undefined
    applyBand()
  })
}

/** Recompute the selection from the cached geometry. */
function applyBand () {
  const band = marquee.value
  if (band === undefined) return
  const left = Math.min(band.x0, band.x1)
  const right = Math.max(band.x0, band.x1)
  const top = Math.min(band.y0, band.y1)
  const bottom = Math.max(band.y0, band.y1)
  const hit = []
  for (const row of band.rows) {
    if (row.bottom < top || row.top > bottom || row.right < left || row.left > right) continue
    hit.push(row.name)
  }
  hit.sort()
  const key = hit.join('\n')
  if (key === bandKey) return
  bandKey = key
  selection.value = new Set(hit)
}

/** Finish the rubber band. */
function endMarquee () {
  if (bandFrame !== undefined) {
    cancelAnimationFrame(bandFrame)
    bandFrame = undefined
  }
  applyBand()
  marquee.value = undefined
}

/** @returns the band's style, for the overlay. */
const marqueeStyle = computed(() => {
  const band = marquee.value
  if (band === undefined) return undefined
  return {
    left: `${String(Math.min(band.x0, band.x1))}px`,
    top: `${String(Math.min(band.y0, band.y1))}px`,
    width: `${String(Math.abs(band.x1 - band.x0))}px`,
    height: `${String(Math.abs(band.y1 - band.y0))}px`,
  }
})

/**
 * @returns 失败响应里的可读原因；正文不是 JSON 时退回状态码。
 */
async function failureText (response) {
  try {
    const payload = await response.json()
    if (typeof payload?.error === 'string' && payload.error !== '') return payload.error
  } catch {
    /* 代理截断或空正文：退回状态码即可，不要再抛一次错把真正的原因盖掉 */
  }
  return `HTTP ${String(response.status)}`
}

/**
 * 上传一个文件：请求体直接是 `File` 对象。
 *
 * 旧实现先 `readAsDataURL`（12MB 文件约 16MB base64 字符串）再 `JSON.stringify` 交给 `api()`，
 * 这两步都在主线程上跑，几百毫秒起步，还要多占几十 MB 临时内存。改用 `fetch(..., { body: file })`
 * 后字节由浏览器直接流式发出，页面不经过 base64、也不拼 JSON。路径仍交给宿主用 `inside()` 校验。
 * @param file - 待上传的文件。
 */
async function uploadOne (file) {
  const target = path.value === '' ? file.name : `${path.value}/${file.name}`
  const query = new URLSearchParams({ workspaceId: workspaceId.value, path: target })
  let response
  try {
    response = await fetch(`/api/files/upload?${query.toString()}`, {
      method: 'POST',
      // 自定义头让跨源请求必须走预检，宿主不会放行；同源请求不受影响。
      headers: { 'x-rc': '1' },
      body: file,
      signal: AbortSignal.timeout(120_000),
    })
  } catch (problem) {
    if (problem?.name === 'TimeoutError') throw new Error('请求超时，请重试')
    throw new Error('无法连接到宿主，请检查网络')
  }
  if (response.status === 401) throw new Error('登录已失效，请重新打开带令牌的链接')
  if (!response.ok) throw new Error(await failureText(response))
}

/** Upload files into the current directory. */
async function upload (input) {
  const files = Array.from(input?.files ?? [])
  input.value = ''
  if (files.length === 0) return
  busy.value = 'upload'
  error.value = ''
  /** 第一个失败文件的原因；一个失败不影响其余文件，最后统一报出来。 */
  let failure = ''
  try {
    for (const file of files) {
      try {
        await uploadOne(file)
      } catch (problem) {
        if (failure === '') failure = `${file.name} 上传失败：${String(problem?.message ?? problem)}`
      }
    }
  } finally {
    // 一批只刷新一次列表：多文件上传不必每个文件都重建一遍目录。
    await open(path.value)
    if (failure !== '') error.value = failure
    busy.value = ''
  }
}

/** Switch workspace, keeping the panel on its root. */
async function switchWorkspace (value) {
  workspaceId.value = String(value ?? '')
  path.value = ''
  await open('')
}

/** Jump back to the workspace of the Session currently open. */
async function jumpToSession () {
  const target = sessionWorkspace.value
  if (target === '' ) return
  workspaceId.value = target
  path.value = ''
  await open('')
}

onMounted(() => {
  workspaceId.value = sessionWorkspace.value
  void open('')
})

// Following the Session means the panel lands on the right workspace after a switch.
watch(() => state.selected, () => {
  const target = sessionWorkspace.value
  if (target === '' || target === workspaceId.value) return
  workspaceId.value = target
  path.value = ''
  void open('')
})
</script>

<template>
  <div class="file-pane relative flex h-full min-h-0 flex-col" :class="fullscreen ? 'fixed inset-0 z-[135] bg-white/95 p-3 backdrop-blur-xl bg-fill-solid' : ''">
    <!-- Title line: the panel's name and its own two actions. -->
    <header class="flex shrink-0 items-center gap-1.5 px-1.5 pt-1 pb-1">
      <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-muted">{{ title }}</span>
      <button class="icon-btn h-7 w-7 shrink-0" type="button" title="回到当前会话的工作区" @click="jumpToSession">
        <AppIcon name="pin" :size="13" />
      </button>
      <button class="icon-btn h-7 w-7 shrink-0" type="button" title="刷新" @click="reload">
        <AppIcon name="refresh" :size="13" />
      </button>
    </header>

    <!--
      Workspace selector and the eight actions share one row: three that create content, a divider, then
      five that act on the selection. The selector yields width first, so the buttons never shrink or wrap.
    -->
    <div class="flex shrink-0 items-center gap-1.5 px-1.5 pb-1.5 [&_.control]:h-7 [&_.control]:py-0">
      <div class="min-w-0 flex-1">
        <ComboBox
          :model-value="workspaceId"
          :items="workspaces"
          icon="layers"
          width="w-full"
          class="w-full"
          @update:model-value="switchWorkspace"
        />
      </div>
      <!-- Icon-only: the panel is narrow, and labelled chips would push the selector off the row. -->
      <button class="icon-btn h-7 w-7" type="button" title="新建文件夹" aria-label="新建文件夹" :disabled="busy !== ''" @click="create('dir')">
        <AppIcon name="folder" :size="13" />
      </button>
      <button class="icon-btn h-7 w-7" type="button" title="新建文件" aria-label="新建文件" :disabled="busy !== ''" @click="create('file')">
        <AppIcon name="file" :size="13" />
      </button>
      <label
        class="icon-btn h-7 w-7 cursor-pointer"
        :class="busy !== '' ? 'pointer-events-none opacity-40' : ''"
        title="上传文件"
        aria-label="上传文件"
      >
        <AppIcon name="paperclip" :size="13" />
        <input type="file" multiple class="hidden" :disabled="busy !== ''" @change="upload($event.target)" />
      </label>
      <span class="mx-0.5 h-4 w-px shrink-0 bg-outline-variant" />
      <button class="icon-btn h-7 w-7" type="button" title="重命名" aria-label="重命名" :disabled="busy !== '' || selection.size !== 1" @click="renameSelected">
        <AppIcon name="pencil" :size="13" />
      </button>
      <button class="icon-btn h-7 w-7" type="button" title="复制" aria-label="复制" :disabled="busy !== '' || !hasSelection" @click="clipSelected('copy')">
        <AppIcon name="copy" :size="13" />
      </button>
      <button class="icon-btn h-7 w-7" type="button" title="剪切" aria-label="剪切" :disabled="busy !== '' || !hasSelection" @click="clipSelected('move')">
        <AppIcon name="cut" :size="13" />
      </button>
      <button
        class="icon-btn h-7 w-7"
        type="button"
        :title="clip === undefined ? '粘贴（剪贴板为空）' : `粘贴 ${String(clip.items.length)} 项`"
        aria-label="粘贴"
        :disabled="busy !== '' || clip === undefined"
        @click="pasteHere"
      >
        <AppIcon name="file" :size="13" />
      </button>
      <button class="icon-btn h-7 w-7 text-danger" type="button" title="删除" aria-label="删除" :disabled="busy !== '' || !hasSelection" @click="deleteSelected">
        <AppIcon name="trash" :size="13" />
      </button>
    </div>

    <!--
      Path row: a breadcrumb and a path field for the same value.

      The breadcrumb is for reading and stepping; the field is for jumping, pasting a path from elsewhere, or
      reading the full location without hovering. Both always show the absolute path, because this panel is
      the one place in the app where the real directory — not the workspace-relative one — is the thing the
      reader is trying to find out.
    -->
    <!--
      Path row: one bordered field, full width.

      The frame belongs to the row rather than to a separate edit button: the whole bar is the affordance, so
      clicking any blank part of it starts editing — the same thing the pointer already looks like it should do
      in a location bar. A breadcrumb segment still navigates on its own click and never starts an edit.
    -->
    <div
      v-if="preview === undefined"
      class="file-path-row flex shrink-0 items-center gap-0.5 px-1.5 pt-1.5 pb-1"
      @click.self="beginPathEdit"
    >
      <!-- Navigation sits on the same line as the path, at its leading edge. -->
      <div class="flex shrink-0 items-center gap-0.5">
        <button
          class="icon-btn h-7 w-7 shrink-0"
          type="button"
          title="上一级目录"
          aria-label="上一级目录"
          :disabled="!canGoUp"
          @click="goUp"
        >
          <AppIcon name="arrowUp" :size="13" />
        </button>
        <button
          class="icon-btn h-7 w-7 shrink-0"
          type="button"
          title="返回"
          aria-label="返回"
          :disabled="!canGoBack"
          @click="goBack"
        >
          <AppIcon name="arrowLeft" :size="13" />
        </button>
        <button
          class="icon-btn h-7 w-7 shrink-0"
          type="button"
          title="前进"
          aria-label="前进"
          :disabled="!canGoForward"
          @click="goForward"
        >
          <AppIcon name="arrowRight" :size="13" />
        </button>
      </div>
      <div
        class="file-path-frame ml-1 flex min-w-0 flex-1 items-center gap-1"
        @click.self="beginPathEdit"
      >
        <nav
          v-if="!editingPath"
          class="file-crumbs flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[11px] text-tertiary"
          @click.self="beginPathEdit"
        >
          <template v-for="(crumb, index) in crumbs" :key="crumb.absolute === '' ? 'root' : crumb.absolute">
            <AppIcon v-if="index > 0" name="chevronRight" :size="10" class="shrink-0 opacity-60" />
            <button
              type="button"
              class="file-crumb max-w-[9rem] shrink-0 truncate rounded px-1 py-0.5 transition-colors"
              :class="[
                index === crumbs.length - 1 ? 'file-crumb-current' : '',
                crumb.inside ? '' : 'file-crumb-outside',
              ]"
              :title="crumb.absolute"
              @click.stop="openCrumb(crumb)"
            >
              {{ crumb.name }}
            </button>
          </template>
          <!-- Trailing blank area of the same field: a place to click without landing on a segment. -->
          <span class="min-w-2 flex-1 self-stretch" @click="beginPathEdit" />
        </nav>
        <input
          v-else
          ref="pathInput"
          v-model="pathDraft"
          class="h-6 min-w-0 flex-1 border-0 bg-transparent px-1 font-mono text-[11px] text-strong outline-none"
          spellcheck="false"
          autocomplete="off"
          placeholder="输入绝对路径后回车"
          @keydown.enter.prevent="commitPathEdit"
          @keydown.esc.prevent="cancelPathEdit"
          @blur="cancelPathEdit"
        />
      </div>
    </div>
    <p v-if="clip !== undefined" class="shrink-0 truncate px-1.5 pb-1 text-[10px] text-tertiary">
      {{ clip.mode === 'copy' ? '已复制' : '已剪切' }} {{ String(clip.items.length) }} 项
    </p>


    <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
      <!-- preview -->
      <div v-if="preview !== undefined" class="flex h-full min-h-0 flex-col">
        <div class="mb-1.5 flex shrink-0 items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate text-[11px] text-secondary" :title="preview.path">
            {{ preview.name }}
          </span>
          <span class="shrink-0 text-[10px] text-tertiary">{{ formatSize(preview.size) }}</span>
          <a class="icon-btn h-6 w-6" :href="rawUrl(preview.path)" download :title="'下载'">
            <AppIcon name="download" :size="12" />
          </a>
          <button class="icon-btn h-6 w-6" type="button" :title="fullscreen ? '退出全屏' : '全屏'" @click="fullscreen = !fullscreen">
            <AppIcon name="spark" :size="12" />
          </button>
          <button class="icon-btn h-6 w-6" type="button" title="关闭预览" @click="preview = undefined; fullscreen = false">
            <AppIcon name="close" :size="12" />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <p v-if="preview.loading" class="px-1 py-3 text-[11px] text-tertiary">正在载入预览…</p>
          <img v-else-if="preview.kind === 'image'" :src="preview.src" alt="" class="max-h-full w-full rounded-xl object-contain" />
          <video v-else-if="preview.kind === 'video'" :src="preview.src" controls class="max-h-full w-full rounded-xl" />
          <audio v-else-if="preview.kind === 'audio'" :src="preview.src" controls class="w-full" />
          <iframe
            v-else-if="preview.kind === 'pdf'"
            :src="preview.src"
            class="h-full min-h-[60vh] w-full rounded-xl border border-outline-medium"
            title="PDF"
          />
          <!-- Code: a fixed-width gutter beside unwrapped text keeps the numbers aligned. -->
          <div v-else-if="preview.kind === 'code'" class="flex gap-2 font-mono text-[11px] leading-5">
            <pre class="shrink-0 select-none text-right text-tertiary">{{ Array.from({ length: preview.lines }, (_, index) => index + 1).join('\n') }}</pre>
            <pre class="min-w-0 flex-1 overflow-x-auto" v-html="preview.html" />
          </div>
          <div v-else-if="preview.kind === 'html'" class="md break-words" :class="preview.name.endsWith('.md') || preview.name.endsWith('.markdown') ? '' : 'sheet-preview'" v-html="preview.html" />
          <p v-else class="rounded-xl bg-white/40 p-2 text-[11px] text-tertiary dark:bg-white/5">
            {{ preview.error ?? '无法预览这个文件，可以下载后查看。' }}
          </p>
          <p v-if="preview.truncated" class="mt-1 text-[10px] text-tertiary">内容较长，仅显示前面一部分。</p>
        </div>
      </div>

      <template v-else>
        <div v-if="loading" class="space-y-1.5 px-1 pt-1">
          <div v-for="index in 6" :key="index" class="rc-shimmer h-6" />
        </div>
        <div v-else-if="error !== ''" class="px-1 pt-2">
          <p class="mb-2 text-[11px] text-danger">{{ error }}</p>
          <button class="chip" type="button" @click="open(path)">重试</button>
        </div>
        <p v-else-if="(listing?.entries ?? []).length === 0" class="px-2 py-6 text-center text-[11px] text-tertiary">
          这个目录是空的。
        </p>
        <!-- Selection summary, so multi-select is visible without counting highlighted rows. -->
        <p v-if="hasSelection" class="shrink-0 px-1.5 pt-1 pb-0.5 text-[10px] text-tertiary">
          已选中 {{ selection.size }} 项
        </p>
        <div ref="listBox" class="relative">
          <ul class="space-y-0.5">
            <li v-for="entry in visibleEntries" :key="entry.name" class="file-row">
            <button
              type="button"
              :data-entry="entry.name"
              class="file-row-button flex w-full items-center gap-1.5 px-1.5 py-1 text-left transition-colors"
              :class="isSelected(entry) ? 'is-selected' : ''"
              @click="tapRow(entry)"
              @dblclick="activate(entry)"
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

          <!-- Blank space under the list: somewhere to start a rubber band without hitting a row. -->
          <div
            class="mt-1 h-24 cursor-crosshair touch-none rounded-lg"
            title="拖动框选"
            @pointerdown="startMarquee"
            @pointermove="moveMarquee"
            @pointerup="endMarquee"
            @pointercancel="endMarquee"
          />

          <div
            v-if="marqueeStyle !== undefined"
            class="pointer-events-none absolute rounded border border-primary bg-primary-container"
            :style="marqueeStyle"
          />
        </div>
        <p v-if="listing?.truncated" class="px-2 pt-2 text-[10px] text-warning-on">
          条目过多，仅显示前面一部分。
        </p>
      </template>
    </div>

    <!-- Dialogs live in the panel so they read as part of it, not as a browser prompt. -->
    <div
      v-if="ask !== undefined"
      class="absolute inset-0 z-40 flex items-center justify-center bg-fill-scrim p-3 backdrop-blur-sm"
      @click.self="cancelAsk"
    >
      <div class="panel pop w-full max-w-[18rem] p-3">
        <p class="mb-2 text-[13px] font-medium text-strong">{{ ask.title }}</p>
        <p v-if="ask.mode === 'confirm'" class="mb-3 text-[12px] leading-relaxed text-secondary">
          {{ ask.message }}
        </p>
        <input
          v-else
          v-model="ask.value"
          type="text"
          class="field mb-3 w-full py-1 text-[12px]"
          :placeholder="'名称'"
          autofocus
          @keydown.enter="submitAsk"
          @keydown.esc="cancelAsk"
        />
        <div class="flex justify-end gap-2">
          <button class="chip" type="button" @click="cancelAsk">取消</button>
          <button
            class="chip chip-strong"
            :class="ask.mode === 'confirm' ? 'text-danger' : ''"
            type="button"
            @click="submitAsk"
          >
            {{ ask.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/*
 * The shared control is composed for the chat composer; at 19rem it takes a third of the header. This
 * keeps the workspace picker inline with the buttons beside it.
 */
.file-pane .control {
  min-height: 1.85rem;
  padding-block: 0.15rem;
  font-size: 12px;
}

.file-pane .icon-btn {
  border-radius: 0.6rem;
}
</style>
