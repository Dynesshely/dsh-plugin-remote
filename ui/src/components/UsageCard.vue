<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../lib/api.js'
import AppIcon from './AppIcon.vue'
import {
  RING_RADIUS,
  USAGE_VIEW_KEY,
  USAGE_VIEW_OVERVIEW,
  balanceProviders,
  clampSlot,
  failedProviders,
  limitProviders,
  nextUsageView,
  overviewProviders,
  readUsageView,
  resetAtText,
  resetInText,
  ringMetrics,
  ringTone,
  shortNumber,
  stepSlot,
  windowAmountText,
  windowCountOf,
  windowPercent,
  windowTip,
} from '../lib/usage.js'

/**
 * 余额与用量卡片。
 *
 * 数据全部来自宿主 `/api/usage`（跨域请求与密钥都在 Host 侧），这里只负责画：
 *  - **详情视图（默认）**：顶部是余额 tile；所有「限额类」渠道共用**一个 slot**，一次显示一个，
 *    左右滑动/箭头切换，带 `2 / 5` 页码与渠道名 —— 渠道再多也不会把卡片撑长。
 *  - **总览视图（右键或右上角小按钮切换）**：每个上游一张卡片，按实际窗口数平铺圆环（`flex-wrap`），
 *    圆环上只有百分比，窗口全称/点数/重置时间收进自绘 tooltip。
 *
 * 视图选择记在 `localStorage`（`rc.usageView`），刷新保持。窗口数量完全按宿主返回的数据渲染：
 * 没有月限额的渠道（如 OpenDesign Go）就只有两个环，不补占位。
 */
const items = ref([])
/** Which source answered: the gateway, or the direct providers. */
const source = ref('')
const loading = ref(false)
const error = ref('')
/** Collapsed state is a reading preference, so it is remembered locally. */
const open = ref(window.localStorage.getItem('rc.usageOpen') !== '0')

/** 当前视图：详情 / 总览。记住选择，刷新保持。 */
const view = ref(readUsageView(window.localStorage.getItem(USAGE_VIEW_KEY)))

/** 限额 slot 的当前页。列表变化时由 watch 夹取，不会指向不存在的渠道。 */
const slotIndex = ref(0)
/** 触摸/鼠标拖拽的起点（null 表示没有正在进行的滑动）。 */
let swipeStart

/** @returns 所有限额类来源（**只含成功的**；失败渠道不进滑动手势的序列）。 */
const limits = computed(() => limitProviders(items.value))
/** @returns 请求失败的渠道（全部失败时的提示、总览里的异常卡片）。 */
const failed = computed(() => failedProviders(items.value))
/** @returns 余额类来源。 */
const balances = computed(() => balanceProviders(items.value))
/** @returns 总览视图要平铺的来源（含失败的）。 */
const overview = computed(() => overviewProviders(items.value))
/** @returns 当前 slot 里的来源。 */
const slotItem = computed(() => limits.value[clampSlot(slotIndex.value, limits.value.length)])
/** @returns 是否显示切换控件（只有一个渠道时不显示）。 */
const swipable = computed(() => limits.value.length > 1)

watch(() => limits.value.length, (total) => {
  slotIndex.value = clampSlot(slotIndex.value, total)
})

/** Toggle the card and remember the choice. */
function toggle () {
  open.value = !open.value
  try {
    window.localStorage.setItem('rc.usageOpen', open.value ? '1' : '0')
  } catch {
    /* a blocked storage keeps the in-memory value */
  }
}

/** 切换视图并记住选择。右键与右上角的小按钮都走这里。 */
function toggleView () {
  view.value = nextUsageView(view.value)
  try {
    window.localStorage.setItem(USAGE_VIEW_KEY, view.value)
  } catch {
    /* a blocked storage keeps the in-memory value */
  }
}

/* ---------------------------------------------------------------- slot 切换 */

/** @param direction - `1` 下一个，`-1` 上一个。 */
function moveSlot (direction) {
  slotIndex.value = stepSlot(slotIndex.value, limits.value.length, direction)
}

