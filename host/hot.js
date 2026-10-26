/**
 * Hot-reloadable routes: session management (pin / rename / fork / archive).
 *
 * `index.js` imports this module with an mtime-derived query string, so an edit here takes effect on
 * the next HTTP request instead of needing a DSH restart. Deliberately state-free: the mirrored
 * workspace sets and the session list stay in the shell and are passed in per request.
 *
 * The four actions go through the same Remotes the desktop client uses, and the mirrored sets come
 * back as complete lists — so a pin made here is instantly visible on the desktop, and one made there
 * arrives here through the shell's `workspaceController.follow()` subscription.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleModelMeta } from './model-meta.js'
/**
 * The usage module, re-imported whenever its file changes.
 *
 * It is a sibling module rather than part of this file, and Node caches modules by URL — so importing it
 * statically would freeze it for the life of the process. The mtime query is the same trick the shell
 * uses on this file, which is what makes an edit to the usage code take effect without a DSH restart.
 */
let usageModule = { module: undefined, mtimeMs: 0 }

/** @returns the freshly imported usage module. */
async function loadUsage () {
  const url = new URL('./usage.js', import.meta.url)
  const info = statSync(fileURLToPath(url))
  if (usageModule.module === undefined || usageModule.mtimeMs !== info.mtimeMs) {
    const fresh = new URL(url.href)
    fresh.searchParams.set('v', String(info.mtimeMs))
    usageModule = { module: await import(fresh.href), mtimeMs: info.mtimeMs }
  }
  return usageModule.module
}

/**
 * @param api - the shell context.
 * @returns whether the usage module handled the request.
 */
async function usageRoutes (api) {
  try {
    const module = await loadUsage()
    return await module.handleUsage(api)
  } catch (error) {
    api.json(500, { error: `usage module failed: ${String(error?.message ?? error)}` })
    return true
  }
}

/**
 * The file browser, re-imported whenever that module changes — the same trick the usage module uses, so
 * editing the browser does not need a DSH restart either.
 */
let filesModule = { module: undefined, mtimeMs: 0 }

/** @returns the freshly imported file-browser module. */
async function loadFiles () {
  const url = new URL('./files.js', import.meta.url)
  const info = statSync(fileURLToPath(url))
  if (filesModule.module === undefined || filesModule.mtimeMs !== info.mtimeMs) {
    const fresh = new URL(url.href)
    fresh.searchParams.set('v', String(info.mtimeMs))
    filesModule = { module: await import(fresh.href), mtimeMs: info.mtimeMs }
  }
  return filesModule.module
}

/**
 * @param api - the shell context.
 * @returns whether the file module handled the request.
 */
async function fileRoutes (api) {
  try {
    const module = await loadFiles()
    return await module.handleFiles(api)
  } catch (error) {
    api.json(500, { error: `files module failed: ${String(error?.message ?? error)}` })
    return true
  }
}

/** The desktop app's executable name, used when the Host does not run as the app itself. */
const APP_NAME = 'DeepSeek Harness.exe'

/**
 * 官方退出服务的名字。
 *
 * `@deepseek-ai/dsh-cmdline` 在整棵树挂载前，把 launcher 的「有界退出请求」注入成服务：
 * `ctx.provide('appExit', exit)`。桌面外壳与 `dsh web` 给出的 exit 都是
 * `@deepseek-ai/dsh/lib/profile-boot` 里的 `shutdown.shutdown(code)`：它 dispose 整棵 Cordis 树
 * （所有插件、订阅、HTTP server、会话），然后让进程以这个退出码自然结束。这是插件能拿到的**唯一**
 * 官方退出入口（headless 运行器同样用它），所以这里既没有 process.exit，也没有任何 kill。
 */
const APP_EXIT_SERVICE = 'appExit'

/** 回完响应到请求 dispose 之间的缓冲：让响应先落到 socket，前端才不会看到连接被重置。 */
const EXIT_FLUSH_MS = 400

/**
 * 自动点「重启」的开关。
 *
 * 默认开启：桌面端弹的是原生模态对话框，人不在电脑前时远程重启就会卡在那里等人点。关掉的方式是
 * 显式设成 0（`RC_AUTO_CONFIRM_RESTART=0`），此时行为回到「只弹框，等用户自己点」。
 */
const AUTO_CONFIRM_ENV = 'RC_AUTO_CONFIRM_RESTART'
/** 自动确认助手的总超时；可用 RC_AUTO_CONFIRM_TIMEOUT_MS 收敛（排障/测试用）。 */
const AUTO_CONFIRM_TIMEOUT_MS = 60_000
/** 助手的重试间隔（也用于等对话框出现）；可用 RC_AUTO_CONFIRM_INTERVAL_MS 调整。 */
const AUTO_CONFIRM_INTERVAL_MS = 400
/**
 * 等助手「证明自己活着」的上限。
 *
 * 为什么不再用固定延迟：fatal 一发出，shell 会立即退出（用户点「重启」后是 app.quit()），刚 spawn 的
 * PowerShell 很可能跟着被拆掉 —— 实测里 relaunch.log 连一条 phase=start 都没有，就是死在这一步。
 * 所以必须先看到助手写出的 ready 标记，确认它已经在跑，才允许发 fatal；宁可这次不重启，也不要留下一个
 * 永远没人点的模态对话框。3000ms 覆盖 PowerShell 冷启动 + Add-Type 编译的实测耗时。
 */
