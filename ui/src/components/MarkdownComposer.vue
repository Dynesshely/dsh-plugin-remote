<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import hljs from 'highlight.js'

/**
 * Markdown composer with live preview, on CodeMirror 6.
 *
 * The document is plain Markdown text and CodeMirror owns every editing behaviour — selection,
 * multi-line drag, deletion across blocks, IME, undo — so none of that is reimplemented here. The only
 * custom part is the render layer: syntax markers are replaced away and their content is marked with a
 * CSS class, except on the line the caret sits on, which stays visible as source. That single rule is
 * what makes the surface read like a Markdown editor: edit the syntax where you are, see the result
 * everywhere else.
 */
const model = defineModel({ type: String, default: '' })

const props = defineProps({
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['submit', 'files'])

const host = ref(null)
let view
let lastReported = model.value
const editable = new Compartment()
const watermark = new Compartment()

/** Node names whose text is syntax rather than content, so it is replaced away. */
const HIDDEN = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
  'QuoteMark',
  'ListMark',
  'LinkMark',
  'URL',
  'CodeInfo',
])

/** Node name → class applied to its content, i.e. the rendered look. */
const MARKED = new Map([
  ['StrongEmphasis', 'rc-md-strong'],
  ['Emphasis', 'rc-md-em'],
  ['InlineCode', 'rc-md-code'],
  ['Strikethrough', 'rc-md-strike'],
  ['Link', 'rc-md-link'],
])

/** Heading node → class applied to its line. */
const HEADINGS = new Map([
  ['ATXHeading1', 'rc-md-h1'],
  ['ATXHeading2', 'rc-md-h2'],
  ['ATXHeading3', 'rc-md-h3'],
  ['ATXHeading4', 'rc-md-h4'],
  ['ATXHeading5', 'rc-md-h5'],
  ['ATXHeading6', 'rc-md-h6'],
  ['SetextHeading1', 'rc-md-h1'],
  ['SetextHeading2', 'rc-md-h2'],
])

const hide = Decoration.replace({})

/**
 * A list bullet, drawn where the source marker was.
 *
 * Replacing `- ` with this instead of styling the line keeps nesting honest: the bullet lands at the
 * item's own indentation, which is exactly where the source marker sat, so nested items line up with
 * their own text instead of with the line's left edge.
 */
class BulletWidget extends WidgetType {
  eq () {
    return true
  }

  toDOM () {
    const element = document.createElement('span')
    element.className = 'rc-md-bullet'
    element.textContent = '•'
    return element
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() })

/**
 * The fenced block's language, shown as a chip where the opening fence was.
 *
 * The fence itself is syntax and hides with the rest of it; the language it names is information, so
 * it is drawn back in — as a small chip, which also explains what the empty band above the code is.
 */
class LanguageWidget extends WidgetType {
  constructor (language) {
    super()
    this.language = language
  }

  eq (other) {
    return other.language === this.language
  }

  toDOM () {
    const element = document.createElement('span')
    element.className = 'rc-md-langchip'
    element.textContent = this.language
    return element
  }
}

/** @returns hljs HTML with its few escaped entities decoded back to text. */
function decodeEntities (text) {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/gu, (entity) => ({
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#x27;': "'",
    '&#39;': "'",
  })[entity] ?? entity)
}

/**
 * Colour one fenced block with highlight.js, which the transcript already uses.
 *
 * highlight.js reports tokens as HTML, so the spans are walked and turned into mark decorations;
 * offsets are counted in the decoded text because only four entities are ever escaped.
 * @param marks - the decoration accumulator.
 * @param code - the code text.
 * @param codeStart - its document offset.
 * @param info - the fence's info string, when it names a language.
 */
function highlightCode (marks, code, codeStart, info) {
  const language = info !== undefined && info !== '' && hljs.getLanguage(info) !== null ? info : undefined
  let html
  try {
    html = hljs.highlight(code, language === undefined ? { ignoreIllegals: true } : { language, ignoreIllegals: true }).value
  } catch {
    return
  }
  const token = /<span class="([^"]+)">|<\/span>|([^<]+)/gu
  const stack = []
  let offset = 0
  let match
  while ((match = token.exec(html)) !== null) {
    if (match[1] !== undefined) {
      stack.push(match[1])
      continue
    }
    if (match[0] === '</span>') {
      stack.pop()
      continue
    }
    const text = decodeEntities(match[2])
    if (stack.length > 0 && text.length > 0) {
      marks.push(Decoration.mark({ class: stack[stack.length - 1] }).range(codeStart + offset, codeStart + offset + text.length))
    }
    offset += text.length
  }
}

