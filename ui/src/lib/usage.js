/**
 * 用量卡片的纯函数层。
 *
 * 组件本身要编译才能跑，所以「slot 归组、页码、百分比、点数文案、重置时间、圆环几何、视图记忆」
 * 这些判断都放在这里：Node 里可以直接单测，假数据一跑就知道 OpenDesign Go 那种只有两个窗口的渠道
 * 会渲染几个环。
 */

/** 两种视图：`detail`（默认，单渠道 + 进度条）与 `overview`（每个上游一张卡片 + 圆环）。 */
export const USAGE_VIEW_DETAIL = 'detail'
export const USAGE_VIEW_OVERVIEW = 'overview'
/** 视图选择的存储键（刷新后保持）。 */
export const USAGE_VIEW_KEY = 'rc.usageView'

/**
 * @param stored - localStorage 里的原始值。
 * @returns 合法的视图名；任何不认识的值都退回默认视图。
 */
export function readUsageView (stored) {
  return stored === USAGE_VIEW_OVERVIEW ? USAGE_VIEW_OVERVIEW : USAGE_VIEW_DETAIL
}

/**
 * @param view - 当前视图。
 * @returns 切到另一个视图的名字。
 */
export function nextUsageView (view) {
  return view === USAGE_VIEW_OVERVIEW ? USAGE_VIEW_DETAIL : USAGE_VIEW_OVERVIEW
}

/**
 * 限额类来源（共用一个 slot 轮流显示的那一组）。
 *
 * 判定：**读取成功且有窗口**的来源。请求失败的渠道不进这个序列 —— 读者滑到它也只能看到一句错误，
 * 却会占掉页码；失败信息在总览视图与余额区仍然可见，详情视图在全部失败时给一条汇总提示。
 * @param items - `/api/usage` 的 items。
 */
export function limitProviders (items) {
  const list = Array.isArray(items) ? items : []
  return list.filter((item) => item !== null && typeof item === 'object'
    && item.ok !== false && Array.isArray(item.windows) && item.windows.length > 0)
}

/**
 * @param items - `/api/usage` 的 items。
 * @returns 请求失败的渠道（用于"全部不可用"的提示与总览里的异常卡片）。
 */
export function failedProviders (items) {
  const list = Array.isArray(items) ? items : []
  return list.filter((item) => item !== null && typeof item === 'object' && item.ok === false)
}

/**
 * 余额类来源（顶端那排金额 tile）。
 * @param items - `/api/usage` 的 items。
 */
export function balanceProviders (items) {
  const list = Array.isArray(items) ? items : []
  return list.filter((item) => item !== null && typeof item === 'object'
    && item.ok !== false && Array.isArray(item.balances) && item.balances.length > 0)
}

/**
 * @param index - 期望的 slot 下标。
 * @param total - slot 数量。
 * @returns 夹取后的合法下标（列表变短时不会指向不存在的位置）。
 */
export function clampSlot (index, total) {
  if (!Number.isFinite(index) || total <= 0) return 0
  return Math.min(Math.max(Math.trunc(index), 0), total - 1)
}

/**
 * @param index - 当前下标。
 * @param total - slot 数量。
 * @param direction - `1` 下一页，`-1` 上一页。
 * @returns 循环移动后的下标（只有一项时恒为 0）。
 */
export function stepSlot (index, total, direction) {
  if (total <= 1) return 0
  const current = clampSlot(index, total)
  const step = direction < 0 ? -1 : 1
  return (current + step + total) % total
}

/**
 * @param value - 任意数值。
 * @returns 卡片上那种紧凑数字文本（≥1000 保留一位小数）。
 */
export function shortNumber (value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return '0'
  if (Math.abs(number) >= 1000) return number.toFixed(1)
  return String(Math.round(number * 100) / 100)
}

/**
 * @param window - 一个窗口。
 * @returns 0–100 的整数百分比（圆环/进度条共用）。
 */
export function windowPercent (window) {
  const ratio = Number(window?.ratio)
  if (!Number.isFinite(ratio)) return 0
  return Math.min(100, Math.max(0, Math.round(ratio * 100)))
}

/**
 * 窗口的数值文案：优先显示「点数」（points/credits/remaining），否则显示 used / total。
 * @param window - 一个窗口。
 * @returns 人读的一行。
 */
