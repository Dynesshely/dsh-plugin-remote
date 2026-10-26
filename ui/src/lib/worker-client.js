/**
 * SSE 帧解析的主线程包装器。
 *
 * 解析本身在 stream-worker.js 里跑（单帧可达数百 KB，放在主线程做 `JSON.parse` 会把整页
 * 卡成「未响应」）。这个文件只做三件事：惰性起 Worker、给请求编号做请求/响应配对、在
 * Worker 不可用时无缝退化为主线程解析。
 *
 * 「任何环境都能工作」是硬约束：不支持 Worker 的环境（老浏览器、被 CSP 或沙箱禁用、Node
 * 里的单测）不能因此白屏，所以降级路径必须与 Worker 路径行为等价——同样的入参、同样的
 * `{ frames, errors }`、同样的错误文案。
 */

/** 单条帧的字符数上限，必须与 stream-worker.js 中的 MAX_FRAME_CHARS 一致。 */
const MAX_FRAME_CHARS = 8 * 1024 * 1024

/**
 * 同一时刻最多允许多少个请求在 Worker 里等待回包。
 *
 * 不设上限的话，一次突发就能把成百上千个待解析文本块堆在内存里；超过这个数的请求先在
 * 本地队列里排队，等前面的回包腾出位置再投递。
 */
const MAX_IN_FLIGHT = 32

/** @returns 一个空结果，用于已释放 / 无法解析等「拿不出帧」的分支。 */
function emptyResult () {
  return { frames: [], errors: [] }
}

/**
 * 主线程上的等价解析实现（Worker 不可用时的降级路径）。
 *
 * 这段规则必须与 stream-worker.js 中的 parseChunks / extractJsonText 保持一致。之所以是
 * 复制而不是共享模块：本次改动只允许新增两个文件，抽不出第三个公共文件；改动其中一处时
 * 请同步另一处。
 * @param {string[]} chunks - 若干条 SSE 原始行/事件文本块。
 * @returns {{ frames: object[], errors: string[] }} 与 Worker 路径完全同形。
 */
function parseOnMainThread (chunks) {
  const frames = []
  const errors = []
  if (!Array.isArray(chunks)) {
    errors.push('帧批次格式不正确：chunks 不是数组，已跳过')
    return { frames, errors }
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const position = String(index + 1)
    const chunk = chunks[index]
    if (typeof chunk !== 'string') {
      errors.push(`第 ${position} 条帧不是字符串，已跳过`)
      continue
    }
    const text = extractJsonText(chunk)
    // 没有正文的事件（心跳、纯注释行）不是错误，直接跳过。
    if (text === '') continue
    if (text.length > MAX_FRAME_CHARS) {
      errors.push(`第 ${position} 条帧过大（${String(text.length)} 字符，超过 ${String(MAX_FRAME_CHARS)} 字符上限），已跳过解析`)
      continue
    }
    try {
      frames.push(JSON.parse(text))
    } catch (error) {
      errors.push(`第 ${position} 条帧解析失败（${String(text.length)} 字符）：${String(error?.message ?? error)}`)
    }
  }
  return { frames, errors }
}

/**
 * 从一条 SSE 原始文本块里取出待解析的 JSON 正文；规则见 stream-worker.js。
 * @param {string} chunk - 一条 SSE 原始行或事件文本块。
 * @returns {string} 待解析的 JSON 文本；空字符串表示这条事件没有正文。
 */
function extractJsonText (chunk) {
  const dataLines = []
  for (const line of chunk.split(/\r?\n/u)) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) continue
    const value = trimmed.slice('data:'.length)
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  if (dataLines.length > 0) return dataLines.join('\n')
  const whole = chunk.trim()
  // 与 stream-worker.js 保持一致：注释行（心跳）与 `event:` / `id:` / `retry:` 字段行不含正文，
  // 安静跳过而不计入 errors。
  if (whole === '' || whole.startsWith(':') || /^(?:event|id|retry):/u.test(whole)) return ''
  return whole
}

/**
 * 建立一个 SSE 帧解析器。
 *
 * Worker 在第一次 parse 时才创建，避免只是打开页面、并不看流的场景白付一次启动开销。
 * @returns a parser that queues raw SSE chunks and resolves parsed frames.
 */
