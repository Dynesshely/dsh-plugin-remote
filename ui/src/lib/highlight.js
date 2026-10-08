import hljs from 'highlight.js'

/**
 * Code highlighting, backed by highlight.js.
 *
 * highlight.js does the tokenising (190+ registered languages, plus fuzzy auto-detection) and
 * escapes everything it emits, which matters because tool output is untrusted and ends up in
 * `v-html`. Only the colours are ours: the token classes are styled in `style.css` so the highlight
 * palette follows the page's own light/dark theme instead of shipping a third-party stylesheet.
 */

/** Languages we never want auto-detection to settle on for a short snippet. */
const PLAIN = 'plaintext'

/** Auto-detection walks every registered language, so it is only worth it for real code blocks. */
const AUTO_MIN_LENGTH = 40
const AUTO_MAX_LENGTH = 20_000
/** Below this score the guess is noise, and uncoloured monospace reads better. */
const AUTO_MIN_RELEVANCE = 6

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
 * Highlight code with a known language.
 * @param code - the source text.
 * @param language - language id or alias; unknown names fall back to plain text.
 * @returns HTML with `hljs-*` token spans.
 */
export function highlightCode (code, language) {
  const text = String(code ?? '')
  const name = resolve(language)
  if (name === undefined) return hljs.highlight(text, { language: PLAIN, ignoreIllegals: true }).value
  return hljs.highlight(text, { language: name, ignoreIllegals: true }).value
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
 * JSON is detected by parsing (certain), everything else by highlight.js auto-detection — accepted
 * only when the text is long enough to be real code and the guess cleared {@link AUTO_MIN_RELEVANCE},
 * so short prose and one-line command output stay plain.
 * @param text - tool output.
 * @param language - an optional language hint, which wins over detection.
 * @returns HTML with token spans.
 */
export function codeHtml (text, language) {
  const source = String(text ?? '')
  const name = resolve(language)
  if (name !== undefined) return highlightCode(source, name)
  if (looksLikeJson(source)) return highlightJson(source)
  const trimmed = source.trim()
  if (trimmed.length < AUTO_MIN_LENGTH || trimmed.length > AUTO_MAX_LENGTH) {
    return hljs.highlight(source, { language: PLAIN, ignoreIllegals: true }).value
  }
  const auto = hljs.highlightAuto(source)
  return auto.relevance >= AUTO_MIN_RELEVANCE
    ? auto.value
    : hljs.highlight(source, { language: PLAIN, ignoreIllegals: true }).value
}

/** @returns the language ids highlight.js can highlight. */
export function supportedLanguages () {
  return hljs.listLanguages()
}