/** 拖拽中的实时位移（像素，只由 pointer 的 clientX 差值算出，不读元素尺寸）。 */
const dragOffset = ref(0)
/** 是否正在拖拽：拖动期间关掉过渡，松手后恢复。 */
const dragging = ref(false)
/** 是否偏好减少动效：reduce 时不要位移过渡，但所有提示照旧。 */
const reducedMotion = ref(false)
let motionQuery

/**
 * 轨道过渡：缓出曲线（接近 macOS 的吸附手感）。
 *
 * 拖动期间必须是 `none`（否则跟手会有延迟）；reduced-motion 下也必须是 `none`（直接到位）。
 */
const trackTransition = computed(() => (dragging.value || reducedMotion.value
  ? 'none'
  : 'transform 300ms cubic-bezier(0.22, 0.61, 0.36, 1)'))

/**
 * 轨道位移：每张卡占满整个轨道（100%），拖拽时叠加实时像素位移。
 * 百分比相对轨道自身宽度（轨道宽度 = slot 内容宽度），所以不需要测量 DOM。
 */
const trackStyle = computed(() => ({
  transform: `translateX(calc(${String(-slotIndex.value * 100)}% + ${String(dragOffset.value)}px))`,
  transition: trackTransition.value,
}))

/** @param event - matchMedia 的 change 事件。 */
function onMotionPreferenceChange (event) {
  reducedMotion.value = event.matches === true
}

/** 按下滑动起点（触摸与鼠标共用 pointer 事件）。 */
function onSwipeStart (event) {
  if (!swipable.value) return
  // P0：从按钮（箭头等）上按下时**完全不介入**。否则 `setPointerCapture` 会把 pointerup 的目标
  // 改成 slot，浏览器随后派发的 click 目标也随之变成 slot —— 按钮的 click 永远收不到，点了毫无反应。
  const target = event.target
  if (target instanceof Element && target.closest('button, a, input, [data-no-drag]') !== null) return
  if (pagingBlocked()) return
  swipeStart = { x: event.clientX, y: event.clientY }
  dragOffset.value = 0
  dragging.value = true
  // 捕获指针，让手指滑出 slot 边界后仍能收到 pointerup；不支持的浏览器/合成事件直接跳过。
  try {
    event.currentTarget?.setPointerCapture?.(event.pointerId)
  } catch {
    /* setPointerCapture 在合成事件或已释放的指针上会抛，忽略即可 */
  }
}

/**
 * 拖动过程中让轨道跟手。
 * @param event - pointermove。
 */
function onSwipeMove (event) {
  if (swipeStart === undefined) return
  const dx = event.clientX - swipeStart.x
  const dy = event.clientY - swipeStart.y
  // 明确的纵向手势：放弃横向拖动，把位移清零，把滚动还给页面。
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
    dragOffset.value = 0
    return
  }
  // 夹一下，避免拖出太离谱的距离（纯算术，没有测量）。
  dragOffset.value = Math.max(-240, Math.min(240, dx))
}

/** 结束滑动：横向位移足够才吸附到下一页/上一页，否则回弹；两者都走同一个过渡。 */
function onSwipeEnd (event) {
  const start = swipeStart
  swipeStart = undefined
  const wasDragging = dragging.value
  dragging.value = false
  if (start === undefined || !swipable.value) {
    if (wasDragging) dragOffset.value = 0
    return
  }
  const dx = event.clientX - start.x
  const dy = event.clientY - start.y
  // 先把跟手位移归零，再改页码：过渡会从「手指停下的位置」继续滑到目标卡片。
  dragOffset.value = 0
  if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return
  moveSlot(dx < 0 ? 1 : -1)
  // 一次拖拽只翻一页：翻完立刻把这次手势标记为「已用过」，直到 500ms 内没有新的横向输入。
  markGestureUsed()
}

/* ---------------------------------------------------------------- 触控板横向滚动 */

