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

/* ---------------------------------------------------------------------------------------------
 * 裸 JSON 解析器（fetch 响应正文）
 * ------------------------------------------------------------------------------------------- */

/**
 * 内联 Worker 的源码：只做一件事——把一段裸 JSON 文本解析成对象，再把结果回传。
 *
 * 为什么是内联 Blob Worker 而不是第三个文件：stream-worker.js 只认 `data:` 前缀的 SSE 文本，
 * 让它兼职裸 JSON 会把两套协议混在一个入口里；而本次改动不允许新增文件，所以这里用
 * `URL.createObjectURL(new Blob([...]))` 现造一个入口。源码里没有 import/export，因此不需要
 * `{ type: 'module' }`——经典 Worker 能被所有目标浏览器直接加载，也省掉一次模块解析。
 *
 * 协议就一行：收 `{ id, text }`，成功发 `{ id, value }`，失败发 `{ id, error }`（字符串）。
 * `error` 一定要转成字符串再传：Error 对象跨线程克隆后拿不到原始类型，主线程也没法直接复用。
 */
const JSON_WORKER_SOURCE = `
self.onmessage = (e) => {
  const { id, text } = e.data
  try { self.postMessage({ id, value: JSON.parse(text) }) }
  catch (error) { self.postMessage({ id, error: String((error && error.message) || error) }) }
}
`

/**
 * 同一时刻最多允许多少个 JSON 解析请求在 Worker 里等回包（有界背压）。
 *
 * 与 SSE 路径同理：不设上限时，一次突发（例如切会话时同时打出的几个大请求）就能把几十份
 * 几百 KB 的响应文本堆在 Worker 队列里，主线程反而要为每份克隆付内存。超出就先排队。
 */
const MAX_JSON_IN_FLIGHT = 8

/**
 * Blob URL 不是构造完就能立刻回收的：个别浏览器（Safari）在 Worker 抓到脚本之前释放会直接
 * 启动失败，所以延迟一小段时间再 revoke。正常路径下只泄漏一个对象 URL 一秒钟。
 */
const BLOB_URL_RELEASE_DELAY_MS = 1_000

/**
 * 模块级单例。
 *
 * 单例放在 worker-client 内部而不是让 api.js 自己缓存：两种写法只能选一种，否则 api.js 缓一份、
 * 这里再缓存一份，页面里就会冒出两个 Worker。api.js 直接调 `createJsonParser()` 即可。
 */
let shared

/**
 * 主线程上的等价解析（Worker 不可用时的降级路径）。
 *
 * 与 Worker 里那段 `JSON.parse` 必须同义：成功给 `{ value, error: undefined }`，失败把异常
 * 转成 `{ value: undefined, error: 字符串 }`，绝不抛出——调用方只认这一种形状。
 * @param {string} text - 响应正文。
 * @returns {{ value: any, error: string|undefined }}
 */
function parseJsonOnMainThread (text) {
  try {
    return { value: JSON.parse(text), error: undefined }
  } catch (error) {
    return { value: undefined, error: String(error?.message ?? error) }
  }
}

/** @returns 一个「已取消」结果，用于 dispose 之后的每一次结清。 */
function cancelledResult () {
  return { value: undefined, error: '已取消' }
}

/**
 * 建立一个裸 JSON 解析器（单例）。
 * @returns {{ parse: (text: string) => Promise<{ value: any, error: string|undefined }>, dispose: () => void }}
 */
export function createJsonParser () {
  if (shared !== undefined) return shared
  shared = createJsonParserInstance()
  return shared
}

/**
 * 实际构造一个 JSON 解析器实例；对外只通过 `createJsonParser()` 的单例暴露。
 *
 * 惰性起 Worker 的理由与 SSE 解析器一致：只在真正有响应要解析时才付启动成本。
 * @returns the parser instance.
 */
