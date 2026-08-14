import { randomBytes } from 'crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  mkdirSync
} from 'fs'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'
import {
  JOURNAL_SCHEMA,
  type AnalysisStatus,
  type CatalogEntry,
  type ObservedFrom,
  type RunAmbiguity,
  type RunCatalog,
  type RunFile,
  type RunLifecycleState,
  type RunSnapshot
} from '@shared/journal'

/**
 * The run journal's persistence layer: one JSON file per run under
 * `userData/runs/`, plus `catalog.json`, the Archive's index.
 *
 * It has **no game knowledge** — it does not derive events, match runs or read
 * the game. It owns exactly four problems, each of which the rest of the
 * journal would otherwise have to solve badly:
 *
 *   1. **Never lose a run to a torn write.** A torn compendium cache refetches;
 *      a torn run file loses an evening of play. So every write is
 *      write-to-unique-temp → `fsync` → `rename`-over-target, with a retry
 *      ladder for the `EPERM`/`EBUSY` that Defender, Search indexing and backup
 *      agents produce on `AppData` with some regularity. This is deliberately
 *      stronger than `CompendiumService.saveDisk`'s plain `writeFile`. The
 *      `fsync` is the part that matters and the part that is easy to omit:
 *      without it a power loss can leave a zero-length target, which is the one
 *      failure temp+rename exists to prevent (a process kill alone cannot show
 *      this — the page cache survives it).
 *   2. **Always be one restart away from correct.** The catalog is a cache, run
 *      files are the truth. A missing, stale or corrupt catalog is rebuilt by
 *      scanning the directory. The scan is *lazy and stat-cached*: only files
 *      whose size or mtime moved are re-parsed, and it yields to the event loop
 *      between files, because "parse 300 run files synchronously at launch" is
 *      how a journal feature becomes a startup regression.
 *   3. **Fail loudly but locally.** An unparseable run file is quarantined to
 *      `<id>.json.corrupt` (never deleted — it is user data, and it is the only
 *      evidence of the bug) and dropped from the catalog; every other run is
 *      unaffected. A file written by a *newer* schema is listed as unreadable
 *      and never rewritten, because destructively migrating user data on the
 *      strength of a guess is worse than a row that says "update Reliquary".
 *   4. **Never let two processes write one directory.** Capture runs bypass the
 *      single-instance lock (`index.ts`), so a second `RunStore` can exist while
 *      a real one is recording, and `catalog.json` is last-writer-wins. Any
 *      instance without the lock — and unconditionally any instance with
 *      `SPECTRA_CAPTURE` set — is **read-only**. Reads are always allowed.
 *
 * Everything is injected (base directory, clock, environment, telemetry sink)
 * so the store runs and is exercised outside Electron: see
 * `scripts/journal-selfcheck.mjs`.
 */

// ── configuration ────────────────────────────────────────────────────────────

/** The catalog's file name inside the runs directory. */
export const CATALOG_FILE = 'catalog.json'

/** Journal-plan's crash budget: at most this much play is at risk. */
const DEFAULT_DEBOUNCE_MS = 2000

/** Retry ladder for the rename/write races AppData is prone to. */
const RETRY_DELAYS_MS = [50, 150, 400]

/** Errors worth retrying — all of them "someone else has the file, briefly". */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST'])

/** How often the scan yields to the event loop while parsing. */
const SCAN_YIELD_EVERY = 8

export type JournalIssueSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/**
 * Telemetry sink, shaped like `telemetry.issue`. Injected rather than imported
 * so this module stays free of Electron and PostHog and can run under plain
 * node in the self-check.
 */
export type JournalIssueSink = (
  key: string,
  severity: JournalIssueSeverity,
  props: Record<string, unknown>,
  err?: unknown
) => void

export interface RunStoreOptions {
  /** Directory holding `catalog.json` and the run files. Usually `<userData>/runs`. */
  baseDir: string
  /**
   * Whether this process may write. Pass the single-instance lock value from
   * `index.ts`. A `SPECTRA_CAPTURE` process is refused regardless.
   */
  hasLock?: boolean
  /** Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>
  onIssue?: JournalIssueSink
  /** Wall clock, injectable so tests can pin timestamps. */
  now?: () => number
  debounceMs?: number
}

// ── results ──────────────────────────────────────────────────────────────────

export type RunLoadFailure = 'missing' | 'corrupt' | 'unsupported-schema'

export type RunLoadResult =
  | { ok: true; run: RunFile; recoveredFromTmp: boolean }
  | { ok: false; reason: RunLoadFailure; schema?: number }

export interface ScanResult {
  /** Run files found on disk. */
  files: number
  /** Of those, how many had to be parsed (the rest were stat-cache hits). */
  parsed: number
  /** Files promoted from a surviving temp after a torn target. */
  recovered: number
  /** Files moved aside as `.corrupt`. */
  quarantined: number
  /** Files from a newer schema, listed but not read. */
  unreadable: number
  /** Catalog rows dropped because their file is gone. */
  dropped: number
  bytes: number
  durationMs: number
}