/** 一次横滑需要累计的位移（像素）。 */
const WHEEL_STEP = 60
/** 翻页后的最短冷却；与手势锁共存，手势锁是主约束。 */
const WHEEL_COOLDOWN_MS = 700
/**
 * 手势结束的判定：超过这么久没有新的横向 wheel，才算这次横向手势结束。
 *
 * 之前是 250ms，而触控板一次持续滑动很容易出现几百毫秒的静默（手指停顿/惯性衰减），
 * 于是「一次手势」被拆成两次，解锁后再翻一页 —— 这就是能从第 1 页一滑到第 3 页的原因。
 * 现在改成 500ms 的手势级判定：一个手势内最多翻一页。
 */
const GESTURE_IDLE_MS = 500
/** 两次 wheel 间隔超过这个值就当作新的一次累计（仍在同一手势内时只影响累计起点）。 */
const WHEEL_GESTURE_GAP_MS = 200

/** 累计的横向位移、最后一次 wheel 时间。 */
let wheelAccum = 0
let wheelLastAt = 0
/** 本次手势是否已经翻过页（手势内最多一次）。 */
let gestureUsed = false
/** 手势结束定时器：500ms 没有新的横向事件就结束手势。 */
let gestureIdleTimer
/** 冷却截止时间（700ms）。 */
let cooldownUntil = 0

/** @returns 现在是否不允许翻页（手势已翻过，或仍在上一次的冷却里）。 */
function pagingBlocked () {
  return gestureUsed === true || Date.now() < cooldownUntil
}

/** 重置「手势结束」的计时：每次横向输入都顺延，直到真的静默 500ms。 */
function touchGesture () {
  if (gestureIdleTimer !== undefined) clearTimeout(gestureIdleTimer)
  gestureIdleTimer = window.setTimeout(() => {
    gestureIdleTimer = undefined
    gestureUsed = false
    wheelAccum = 0
  }, GESTURE_IDLE_MS)
}

/** 标记本次手势已翻页：同一个手势里后面的横向事件只吞掉、不再翻页。 */
function markGestureUsed () {
  gestureUsed = true
  cooldownUntil = Date.now() + WHEEL_COOLDOWN_MS
  touchGesture()
}

/**
 * @param value - `event.deltaX` / `deltaY`。
 * @param deltaMode - 0 像素、1 行、2 页。
 * @returns 近似的像素值（行按 16px、页按视口宽度换算；不求逐像素精确）。
 */
function wheelPixels (value, deltaMode) {
  const delta = Number(value) || 0
  if (deltaMode === 1) return delta * 16
  if (deltaMode === 2) return delta * window.innerWidth
  return delta
}

/**
 * 触控板/横向滚轮翻页。
 *
 * 只接管「横向意图明确」的事件：`|deltaX| > |deltaY|`。纵向滑动的 `wheel` 原样放行，
 * 绝不 preventDefault。手势级锁：一次连续滑动（500ms 内持续有横向 wheel）最多翻一页。
 * @param event - wheel 事件。
 */
function onWheel (event) {
  const now = Date.now()
  const dx = wheelPixels(event.deltaX, event.deltaMode)
  const dy = wheelPixels(event.deltaY, event.deltaMode)
  if (Math.abs(dx) <= Math.abs(dy)) {
    // 纵向（或斜着但更偏纵向）：不接管。
    wheelAccum = 0
    return
  }
  // 横向：拦住，slot 上不该出现水平滚动条。
  event.preventDefault()
  touchGesture()
  if (pagingBlocked()) {
    // 本手势已经翻过页（或仍在冷却）：只吞掉，不累计、不翻页。
    wheelAccum = 0
    return
  }
  if (now - wheelLastAt > WHEEL_GESTURE_GAP_MS) wheelAccum = 0
  wheelLastAt = now
  wheelAccum += dx
  if (Math.abs(wheelAccum) < WHEEL_STEP) return
  const direction = wheelAccum < 0 ? 1 : -1
  wheelAccum = 0
  moveSlot(direction)
  markGestureUsed()
}

/* ---------------------------------------------------------------- 自绘 tooltip */

/** 当前 tooltip：`{ left, top, title, amount, reset }`，undefined 表示不显示。 */
const tip = ref(undefined)

/**
 * 把 tooltip 放在指针右下方并夹在视口内。
 *
 * 只用 pointer 坐标做算术，不读 DOM 尺寸 —— 每帧量元素正是之前卡顿的来源之一。
 * @param x - 指针 x。
 * @param y - 指针 y。
 */