/**
 * 巨型围栏的判定阈值：行数或字符数任一超过，就不再整块处理。
 *
 * 粘贴 2000 行代码块之后，`buildDecorations` 每次按键/光标移动都要对整块 `sliceString` +
 * `hljs.highlight`，并给每一行建一个 `Decoration.line` —— 那是数百毫秒到数秒的同步任务，
 * 输入框直接假死。超过阈值的块只处理与视口相交的行，于是 decoration 数量被一屏行数界住。
 */
const BIG_FENCE_LINES = 120
const BIG_FENCE_CHARS = 8000
/**
 * 超阈值围栏里，单次交给 highlight.js 的字符上限。
 *
 * 一屏也可能是「一行几十万字符」的超长行，此时行数限制救不了 hljs；超过上限就只保留代码块
 * 底色，不再着色 —— 宁可少一层颜色，也不能让一次滚动重建再卡住输入。
 */
const VISIBLE_HIGHLIGHT_CHARS = 20_000

/**
 * Build the decorations for the visible document.
 * @param editorView - the editor view.
 * @returns the decoration set.
 */
function buildDecorations (editorView) {
  const { state } = editorView
  const selection = state.selection.main
  const caretLine = state.doc.lineAt(selection.head).number
  const marks = []
  /** 已经加过代码块底色的行（`line.from`）：同一围栏可能落在多个 visibleRanges 里被重复访问。 */
  const fenceLines = new Set()
  /** True while walking a fenced block's subtree, whose fence marks are handled below. */
  let inFence = false

  /**
   * @returns whether this range is being edited, i.e. the caret is inside it or on its line, in which
   * case its syntax stays visible and its content stays unstyled — source mode.
   */
  const editing = (from, to) => {
    if (selection.from <= to && selection.to >= from) return true
    // Whole blocks count: a list item or quote can span several lines and all of them stay source.
    return caretLine >= state.doc.lineAt(from).number && caretLine <= state.doc.lineAt(to).number
  }

  const addLine = (position, className) => {
    const line = state.doc.lineAt(position)
    marks.push(Decoration.line({ class: className }).range(line.from))
  }

  const forLines = (from, to, className) => {
    for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
      addLine(state.doc.line(number).from, className)
    }
  }

  for (const { from, to } of editorView.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        const start = node.from
        const end = node.to

        if (HEADINGS.has(name)) {
          addLine(start, HEADINGS.get(name))
          return
        }
        if (name === 'Blockquote') {
          forLines(start, end, 'rc-md-quote')
          return
        }
        // List items carry no line styling: the marker replacement below is their only chrome.
        if (name === 'HorizontalRule') {
          addLine(start, 'rc-md-hr')
          if (!editing(start, end)) marks.push(hide.range(start, end))
          return
        }
        if (name === 'FencedCode') {
          // The slab is drawn per line. The fence lines carry the fill and the rounded corners, so the
          // block reads as one rounded plate; the code inside is only indented by its own padding.
          const firstLine = state.doc.lineAt(start).number
          const lastLine = state.doc.lineAt(end).number
          const bodyFirst = firstLine + 1
          const bodyLast = lastLine - 1
          const blockEditing = editing(start, end)
          const infoNode = node.node.getChild('CodeInfo')
          const info = infoNode === null ? '' : state.doc.sliceString(infoNode.from, infoNode.to).trim()
          // 位置偏移就是 UTF-16 码元数，拿它当字符数量级足够判断「这块是不是大到不能整块处理」。
          const big = lastLine - firstLine + 1 > BIG_FENCE_LINES || end - start > BIG_FENCE_CHARS
          // 大块只装饰与当前可见范围相交的行：滚出视口的行不建对象，decoration 数量因此有界。
          const fromLine = big ? Math.max(firstLine, state.doc.lineAt(from).number) : firstLine
          const toLine = big ? Math.min(lastLine, state.doc.lineAt(to).number) : lastLine
          for (let number = fromLine; number <= toLine; number++) {
            const line = state.doc.line(number)
            if (fenceLines.has(line.from)) continue
            fenceLines.add(line.from)
            const classes = ['rc-md-codeblock']
            if (number === firstLine) classes.push('rc-md-codeblock-first')
            if (number === lastLine) classes.push('rc-md-codeblock-last')
            marks.push(Decoration.line({ class: classes.join(' ') }).range(line.from))
            // The fence markers disappear unless the caret is inside the block, so the plate looks
            // solid while working elsewhere but stays editable as source from within. The language the
            // opening fence named comes back as a chip, which is information rather than syntax.
            const isFence = number === firstLine || number === lastLine
            if (isFence && !blockEditing && line.to > line.from) {
              const widget = number === firstLine && info !== '' ? new LanguageWidget(info) : null
              marks.push(Decoration.replace({ widget }).range(line.from, line.to))
            }
          }
          // 高亮同样只取与视口相交的正文行：`sliceString` 和 hljs 的输入都随之有界，滚动时由
          // ViewPlugin 的 viewportChanged 分支重新计算这一段。
          const bodyFrom = Math.max(bodyFirst, fromLine)
          const bodyTo = Math.min(bodyLast, toLine)
          if (bodyTo >= bodyFrom) {
            const codeStart = state.doc.line(bodyFrom).from
            const code = state.doc.sliceString(codeStart, state.doc.line(bodyTo).to)
            // 一屏也可能是一行几十万字符的超长行：超过上限就只留底色，不再交给 hljs。
            if (!big || code.length <= VISIBLE_HIGHLIGHT_CHARS) {
              highlightCode(marks, code, codeStart, info === '' ? undefined : info)
            }
          }
          inFence = true
          return
        }
        if (MARKED.has(name)) {
          if (editing(start, end)) return
          marks.push(Decoration.mark({ class: MARKED.get(name) }).range(start, end))
          return
        }
        if (HIDDEN.has(name)) {
          // A fenced block hides or shows its own fence lines as a unit.
          if (inFence && (name === 'CodeMark' || name === 'CodeInfo')) return
          // An ordered list's number *is* its marker, so it stays; only bullets are replaced. The
          // list type lives above ListItem (OrderedList > ListItem > ListMark), so walk the ancestors.
          if (name === 'ListMark') {
            let ordered = false
            for (let ancestor = node.node.parent; ancestor !== null; ancestor = ancestor.parent) {
              if (ancestor.name === 'OrderedList') {
                ordered = true
                break
              }
              if (ancestor.name === 'BulletList') break
            }
            if (ordered) return
          }
          if (editing(start, end)) return
          marks.push(name === 'ListMark' ? bullet.range(start, end) : hide.range(start, end))
        }
      },
      exit: (node) => {
        if (node.name === 'FencedCode') inFence = false
      },
    })
  }

  return Decoration.set(marks, true)
}

