import type { Severity } from './telemetry/Telemetry'

/**
 * When the app is allowed to be alive.
 *
 * Reliquary owns two windows, and until now only one of them had a say. The
 * overlay is `skipTaskbar: true`, `focusable: false` and — when the game is not
 * running — completely empty, so a process holding nothing but the overlay is
 * invisible: no taskbar button, no window to close, no tray icon. It also holds
 * the single-instance lock, so every later launch of the exe lands in
 * `second-instance` instead of starting the app. The result was a process that
 * looked dead and could not be relaunched, only killed in Task Manager.
 *
 * Commit 9e8a521 made that state *recoverable* (a second instance recreates the
 * dashboard). This makes it *rare and finite*:
 *
 *   - dashboard closed, no game  -> quit. There is nothing left to draw over.
 *   - dashboard closed, game up  -> keep the overlay. Deliberate, reported, and
 *                                   it ends when the game does.
 *   - game exits while headless  -> quit after a short grace, so a reader blip
 *                                   or a game restart does not kill the overlay.
 *
 * The watchdog is the regression alarm the whole exercise is for: if any future
 * change reintroduces lingering, a process that is dashboard-less and game-less
 * past `ZOMBIE_AFTER_MS` files an issue, and PostHog shows it without anyone
 * having to notice their fans spinning.
 *
 * There is no tray icon today, and this does not invent one. A tray would make
 * the kept-overlay state directly visible and quittable; see the note in the
 * decision record. Until then the honest answer is to not linger.
 */

/** How often the watchdog re-asks the question. Cheap: two booleans. */
const TICK_MS = 15_000

/**
 * How long the game must stay gone before a dashboard-less process quits.
 *
 * Not zero: the reader child restarts with up to a 30 s backoff, a user may
 * alt-F4 the game and relaunch it, and killing the overlay for either would be
 * the same "it just disappeared" complaint from the other direction.
 */
const GAME_GONE_GRACE_MS = 30_000

/**
 * How long the zombie state must persist before it is reported. Comfortably
 * past the grace period plus the quit itself, so this can only fire if the quit
 * did NOT happen — which is exactly the regression worth an alert.
 */
const ZOMBIE_AFTER_MS = 5 * 60_000

/**
 * The other half of the hole: detection is a *push* from the reader child, and
 * a dead child pushes nothing, so `detected` can sit stale-true forever. A
 * headless process that still claims the game is running but has not managed a
 * memory read in ten minutes is not overlaying anything either.
 */
const STALE_READS_MS = 10 * 60_000

/** What the app currently believes about the game, from the scry provider. */
export interface GameEvidence {
  /** The reader's latest word on whether the game window exists. */
  detected: boolean
  /** Age of the newest memory read, or null if there has never been one. */
  snapshotAgeMs: number | null
}

export interface WindowLifecycleOptions {
  /** Whether a live dashboard window exists right now. */
  hasDashboard: () => boolean
  gameEvidence: () => GameEvidence
  /** `app.quit()`, injected so this module stays free of electron. */
  quit: () => void
  onEvent: (name: string, props?: Record<string, unknown>) => void
  onIssue: (key: string, severity: Severity, props?: Record<string, unknown>) => void
  /** Optional narration for the in-app Logs tab. */
  log?: (line: string) => void
  /** Test seams. Production uses the defaults above. */
  graceMs?: number
  zombieMs?: number
  staleMs?: number
  tickMs?: number
  now?: () => number
}

/** The issue key both watchdog conditions report under. */
export const ZOMBIE_ISSUE_KEY = 'process_without_dashboard'

export class WindowLifecycle {
  private timer: NodeJS.Timeout | null = null
  /** Epoch ms since the process last had a dashboard window, or null if it has one. */
  private headlessSince: number | null = null
  /** Epoch ms since the process had neither a dashboard nor a detected game. */
  private noGameSince: number | null = null
  private quitRequested = false
  private zombieReported = false
  private staleReported = false
  private quitting = false

  private readonly graceMs: number
  private readonly zombieMs: number
  private readonly staleMs: number
  private readonly tickMs: number
  private readonly now: () => number

  constructor(private readonly opts: WindowLifecycleOptions) {
    this.graceMs = opts.graceMs ?? GAME_GONE_GRACE_MS
    this.zombieMs = opts.zombieMs ?? ZOMBIE_AFTER_MS
    this.staleMs = opts.staleMs ?? STALE_READS_MS
    this.tickMs = opts.tickMs ?? TICK_MS
    this.now = opts.now ?? Date.now
  }