export function createStreamParser () {
  /** 在途请求：id → 该请求的文本块与 resolve，用于回包配对，也用于失败时补算。 */
  const pending = new Map()
  /** 超出背压上限后排队等待投递的请求，先进先出。 */
  const queue = []
  let worker = null
  let workerUnavailable = false
  let disposed = false
  let nextId = 1

  /**
   * 惰性创建 Worker。
   * @returns {Worker|null} Worker 实例；环境不支持或创建失败时为 null，调用方退化到主线程解析。
   */
  function ensureWorker () {
    if (worker !== null) return worker
    if (workerUnavailable || disposed) return null
    if (typeof Worker !== 'function') {
      // 没有 Worker 全局（Node、极老的浏览器）：直接认定不可用，不再反复尝试。
      workerUnavailable = true
      return null
    }
    try {
      // 这个字面量写法是 Vite 能静态识别的形式，Worker 入口会被单独打包。
      const created = new Worker(new URL('./stream-worker.js', import.meta.url), { type: 'module' })
      created.addEventListener('message', onWorkerMessage)
      created.addEventListener('messageerror', onWorkerFailure)
      created.addEventListener('error', onWorkerFailure)
      worker = created
    } catch {
      // 例如 CSP 或沙箱禁止构造 Worker：不把异常抛给调用方，静默降级。
      worker = null
      workerUnavailable = true
    }
    return worker
  }

  /** 终止并丢弃当前 Worker（如果还在）。 */
  function stopWorker () {
    if (worker === null) return
    try {
      worker.terminate()
    } catch {
      // 已经失效的 Worker 无需再处理。
    }
    worker = null
  }

  /**
   * 收 Worker 回包：按 id 找到挂起的请求，resolve 后清掉，再泵一次队列。
   * @param {MessageEvent} event - Worker 发来的 `{ id, frames, errors }`。
   */
  function onWorkerMessage (event) {
    const message = event.data
    const id = message?.id
    const job = pending.get(id)
    // 找不到说明是迟到回包或已 dispose，丢掉即可。
    if (job === undefined) return
    pending.delete(id)
    job.resolve({
      frames: Array.isArray(message.frames) ? message.frames : [],
      errors: Array.isArray(message.errors) ? message.errors : [],
    })
    pump()
  }

  /** Worker 级故障（脚本报错 / 无法反序列化）：改走主线程，保证挂起的 promise 都有结果。 */
  function onWorkerFailure () {
    stopWorker()
    workerUnavailable = true
    for (const job of pending.values()) job.resolve(parseOnMainThread(job.chunks))
    pending.clear()
    pump()
  }

  /** 按背压上限把队列里的请求投递给 Worker；没有 Worker 时就地用主线程解析。 */
  function pump () {
    while (queue.length > 0) {
      const live = ensureWorker()
      if (live === null) {
        const job = queue.shift()
        job.resolve(parseOnMainThread(job.chunks))
        continue
      }
      // 在途已满：等回包触发下一次 pump，而不是继续往 Worker 里堆。
      if (pending.size >= MAX_IN_FLIGHT) return
      const job = queue.shift()
      const id = nextId
      nextId += 1
      pending.set(id, job)
      try {
        live.postMessage({ id, chunks: job.chunks })
      } catch {
        // 投递失败（Worker 刚失效等）：就地补算，不能让这个 promise 落空。
        pending.delete(id)
        job.resolve(parseOnMainThread(job.chunks))
      }
    }
  }

  /**
   * 解析一批 SSE 原始文本块。
   * @param {string[]} chunks - 若干条 SSE 原始行/事件文本块。
   * @returns {Promise<{ frames: object[], errors: string[] }>} 解析成功的数据帧与逐条失败说明。
   */
  async function parse (chunks) {
    const list = Array.isArray(chunks) ? chunks : []
    // 已释放的解析器不再接活：立即给出空结果，而不是留下一个永远不落定的 promise。
    if (disposed) return emptyResult()
    return new Promise((resolve) => {
      queue.push({ chunks: list, resolve })
      pump()
    })
  }

  /**
   * 释放解析器：终止 Worker，并把所有还挂着的 promise 用空结果 resolve。
   *
   * 「挂起不落定」比「返回空结果」危险得多——调用方的 await 会永远等下去（例如页面切走时
   * 的收尾逻辑就卡在这里），所以这里宁可丢掉未完成的帧，也要把每个 promise 结清。
   */
  function dispose () {
    if (disposed) return
    disposed = true
    stopWorker()
    for (const job of pending.values()) job.resolve(emptyResult())
    pending.clear()
    while (queue.length > 0) queue.shift().resolve(emptyResult())
  }

  return { parse, dispose }
}
