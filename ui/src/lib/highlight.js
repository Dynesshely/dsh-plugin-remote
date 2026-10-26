import hljs from 'highlight.js'

/**
 * Code highlighting, backed by highlight.js.
 *
 * highlight.js does the tokenising (190+ registered languages) and escapes everything it emits, which
 * matters because tool output is untrusted and ends up in `v-html`. Only the colours are ours: the token
 * classes are styled in `style.css` so the highlight palette follows the page's own light/dark theme
 * instead of shipping a third-party stylesheet.
 *
 * 分词是同步的、跑在主线程上，所以这里有两道闸门：超过 {@link RENDER_MAX_LENGTH} 的文本不分词，
 * 超过 {@link AUTO_MAX_LENGTH} 的文本不做任何"猜内容"的试探。两者都是为了让一次渲染的最大耗时
 * 有上界，而不是随工具输出的大小失控。
 */

/** 兜底语法：不做任何分词，只做 HTML 转义。没有语言提示或语言未知时都用它。 */
const PLAIN = 'plaintext'

/**
 * 值得做试探（`JSON.parse`）的文本长度上限。
 *
 * 这个常量过去是自动检测的上限（20000）。自动检测已经删除（原因见 `codeHtml`），剩下唯一的试探是
 * `JSON.parse`，它的代价同样与长度线性相关，而在 4KB 以上再猜一次 JSON 换不到可感知的收益，所以降到
 * 4000：长文本直接按纯文本渲染，不再解析。
 */
const AUTO_MAX_LENGTH = 4000

/**
 * 允许进入分词器的文本长度上限。
 *
 * 512KB 级别的文本单次分词要 100–500ms，几十 KB 的 JSON/代码块也在几十毫秒量级；这段工作是同步的，
 * 期间页面既不响应点击也不响应滚动，也就是"僵死"。超过上限一律退回转义纯文本：这么长的内容本来也
 * 读不过来，牺牲高亮换主线程的响应性是划算的。
 */
const RENDER_MAX_LENGTH = 20_000

/**
 * @param language - a language id or alias, possibly empty.
 * @returns the registered language id, or undefined.
 */
function resolve (language) {
  const name = String(language ?? '').trim().toLowerCase().split(/\s+/u)[0] ?? ''
  if (name === '') return undefined
  return hljs.getLanguage(name) === undefined ? undefined : name
}

/**
 * @param value - 任意文本。
 * @returns 转义后的文本，可直接放进 HTML 文本节点。
 *
 * 用于超长文本的兜底路径：那里不再经过 highlight.js，转义必须自己做完，否则不可信的工具输出会原样
 * 进入 `v-html`。
 */
function escapeHtml (value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 超长文本的渲染结果：转义后的纯文本，外面套一个带 `hljs` 类的 span。
 *
 * 外套用 `<span>` 而不是 `<pre>`：调用方（`ToolCard.vue`、`FilePane.vue`、markdown 的代码块）已经把
 * 这段 HTML 放进自己的 `<pre>` 里，再套一层 `<pre>` 是非法嵌套。`hljs` 类保留下来，主题和字号仍按
 * 代码块的规则生效。
 * @param text - 原始文本。
 * @returns 安全 HTML。
 */
function plainHtml (text) {
  return `<span class="hljs">${escapeHtml(text)}</span>`
}

/**
 * Highlight code with a known language.
 * @param code - the source text.
 * @param language - language id or alias; unknown names fall back to plain text.
 * @returns HTML with `hljs-*` token spans.
 */
export function highlightCode (code, language) {
  const text = String(code ?? '')
  // 长度闸门：超限不分词，直接给转义纯文本，保证这次调用的耗时与文本大小无关。
  if (text.length > RENDER_MAX_LENGTH) return plainHtml(text)
  // 语言提示要先经过注册表校验：highlight.js 对未注册语言会抛异常，不能把调用方的脏提示直接丢进去。
  const name = resolve(language)
  return hljs.highlight(text, { language: name ?? PLAIN, ignoreIllegals: true }).value
}

/**
 * Highlight JSON (tool arguments, JSON fences).
 * @param text - pretty-printed JSON.
 * @returns HTML with token spans.
 */
export function highlightJson (text) {
  return highlightCode(text, 'json')
}

/**
 * Whether a text is worth colouring as JSON.
 *
 * Only objects and arrays count: a bare number or a quoted string in command output is not "JSON
 * output" and colouring it would be misleading.
 * @param text - candidate text.
 * @returns true when the whole text parses as a JSON object or array.
 */
export function looksLikeJson (text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  // 解析试探也要有预算：`JSON.parse` 是同步的，几百 KB 的输入要几十到几百毫秒，而这段文本最终会走
  // 纯文本分支，猜对了也没有收益。超长一律当作"不像 JSON"。
  if (trimmed.length > AUTO_MAX_LENGTH) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/**
 * Highlight arbitrary tool output.
 *
 * 策略是确定的：有语言提示就用它（经 `getLanguage` 校验，未知退回 plaintext），没有提示时先看是不是
 * JSON，其余一律按 plaintext 渲染。
 *
 * 这里不再做自动检测，也不重新引入：自动检测（highlight.js 的 `auto` 接口）会遍历全部已注册语法（约 190 种），对
 * 40–20000 字符的文本逐个尝试，单次 0.3–3 秒，是这条路径上唯一的秒级长任务，也是页面僵死的来源。
 * 猜错语法时的配色收益远小于卡顿的代价，所以宁可不着色。
 * @param text - tool output.
 * @param language - an optional language hint, which wins over JSON detection.
 * @returns HTML with token spans.
 */
export function codeHtml (text, language) {
  const source = String(text ?? '')
  // 与 highlightCode 同一道闸门，先于任何试探：超长文本连 JSON.parse 都不做。
  if (source.length > RENDER_MAX_LENGTH) return plainHtml(source)
  const name = resolve(language)
  if (name !== undefined) return highlightCode(source, name)
  if (looksLikeJson(source)) return highlightJson(source)
  return hljs.highlight(source, { language: PLAIN, ignoreIllegals: true }).value
}

/** @returns the language ids highlight.js can highlight. */
export function supportedLanguages () {
  return hljs.listLanguages()
}
