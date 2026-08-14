import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type {
  AmbiguityResolution,
  AnalysisStatus,
  CatalogEntry,
  JournalCurrentRun,
  JournalResult,
  RunFile,
  Sts2CardData,
  Sts2EnemiesState,
  Sts2PileState
} from '@shared/types'
import { useIpc } from '../hooks/useIpc'

/**
 * The renderer's half of the run journal: one store for the Archive index and
 * the run files, plus fixture-aware readers for the live keys.
 *
 * It is deliberately a *sibling* of `codex/data.ts` rather than a reuse of it.
 * The two stores look alike — same `Resource<T>`, same `useSyncExternalStore`
 * spine, same "a failed refresh never blanks good data" rule — but they answer
 * different contracts: the compendium's IPC returns `{data, stale, fetchedAt}`
 * from a network cache, and the journal's returns `{data} | {error}` from local
 * disk with no staleness to speak of. Generalising one store over both would
 * mean a payload adapter and a mode flag in the middle of the app's two most
 * state-sensitive surfaces, to save about forty lines. The duplication is
 * named here so the next person deletes the right one if they ever do merge
 * them.
 *
 * Three properties everything below depends on:
 *
 *   1. **Nothing polls.** The Archive is fed by `journal:list` once and by
 *      `JournalPush` forever after; the live run rides the keyed snapshot
 *      channel. A view left open while a run ends updates on its own.
 *   2. **Errors are values.** Every journal invoke resolves `{data}` or
 *      `{error}` and never rejects, so a failure lands in the store as an
 *      `error` beside whatever data we already had, and the view renders a
 *      state instead of catching one.
 *   3. **The harness answers first, and synchronously.** A canned catalog that
 *      arrived a tick later would give every mock screenshot a frame of
 *      skeleton to race against.
 */

// ── the store ───────────────────────────────────────────────────────────────

export interface Resource<T> {
  data: T | null
  /** Set when the last attempt failed; `data` may still be a usable old copy. */
  error: string | null
  /** No data yet and a request is out. */
  loading: boolean
  fetchedAt: number | null
}

type Listener = () => void

const PENDING: Resource<never> = Object.freeze({
  data: null,
  error: null,
  loading: true,
  fetchedAt: null
})

const store = new Map<string, Resource<unknown>>()
const listeners = new Map<string, Set<Listener>>()
const inflight = new Set<string>()

const CATALOG_KEY = 'journal:catalog'
const runKey = (id: string): string => `journal:run:${id}`

function subscribe(key: string, l: Listener): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(l)
  return () => {
    set?.delete(l)
  }
}

function emit(key: string): void {
  const set = listeners.get(key)
  if (!set) return
  for (const l of set) l()
}

function put(key: string, value: Resource<unknown>): void {
  store.set(key, value)
  emit(key)
}

function snapshot<T>(key: string): Resource<T> {
  return (store.get(key) as Resource<T> | undefined) ?? (PENDING as Resource<T>)
}

/** Fold a `JournalResult` into the store, keeping the last good copy on failure. */
function apply<T>(key: string, result: JournalResult<T>): void {
  const previous = store.get(key)
  if ('error' in result) {
    put(key, {
      data: previous?.data ?? null,
      error: result.error,
      loading: false,
      fetchedAt: previous?.fetchedAt ?? null
    })
    return
  }
  put(key, { data: result.data, error: null, loading: false, fetchedAt: Date.now() })
}

function fail(key: string, message: string): void {
  const previous = store.get(key)
  put(key, {
    data: previous?.data ?? null,
    error: message,
    loading: false,
    fetchedAt: previous?.fetchedAt ?? null
  })
}

const NO_BRIDGE = 'Journal bridge unavailable in this window.'

// ── the harness's back door ─────────────────────────────────────────────────

/**
 * `#/mock/journal/:view` installs a resolver here before handing over to the
 * real routes; from that moment every list, every run file and every live key
 * in the tab is answered from canned data instead of the bridge.
 *
 * Same reasoning as the Codex's seam: the alternative is a fixture prop
 * threaded through the layout, the report, four ledgers and the banner — a test
 * seam in the public shape of every component in the tab. This costs one
 * nullable module-level variable, written only from a route a production bundle
 * does not contain.
 */
