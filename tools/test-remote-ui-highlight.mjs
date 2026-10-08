// Unit test for the highlight.js integration used by tool cards and fenced code blocks.
// highlight.js is pure JS, so the real tokeniser runs in Node without a DOM.
//
// Run (from the plugin directory): node tools/test-remote-ui-highlight.mjs
import assert from 'node:assert/strict'
import { codeHtml, highlightCode, highlightJson, looksLikeJson, supportedLanguages } from '../ui/src/lib/highlight.js'

let failures = 0
function check (name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

console.log('Remote Control highlighting (highlight.js)')

check('the library really is registered with the full language set', () => {
  const languages = supportedLanguages()
  assert.ok(languages.length > 150, `expected the complete set, got ${languages.length}`)
  for (const language of ['json', 'powershell', 'bash', 'typescript', 'python', 'rust', 'sql', 'yaml', 'dockerfile', 'markdown', 'ini', 'diff']) {
    assert.ok(languages.includes(language), `${language} is missing`)
  }
})

check('JSON arguments are tokenised by class', () => {
  const html = highlightJson('{\n  "name": "read",\n  "count": 12,\n  "ok": true,\n  "none": null\n}')
  assert.match(html, /class="hljs-attr"/u, 'keys')
  assert.match(html, /class="hljs-string"/u, 'strings')
  assert.match(html, /class="hljs-number"/u, 'numbers')
  assert.match(html, /class="hljs-literal"/u, 'true/null')
})

check('other languages come from their own grammars', () => {
  assert.match(highlightCode('const answer = 42', 'javascript'), /hljs-keyword/u)
  assert.match(highlightCode('$x = Get-ChildItem -Path C:\\', 'powershell'), /hljs-/u)
  assert.match(highlightCode('def greet(name):\n    return name', 'python'), /hljs-keyword/u)
})

check('an unknown language degrades to escaped plain text', () => {
  const html = highlightCode('some <tag> & stuff', 'klingon')
  assert.ok(!html.includes('hljs-'), 'no tokens for an unknown grammar')
  assert.ok(html.includes('&lt;tag&gt;'), 'but it is escaped')
})

check('tool output can never inject markup', () => {
  const json = highlightJson('{"cmd":"<script>alert(1)</script>","img":"<img src=x onerror=alert(1)>"}')
  assert.ok(!json.includes('<script'), 'no script tag survives')
  assert.ok(!json.includes('<img'), 'no image tag survives')
  assert.ok(json.includes('&lt;script&gt;'), 'it is escaped instead')

  const auto = codeHtml('const html = "<script>alert(1)</script>"\nconst x = 1\nconst y = 2\nconst z = 3')
  assert.ok(!auto.includes('<script'), 'auto-detected code is escaped too')
})

check('only objects and arrays count as JSON output', () => {
  assert.equal(looksLikeJson('{"a":1}'), true)
  assert.equal(looksLikeJson('  [1, 2, 3]  '), true)
  assert.equal(looksLikeJson('"just a string"'), false, 'a bare string is not JSON output')
  assert.equal(looksLikeJson('42'), false)
  assert.equal(looksLikeJson('{"a":'), false)
  assert.equal(looksLikeJson('plain command output'), false)
  assert.equal(looksLikeJson(''), false)
  assert.equal(looksLikeJson(undefined), false)
})

check('auto-detection colours real code but leaves prose alone', () => {
  const ps = codeHtml('$files = Get-ChildItem -Path C:\\Temp -Recurse | Where-Object { $_.Length -gt 0 }\nWrite-Host $files.Count')
  assert.match(ps, /hljs-/u, 'a PowerShell snippet is detected')
  const prose = codeHtml('The command finished after four seconds and reported no errors at all.')
  assert.ok(!prose.includes('hljs-'), 'ordinary sentences stay plain')
  const oneLiner = codeHtml('total 3')
  assert.ok(!oneLiner.includes('hljs-'), 'short output stays plain')
})

check('a language hint wins over detection', () => {
  const hinted = codeHtml('{"a": 1}', 'json')
  assert.match(hinted, /hljs-attr/u)
})

check('the markdown pipeline hands fences to highlight.js', async () => {
  const { marked } = await import('../ui/src/lib/marked-setup.js')
  const powershell = marked.parse('```powershell\n$files = Get-ChildItem -Path C:\\Temp -Recurse\nWrite-Host $files.Count\n```')
  assert.match(powershell, /hljs language-powershell/u, 'the fence language is kept in the class list')
  assert.match(powershell, /hljs-/u, 'and the body is tokenised')

  const json = marked.parse('```json\n{"a": [1, true]}\n```')
  assert.match(json, /class="hljs-attr"/u)

  const noLanguage = marked.parse('```\n{"a": 1}\n```')
  assert.match(noLanguage, /hljs-attr/u, 'an unlabelled fence still gets JSON detection')

  const prose = marked.parse('Just a paragraph with `inline code`, nothing else.')
  assert.ok(!prose.includes('hljs-'), 'inline code is not highlighted as a block')
})

if (failures === 0) {
  console.log('\nAll highlighting checks passed.')
  process.exit(0)
}
console.log(`\n${failures} check(s) failed.`)
process.exit(1)