/** What `createRun` needs to mint a file; everything else has an honest default. */
export interface NewRunInit {
  character: string
  observedFrom: ObservedFrom
  /** Null when we joined mid-run — we did not see the start. */
  startedAt: number | null
  /** The game's own run key (`RunManager._startTime`, seconds), when readable. */
  runStartTime?: number | null
  firstSeenAt?: number
  gameVersion?: string | null
  playerCount?: number | null
  ambiguity?: RunAmbiguity | null
  snapshot?: Partial<RunSnapshot>
}

// ── the store ────────────────────────────────────────────────────────────────

export class RunStore {
  readonly dir: string
  /** False in a capture run or without the single-instance lock; reads still work. */
  readonly writable: boolean
  private readonly writeRefusal: 'capture-run' | 'no-lock' | null
  private readonly onIssue: JournalIssueSink
  private readonly now: () => number
  private readonly debounceMs: number

  private entries = new Map<string, CatalogEntry>()
  /** Run files held in memory: the live one, plus anything recently touched. */
  private runs = new Map<string, RunFile>()
  private dirty = new Set<string>()
  private catalogDirty = false
  private rebuiltAt = 0

  private opened = false
  /** True when the catalog was missing or unparseable — the scan is then mandatory. */
  private catalogMissing = false
  private scanning: Promise<ScanResult> | null = null
  private scanned = false

  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> | null = null
  private flushAgain = false
  private refusalReported = false
  private tmpSeq = 0
  private disposed = false

  constructor(opts: RunStoreOptions) {
    this.dir = opts.baseDir
    const env = opts.env ?? process.env
    const capture = !!env['SPECTRA_CAPTURE']
    // The capture check is not redundant with `hasLock`: capture runs are
    // *granted* the lock unconditionally by index.ts precisely because they run
    // alongside a real instance, which makes them the one case where a caller's
    // `hasLock: true` is not evidence of exclusivity.
    this.writeRefusal = capture ? 'capture-run' : opts.hasLock === false ? 'no-lock' : null
    this.writable = this.writeRefusal === null
    this.onIssue = opts.onIssue ?? ((): void => {})
    this.now = opts.now ?? Date.now
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Loads the catalog and nothing else. Deliberately cheap: no run file is
   * opened here, so this can sit on the startup path. `scan()` is the expensive
   * half and belongs after the first window has painted.
   */
  async open(): Promise<void> {
    if (this.opened) return
    this.opened = true
    if (this.writable) {
      try {
        await mkdir(this.dir, { recursive: true })
      } catch (err) {
        this.onIssue('journal_dir_create_failed', 'error', { dir: this.dir }, err)
      }
    }
    const file = join(this.dir, CATALOG_FILE)
    let raw: string | null = null
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      // First run, or a directory we have not written yet. Not an issue.
      this.catalogMissing = true
      return
    }
    const catalog = parseCatalog(raw)
    if (!catalog) {
      // A corrupt index costs nothing but a scan — quarantine it so the bug
      // leaves evidence, and rebuild from the files that are the actual truth.
      this.catalogMissing = true
      this.onIssue('journal_catalog_corrupt', 'warn', { bytes: raw.length })
      await this.quarantine(file)
      return
    }
    this.rebuiltAt = catalog.rebuiltAt
    for (const entry of catalog.entries) this.entries.set(entry.id, entry)
  }

  /** True until `scan()` has run once — the recorder holds sightings until then. */
  get needsScan(): boolean {
    return !this.scanned
  }

  /**
   * Rebuild-by-scan: walk the directory, refresh every entry whose file moved,
   * drop entries whose file is gone, quarantine what will not parse, and
   * rewrite the catalog. This is also the crash-recovery walk — `recording`
   * files found here are orphans of a killed process; the recorder demotes them
   * to `suspended` when it takes them over.
   *
   * Idempotent and concurrency-safe: a second call while one is in flight joins
   * the first.
   */
  scan(): Promise<ScanResult> {
    if (this.scanning) return this.scanning
    const run = this.runScan().finally(() => {
      this.scanning = null
      this.scanned = true
    })
    this.scanning = run
    return run
  }

