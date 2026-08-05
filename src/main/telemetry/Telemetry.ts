import { app } from 'electron'
import { PostHog } from 'posthog-node'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { release, totalmem, cpus, arch } from 'os'

/**
 * PostHog telemetry for Reliquary.
 *
 * Reliquary reads another process's memory and paints a transparent always-on-top
 * window over a game — two things that fail in ways a user can neither see nor
 * describe. Almost every bug report is going to be "the overlay stopped showing
 * numbers", so this module is deliberately over-instrumented: it records not just
 * crashes but every degraded state (game vanished, native module missing, Codex
 * 429, snapshot shape unexpected) along with enough context to reconstruct what
 * the app believed at that moment.
 *
 * Design rules:
 *  - NEVER throw. Telemetry that breaks the app it is monitoring is worse than
 *    no telemetry, so every public method is internally guarded.
 *  - Errors carry breadcrumbs: the last N events plus recent log lines, so a
 *    crash report explains what led up to it rather than just where it landed.
 *  - Repeating failures are aggregated, not streamed. A poll loop failing at 4 Hz
 *    would otherwise emit 14k events an hour and bury the signal.
 *  - No game content, file paths, or user identifiers leave the machine beyond a
 *    random install id. See `scrub()`.
 */

/**
 * Baked in by electron.vite.config from POSTHOG_KEY/POSTHOG_HOST at build time.
 * A PostHog *project* key is write-only by design and safe to ship in a client;
 * it cannot read any data back out.
 */
declare const __POSTHOG_KEY__: string | undefined
declare const __POSTHOG_HOST__: string | undefined
declare const __APP_VERSION__: string | undefined

const BUILD_KEY = typeof __POSTHOG_KEY__ === 'string' ? __POSTHOG_KEY__ : ''
const BUILD_HOST = typeof __POSTHOG_HOST__ === 'string' ? __POSTHOG_HOST__ : ''
const DEFAULT_HOST = 'https://us.i.posthog.com'
/** Build-pinned app version. app.getVersion() reports Electron's in a dev run. */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

interface Breadcrumb {
  t: number
  kind: string
  message: string
}

interface AggregatedIssue {
  count: number
  firstAt: number
  lastAt: number
  lastProps: Record<string, unknown>
  reported: number
}

const BREADCRUMB_MAX = 60
/** Aggregate a repeating issue over this window instead of sending each one. */
const AGGREGATE_WINDOW_MS = 60_000
/** Send the 1st, 2nd, 5th, 25th… occurrence of a repeating issue. */
const REPORT_AT = [1, 2, 5, 25, 100, 500]

function idFile(): string {
  return join(app.getPath('userData'), 'telemetry-id.json')
}

/** Stable random install id. Not tied to any account, machine name, or user. */
function installId(): { id: string; firstSeen: number; isNew: boolean } {
  try {
    const raw = JSON.parse(readFileSync(idFile(), 'utf8')) as { id?: string; firstSeen?: number }
    if (raw.id) return { id: raw.id, firstSeen: raw.firstSeen ?? Date.now(), isNew: false }
  } catch {
    /* first run, or unreadable — mint a new one */
  }
  const fresh = { id: randomUUID(), firstSeen: Date.now() }
  try {
    writeFileSync(idFile(), JSON.stringify(fresh))
  } catch {
    /* best effort; a per-session id is still useful */
  }
  return { ...fresh, isNew: true }
}

/**
 * Strip anything that could identify the machine or its owner.
 * Windows paths are the main offender — they embed the account name.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (value == null || depth > 6) return value
  if (typeof value === 'string') {
    return value
      .replace(/[A-Za-z]:\\Users\\[^\\/:*?"<>|\r\n]+/gi, 'C:\\Users\\~')
      .replace(/\/(?:home|Users)\/[^/\s]+/g, '/home/~')
      .slice(0, 2000)
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/password|token|secret|apikey|api_key|auth/i.test(k)) {
      out[k] = '[redacted]'
      continue
    }
    out[k] = scrub(v, depth + 1)
  }
  return out
}

/** Turn anything thrown into a stable, groupable shape. */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error_name: err.name,
      error_message: String(err.message).slice(0, 500),
      error_stack: (err.stack ?? '').split('\n').slice(0, 24).join('\n'),
      error_code: (err as NodeJS.ErrnoException).code ?? null,
      error_cause: err.cause ? String(err.cause).slice(0, 300) : null
    }
  }
  if (typeof err === 'object' && err !== null) {
    return { error_name: 'object', error_message: safeJson(err).slice(0, 500) }
  }
  return { error_name: typeof err, error_message: String(err).slice(0, 500) }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

