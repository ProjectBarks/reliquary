/* eslint-disable @typescript-eslint/no-explicit-any */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { codexHttp } from './http'
import { telemetry } from '../telemetry/Telemetry'
import {
  catalogCacheKey,
  metricsCacheKey,
  normalizeCharacter,
  type CatalogPayload,
  type CodexCatalogKind,
  type CodexPayload,
  type CodexPushMessage,
  type MetricsPayload,
  type MetricsQuery,
  type MetricsTable
} from '@shared/types'

/**
 * The compendium: the whole spire-codex database (cards, relics, potions,
 * characters, keywords) plus the meta layer (metrics tables sliced by cohort
 * and character), cached so the Codex tab paints instantly and the API is
 * touched as little as the data's own volatility allows.
 *
 * Three properties this thing has to hold, in order of how loudly they fail:
 *
 *   1. **It never blocks startup.** Nothing here runs until a renderer asks.
 *      The compendium is one tab of a game overlay; a cold spire-codex.com
 *      must not delay the window that shows the deck tracker.
 *   2. **It never throws across IPC.** Every accessor resolves — to data, or
 *      to `{error}`. A rejected `invoke()` reaches the renderer as an opaque
 *      "Error invoking remote method 'spectra:codex-catalog'", which names the
 *      channel and hides the cause, and every call site would need its own
 *      try/catch to say anything better.
 *   3. **It works with the game closed.** No dependency on the scry provider,
 *      the reader process, or a detected game — this is a database browser.
 *
 * Freshness has three layers, each answering a different question:
 *   - **Disk** (`userData/codex/compendium/`) — "is this worth serving at all?"
 *     Catalogs for 7 days *and* only while the API's aggregate snapshot version
 *     is unchanged (card text is versioned data, not merely old data); metrics
 *     for 30 minutes, which is roughly how often the aggregate rebuilds.
 *   - **Memory** (300 s) — "may we ask the network again yet?" It throttles
 *     *checks*, not data: without it, every request past the freshness horizon
 *     would re-hit the API while the previous attempt was still failing.
 *   - **Stale-while-revalidate** — cached data goes out immediately with
 *     `stale: true`, the refetch happens behind it, and the fresh copy is
 *     pushed over IPC when it lands. The UI shows numbers with a quiet
 *     "updating…" rather than a spinner over an empty table.
 */

// ── freshness windows ────────────────────────────────────────────────────────

/** How long a catalog is trusted, absent a snapshot version change. */
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Metrics move with the aggregate snapshot, which rebuilds a few times a day. */
const METRICS_TTL_MS = 30 * 60 * 1000
/** Minimum spacing between network *checks* for one key. */
const MEMORY_TTL_MS = 300_000
/** How long the last snapshot-status read stands in for the current version. */
const SNAPSHOT_TTL_MS = 300_000

// ── cache entry ──────────────────────────────────────────────────────────────

interface Entry<T = unknown> {
  data: T
  /** Epoch ms the data was fetched from the API (survives to disk). */
  fetchedAt: number
  /** Aggregate snapshot version the data was fetched under; null if unknown. */
  apiVersion: number | null
  /**
   * Epoch ms we last *asked* whether this entry is still current. Memory-only:
   * a check costs nothing to redo after a relaunch, and persisting it would let
   * a long-dead process suppress the first check of a new one.
   */
  checkedAt: number
}

/** What a disk file holds — `checkedAt` deliberately absent (see above). */
interface DiskEntry {
  key: string
  data: unknown
  fetchedAt: number
  apiVersion: number | null
}

type PushFn = (message: CodexPushMessage) => void

export class CompendiumService {
  private mem = new Map<string, Entry>()
  /**
   * Disk reads by key, kept forever rather than cleared on completion: it is
   * both the once-per-process guard and the dedupe for two renderers asking in
   * the same tick. A `Set` marked "already tried" would let the second caller
   * see a miss while the first was still reading the file.
   */
  private diskReads = new Map<string, Promise<Entry | undefined>>()
  /** In-flight fetches, so N concurrent renderers cause one request. */
  private inFlight = new Map<string, Promise<Entry | null>>()

  private apiVersionValue: number | null = null
  private apiVersionAt = 0
  private apiVersionInFlight: Promise<number | null> | null = null

  constructor(private readonly push: PushFn) {}

  // ── public API (everything resolves; nothing rejects) ──────────────────────

  /**
   * One catalog. Serves cache when there is any, and only awaits the network on
   * a genuinely cold key — which is the single case where the user has nothing
   * to look at anyway.
   */
  async catalog<K extends CodexCatalogKind>(kind: K): Promise<CatalogPayload<K>> {
    if (!isCatalogKind(kind)) {
      return { error: `unknown catalog "${String(kind)}"` }
    }
    const key = catalogCacheKey(kind)
    return (await this.read(key, `/api/${kind}`, CATALOG_TTL_MS, true)) as CatalogPayload<K>
  }

