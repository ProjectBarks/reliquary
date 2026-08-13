import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  catalogCacheKey,
  codexImageUrl,
  metricsCacheKey,
  normalizeCharacter,
  type CatalogPayload,
  type CodexBracket,
  type CodexCard,
  type CodexCatalogKind,
  type CodexCatalogMap,
  type CodexCharacter,
  type CodexKeyword,
  type CodexKind,
  type CodexPayload,
  type CodexPotion,
  type CodexRelic,
  type MetricsPayload,
  type MetricsRow,
  type MetricsTable
} from '@shared/codex'

/**
 * The renderer's half of the compendium's stale-while-revalidate.
 *
 * Shaped after `hooks/useIpc.ts`: one module-level store keyed by the same
 * cache keys the main process uses, `useSyncExternalStore` on top, so ten
 * components asking for the card catalog share one request and one array. The
 * difference is direction — `useIpc` is fed by broadcasts, this is fed by
 * request/reply plus a revalidation push — which is why the two are separate
 * stores rather than one with a mode flag.
 *
 * Two rules the rest of the tab depends on:
 *   1. A failed *revalidation* never blanks data we already have. A stale card
 *      list is worth infinitely more than an error page, so a failure lands as
 *      an `error` beside the data, not instead of it.
 *   2. `getSnapshot` returns the stored object by reference. Building a fresh
 *      `{data, loading}` on every call is the classic way to make
 *      `useSyncExternalStore` loop forever.
 */

// ── the store ───────────────────────────────────────────────────────────────

export interface Resource<T> {
  data: T | null
  /** Set when the *last attempt* failed; `data` may still be a usable old copy. */
  error: string | null
  /** No data yet and a request is out. */
  loading: boolean
  /** Data is real but a refresh is in flight — the whisper, not the spinner. */
  stale: boolean
  fetchedAt: number | null
}

type Listener = () => void

/** The snapshot handed out for a key nobody has fetched yet. One frozen object. */
const PENDING: Resource<never> = Object.freeze({
  data: null,
  error: null,
  loading: true,
  stale: false,
  fetchedAt: null
})

const store = new Map<string, Resource<unknown>>()
const listeners = new Map<string, Set<Listener>>()
const inflight = new Set<string>()

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

/** Fold an IPC payload into the store, keeping the last good data on failure. */
function apply(key: string, payload: CodexPayload<unknown>): void {
  const previous = store.get(key)
  if (payload.error !== undefined) {
    put(key, {
      data: previous?.data ?? null,
      error: payload.error,
      loading: false,
      stale: false,
      fetchedAt: previous?.fetchedAt ?? null
    })
    return
  }
  put(key, {
    data: payload.data,
    error: null,
    loading: false,
    stale: payload.stale,
    fetchedAt: payload.fetchedAt
  })
}

function fail(key: string, message: string): void {
  const previous = store.get(key)
  put(key, {
    data: previous?.data ?? null,
    error: message,
    loading: false,
    stale: false,
    fetchedAt: previous?.fetchedAt ?? null
  })
}

/**
 * The bridge is absent when this bundle is opened outside Electron (the Vite
 * dev server in a plain browser). That is a legitimate way to look at the UI,
 * so it gets a designed error state rather than a TypeError.
 */
const NO_BRIDGE = 'Compendium bridge unavailable in this window.'

let pushWired = false
function wirePush(): void {
  if (pushWired) return
  if (typeof window === 'undefined' || !window.spectra) return
  pushWired = true
  window.spectra.onCodexPush(({ key, value }) => {
    // Only for keys something has actually asked for. Caching a push nobody
    // wants would grow the store with tables no view will ever read.
    if (store.has(key)) apply(key, value)
  })
}

function load(key: string, request: () => Promise<CodexPayload<unknown>>): void {
  if (inflight.has(key)) return
  wirePush()
  if (typeof window === 'undefined' || !window.spectra) {
    if (!store.has(key)) fail(key, NO_BRIDGE)
    return
  }
  inflight.add(key)
  if (!store.has(key)) store.set(key, PENDING as Resource<unknown>)
  request()
    .then((payload) => apply(key, payload))
    .catch((err: unknown) => fail(key, err instanceof Error ? err.message : String(err)))
    .finally(() => inflight.delete(key))
}

