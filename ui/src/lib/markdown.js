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
export function renderMarkdown (text) {
  const html = marked.parse(String(text ?? ''))
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
