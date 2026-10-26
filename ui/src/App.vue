<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { consumeLinkToken, login } from './lib/api.js'
import { loadModels, loadState, state } from './lib/store.js'
import { mobile } from './lib/layout.js'
import { loadMessage, loadPhase, SLOW_AFTER_MS } from './lib/loading.js'
import AppIcon from './components/AppIcon.vue'
import SidebarPane from './components/SidebarPane.vue'
import ConversationPane from './components/ConversationPane.vue'
import RightPane from './components/RightPane.vue'

const THEME_KEY = 'rc.theme'
const SIDEBAR_KEY = 'rc.sidebar'
/** Sidebar column width, padding included. */
const SIDEBAR_WIDTH = '18.5rem'

const drawer = ref(false)
/** The file browser column; remembered like the other layout choices. */
const filesOpen = ref(window.localStorage.getItem('rc.files') !== '0')
/** Width of the file column in rem, remembered because it is tuned once and then expected to stay. */
const filesWidth = ref(Number(window.localStorage.getItem('rc.filesWidth') ?? '19') || 19)
/** True while the divider is being dragged, so the width can follow the pointer without animating. */
const filesResizing = ref(false)
const sidebar = ref(window.localStorage.getItem(SIDEBAR_KEY) !== '0')
const theme = ref(window.localStorage.getItem(THEME_KEY) ?? 'system')
const token = ref('')
const loginError = ref('')

const media = window.matchMedia('(prefers-color-scheme: dark)')

/** True once the very first request has been waiting long enough to be worth admitting. */
const bootSlow = ref(false)
let bootTimer

watch(() => state.booted, (value) => {
  window.clearTimeout(bootTimer)
  bootSlow.value = false
  if (value) return
  bootTimer = window.setTimeout(() => { bootSlow.value = true }, SLOW_AFTER_MS)
}, { immediate: true })

/** How the boot request should read right now. */
const bootPhase = computed(() => loadPhase(!state.booted, bootSlow.value, state.bootError !== ''))
const bootHint = computed(() => loadMessage(bootPhase.value, '应用状态'))

/**
 * Retry the first state request.
 *
 * The store marks the page booted even when the request failed, and keeps the reason in `bootError` — so
 * the overlay keys off the error too, and clearing it is what brings the skeleton back.
 */
function retryBoot () {
  state.bootError = ''
  void loadState()
}