function startCatalog(kind: CodexCatalogKind): void {
  const key = catalogCacheKey(kind)
  if (store.has(key)) return
  load(key, () => window.spectra.codexCatalog(kind) as Promise<CodexPayload<unknown>>)
}

function startMetrics(kind: CodexKind, bracket: CodexBracket, character: string | null): void {
  const key = metricsCacheKey({ kind, bracket, character })
  if (store.has(key)) return
  load(key, () =>
    window.spectra.codexMetrics({
      kind,
      bracket,
      character: normalizeCharacter(character)
    }) as Promise<CodexPayload<unknown>>
  )
}

/**
 * Ask for a fresh copy now. The service answers the invoke from cache and
 * pushes the fresh copy when it lands, so the retry button resolves to *some*
 * state immediately even when the network is still down.
 */
/** Clear the last failure and show the right kind of waiting for a retry. */
function markRefreshing(key: string): void {
  const previous = store.get(key)
  put(key, {
    data: previous?.data ?? null,
    error: null,
    loading: !previous?.data,
    stale: Boolean(previous?.data),
    fetchedAt: previous?.fetchedAt ?? null
  })
}

function refreshCatalog(kind: CodexCatalogKind): void {
  const key = catalogCacheKey(kind)
  if (typeof window === 'undefined' || !window.spectra) {
    fail(key, NO_BRIDGE)
    return
  }
  markRefreshing(key)
  // Fire-and-forget: this only tells the service to go look. The answer we
  // render comes from the invoke below (cache, possibly stale) and then from
  // the push when the network copy lands.
  void window.spectra.codexRefresh(kind).catch(() => undefined)
  load(key, () => window.spectra.codexCatalog(kind) as Promise<CodexPayload<unknown>>)
}

function refreshMetrics(kind: CodexKind, bracket: CodexBracket, character: string | null): void {
  const key = metricsCacheKey({ kind, bracket, character })
  markRefreshing(key)
  load(key, () =>
    window.spectra.codexMetrics({
      kind,
      bracket,
      character: normalizeCharacter(character)
    }) as Promise<CodexPayload<unknown>>
  )
}

// ── hooks ───────────────────────────────────────────────────────────────────

export interface CatalogResource<K extends CodexCatalogKind> extends Resource<CodexCatalogMap[K]> {
  refresh: () => void
}

export function useCatalog<K extends CodexCatalogKind>(kind: K): CatalogResource<K> {
  const key = catalogCacheKey(kind)
  const sub = useCallback(
    (l: Listener) => {
      startCatalog(kind)
      return subscribe(key, l)
    },
    [key, kind]
  )
  const res = useSyncExternalStore(sub, () => snapshot<CodexCatalogMap[K]>(key))
  const refresh = useCallback(() => refreshCatalog(kind), [kind])
  return useMemo(() => ({ ...res, refresh }), [res, refresh])
}

export interface MetricsResource extends Resource<MetricsTable> {
  refresh: () => void
}

export function useMetrics(
  kind: CodexKind,
  bracket: CodexBracket,
  character: string | null
): MetricsResource {
  const normalized = normalizeCharacter(character)
  const key = metricsCacheKey({ kind, bracket, character: normalized })
  const sub = useCallback(
    (l: Listener) => {
      startMetrics(kind, bracket, normalized)
      return subscribe(key, l)
    },
    [key, kind, bracket, normalized]
  )
  const res = useSyncExternalStore(sub, () => snapshot<MetricsTable>(key))
  const refresh = useCallback(
    () => refreshMetrics(kind, bracket, normalized),
    [kind, bracket, normalized]
  )
  return useMemo(() => ({ ...res, refresh }), [res, refresh])
}

/** Keyword definitions for the dotted-underline tooltips. Never blocks a render. */
export function useKeywords(): CodexKeyword[] {
  const res = useCatalog('keywords')
  return res.data ?? EMPTY_KEYWORDS
}

const EMPTY_KEYWORDS: CodexKeyword[] = []