  private async runScan(): Promise<ScanResult> {
    const started = this.now()
    const result: ScanResult = {
      files: 0,
      parsed: 0,
      recovered: 0,
      quarantined: 0,
      unreadable: 0,
      dropped: 0,
      bytes: 0,
      durationMs: 0
    }
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      // No directory yet: an empty archive is the correct answer, not an error.
      result.durationMs = this.now() - started
      return result
    }
    const seen = new Set<string>()
    let sinceYield = 0
    for (const name of names) {
      if (!name.endsWith('.json') || name === CATALOG_FILE) continue
      const id = name.slice(0, -'.json'.length)
      result.files++
      const path = join(this.dir, name)
      let info: { size: number; mtimeMs: number }
      try {
        const s = await stat(path)
        info = { size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        continue
      }
      result.bytes += info.size
      seen.add(id)
      const known = this.entries.get(id)
      if (
        known &&
        known.file === name &&
        known.fileBytes === info.size &&
        known.fileMtimeMs === info.mtimeMs
      ) {
        // Stat-cache hit: the file has not moved since we last derived its row.
        continue
      }
      if (++sinceYield >= SCAN_YIELD_EVERY) {
        sinceYield = 0
        await yieldToLoop()
      }
      result.parsed++
      const loaded = await this.load(id)
      if (loaded.ok) {
        if (loaded.recoveredFromTmp) result.recovered++
        // Re-stat: recovery from a temp changes the file under us.
        const after = await statSafe(path)
        this.entries.set(id, catalogEntryFromRun(loaded.run, after ?? info))
        this.catalogDirty = true
        continue
      }
      if (loaded.reason === 'unsupported-schema') {
        result.unreadable++
        this.entries.set(id, unreadableEntry(id, name, info, loaded.schema ?? 0, this.now()))
        this.catalogDirty = true
        continue
      }
      if (loaded.reason === 'corrupt') result.quarantined++
      this.entries.delete(id)
      seen.delete(id)
      this.catalogDirty = true
    }
    // Rows whose file vanished (a manual delete, a half-finished uninstall).
    for (const id of [...this.entries.keys()]) {
      if (seen.has(id)) continue
      this.entries.delete(id)
      this.runs.delete(id)
      this.dirty.delete(id)
      result.dropped++
      this.catalogDirty = true
    }
    result.durationMs = this.now() - started
    this.rebuiltAt = this.now()
    if (this.catalogMissing || this.catalogDirty) {
      this.catalogDirty = true
      this.catalogMissing = false
      await this.writeCatalog()
    }
    this.onIssue('journal_scan', 'info', { ...result })
    return result
  }