function placeTip (x, y) {
  const width = 216
  const height = 74
  const left = Math.min(Math.max(8, x + 12), Math.max(8, window.innerWidth - width - 8))
  const top = Math.min(Math.max(8, y + 14), Math.max(8, window.innerHeight - height - 8))
  tip.value = { ...tip.value, left, top }
}

/** hover 进入一个圆环：填内容并跟随指针。 */
function showTip (event, item, window) {
  tip.value = { ...windowTip(item, window), left: 0, top: 0 }
  placeTip(event.clientX, event.clientY)
}

/** 指针在圆环上移动：只更新位置。 */
function moveTip (event) {
  if (tip.value === undefined) return
  placeTip(event.clientX, event.clientY)
}

/** 键盘 focus / 点击：锚定到圆环下方（只量一次元素位置）。 */
function showTipAtElement (event, item, window) {
  const rect = event.currentTarget?.getBoundingClientRect?.()
  tip.value = { ...windowTip(item, window), left: 0, top: 0 }
  if (rect === undefined) {
    placeTip(16, 16)
    return
  }
  placeTip(rect.left + rect.width / 2, rect.bottom + 2)
}

function hideTip () {
  tip.value = undefined
}

/** @returns 圆环的 `stroke-dasharray`。 */
function ringDash (window) {
  const metrics = ringMetrics(windowPercent(window), RING_RADIUS)
  return `${metrics.filled.toFixed(2)} ${metrics.gap.toFixed(2)}`
}

/* ---------------------------------------------------------------- 数据装载 */

/** @returns the tile's value text, unit included. */
function amount (balance) {
  const value = shortNumber(balance?.remaining)
  return balance?.unit === '' || balance?.unit === undefined ? value : `${value} ${String(balance.unit)}`
}

/** @returns the bar's tone, from how full the window is. */
function tone (window) {
  const percent = windowPercent(window)
  if (window?.exceeded || percent > 85) return 'bg-danger'
  if (percent > 60) return 'bg-warning'
  return 'bg-primary'
}

/** @returns a reset moment as `MM-DD HH:mm`, when one is known. */
function resetText (value) {
  return resetAtText(value)
}

/** @returns the one-line summary shown while collapsed. */
function summary () {
  return balances.value.map((item) => amount(item.balances[0])).join(' · ')
}

/** Load every enabled provider at once. */
async function load () {
  loading.value = true
  error.value = ''
  try {
    const payload = await api('/api/usage')
    items.value = Array.isArray(payload.items) ? payload.items : []
    source.value = String(payload.source ?? '')
    if (payload.error !== undefined && payload.error !== null) error.value = String(payload.error)
  } catch (problem) {
    error.value = String(problem.message ?? problem)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  // 动效偏好只影响过渡（不影响任何提示）。
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = motionQuery.matches === true
  motionQuery.addEventListener('change', onMotionPreferenceChange)
  void load()
})
onBeforeUnmount(() => {
  hideTip()
  motionQuery?.removeEventListener('change', onMotionPreferenceChange)
  motionQuery = undefined
  if (gestureIdleTimer !== undefined) {
    clearTimeout(gestureIdleTimer)
    gestureIdleTimer = undefined
  }
})
</script>

