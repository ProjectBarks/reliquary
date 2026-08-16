import type { Severity } from './telemetry/Telemetry'

/**
 * When the app is allowed to be alive: exactly as long as the dashboard is.
 *
 * Closing the main window IS the intent to close the app — the user was
 * explicit, and the earlier, cleverer version of this file (quit only when the
 * game wasn't running; keep the overlay otherwise) is deliberately gone. Two
 * processes' worth of behavior hiding behind one window's close button cost a
 * 5-hour invisible zombie that ate ten relaunches (session 99bc0c83), and no
 * amount of grace-period tuning buys back the confusion. One rule survives:
 *
 *   dashboard closed -> app.quit(). Unconditionally.
 *
 * What remains besides the rule is the regression alarm the whole exercise was
 * for: if a future change reintroduces a dashboard-less process that outlives
 * the quit, the watchdog files `process_without_dashboard` and retries the
 * quit, so the failure shows up in PostHog instead of in Task Manager.
 */

/** How often the watchdog re-checks. Cheap: one boolean. */
const TICK_MS = 15_000

/**
 * How long a dashboard-less process may exist before it is a reported bug.
 * Generous next to an immediate quit, tiny next to the 5-hour zombie.
 */
const ZOMBIE_AFTER_MS = 60_000

export interface WindowLifecycleOptions {
  /** Whether a live dashboard window exists right now. */
  hasDashboard: () => boolean
  /** `app.quit()`, injected so this module stays free of electron. */
  quit: () => void
  onEvent: (name: string, props?: Record<string, unknown>) => void
  onIssue: (key: string, severity: Severity, props?: Record<string, unknown>) => void
  /** Optional narration for the in-app Logs tab. */
  log?: (line: string) => void
  /** Test seams. Production uses the defaults above. */
  zombieMs?: number
  tickMs?: number
  now?: () => number
}

/** The issue key the watchdog reports under. */
export const ZOMBIE_ISSUE_KEY = 'process_without_dashboard'

export class WindowLifecycle {
  private timer: NodeJS.Timeout | null = null
  /** Epoch ms since the process last had a dashboard window, or null if it has one. */
  private headlessSince: number | null = null
  private quitRequested = false
  private zombieReported = false
  private quitting = false

  private readonly zombieMs: number
  private readonly tickMs: number
  private readonly now: () => number

  constructor(private readonly opts: WindowLifecycleOptions) {
    this.zombieMs = opts.zombieMs ?? ZOMBIE_AFTER_MS
    this.tickMs = opts.tickMs ?? TICK_MS
    this.now = opts.now ?? Date.now
  }

  /**
   * Arm the watchdog. Armed for the whole session rather than only once the
   * dashboard closes: a dashboard lost any other way (a renderer kill, a future
   * refactor) must land in the same rule.
   */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.evaluate(), this.tickMs)
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

  /** A dashboard window exists again (first launch, or a recovery recreate). */
  dashboardOpened(): void {
    this.headlessSince = null
    this.zombieReported = false
  }

  /** The dashboard closed. That is the app closing — no conditions. */
  dashboardClosed(): void {
    if (this.quitting) return
    this.headlessSince = this.now()
    this.opts.onEvent('dashboard_closed_quit', {})
    this.opts.log?.('[spectra] dashboard closed — quitting.')
    this.requestQuit('dashboard-closed')
  }

  /** For the second-instance report: how long this process has had no dashboard. */
  headlessMs(): number | null {
    return this.headlessSince == null ? null : this.now() - this.headlessSince
  }

  private evaluate(): void {
    if (this.quitting) return
    if (this.opts.hasDashboard()) {
      this.dashboardOpened()
      return
    }
    const now = this.now()
    if (this.headlessSince == null) this.headlessSince = now
    const headless = now - this.headlessSince
    if (headless < this.zombieMs) return
    // Reachable only when the immediate quit failed to take — the regression
    // this file exists to make loud. Report once, but keep retrying the quit.
    if (!this.zombieReported) {
      this.zombieReported = true
      this.opts.onIssue(ZOMBIE_ISSUE_KEY, 'error', {
        headless_ms: headless,
        quit_requested: this.quitRequested
      })
    }
    this.requestQuit('watchdog')
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