/** Apply the chosen theme: `system` follows the OS, the other two pin it. */
function applyTheme () {
  const dark = theme.value === 'dark' || (theme.value === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
}

/**
 * The column is persistent in desktop mode and a drawer in mobile mode. Mobile mode is decided by
 * `lib/layout.js`: either the viewport is narrow, or the composer toolbar reported that its desktop
 * controls no longer fit.
 */
const sidebarOpen = computed(() => (mobile.value ? drawer.value : sidebar.value))

/**
 * Sidebar geometry as inline styles.
 *
 * Breakpoint variants cannot fight each other here, so the panel can never be left translated
 * off-screen by a losing utility class.
 */
const asideStyle = computed(() => {
  const open = sidebarOpen.value
  if (!mobile.value) {
    return {
      position: 'static',
      width: open ? SIDEBAR_WIDTH : '0rem',
      padding: open ? '0.5rem' : '0rem',
      opacity: open ? '1' : '0',
      overflow: 'hidden',
      pointerEvents: open ? 'auto' : 'none',
    }
  }
  return {
    position: 'absolute',
    top: '0px',
    bottom: '0px',
    left: '0px',
    width: SIDEBAR_WIDTH,
    padding: '0.5rem',
    transform: open ? 'translateX(0)' : 'translateX(-110%)',
  }
})

/** Mirror of `asideStyle` for the right-hand column: same inset, mirrored drawer direction. */
const filesStyle = computed(() => {
  const open = filesOpen.value
  if (!mobile.value) {
    return {
      // `relative`, not `static`: the resize handle is absolutely positioned inside this column, and a
      // static ancestor gives it no containing block — which is why it was invisible and could not be
      // grabbed. It stays in flow, so the flex layout is unchanged.
      position: 'relative',
      width: open ? `${String(filesWidth.value)}rem` : '0rem',
      padding: open ? '0.5rem' : '0rem',
      opacity: open ? '1' : '0',
      overflow: 'hidden',
      pointerEvents: open ? 'auto' : 'none',
    }
  }
  return {
    position: 'absolute',
    top: '0px',
    bottom: '0px',
    right: '0px',
    width: `${String(filesWidth.value)}rem`,
    padding: '0.5rem',
    transform: open ? 'translateX(0)' : 'translateX(110%)',
  }
})

/**
 * Start dragging the divider between the transcript and the file column.
 * @param event - pointerdown on the divider.
 */
/** The frame that will apply the pending width, if one is scheduled. */
let resizeFrame
/** The latest pointer x, so several events per frame collapse into one write. */
let resizeX = 0

/** Apply the pending width once per frame instead of once per pointer event. */
function applyFilesResize () {
  resizeFrame = undefined
  const rem = (window.innerWidth - resizeX) / 16 - 0.5
  filesWidth.value = Math.min(42, Math.max(15, Math.round(rem * 10) / 10))
}

function startFilesResize (event) {
  if (mobile.value) return
  filesResizing.value = true
  resizeX = event.clientX
  event.currentTarget.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

/**
 * Follow the pointer while dragging.
 * @param event - pointermove on the divider.
 */
function moveFilesResize (event) {
  if (!filesResizing.value) return
  resizeX = event.clientX
  if (resizeFrame !== undefined) return
  resizeFrame = requestAnimationFrame(applyFilesResize)
}

/** Finish the drag and remember the width. */
function endFilesResize () {
  if (!filesResizing.value) return
  filesResizing.value = false
  if (resizeFrame !== undefined) {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = undefined
    applyFilesResize()
  }
  try {
    window.localStorage.setItem('rc.filesWidth', String(filesWidth.value))
  } catch {
    /* a blocked storage keeps the in-memory width */
  }
}

/** Show or hide the file browser. On a phone the two columns would fight, so the drawer closes. */
function toggleFiles () {
  filesOpen.value = !filesOpen.value
  if (filesOpen.value) drawer.value = false
  try {
    window.localStorage.setItem('rc.files', filesOpen.value ? '1' : '0')
  } catch {
    /* a blocked storage keeps the in-memory value */
  }
}

function toggleSidebar () {
  if (!mobile.value) {
    sidebar.value = !sidebar.value
    window.localStorage.setItem(SIDEBAR_KEY, sidebar.value ? '1' : '0')
    return
  }
  drawer.value = !drawer.value
}

// Leaving mobile mode drops the drawer, so the column can take over.
watch(mobile, (value) => {
  if (!value) drawer.value = false
})

watch(theme, () => {
  window.localStorage.setItem(THEME_KEY, theme.value)
  applyTheme()
})

/** Escape closes the drawer on narrow screens. */
function onKeydown (event) {
  if (event.key === 'Escape' && drawer.value) drawer.value = false
}

/* ---------------------------------------------------------------- swipe gestures (mobile only) */

/** Opening must start at the left edge so horizontal scrolling inside a card is untouched. */
const EDGE_ZONE = 42
const SWIPE_MIN = 64
let swipeStart

function onTouchStart (event) {
  if (!mobile.value) return
  const touch = event.touches[0]
  if (touch === undefined) return
  swipeStart = { x: touch.clientX, y: touch.clientY, fromEdge: touch.clientX <= EDGE_ZONE }
}

function onTouchEnd (event) {
  if (!mobile.value || swipeStart === undefined) return
  const touch = event.changedTouches[0]
  const start = swipeStart
  swipeStart = undefined
  if (touch === undefined) return
  const dx = touch.clientX - start.x
  const dy = touch.clientY - start.y
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return
  if (dx > 0 && start.fromEdge) drawer.value = true
  else if (dx < 0 && drawer.value) drawer.value = false
}

onMounted(async () => {
  applyTheme()
  media.addEventListener('change', applyTheme)
  window.addEventListener('keydown', onKeydown)
  try {
    await consumeLinkToken()
  } catch {
    loginError.value = '链接里的令牌无效'
  }
  await loadState()
  void loadModels()
})

onUnmounted(() => {
  media.removeEventListener('change', applyTheme)
  window.removeEventListener('keydown', onKeydown)
})

async function submitToken () {
  loginError.value = ''
  try {
    await login(token.value.trim())
    token.value = ''
    await loadState()
    void loadModels()
  } catch (error) {
    loginError.value = String(error.message ?? error)
  }
}
</script>

<template>
  <div
    class="relative h-full"
    :class="[state.lightweight ? 'lightweight' : '', state.telemetry.running ? 'streaming' : '']"
    @touchstart.passive="onTouchStart"
    @touchend.passive="onTouchEnd"
  >
    <!-- Liquid-glass backdrop: drifting colour fields that also cycle hue, so the frosted panels
         sit on something that keeps moving. -->
    <div class="drift-hue pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div class="drift-a absolute -left-28 -top-32 h-[28rem] w-[28rem] rounded-full bg-blue-400/40 blur-3xl dark:bg-blue-600/30" />
      <div class="drift-b absolute -right-24 top-1/5 h-96 w-96 rounded-full bg-fuchsia-400/30 blur-3xl dark:bg-fuchsia-600/25" />
      <div class="drift-c absolute -bottom-28 left-1/4 h-[26rem] w-[26rem] rounded-full bg-emerald-300/35 blur-3xl dark:bg-teal-500/25" />
      <div class="drift-b absolute left-1/3 top-1/2 h-80 w-80 rounded-full bg-cyan-300/25 blur-3xl dark:bg-cyan-500/20" style="animation-delay: -9s" />
      <div class="drift-a absolute bottom-1/4 right-1/4 h-72 w-72 rounded-full bg-violet-300/25 blur-3xl dark:bg-violet-500/20" style="animation-delay: -14s" />
      <div class="absolute inset-0 bg-gradient-to-b from-white/40 via-transparent to-white/30 dark:from-black/30 dark:via-transparent dark:to-black/40" />
    </div>

    <!-- Boot: the first state request takes seconds on a slow link, and a blank page reads as broken. -->
    <div
      v-if="!state.unauthorized && (!state.booted || (state.bootError !== '' && state.sessions.length === 0))"
      class="fixed inset-0 z-[130] flex items-center justify-center bg-white/70 px-6 backdrop-blur-xl dark:bg-zinc-950/80"
      aria-busy="true"
      aria-live="polite"
    >
      <div class="w-full max-w-md">
        <p class="mb-3 flex items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400">
          <AppIcon v-if="state.bootError === ''" name="refresh" :size="13" class="animate-spin" />
          <span>{{ state.bootError !== '' ? state.bootError : (bootHint === '' ? '正在连接 DSH…' : bootHint) }}</span>
        </p>
        <div v-if="state.bootError === ''" class="space-y-2">
          <div class="rc-shimmer h-14" />
          <div class="rc-shimmer h-24" />
          <div class="rc-shimmer h-16" />
        </div>
        <button v-else class="btn btn-primary" type="button" @click="retryBoot">重试</button>
      </div>
    </div>

    <!-- Token gate -->
    <div v-if="state.unauthorized" class="flex h-full items-center justify-center px-6">
      <div class="panel-tight w-full max-w-sm p-6">
        <div class="mb-3 flex items-center gap-2.5">
          <span class="brand-tile h-9 w-9">
            <img src="/app-icon.png" alt="" class="h-full w-full scale-125 object-cover" />
          </span>
          <span class="text-base font-semibold tracking-wide">DSH REMOTE</span>
        </div>
        <p class="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          需要一个访问令牌。它由 Host 首次启动时生成，写在
          <code class="rounded-md bg-zinc-900/[0.06] px-1.5 py-0.5 text-[12px] dark:bg-white/10">~/.dsh/remote-control/auth.json</code>，
          或直接使用带 <code class="rounded-md bg-zinc-900/[0.06] px-1.5 py-0.5 text-[12px] dark:bg-white/10">?k=</code> 的链接。
        </p>
        <div class="flex gap-2">
          <input
            v-model="token"
            type="password"
            class="field flex-1"
            placeholder="令牌"
            @keydown.enter="submitToken"
          />
          <button class="btn btn-primary" type="button" @click="submitToken">进入</button>
        </div>
        <p v-if="loginError" class="mt-2 text-sm text-rose-500">{{ loginError }}</p>
      </div>
    </div>

    <div v-else class="flex h-full min-h-0">
      <aside class="z-30 min-h-0 shrink-0 transition-all duration-300 ease-out" :style="asideStyle">
        <div class="panel-tight h-full w-full overflow-hidden">
          <SidebarPane @select="drawer = false" @close="toggleSidebar" />
        </div>
      </aside>
      <div
        v-if="drawer"
        class="absolute inset-0 z-20 bg-black/30 backdrop-blur-sm wide:hidden"
        @click="drawer = false"
      />

      <ConversationPane
        v-model:theme="theme"
        class="min-w-0 flex-1"
        @toggle-sidebar="toggleSidebar"
        @toggle-files="toggleFiles"
      />

      <!-- Narrow screens give the file browser the whole width, over a dimmed transcript. -->
      <div
        v-if="filesOpen && mobile"
        class="absolute inset-0 z-20 bg-black/30 backdrop-blur-sm"
        @click="toggleFiles"
      />

      <!-- The right column keeps its box while closed on desktop, so the width can animate. -->
      <aside
        v-if="filesOpen"
        class="relative z-30 min-h-0 shrink-0"
        :class="filesResizing ? '' : 'transition-[width] duration-300 ease-out'"
        :style="filesStyle"
      >
        <!--
          The divider straddles the gutter: the visible line is 2px, but the grab area is wider and
          overlaps the padding, because a 6px strip with no resting colour was neither visible nor easy
          to hit.
        -->
        <div
          v-if="mobile === false && filesOpen"
          class="group absolute inset-y-0 -left-1 z-40 w-3 cursor-col-resize touch-none"
          title="拖动调整宽度"
          @pointerdown="startFilesResize"
          @pointermove="moveFilesResize"
          @pointerup="endFilesResize"
          @pointercancel="endFilesResize"
        >
          <!-- A short rounded bar instead of a full-height line, which reads as a seam rather than a grip. -->
          <span
            class="absolute top-1/2 left-1/2 h-16 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/15 transition-all duration-150 group-hover:w-1.5 group-hover:bg-blue-500 dark:bg-white/25"
          />
        </div>
        <div class="panel-tight h-full w-full overflow-hidden">
          <RightPane @close="toggleFiles" />
        </div>
      </aside>
    </div>
  </div>
</template>