export interface JournalFixtures {
  catalog?: CatalogEntry[]
  runs?: Record<string, RunFile>
  currentRun?: JournalCurrentRun | null
  piles?: Sts2PileState | null
  enemies?: Sts2EnemiesState | null
  cardData?: Sts2CardData | null
}

let fixtures: JournalFixtures | null = null

export function installJournalFixtures(source: JournalFixtures): void {
  fixtures = source
  // Seed the store synchronously so the first paint is the fixture, not a
  // spinner that resolves into one.
  if (source.catalog) apply(CATALOG_KEY, { data: source.catalog })
  for (const [id, run] of Object.entries(source.runs ?? {})) apply(runKey(id), { data: run })
}

export function journalFixturesInstalled(): boolean {
  return fixtures !== null
}

// ── loading ─────────────────────────────────────────────────────────────────

let pushWired = false

function wirePush(): void {
  if (pushWired) return
  if (typeof window === 'undefined' || !window.spectra) return
  pushWired = true
  window.spectra.onJournalPush((message) => {
    if (message.kind === 'catalog') {
      apply(CATALOG_KEY, { data: message.entries })
      return
    }
    // An analysis transition changes one row's chip and the run file behind it.
    // The row is patched in place (cheap, and keeps the list's identity stable
    // for anything mid-scroll); the file is re-fetched only if something is
    // actually reading it.
    patchAnalysis(message.id, message.status)
    if (store.has(runKey(message.id))) void loadRun(message.id, true)
  })
}

function patchAnalysis(id: string, status: AnalysisStatus): void {
  const current = store.get(CATALOG_KEY) as Resource<CatalogEntry[]> | undefined
  if (!current?.data) return
  let changed = false
  const next = current.data.map((entry) => {
    if (entry.id !== id || entry.analysisStatus === status) return entry
    changed = true
    return { ...entry, analysisStatus: status }
  })
  if (!changed) return
  put(CATALOG_KEY, { ...current, data: next })
}

function load<T>(key: string, request: () => Promise<JournalResult<T>>, force = false): void {
  if (fixtures) return
  if (inflight.has(key)) return
  if (!force && store.has(key) && !store.get(key)?.error) return
  wirePush()
  if (typeof window === 'undefined' || !window.spectra) {
    if (!store.has(key)) fail(key, NO_BRIDGE)
    return
  }
  inflight.add(key)
  if (!store.has(key)) store.set(key, PENDING as Resource<unknown>)
  request()
    .then((result) => apply(key, result))
    .catch((err: unknown) => fail(key, err instanceof Error ? err.message : String(err)))
    .finally(() => inflight.delete(key))
}

function loadCatalog(force = false): void {
  load(CATALOG_KEY, () => window.spectra.journalList(), force)
}

function loadRun(id: string, force = false): void {
  load(runKey(id), () => window.spectra.journalGet(id), force)
}

/** Clear a stored failure so a retry shows waiting rather than the old error. */
function markRefreshing(key: string): void {
  const previous = store.get(key)
  put(key, {
    data: previous?.data ?? null,
    error: null,
    loading: !previous?.data,
    fetchedAt: previous?.fetchedAt ?? null
  })
}

// ── hooks ───────────────────────────────────────────────────────────────────

export interface CatalogResource extends Resource<CatalogEntry[]> {
  refresh: () => void
}

/** The Archive index, newest first. Shared by every view that names a run. */
export function useJournalCatalog(): CatalogResource {
  const sub = useCallback((l: Listener) => {
    loadCatalog()
    return subscribe(CATALOG_KEY, l)
  }, [])
  const res = useSyncExternalStore(sub, () => snapshot<CatalogEntry[]>(CATALOG_KEY))
  const refresh = useCallback(() => {
    markRefreshing(CATALOG_KEY)
    loadCatalog(true)
  }, [])
  return useMemo(() => ({ ...res, refresh }), [res, refresh])
}

export interface RunResource extends Resource<RunFile> {
  refresh: () => void
}

/** One whole run file. The report and the review both render from this. */
export function useRunFile(id: string | null): RunResource {
  const key = id ? runKey(id) : 'journal:run:'
  const sub = useCallback(
    (l: Listener) => {
      if (id) loadRun(id)
      return subscribe(key, l)
    },
    [id, key]
  )
  const res = useSyncExternalStore(sub, () =>
    id ? snapshot<RunFile>(key) : (EMPTY_RUN as Resource<RunFile>)
  )
  const refresh = useCallback(() => {
    if (!id) return
    markRefreshing(key)
    loadRun(id, true)
  }, [id, key])
  return useMemo(() => ({ ...res, refresh }), [res, refresh])
}

