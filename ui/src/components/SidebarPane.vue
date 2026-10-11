<script setup>
import { computed, nextTick, ref } from 'vue'
import {
  createSession,
  forkSession,
  groupedSessions,
  isPinned,
  renameSession,
  selectSession,
  loadPresets,
  setArchived,
  setPinned,
  state,
} from '../lib/store.js'
import { mobile } from '../lib/layout.js'
import { api } from '../lib/api.js'
import UsageCard from './UsageCard.vue'
import { Pin } from 'lucide-vue-next'
import AppIcon from './AppIcon.vue'
import ComboBox from './ComboBox.vue'

const emit = defineEmits(['select', 'close'])

const COLLAPSE_KEY = 'rc.collapsed'
const query = ref('')

/** Collapsed workspace ids, stored as a plain array so a malformed value can never break setup. */
function readCollapsed () {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

const collapsed = ref(readCollapsed())
/** Archived rows are folded away until asked for, like the desktop's archived section. */
const archivedOpen = ref(false)
/** The row whose action menu is open, plus its screen position (the list scrolls, so it is fixed). */
const menuFor = ref(undefined)
const menuAt = ref({ left: 0, top: 0 })
/** Inline rename state (desktop); mobile uses the dialog instead. */
const renamingId = ref(undefined)
const renameDraft = ref('')
const renameInput = ref(null)
/** Dialog state for the mobile rename and the archive confirmation. */
const dialog = ref(undefined)

/** @returns whether the workspace's Session list is folded away. */
function isCollapsed (id) {
  return collapsed.value.includes(id)
}

function toggle (id) {
  collapsed.value = isCollapsed(id)
    ? collapsed.value.filter((candidate) => candidate !== id)
    : [...collapsed.value, id]
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed.value))
  } catch {
    /* a full or blocked storage keeps the in-memory state */
  }
}

/**
 * Workspace groups and the archived rows, filtered by the search box.
 * Empty groups drop out while searching, and an archived Session surfaces in its own section.
 */
const view = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const all = groupedSessions.value
  if (needle === '') return all
  const matches = (session) => `${session.title ?? ''} ${session.id}`.toLowerCase().includes(needle)
  return {
    groups: all.groups
      .map((group) => ({ ...group, sessions: group.sessions.filter(matches) }))
      .filter((group) => group.sessions.length > 0),
    archived: all.archived.filter(matches),
  }
})

/** Workspace choices for the create dialog. */
const workspaceOptions = computed(() => state.workspaces.map((workspace) => ({
  value: workspace.id,
  name: workspace.title || workspace.path || workspace.id,
  description: workspace.path,
})))

/** @returns the open Session's workspace, else the first known one. */
function defaultWorkspaceId () {
  const current = state.sessions.find((session) => session.id === state.selected)
  return current?.workspaceId ?? groupedSessions.value.groups[0]?.id ?? state.workspaces[0]?.id
}

/**
 * Open the create dialog.
 * @param workspaceId - a preselected workspace, when the caller knows one.
 */
function openCreate (workspaceId) {
  dialog.value = { kind: 'create', workspaceId: workspaceId ?? defaultWorkspaceId(), presetId: undefined }
  void loadPresets()
}

function open (id) {
  void selectSession(id)
  emit('select')
}

