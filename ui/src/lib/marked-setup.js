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

export { marked }