const AUTO_CONFIRM_READY_TIMEOUT_MS = 3000
/** 轮询 ready 标记的间隔。 */
const AUTO_CONFIRM_READY_POLL_MS = 100
/**
 * 确认助手活着之后、发 fatal 之前再留的一小段时间。
 *
 * 只为让助手完成阶段一（ALT trick + 把主窗口顶到前台）：主窗口在前台时，shell 随后弹的模态对话框才会
 * 自然出现在最上层。它不是「等助手启动」——那件事已经由 ready 握手保证了。
 */
const AUTO_CONFIRM_SETTLE_MS = 400
/** 助手的对话框等待窗口：30s 内没等到就干净退出，不空转。 */
const AUTO_CONFIRM_DIALOG_WAIT_MS = 30_000
/** 主窗口标题关键词：助手用它把主窗口和别的同进程窗口区分开。 */
const AUTO_CONFIRM_WINDOW_TITLE = 'DeepSeek Harness'
/** 恢复对话框标题关键词（逗号分隔，助手按任一匹配，中英文界面都覆盖）。 */
const AUTO_CONFIRM_DIALOG_TITLE = '无法使用,is unavailable'

/** @returns 是否允许自动点「重启」；未设置 = 允许，显式 0/false/off/no = 不允许。 */
function autoConfirmEnabled () {
  const raw = typeof process.env[AUTO_CONFIRM_ENV] === 'string' ? process.env[AUTO_CONFIRM_ENV].trim() : ''
  if (raw === '') return true
  return !/^(?:0|false|off|no)$/iu.test(raw)
}

/** @returns 自动确认助手的总超时（毫秒），做一个合理的夹取。 */
function autoConfirmTimeout () {
  const raw = Number(process.env.RC_AUTO_CONFIRM_TIMEOUT_MS ?? '')
  if (!Number.isFinite(raw) || raw <= 0) return AUTO_CONFIRM_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(raw), 1000), 300_000)
}

/** @returns 助手重试间隔（毫秒），夹取到 100–2000ms：太短空转，太长错过对话框。 */
function autoConfirmInterval () {
  const raw = Number(process.env.RC_AUTO_CONFIRM_INTERVAL_MS ?? '')
  if (!Number.isFinite(raw) || raw <= 0) return AUTO_CONFIRM_INTERVAL_MS
  return Math.min(Math.max(Math.trunc(raw), 100), 2000)
}

/** @returns 等 ready 标记的上限（毫秒），夹取到 500–10000ms，排障时可缩短。 */
function autoConfirmReadyTimeout () {
  const raw = Number(process.env.RC_AUTO_CONFIRM_READY_TIMEOUT_MS ?? '')
  if (!Number.isFinite(raw) || raw <= 0) return AUTO_CONFIRM_READY_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(raw), 500), 10_000)
}

/** @returns 确认 ready 后到 fatal 之间的缓冲（毫秒），夹取到 0–3000ms。 */
function autoConfirmSettle () {
  const raw = Number(process.env.RC_AUTO_CONFIRM_SETTLE_MS ?? '')
  if (!Number.isFinite(raw) || raw < 0) return AUTO_CONFIRM_SETTLE_MS
  return Math.min(Math.max(Math.trunc(raw), 0), 3000)
}

/** @returns 与 relaunch.mjs 共用的那本日志，按行追加，时间线读起来是连续的。 */
function controlLogPath () {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return join(home, 'remote-control', 'relaunch.log')
}

/**
 * 由 Node 直接往 relaunch.log 追加一行 spawn 诊断。
 *
 * 为什么不依赖 ps1 写：如果助手根本没活到写日志（这正是上一轮的症状），页面和日志都会一片空白。
 * Node 自己是确定还在跑的，由它记录「第几次尝试、用什么命令、pid、结果」，失败原因才可定位。
 * @param message - 已格式化的内容，会带上 UTC 时间戳与 `spawn:` 前缀。
 * @returns 是否写成功（日志失败绝不能影响重启流程）。
 */
function writeControlLog (message) {
  const line = `[${new Date().toISOString()}] spawn: ${message}\n`
  try {
    const path = controlLogPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * @param command - 可执行文件。
 * @param args - 参数数组。
 * @returns `{ child, error? }`：`spawn` 事件或 `error` 事件先到就先返回。
 *
 * 用事件判定「进程是否真的起来了」，而不是假定 `spawn()` 返回就等于成功：Windows 上找不到
 * powershell.exe、策略拦截、Job Object 拒绝都会以异步 `error` 事件出现。
 */
function launchAttempt (command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: process.cwd(),
    })
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      resolve(error === undefined ? { child } : { child, error })
    }
    child.once('spawn', () => { settle(undefined) })
    child.once('error', (error) => { settle(error) })
    // 极少数环境两个事件都迟迟不来：按「进程已起」继续，由 ready 握手下最终判定。
    setTimeout(() => { settle(undefined) }, 300).unref?.()
  })
}