const livePreview = ViewPlugin.fromClass(class {
  constructor (editorView) {
    this.decorations = buildDecorations(editorView)
  }

  update (update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildDecorations(update.view)
    }
  }
}, { decorations: (instance) => instance.decorations })

/** Hand pasted or dropped images to the composer, which owns the attachment flow. */
function handOffFiles (event) {
  const data = event.clipboardData ?? event.dataTransfer
  const files = [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'))
  if (files.length === 0) return false
  emit('files', files)
  return true
}

onMounted(() => {
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        history(),
        keymap.of([
          { key: 'Mod-Enter', run: () => { emit('submit'); return true } },
          indentWithTab,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        livePreview,
        EditorView.lineWrapping,
        EditorView.domEventHandlers({ paste: handOffFiles, drop: handOffFiles }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          const value = update.state.doc.toString()
          lastReported = value
          model.value = value
        }),
        editable.of(EditorView.editable.of(props.disabled !== true)),
        // CodeMirror's own placeholder: it lays the hint out with the document, so it lines up with
        // the caret instead of being positioned by hand.
        watermark.of(placeholder(props.placeholder)),
      ],
    }),
  })
})

// The parent owns the draft (sending clears it), so re-seed the document when the two drift apart.
watch(model, (value) => {
  if (view === undefined || value === lastReported) return
  lastReported = value
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
})

watch(() => props.placeholder, (value) => {
  view?.dispatch({ effects: watermark.reconfigure(placeholder(value)) })
})

watch(() => props.disabled, (value) => {
  view?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(value !== true)) })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = undefined
})
</script>

<template>
  <div class="rc-md relative w-full">
    <!-- CodeMirror owns this element's subtree imperatively, so Vue renders nothing inside it. -->
    <div ref="host" class="w-full"></div>
  </div>
</template>
