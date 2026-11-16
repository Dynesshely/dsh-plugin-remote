import { install, lang, t } from './i18n.js'
import { enUS, zhCN } from './locales.misc.js'

// Worker 看不到主线程那份字典注册表，所以自己装一份本文件用到的切片；语言由每条消息带过来
// （主线程把 `lang.value` 一起投递），这样 Worker 报的错与页面当前语言一致。
install('zh-CN', zhCN)
install('en-US', enUS)

/**
 * SSE 帧解析 Worker。
 *
 * 解析下放到这里的原因：主线程原先直接对新到的帧做 `JSON.parse`，而单帧可达数百 KB。
 * 解析是纯 CPU 的同步工作，期间主线程上的渲染、输入、滚动全部停摆，用户看到的就是
 * 「页面未响应」。把这段工作搬进 Worker 后，主线程只负责把原始字符串投递进来、再
 * 接住已经解析好的对象，长任务的可见影响从「整页卡住」缩到「一次消息往返」。
 *
 * 本文件由主线程以
 * `new Worker(new URL('./stream-worker.js', import.meta.url), { type: 'module' })`
 * 加载，所以是一个 ES module Worker，`self` 即 WorkerGlobalScope。
 *
 * 消息契约：
 *   收 { id, chunks: string[] }            —— 若干条 SSE 原始行/事件文本块
 *   发 { id, frames: object[], errors: string[] }
 *
 * 另一个硬要求：解析失败绝不能把 Worker 弄崩。Worker 一崩，主线程上的挂起请求就没有
 * 回包了；所以每个 chunk 的失败都被就地收成一条 error 字符串跟着结果一起回传。
 */

/**
 * 单条帧文本的字符数上限。
 *
 * 超过就不解析：一个 8MB 的帧本身已经是大流量异常信号，把它丢进 `JSON.parse` 同样会长时间
 * 占住 Worker，还不如明确报出来让上层决定（丢弃 / 提示 / 重连）。
 */
const MAX_FRAME_CHARS = 8 * 1024 * 1024

/**
 * 从一条 SSE 原始文本块里取出待解析的 JSON 正文。
 *
 * SSE 的规则是事件由若干 `field: value` 行组成，正文放在 `data:` 行里；一个事件有多行
 * `data:` 时按规范用换行拼接。主线程的切片粒度由调用方决定，所以这里两种形态都接受：
 * 有 `data:` 行就取冒号后的内容，一行都没有就当作裸 JSON 文本（兼容直接把 `event.data`
 * 递过来的调用方）。
 * @param {string} chunk - 一条 SSE 原始行或事件文本块。
 * @returns {string} 待解析的 JSON 文本；空字符串表示这条事件没有正文。
 */
function extractJsonText (chunk) {
  const dataLines = []
  for (const line of chunk.split(/\r?\n/u)) {
    const trimmed = line.trimStart()
    // `:`、`event:`、`id:`、`retry:` 以及注释行都不承载正文。
    if (!trimmed.startsWith('data:')) continue
    const value = trimmed.slice('data:'.length)
    // 规范允许冒号后跟一个空格，而这个空格不属于数据。
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  if (dataLines.length > 0) return dataLines.join('\n')
  const whole = chunk.trim()
  // 没有 `data:` 行时，注释行（`:` 开头的心跳）和 `event:` / `id:` / `retry:` 字段行同样
  // 不承载正文：它们应当被安静跳过，而不是被当成坏 JSON 报错——真实连接里心跳是常态。
  if (whole === '' || whole.startsWith(':') || /^(?:event|id|retry):/u.test(whole)) return ''
  // 剩下的按裸 JSON 文本处理，兼容调用方直接投递 `event.data`。
  return whole
}

/**
 * 解析一批文本块。
 *
 * 任何一块失败都只记一条 error，不抛出：调用方拿到的永远是 `{ frames, errors }`，
 * 与主线程降级路径的返回值形状完全一致。
 * @param {string[]} chunks - 若干条 SSE 原始行/事件文本块。
 * @returns {{ frames: object[], errors: string[] }} 解析成功的数据帧与逐条的失败说明。
 */
function parseChunks (chunks) {
  const frames = []
  const errors = []
  if (!Array.isArray(chunks)) {
    errors.push(t('worker.badBatch'))
    return { frames, errors }
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const position = String(index + 1)
    const chunk = chunks[index]
    if (typeof chunk !== 'string') {
      errors.push(t('worker.frameNotString', { index: position }))
      continue
    }
    const text = extractJsonText(chunk)
    // 没有正文的事件（心跳、纯注释行）不是错误，直接跳过。
    if (text === '') continue
    if (text.length > MAX_FRAME_CHARS) {
      errors.push(t('worker.frameTooLarge', {
        index: position,
        chars: String(text.length),
        limit: String(MAX_FRAME_CHARS),
      }))
      continue
    }
    try {
      frames.push(JSON.parse(text))
    } catch (error) {
      errors.push(t('worker.frameParseFailed', {
        index: position,
        chars: String(text.length),
        reason: String(error?.message ?? error),
      }))
    }
  }
  return { frames, errors }
}

self.addEventListener('message', (event) => {
  const request = event.data
  const id = request?.id
  // 主线程随每条消息带上当前语言；只认两种合法值，别的保持原样。
  if (request?.lang === 'zh-CN' || request?.lang === 'en-US') lang.value = request.lang
  let result
  try {
    result = parseChunks(request?.chunks)
  } catch (error) {
    // 走到这里说明解析函数内部出了意外；仍然要回一条结果，否则主线程那个 promise 会一直挂着。
    result = { frames: [], errors: [t('worker.batchFailed', { reason: String(error?.message ?? error) })] }
  }
  self.postMessage({ id, frames: result.frames, errors: result.errors })
})