export function useCharacters(): CodexCharacter[] {
  const res = useCatalog('characters')
  return res.data ?? EMPTY_CHARACTERS
}

const EMPTY_CHARACTERS: CodexCharacter[] = []

// ── metrics index + the TRAP maths ──────────────────────────────────────────

export interface MetricsIndex {
  /** Non-upgraded rows by id — what a library tile or a tier list reads. */
  base: Map<string, MetricsRow>
  /** `upgraded: true` rows, only ever populated for cards. */
  upgraded: Map<string, MetricsRow>
  /** Whether *any* row in this table carries an elo. Drives column visibility. */
  hasElo: boolean
  eloMean: number
  eloStd: number
  scoreMean: number
  scoreStd: number
}

const EMPTY_INDEX: MetricsIndex = {
  base: new Map(),
  upgraded: new Map(),
  hasElo: false,
  eloMean: 0,
  eloStd: 0,
  scoreMean: 0,
  scoreStd: 0
}

function moments(xs: number[]): { mean: number; std: number } {
  const n = xs.length
  if (!n) return { mean: 0, std: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n
  return { mean, std: Math.sqrt(variance) }
}

/**
 * Bucket a metrics table by id and measure the two distributions the TRAP
 * index needs. Only the non-upgraded rows feed the moments: including the
 * upgraded twins would double-count every card and shift both means toward
 * whatever upgrading does on average.
 */
export function buildMetricsIndex(table: MetricsTable | null | undefined): MetricsIndex {
  if (!table) return EMPTY_INDEX
  const base = new Map<string, MetricsRow>()
  const upgraded = new Map<string, MetricsRow>()
  const elos: number[] = []
  const scores: number[] = []
  for (const row of table.rows) {
    if (row.upgraded) upgraded.set(row.id, row)
    else {
      base.set(row.id, row)
      if (row.elo != null && Number.isFinite(row.elo)) elos.push(row.elo)
      if (row.score != null && Number.isFinite(row.score)) scores.push(row.score)
    }
  }
  const e = moments(elos)
  const s = moments(scores)
  return {
    base,
    upgraded,
    hasElo: elos.length > 0,
    eloMean: e.mean,
    eloStd: e.std,
    scoreMean: s.mean,
    scoreStd: s.std
  }
}

/**
 * TRAP: how far a card's *reputation* runs ahead of its *results*.
 *
 * Elo is revealed preference — what players actually take out of a reward
 * screen — and score is what happened to the runs afterwards. Standardise both
 * against the cohort and subtract: positive means the room drafts it harder
 * than it deserves (a trap), negative means it quietly outperforms its
 * reputation (a sleeper). Null wherever elo is missing, which is most of the
 * table, and that silence is the honest answer.
 */
export function trapIndex(row: MetricsRow | null | undefined, index: MetricsIndex): number | null {
  if (!row || row.elo == null || row.score == null) return null
  if (index.eloStd <= 0 || index.scoreStd <= 0) return null
  const zElo = (row.elo - index.eloMean) / index.eloStd
  const zScore = (row.score - index.scoreMean) / index.scoreStd
  return Number((zElo - zScore).toFixed(2))
}

export const TRAP_THRESHOLD = 0.75

export type TrapVerdict = 'overdrafted' | 'sleeper' | null

export function trapVerdict(trap: number | null): TrapVerdict {
  if (trap == null) return null
  if (trap > TRAP_THRESHOLD) return 'overdrafted'
  if (trap < -TRAP_THRESHOLD) return 'sleeper'
  return null
}

// ── the join: catalog × metrics ─────────────────────────────────────────────

interface EntryBase {
  id: string
  name: string
  description: string | null
  /** Small art: the sprite for every kind. Always run through `codexImageUrl`. */
  thumb: string | null
  /** Large art: a card's full render, or the same sprite for relics/potions. */
  art: string | null
  compendiumOrder: number | null
  metrics: MetricsRow | null
  score: number | null
  tier: string | null
  elo: number | null
  winRate: number | null
  pickRate: number | null
  picks: number | null
}

/**
 * One row of a library view: the catalog entity, plus whatever the currently
 * selected cohort knows about it, flattened so a tile can render without a
 * second lookup. Discriminated on `kind` so `entry.item` narrows to the right
 * shape in a `switch` without a cast.
 */
export type LibraryEntry =
  | (EntryBase & { kind: 'cards'; item: CodexCard })
  | (EntryBase & { kind: 'relics'; item: CodexRelic })
  | (EntryBase & { kind: 'potions'; item: CodexPotion })

function withMetrics(base: Omit<EntryBase, keyof MetricsFields>, row: MetricsRow | null): EntryBase {
  return {
    ...base,
    metrics: row,
    score: row?.score ?? null,
    tier: row?.tier ?? null,
    elo: row?.elo ?? null,
    winRate: row?.win_rate ?? null,
    pickRate: row?.pick_rate ?? null,
    picks: row?.picks ?? null
  }
}

type MetricsFields = Pick<
  EntryBase,
  'metrics' | 'score' | 'tier' | 'elo' | 'winRate' | 'pickRate' | 'picks'
>

export interface LibraryData {
  entries: LibraryEntry[]
  catalog: Resource<unknown>
  metrics: MetricsResource
  index: MetricsIndex
  table: MetricsTable | null
  /** Nothing to show yet and at least one request is still out. */
  loading: boolean
  /** The catalog failed — the view has no rows at all. Metrics failing is softer. */
  error: string | null
  retry: () => void
}

/**
 * Catalog joined to the metrics table for the *currently selected cohort*.
 *
 * That last part is the important one, and it is inherited from the Overwolf
 * app's behaviour: sorting the library by score reads the bracket chosen up in
 * the sub-nav, so switching from "All runs" to "A10" genuinely reorders the
 * library. One authority for every number on screen.
 */
export function useLibraryEntries(
  kind: CodexKind,
  bracket: CodexBracket,
  character: string | null
): LibraryData {
  const catalog = useCatalog(kind)
  const metrics = useMetrics(kind, bracket, character)
  const index = useMemo(() => buildMetricsIndex(metrics.data), [metrics.data])

  const entries = useMemo<LibraryEntry[]>(() => {
    const rows = catalog.data
    if (!rows) return []
    if (kind === 'cards') {
      return (rows as CodexCard[]).map((item) => ({
        kind: 'cards' as const,
        item,
        ...withMetrics(
          {
            id: item.id,
            name: item.name,
            description: item.description,
            thumb: codexImageUrl(item.image_url),
            art: codexImageUrl(item.image_url_card) ?? codexImageUrl(item.image_url),
            compendiumOrder: item.compendium_order
          },
          index.base.get(item.id) ?? null
        )
      }))
    }
    if (kind === 'relics') {
      return (rows as CodexRelic[]).map((item) => ({
        kind: 'relics' as const,
        item,
        ...withMetrics(
          {
            id: item.id,
            name: item.name,
            description: item.description,
            thumb: codexImageUrl(item.image_url),
            art: codexImageUrl(item.image_url),
            compendiumOrder: item.compendium_order
          },
          index.base.get(item.id) ?? null
        )
      }))
    }
    return (rows as CodexPotion[]).map((item) => ({
      kind: 'potions' as const,
      item,
      ...withMetrics(
        {
          id: item.id,
          name: item.name,
          description: item.description,
          thumb: codexImageUrl(item.image_url),
          art: codexImageUrl(item.image_url),
          compendiumOrder: item.compendium_order
        },
        index.base.get(item.id) ?? null
      )
    }))
  }, [catalog.data, index, kind])

  const retry = useCallback(() => {
    catalog.refresh()
    metrics.refresh()
  }, [catalog, metrics])

  return {
    entries,
    catalog,
    metrics,
    index,
    table: metrics.data,
    loading: (catalog.loading && !catalog.data) || (metrics.loading && !metrics.data && !catalog.data),
    error: catalog.data ? null : catalog.error,
    retry
  }
}

/** Prefetched art urls, so hovering the same tile twice costs one request. */
const prefetched = new Set<string>()

/** Warm the browser cache for a full-size render before the click arrives. */
export function prefetchArt(url: string | null | undefined): void {
  if (!url || prefetched.has(url)) return
  prefetched.add(url)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
}
