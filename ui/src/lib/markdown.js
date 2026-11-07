import DOMPurify from 'dompurify'
import { marked } from './marked-setup.js'

/**
 * Render assistant text (or a reasoning chain) as sanitized HTML.
 *
 * The markdown → highlight.js pipeline lives in `marked-setup.js`; this module only adds the
 * sanitising step. The page holds an agent-control token, so model output is treated as untrusted:
 * DOMPurify strips scripts, event handlers, and unknown URL schemes before anything reaches
 * `v-html`.
 * @param text - raw model or user text.
 * @returns sanitized HTML.
 */
/**
 * One pass over a line of text.
 *
 * The alternatives are ordered so that a reference is classified once and never re-read: an existing
 * Markdown image and an inline code span are matched first and returned untouched, then a bare URL,
 * then a path. (An earlier version ran two passes and promoted its own output, which produced nested
 * `![…](…)` inside the URL.)
 */
const PROMOTABLE = /(!\[[^\]]*\]\([^)]*\))|(`[^`]*`)|(https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:\?[^\s)"'<>]*)?)|((?:[A-Za-z]:[\\/]|[^\s:`"'<>|]+[\\/])[^\s"'<>|]*?\.(?:png|jpe?g|gif|webp|svg|bmp|avif))/giu

/**
 * 单行长度闸门：超过这个字符数就整行跳过 promote 处理。
 *
 * `PROMOTABLE` 末支是 `[^\s:"'<>|]+[\\/]` 后面接惰性 `[^\\s"'<>|]*?\\.(?:png|…)`。惰性量词在
 * 无空格、无引号、又含 `/` 的超长单行（内联 base64 data URL、一长串 URL）上会退化成 O(n²)：
 * 每个起点都要把剩下的字符扫一遍再回溯，20k 字符约 1s，100k 级直接僵死主线程。正常 markdown
 * 里一行图片引用不可能有 2000 字符，所以超长行原样保留，不冒这个风险。
 */
const MAX_PROMOTE_LINE = 2000

/** @returns the last path segment, used as the alt text. */
function baseName (value) {
  const parts = String(value).split(/[\\/]/u)
  return parts[parts.length - 1] ?? ''
}

/**
 * Turn plain-text picture references into Markdown images.
 *
 * Tools and agents report a screenshot as a bare URL or a Windows path far more often than as Markdown,
 * and the transcript used to show that as a string — which is exactly why "the image does not load":
 * there was never an image. Fenced blocks and inline code are left alone, since a path printed there is
 * meant to be read, not rendered.
 * @param text - raw text.
 * @returns text with image references promoted.
 */
/**
 * Turn local markdown image syntax into an HTML tag *before* markdown parsing.
 *
 * Markdown treats a backslash as an escape, so `![x](D:\\Projects\\.meta\\a.png)` parses to a src of
 * `D:\\Projects.meta\\a.png` — the separator in front of the dot is consumed as an escape and the image
 * resolves to a directory that does not exist. Promoting bare paths was not enough: when the model writes
 * image syntax itself, marked is the thing eating the backslash. Converting first keeps the path intact,
 * because a backslash inside an HTML attribute is literal.
 *
 * Remote, data: and root-absolute sources keep their original syntax: markdown renders them correctly.
 * @param text - raw markdown.
 * @returns markdown with local images already written as HTML tags.
 */
function preparseLocalImages (text) {
  return String(text ?? '').replace(/!\[([^\]]*)\]\(\s*<?([^)>]+?)>?\s*\)/gu, (match, alt, source) => {
    const trimmed = source.trim()
    if (trimmed === '') return match
    // Two-character scheme or a slash: leave it to markdown. A single letter plus colon is a drive.
    if (/^(?:[a-z][a-z0-9+.-]+:|\/\/|\/)/iu.test(trimmed)) return match
    // Only paths that name a file; a bare word in parentheses is not an image.
    const pathOnly = trimmed.split(/[?#]/u)[0]
    if (!/\.[a-z0-9]{1,5}$/iu.test(pathOnly)) return match
    return '<img src="' + escapeAttribute(trimmed) + '" alt="' + escapeAttribute(alt) + '">'
  })
}

