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
      return line.replace(PROMOTABLE, (match, existing, code, url, file) => {
        if (existing !== undefined || code !== undefined) return match
        const source = url !== undefined ? url : file
        if (source === undefined) return match
        return `![${baseName(source)}](${source})`
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
  for (const match of promoteImageReferences(text).matchAll(/!\[[^\]]*\]\(<?([^)>]+)>?\)/gu)) {
    const source = match[1].trim()
    if (source !== '' && !found.includes(source)) found.push(source)
  }
  return found
}

export function renderMarkdown (text) {
  const html = marked.parse(promoteImageReferences(text))
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
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
