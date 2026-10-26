/**
 * Relaunch DSH after the Remote Control host process has exited.
 *
 * 只有 **CLI / `dsh web` 形态**用它：那种部署里当前进程自己就是宿主，没有 Electron 外壳可以代劳退出
 * 与拉起。桌面应用不走这条路 —— 桌面端由 shell 的官方恢复对话框（`fatal` 通知触发）执行
 * `app.relaunch()`，那样才不会出现「Host 退了、窗口停在重新连接中」的半死状态。
 *
 * 为什么必须是独立进程：优雅退出会把宿主连同插件一起带走，进程内没有任何东西能再把自己拉起来。
 * 插件因此在退出**之前**用 detached 方式启动本脚本，于是它能活过那次退出。
 *
 * 它不 kill 任何进程：旧实例是被官方 `appExit`（Cordis 整树 dispose）拆掉的，本脚本只负责
 * 「等旧实例真的走了 → 确认没有别人把它拉起来 → 启动 → 看看有没有回来」。每一步都追加到
 * `<DSH home>/remote-control/relaunch.log`，这样「点重启后没回来」能事后查。
 *
 * Usage: node relaunch.mjs --port <n> [--kind desktop|cli] [--exe <path>] [--argv <json>]
 *                        [--parent <pid>] [--free-ms <n>] [--settle-ms <n>] [--observe-ms <n>]
 * （三个 -ms 是给测试与特殊部署用的收敛参数，默认值就是生产值。）
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 旧监听器让出端口的等待上限：宿主 dispose 是异步的，正常在 1-2 秒内完成。 */
const PORT_FREE_TIMEOUT_MS = 60_000
/**
 * 端口释放后的静置观察时间。
 *
 * 桌面外壳自己也在重启（`app.relaunch` + `app.quit`）时，新实例会在几秒内重新占住端口；先等一会儿
 * 再看一眼，就能把「别人已经拉起来了」和「真的没人拉」区分开，避免重复启动。
 */
const SETTLE_MS = 8_000
/** 启动之后等端口回来的上限。 */
const OBSERVE_MS = 60_000
/** 轮询间隔。 */
const POLL_MS = 500

/** @param name - flag name. @returns its value, or undefined. */
function flag (name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

/** @returns the log file path; honours DSH_HOME so tests and alternative homes stay isolated. */
function logPath () {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'remote-control', 'relaunch.log')
}

/** @param message - a line to record. */
function log (message) {
  try {
    const path = logPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* 日志是排障用的，写不了也不能影响重启 */
  }
}

/** @param ms - milliseconds. */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * @param port - the port to probe on loopback.
 * @returns whether something is still listening there.
 */
function portListening (port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (listening) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(listening)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    // 一个不回应的 connect 也不能让等待无限延长。
    setTimeout(() => done(false), 1000)
  })
}

/**
 * @param port - the port to watch.
 * @param timeoutMs - the longest wait.
 * @returns whether the port became free before the deadline.
 */
async function waitPortFree (port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portListening(port))) return true
    await sleep(POLL_MS)
  }
  return false
}

/**
 * @param port - the port to watch.
 * @param timeoutMs - the longest wait.
 * @returns whether the port started answering before the deadline.
 */
async function waitPortBack (port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portListening(port)) return true
    await sleep(POLL_MS)
  }
  return false
}

/** @returns the launch plan, or an exit code when the flags do not describe one. */
function readPlan () {
  const kind = flag('kind') === 'cli' ? 'cli' : 'desktop'
  const exe = flag('exe') ?? ''
  const port = Number(flag('port') ?? 0)
  const freeMs = Number(flag('free-ms') ?? PORT_FREE_TIMEOUT_MS)
  const settleMs = Number(flag('settle-ms') ?? SETTLE_MS)
  const observeMs = Number(flag('observe-ms') ?? OBSERVE_MS)
  let argv = []
  const rawArgv = flag('argv')
  if (rawArgv !== undefined) {
    try {
      const parsed = JSON.parse(rawArgv)
      if (Array.isArray(parsed)) argv = parsed.map(String)
    } catch {
      log(`ignoring unparseable --argv: ${rawArgv.slice(0, 200)}`)
    }
  }
  return { kind, exe, port, freeMs, settleMs, observeMs, argv }
}

/** @returns the process exit code for this run. */
async function main () {
  const plan = readPlan()
  log(`--- relaunch requested (helper pid ${String(process.pid)}, kind ${plan.kind}, port ${String(plan.port)}, exe ${plan.exe})`)
  if (!Number.isSafeInteger(plan.port) || plan.port <= 0) {
    log('no usable --port; refusing to guess when the old instance is gone')
    return 2
  }
  if (plan.exe === '' || !existsSync(plan.exe)) {
    log(`launcher not found: ${plan.exe}`)
    return 2
  }
  // 1. 等旧监听器释放：它还在应答，说明旧实例没走完，现在启动只会多一个实例去抢端口。
  if (!(await waitPortFree(plan.port, plan.freeMs))) {
    log(`port ${String(plan.port)} is still held after ${String(plan.freeMs / 1000)}s; not launching`)
    return 1
  }
  log(`port ${String(plan.port)} released`)
  // 2. 静置观察：桌面外壳自己的重启会在这段时间里把端口占回来，那就什么都不用做。
  await sleep(plan.settleMs)
  if (await portListening(plan.port)) {
    log('another instance already came back; nothing to launch')
    return 0
  }
  // 3. 启动。桌面形态拉起应用本体，CLI 形态用同一个 node 与同一组参数再跑一次。
  const args = plan.kind === 'cli' ? plan.argv : []
  const child = spawn(plan.exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: plan.kind !== 'desktop',
    cwd: process.cwd(),
    env: { ...process.env },
  })
  child.on('error', (error) => {
    log(`launch failed: ${String(error?.message ?? error)}`)
  })
  child.unref()
  log(`launched ${plan.exe} (pid ${String(child.pid ?? 0)})`)
  // 4. 报告有没有真的回来 —— 这是事后唯一有用的信息。
  const back = await waitPortBack(plan.port, plan.observeMs)
  log(back ? 'remote-control port is answering again' : `the app did not come back within ${String(plan.observeMs / 1000)}s`)
  return back ? 0 : 1
}

main().then((code) => {
  process.exitCode = code
}, (error) => {
  log(`unexpected failure: ${String(error?.message ?? error)}`)
  process.exitCode = 1
})