class TelemetryClient {
  private client: PostHog | null = null
  private id = ''
  private enabled = false
  private sessionId = randomUUID()
  private startedAt = Date.now()
  private breadcrumbs: Breadcrumb[] = []
  private issues = new Map<string, AggregatedIssue>()
  private context: Record<string, unknown> = {}
  private logTail: string[] = []
  private sentCount = 0
  private failed = false

  /** Call once, after app is ready. Safe to call when no key is configured. */
  init(): void {
    try {
      // Runtime env wins over the baked-in build value, so a user can point a
      // debug build at their own project without a rebuild. An env var set to
      // an empty string counts as unset — `??` would treat '' as a real value
      // and silently disable reporting for anyone who exports the var blank.
      const env = (n: string): string => {
        const v = process.env[n]
        return v != null && v.trim() !== '' ? v : ''
      }
      const key = env('POSTHOG_KEY') || env('SPECTRA_POSTHOG_KEY') || BUILD_KEY
      const host = env('POSTHOG_HOST') || BUILD_HOST || DEFAULT_HOST
      const optedOut = process.env['SPECTRA_TELEMETRY'] === '0'
      const who = installId()
      this.id = who.id

      if (!key) {
        console.log('[telemetry] no POSTHOG_KEY configured; telemetry disabled (local logging only)')
        return
      }
      if (optedOut) {
        console.log('[telemetry] disabled by SPECTRA_TELEMETRY=0')
        return
      }

      this.client = new PostHog(key, {
        host,
        // Small batches + short interval: this app crashes hard (GPU device
        // loss takes the process with it), so buffering for long loses exactly
        // the events worth having.
        flushAt: 5,
        flushInterval: 5_000,
        requestTimeout: 10_000,
        disableGeoip: false
      })
      this.client.on('error', (e: unknown) => {
        if (this.failed) return
        this.failed = true
        console.warn(`[telemetry] delivery error (further errors suppressed): ${String(e)}`)
      })
      this.enabled = true
      console.log(`[telemetry] enabled → ${host} (install ${this.id.slice(0, 8)}…)`)
      this.identify(who.isNew)
    } catch (err) {
      console.warn(`[telemetry] init failed: ${String(err)}`)
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Merge properties attached to every subsequent event. */
  setContext(patch: Record<string, unknown>): void {
    try {
      Object.assign(this.context, scrub(patch) as Record<string, unknown>)
    } catch {
      /* never throw */
    }
  }

  /** Record a lightweight breadcrumb; attached to the next error report. */
  crumb(kind: string, message: string): void {
    try {
      this.breadcrumbs.push({ t: Date.now(), kind, message: String(message).slice(0, 300) })
      if (this.breadcrumbs.length > BREADCRUMB_MAX) this.breadcrumbs.shift()
    } catch {
      /* never throw */
    }
  }

  /** Mirror of the console ring, so an error report carries recent log output. */
  noteLog(level: string, text: string): void {
    try {
      this.logTail.push(`${level}: ${text}`.slice(0, 400))
      if (this.logTail.length > 40) this.logTail.shift()
    } catch {
      /* never throw */
    }
  }

  private identify(isNew: boolean): void {
    const c = cpus()
    this.setContext({
      app_version: APP_VERSION,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: arch(),
      os_release: release(),
      cpu_model: c[0]?.model ?? null,
      cpu_count: c.length,
      total_mem_gb: Math.round(totalmem() / 1024 ** 3),
      packaged: app.isPackaged,
      locale: app.getLocale(),
      first_run: isNew
    })
    this.capture('app_installed_or_launched', { is_new_install: isNew })
  }

  /** Fire a product/diagnostic event. */
  capture(event: string, props: Record<string, unknown> = {}): void {
    if (!this.enabled || !this.client) return
    try {
      this.sentCount++
      this.client.capture({
        distinctId: this.id,
        event,
        properties: {
          ...this.context,
          ...(scrub(props) as Record<string, unknown>),
          session_id: this.sessionId,
          uptime_ms: Date.now() - this.startedAt,
          $process_person_profile: false
        }
      })
    } catch (err) {
      // A telemetry failure must never surface to the user or break a caller.
      if (!this.failed) {
        this.failed = true
        console.warn(`[telemetry] capture failed: ${String(err)}`)
      }
    }
  }

  /**
   * Report a problem. Repeating problems with the same key are aggregated so a
   * failing poll loop reports occurrences 1, 2, 5, 25… rather than thousands.
   */
  issue(
    key: string,
    severity: Severity,
    props: Record<string, unknown> = {},
    err?: unknown
  ): void {
    try {
      const now = Date.now()
      const detail = err === undefined ? {} : describeError(err)
      const merged = { ...props, ...detail }

      let agg = this.issues.get(key)
      if (!agg || now - agg.lastAt > AGGREGATE_WINDOW_MS) {
        agg = { count: 0, firstAt: now, lastAt: now, lastProps: merged, reported: 0 }
        this.issues.set(key, agg)
      }
      agg.count++
      agg.lastAt = now
      agg.lastProps = merged

      this.crumb(severity, `${key}: ${String(merged['error_message'] ?? props['reason'] ?? '')}`)

      const shouldSend = REPORT_AT.includes(agg.count) || severity === 'fatal'
      if (!shouldSend) return
      agg.reported++

      this.capture('issue', {
        issue_key: key,
        severity,
        occurrence: agg.count,
        window_ms: now - agg.firstAt,
        ...merged,
        breadcrumbs: this.breadcrumbs.slice(-25),
        recent_logs: this.logTail.slice(-20)
      })
    } catch {
      /* never throw */
    }
  }

  /**
   * Run `fn`, reporting anything it throws and returning `fallback` instead of
   * propagating. The point is that a failure in one subsystem (a bad snapshot,
   * a dead window handle) degrades that feature rather than the whole app.
   */
  guard<T>(key: string, fn: () => T, fallback: T, props: Record<string, unknown> = {}): T {
    try {
      return fn()
    } catch (err) {
      this.issue(key, 'error', props, err)
      return fallback
    }
  }

  /** Async twin of `guard`. */
  async guardAsync<T>(
    key: string,
    fn: () => Promise<T>,
    fallback: T,
    props: Record<string, unknown> = {}
  ): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      this.issue(key, 'error', props, err)
      return fallback
    }
  }

  /** A snapshot of what telemetry itself is doing, for the Debug tab. */
  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      installId: this.id ? this.id.slice(0, 8) + '…' : null,
      sessionId: this.sessionId.slice(0, 8) + '…',
      eventsSent: this.sentCount,
      deliveryFailed: this.failed,
      breadcrumbs: this.breadcrumbs.length,
      aggregatedIssues: [...this.issues.entries()].map(([k, v]) => ({ key: k, count: v.count }))
    }
  }

  /** Flush pending events. Called on quit and after fatal errors. */
  async shutdown(reason = 'quit'): Promise<void> {
    if (!this.enabled || !this.client) return
    try {
      // Summarise anything that was aggregated but never crossed a report threshold.
      for (const [key, agg] of this.issues) {
        if (agg.reported === 0 || agg.count > (REPORT_AT[agg.reported - 1] ?? 0)) {
          this.capture('issue_summary', { issue_key: key, total: agg.count, ...agg.lastProps })
        }
      }
      this.capture('app_exit', { reason, session_ms: Date.now() - this.startedAt })
      await this.client.shutdown()
    } catch {
      /* never block quit on telemetry */
    }
  }
}

export const telemetry = new TelemetryClient()
