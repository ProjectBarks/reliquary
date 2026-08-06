import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join, sep } from 'path'
import { existsSync } from 'fs'
import { telemetry } from '../telemetry/Telemetry'
import type { HostToReader, RawSnapshot, ReaderToHost } from './readerProtocol'

/**
 * Supervises the forked memory reader.
 *
 * `utilityProcess` rather than `child_process.fork`: Electron owns the
 * lifetime (it dies with the app instead of leaking), it appears in crash
 * reports, and it speaks MessagePort so there is no stdout parsing.
 *
 * The supervision is the point. A native segfault used to be unrecoverable —
 * the whole app went, taking the overlay and the crash reporter with it. Now
 * the child dies, this restarts it with backoff, and the numbers resume. What
 * the user notices is a gap, not a disappearance.
 *
 * Backoff exists so a reader that cannot survive startup (a broken native
 * module, an unreadable game build) fails quietly at a low rate instead of
 * spinning a fork loop that burns a core.
 */

const RESTART_DELAYS_MS = [500, 1000, 2000, 5000, 10_000, 30_000]
/** Uptime past which a run counts as healthy, resetting the backoff. */
const HEALTHY_AFTER_MS = 60_000

export class ReaderHost {
  private child: UtilityProcess | null = null
  /**
   * Last snapshot the reader produced.
   *
   * A restart takes a second or two, and blanking the overlay for it would be
   * a worse experience than the crash it is recovering from — the numbers would
   * vanish and come back rather than simply pausing. Holding the last values
   * means a reader crash looks like a brief freeze, which is honest: the data
   * IS a moment old, and it is still the best information available.
   */
  private cache: RawSnapshot | null = null
  private cachedAt = 0
  private moduleLoaded: boolean | null = null
  private moduleError: string | null = null
  private restarts = 0
  private startedAt = 0
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null

  constructor(private readonly onMessage: (msg: ReaderToHost) => void) {}

  get isRunning(): boolean {
    return !!this.child
  }

  get restartCount(): number {
    return this.restarts
  }

  /** Last known reads, and how stale they are. Null before the first poll. */
  get lastSnapshot(): { snapshot: RawSnapshot; ageMs: number } | null {
    return this.cache ? { snapshot: this.cache, ageMs: Date.now() - this.cachedAt } : null
  }

  /** Whether the native reader loaded, once the child has reported. */
  get nativeStatus(): { loaded: boolean | null; error: string | null } {
    return { loaded: this.moduleLoaded, error: this.moduleError }
  }

  start(): void {
    this.stopping = false
    this.spawn()
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.send({ type: 'stop' })
    try {
      this.child?.kill()
    } catch {
      /* already gone */
    }
    this.child = null
  }

  send(msg: HostToReader): void {
    try {
      this.child?.postMessage(msg)
    } catch {
      // Child died between the check and the post; the exit handler restarts it.
    }
  }

  /**
   * Path to the forked bundle.
   *
   * Packaged, __dirname sits inside app.asar. Electron can generally read from
   * an archive, but a fork target is the wrong thing to gamble on for every
   * install — so the bundle is also unpacked, and the real on-disk copy wins
   * when it exists. Falls back to the asar path either way.
   */
  private modulePath(): string {
    const inAsar = join(__dirname, 'reader.js')
    if (!app.isPackaged) return inAsar
    const unpacked = inAsar.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    return existsSync(unpacked) ? unpacked : inAsar
  }

  private spawn(): void {
    if (this.stopping || this.child) return
    const path = this.modulePath()
    try {
      this.startedAt = Date.now()
      const child = utilityProcess.fork(path, [], {
        serviceName: 'reliquary-reader',
        // The child cannot import `app`, so it cannot work out where the
        // packaged native binary lives. Resolve it here and hand it over.
        env: {
          ...process.env,
          RELIQUARY_APP_PATH: app.getAppPath(),
          RELIQUARY_VENDOR_ROOTS: [
            app.isPackaged ? join(process.resourcesPath, 'vendor') : '',
            join(app.getAppPath(), 'vendor')
          ]
            .filter(Boolean)
            .join(';')
        },
        // Piped, not ignored: a child that dies before its message channel is
        // up can only explain itself on stderr, and 'ignore' throws that away —
        // which is exactly the failure you most need to read.
        stdio: 'pipe'
      })
      this.child = child

      const relay = (stream: NodeJS.ReadableStream | null, level: 'log' | 'error'): void => {
        stream?.on('data', (chunk: Buffer) => {
          const text = chunk.toString().trimEnd()
          if (!text) return
          for (const line of text.split(/\r?\n/)) {
            if (level === 'error') console.error(`[reader] ${line}`)
            else console.log(`[reader] ${line}`)
          }
        })
      }
      relay(child.stdout, 'log')
      relay(child.stderr, 'error')

      child.on('message', (msg: ReaderToHost) => {
        try {
          if (msg.type === 'snapshot') {
            this.cache = { nGame: msg.nGame, pile: msg.pile, enemies: msg.enemies, items: msg.items }
            this.cachedAt = Date.now()
          } else if (msg.type === 'moduleStatus') {
            this.moduleLoaded = msg.loaded
            this.moduleError = msg.error
          }
          this.onMessage(msg)
        } catch (err) {
          telemetry.issue('reader_message_handler_failed', 'error', { kind: msg?.type }, err)
        }
      })

      child.on('exit', (code) => {
        const uptime = Date.now() - this.startedAt
        this.child = null
        if (this.stopping) return
        // A clean exit we did not ask for still means no data, so it restarts
        // either way; only the reporting distinguishes them.
        telemetry.issue('reader_process_exit', code === 0 ? 'warn' : 'error', {
          exit_code: code,
          uptime_ms: uptime,
          restarts: this.restarts
        })
        console.warn(`[reader] process exited (code ${code}) after ${Math.round(uptime / 1000)}s`)
        this.scheduleRestart(uptime)
      })

      child.once('spawn', () => {
        console.log(`[reader] forked (pid ${child.pid})`)
        this.send({ type: 'start' })
      })
    } catch (err) {
      // Fork itself failed — a missing bundle or a blocked exec. Nothing to
      // restart yet, so back off on the same schedule.
      telemetry.issue('reader_fork_failed', 'fatal', { path }, err)
      console.error('[reader] failed to fork', err)
      this.child = null
      this.scheduleRestart(0)
    }
  }

  private scheduleRestart(uptime: number): void {
    if (this.stopping) return
    // A reader that ran fine for a while and then died is unlucky, not broken:
    // start its backoff over rather than punishing it for an old crash.
    if (uptime >= HEALTHY_AFTER_MS) this.restarts = 0
    const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)]
    this.restarts++
    if (this.restarts === 1 || this.restarts % 10 === 0) {
      telemetry.capture('reader_restart', { attempt: this.restarts, delay_ms: delay })
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawn()
    }, delay)
    this.restartTimer.unref?.()
  }
}
