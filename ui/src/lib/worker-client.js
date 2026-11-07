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
 * 投影规格里的「整棵保留」标记。
 *
 * 规格是纯数据（必须能被结构化克隆送进 Worker）：`true` 保留整棵子树，对象表示递归，数组元素的
 * 规格沿用同一个对象。这样每个路由只写一行声明，不必在 Worker 里堆 if 分支。
 */
const KEEP = true

/**
 * 在 Worker **内部**执行的投影实现（源码字符串，必须是自包含的）。
 *
 * 为什么要在 Worker 侧裁剪而不是主线程收完再裁：Worker 回包时要把解析结果做一次结构化克隆，
 * 克隆成本与对象体量成正比。先裁再回传，克隆的才是裁完的那一份；主线程收完再裁，那份成本已经
 * 花掉了。规则与主线程的 `projectValue` 必须逐字一致（见文件头「降级路径行为等价」的约定）。
 */
const WORKER_PROJECTION_SOURCE = `
const KEEP = true
function project (value, spec) {
  if (spec === KEEP) return value
  if (Array.isArray(value)) return value.map(function (item) { return project(item, spec) })
  if (value === null || typeof value !== 'object' || spec === null || typeof spec !== 'object') return undefined
  const out = {}
  const keys = Object.keys(spec)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const kept = project(value[key], spec[key])
    if (kept !== undefined) out[key] = kept
  }
  return out
}
function estimateChars (value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : text.length
  } catch (error) {
    return 0
  }
}
function split (value, chunkChars) {
  const single = { parts: [{ value: value, partIndex: 0 }], arrayKey: '' }
  const total = estimateChars(value)
  if (chunkChars <= 0 || total <= chunkChars) return single
  let arrayKey = ''
  let length = 0
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value)
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      const item = value[key]
      if (!Array.isArray(item) || item.length === 0) continue
      if (item.length > length) {
        length = item.length
        arrayKey = key
      }
    }
  }
  if (arrayKey === '') return single
  const wanted = Math.min(128, Math.max(2, Math.ceil(total / chunkChars)))
  const size = Math.min(2000, Math.max(1, Math.ceil(length / wanted)))
  const parts = []
  for (let at = 0; at < length; at += size) {
    const copy = Object.assign({}, value)
    copy[arrayKey] = value[arrayKey].slice(at, at + size)
    parts.push({ value: copy, partIndex: parts.length })
  }
  return { parts: parts, arrayKey: arrayKey }
}
`

/**
 * 内联 Worker 的源码：解析一整段 JSON → 按投影瘦身 → 按字节预算切片回传。
 *
 * 为什么是内联 Blob Worker 而不是第三个文件：stream-worker.js 只认 `data:` 前缀的 SSE 文本，
 * 让它兼职裸 JSON 会把两套协议混在一个入口里。
 *
 * 协议：收 `{ id, text, project, chunkChars }`；
 * - 失败发 `{ id, error }`（字符串，Error 对象跨线程克隆后拿不到原始类型）；
 * - 成功发一条或多条 `{ id, partIndex, partCount, arrayKey, value }`。`partCount > 1` 时主线程按
 *   `partIndex` 攒齐再拼——每条消息各自是一次结构化克隆，于是「一次 2.8MB 的克隆」被摊成十来次
 *   小克隆，主线程每次只处理一小段。
 */
const JSON_WORKER_SOURCE = `
${WORKER_PROJECTION_SOURCE}
self.onmessage = (e) => {
  const { id, text, project: spec, chunkChars } = e.data
  try {
    const parsed = JSON.parse(text)
    const slim = spec === undefined ? parsed : project(parsed, spec)
    const splitUp = split(slim, Number(chunkChars) || 0)
    const partCount = splitUp.parts.length
    for (let index = 0; index < partCount; index += 1) {
      const part = splitUp.parts[index]
      self.postMessage({
        id: id,
        partIndex: part.partIndex,
        partCount: partCount,
        arrayKey: splitUp.arrayKey,
        value: part.value,
      })
    }
  } catch (error) {
    self.postMessage({ id: id, error: String((error && error.message) || error) })
  }
}
`

