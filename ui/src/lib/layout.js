import { computed, ref } from 'vue'

/**
 * 布局模式检测。
 *
 * 这里曾经把「composer 工具栏放不下」也算进 `mobile`，于是形成一个自激回路：
 *
 *   工具栏放不下 → `mobile = true` → App 把左右两栏改成 absolute（离开文档流）→ 中间列变宽
 *   → 工具栏又放得下 → `mobile = false` → 中间列变窄 → 又放不下 …… 无限互踢。
 *
 * 视口落在 704–1200px 时这个回路必然被点燃，而左栏还挂着 `transition-all`，每一轮翻转都要连续
 * 重排十几帧 —— 表现就是「只打开右栏就卡死、关掉就好」。
 *
 * 现在两个信号彻底分开，回路从结构上消失：
 *   - {@link mobile}：**只**由视口断点决定，是唯一的布局模式信号（absolute / flex / 抽屉）；
 *   - {@link compact}：由 composer 自己报告的「控件放不下」决定，只用来把控件收成图标，**绝不回写布局**。
 * 另外 composer 的测量本身也加了迟滞与 250ms 防抖（见 ComposerBar.measure），单帧抖动不会改判定。
 */

const WIDE = '(min-width: 44rem)'

const belowWide = ref(typeof window === 'undefined' ? false : !window.matchMedia(WIDE).matches)
const composerOverflow = ref(false)

if (typeof window !== 'undefined') {
  window.matchMedia(WIDE).addEventListener('change', (event) => {
    belowWide.value = !event.matches
  })
}

/**
 * True when the page should use the phone **layout**: drawer sidebar, full-width overlay columns.
 *
 * 布局唯一认的信号。它只由视口断点决定 —— 任何「内容宽度」判定都不能参与，否则就会重新制造
 * 下面 `mobile` 注释里描述的那个反馈环。
 */
export const mobileLayout = computed(() => belowWide.value)

/**
 * True when the composer controls should collapse to icons.
 *
 * 视口窄，或 composer 报告工具栏放不下它的桌面控件。它只影响控件形态，**不影响布局模式** ——
 * 所以「控件收起」不会再把两栏挤出文档流，也就不会触发新一轮测量。
 */
export const compact = computed(() => belowWide.value || composerOverflow.value)

/**
 * Legacy composite flag: narrow viewport **or** composer overflow.
 *
 * 保留它是为了兼容旧的调用点与既有测试（它们把「放不下」也算作 mobile）。**页面布局不再使用它** ——
 * 布局一律读 {@link mobileLayout}。两者共存不是冗余：`mobile` 回答「界面要不要按手机形态呈现」，
 * `mobileLayout` 回答「窗口是不是真的要换布局」，前者可以随内容变化，后者必须只随视口变化。
 */
export const mobile = computed(() => belowWide.value || composerOverflow.value)

/** @returns the viewport half of the decision, for diagnostics. */
export const isBelowWide = computed(() => belowWide.value)

/**
 * Report whether the composer toolbar fits its desktop controls.
 *
 * 调用方（ComposerBar）已经做了迟滞与防抖，这里只在结论真的变化时写一次，避免无谓的响应式通知。
 * @param value - true when the row overflows or the telemetry strip is squeezed.
 */
export function reportComposerOverflow (value) {
  const next = value === true
  if (composerOverflow.value !== next) composerOverflow.value = next
}