  /** Stops the debounce timer. Callers that need the data on disk flush first. */
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** Newest first. Ties break on file mtime, per the clock-skew rule (§5.3). */
  list(): CatalogEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt || b.fileMtimeMs - a.fileMtimeMs
    )
  }

  entry(id: string): CatalogEntry | null {
    return this.entries.get(id) ?? null
  }

  /**
   * The matcher's candidate set: same character, still resumable, newest first.
   * Each row carries its deck multiset (audit A6), so matching answers EVOLVED,
   * subset and regression predicates without opening a single run file.
   */
  candidates(character: string): CatalogEntry[] {
    const want = normalizeRunCharacter(character)
    return this.list().filter(
      (e) =>
        !e.unreadable &&
        normalizeRunCharacter(e.character) === want &&
        (e.state === 'suspended' || e.state === 'recording')
    )
  }

  /** Runs awaiting the user's answer to the ambiguity banner. */
  pendingResolutions(): CatalogEntry[] {
    return this.list().filter((e) => e.ambiguity !== null && e.ambiguity.resolution === null)
  }

  /**
   * Loads one run file. Order of attempts mirrors the write: the target, then
   * any surviving temp (a crash between write and rename), then quarantine.
   */
  async load(id: string): Promise<RunLoadResult> {
    const held = this.runs.get(id)
    if (held) return { ok: true, run: held, recoveredFromTmp: false }
    const name = runFileName(id)
    const path = join(this.dir, name)
    let text: string | null = null
    try {
      text = await readFile(path, 'utf8')
    } catch {
      text = null
    }
    if (text !== null) {
      const parsed = parseRunFile(text)
      if (parsed.ok) {
        this.runs.set(id, parsed.run)
        await this.sweepStrayTemps(name)
        return { ok: true, run: parsed.run, recoveredFromTmp: false }
      }
      if (parsed.reason === 'unsupported-schema') {
        return { ok: false, reason: 'unsupported-schema', schema: parsed.schema }
      }
    }
    // The target is missing or unusable: try the temps, newest first.
    for (const tmp of await this.tempsFor(name)) {
      let tmpText: string
      try {
        tmpText = await readFile(tmp, 'utf8')
      } catch {
        continue
      }
      const parsed = parseRunFile(tmpText)
      if (!parsed.ok) continue
      this.onIssue('journal_run_recovered_from_tmp', 'warn', { id })
      if (this.writable) {
        try {
          await renameWithRetry(tmp, path)
        } catch (err) {
          this.onIssue('journal_run_recover_rename_failed', 'warn', { id }, err)
        }
      }
      this.runs.set(id, parsed.run)
      return { ok: true, run: parsed.run, recoveredFromTmp: true }
    }
    if (text === null) return { ok: false, reason: 'missing' }
    this.onIssue('journal_run_file_corrupt', 'warn', { id, bytes: text.length })
    await this.quarantine(path)
    return { ok: false, reason: 'corrupt' }
  }

  /** Convenience for callers that treat every failure the same way. */
  async getRun(id: string): Promise<RunFile | null> {
    const res = await this.load(id)
    return res.ok ? res.run : null
  }

  /** Total bytes under the runs directory — the size telemetry the plan asks for. */
  async totalBytes(): Promise<number> {
    let total = 0
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return 0
    }
    for (const name of names) {
      const s = await statSafe(join(this.dir, name))
      if (s) total += s.size
    }
    return total
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /**
   * Mints a run file in memory and schedules its first flush. The id embeds the
   * first-seen instant and character so the directory is browsable and sorts
   * chronologically without opening anything.
   */
  createRun(init: NewRunInit): RunFile {
    const at = init.firstSeenAt ?? this.now()
    const character = normalizeRunCharacter(init.character)
    const id = newRunId(character, at)
    const run = newRunFile(id, { ...init, character, firstSeenAt: at })
    this.runs.set(id, run)
    this.save(run)
    return run
  }

  /**
   * Registers a mutated run and marks it for the next flush. The recorder keeps
   * the object and mutates it in place; the store's job is only to notice.
   *
   * `immediate` is for the lifecycle transitions the plan flushes on the spot
   * (attach, detach, room enter, combat end, close) rather than at debounce.
   */
  save(run: RunFile, opts: { immediate?: boolean } = {}): void {
    // `lastSeenAt` is the Archive's recency order and must never rewind, even
    // if the wall clock does.
    const prev = this.entries.get(run.id)
    if (prev && run.lastSeenAt < prev.lastSeenAt) {
      this.onIssue('journal_clock_rewind', 'info', {
        id: run.id,
        byMs: prev.lastSeenAt - run.lastSeenAt
      })
      run.lastSeenAt = prev.lastSeenAt
    }
    this.runs.set(run.id, run)
    this.dirty.add(run.id)
    this.entries.set(run.id, catalogEntryFromRun(run, this.entries.get(run.id)))
    this.catalogDirty = true
    if (opts.immediate) void this.flush()
    else this.schedule()
  }

  /** Deletes a run and its row. The Archive's per-run Delete; nothing else prunes. */
  async delete(id: string): Promise<boolean> {
    if (!this.allowWrite()) return false
    const name = runFileName(id)
    this.runs.delete(id)
    this.dirty.delete(id)
    this.entries.delete(id)
    this.catalogDirty = true
    try {
      await unlink(join(this.dir, name))
    } catch {
      // Already gone; the row going with it is still the right outcome.
    }
    for (const tmp of await this.tempsFor(name)) {
      try {
        await unlink(tmp)
      } catch {
        /* best effort */
      }
    }
    await this.writeCatalog()
    return true
  }

  /** Writes everything dirty. Safe to call at any time; serialised with itself. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true
      return this.flushing
    }
    const run = this.runFlush().finally(() => {
      this.flushing = null
      if (this.flushAgain) {
        this.flushAgain = false
        void this.flush()
      }
    })
    this.flushing = run
    return run
  }

  private async runFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.allowWrite()) {
      this.dirty.clear()
      this.catalogDirty = false
      return
    }
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) {
      const run = this.runs.get(id)
      if (!run) continue
      try {
        await mkdir(this.dir, { recursive: true })
        const path = join(this.dir, runFileName(id))
        const bytes = await writeAtomic(path, serializeRun(run), () => this.tempName(path))
        this.entries.set(id, catalogEntryFromRun(run, { size: bytes, mtimeMs: this.now() }))
        // The mtime we just guessed is close but not exact; a stat keeps the
        // scan's cache honest instead of forcing a re-parse next launch.
        const s = await statSafe(path)
        if (s) this.entries.set(id, catalogEntryFromRun(run, s))
      } catch (err) {
        // Put it back: the next flush retries rather than dropping the run.
        this.dirty.add(id)
        this.onIssue('journal_run_write_failed', 'error', { id }, err)
      }
    }
    if (this.catalogDirty) await this.writeCatalog()
  }

  /**
   * The `will-quit` path: synchronous, because the process will not be alive
   * for a promise. Idempotent, because `will-quit` fires twice (the telemetry
   * flush preventDefaults the first one).
   */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.allowWrite()) {
      this.dirty.clear()
      this.catalogDirty = false
      return
    }
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) {
      const run = this.runs.get(id)
      if (!run) continue
      try {
        mkdirSync(this.dir, { recursive: true })
        const path = join(this.dir, runFileName(id))
        const bytes = writeAtomicSync(path, serializeRun(run), () => this.tempName(path))
        const s = statSyncSafe(path)
        this.entries.set(id, catalogEntryFromRun(run, s ?? { size: bytes, mtimeMs: this.now() }))
      } catch (err) {
        this.onIssue('journal_run_write_failed', 'error', { id, sync: true }, err)
      }
    }
    if (!this.catalogDirty) return
    try {
      const path = join(this.dir, CATALOG_FILE)
      writeAtomicSync(path, this.serializeCatalog(), () => this.tempName(path))
      this.catalogDirty = false
    } catch (err) {
      this.onIssue('journal_catalog_write_failed', 'error', { sync: true }, err)
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private schedule(): void {
    if (!this.writable || this.disposed || this.timer) return
    const handle = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.debounceMs)
    // Never hold the process open for a debounce: quit flushes synchronously.
    ;(handle as unknown as { unref?: () => void }).unref?.()
    this.timer = handle
  }

  private allowWrite(): boolean {
    if (this.writable) return true
    if (!this.refusalReported) {
      this.refusalReported = true
      this.onIssue('journal_store_readonly', 'info', { reason: this.writeRefusal, dir: this.dir })
    }
    return false
  }

  private serializeCatalog(): string {
    const catalog: RunCatalog = {
      schema: JOURNAL_SCHEMA,
      rebuiltAt: this.rebuiltAt || this.now(),
      entries: this.list()
    }
    return JSON.stringify(catalog, null, 2)
  }

  private async writeCatalog(): Promise<void> {
    if (!this.allowWrite()) return
    try {
      await mkdir(this.dir, { recursive: true })
      const path = join(this.dir, CATALOG_FILE)
      await writeAtomic(path, this.serializeCatalog(), () => this.tempName(path))
      this.catalogDirty = false
    } catch (err) {
      // The catalog is a cache: a failed write costs a rebuild, not data.
      this.onIssue('journal_catalog_write_failed', 'error', {}, err)
    }
  }

  /**
   * Unique per target, per process and per write. A fixed `.tmp` name would let
   * the run flusher and the catalog flusher — which share a debounce — collide.
   */
  private tempName(path: string): string {
    return `${path}.${process.pid}.${++this.tmpSeq}.tmp`
  }

  private async tempsFor(name: string): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const matches = names.filter((n) => n.startsWith(`${name}.`) && n.endsWith('.tmp'))
    const withTime = await Promise.all(
      matches.map(async (n) => {
        const path = join(this.dir, n)
        return { path, mtimeMs: (await statSafe(path))?.mtimeMs ?? 0 }
      })
    )
    return withTime.sort((a, b) => b.mtimeMs - a.mtimeMs).map((t) => t.path)
  }

  /**
   * Removes temps left by *other* processes once the target itself has parsed —
   * only then, because until the target is known good a temp may be the last
   * copy of the run.
   */
  private async sweepStrayTemps(name: string): Promise<void> {
    if (!this.writable) return
    for (const tmp of await this.tempsFor(name)) {
      if (tmp.includes(`.${process.pid}.`)) continue
      try {
        await unlink(tmp)
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Moves an unreadable file aside instead of deleting it. It is user data and
   * the only evidence of whatever produced it; a `.corrupt` file costs a few KB
   * and can be mailed to us.
   */
  private async quarantine(path: string): Promise<void> {
    if (!this.writable) return
    let target = `${path}.corrupt`
    let n = 2
    while (await exists(target)) target = `${path}.corrupt.${n++}`
    try {
      await renameWithRetry(path, target)
    } catch (err) {
      this.onIssue('journal_quarantine_failed', 'warn', { path: target }, err)
    }
  }
}

// ── pure helpers (exported for the self-check and for WP3) ────────────────────

/** `<id>.json` — the one place the naming lives. */
export function runFileName(id: string): string {
  return `${id}.json`
}

/**
 * Which directory a given process journals into. Real play writes `runs/`;
 * anything synthetic — a `SPECTRA_JOURNAL_STUB` UI session, a screenshot
 * capture run, a `SPECTRA_STUB` dev launch — writes `runs-stub/`, so a fixture
 * can never appear in the user's archive and a capture run can never touch a
 * live catalog. Kept here rather than at the call site so the rule has exactly
 * one home.
 *
 * `SPECTRA_STUB` belongs on that list for the same reason as the other two, and
 * became load-bearing when it stopped being harmless: stub mode has no reader,
 * so nothing was ever recorded there — until `stub/journalDemoDriver.ts` began
 * driving the real recorder with a scripted run. Those runs are as synthetic as
 * a fixture and must not be filed next to the user's own.
 */
export function resolveRunsDir(
  userDataDir: string,
  env: Record<string, string | undefined> = process.env
): string {
  const synthetic =
    !!env['SPECTRA_JOURNAL_STUB'] || !!env['SPECTRA_CAPTURE'] || !!env['SPECTRA_STUB']
  return join(userDataDir, synthetic ? 'runs-stub' : 'runs')
}

/**
 * Upper-case, trimmed. The stub emits `ironclad` and the mockups say
 * `IRONCLAD`; normalising once here keeps matching and grouping from being
 * accidentally case-sensitive (audit A12.5).
 */
export function normalizeRunCharacter(character: string): string {
  return character.trim().toUpperCase()
}

/**
 * `<ISO instant, filesystem-safe>-<character>-<6 hex>`. Sortable, unique enough
 * for a directory only this app writes, and readable in a bug report.
 */
export function newRunId(character: string, at: number, rand?: string): string {
  const iso = new Date(at).toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')
  const suffix = rand ?? randomBytes(3).toString('hex')
  return `${iso}-${normalizeRunCharacter(character).toLowerCase()}-${suffix}`
}

/** A snapshot that claims nothing: no deck read yet, no act known. */
export function emptyRunSnapshot(at: number): RunSnapshot {
  return {
    at,
    act: null,
    roomIndex: 0,
    roomType: null,
    deck: [],
    deckHash: '',
    deckSize: 0,
    eventCount: 0,
    combatAgg: { plays: {}, drawn: {} },
    openCombat: null,
    openOffer: null,
    paceActiveMs: 0
  }
}

/** A complete, honest run file: every unknown is null, every count is zero. */
export function newRunFile(id: string, init: NewRunInit): RunFile {
  const at = init.firstSeenAt ?? init.startedAt ?? 0
  const snapshot = { ...emptyRunSnapshot(at), ...(init.snapshot ?? {}) }
  return {
    schema: JOURNAL_SCHEMA,
    id,
    character: normalizeRunCharacter(init.character),
    gameVersion: init.gameVersion ?? null,
    state: 'recording',
    outcome: null,
    observedFrom: init.observedFrom,
    startedAt: init.startedAt,
    runStartTime: init.runStartTime ?? null,
    firstSeenAt: at,
    lastSeenAt: at,
    endedAt: null,
    // A mid-run attach can never produce complete counts, and says so from the
    // first byte rather than at render time.
    countsArePartial: init.observedFrom === 'mid-run',
    truncatedEvents: false,
    ambiguity: init.ambiguity ?? null,
    supersededBy: null,
    playerCount: init.playerCount ?? null,
    actReached: snapshot.act,
    roomsEntered: 0,
    floorReached: null,
    ascension: null,
    sessions: [],
    snapshot,
    events: [],
    combats: [],
    signature: { deckHash: snapshot.deckHash, relicHash: null, core: [] },
    finalDeck: null,
    relics: [],
    potions: [],
    pace: { elapsedMs: 0, roomsEntered: 0, perRoomAvgMs: null },
    analysisStatus: 'none',
    analysis: null,
    // Null, not absent: a fresh file states that no history file has been
    // merged, rather than leaving the reader to guess which it is.
    saveData: null
  }
}

/**
 * Derives an Archive row from a run file. The row is a projection and nothing
 * else — anything it says can be recomputed from the file, which is what makes
 * rebuild-by-scan byte-equivalent to the catalog it replaces.
 */
export function catalogEntryFromRun(
  run: RunFile,
  file?: { size: number; mtimeMs: number } | CatalogEntry
): CatalogEntry {
  const meta =
    file && 'fileBytes' in file
      ? { size: file.fileBytes, mtimeMs: file.fileMtimeMs }
      : (file ?? { size: 0, mtimeMs: 0 })
  const resumable = run.state === 'recording' || run.state === 'suspended'
  return {
    id: run.id,
    character: normalizeRunCharacter(run.character),
    startedAt: run.startedAt,
    firstSeenAt: run.firstSeenAt,
    lastSeenAt: run.lastSeenAt,
    state: run.state,
    outcome: run.outcome,
    observedFrom: run.observedFrom,
    actReached: run.actReached,
    roomsEntered: run.roomsEntered,
    countsArePartial: run.countsArePartial,
    deckSize: run.snapshot.deckSize,
    deckHash: run.snapshot.deckHash,
    // Only a resumable run is ever a matching candidate, so only a resumable
    // run pays the ~1 KB the multiset costs.
    deck: resumable ? [...run.snapshot.deck] : null,
    core: [...run.signature.core],
    // Unlike `deck` this is kept for terminal runs too: it costs one number,
    // and a closed run's start time is what tells a false close (a run that
    // reappears with the same start time) from an honest new run.
    runStartTime: run.runStartTime ?? null,
    playerCount: run.playerCount,
    activeMs: run.sessions.reduce((sum, s) => sum + (s.activeMs || 0), 0),
    analysisStatus: run.analysisStatus,
    ambiguity: run.ambiguity ? { ...run.ambiguity } : null,
    supersededBy: run.supersededBy,
    schema: run.schema,
    unreadable: false,
    file: runFileName(run.id),
    fileBytes: meta.size,
    fileMtimeMs: meta.mtimeMs,
    // One boolean rather than the section itself: the Archive needs to know a
    // row is merged, and the ~20 KB that proves it belongs in the run file.
    hasSaveData: !!run.saveData
  }
}

/** The row for a file we can see but must not read: a newer app wrote it. */
export function unreadableEntry(
  id: string,
  file: string,
  meta: { size: number; mtimeMs: number },
  schema: number,
  at: number
): CatalogEntry {
  return {
    id,
    character: '',
    startedAt: null,
    firstSeenAt: meta.mtimeMs || at,
    lastSeenAt: meta.mtimeMs || at,
    state: 'suspended',
    outcome: null,
    observedFrom: 'mid-run',
    actReached: null,
    roomsEntered: 0,
    countsArePartial: true,
    deckSize: 0,
    deckHash: '',
    deck: null,
    core: [],
    runStartTime: null,
    playerCount: null,
    activeMs: 0,
    analysisStatus: 'none',
    ambiguity: null,
    supersededBy: null,
    schema,
    unreadable: true,
    file,
    fileBytes: meta.size,
    fileMtimeMs: meta.mtimeMs
  }
}

export type RunParseResult =
  | { ok: true; run: RunFile }
  | { ok: false; reason: 'corrupt' }
  | { ok: false; reason: 'unsupported-schema'; schema: number }

/**
 * Parses and normalises a run file. Two rules, both about not destroying user
 * data: unknown *higher* schemas are refused rather than guessed at, and
 * unknown fields on a same-schema file are preserved verbatim, because a
 * newer minor version may have written fields we do not know and we rewrite the
 * whole file on every flush.
 */
export function parseRunFile(text: string): RunParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  if (!isRecord(raw)) return { ok: false, reason: 'corrupt' }
  const schema = typeof raw['schema'] === 'number' ? raw['schema'] : 0
  if (schema > JOURNAL_SCHEMA) return { ok: false, reason: 'unsupported-schema', schema }
  const id = raw['id']
  if (typeof id !== 'string' || !id) return { ok: false, reason: 'corrupt' }
  // The three structural fields the whole design rests on. Anything else can be
  // defaulted; without these the file is not a run file at all.
  if (!Array.isArray(raw['events'])) return { ok: false, reason: 'corrupt' }
  if (!Array.isArray(raw['sessions'])) return { ok: false, reason: 'corrupt' }
  if (!isRecord(raw['snapshot'])) return { ok: false, reason: 'corrupt' }
  const snapRaw = raw['snapshot']
  const firstSeenAt = num(raw['firstSeenAt'], 0)
  const snapshot: RunSnapshot = {
    ...emptyRunSnapshot(firstSeenAt),
    ...(snapRaw as Partial<RunSnapshot>),
    act: nullableNum(snapRaw['act']),
    deck: strings(snapRaw['deck']),
    deckHash: str(snapRaw['deckHash'], ''),
    deckSize: num(snapRaw['deckSize'], strings(snapRaw['deck']).length)
  }
  const run: RunFile = {
    // Spread first: fields this version does not know survive the round trip.
    ...(raw as unknown as RunFile),
    schema: schema || JOURNAL_SCHEMA,
    id,
    character: normalizeRunCharacter(str(raw['character'], '')),
    gameVersion: nullableStr(raw['gameVersion']),
    state: lifecycleState(raw['state']),
    outcome: outcomeOf(raw['outcome']),
    observedFrom: raw['observedFrom'] === 'start' ? 'start' : 'mid-run',
    startedAt: nullableNum(raw['startedAt']),
    runStartTime: nullableNum(raw['runStartTime']),
    firstSeenAt,
    lastSeenAt: num(raw['lastSeenAt'], firstSeenAt),
    endedAt: nullableNum(raw['endedAt']),
    countsArePartial: raw['countsArePartial'] === true,
    truncatedEvents: raw['truncatedEvents'] === true,
    ambiguity: ambiguityOf(raw['ambiguity']),
    supersededBy: nullableStr(raw['supersededBy']),
    playerCount: nullableNum(raw['playerCount']),
    actReached: nullableNum(raw['actReached']),
    roomsEntered: num(raw['roomsEntered'], 0),
    floorReached: nullableNum(raw['floorReached']),
    ascension: nullableNum(raw['ascension']),
    sessions: raw['sessions'] as RunFile['sessions'],
    snapshot,
    events: raw['events'] as RunFile['events'],
    combats: Array.isArray(raw['combats']) ? (raw['combats'] as RunFile['combats']) : [],
    signature: signatureOf(raw['signature'], snapshot.deckHash),
    finalDeck: Array.isArray(raw['finalDeck']) ? (raw['finalDeck'] as RunFile['finalDeck']) : null,
    relics: strings(raw['relics']),
    potions: strings(raw['potions']),
    pace: paceOf(raw['pace']),
    analysisStatus: analysisStatusOf(raw['analysisStatus']),
    analysis: (raw['analysis'] ?? null) as RunFile['analysis'],
    saveData: saveDataOf(raw['saveData'])
  }
  return { ok: true, run }
}

/** Returns null for anything that is not a catalog we can use — the caller rebuilds. */
export function parseCatalog(text: string): RunCatalog | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !Array.isArray(raw['entries'])) return null
  const schema = typeof raw['schema'] === 'number' ? raw['schema'] : 0
  // A catalog from a newer app is not worth guessing at either — but unlike a
  // run file it costs nothing to discard, because a scan rebuilds it exactly.
  if (schema !== JOURNAL_SCHEMA) return null
  const entries = (raw['entries'] as unknown[]).filter(isPlausibleEntry)
  return { schema, rebuiltAt: num(raw['rebuiltAt'], 0), entries }
}

