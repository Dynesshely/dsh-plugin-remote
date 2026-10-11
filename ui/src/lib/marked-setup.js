import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import { codeHtml, highlightCode } from './highlight.js'

/**
 * The marked instance used by the transcript, wired to highlight.js.
 *
 * Kept free of any DOM dependency (sanitising happens in `markdown.js`) so the markdown → highlight
 * pipeline can be unit-tested in Node.
 */
marked.setOptions({ gfm: true, breaks: true })

marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight (code, language) {
    // A fence without an info string still gets a chance: `codeHtml` parses JSON and otherwise runs
    // highlight.js auto-detection.
    return language === '' || language === undefined ? codeHtml(code) : highlightCode(code, language)
  },
}))

/**
 * @param href - an image source from Markdown.
 * @returns the source the page should actually load.
 *
 * Session content often points at a picture by an internal hostname — the Harness serves its own files
 * from something like `https://dsh.<machine>.services.local/…` — which the phone cannot resolve, and
 * which the page's `img-src 'self'` would refuse even if it could. Both problems are the same problem:
 * the Host runs beside the Session, so it fetches the bytes and serves them from this origin.
 */
export function proxiedImageSrc (href) {
  const source = String(href ?? '').trim()
  if (source === '') return source
  if (/^https?:\/\//iu.test(source)) return `/api/image?url=${encodeURIComponent(source)}`
  // Anything rooted at the site is already ours.
  if (source.startsWith('/')) return source
  // A file on this machine — an absolute Windows path, or a workspace-relative one. Agents and tools
  // print these constantly (a screenshot they just wrote), and the Host resolves them inside a
  // workspace root.
  if (/^[A-Za-z]:[\\/]/u.test(source) || /[\\/]/u.test(source)) {
    return `/api/image?path=${encodeURIComponent(source)}`
  }
  return source
}

/** @returns text safe to place inside an HTML attribute. */
function attribute (value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

marked.use({
  renderer: {
    // A token-object renderer: marked hands over the parsed token, not positional arguments.
    image (token) {
      const source = attribute(proxiedImageSrc(token?.href))
      const alt = attribute(token?.text ?? '')
      const title = typeof token?.title === 'string' && token.title !== '' ? ` title="${attribute(token.title)}"` : ''
      // Lazy loading keeps a long transcript from fetching every screenshot at once.
      return `<img src="${source}" alt="${alt}"${title} loading="lazy" decoding="async">`
    },
  },
})

export { marked }