/**
 * @param readyPath - 助手会写的 ready 标记。
 * @param timeoutMs - 最多等多久。
 * @returns 确认耗时（毫秒），超时返回 undefined。
 */
async function waitForReady (readyPath, timeoutMs) {
  const startedAt = Date.now()
  for (;;) {
    if (existsSync(readyPath)) return Date.now() - startedAt
    if (Date.now() - startedAt >= timeoutMs) return undefined
    await new Promise((resolve) => { setTimeout(resolve, AUTO_CONFIRM_READY_POLL_MS) })
  }
}

/** @returns 传给 ps1 的参数；打散成数组，路径里有空格也不会被拼坏。 */
function autoConfirmArgs (script, readyPath) {
  return [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    // 主窗口定位：Host 自己的 pid 优先，父进程（桌面外壳）兜底。
    '-TargetPid', String(process.pid),
    '-FallbackPid', String(process.ppid),
    '-WindowTitle', AUTO_CONFIRM_WINDOW_TITLE,
    '-DialogTitle', AUTO_CONFIRM_DIALOG_TITLE,
    // ready 握手：ps1 在类型加载成功后立刻写这个文件，Host 见到它才允许发 fatal。
    '-ReadyPath', readyPath,
    '-TimeoutMs', String(autoConfirmTimeout()),
    '-DialogWaitMs', String(AUTO_CONFIRM_DIALOG_WAIT_MS),
    '-IntervalMs', String(autoConfirmInterval()),
    '-LogPath', controlLogPath(),
  ]
}

/**
 * 起一个「自动点重启」助手，并确认它真的活下来之后才返回。
 *
 * 为什么必须先确认助手活着才发 fatal（关键）：fatal 一发出，shell 就会弹官方恢复对话框并（用户点
 * 「重启」后）立即 app.quit()。如果助手那时候还没真正跑起来，它会跟着 Host 的进程拆分一起被带走，
 * 我们的 relaunch.log 里就连一条 phase=start 都不会有 —— 上一轮实测正是这样。
 *
 * 两层脱离：
 *   1. 直接 `spawn('powershell.exe', [...], { detached: true, stdio: 'ignore' })`；
 *   2. 失败（或没在超时内确认）时改用 `cmd.exe /c start "" /b powershell.exe ...` —— cmd 起完
 *      `start` 立刻退出，PowerShell 成为孤儿进程，不再挂在 Host 的进程树里，更不容易被一起拆掉。
 * 两次都确认不到 → 返回失败，调用方**不发 fatal**、直接 500。
 * @param api - the shell context.
 * @param port - 仅用于日志，便于把一次重启和它的 Host 对上。
 * @returns `{ pid?, readyMs?, attempts?, skipped?, note }`；只有 `readyMs` 有值才表示「可以发 fatal」。
 *   `skipped` 表示有意不启用（非 Windows / 开关关闭），调用方仍按老语义只弹框。
 */