/** Stable, pretty JSON: run files are user data people do read and diff. */
export function serializeRun(run: RunFile): string {
  return JSON.stringify(run, null, 2)
}

// ── atomic write ─────────────────────────────────────────────────────────────

/**
 * write(unique temp) → fsync → close → rename-over-target, each step retried on
 * the transient Win32 sharing errors. `rename` replaces an existing file on
 * Windows (Node maps it to `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`), so there
 * is no unlink-first step to open a window where the target does not exist.
 *
 * Returns the byte length written.
 */
export async function writeAtomic(
  path: string,
  data: string,
  tempName: () => string
): Promise<number> {
  const bytes = Buffer.byteLength(data)
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const tmp = tempName()
    try {
      const handle = await open(tmp, 'w')
      try {
        await handle.writeFile(data, 'utf8')
        // The whole point: without this, a power loss can leave a target that
        // renamed successfully over nothing but unflushed pages.
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmp, path)
      await fsyncDir(path)
      return bytes
    } catch (err) {
      lastErr = err
      await unlink(tmp).catch(() => {})
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isRetryable(err)) throw err
      await sleep(delay)
    }
  }
  throw lastErr
}

/** The `will-quit` twin of `writeAtomic`; same guarantees, no event loop. */
export function writeAtomicSync(path: string, data: string, tempName: () => string): number {
  const bytes = Buffer.byteLength(data)
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const tmp = tempName()
    try {
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, data, 0, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, path)
      return bytes
    } catch (err) {
      lastErr = err
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isRetryable(err)) throw err
      sleepSync(delay)
    }
  }
  throw lastErr
}

