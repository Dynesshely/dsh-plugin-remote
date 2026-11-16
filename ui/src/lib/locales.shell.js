/**
 * Shell strings: the boot screen, the loading notices and the transport-level errors.
 *
 * Kept apart from the conversation and workspace slices because these are the strings a reader sees when
 * nothing else is on screen — a failed handshake, a slow first load — and they are better reviewed together.
 */

export const zhCN = {
  // ---- boot / loading ----------------------------------------------------
  'loading.appState': '应用状态',
  'loading.session': '会话',
  'loading.slow': '网络较慢，正在继续载入{label}…',
  'loading.failed': '{label}载入失败',
  'loading.done': '载入完成',
  'loading.items': '{count} 条',
  'loading.history': '正在载入历史…',
  'loading.historyWith': '正在载入历史 · {detail}',
  'loading.retry': '重试',
  'loading.tokenInvalidHint': '链接里的令牌无效，或已被更换。请在桌面端的远程控制页面重新获取链接。',

  // ---- shell -------------------------------------------------------------
  'shell.degraded': '转写渲染失败，已降级显示；切换会话或刷新可恢复',
  'shell.tokenInvalid': '链接里的令牌无效',
  'shell.connecting': '正在连接 DSH…',
  'shell.bootFailed': '无法连接到宿主',
  'shell.retry': '重试',

  // ---- store notices -----------------------------------------------------
  'store.orphans': '未归档',
  'store.fileFallback': '文件',
  'store.turnEnded': '本轮结束：{reason}',
  'store.unknownError': '未知错误',

  // ---- transport ---------------------------------------------------------
  'error.cancelled': '已取消',
  'error.timeout': '请求超时，请重试',
  'error.uploadTimeout': '图片上传超时，请重试',
  'error.offline': '无法连接到宿主，请检查网络',
  'error.reconnecting': '连接中断，正在重连…',
  'error.badToken': '令牌不正确',
  'error.frameParse': '数据帧解析失败（{bytes} 字节）：{reason}',
  'error.tooLarge': '请求体过大',
  'error.badRequest': '请求格式不正确',
}

export const enUS = {
  // ---- boot / loading ----------------------------------------------------
  'loading.appState': 'application state',
  'loading.session': 'session',
  'loading.slow': 'The network is slow; still loading {label}…',
  'loading.failed': 'Failed to load {label}',
  'loading.done': 'Loaded',
  'loading.items': '{count} items',
  'loading.history': 'Loading history…',
  'loading.historyWith': 'Loading history · {detail}',
  'loading.retry': 'Retry',
  'loading.tokenInvalidHint': 'The token in this link is invalid or has been replaced. Get a fresh link from the remote control page on the desktop.',

  // ---- shell -------------------------------------------------------------
  'shell.degraded': 'Transcript rendering failed and fell back to plain text; switching sessions or reloading restores it',
  'shell.tokenInvalid': 'The token in this link is invalid',
  'shell.connecting': 'Connecting to DSH…',
  'shell.bootFailed': 'Cannot reach the host',
  'shell.retry': 'Retry',

  // ---- store notices -----------------------------------------------------
  'store.orphans': 'Unfiled',
  'store.fileFallback': 'File',
  'store.turnEnded': 'Turn ended: {reason}',
  'store.unknownError': 'Unknown error',

  // ---- transport ---------------------------------------------------------
  'error.cancelled': 'Cancelled',
  'error.timeout': 'The request timed out, please try again',
  'error.uploadTimeout': 'The image upload timed out, please try again',
  'error.offline': 'Cannot reach the host, check the network',
  'error.reconnecting': 'Connection lost, reconnecting…',
  'error.badToken': 'The token is incorrect',
  'error.frameParse': 'Failed to parse a data frame ({bytes} bytes): {reason}',
  'error.tooLarge': 'The request body is too large',
  'error.badRequest': 'The request is malformed',
}