  /**
   * Arm the watchdog. Called after `whenReady`, and deliberately armed for the
   * whole session rather than only once the dashboard closes: a dashboard lost
   * some other way (a renderer kill, a future refactor) must be caught too.
   */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.evaluate('tick'), this.tickMs)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * The app is on its way out. Everything below becomes a no-op, because
   * `app.quit()` closes the dashboard on its way and that close must not be
   * mistaken for the user closing it (it would double-count the metric and
   * re-enter `quit`).
   */
  markQuitting(): void {
    this.quitting = true
  }

  /** A dashboard window exists again (first launch, or a second-instance recreate). */
  dashboardOpened(): void {
    this.headlessSince = null
    this.noGameSince = null
    this.zombieReported = false
    this.staleReported = false
  }

  /**
   * The dashboard window has closed. This is the decision the user actually
   * asked for: with no game there is nothing to overlay, so the process goes
   * with the window — no grace period, because a window that vanishes and a
   * process that lingers 30 s is the same confusion in miniature.
   */
  dashboardClosed(): void {
    if (this.quitting) return
    const evidence = this.opts.gameEvidence()
    const now = this.now()
    this.headlessSince = now
    if (!evidence.detected) {
      this.noGameSince = now
      this.opts.onEvent('dashboard_closed_quit', { game_detected: false })
      this.requestQuit('dashboard-closed-no-game')
      return
    }
    this.noGameSince = null
    this.opts.onEvent('dashboard_closed_overlay_kept', {
      game_detected: true,
      snapshot_age_ms: evidence.snapshotAgeMs
    })
    this.opts.log?.(
      '[spectra] dashboard closed while the game is running — keeping the overlay; ' +
        'the app will quit when the game does.'
    )
  }

  /** Detection may have changed. Cheap enough to call on every reader poll. */
  processChanged(): void {
    this.evaluate('process')
  }

  /** For the second-instance report: how long this process has had no dashboard. */
  headlessMs(): number | null {
    return this.headlessSince == null ? null : this.now() - this.headlessSince
  }

  private evaluate(reason: 'tick' | 'process'): void {
    if (this.quitting) return
    if (this.opts.hasDashboard()) {
      this.dashboardOpened()
      return
    }
    const now = this.now()
    if (this.headlessSince == null) this.headlessSince = now
    const evidence = this.opts.gameEvidence()

    if (evidence.detected) {
      // The legitimate kept-overlay state: a window closed on purpose while the
      // overlay is doing its job. Nothing to do — except notice if the "game is
      // running" claim has quietly gone stale under a dead reader.
      this.noGameSince = null
      const headless = now - this.headlessSince
      const age = evidence.snapshotAgeMs
      if (!this.staleReported && headless >= this.staleMs && (age == null || age >= this.staleMs)) {
        this.staleReported = true
        this.opts.onIssue(ZOMBIE_ISSUE_KEY, 'warn', {
          reason: 'stale_game',
          headless_ms: headless,
          snapshot_age_ms: age,
          detected: true
        })
      }
      return
    }

    if (this.noGameSince == null) this.noGameSince = now
    const orphaned = now - this.noGameSince
    if (!this.quitRequested && orphaned >= this.graceMs) {
      this.opts.onEvent('overlay_only_quit', {
        reason: 'game_exited',
        orphaned_ms: orphaned,
        headless_ms: now - this.headlessSince,
        via: reason
      })
      this.opts.log?.('[spectra] the game is gone and there is no dashboard — quitting.')
      this.requestQuit('game-gone')
    }
    // The regression alarm. Reachable only when the quit above failed to take,
    // which is the whole point: a future change that reintroduces lingering
    // shows up in PostHog instead of in someone's Task Manager.
    if (!this.zombieReported && orphaned >= this.zombieMs) {
      this.zombieReported = true
      this.opts.onIssue(ZOMBIE_ISSUE_KEY, 'error', {
        reason: 'no_game',
        orphaned_ms: orphaned,
        headless_ms: now - this.headlessSince,
        quit_requested: this.quitRequested
      })
    }
  }

  private requestQuit(why: string): void {
    this.quitRequested = true
    try {
      this.opts.quit()
    } catch (err) {
      this.opts.onIssue(ZOMBIE_ISSUE_KEY, 'error', {
        reason: 'quit_threw',
        why,
        error_message: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