/**
 * 主线程上的同名实现（Worker 不可用时的降级路径、以及单测的量具）。
 *
 * 与 `WORKER_PROJECTION_SOURCE` 里的实现必须逐字同义：Worker 路径与降级路径给调用方的必须是
 * 同一种形状，否则 api.js 会看到两种 payload。
 * @param value - 解析出的完整值。
 * @param spec - 投影规格；`undefined` 表示不做投影。
 * @returns 只保留规格里列出的字段的新值。
 */
export function projectValue (value, spec) {
  if (spec === undefined) return value
  if (spec === KEEP) return value
  if (Array.isArray(value)) return value.map((item) => projectValue(item, spec))
  if (value === null || typeof value !== 'object' || spec === null || typeof spec !== 'object') return undefined
  const out = {}
  for (const key of Object.keys(spec)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const kept = projectValue(value[key], spec[key])
    if (kept !== undefined) out[key] = kept
  }
  return out
}

/** @returns 一份值的近似字节数（JSON 字符数；用于决定切几片，不需要精确）。 */
function estimateChars (value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : text.length
  } catch {
    return 0
  }
}

/**
 * 把一个大值切成若干「能各自小成本克隆」的片。
 *
 * 只切最大的数组字段（`records` / `sessions` 这类响应的体量都集中在一个数组里），其余字段原样
 * 复制到每一片，主线程按 `partIndex` 拼回。单条片里的条目数不超过 2000，避免「片数够了但单片条目
 * 太多」。
 * @param value - 待回传的值。
 * @param chunkChars - 单片的字符预算；0 或负数表示不切。
 * @returns `{ parts, arrayKey }`，`parts` 每项是 `{ value, partIndex }`。
 */
export function splitValueForTransfer (value, chunkChars) {
  const single = { parts: [{ value, partIndex: 0 }], arrayKey: '' }
  const total = estimateChars(value)
  if (!(chunkChars > 0) || total <= chunkChars) return single
  let arrayKey = ''
  let length = 0
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      const item = value[key]
      if (!Array.isArray(item) || item.length === 0) continue
      if (item.length > length) {
        length = item.length
        arrayKey = key
      }
    }
  }
  if (arrayKey === '') return single
  const wanted = Math.min(128, Math.max(2, Math.ceil(total / chunkChars)))
  const size = Math.min(2000, Math.max(1, Math.ceil(length / wanted)))
  const parts = []
  for (let at = 0; at < length; at += size) {
    parts.push({ value: { ...value, [arrayKey]: value[arrayKey].slice(at, at + size) }, partIndex: parts.length })
  }
  return { parts, arrayKey }
}

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
 * 与 Worker 里那段「JSON.parse → 投影」必须同义：成功给 `{ value, error: undefined }`，失败把异常
 * 转成 `{ value: undefined, error: 字符串 }`，绝不抛出——调用方只认这一种形状。投影必须一起做：
 * 否则降级路径会把整棵原始对象交给页面，两条路径的 payload 形状就不一样了。
 * @param {string} text - 响应正文。
 * @param {object|undefined} project - 投影规格。
 * @returns {{ value: any, error: string|undefined }}
 */