function createJsonParserInstance () {
  /** 在途请求：id → `{ text, resolve }`，用于回包配对，也用于 Worker 挂掉时补算。 */
  const pending = new Map()
  /** 超出背压上限后排队等待投递的请求，先进先出。 */
  const queue = []
  let worker = null
  /** 当前 Blob URL；只在 Worker 存活期间非空。 */
  let blobUrl = null
  /** 延迟释放 Blob URL 的定时器 id。 */
  let releaseTimer = null
  let workerUnavailable = false
  let disposed = false
  let nextId = 1

  /**
   * 惰性创建内联 Worker。
   * @returns {Worker|null} Worker 实例；环境不支持或构造失败时为 null，调用方退化到主线程解析。
   */
  function ensureWorker () {
    if (worker !== null) return worker
    if (workerUnavailable || disposed) return null
    if (typeof Worker !== 'function' || typeof Blob !== 'function'
      || typeof URL !== 'function' || typeof URL.createObjectURL !== 'function') {
      // 没有 Worker / Blob / createObjectURL 全局（Node、极老浏览器）：直接认定不可用，不再重试。
      workerUnavailable = true
      return null
    }
    let objectUrl
    try {
      objectUrl = URL.createObjectURL(new Blob([JSON_WORKER_SOURCE], { type: 'text/javascript' }))
      const created = new Worker(objectUrl)
      created.addEventListener('message', onWorkerMessage)
      created.addEventListener('messageerror', onWorkerFailure)
      created.addEventListener('error', onWorkerFailure)
      worker = created
      blobUrl = objectUrl
      releaseTimer = setTimeout(releaseBlobUrl, BLOB_URL_RELEASE_DELAY_MS)
    } catch {
      // 例如 CSP 禁止 blob: Worker、沙箱禁用 Worker：不把异常抛给调用方，静默降级。
      if (objectUrl !== undefined) {
        try {
          URL.revokeObjectURL(objectUrl)
        } catch {
          // 已经失效的 URL 无需再处理。
        }
      }
      worker = null
      workerUnavailable = true
    }
    return worker
  }

  /** 释放 Blob URL（幂等）。Worker 抓到脚本之后它就没用了。 */
  function releaseBlobUrl () {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    if (blobUrl === null) return
    try {
      URL.revokeObjectURL(blobUrl)
    } catch {
      // 同上，已失效的 URL 忽略。
    }
    blobUrl = null
  }

  /** 终止并丢弃当前 Worker（如果还在）。 */
  function stopWorker () {
    releaseBlobUrl()
    if (worker === null) return
    try {
      worker.terminate()
    } catch {
      // 已经失效的 Worker 无需再处理。
    }
    worker = null
  }

  /**
   * 收 Worker 回包：按 id 找到挂起请求，resolve 后清掉，再泵一次队列。
   * @param {MessageEvent} event - Worker 发来的 `{ id, value }` 或 `{ id, error }`。
   */
  function onWorkerMessage (event) {
    const message = event.data
    const job = pending.get(message?.id)
    // 找不到说明是迟到回包或已 dispose，丢掉即可。
    if (job === undefined) return
    pending.delete(message.id)
    // `error` 存在即失败；否则成功。`value` 可能就是 null / 0 / ''，不能用真值判断。
    job.resolve(typeof message.error === 'string'
      ? { value: undefined, error: message.error }
      : { value: message.value, error: undefined })
    pump()
  }

  /** Worker 级故障（脚本报错 / 无法反序列化）：改走主线程，保证挂起的 promise 都有结果。 */
  function onWorkerFailure () {
    stopWorker()
    workerUnavailable = true
    for (const job of pending.values()) job.resolve(parseJsonOnMainThread(job.text))
    pending.clear()
    pump()
  }

  /** 按背压上限把队列里的请求投递给 Worker；没有 Worker 时就地用主线程解析。 */
  function pump () {
    while (queue.length > 0) {
      const live = ensureWorker()
      if (live === null) {
        const job = queue.shift()
        job.resolve(parseJsonOnMainThread(job.text))
        continue
      }
      // 在途已满：等回包触发下一次 pump，而不是继续往 Worker 里堆。
      if (pending.size >= MAX_JSON_IN_FLIGHT) return
      const job = queue.shift()
      const id = nextId
      nextId += 1
      pending.set(id, job)
      try {
        live.postMessage({ id, text: job.text })
      } catch {
        // 投递失败（Worker 刚失效等）：就地补算，不能让这个 promise 落空。
        pending.delete(id)
        job.resolve(parseJsonOnMainThread(job.text))
      }
    }
  }

  /**
   * 解析一段裸 JSON 文本。
   * @param {string} text - 响应正文。
   * @returns {Promise<{ value: any, error: string|undefined }>} 成功给 `value`，失败给 `error`。
   */
  async function parse (text) {
    // 已释放 / 已取消：立即给出结果，绝不留下一个永远不落定的 promise。
    if (disposed) return cancelledResult()
    if (typeof text !== 'string') return { value: undefined, error: '待解析的响应正文不是字符串' }
    return new Promise((resolve) => {
      queue.push({ text, resolve })
      pump()
    })
  }

  /**
   * 释放解析器：终止 Worker，并把所有还挂着的 promise 用 `{ error: '已取消' }` 结清。
   *
   * 「挂起不落定」比「返回取消」危险得多——调用方的 await 会一直等下去。宁可丢掉未完成的解析，
   * 也要把每个 promise 结清；同时把模块级单例清掉，之后 `createJsonParser()` 能造出新实例。
   */
  function dispose () {
    if (disposed) return
    disposed = true
    stopWorker()
    for (const job of pending.values()) job.resolve(cancelledResult())
    pending.clear()
    while (queue.length > 0) queue.shift().resolve(cancelledResult())
    if (shared === parser) shared = undefined
  }

  const parser = { parse, dispose }
  return parser
}
