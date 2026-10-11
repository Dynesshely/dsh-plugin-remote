/**
 * Restart or quit the desktop app from outside it.
 *
 * The plugin cannot do this itself: quitting DSH takes the Host — and therefore the plugin — down with it,
 * so nothing would be left to start it again. This script is spawned detached, outlives the app, and does
 * the sequence from the outside: close the app, wait until its port is really free, then launch it again
 * (for `restart`).
 *
 * It must **not** be launched through the app's own executable. `taskkill /IM "DeepSeek Harness.exe"`
 * matches by image name, so a helper running as that same executable kills itself halfway through the
 * restart — which is exactly how the first version behaved: the app quit, and nothing came back. The
 * spawner therefore uses a plain node runtime, and this file refuses to run as the app at all.
 *
 * Every step is appended to `~/.dsh/remote-control/dsh-control.log`, so a restart can be diagnosed after
 * the fact.
 *
 * Usage: node dsh-control.mjs restart|exit [--exe <path>] [--port <number>] [--app <process name>]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const APP_NAME = 'DeepSeek Harness.exe'
const LOG = join(homedir(), '.dsh', 'remote-control', 'dsh-control.log')

/** @param name - flag name. @returns its value, or undefined. */
function flag (name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

/** @param message - a line to record. */
function log (message) {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* logging is best-effort */
  }
}

const mode = process.argv[2] === 'exit' ? 'exit' : 'restart'
const appName = flag('app') ?? APP_NAME
const port = Number(flag('port') ?? 19400)
const exe = flag('exe') ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', appName)

log(`--- ${mode} requested (pid ${String(process.pid)}, image ${process.execPath})`)
if (process.execPath.toLowerCase().endsWith(appName.toLowerCase())) {
  log('refusing to run: this helper is the app executable itself')
  process.exit(3)
}

/** @param ms - milliseconds. */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** @returns whether nothing is listening on the remote-control port any more. */
function portFree () {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (free) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(free)
    }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    setTimeout(() => done(true), 1000)
  })
}

/** @param force - whether to force the close. @returns a promise that settles when taskkill returns. */
function closeApp (force) {
  return new Promise((resolve) => {
    // Without /F taskkill asks the window to close, which is what a normal quit looks like. No /T: that
    // would take this helper down with the tree.
    const child = spawn('taskkill', force ? ['/F', '/IM', appName] : ['/IM', appName], { stdio: 'ignore', windowsHide: true })
    child.once('exit', (code) => {
      log(`taskkill${force ? ' /F' : ''} exited with ${String(code)}`)
      resolve()
    })
    child.once('error', (error) => {
      log(`taskkill failed: ${String(error?.message ?? error)}`)
      resolve()
    })
  })
}

// Give the HTTP response time to reach the browser before anything disappears.
await sleep(1500)
await closeApp(false)

let free = false
for (let attempt = 0; attempt < 24; attempt += 1) {
  free = await portFree()
  if (free) break
  await sleep(500)
}
if (!free) await closeApp(true)
log(`port ${String(port)} ${free ? 'released' : 'forced'}`)

if (mode === 'restart') {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await portFree()) break
    await sleep(500)
  }
  await sleep(1500)
  if (!existsSync(exe)) {
    log(`launcher not found: ${exe}`)
    process.exit(2)
  }
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  log(`launched ${exe} (pid ${String(child.pid ?? 0)})`)

  // Report whether it actually came back, which is the only useful thing to know afterwards.
  let back = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!(await portFree())) {
      back = true
      break
    }
    await sleep(1000)
  }
  log(back ? 'remote-control port is answering again' : 'the app did not come back within 60s')
}
process.exit(0)