async function spawnAutoConfirm (api, port) {
  if (process.platform !== 'win32') return { skipped: true, note: 'skipped: Windows only' }
  if (!autoConfirmEnabled()) return { skipped: true, note: `skipped: ${AUTO_CONFIRM_ENV} is off` }
  const script = fileURLToPath(new URL('./confirm-restart.ps1', import.meta.url))
  if (!existsSync(script)) return { skipped: true, note: `skipped: helper script missing (${script})` }

  const logPath = controlLogPath()
  const readyDir = dirname(logPath)
  try {
    mkdirSync(readyDir, { recursive: true })
  } catch {
    /* 目录建不出来时 ready 握手会失败，下面的超时分支会如实报告 */
  }
  const readyPath = join(readyDir, `confirm-restart-ready-${String(process.pid)}-${String(Date.now())}.flag`)
  const args = autoConfirmArgs(script, readyPath)
  const timeoutMs = autoConfirmReadyTimeout()
  // Order matters: the VBS launcher is the only one that creates NO console for the child. The direct
  // spawn still flashes a console host briefly even with -WindowStyle Hidden, so it is only a fallback.
  const vbsLauncher = fileURLToPath(new URL('./confirm-restart.vbs', import.meta.url))
  const attempts = [
    ...(existsSync(vbsLauncher)
      ? [{ name: 'wscript.exe confirm-restart.vbs', command: 'wscript.exe', argv: ['//nologo', '//B', vbsLauncher, ...args] }]
      : []),
    { name: 'powershell.exe', command: 'powershell.exe', argv: args },
    // `cmd /c start "" /b ...`：空标题、/b 不弹新窗口；cmd 立刻退出，让 PowerShell 脱离进程树。
    { name: 'cmd.exe start /b powershell.exe', command: 'cmd.exe', argv: ['/c', 'start', '', '/b', 'powershell.exe', ...args] },
  ]

  writeControlLog(`begin hostPid=${String(process.pid)} port=${String(port)} log=${logPath} readyTimeout=${String(timeoutMs)}ms`)

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]
    const attemptNo = index + 1
    // 上一次的 ready 文件必须清掉，否则「上一轮的残留」会被当成本次确认。
    try {
      rmSync(readyPath, { force: true })
    } catch {
      /* 清不掉时最多是误判一次超时，日志里能看出来 */
    }
    let launched
    try {
      launched = await launchAttempt(attempt.command, attempt.argv)
    } catch (error) {
      writeControlLog(`attempt=${String(attemptNo)} cmd=${attempt.name} result=error: ${String(error?.message ?? error)}`)
      continue
    }
    const { child, error } = launched
    if (error !== undefined) {
      writeControlLog(`attempt=${String(attemptNo)} cmd=${attempt.name} result=error: ${String(error?.code ?? error?.message ?? error)}`)
      continue
    }
    // spawn 成功就立刻 unref，Host 的退出流程不该等这个子进程。
    try {
      child.unref()
    } catch {
      /* already gone */
    }
    writeControlLog(`attempt=${String(attemptNo)} cmd=${attempt.name} pid=${String(child?.pid ?? 0)} result=ok`)

    const readyMs = await waitForReady(readyPath, timeoutMs)
    if (readyMs === undefined) {
      writeControlLog(`attempt=${String(attemptNo)} cmd=${attempt.name} pid=${String(child?.pid ?? 0)} ready=timeout after ${String(timeoutMs)}ms`)
      // 没确认就杀掉，避免多留一个可能抢焦点的进程。
      try {
        child?.kill?.()
      } catch {
        /* already gone */
      }
      continue
    }
    writeControlLog(`attempt=${String(attemptNo)} cmd=${attempt.name} pid=${String(child?.pid ?? 0)} ready=confirmed in ${String(readyMs)}ms`)
    try {
      rmSync(readyPath, { force: true })
    } catch {
      /* 留着也无害 */
    }
    api.ctx.logger?.info?.(`[remote-control] auto-confirm helper ready (pid ${String(child?.pid ?? 0)}, ${String(readyMs)}ms, attempt ${String(attemptNo)})`)
    return {
      pid: child?.pid,
      readyMs,
      attempt: attemptNo,
      note: `auto-confirm helper ready after ${String(readyMs)}ms (attempt ${String(attemptNo)}: ${attempt.name})`,
    }
  }

  writeControlLog(`gave-up: no attempt confirmed the helper within ${String(timeoutMs)}ms`)
  api.ctx.logger?.warn?.('[remote-control] auto-confirm helper could not be confirmed alive; restart will be cancelled')
  return { note: 'failed: auto-confirm helper could not be confirmed alive (see relaunch.log)' }
}

/** @returns the launcher this machine would start, so the page can show it and be trusted about it. */
function launcherPath () {
  const running = process.execPath
  if (running.toLowerCase().endsWith(APP_NAME.toLowerCase())) return running
  const local = process.env.LOCALAPPDATA ?? ''
  return local === '' ? running : `${local}\\Programs\\DeepSeek Harness\\${APP_NAME}`
}

/**
 * @param api - the shell context.
 * @returns 官方退出函数；这个 DSH 没提供 appExit 服务时返回 undefined。
 */
function exitRequestOf (api) {
  const exit = api.ctx.get(APP_EXIT_SERVICE)
  return typeof exit === 'function' ? exit : undefined
}

/** @returns 一个普通 node 可执行文件：重启助手不能以应用本体运行，否则会和应用同生共死。 */
function nodeRuntime () {
  // 正常情况下宿主本身就是 node（桌面外壳 fork 的也是 node 运行时），直接复用即可。
  if (!process.execPath.toLowerCase().endsWith(APP_NAME.toLowerCase())) return process.execPath
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home !== '') {
    try {
      const root = `${home}\\.dsh\\dsh-runtimes`
      for (const name of readdirSync(root)) {
        const candidate = `${root}\\${name}\\dependencies\\node\\bin\\node.exe`
        if (existsSync(candidate)) return candidate
      }
    } catch {
      /* 没有可用运行时的话只能退回应用本体，此时重启助手会随宿主一起消失 */
    }
  }
  return process.execPath
}

/**
 * @returns 这台机器上「再启动一次 DSH」的方式。
 *
 * 两种部署形态差别很大：
 *  - 桌面应用：宿主是 Electron 外壳 fork 出来的子进程（有 IPC 通道），重启就是把应用本体再跑一次；
 *  - `dsh web` / CLI：当前进程自己就是宿主，重启就是用同一个 node、同一组参数再跑一次。
 * `RC_RELAUNCH_EXE`（配 `RC_RELAUNCH_ARGV`，JSON 数组）优先，给用包装脚本或 dshd 拉起 DSH 的部署
 * 留一个逃生口：那种情况下本插件猜不到启动命令。
 */