function parseJsonOnMainThread (text, project) {
  try {
    const parsed = JSON.parse(text)
    return { value: project === undefined ? parsed : projectValue(parsed, project), error: undefined }
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
   * 把按 partIndex 到达的片拼回一个值。
   *
   * 切片的包装形状是「原对象 + 被切的那个数组字段」：其余字段每片都有（取第一片的即可），数组则
   * 按 partIndex 顺序拼回去 —— 顺序就是原顺序，页面拿到的数组与未切片时逐个相同。
   * @param job - 正在攒片的请求。
   * @returns 拼好的值。
   */
  function mergeParts (job) {
    const base = job.parts[0]
    if (job.arrayKey === '' || base === null || typeof base !== 'object') return base
    const merged = { ...base }
    merged[job.arrayKey] = job.parts.flatMap((part) => {
      const items = part?.[job.arrayKey]
      return Array.isArray(items) ? items : []
    })
    return merged
  }

  /**
   * 收 Worker 回包：按 id 找到挂起请求；分片时攒齐再 resolve，最后泵一次队列。
   * @param {MessageEvent} event - Worker 发来的 `{ id, partIndex, partCount, arrayKey, value }` 或 `{ id, error }`。
   */
  function onWorkerMessage (event) {
    const message = event.data
    const job = pending.get(message?.id)
    // 找不到说明是迟到回包或已 dispose，丢掉即可。
    if (job === undefined) return
    // `error` 存在即失败；否则成功。`value` 可能就是 null / 0 / ''，不能用真值判断。
    if (typeof message.error === 'string') {
      pending.delete(message.id)
      job.resolve({ value: undefined, error: message.error })
      pump()
      return
    }
    const partCount = Number(message.partCount) > 0 ? Number(message.partCount) : 1
    if (partCount > 1) {
      const partIndex = Number.isInteger(message.partIndex) ? message.partIndex : 0
      job.parts[partIndex] = message.value
      job.received += 1
      job.arrayKey = typeof message.arrayKey === 'string' ? message.arrayKey : ''
      // 还没收齐：不 resolve，等剩下的片（每一片都是独立的一次小克隆，主线程不会被一次性压住）。
      if (job.received < partCount) return
      pending.delete(message.id)
      job.resolve({ value: mergeParts(job), error: undefined })
      pump()
      return
    }
    pending.delete(message.id)
    job.resolve({ value: message.value, error: undefined })
    pump()
  }

  /** Worker 级故障（脚本报错 / 无法反序列化）：改走主线程，保证挂起的 promise 都有结果。 */
  function onWorkerFailure () {
    stopWorker()
    workerUnavailable = true
    for (const job of pending.values()) job.resolve(parseJsonOnMainThread(job.text, job.project))
    pending.clear()
    pump()
  }

  /** 按背压上限把队列里的请求投递给 Worker；没有 Worker 时就地用主线程解析。 */
  function pump () {
    while (queue.length > 0) {
      const live = ensureWorker()
      if (live === null) {
        const job = queue.shift()
        job.resolve(parseJsonOnMainThread(job.text, job.project))
        continue
      }
      // 在途已满：等回包触发下一次 pump，而不是继续往 Worker 里堆。
      if (pending.size >= MAX_JSON_IN_FLIGHT) return
      const job = queue.shift()
      const id = nextId
      nextId += 1
      pending.set(id, job)
      try {
        live.postMessage({ id, text: job.text, project: job.project, chunkChars: job.chunkChars })
      } catch {
        // 投递失败（Worker 刚失效等）：就地补算，不能让这个 promise 落空。
        pending.delete(id)
        job.resolve(parseJsonOnMainThread(job.text, job.project))
      }
    }
  }

  /**
   * 解析一段裸 JSON 文本。
   * @param {string} text - 响应正文。
   * @param {object} [options] - `{ project, chunkChars }`：投影规格与单片字符预算。
   * @returns {Promise<{ value: any, error: string|undefined }>} 成功给 `value`，失败给 `error`。
   */
  async function parse (text, options = {}) {
    // 已释放 / 已取消：立即给出结果，绝不留下一个永远不落定的 promise。
    if (disposed) return cancelledResult()
    if (typeof text !== 'string') return { value: undefined, error: '待解析的响应正文不是字符串' }
    const project = options?.project
    const chunkChars = Number(options?.chunkChars) > 0 ? Number(options.chunkChars) : 0
    return new Promise((resolve) => {
      queue.push({ text, project, chunkChars, resolve, parts: [], received: 0, arrayKey: '' })
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
