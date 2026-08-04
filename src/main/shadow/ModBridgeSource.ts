import { compareCandidate, isShadowEnabled } from './index'
import type { Sts2Key } from '@shared/types'

/**
 * Candidate data source: our OWN mod (spike/mod → SpectraBridge.dll), running
 * inside the game and serving state over localhost.
 *
 * This is the replacement for the proprietary `untapped-scry.node`. While the
 * spike runs it is read-only and non-authoritative: every snapshot it produces
 * is fed to the shadow comparer and diffed against the live scry provider, so
 * we can drive it to parity before it ever becomes the source of truth.
 *
 * Flip SPECTRA_BRIDGE=1 (with SPECTRA_SHADOW=1) to enable.
 *
 * Parity target — the four keys the native reader owns. `sts2.cardData` comes
 * from the CDN and `sts2.settings` from SettingsStore, so neither is in scope.
 */
export const PARITY_KEYS: Sts2Key[] = [
  'sts2.nGameState',
  'sts2.pileState',
  'sts2.enemiesState',
  'sts2.layoutState'
]

const DEFAULT_URL = 'http://127.0.0.1:15600/state'
const POLL_MS = 250
const BACKOFF_MAX_MS = 10_000

export class ModBridgeSource {
  private timer: NodeJS.Timeout | null = null
  private backoff = 0
  private lastOk = 0
  private failures = 0
  private connected = false

  constructor(private readonly url = process.env['SPECTRA_BRIDGE_URL'] || DEFAULT_URL) {}

  start(): void {
    if (!isShadowEnabled() || !process.env['SPECTRA_BRIDGE']) return
    console.log(`[bridge] shadow candidate polling ${this.url}`)
    this.schedule(0)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  get status(): { connected: boolean; lastOk: number; failures: number } {
    return { connected: this.connected, lastOk: this.lastOk, failures: this.failures }
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick(): Promise<void> {
    try {
      const ctl = new AbortController()
      const to = setTimeout(() => ctl.abort(), 2000)
      const res = await fetch(this.url, { signal: ctl.signal })
      clearTimeout(to)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = (await res.json()) as Partial<Record<Sts2Key, unknown>>

      if (!this.connected) {
        this.connected = true
        console.log('[bridge] connected to in-game mod')
      }
      this.lastOk = Date.now()
      this.backoff = 0

      // Diff every key the mod claims against the live provider's ground truth.
      for (const key of PARITY_KEYS) {
        if (payload[key] !== undefined) compareCandidate(key, payload[key], 'mod')
      }
      this.schedule(POLL_MS)
    } catch (err) {
      this.failures++
      if (this.connected) {
        this.connected = false
        console.warn(`[bridge] lost mod connection: ${(err as Error).message}`)
      }
      // Game not running / mod not installed is the normal case — back off quietly.
      this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff ? this.backoff * 2 : 1000)
      this.schedule(this.backoff)
    }
  }
}