/** `rename` with the same retry ladder, for recovery and quarantine moves. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isRetryable(err)) throw err
      await sleep(delay)
    }
  }
}

/** True for the "someone else is holding this file, briefly" family. */
export function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && RETRYABLE.has(code)
}

/**
 * Runs `fn`, retrying the transient sharing errors on the standard ladder.
 * Exported because it is the piece worth testing on its own — the failure it
 * exists for cannot be provoked reliably from a test.
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  delays: readonly number[] = RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      const delay = delays[attempt]
      if (delay === undefined || !isRetryable(err)) throw err
      await sleep(delay)
    }
  }
}

// ── small fs/parse utilities ─────────────────────────────────────────────────

/**
 * Best-effort directory fsync so the rename itself is durable. Windows refuses
 * to open a directory for this, which is expected and ignored — the file's own
 * fsync is the guarantee that matters.
 */
async function fsyncDir(filePath: string): Promise<void> {
  const dir = filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')))
  if (!dir) return
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* not supported on this platform; the file fsync already happened */
  }
}

async function statSafe(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

function statSyncSafe(path: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  return (await statSafe(path)) !== null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Blocking sleep for the synchronous quit path, where there is no loop left. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function nullableNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

const LIFECYCLE: readonly RunLifecycleState[] = ['recording', 'suspended', 'closed', 'abandoned']

function lifecycleState(v: unknown): RunLifecycleState {
  // An unrecognised state is treated as `suspended`: it keeps the run a resume
  // candidate, which is the only reading that cannot lose anything.
  return LIFECYCLE.includes(v as RunLifecycleState) ? (v as RunLifecycleState) : 'suspended'
}

const OUTCOMES: readonly string[] = ['ended', 'death', 'victory', 'superseded', 'abandoned']

function outcomeOf(v: unknown): RunFile['outcome'] {
  return typeof v === 'string' && OUTCOMES.includes(v) ? (v as RunFile['outcome']) : null
}

/**
 * The merged save section, round-tripped rather than validated field by field.
 * `SaveScribe` is its only writer and normalises on the way in; re-deriving the
 * shape here would only give two places to disagree. The one thing this must do
 * is refuse a non-object, so a hand-edited file cannot make `saveData` a string
 * that every consumer then has to defend against.
 */
function saveDataOf(v: unknown): RunFile['saveData'] {
  if (!isRecord(v)) return null
  return v as unknown as NonNullable<RunFile['saveData']>
}

const ANALYSIS: readonly AnalysisStatus[] = ['none', 'pending', 'partial', 'done', 'failed']

function analysisStatusOf(v: unknown): AnalysisStatus {
  return ANALYSIS.includes(v as AnalysisStatus) ? (v as AnalysisStatus) : 'none'
}

function ambiguityOf(v: unknown): RunAmbiguity | null {
  if (!isRecord(v) || typeof v['candidateId'] !== 'string') return null
  const resolution = v['resolution']
  return {
    candidateId: v['candidateId'],
    raisedAt: num(v['raisedAt'], 0),
    resolution: resolution === 'fresh' || resolution === 'resumed' ? resolution : null,
    resolvedAt: nullableNum(v['resolvedAt'])
  }
}

function signatureOf(v: unknown, deckHash: string): RunFile['signature'] {
  if (!isRecord(v)) return { deckHash, relicHash: null, core: [] }
  return {
    deckHash: str(v['deckHash'], deckHash),
    relicHash: nullableStr(v['relicHash']),
    core: strings(v['core'])
  }
}

function paceOf(v: unknown): RunFile['pace'] {
  if (!isRecord(v)) return { elapsedMs: 0, roomsEntered: 0, perRoomAvgMs: null }
  return {
    elapsedMs: num(v['elapsedMs'], 0),
    roomsEntered: num(v['roomsEntered'], 0),
    perRoomAvgMs: nullableNum(v['perRoomAvgMs'])
  }
}

/** A row we can render. Anything less and the scan rebuilds it from the file. */
function isPlausibleEntry(v: unknown): v is CatalogEntry {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    !!v['id'] &&
    typeof v['file'] === 'string' &&
    typeof v['fileBytes'] === 'number' &&
    typeof v['fileMtimeMs'] === 'number'
  )
}