<template>
  <!-- A glass card of its own, inset from the sidebar edge rather than fused to its footer. -->
  <!-- 右键切换视图：阻止浏览器菜单，切到「详情 / 总览」的另一个。 -->
  <div class="card usage-card m-2 rounded-2xl p-2" @contextmenu.prevent="toggleView">
    <!-- One row, never wrapped: a squeezed header was the whole problem with the collapsed state. -->
    <div class="flex w-full flex-nowrap items-center gap-1.5">
      <button type="button" class="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 text-left" @click="toggle">
        <span
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-white/50 text-secondary transition-transform duration-200 dark:bg-white/10 text-muted"
          :class="open ? 'rotate-90' : ''"
        >
          <!-- Drawn here rather than borrowed: the affordance has to be big enough to read. -->
          <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
        <AppIcon name="spark" :size="11" class="shrink-0 text-tertiary" />
        <span class="shrink-0 text-[11px] font-medium whitespace-nowrap text-secondary-strong">用量与余额</span>
        <span
          v-if="source === 'gateway'"
          class="shrink-0 rounded-full bg-fill-tint px-1.5 py-px text-[9px] leading-none whitespace-nowrap text-secondary"
        >
          网关
        </span>
        <span
          v-if="!open && summary() !== ''"
          class="ml-auto min-w-0 truncate font-mono text-[10px] text-secondary"
          :title="summary()"
        >
          {{ summary() }}
        </span>
      </button>
      <template v-if="open">
        <!-- 视图名 + 小图标：不做成"只有知道右键的人才能用"。点它也能切换。 -->
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 rounded-full bg-fill-tint px-1.5 py-px text-[9px] leading-none whitespace-nowrap text-secondary transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
          :title="view === 'overview' ? '当前：总览视图（点击或右键切换到详情）' : '当前：详情视图（点击或右键切换到总览）'"
          @click.stop="toggleView"
        >
          <AppIcon :name="view === 'overview' ? 'layers' : 'info'" :size="9" />
          <span>{{ view === 'overview' ? '总览' : '详情' }}</span>
        </button>
        <span
          class="shrink-0 text-[10px] text-tertiary transition-colors hover:text-zinc-600 dark:hover:text-zinc-200"
          :class="loading ? 'opacity-40' : ''"
          title="刷新"
          @click.stop="load"
        >
          {{ loading ? '刷新中…' : '刷新' }}
        </span>
      </template>
    </div>

    <div v-if="open" class="mt-2 border-t border-outline-medium pt-2 dark:border-white/10">
      <p v-if="error !== ''" class="text-[10px] leading-relaxed text-danger">{{ error }}</p>

      <template v-else-if="items.length > 0">
        <!-- Balances first, as one row of tiles: channel above, amount below. -->
        <div v-if="balances.length > 0" class="flex flex-wrap gap-1.5" :class="view === 'detail' && limits.length > 0 ? 'mb-2' : ''">
          <div v-for="item in balances" :key="`tile-${item.id}`" class="usage-tile min-w-[6.5rem] flex-1 rounded-xl px-2 py-1.5">
            <p class="flex items-center gap-1 text-[10px] text-secondary">
              <span class="truncate" :title="item.label">{{ item.label }}</span>
              <!-- The gateway serves cached numbers; an icon says so without taking a row. -->
              <AppIcon v-if="item.cached" name="clock" :size="9" class="shrink-0 opacity-60" title="网关缓存的数据" />
            </p>
            <p class="truncate font-mono text-[13px] text-strong">{{ amount(item.balances[0]) }}</p>
            <p v-if="item.balances.length > 1" class="truncate text-[9px] text-tertiary">
              <span v-for="(balance, index) in item.balances.slice(1, 3)" :key="index">
                <template v-if="index > 0"> · </template>{{ amount(balance) }}
              </span>
            </p>
          </div>
        </div>

        <!-- 详情视图：所有限额类渠道共用一个 slot；内容是一条横向轨道，翻页是"滑走 / 滑入"。 -->
        <div
          v-if="view === 'detail' && limits.length > 0"
          class="usage-slot touch-pan-y overflow-hidden rounded-xl px-2 py-1.5"
          :class="dragging ? 'usage-dragging' : ''"
          @pointerdown="onSwipeStart"
          @pointermove="onSwipeMove"
          @pointerup="onSwipeEnd"
          @pointercancel="onSwipeEnd"
          @pointerleave="onSwipeEnd"
          @wheel="onWheel"
        >
          <div class="flex items-center gap-1">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
            <p class="min-w-0 flex-1 truncate text-[10px] text-secondary">{{ slotItem?.label }}</p>
            <template v-if="swipable">
              <span class="shrink-0 font-mono text-[9px] text-tertiary">{{ slotIndex + 1 }} / {{ limits.length }}</span>
              <button class="usage-slot-arrow" type="button" data-no-drag title="上一个渠道" @click.stop="moveSlot(-1)">
                <AppIcon name="chevron" :size="10" class="rotate-90" />
              </button>
              <button class="usage-slot-arrow" type="button" data-no-drag title="下一个渠道" @click.stop="moveSlot(1)">
                <AppIcon name="chevron" :size="10" class="-rotate-90" />
              </button>
            </template>
          </div>

          <div class="usage-viewport relative mt-1 overflow-hidden">
            <!-- 每张卡占满整条轨道（100%）：一次只露出一张完整卡片，不做 peek，避免"三块拼接"的观感。 -->
            <div class="usage-track flex" :style="trackStyle">
              <div v-for="item in limits" :key="`slide-${item.id}`" class="usage-slide">
                <div v-for="window in item.windows" :key="window.key" class="mb-1.5 last:mb-0">
                  <div class="flex flex-nowrap items-baseline gap-1.5 text-[10px]">
                    <span class="shrink-0 text-secondary">{{ window.label }}</span>
                    <span class="ml-auto shrink-0 font-mono text-muted">{{ windowAmountText(window) }}</span>
                    <span
                      v-if="resetText(window.resetAt ?? item.resetAt) !== ''"
                      class="shrink-0 text-[9px] text-tertiary"
                      :title="`${resetText(window.resetAt ?? item.resetAt)} 重置`"
                    >
                      · {{ resetText(window.resetAt ?? item.resetAt) }} 重置
                    </span>
                  </div>
                  <div class="usage-bar mt-0.5 h-1 w-full overflow-hidden rounded-full">
                    <div class="usage-bar-fill h-full rounded-full" :class="tone(window)" :style="{ width: `${String(windowPercent(window))}%` }" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- 全部限额来源都失败：给一句可读的提示，而不是一片空白。 -->
        <p v-else-if="view === 'detail' && failed.length > 0" class="mt-1 rounded-xl px-2 py-1.5 text-[10px] leading-relaxed text-tertiary">
          暂无可用限额来源（{{ failed.length }} 个渠道请求失败，可切到总览查看原因）
        </p>

        <!-- 总览视图：每个上游一张卡片，圆环按实际窗口数平铺。 -->
        <!-- 与上面的余额区之间留出明确间距：它们是两个区块，不是一整块。 -->
        <div
          v-else-if="view === 'overview'"
          class="mt-2 flex flex-col gap-1.5"
          :class="balances.length > 0 ? 'border-t border-outline-medium pt-2 dark:border-white/10' : ''"
        >
          <p v-if="overview.length === 0" class="rounded-xl px-2 py-1.5 text-[10px] leading-relaxed text-tertiary">
            暂无可显示的限额来源
          </p>
          <template v-else>
            <div v-for="item in overview" :key="`overview-${item.id}`" class="usage-tile rounded-xl px-2 py-1.5">
              <div class="flex items-center gap-1">
                <p class="min-w-0 flex-1 truncate text-[10px] text-secondary" :title="item.label">{{ item.label }}</p>
                <span class="shrink-0 font-mono text-[9px] text-tertiary">{{ windowCountOf(item) }} 项</span>
                <span class="shrink-0 text-[9px] text-success-on text-success-on">正常</span>
              </div>
              <div class="mt-1.5 flex flex-wrap gap-x-1.5 gap-y-1.5">
                <button
                  v-for="window in item.windows"
                  :key="window.key"
                  type="button"
                  class="usage-ring relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  :aria-label="`${String(window.label)} ${String(windowPercent(window))}%，${windowAmountText(window)}`"
                  @pointerenter="showTip($event, item, window)"
                  @pointermove="moveTip"
                  @pointerleave="hideTip"
                  @focus="showTipAtElement($event, item, window)"
                  @blur="hideTip"
                >
                  <!-- 环内只保留图形（不写百分比）：数字只在 tooltip 里。 -->
                  <svg viewBox="0 0 36 36" class="h-full w-full -rotate-90" aria-hidden="true">
                    <circle cx="18" cy="18" :r="RING_RADIUS" fill="none" stroke="currentColor" stroke-width="2.5" class="text-black/10 dark:text-white/15" />
                    <circle
                      cx="18"
                      cy="18"
                      :r="RING_RADIUS"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      :class="ringTone(window)"
                      :stroke-dasharray="ringDash(window)"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </template>
        </div>
      </template>

      <p v-else class="text-[10px] leading-relaxed text-tertiary">网关未返回可用的余额。</p>
    </div>

    <!-- 自绘 tooltip：跟随指针定位（不读 DOM 尺寸），带小箭头，深色主题跟随卡片。 -->
    <Teleport to="body">
      <div
        v-if="tip !== undefined"
        class="usage-tip fixed z-[140] max-w-[13.5rem] rounded-xl border border-outline-medium-strong bg-white/95 px-2 py-1.5 text-[10px] leading-relaxed text-muted shadow-[0_10px_30px_-12px_rgb(15_23_42/0.45)] dark:border-white/15 bg-fill-solid text-strong"
        :style="{ left: `${tip.left}px`, top: `${tip.top}px` }"
        role="tooltip"
      >
        <span class="usage-tip-arrow" aria-hidden="true" />
        <p class="font-medium">{{ tip.title }}</p>
        <p class="font-mono text-strong">{{ tip.amount }}</p>
        <p v-if="tip.reset !== ''" class="text-tertiary">{{ tip.reset }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style>
/* slot 的背景：比余额 tile 更轻，让「一次只显示一个渠道」的区块自成一块。 */
.usage-slot {
  background: rgb(255 255 255 / 0.28);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.5);
  /* 只允许纵向手势：横滑由 JS 接管（翻页后进入锁定），纵向滚动交给页面。 */
  touch-action: pan-y;
}