function relaunchTarget () {
  const override = typeof process.env.RC_RELAUNCH_EXE === 'string' ? process.env.RC_RELAUNCH_EXE.trim() : ''
  if (override !== '') {
    let argv = []
    try {
      const parsed = JSON.parse(process.env.RC_RELAUNCH_ARGV ?? '[]')
      if (Array.isArray(parsed)) argv = parsed.map(String)
    } catch {
      /* 参数写错就不带参数：exe 本身仍然能启动 */
    }
    return { kind: 'cli', exe: override, argv, source: 'RC_RELAUNCH_EXE' }
  }
  // fork 出来的子进程才有 IPC 通道；桌面外壳正是这样拉起宿主的。
  if (typeof process.send === 'function' && process.connected === true) {
    return { kind: 'desktop', exe: launcherPath(), argv: [], source: 'desktop-shell' }
  }
  if (process.argv.length < 2) return undefined
  return { kind: 'cli', exe: process.execPath, argv: process.argv.slice(1), source: 'process-argv' }
}

/**
 * 起一个 detached 的重启助手。
 *
 * 为什么必须另起进程：退出会把宿主连同本插件一起带走，进程内没有任何东西能再把自己拉起来。助手用
 * 普通 node 运行（不是应用本体），因此能活过这次退出；它只做「等旧实例走掉 + 启动」，不 kill 任何
 * 进程 —— 旧实例是被官方 appExit 优雅拆掉的。
 * @param api - the shell context.
 * @param port - 本插件真实监听的端口，用来说明旧实例是否真的走了。
 * @returns the helper's process id.
 */
async function spawnRelaunch (api, port) {
  const target = relaunchTarget()
  if (target === undefined) throw new Error('无法判断这台机器上的 DSH 启动方式（可用 RC_RELAUNCH_EXE 指定）')
  if (!existsSync(target.exe)) throw new Error(`启动器不存在：${target.exe}`)
  const helper = fileURLToPath(new URL('./relaunch.mjs', import.meta.url))
  const runtime = nodeRuntime()
  const env = { ...process.env }
  // 宿主自己就是 Electron 二进制时，要它按 node 语义执行脚本。
  if (runtime === process.execPath && process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = '1'
  const args = [
    helper,
    '--kind', target.kind,
    '--exe', target.exe,
    '--port', String(port),
    '--parent', String(process.ppid),
    ...target.argv.length === 0 ? [] : ['--argv', JSON.stringify(target.argv)],
  ]
  const child = spawn(runtime, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: process.cwd(), env })
  child.unref()
  api.ctx.logger?.info?.(`[remote-control] relaunch helper ${String(child.pid ?? 0)} (${target.source}): ${target.exe}`)
  return child.pid
}

/** @returns the parsed body, or undefined after the shell replied 400. */
async function bodyOf (api) {
  try {
    return await api.readJson(api.request)
  } catch {
    api.json(400, { error: 'bad request' })
    return undefined
  }
}

/** @returns the `workspaceController` service, or undefined when the Harness does not expose it. */
function controllerOf (api) {
  const controller = api.ctx.get('workspaceController')
  if (controller === undefined) api.json(503, { error: 'workspaceController 不可用（Harness 版本不支持会话管理）' })
  return controller
}

/**
 * Publish the new session list and the management sets to every open page.
 * @param api - the shell context.
 */
async function publish (api) {
  const payload = await api.sessionsPayload()
  api.broadcast('sessions', payload)
  return payload
}