/** @returns a coarse "how long ago" label for a Session row. */
function ago (updatedAt) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return ''
  const minutes = Math.floor((Date.now() - updatedAt) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Open the action menu under its button. */
function openMenu (session, event) {
  if (menuFor.value === session.id) {
    menuFor.value = undefined
    return
  }
  const rect = event.currentTarget.getBoundingClientRect()
  const width = 176
  menuFor.value = session.id
  menuAt.value = {
    left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    top: Math.min(rect.bottom + 6, window.innerHeight - 168),
  }
}

/** @returns the Session the open menu belongs to. */
const menuSession = computed(() => {
  const id = menuFor.value
  if (id === undefined) return undefined
  const all = groupedSessions.value
  return [...all.groups.flatMap((group) => group.sessions), ...all.archived].find((session) => session.id === id)
})

async function act (kind) {
  const session = menuSession.value
  menuFor.value = undefined
  if (session === undefined) return
  if (kind === 'pin') {
    await setPinned(session.id, !isPinned(session.id))
    return
  }
  if (kind === 'fork') {
    const payload = await forkSession(session.id)
    if (payload !== undefined) emit('select')
    return
  }
  if (kind === 'rename') {
    if (mobile.value) {
      dialog.value = { kind: 'rename', session, title: session.title ?? '' }
      return
    }
    renamingId.value = session.id
    renameDraft.value = session.title ?? ''
    await nextTick()
    renameInput.value?.[0]?.focus?.() ?? renameInput.value?.focus?.()
    return
  }
  if (kind === 'archive') {
    dialog.value = { kind: 'archive', session, archived: !state.archivedSessionIds.includes(session.id), stopActivity: false }
    return
  }
  if (kind === 'unarchive') await setArchived(session.id, false)
}

/** Commit the inline rename. */
async function commitRename () {
  const id = renamingId.value
  const title = renameDraft.value.trim()
  renamingId.value = undefined
  if (id === undefined || title === '') return
  await renameSession(id, title)
}

/** Cancel the inline rename. */
function cancelRename () {
  renamingId.value = undefined
}

/** Commit the dialog (rename on mobile, or the archive confirmation). */
async function commitDialog () {
  const current = dialog.value
  dialog.value = undefined
  if (current === undefined) return
  if (current.kind === 'create') {
    const workspace = state.workspaces.find((candidate) => candidate.id === current.workspaceId)
    const presetId = current.presetId ?? state.presets[0]?.id
    const sessionId = await createSession({
      ...(workspace === undefined || workspace.id.startsWith('__') ? { cwd: workspace?.path } : { workspaceId: workspace.id }),
      ...(presetId === undefined ? {} : { agentPreset: presetId }),
    })
    if (sessionId !== undefined) {
      await selectSession(sessionId)
      emit('select')
    }
    return
  }
  if (current.kind === 'rename') {
    const title = String(current.title ?? '').trim()
    if (title !== '') await renameSession(current.session.id, title)
    return
  }
  await setArchived(current.session.id, current.archived, current.stopActivity === true)
}

/* ---------------------------------------------------------------- DSH menu */

/** Whether the logo menu is open. */
const dshOpen = ref(false)
/** Which destructive action is waiting for a second click, so neither fires by accident. */
const armed = ref('')
const dshBusy = ref('')
/** Facts about this Host, fetched when the menu opens. */
const info = ref(undefined)

/** @returns the remote-control port the Host should watch while it closes. */
function controlPort () {
  const port = Number(window.location.port)
  return Number.isFinite(port) && port > 0 ? port : 19400
}

/** Load the Host facts shown in the About section. */
async function loadInfo () {
  try {
    info.value = await api('/api/dsh/info')
  } catch (error) {
    info.value = { error: String(error.message ?? error) }
  }
}

async function openDsh () {
  dshOpen.value = !dshOpen.value
  armed.value = ''
  if (dshOpen.value) await loadInfo()
}

/**
 * Restart or quit DSH.
 *
 * Both go through the Host, which spawns a detached helper: quitting takes the Host — and this page's
 * only backend — down with it, so the process that starts it again has to live outside.
 * @param mode - `restart` or `exit`.
 */
async function controlDsh (mode) {
  if (armed.value !== mode) {
    armed.value = mode
    return
  }
  armed.value = ''
  dshBusy.value = mode
  try {
    await api(`/api/dsh/${mode}`, { method: 'POST', body: { port: controlPort() } })
    state.actionError = mode === 'restart'
      ? 'DSH 正在重启，页面会在它回来后自动重连'
      : 'DSH 正在退出，本页面将失去连接'
  } catch (error) {
    state.actionError = String(error.message ?? error)
  } finally {
    dshBusy.value = ''
  }
}

/** @returns the menu entries for one Session. */
function entriesFor (session) {
  const archived = state.archivedSessionIds.includes(session.id)
  return [
    { kind: archived ? 'unarchive' : 'archive', label: archived ? '取消归档' : '归档会话', icon: 'layers' },
    { kind: 'pin', label: isPinned(session.id) ? '取消置顶' : '置顶会话', icon: 'pin' },
    { kind: 'rename', label: '重命名', icon: 'pencil' },
    { kind: 'fork', label: '从最后已结束轮次分叉', icon: 'fork' },
  ]
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 px-3 py-3">
      <!-- Brand tile: a rounded rectangle whose 10px radius reads as the sidebar's own 18px corner
           at this size. The source icon ships its own rounded-square backdrop, so the image is
           scaled up inside the clipped tile to cut that backdrop away. -->
      <!-- The mark doubles as the DSH menu: restart, quit, and what this Host actually is. -->
      <button
        type="button"
        class="brand-tile h-8 w-8 transition-transform duration-200 hover:scale-105 active:scale-95"
        :class="dshOpen ? 'ring-2 ring-blue-400/60' : ''"
        title="DSH 菜单"
        @click="openDsh"
      >
        <img src="/app-icon.png" alt="" class="h-full w-full scale-125 object-cover" />
      </button>
      <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide">DSH REMOTE</span>
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="state.streamError ? 'bg-amber-400 pulse' : 'bg-emerald-500'"
        :title="state.streamError || '已连接'"
      />
      <button class="icon-btn h-7 w-7" type="button" title="收起侧栏" @click="emit('close')">
        <AppIcon name="close" :size="13" />
      </button>
    </div>

    <div class="px-3 pb-2">
      <div class="relative">
        <AppIcon name="search" :size="14" class="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-zinc-400" />
        <input v-model="query" class="field pl-9" placeholder="搜索会话" />
      </div>
      <!-- New Session sits next to the search box, and asks for the workspace and the mode. -->
      <button
        type="button"
        class="btn mt-2 w-full justify-center"
        :disabled="state.workspaces.length === 0"
        @click="openCreate()"
      >
        <AppIcon name="plus" :size="14" />
        <span>新建会话</span>
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2" @click.self="menuFor = undefined">
      <div v-for="group in view.groups" :key="group.id" class="mt-2 first:mt-0">
        <!-- Workspace level: bigger, bolder, clearly the parent of the rows below. -->
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/50 dark:hover:bg-white/[0.06]"
          :aria-expanded="!isCollapsed(group.id)"
          @click="toggle(group.id)"
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-white/80 to-white/40 text-zinc-500 shadow-[0_2px_8px_-6px_rgb(15_23_42/0.6)] dark:from-white/[0.14] dark:to-white/[0.06] dark:text-zinc-300">
            <AppIcon name="layers" :size="13" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px] font-semibold text-zinc-700 dark:text-zinc-100">
              {{ group.title || group.path || '工作区' }}
            </span>
            <span v-if="group.path" class="block truncate text-[10px] font-normal text-zinc-400">
              {{ group.path }}
            </span>
          </span>
          <span class="shrink-0 rounded-full bg-white/60 px-1.5 text-[10px] text-zinc-500 dark:bg-white/10 dark:text-zinc-400">
            {{ group.sessions.length }}
          </span>
          <AppIcon
            name="chevron"
            :size="13"
            class="shrink-0 text-zinc-400 transition-transform duration-200"
            :class="isCollapsed(group.id) ? '-rotate-90' : ''"
          />
        </button>

        <!-- Session level: indented behind a guide line so the hierarchy reads at a glance. -->
        <div
          v-if="!isCollapsed(group.id)"
          class="mt-1 ml-[1.15rem] space-y-0.5 border-l border-zinc-900/10 pl-2.5 dark:border-white/10"
        >
          <div
            v-for="session in group.sessions"
            :key="session.id"
            class="group/row flex items-center gap-1 rounded-xl pr-1 transition-all duration-200"
            :class="session.id === state.selected
              ? 'bg-white/80 shadow-[0_4px_16px_-10px_rgb(15_23_42/0.5)] dark:bg-white/[0.12]'
              : 'hover:bg-white/50 dark:hover:bg-white/[0.06]'"
          >
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left text-[13px]" @click="open(session.id)">
              <!-- The status dot always stays put; pinning only adds a marker on the right. -->
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full"
                :class="session.running ? 'bg-emerald-500 pulse' : session.origin === 'subagent' ? 'bg-violet-400' : 'bg-zinc-300 dark:bg-zinc-600'"
              />
              <input
                v-if="renamingId === session.id"
                ref="renameInput"
                v-model="renameDraft"
                class="min-w-0 flex-1 rounded-lg border border-sky-400/60 bg-white/80 px-1.5 py-0.5 text-[13px] outline-none dark:bg-black/40"
                @click.stop
                @keydown.enter.prevent="commitRename"
                @keydown.esc.prevent="cancelRename"
                @blur="commitRename"
              />
              <span v-else class="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">{{ session.title || session.id }}</span>
              <span class="shrink-0 text-[10px] text-zinc-400">{{ ago(session.updatedAt) }}</span>
              <!-- Lucide's pushpin reads as "pinned" without the hand-drawn drop shape. -->
              <Pin
                v-if="isPinned(session.id)"
                :size="13"
                :stroke-width="2"
                class="shrink-0 text-sky-500 dark:text-sky-300"
                title="已置顶"
              />
            </button>
            <button
              type="button"
              class="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-zinc-400 opacity-0 transition-opacity group-hover/row:opacity-100 focus:opacity-100"
              :class="menuFor === session.id ? 'opacity-100' : ''"
              :title="'会话操作'"
              @click.stop="openMenu(session, $event)"
            >
              <AppIcon name="more" :size="14" />
            </button>
          </div>
        </div>
      </div>

      <!-- Archived Sessions: hidden by default, folded open on demand, unarchivable in place. -->
      <div v-if="view.archived.length > 0" class="mt-3">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[11px] text-zinc-400 transition-colors hover:bg-white/50 dark:hover:bg-white/[0.06]"
          :aria-expanded="archivedOpen"
          @click="archivedOpen = !archivedOpen"
        >
          <AppIcon name="chevron" :size="12" class="transition-transform duration-200" :class="archivedOpen ? '' : '-rotate-90'" />
          <span class="flex-1">已归档</span>
          <span class="rounded-full bg-white/60 px-1.5 text-[10px] dark:bg-white/10">{{ view.archived.length }}</span>
        </button>
        <div v-if="archivedOpen" class="mt-1 ml-[1.15rem] space-y-0.5 border-l border-zinc-900/10 pl-2.5 dark:border-white/10">
          <div
            v-for="session in view.archived"
            :key="session.id"
            class="flex items-center gap-1 rounded-xl pr-1 hover:bg-white/50 dark:hover:bg-white/[0.06]"
          >
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left text-[13px] text-zinc-400" @click="open(session.id)">
              <AppIcon name="layers" :size="12" class="shrink-0 opacity-60" />
              <span class="min-w-0 flex-1 truncate">{{ session.title || session.id }}</span>
            </button>
            <button type="button" class="chip px-2 py-0 text-[10px]" @click.stop="setArchived(session.id, false)">取消归档</button>
          </div>
        </div>
      </div>

      <p v-if="view.groups.length === 0 && view.archived.length === 0" class="px-3 py-6 text-center text-xs text-zinc-400">
        没有匹配的会话
      </p>
    </div>

    <!-- Balance and usage took the footer over: the listening address now lives in the DSH menu and
         the settings sheet, where it belongs next to the rest of the connection facts. -->
    <!-- The card carries its own glass and margin, so the footer needs no rule of its own. -->
    <UsageCard />

    <!-- DSH menu: a glass card in the top-left corner, teleported so nothing clips it. -->
    <Teleport to="body">
      <div v-if="dshOpen" class="fixed inset-0 z-[124]" @click="dshOpen = false" />
      <div v-if="dshOpen" class="card pop fixed top-3 left-3 z-[125] w-64 overflow-hidden p-1.5">
        <p class="px-2.5 pt-1.5 pb-2 text-[11px] font-medium tracking-wide text-zinc-400">DSH</p>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-white/60 dark:hover:bg-white/[0.08]"
          :disabled="dshBusy !== ''"
          @click="controlDsh('restart')"
        >
          <AppIcon name="restart" :size="14" class="opacity-70" />
          <span class="flex-1">{{ armed === 'restart' ? '再次点击确认重启' : '重启 DSH' }}</span>
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-rose-500 transition-colors hover:bg-rose-500/10"
          :disabled="dshBusy !== ''"
          @click="controlDsh('exit')"
        >
          <AppIcon name="power" :size="14" class="opacity-80" />
          <span class="flex-1">{{ armed === 'exit' ? '再次点击确认退出' : '退出 DSH' }}</span>
        </button>
        <div class="mx-2 my-1.5 border-t border-white/50 dark:border-white/10" />
        <div class="px-2.5 py-1.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          <p class="mb-1 font-medium text-zinc-400">关于</p>
          <p>远程遥控插件 · v1.0.0</p>
          <p>监听 {{ state.bind || '—' }}</p>
          <template v-if="info !== undefined">
            <p v-if="info.error" class="text-rose-500">读取失败：{{ info.error }}</p>
            <template v-else>
              <p>DSH pid {{ info.pid }} · node {{ info.node }}<span v-if="info.electron"> · electron {{ info.electron }}</span></p>
              <p class="break-all">启动器 {{ info.launcher }}</p>
              <p v-if="info.launcherExists === false" class="text-rose-500">启动器不存在，重启会失败</p>
            </template>
          </template>
          <p v-else class="opacity-60">正在读取…</p>
        </div>
      </div>
    </Teleport>

    <!-- Action menu: teleported so the scrolling list cannot clip it. -->
    <Teleport to="body">
      <div v-if="menuFor !== undefined" class="fixed inset-0 z-[115]" @click="menuFor = undefined" />
      <div
        v-if="menuFor !== undefined && menuSession !== undefined"
        class="card pop fixed z-[116] w-44 overflow-hidden p-1"
        :style="{ left: `${menuAt.left}px`, top: `${menuAt.top}px` }"
      >
        <button
          v-for="entry in entriesFor(menuSession)"
          :key="entry.kind"
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-white/70 dark:hover:bg-white/[0.10]"
          @click="act(entry.kind)"
        >
          <Pin v-if="entry.icon === 'pin'" :size="13" :stroke-width="2" class="opacity-70" />
          <AppIcon v-else :name="entry.icon" :size="13" class="opacity-70" />
          <span class="truncate">{{ entry.label }}</span>
        </button>
      </div>
    </Teleport>

    <!-- Rename on mobile, and the archive confirmation (with its opt-in stop). -->
    <Teleport to="body">
      <div
        v-if="dialog !== undefined"
        class="fixed inset-0 z-[117] flex items-end justify-center bg-black/40 p-3 backdrop-blur-sm wide:items-center"
        @click.self="dialog = undefined"
      >
        <div class="panel pop w-full max-w-sm p-4">
          <h3 class="mb-3 text-sm font-medium">{{ dialog.kind === 'create' ? '新建会话' : dialog.kind === 'rename' ? '重命名会话' : (dialog.archived ? '归档会话' : '取消归档') }}</h3>
          <template v-if="dialog.kind === 'create'">
            <ComboBox v-model="dialog.workspaceId" :items="workspaceOptions" placeholder="选择工作区" icon="layers" width="w-full" />
            <p class="mt-4 mb-1.5 text-[11px] text-zinc-400">模式</p>
            <div class="max-h-[46dvh] space-y-1 overflow-y-auto">
              <button
                v-for="preset in state.presets"
                :key="preset.id"
                type="button"
                class="flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition-colors"
                :class="(dialog.presetId ?? state.presets[0]?.id) === preset.id ? 'bg-white/80 dark:bg-white/[0.12]' : 'hover:bg-white/60 dark:hover:bg-white/[0.08]'"
                @click="dialog.presetId = preset.id"
              >
                <span class="min-w-0 flex-1">
                  <span class="block text-[13px] font-medium">{{ preset.name }}</span>
                  <span v-if="preset.description" class="mt-0.5 block text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">{{ preset.description }}</span>
                </span>
                <AppIcon v-if="(dialog.presetId ?? state.presets[0]?.id) === preset.id" name="check" :size="14" class="mt-0.5 shrink-0 text-blue-500" />
              </button>
              <p v-if="state.presets.length === 0" class="px-2 py-1 text-xs text-zinc-400">没有可用的模式</p>
            </div>
          </template>
          <input
            v-if="dialog.kind === 'rename'"
            v-model="dialog.title"
            class="field"
            placeholder="会话标题"
            @keydown.enter.prevent="commitDialog"
          />
          <template v-else>
            <p v-if="dialog.archived" class="text-[13px] text-zinc-500 dark:text-zinc-400">
              归档后它会从列表移到「已归档」，随时可以取消归档。
            </p>
            <label v-if="dialog.archived" class="mt-3 flex items-center gap-2 text-[13px]">
              <input v-model="dialog.stopActivity" type="checkbox" class="h-3.5 w-3.5" />
              同时停止正在运行的工作
            </label>
          </template>
          <div class="mt-4 flex justify-end gap-2">
            <button type="button" class="btn" @click="dialog = undefined">取消</button>
            <button type="button" class="btn btn-primary" @click="commitDialog">确定</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
