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
  // **先代理、再净化**：本地路径（`C:\…\a.png`）在 DOMPurify 眼里是一个非法 scheme —— 它要求
  // `[a-z]+:` 是已知协议，否则整条 `src` 被删掉，图片于是"渲染了但没有地址"（`<img alt="x">`）。
  // 换成同源的 `/api/image?path=…` 之后就是合法相对 URL，净化时会原样保留。
  const proxied = proxyLocalImages(html)
  const safe = DOMPurify.sanitize(proxied, { USE_PROFILES: { html: true } })
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

/* ---------------------------------------------------------------- 文件引用 → 文件卡片 */

/**
 * 会被渲染成文件卡片的类型分组。
 *
 * 只用于挑选图标与"是不是图片"的判断，不需要覆盖所有扩展名：不认识的归到 `unknown`，
 * 仍然会渲染成卡片，只是图标通用、没有缩略图。
 */
const FILE_KINDS = [
  ['image', 'png jpg jpeg gif webp svg bmp avif ico heic heif tif tiff'],
  ['document', 'pdf doc docx txt md rtf odt pages ppt pptx key'],
  ['sheet', 'xls xlsx csv tsv ods numbers'],
  ['code', 'js mjs cjs jsx ts tsx vue py rs go java c h cpp hpp cs php rb swift kt sh ps1 bat cmd sql json yaml yml toml ini xml html css scss less ipynb'],
  ['archive', 'zip rar 7z tar gz tgz bz2 xz dmg iso exe msi apk deb rpm'],
  ['media', 'mp4 mov avi mkv webm mp3 wav flac ogg m4a'],
]

/** 扩展名 → 分组。 */
const KIND_BY_EXTENSION = new Map()
for (const [kind, extensions] of FILE_KINDS) {
  for (const extension of extensions.split(' ')) KIND_BY_EXTENSION.set(extension, kind)
}

/**
 * 单行长度闸门：太长的行不做引用识别。
 *
 * 与 `MAX_PROMOTE_LINE` 同源：惰性量词在超长单行上会退化成 O(n²)，而正常 markdown 里一行引用
 * 不可能有 2000 字符。
 */
const MAX_FILE_LINE = 2000