/** Pin or unpin one Session. */
async function pin (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const controller = controllerOf(api)
  if (controller === undefined) return true
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') {
    api.json(400, { error: 'sessionId is required' })
    return true
  }
  try {
    const value = body.pinned === false
      ? await controller.unpinSession({ sessionId })
      : await controller.pinSession({ sessionId })
    api.setPinned(Array.isArray(value?.pinnedSessionIds) ? value.pinnedSessionIds : [])
    await publish(api)
    api.json(200, { ok: true, pinnedSessionIds: api.managementState().pinnedSessionIds })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/** Rename one Session (the title lives in the Session's title projection). */
async function rename (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const sessionId = String(body.sessionId ?? '')
  const title = String(body.title ?? '').trim()
  if (sessionId === '' || title === '') {
    api.json(400, { error: 'sessionId and a non-empty title are required' })
    return true
  }
  if (title.length > 200) {
    api.json(400, { error: '标题过长（上限 200 字）' })
    return true
  }
  try {
    const value = await api.ctx.sessionController.rename({ sessionId, title })
    await publish(api)
    api.json(200, { ok: true, title: String(value?.title ?? title) })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/**
 * Fork one Session from the last ended turn.
 *
 * `atSeq` is optional; leaving it out is exactly the "fork after the last completed turn" behaviour,
 * which is the only mode the page offers.
 */
async function fork (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') {
    api.json(400, { error: 'sessionId is required' })
    return true
  }
  const atSeq = Number.isSafeInteger(body.atSeq) ? body.atSeq : undefined
  try {
    const value = await api.ctx.sessionController.fork({ sessionId, ...(atSeq === undefined ? {} : { atSeq }) })
    await publish(api)
    api.json(200, { ok: true, sessionId: String(value?.sessionId ?? '') })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/** Archive or unarchive one Session, unpinning it on the way in like the desktop client does. */
async function archive (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const controller = controllerOf(api)
  if (controller === undefined) return true
  const sessionId = String(body.sessionId ?? '')
  if (sessionId === '') {
    api.json(400, { error: 'sessionId is required' })
    return true
  }
  const archived = body.archived !== false
  try {
    const value = archived
      // `stopActivity` defaults to false: archiving must not kill work the user did not ask to stop.
      ? await controller.archiveSession({ sessionId, stopActivity: body.stopActivity === true })
      : await controller.unarchiveSession({ sessionId })
    api.setArchived(Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : [])
    if (archived && api.managementState().pinnedSessionIds.includes(sessionId)) {
      // Mirrors the desktop client: an archived Session is no longer pinned.
      try {
        const unpinned = await controller.unpinSession({ sessionId })
        api.setPinned(Array.isArray(unpinned?.pinnedSessionIds) ? unpinned.pinnedSessionIds : [])
      } catch {
        /* the follow stream will correct the set anyway */
      }
    }
    await publish(api)
    const state = api.managementState()
    api.json(200, { ok: true, archivedSessionIds: state.archivedSessionIds, pinnedSessionIds: state.pinnedSessionIds })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}


/**
 * Localized labels for the built-in presets.
 *
 * The registry returns bare ids (its own \`name\` is the id), while the desktop picker shows these
 * labels — so the page uses the same wording and falls back to the registry for anything unknown.
 */
const PRESET_LABELS = {
  standard: {
    name: '标准模式',
    description: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
  },
  ptc: {
    name: 'PTC 模式',
    description: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  },
  minimal: {
    name: '极简模式',
    description: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
  },
  cordis: {
    name: '创造模式',
    description: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
  },
}

/**
 * List the agent presets — the desktop's "模式" choices (标准 / PTC / 极简 / 创造 …).
 * @param api - the shell context.
 */
async function presets (api) {
  const registry = api.ctx.get('agentPresets')
  if (typeof registry?.list !== 'function') {
    api.json(200, { presets: [] })
    return true
  }
  try {
    const list = await registry.list()
    const items = (Array.isArray(list) ? list : [])
      .map((preset) => {
        const id = String(preset?.id ?? '')
        const label = PRESET_LABELS[id]
        return {
          id,
          name: label?.name ?? String(preset?.name ?? id),
          description: label?.description
            ?? (typeof preset?.description === 'string' ? preset.description : undefined),
          order: typeof preset?.order === 'number' ? preset.order : 0,
          broken: typeof preset?.broken === 'string' ? preset.broken : undefined,
        }
      })
      .filter((preset) => preset.id !== '')
      .sort((left, right) => left.order - right.order)
    api.json(200, { presets: items })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/** Create one Session in a workspace, optionally with an agent preset ("模式"). */
async function create (api) {
  const body = await bodyOf(api)
  if (body === undefined) return true
  const request = {}
  if (typeof body.workspaceId === 'string' && body.workspaceId !== '') request.workspaceId = body.workspaceId
  if (typeof body.cwd === 'string' && body.cwd !== '') request.cwd = body.cwd
  if (typeof body.agentPreset === 'string' && body.agentPreset !== '') request.agentPreset = body.agentPreset
  if (request.workspaceId === undefined && request.cwd === undefined) {
    api.json(400, { error: 'workspaceId 或 cwd 至少需要一个' })
    return true
  }
  try {
    const value = await api.ctx.sessionController.create(request)
    await publish(api)
    api.json(200, {
      ok: true,
      sessionId: String(value?.sessionId ?? ''),
      ...(typeof value?.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    })
  } catch (error) {
    api.json(500, { error: String(error?.message ?? error) })
  }
  return true
}

/** Everything the page needs to describe this Host, and to be trusted about restarting it. */
function dshInfo (api) {
  const launcher = launcherPath()
  const target = relaunchTarget()
  api.json(200, {
    ok: true,
    launcher,
    launcherExists: existsSync(launcher),
    execPath: process.execPath,
    pid: process.pid,
    parentPid: process.ppid,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    platform: process.platform,
    // 页面据此决定要不要给「退出 / 重启」按钮：没有 appExit 时按下去只会得到可读错误。
    appExit: exitRequestOf(api) !== undefined,
    // 桌面形态走 shell 的官方对话框（唯一能真正重启整个应用的通道），CLI 形态才用 relaunch 助手。
    shell: shellChannelOpen(),
    // 自动点「重启」是否生效：Windows + 开关打开时才算生效，页面可据此提示用户。
    autoConfirmRestart: process.platform === 'win32' && autoConfirmEnabled(),
    restart: shellChannelOpen() ? 'shell-dialog' : (target === undefined ? null : 'relaunch-helper'),
    relaunch: target === undefined ? null : { kind: target.kind, exe: target.exe, exists: existsSync(target.exe), source: target.source },
    port: Number.isSafeInteger(api.boundPort) ? api.boundPort : null,
  })
  return true
}

/**
 * 桌面 shell 的 IPC 通道是否可用。
 *
 * 桌面形态下宿主是 Electron 外壳 fork 出来的子进程，`process.send` 是 Host→shell 的唯一通道；
 * `dsh web` / CLI 形态没有这条通道（当前进程自己就是宿主）。
 */
function shellChannelOpen () {
  return typeof process.send === 'function' && process.connected === true
}

/**
 * 请 shell 弹出官方恢复对话框（退出 / 重启）。
 *
 * 为什么只能这样：Host→shell 的 IPC 白名单只有 ready / platform-session / shutdown-complete /
 * fatal / update-tasks / quit-inspection，其中唯一能让 shell 执行动作的是 `fatal`。shell 收到它会
 * 把它当作启动失败，弹出官方恢复对话框（退出 / 重启 / 禁用第三方插件并重启），点「重启」时才执行
 * `app.relaunch()` + `app.quit()`。没有任何消息能让 shell 直接 relaunch，也没有这样的服务可注入，
 * 所以这就是「请求重启整个应用」唯一合法的通道。
 *
 * 同样重要的是：发完这条消息我们**不退出自己**。宿主一旦退出，窗口就停在「重新连接中…」而 shell
 * 无事可做；留在运行状态，窗口不掉线，重启/退出由 shell 自己完成（它会先发 shutdown IPC 让我们
 * 优雅拆除）。
 * @param api - the shell context.
 * @param message - 显示在对话框 detail 里、用户能读懂的一句话。
 * @param diagnostic - 写进崩溃报告的补充信息（说明这是用户主动请求，不是崩溃）。
 * @returns 消息是否交给了 shell；通道不在或发送抛错都是 false。
 */
function notifyShell (api, message, diagnostic) {
  if (!shellChannelOpen()) return false
  try {
    process.send({ type: 'fatal', message, diagnostic }, (error) => {
      if (error !== null) api.ctx.logger?.warn?.(`[remote-control] shell notify failed: ${String(error?.message ?? error)}`)
    })
    return true
  } catch (error) {
    api.ctx.logger?.warn?.(`[remote-control] shell notify threw: ${String(error?.message ?? error)}`)
    return false
  }
}

/**
 * 退出或重启 DSH。
 *
 * 两条路，按部署形态分：
 *  - 桌面（有 IPC 通道）：把请求交给 shell 的官方恢复对话框，由 shell 执行 `app.quit()` 或
 *    `app.relaunch()`。本进程保持运行，所以窗口不会掉线，也不会出现「Host 退了、shell 还在等」。
 *  - CLI / `dsh web`（没有 shell）：走官方 `appExit`（整树 dispose）；重启时先起 relaunch 助手，
 *    等旧监听器释放后再拉起新实例。
 * @param api - the shell context.
 * @param mode - `restart` or `exit`.
 */
async function dshControl (api, mode) {
  // 旧客户端还会带一个 body（里面有它自己猜的端口）；端口一律以宿主实际监听为准，不采信页面自报。
  const body = await bodyOf(api)
  if (body === undefined) return true
  // The real listening port, without waiting for a DSH restart: the socket this request arrived on already
  // knows it. `api.boundPort` is the preferred source (it survives even if the request came through a
  // proxy), but falling back to the socket means the CLI relaunch path works today instead of after the
  // next DSH restart — and a wrong port there would make the helper wait on the wrong instance.
  const socketPort = Number(api.request?.socket?.localPort)
  const port = Number.isSafeInteger(api.boundPort) && api.boundPort > 0
    ? api.boundPort
    : Number.isSafeInteger(socketPort) && socketPort > 0 ? socketPort : 0
  const restart = mode === 'restart'

  if (shellChannelOpen()) {
    // 重启时先起「自动点确认」助手，并**确认它已经活着**再发 fatal。exit 不自动点任何按钮 ——
    // 用户说「退出」就只弹框，由他自己选，避免语义冲突。
    let auto = { note: 'not a restart; nothing to auto-confirm' }
    if (restart) {
      auto = await spawnAutoConfirm(api, port)
      // 只有「本该启动却没能确认」才算失败；非 Windows / 开关显式关闭属于有意跳过，仍按老语义只弹框。
      if (auto.readyMs === undefined && auto.skipped !== true) {
        // fatal 会让 shell 立即退出。助手没确认活着却先弹对话框，就只剩一个没人点的模态框 —— 宁可不重启。
        api.ctx.logger?.warn?.(`[remote-control] restart cancelled: ${auto.note}`)
        api.json(500, {
          ok: false,
          action: mode,
          mode: 'failed',
          error: `自动确认助手未能启动，已取消重启以避免弹出无人处理的对话框（${auto.note}）`,
          autoConfirm: false,
          autoConfirmNote: auto.note,
        })
        return true
      }
    }
    const ready = restart && auto.readyMs !== undefined
    const settle = ready ? autoConfirmSettle() : 0
    const message = restart
      ? '远程控制（手机端）请求重启 DSH：点「重启」重启整个应用（Host 与窗口）。'
      : '远程控制（手机端）请求退出 DSH：点「退出」关闭应用。'
    const diagnostic = `remote-control: user-initiated ${mode} from the remote page (host pid ${String(process.pid)}, port ${String(port)})`

    if (ready) {
      // 助手已经确认在跑了：再给它 settle 时间完成「把主窗口顶到前台」，然后才让 shell 弹对话框。
      // 定时器故意不 unref：这段时间里必须保证 fatal 真的发出去，不能因为事件循环空了就把重启弄丢。
      setTimeout(() => {
        if (!notifyShell(api, message, diagnostic)) {
          api.ctx.logger?.warn?.('[remote-control] shell notify failed after the auto-confirm handshake; nothing was restarted')
          return
        }
        api.ctx.logger?.info?.(`[remote-control] shell notified (${mode}) ${String(settle)}ms after the auto-confirm helper was confirmed`)
      }, settle)
    } else {
      // 没有助手（exit / 有意跳过）：立刻通知；失败是一个可读的 5xx，而不是悄悄什么都不做。
      if (!notifyShell(api, message, diagnostic)) {
        api.json(500, { ok: false, action: mode, mode: 'failed', error: '无法通知桌面外壳（IPC 通道不可用），没有执行任何操作' })
        return true
      }
    }

    api.json(200, {
      ok: true,
      action: mode,
      mode: restart ? 'shell-restart-dialog' : 'shell-quit-dialog',
      pid: process.pid,
      port,
      // 助手状态对页面可见：自动确认被关掉时，前端可以提示「需要到桌面点一下」。
      ...(restart
        ? (ready
          ? { autoConfirm: true, autoConfirmPid: auto.pid, autoConfirmReadyMs: auto.readyMs, autoConfirmSettleMs: settle }
          : { autoConfirm: false, autoConfirmNote: auto.note })
        : { autoConfirm: false }),
      detail: restart
        ? (ready
          ? `已确认自动确认助手在运行（pid ${String(auto.pid ?? 0)}，${String(auto.readyMs)}ms 就绪）：对话框弹出后，助手会把它顶到最前并直接点「重启」。宿主保持运行，窗口不会掉线。`
          : `已通知桌面外壳：桌面端会弹出官方对话框，请点「重启」（不要点「禁用第三方插件」）。自动确认未启用（${auto.note}）。`)
        : '已通知桌面外壳：桌面端会弹出官方对话框，点「退出」即关闭应用（不要点「禁用第三方插件」）。宿主保持运行，窗口不会掉线。',
    })
    return true
  }

  const exit = exitRequestOf(api)
  if (exit === undefined) {
    api.json(503, {
      ok: false,
      action: mode,
      mode: 'unsupported',
      error: '这个 DSH 没有提供 appExit 服务，无法走官方退出路径',
    })
    return true
  }
  let helperPid
  if (restart) {
    if (port === 0) {
      // 旧宿主（index.js 还没更新）不会把这个字段交过来：宁可不重启，也不要拿一个猜出来的端口去判断
      // 旧实例是否已经走了 —— 误判的代价是多一个实例去抢同一个端口。
      api.json(503, {
        ok: false,
        action: mode,
        mode: 'unsupported',
        error: '宿主没有把实际监听端口交过来（index.js 的新版本要重启 DSH 才生效），暂不重启以免误判旧实例',
      })
      return true
    }
    try {
      helperPid = await spawnRelaunch(api, port)
    } catch (error) {
      api.json(500, { ok: false, action: mode, mode: 'failed', error: `重启助手启动失败：${String(error?.message ?? error)}` })
      return true
    }
  }
  api.json(200, {
    ok: true,
    action: mode,
    mode: 'graceful',
    pid: process.pid,
    port,
    ...(helperPid === undefined ? {} : { helperPid }),
    detail: restart
      ? '已请求官方优雅退出；旧监听器释放后，重启助手会把 DSH 重新拉起来。'
      : '已请求官方优雅退出（appExit）。',
  })
  // 响应已经写进 socket；留一点时间让它落地，再请求官方 dispose，避免前端看到连接被重置。
  setTimeout(() => {
    try {
      exit(0)
    } catch (error) {
      api.ctx.logger?.warn?.(`[remote-control] appExit failed: ${String(error?.message ?? error)}`)
    }
  }, EXIT_FLUSH_MS)
  return true
}

/**
 * One request from the shell.
 * @param api - `{ctx, request, url, json, readJson, broadcast, sessionsPayload, managementState, boundPort, setPinned, setArchived}`.
 * @returns whether this module handled the request.
 */
export async function handle (api) {
  // Balance and usage live in their own module: the routes, the parsers and the stored keys together.
  if (await usageRoutes(api)) return true
  // Model capacity metadata, joined from the gateway catalogue.
  if (await handleModelMeta(api)) return true
  // Read-only file browser over the workspace.
  if (await fileRoutes(api)) return true
  const method = api.request.method
  if (method === 'GET') {
    if (api.url.pathname === '/api/presets') return await presets(api)
    if (api.url.pathname === '/api/dsh/info') return dshInfo(api)
    return false
  }
  if (method !== 'POST') return false
  switch (api.url.pathname) {
    case '/api/session/pin': return await pin(api)
    case '/api/session/rename': return await rename(api)
    case '/api/session/fork': return await fork(api)
    case '/api/session/archive': return await archive(api)
    case '/api/session/create': return await create(api)
    case '/api/dsh/restart': return await dshControl(api, 'restart')
    case '/api/dsh/exit': return await dshControl(api, 'exit')
    default: return false
  }
}