export function windowAmountText (window) {
  /** 去掉 `1000.0` 这种多余的小数尾巴，卡片上的数字更好读。 */
  const trim = (text) => (text.endsWith('.0') ? text.slice(0, -2) : text)
  const points = Number(window?.points)
  if (Number.isFinite(points)) {
    const unit = typeof window?.unit === 'string' && window.unit !== '' ? window.unit : '点数'
    // 积分/credits 通常是整数：整数就原样显示，别写成 "1200.0 积分"。
    const text = Number.isInteger(points) && Math.abs(points) < 1_000_000 ? String(points) : shortNumber(points)
    return `${text} ${unit}`
  }
  if (window?.missingQuota === true) {
    return `${trim(shortNumber(window?.used))}（无配额）`
  }
  return `${trim(shortNumber(window?.used))} / ${trim(shortNumber(window?.total))}`
}

/** @returns 一个可解析的重置时刻（毫秒），或 undefined。 */
function resetTimeOf (resetAt) {
  if (typeof resetAt !== 'string' || resetAt === '') return undefined
  const time = Date.parse(resetAt)
  return Number.isFinite(time) ? time : undefined
}

/**
 * @param resetAt - ISO 时刻。
 * @param now - 参照时间（单测可注入）。
 * @returns 「3 小时后重置」这类人读文案；无法解析时返回空字符串。
 */
export function resetInText (resetAt, now = Date.now()) {
  const time = resetTimeOf(resetAt)
  if (time === undefined) return ''
  const diff = time - now
  if (diff <= 0) return '已到重置时间'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) return `${String(Math.max(1, Math.round(diff / minute)))} 分钟后重置`
  if (diff < day) return `${String(Math.round(diff / hour))} 小时后重置`
  return `${String(Math.round(diff / day))} 天后重置`
}

/**
 * @param resetAt - ISO 时刻。
 * @returns `MM-DD HH:mm`（详情视图里的绝对时刻）；无法解析时返回空字符串。
 */
export function resetAtText (resetAt) {
  const time = resetTimeOf(resetAt)
  if (time === undefined) return ''
  const date = new Date(time)
  const pad = (number) => String(number).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 圆环半径（viewBox 36×36 里留出描边宽度）。 */
export const RING_RADIUS = 15

/**
 * @param percent - 0–100。
 * @param radius - 半径，默认 {@link RING_RADIUS}。
 * @returns `{ circumference, filled, gap }`，直接喂给 `stroke-dasharray`。
 */
export function ringMetrics (percent, radius = RING_RADIUS) {
  const r = Number(radius) > 0 ? Number(radius) : RING_RADIUS
  const circumference = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, Number(percent) || 0))
  const filled = (clamped / 100) * circumference
  return { circumference, filled, gap: circumference - filled }
}

/**
 * @param window - 一个窗口。
 * @returns 圆环/进度条的颜色类（与既有 tone 保持一致）。
 */
export function ringTone (window) {
  const percent = windowPercent(window)
  if (window?.exceeded === true || percent > 85) return 'text-rose-500'
  if (percent > 60) return 'text-amber-400'
  return 'text-blue-500'
}

/**
 * 总览视图的上游列表。
 *
 * 只保留「读取成功且确实有窗口」的上游：失败卡与「没有可显示的限额」的占位卡都不进总览
 * —— 总览是拿来横向比较限额的，一张只有余额或只有错误的卡片除了把版面撑长没有别的作用。
 * 余额仍在卡片顶部的余额区展示（`balanceProviders`），不受这里影响。
 * @param items - `/api/usage` 的 items。
 */
export function overviewProviders (items) {
  const list = Array.isArray(items) ? items : []
  return list.filter((item) => item !== null && typeof item === 'object'
    && item.ok !== false && Array.isArray(item.windows) && item.windows.length > 0)
}

/**
 * @param item - 一个来源。
 * @returns 该来源实际要画的窗口数（失败 0；OpenDesign Go 这类只有两个窗口的就是 2）。
 */
export function windowCountOf (item) {
  if (item === null || typeof item !== 'object' || item.ok === false) return 0
  return Array.isArray(item.windows) ? item.windows.length : 0
}

/**
 * @param item - 一个来源。
 * @param window - 一个窗口。
 * @returns 自绘 tooltip 的内容：`上游 · 窗口全称` → `38%（已用/总量）` → 重置时间。
 *
 * 百分比只出现在这里（总览视图的圆环内不再写数字），所以这一行必须带上它，不能因此丢信息。
 */
export function windowTip (item, window, now = Date.now()) {
  const percent = windowPercent(window)
  return {
    title: `${typeof item?.label === 'string' && item.label !== '' ? item.label : '来源'} · ${String(window?.label ?? '窗口')}`,
    amount: `${String(percent)}%（${windowAmountText(window)}）`,
    percent,
    reset: resetInText(window?.resetAt ?? item?.resetAt, now),
  }
}