/** @returns the extension of a path, without the dot and lower-cased. */
function extensionOf (value) {
  const clean = String(value ?? '').trim().split(/[?#]/u)[0]
  const match = /\.([a-z0-9]{1,6})$/iu.exec(clean)
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * @param value - 任意字符串。
 * @returns 它属于哪个卡片分组（image/document/sheet/code/archive/media/unknown）。
 */
export function fileKindOf (value) {
  const extension = extensionOf(value)
  return KIND_BY_EXTENSION.get(extension) ?? 'unknown'
}

/**
 * @param value - 一个引用。
 * @returns 它是否是"本地路径"：盘符路径或相对路径，而不是远程 URL、锚点、或已经代理的 URL。
 *
 * 单字母 + 冒号是盘符（`C:\…`），不是 scheme；真正的 scheme 至少两个字符。
 */
export function isLocalFilePath (value) {
  let text = String(value ?? '').trim()
  if (text === '') return false
  // 常见包裹：`<…>`、引号、反引号。
  text = text.replace(/^[<`"']+/u, '').replace(/[>`"']+$/u, '').trim()
  if (text === '') return false
  if (extensionOf(text) === '') return false
  // scheme / protocol-relative / 锚点 / 已经由宿主代理过的图片地址。
  if (/^(?:[a-z][a-z0-9+.-]+:|\/\/|#)/iu.test(text)) return false
  if (text.startsWith('/api/')) return false
  return true
}

/** @returns HTML 实体解码后的一小段文本（`<path>` 里的内容可能被转义过）。 */
function decodeEntities (value) {
  return String(value ?? '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
}

/**
 * @param path - 引用到的路径。
 * @param description - alt / title 里带来的说明文字。
 * @returns 一颗文件卡片需要的数据（组件不再需要额外请求就够画）。
 */
function referenceOf (path, description) {
  const clean = String(path ?? '').trim().replace(/^<|>$/gu, '')
  const extension = extensionOf(clean)
  return {
    path: clean,
    name: baseName(clean),
    extension,
    kind: KIND_BY_EXTENSION.get(extension) ?? 'unknown',
    description: String(description ?? '').trim(),
    isImage: KIND_BY_EXTENSION.get(extension) === 'image',
  }
}

/**
 * @param line - 一行 markdown。
 * @returns 该行里识别到的文件引用，以及摘掉引用之后剩下的文本。
 *
 * **只认两种写法**：`<path>…</path>` 标签，以及**整行就是一个**本地路径。图片引用
 * （`![alt](本地路径)` 与已有的本地 `<img>`）不再转成卡片 —— 读者要看到的是大图，那条链路留在
 * `preparseLocalImages` / `proxyLocalImages` 里。正文里顺带提到的路径也不动它：那多半是在讲解路径。
 */
function referencesInLine (line) {
  const references = []
  let text = line
  // 1. `<path>…</path>`：截图上方那种 chip，标签本身是明确意图。
  text = text.replace(/<path>([\s\S]*?)<\/path>/giu, (match, inner) => {
    const value = decodeEntities(inner).trim()
    if (!isLocalFilePath(value)) return match
    references.push(referenceOf(value, ''))
    return ' '
  })
  // 2. 整行就是一个本地路径（可带反引号/引号）——"裸路径独立成行"。
  //    markdown 图片语法不算：那种行要留给 markdown 渲染成内联大图。
  //    列表项/引用/标题前缀也剥掉：`- `C:\…`` 这种依旧是"独占一行的路径"。
  if (references.length === 0) {
    const candidate = text.trim()
    const isImageSyntax = /^!\[[^\]]*\]\(/u.test(candidate)
    const bare = candidate
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*|#{1,6}\s+)+/u, '')
      .trim()
      .replace(/^[`"']+/u, '')
      .replace(/[`"']+$/u, '')
      .trim()
    if (!isImageSyntax && bare !== '' && isLocalFilePath(bare)) {
      references.push(referenceOf(bare, ''))
      text = ' '
    }
  }
  return { text: text.replace(/[ \t]+$/u, ''), references }
}

/**
 * 把一段消息拆成"普通 markdown"与"文件卡片"两类片段。
 *
 * 只把 `<path>…</path>` 与"整行就是本地路径"这两类摘成卡片；图片引用仍然留在 markdown 里，
 * 由 `preparseLocalImages` / `proxyLocalImages` 渲染成内联大图。识别在任何 markdown 解析之前完成，
 * 所以被摘掉的路径不会再多渲染一份。代码围栏里的一律不动：那里的路径是给人读的。
 * 同一路径（忽略大小写与分隔符差异）只保留第一个卡片，重复出现的那次直接丢弃。
 * @param text - 原始消息文本。
 * @returns `{ parts, files }`：片段序列（`text` 带 markdown 原文，`file` 带卡片数据）与识别到的文件列表。
 */
export function extractFileReferences (text) {
  const source = String(text ?? '')
  const parts = []
  const files = []
  const seen = new Set()
  let buffer = []
  let inFence = false

  /** 把攒着的普通行输出成一个 text 片段。 */
  const flushText = () => {
    if (buffer.length === 0) return
    const value = buffer.join('\n')
    buffer = []
    if (value.trim() !== '') parts.push({ type: 'text', value })
  }

  /** @param reference - 识别到的一颗卡片数据。 */
  const pushFile = (reference) => {
    const key = reference.path.replace(/[\\/]+/gu, '/').toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    files.push(reference)
    parts.push({ type: 'file', file: reference })
  }

  for (const line of source.split('\n')) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence
      buffer.push(line)
      continue
    }
    if (inFence || line.length > MAX_FILE_LINE) {
      buffer.push(line)
      continue
    }
    const { text: rest, references } = referencesInLine(line)
    if (references.length === 0) {
      buffer.push(line)
      continue
    }
    flushText()
    if (rest.trim() !== '') {
      buffer.push(rest)
      flushText()
    }
    for (const reference of references) pushFile(reference)
  }
  flushText()
  return { parts, files }
}

