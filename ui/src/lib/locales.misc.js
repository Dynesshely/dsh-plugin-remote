/**
 * 第三批本地化字符串：用量卡片的纯函数层、帧解析 Worker、以及收尾阶段剩下的零散文案。
 *
 * 与其它 `locales.*.js` 共用同一套扁平字典（`main.js` 用 `import.meta.glob('./lib/locales.*.js')`
 * 自动收集），所以只需按约定导出 `zhCN` / `enUS` 两个对象。
 *
 * key 前缀按来源分：
 *  - `usage.extra.*` —— `usage.js` 里算出、交给 `UsageCard` 自绘 tooltip 的文案（`usage.*` 已被
 *    `locales.workspace.js` 占用，这里只补它没有的）；
 *  - `worker.*` —— `worker-client.js` 与 `stream-worker.js` 的解析错误，两条路径必须同一条文案；
 *  - `misc.*` —— 其余零散位置（prompt rail、markdown 截断提示、图片暂存、响应解析、令牌门）。
 *
 * 能复用的既有 key（`action.*` / `error.*` / `loading.*` / `usage.*`）一律复用，不在这里重复定义。
 */

export const zhCN = {
  // ---- 用量卡片（usage.js 的纯函数）----------------------------------------
  'usage.extra.points': '点数',
  'usage.extra.noQuotaLine': '{amount}（无配额）',
  'usage.extra.resetReached': '已到重置时间',
  // 单位单独成 key，整句仍是「一段式」：语序由译文决定，不靠调用方拼接。
  'usage.extra.resetIn': '{value} {unit}后重置',
  'usage.extra.unitMinute': '分钟',
  'usage.extra.unitHour': '小时',
  'usage.extra.unitDay': '天',
  'usage.extra.source': '来源',
  'usage.extra.window': '窗口',
  'usage.extra.amountLine': '{percent}%（{amount}）',

  // ---- 帧解析（worker-client.js / stream-worker.js 共用）-------------------
  'worker.badBatch': '帧批次格式不正确：chunks 不是数组，已跳过',
  'worker.frameNotString': '第 {index} 条帧不是字符串，已跳过',
  'worker.frameTooLarge': '第 {index} 条帧过大（{chars} 字符，超过 {limit} 字符上限），已跳过解析',
  'worker.frameParseFailed': '第 {index} 条帧解析失败（{chars} 字符）：{reason}',
  'worker.batchFailed': '帧批次处理失败：{reason}',
  'worker.textNotString': '待解析的响应正文不是字符串',

  // ---- prompt rail --------------------------------------------------------
  'misc.railTick': '第 {index} 条 prompt',

  // ---- markdown 截断提示 ---------------------------------------------------
  'misc.mdTruncated': '内容较长，仅渲染前 {shown} 字符（原文 {total} 字符）',

  // ---- 图片暂存与上传 ------------------------------------------------------
  'misc.imageTypeUnsupported': '不支持的图片类型：{type}',
  'misc.imageTypeUnknown': '未知',
  'misc.imageTooLarge': '图片过大（{size} MB），上限 {limit} MB',
  'misc.imageEmpty': '这张图片是空的，无法发送',
  'misc.uploadFailedNoReference': '上传失败：宿主没有返回图片引用',

  // ---- 响应解析 -----------------------------------------------------------
  'misc.responseParseFailed': '响应解析失败：{reason}',
  'misc.responseTooLarge': '响应过大（{size} MB），已拒绝解析',

  // ---- 转写里的诊断行 ------------------------------------------------------
  'misc.eventDump': '{type}：{data}',

  // ---- 令牌门（App.vue）----------------------------------------------------
  'misc.tokenGateLead': '需要一个访问令牌。它由 Host 首次启动时生成，写在',
  'misc.tokenGateMiddle': '，或直接使用带',
  'misc.tokenGateTail': '的链接。',
  'misc.tokenPlaceholder': '令牌',
  'misc.enter': '进入',

  // ---- 右栏拖拽把手 --------------------------------------------------------
  'misc.resizeWidth': '拖动调整宽度',
}

export const enUS = {
  // ---- Usage card (the pure-function layer in usage.js) -------------------
  'usage.extra.points': 'points',
  'usage.extra.noQuotaLine': '{amount} (no quota)',
  'usage.extra.resetReached': 'Reset time reached',
  // 英文用 45m / 3h / 2d 这种紧凑写法：既不用复数规则，也不会出现 "1 days"。
  'usage.extra.resetIn': 'Resets in {value}{unit}',
  'usage.extra.unitMinute': 'm',
  'usage.extra.unitHour': 'h',
  'usage.extra.unitDay': 'd',
  'usage.extra.source': 'Source',
  'usage.extra.window': 'Window',
  'usage.extra.amountLine': '{percent}% ({amount})',

  // ---- Frame parsing (shared by worker-client.js and stream-worker.js) ----
  'worker.badBatch': 'Malformed frame batch: chunks is not an array, skipped',
  'worker.frameNotString': 'Frame {index} is not a string, skipped',
  'worker.frameTooLarge': 'Frame {index} is too large ({chars} characters, over the {limit}-character cap), parsing skipped',
  'worker.frameParseFailed': 'Frame {index} failed to parse ({chars} characters): {reason}',
  'worker.batchFailed': 'The frame batch failed: {reason}',
  'worker.textNotString': 'The response text to parse is not a string',

  // ---- Prompt rail --------------------------------------------------------
  'misc.railTick': 'Prompt {index}',

  // ---- Markdown truncation notice -----------------------------------------
  'misc.mdTruncated': 'Long content: only the first {shown} of {total} characters are rendered',

  // ---- Image staging and upload -------------------------------------------
  'misc.imageTypeUnsupported': 'Unsupported image type: {type}',
  'misc.imageTypeUnknown': 'unknown',
  'misc.imageTooLarge': 'The image is too large ({size} MB); the limit is {limit} MB',
  'misc.imageEmpty': 'This image is empty and cannot be sent',
  'misc.uploadFailedNoReference': 'Upload failed: the Host returned no image reference',

  // ---- Response parsing ---------------------------------------------------
  'misc.responseParseFailed': 'Failed to parse the response: {reason}',
  'misc.responseTooLarge': 'The response is too large ({size} MB), parsing refused',

  // ---- Diagnostic rows in the transcript ----------------------------------
  'misc.eventDump': '{type}: {data}',

  // ---- Token gate (App.vue) -----------------------------------------------
  'misc.tokenGateLead': 'An access token is required. The Host generates it on first start and writes it to',
  'misc.tokenGateMiddle': ', or use a link that already carries',
  'misc.tokenGateTail': '.',
  'misc.tokenPlaceholder': 'Token',
  'misc.enter': 'Enter',

  // ---- Right column resize handle -----------------------------------------
  'misc.resizeWidth': 'Drag to resize',
}