/** @returns a string safe to place inside a double-quoted HTML attribute. */
function escapeAttribute (value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

export function promoteImageReferences (text) {
  let inFence = false
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      if (/^\s*```/u.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      // 闸门必须放在 replace 之前：正则一旦跑起来，卡顿就已经花掉了（见 MAX_PROMOTE_LINE 的说明）。
      if (line.length > MAX_PROMOTE_LINE) return line
      return line.replace(PROMOTABLE, (match, existing, code, url, file) => {
        if (existing !== undefined || code !== undefined) return match
        const source = url !== undefined ? url : file
        if (source === undefined) return match
        // An HTML tag, not markdown syntax: markdown treats a backslash as an escape, so a Windows path like
        // D:\\Projects\\.meta\\shot.png lost the separator in front of the dot and resolved to a directory
        // that does not exist. Inside an HTML attribute the backslash is literal and survives.
        return `<img src="${escapeAttribute(source)}" alt="${escapeAttribute(baseName(source))}">`
      })
    })
    .join('\n')
}

/**
 * @param text - raw text.
 * @returns every image reference it contains, for the places that render plain text.
 */
export function imageReferencesIn (text) {
  const found = []
  const promoted = promoteImageReferences(text)
  // Two shapes now: the markdown form that was already here, and the HTML tag this module emits.
  for (const match of promoted.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/giu)) {
    const source = match[1].trim()
    if (source !== '' && !found.includes(source)) found.push(source)
  }
  for (const match of promoted.matchAll(/!\[[^\]]*\]\(<?([^)>]+)>?\)/gu)) {
    const source = match[1].trim()
    if (source !== '' && !found.includes(source)) found.push(source)
  }
  return found
}

/**
 * 单次渲染的字符上限。
 *
 * `marked.parse` + `DOMPurify.sanitize` 对整段文本没有任何长度上限：一条 20 万字的助手消息，或
 * 文件面板里的 512KB `.md` 预览，进渲染波段时单次就是 200–500ms 的同步任务，输入与滚动全部停摆。
 * 超长内容本来也读不完，所以超过就只渲染前一段，并在末尾说清楚发生了什么。
 */
const MAX_RENDER_CHARS = 50_000

/**
 * Route local image sources through the Host.
 *
 * A Session often refers to screenshots by path — `preview.png`, `docs/shot.png`, or a Windows absolute
 * path — and an <img> pointing at one resolves against the page's URL, which is never where the file is.
 * The Host's `/api/image` resolves a path inside a workspace and serves the bytes from this origin, so the
 * only thing missing was telling it which path to look for.
 *
 * Getting this right is mostly about *not* rewriting:
 *   - `http:`, `data:` and `blob:` already load, and a single letter followed by a colon is a drive letter,
 *     not a scheme, so the scheme test requires at least two characters.
 *   - A source starting with one slash is already origin-absolute. An earlier version rewrote those too,
 *     which wrapped `/api/image?path=…` inside another `/api/image?path=…`; the doubled request returned
 *     nothing, so every local image stayed broken.
 * @param html - rendered markdown.
 * @returns the same html with local image sources rewritten.
 */

function proxyLocalImages(html) {
  return html.replace(/<img\b([^>]*?)\ssrc="([^"]*)"/giu, (match, before, source) => {
    const trimmed = source.trim()
    if (trimmed === '') return match
    // Already proxied: rewriting again would nest the query into itself.
    if (trimmed.startsWith('/api/image')) return match
    // Origin-absolute, protocol-relative, or a fragment: nothing to resolve.
    if (trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('#')) return match
    // A real scheme. A single letter with a colon is a drive, not a scheme.
    if (/^[a-z][a-z0-9+.-]+:/iu.test(trimmed)) return match
    const query = new URLSearchParams({ path: trimmed })
    return '<img' + before + ' src="/api/image?' + query.toString() + '"'
  })
}

/**
 * @param text - 原始 markdown。
 * @returns `{ text, omitted }`：真正交给渲染的前缀，以及被省略的字符数。
 *
 * 截断点退到最后一个换行，避免把代码围栏或表格从中间切开后渲染成错误的结构；单行超长内容
 * （压缩过的 JSON、base64）没有换行可退，只能硬切。
 */
function clampForRender (text) {
  if (text.length <= MAX_RENDER_CHARS) return { text, omitted: 0 }
  const lineEnd = text.lastIndexOf('\n', MAX_RENDER_CHARS)
  const end = lineEnd > MAX_RENDER_CHARS * 0.8 ? lineEnd : MAX_RENDER_CHARS
  return { text: text.slice(0, end), omitted: text.length - end }
}

export function renderMarkdown (text) {
  const source = String(text ?? '')
  const clamped = clampForRender(source)
  const html = marked.parse(preparseLocalImages(promoteImageReferences(clamped.text)))
  // Rewrite here, once, right after sanitising: both exits below get it, and the truncation notice that
  // follows is fixed text this module owns, so it does not need to pass through image rewriting.
  const safe = proxyLocalImages(DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }))
  if (clamped.omitted === 0) return safe
  // 提示拼接在净化之后：它是本模块自己的固定文本，不含任何模型输出，不需要再过一次 DOMPurify。
  // 后半句给出原文长度，读者才知道自己少看了多少。
  return `${safe}<p class="rc-md-truncated">内容较长，仅渲染前 ${String(clamped.text.length)} 字符（原文 ${String(source.length)} 字符）</p>`
}

/** @returns the first line of a possibly long string, trimmed for a collapsed header. */
export function firstLine (text, limit = 120) {
  const line = String(text ?? '').split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`
}

/** @returns a compact JSON preview of tool arguments. */
export function prettyArguments (raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
