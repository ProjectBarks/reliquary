/**
 * The memory reader, running in its own OS process.
 *
 * Everything that touches the native scry module lives here: process detection,
 * the connection, the poll loop, and the raw reads. Nothing else does.
 *
 * The reason is blunt: this code dereferences pointers into a running game's
 * address space. A JS-level failure is catchable, but a bad pointer inside the
 * native module is a segfault, and a segfault in the main process takes the
 * windows, the overlay, the settings and the crash reporter with it. Here it
 * kills one child that the host restarts, and the user sees a two-second gap in
 * the numbers instead of the app vanishing.
 *
 * It emits raw snapshots only. Codex enrichment, settings and IPC stay in the
 * main process, so the boundary matches the one that already existed between
 * readers.ts (raw) and provider.ts (meaning).
 */
import { ScryConnection } from './connection'
import { loadScryModule } from './native'
import { isTransientRead } from './scryObject'
import {
  readEnemiesState,
  readGameVersion,
  readNGameState,
  readPileState,
  readVisibleItems
} from './readers'
import type { ReaderToHost, HostToReader } from './readerProtocol'

const DETECT_MS = 2000
const POLL_MS = 250
/** Restart the native connection after this many consecutive read failures. */
const RESTART_AFTER_ERRORS = 20
/** Give up and re-detect the process after this many. */
const REDETECT_AFTER_ERRORS = 40

const conn = new ScryConnection()
let detectTimer: NodeJS.Timeout | null = null
let pollTimer: NodeJS.Timeout | null = null
let errorStreak = 0
let transientReads = 0
let running = false
let lastPid: number | null = null

/** Post to the host. Never throws — a dead channel must not kill the reader. */
function send(msg: ReaderToHost): void {
  try {
    process.parentPort?.postMessage(msg)
  } catch {
    /* host is gone; it will restart us */
  }
}

function log(level: 'log' | 'warn' | 'error', text: string): void {
  send({ type: 'log', level, text })
}

function describe(err: unknown): { message: string; stack: string | null; transient: boolean } {
  return {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? (err.stack ?? '').split('\n').slice(0, 20).join('\n') : null,
    transient: isTransientRead(err)
  }
}

function detect(): void {
  try {
    const { proc } = ScryConnection.findGameProcess()
    if (!proc) {
      if (conn.isConnected()) processGone()
      send({ type: 'process', detected: false, pid: null, bounds: null, active: false })
      lastPid = null
      return
    }
    send({
      type: 'process',
      detected: true,
      pid: proc.pid,
      bounds: proc.bounds,
      active: proc.active
    })
    if (!conn.isConnected() || conn.connectedPid !== proc.pid) {
      const ok = conn.connect(proc.pid)
      send({ type: 'connect', ok, pid: proc.pid, error: conn.error })
      if (ok) {
        errorStreak = 0
        lastPid = proc.pid
        send({ type: 'gameVersion', version: safe(() => readGameVersion(conn.getContext()!), null) })
        startPolling()
      }
    }
  } catch (err) {
    log('error', `detect failed: ${describe(err).message}`)
    send({ type: 'error', scope: 'detect', ...describe(err) })
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function processGone(): void {
  conn.disconnect()
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  errorStreak = 0
  send({ type: 'processGone' })
}

function startPolling(): void {
  if (pollTimer) return
  const tick = (): void => {
    if (!running || !conn.isConnected()) {
      pollTimer = null
      return
    }
    try {
      poll()
    } catch (err) {
      // poll() handles read errors; this only catches a throw from the error
      // path itself, which must never stop the loop.
      send({ type: 'error', scope: 'pollTick', ...describe(err) })
    } finally {
      if (running && conn.isConnected()) pollTimer = setTimeout(tick, POLL_MS)
      else pollTimer = null
    }
  }
  pollTimer = setTimeout(tick, POLL_MS)
}

function poll(): void {
  const context = conn.getContext()
  if (!context) return

  // Each read stands alone. They used to be four expressions inside one
  // object literal, so a dead pointer while reading room state threw before
  // the other three were evaluated and the whole snapshot was dropped — the
  // card recommendations vanished because something unrelated failed. A read
  // that fails now costs only its own field.
  let failures = 0
  let firstError: unknown = null
  const read = <T>(fn: () => T): T | null => {
    try {
      return fn()
    } catch (err) {
      failures++
      if (!firstError) firstError = err
      return null
    }
  }

  const snapshot = {
    nGame: read(() => readNGameState(context)),
    pile: read(() => readPileState(context)),
    enemies: read(() => readEnemiesState(context)),
    items: read(() => readVisibleItems(context))
  }
  send({ type: 'snapshot', ...snapshot })

  if (failures === 0) {
    errorStreak = 0
    return
  }
  const d = describe(firstError)
  errorStreak++
  if (d.transient) transientReads++
  send({
    type: 'readFailed',
    ...d,
    errorStreak,
    transientTotal: transientReads
  })
  if (errorStreak === RESTART_AFTER_ERRORS) {
    log('warn', `restarting scry connection after ${errorStreak} failures`)
    conn.restart()
  } else if (errorStreak >= REDETECT_AFTER_ERRORS) {
    log('warn', `re-detecting game after ${errorStreak} failures`)
    processGone()
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────

process.parentPort?.on('message', (e) => {
  const msg = e.data as HostToReader
  try {
    if (msg?.type === 'start' && !running) {
      running = true
      detect()
      detectTimer = setInterval(detect, DETECT_MS)
      send({ type: 'ready', pid: process.pid })
    } else if (msg?.type === 'stop') {
      running = false
      if (detectTimer) clearInterval(detectTimer)
      if (pollTimer) clearTimeout(pollTimer)
      detectTimer = pollTimer = null
      conn.disconnect()
    }
  } catch (err) {
    send({ type: 'error', scope: 'command', ...describe(err) })
  }
})

// A throw that escapes anything above would otherwise take this process down
// silently; report it first so the host learns why it is about to restart us.
process.on('uncaughtException', (err) => {
  send({ type: 'error', scope: 'uncaught', ...describe(err) })
})
process.on('unhandledRejection', (reason) => {
  send({ type: 'error', scope: 'unhandledRejection', ...describe(reason) })
})

// Report whether the native binary is even loadable before anything else: it
// is the difference between "no game yet" and "this install is broken", and
// only this process can answer it now.
{
  const mod = loadScryModule()
  send({ type: 'moduleStatus', loaded: !!mod.module, error: mod.error })
}

send({ type: 'spawned', pid: process.pid, lastPid })