  /** One metrics table, identified by kind × bracket × character. */
  async metrics(query: MetricsQuery): Promise<MetricsPayload> {
    const kind = query?.kind
    if (kind !== 'cards' && kind !== 'relics' && kind !== 'potions') {
      return { error: `unknown metrics kind "${String(kind)}"` }
    }
    const bracket = typeof query.bracket === 'string' && query.bracket ? query.bracket : 'all'
    const character = normalizeCharacter(query.character)
    const key = metricsCacheKey({ kind, bracket: bracket as MetricsQuery['bracket'], character })
    const path =
      `/api/runs/metrics/${kind}?bracket=${encodeURIComponent(bracket)}` +
      (character ? `&character=${encodeURIComponent(character)}` : '')
    return (await this.read(key, path, METRICS_TTL_MS, false)) as CodexPayload<MetricsTable>
  }

  /**
   * Force a catalog refetch, ignoring both freshness and the check throttle —
   * this is the "Retry" button, and a button that might do nothing is worse
   * than no button. Resolves once the attempt settles; the result reaches the
   * renderer as a push, like any other revalidation.
   */
  async refresh(kind: CodexCatalogKind): Promise<void> {
    if (!isCatalogKind(kind)) return
    const key = catalogCacheKey(kind)
    this.apiVersionAt = 0 // re-read the version too; that's usually the point
    await this.fetchAndPush(key, `/api/${kind}`, true, true)
  }

  // ── read path ─────────────────────────────────────────────────────────────

  /**
   * The shared shape of both accessors: hydrate from disk once, serve whatever
   * we have, and let a background check decide whether it needs replacing.
   */
  private async read(
    key: string,
    path: string,
    ttlMs: number,
    versionGated: boolean
  ): Promise<CodexPayload<unknown>> {
    let entry = this.mem.get(key)
    if (!entry) entry = await this.loadDisk(key)

    if (!entry) {
      // Cold: nothing cached, so there is no "serve stale" to do — wait for it.
      const fetched = await this.fetchEntry(key, path, versionGated)
      if (!fetched) {
        return { error: `could not reach spire-codex.com (${key})` }
      }
      return payloadOf(fetched, false)
    }

    const stale = !this.isFresh(entry, ttlMs, versionGated)
    if (Date.now() - entry.checkedAt > MEMORY_TTL_MS) {
      // Fire-and-forget by design: the caller already has data in hand, and the
      // outcome reaches them as a push. Errors are swallowed inside.
      void this.revalidate(key, path, ttlMs, versionGated)
    }
    return payloadOf(entry, stale)
  }

  private isFresh(entry: Entry, ttlMs: number, versionGated: boolean): boolean {
    if (Date.now() - entry.fetchedAt > ttlMs) return false
    // A catalog is only as valid as the snapshot it was built from — the API
    // can reword a card without the file getting a day older.
    if (versionGated && this.apiVersionValue != null && entry.apiVersion !== this.apiVersionValue) {
      return false
    }
    return true
  }

  // ── revalidation ──────────────────────────────────────────────────────────

  /**
   * Background check for a key we already have. Reads the current snapshot
   * version first (cheap, shared, throttled) so a catalog that is merely *old*
   * but still current costs one small request instead of a full refetch.
   */
  private async revalidate(
    key: string,
    path: string,
    ttlMs: number,
    versionGated: boolean
  ): Promise<void> {
    const entry = this.mem.get(key)
    if (!entry) return
    // Stamp before the await: two requests arriving in the same tick must not
    // both decide the throttle has expired.
    entry.checkedAt = Date.now()

    if (versionGated) await this.apiVersion()
    if (this.isFresh(entry, ttlMs, versionGated)) {
      this.log(`revalidate skip: ${key} still current (v${entry.apiVersion ?? '?'})`)
      return
    }
    await this.fetchAndPush(key, path, versionGated, false)
  }

  private async fetchAndPush(
    key: string,
    path: string,
    versionGated: boolean,
    force: boolean
  ): Promise<void> {
    // `force` means "do not join whatever is already running" — a Retry that
    // silently awaited the request that just failed would be theatre.
    if (force) this.inFlight.delete(key)
    const fetched = await this.fetchEntry(key, path, versionGated)
    if (fetched) this.push({ key, value: payloadOf(fetched, false) })
  }

  // ── fetching ──────────────────────────────────────────────────────────────

  /**
   * Fetch, store, persist. Returns null on any failure — callers decide whether
   * that means an error payload (cold) or silence (background revalidation of
   * data the user is already looking at).
   */
  private fetchEntry(key: string, path: string, versionGated: boolean): Promise<Entry | null> {
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const run = (async (): Promise<Entry | null> => {
      const t0 = Date.now()
      try {
        // Version-gated data is stamped with the version it was actually built
        // under, resolved in parallel (different endpoint, so no shared budget
        // and no added latency). Skipping it would leave a cold catalog stamped
        // `null` and therefore due for an immediate second fetch.
        const [data, apiVersion] = await Promise.all([
          codexHttp.get(path),
          versionGated ? this.apiVersion() : Promise.resolve(this.apiVersionValue)
        ])
        if (data == null) throw new Error('empty response')
        const entry: Entry = {
          data,
          fetchedAt: Date.now(),
          apiVersion,
          checkedAt: Date.now()
        }
        this.mem.set(key, entry)
        void this.saveDisk(key, entry)
        this.log(`fetch OK ${key} (${describe(data)}) in ${Date.now() - t0}ms`)
        return entry
      } catch (err) {
        // The HTTP layer already filed the transport-level issue with its
        // status and cooldown; this one says which cached thing went without.
        telemetry.issue('codex_compendium_fetch_failed', 'warn', { key, path }, err)
        this.log(`fetch FAILED ${key}: ${(err as any)?.message ?? err}`)
        return null
      } finally {
        this.inFlight.delete(key)
      }
    })()

    this.inFlight.set(key, run)
    return run
  }