/** The "no id asked for" snapshot: not loading, not broken, simply nothing. */
const EMPTY_RUN: Resource<never> = Object.freeze({
  data: null,
  error: null,
  loading: false,
  fetchedAt: null
})

/**
 * The newest finished run — what the Journal tab opens on.
 *
 * "Finished" means `closed`, not merely old: a suspended run is one the player
 * can still walk back into, and opening the tab on a report for a run that is
 * not over would be the wrong answer to "how did it go".
 */
export function useLatestFinishedRun(): CatalogEntry | null {
  const catalog = useJournalCatalog()
  return useMemo(() => {
    const rows = (catalog.data ?? []).filter((e) => e.state === 'closed' && !e.unreadable)
    if (rows.length === 0) return null
    return rows.reduce((a, b) => (a.lastSeenAt >= b.lastSeenAt ? a : b))
  }, [catalog.data])
}

// ── live keys ───────────────────────────────────────────────────────────────

/**
 * The run being recorded, or null when there is none.
 *
 * It reads `journal.currentRun` off the same keyed-snapshot store the overlay
 * lives on — no polling, no second channel — with the harness's canned run
 * taking precedence so the LIVE view can be screenshotted without a game.
 */
export function useCurrentRun(): JournalCurrentRun | null {
  const live = useIpc('journal.currentRun')
  if (fixtures && 'currentRun' in fixtures) return fixtures.currentRun ?? null
  return live
}

export function useLivePiles(): Sts2PileState | null {
  const live = useIpc('sts2.pileState')
  if (fixtures && 'piles' in fixtures) return fixtures.piles ?? null
  return live
}

export function useLiveEnemies(): Sts2EnemiesState | null {
  const live = useIpc('sts2.enemiesState')
  if (fixtures && 'enemies' in fixtures) return fixtures.enemies ?? null
  return live
}

export function useLiveCardData(): Sts2CardData | null {
  const live = useIpc('sts2.cardData')
  if (fixtures && 'cardData' in fixtures) return fixtures.cardData ?? null
  return live
}

// ── actions ─────────────────────────────────────────────────────────────────

/**
 * The four mutating invokes, each returning the result rather than throwing.
 *
 * They refresh the catalog themselves where main does not push one — main's
 * own push is authoritative when it comes, and a second list request is far
 * cheaper than a row that lies until the user navigates away and back.
 */
export async function exportRun(id: string): Promise<JournalResult<{ path: string; bytes: number }>> {
  if (fixtures) {
    return { data: { path: 'C:\\Users\\you\\Downloads\\' + id + '.json', bytes: 48_213 } }
  }
  if (typeof window === 'undefined' || !window.spectra) return { error: NO_BRIDGE }
  return window.spectra.journalExport(id)
}

export async function deleteRun(id: string): Promise<JournalResult<boolean>> {
  if (fixtures) return { data: true }
  if (typeof window === 'undefined' || !window.spectra) return { error: NO_BRIDGE }
  const result = await window.spectra.journalDelete(id)
  if ('data' in result) {
    store.delete(runKey(id))
    loadCatalog(true)
  }
  return result
}

export async function reanalyzeRun(id: string): Promise<JournalResult<AnalysisStatus>> {
  if (fixtures) return { data: 'pending' }
  if (typeof window === 'undefined' || !window.spectra) return { error: NO_BRIDGE }
  return window.spectra.journalReanalyze(id)
}

export async function resolveAmbiguity(
  id: string,
  resolution: AmbiguityResolution
): Promise<JournalResult<{ id: string; merged: boolean }>> {
  if (fixtures) return { data: { id, merged: resolution === 'resumed' } }
  if (typeof window === 'undefined' || !window.spectra) return { error: NO_BRIDGE }
  const result = await window.spectra.journalResolveAmbiguity(id, resolution)
  if ('data' in result) {
    // A merge deletes the provisional file; either answer moves the row.
    store.delete(runKey(id))
    loadCatalog(true)
  }
  return result
}