.dark .usage-slot {
  background: rgb(255 255 255 / 0.03);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08);
}

/* 轨道：宽度 = slot 内容宽度，每张卡占满轨道，位移用 transform（不读尺寸、不触发重排）。 */
.usage-viewport {
  touch-action: pan-y;
}

.usage-track {
  width: 100%;
  will-change: transform;
}

.usage-slide {
  flex: 0 0 100%;
  min-width: 0;
}

/* 拖动时禁止选中文本（否则一拖就把卡片文字刷蓝）。 */
.usage-slot.usage-dragging,
.usage-slot.usage-dragging * {
  user-select: none;
}

/* reduced-motion：即使内联样式被绕过，也不要有位移过渡。 */
@media (prefers-reduced-motion: reduce) {
  .usage-track {
    transition: none !important;
  }
}

/* slot 的翻页箭头：小、方、可点，但不抢圆环的注意力。 */
.usage-slot-arrow {
  display: inline-flex;
  height: 1.1rem;
  width: 1.1rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 0.375rem;
  color: #a1a1aa;
  transition: color 0.15s ease, background-color 0.15s ease;
}

.usage-slot-arrow:hover {
  color: #52525b;
  background-color: rgb(255 255 255 / 0.6);
}

.dark .usage-slot-arrow:hover {
  color: #e4e4e7;
  background-color: rgb(255 255 255 / 0.1);
}

/* 圆环按钮：hover/focus 时轻微提亮，不做缩放（避免布局抖动）。 */
.usage-ring:hover {
  background-color: rgb(255 255 255 / 0.5);
}

.dark .usage-ring:hover {
  background-color: rgb(255 255 255 / 0.06);
}

/* 自绘 tooltip 的小箭头：顶边朝上，指向指针/圆环。 */
.usage-tip-arrow {
  position: absolute;
  top: -4px;
  left: 14px;
  height: 8px;
  width: 8px;
  transform: rotate(45deg);
  border-left: 1px solid rgb(255 255 255 / 0.7);
  border-top: 1px solid rgb(255 255 255 / 0.7);
  background: rgb(255 255 255 / 0.95);
}

.dark .usage-tip-arrow {
  border-left-color: rgb(255 255 255 / 0.15);
  border-top-color: rgb(255 255 255 / 0.15);
  background: rgb(24 24 27 / 0.95);
}

/* 只在允许动效时给一点淡入；prefers-reduced-motion 下完全不动。 */
@media (prefers-reduced-motion: no-preference) {
  .usage-tip {
    animation: usage-tip-in 0.1s ease-out both;
  }

  @keyframes usage-tip-in {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
}
</style>