  /**
   * The API's aggregate snapshot version, cached for 5 minutes and deduped
   * across every key that wants it. Resolves to the last known value (or null)
   * rather than throwing: a version we can't read must not turn into a catalog
   * we refuse to serve.
   */
  private async apiVersion(): Promise<number | null> {
    if (this.apiVersionValue != null && Date.now() - this.apiVersionAt < SNAPSHOT_TTL_MS) {
      return this.apiVersionValue
    }
    if (this.apiVersionInFlight) return this.apiVersionInFlight

    this.apiVersionInFlight = (async (): Promise<number | null> => {
      try {
        const ss = await codexHttp.get('/api/runs/snapshot-status')
        const version = typeof ss?.version === 'number' ? ss.version : null
        if (version != null) {
          if (version !== this.apiVersionValue) this.log(`snapshot version → v${version}`)
          this.apiVersionValue = version
          this.apiVersionAt = Date.now()
        }
        return this.apiVersionValue
      } catch (err) {
        telemetry.issue('codex_snapshot_status_failed', 'warn', {}, err)
        return this.apiVersionValue
      } finally {
        this.apiVersionInFlight = null
      }
    })()
    return this.apiVersionInFlight
  }

  // ── disk ──────────────────────────────────────────────────────────────────

  private get dir(): string {
    return join(app.getPath('userData'), 'codex', 'compendium')
  }

  /** `catalog:cards` -> `catalog-cards.json`. Keys are ours, but be strict anyway. */
  private fileFor(key: string): string {
    return join(this.dir, `${key.replace(/[^a-z0-9]+/gi, '-')}.json`)
  }

  /**
   * Read a key's disk copy, once per process. A missing or corrupt file is a
   * cache miss, not an error: we refetch, and the next write repairs it.
   */
  private loadDisk(key: string): Promise<Entry | undefined> {
    const existing = this.diskReads.get(key)
    if (existing) return existing

    const run = (async (): Promise<Entry | undefined> => {
      try {
        const raw = JSON.parse(await readFile(this.fileFor(key), 'utf8')) as DiskEntry
        if (!raw || raw.data == null || typeof raw.fetchedAt !== 'number') return undefined
        const entry: Entry = {
          data: raw.data,
          fetchedAt: raw.fetchedAt,
          apiVersion: typeof raw.apiVersion === 'number' ? raw.apiVersion : null,
          // Zero, not now: a relaunch is exactly when a check is most warranted.
          checkedAt: 0
        }
        // A fetch may have overtaken this read; never demote fresher data.
        if (!this.mem.has(key)) this.mem.set(key, entry)
        this.log(`disk hit ${key} (${describe(entry.data)}, age ${ageOf(entry.fetchedAt)})`)
        return this.mem.get(key)
      } catch {
        return undefined
      }
    })()

    this.diskReads.set(key, run)
    return run
  }

  private async saveDisk(key: string, entry: Entry): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      const payload: DiskEntry = {
        key,
        data: entry.data,
        fetchedAt: entry.fetchedAt,
        apiVersion: entry.apiVersion
      }
      await writeFile(this.fileFor(key), JSON.stringify(payload), 'utf8')
    } catch (err) {
      // Non-fatal: we simply refetch next launch. Still worth counting, because
      // a userData directory we cannot write to breaks more than this feature.
      telemetry.issue('codex_compendium_cache_write_failed', 'warn', { key }, err)
    }
  }

  private log(msg: string): void {
    if (process.env['SPECTRA_DEBUG']) console.log(`[codex:compendium] ${msg}`)
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const CATALOG_KINDS = ['cards', 'relics', 'potions', 'characters', 'keywords'] as const

function isCatalogKind(v: unknown): v is CodexCatalogKind {
  return typeof v === 'string' && (CATALOG_KINDS as readonly string[]).includes(v)
}

function payloadOf(entry: Entry, stale: boolean): CodexPayload<any> {
  return { data: entry.data, fetchedAt: entry.fetchedAt, stale, apiVersion: entry.apiVersion }
}

/** A short "what did we just cache" for the debug log — row counts, not blobs. */
function describe(data: unknown): string {
  if (Array.isArray(data)) return `${data.length} rows`
  const rows = (data as any)?.rows
  if (Array.isArray(rows)) return `${rows.length} metric rows`
  return typeof data
}

function ageOf(t: number): string {
  const ms = Date.now() - t
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}
