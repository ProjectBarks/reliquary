import { useMemo } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { isCodexBracket, type CodexBracket, type CodexKind } from '@shared/codex'
import { getBracketPref, getCharacterPref, isCodexView, type CodexView } from './prefs'

/**
 * The Codex's URL vocabulary: what a link is allowed to say, and what a bad
 * link degrades to.
 *
 * Every validator here is pure and total — it takes whatever the address bar
 * happens to contain and returns something the views can render. Nothing
 * throws. A hand-edited `?sort=banana` should quietly become the default sort,
 * not a router error boundary; the URL is user input, and the only sane posture
 * toward user input is to accept what you understand and drop the rest.
 *
 * These same functions back the routes' `validateSearch` and the hooks the
 * components read, so a param is parsed by exactly one piece of code.
 */

// ── kinds ───────────────────────────────────────────────────────────────────

export const CODEX_KINDS: CodexKind[] = ['cards', 'relics', 'potions']

export function isCodexKind(v: unknown): v is CodexKind {
  return v === 'cards' || v === 'relics' || v === 'potions'
}

/** Singular, for prose: "No cards match" but "This relic…". */
export function kindNoun(kind: CodexKind): string {
  return kind === 'cards' ? 'card' : kind === 'relics' ? 'relic' : 'potion'
}

export function kindLabel(kind: CodexKind): string {
  return kind === 'cards' ? 'Cards' : kind === 'relics' ? 'Relics' : 'Potions'
}

// ── shared value parsers ────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed ? trimmed : undefined
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined
}

// ── /codex — the cohort every number on screen is read against ──────────────

export interface CodexSearch {
  bracket?: CodexBracket
  /** Character id, lower-case. Absent means every character. */
  character?: string
}

export function validateCodexSearch(search: Record<string, unknown>): CodexSearch {
  const out: CodexSearch = {}
  if (isCodexBracket(search['bracket'])) out.bracket = search['bracket']
  const character = str(search['character'])
  if (character && character !== 'all') out.character = character.toLowerCase()
  return out
}

// ── /codex/browse/$kind ─────────────────────────────────────────────────────

export type LibrarySort = 'order' | 'name' | 'name-desc' | 'score' | 'elo' | 'winrate'

const LIBRARY_SORTS: LibrarySort[] = ['order', 'name', 'name-desc', 'score', 'elo', 'winrate']

export const DEFAULT_LIBRARY_SORT: LibrarySort = 'order'

export interface BrowseSearch {
  q?: string
  view?: CodexView
  sort?: LibrarySort
  /** Card type key. */
  type?: string
  /** `rarity_key` for relics and potions; the card's own rarity for cards. */
  rarity?: string
  keyword?: string
  /** A card's character colour. Named `color` so it cannot collide with the
   *  codex-wide `character` cohort filter, which means something else entirely. */
  color?: string
  pool?: string
}

export function validateBrowseSearch(search: Record<string, unknown>): BrowseSearch {
  const out: BrowseSearch = {}
  const q = str(search['q'])
  if (q) out.q = q
  if (isCodexView(search['view'])) out.view = search['view']
  const sort = oneOf(search['sort'], LIBRARY_SORTS)
  if (sort) out.sort = sort
  for (const key of ['type', 'rarity', 'keyword', 'color', 'pool'] as const) {
    const value = str(search[key])
    if (value) out[key] = value
  }
  return out
}

/** The full search a `/codex/browse/**` link has to satisfy. */
export type FullBrowseSearch = CodexSearch & BrowseSearch

// ── /codex/meta ─────────────────────────────────────────────────────────────

export interface MetaSearch {
  kind?: CodexKind
  /** An entity to scroll to and ring, handed over from a detail's footer link. */
  highlight?: string
}

export function validateMetaSearch(search: Record<string, unknown>): MetaSearch {
  const out: MetaSearch = {}
  if (isCodexKind(search['kind'])) out.kind = search['kind']
  const highlight = str(search['highlight'])
  if (highlight) out.highlight = highlight
  return out
}

// ── /codex/meta/table ───────────────────────────────────────────────────────

export type TableColumn =
  | 'name'
  | 'tier'
  | 'score'
  | 'elo'
  | 'win'
  | 'pick'
  | 'seen'
  | 'runs'
  | 'a1'
  | 'a2'
  | 'a3'

const TABLE_COLUMNS: TableColumn[] = [
  'name',
  'tier',
  'score',
  'elo',
  'win',
  'pick',
  'seen',
  'runs',
  'a1',
  'a2',
  'a3'
]

export type SortDir = 'asc' | 'desc'

/** Which of a card's two rows to list. Relics and potions only have the one. */
export type Variant = 'base' | 'upgraded' | 'both'

export interface TableSearch {
  sort?: TableColumn
  dir?: SortDir
  /** Character colour filter (cards only); `curse` is included as a pseudo-colour. */
  color?: string
  variant?: Variant
}

export function validateTableSearch(search: Record<string, unknown>): TableSearch {
  const out: TableSearch = {}
  const sort = oneOf(search['sort'], TABLE_COLUMNS)
  if (sort) out.sort = sort
  const dir = oneOf(search['dir'], ['asc', 'desc'] as const)
  if (dir) out.dir = dir
  const color = str(search['color'])
  if (color) out.color = color.toLowerCase()
  const variant = oneOf(search['variant'], ['base', 'upgraded', 'both'] as const)
  if (variant) out.variant = variant
  return out
}

export type FullMetaSearch = CodexSearch & MetaSearch
export type FullTableSearch = CodexSearch & MetaSearch & TableSearch

// ── reading the URL back ────────────────────────────────────────────────────

/**
 * The current location's raw search object.
 *
 * Selecting the router's own `location.search` gives a reference that only
 * changes when the URL does, which is exactly the stability
 * `useSyncExternalStore` wants underneath `useRouterState`. It is re-parsed
 * through the validators above rather than trusted, so this hook behaves the
 * same whether it is called from inside a validated route or from a component
 * that happens to be mounted somewhere else.
 */
function useRawSearch(): Record<string, unknown> {
  return useRouterState({
    select: (s) => s.location.search as unknown as Record<string, unknown>
  })
}

/**
 * The cohort the whole tab is reading: bracket and character, from the URL if
 * it says, otherwise from the remembered preference, otherwise "all runs".
 *
 * One authority. A tier list, a library sorted by score and a detail's win rate
 * that disagreed about which runs they were counting would be worse than
 * useless — they would each be individually plausible.
 */
export interface CodexScope {
  bracket: CodexBracket
  /** Lower-case character id, or null for every character. */
  character: string | null
}

export function useCodexScope(): CodexScope {
  const raw = useRawSearch()
  return useMemo(() => {
    const parsed = validateCodexSearch(raw)
    return {
      bracket: parsed.bracket ?? getBracketPref(),
      character: parsed.character ?? getCharacterPref()
    }
  }, [raw])
}

/** The codex-wide params as they should be written into an outgoing link. */
export function useCodexSearch(): CodexSearch {
  const scope = useCodexScope()
  return useMemo(
    () => ({
      bracket: scope.bracket,
      ...(scope.character ? { character: scope.character } : {})
    }),
    [scope.bracket, scope.character]
  )
}

export function useBrowseSearch(): FullBrowseSearch {
  const raw = useRawSearch()
  const scope = useCodexScope()
  return useMemo(
    () => ({
      ...validateBrowseSearch(raw),
      bracket: scope.bracket,
      ...(scope.character ? { character: scope.character } : {})
    }),
    [raw, scope.bracket, scope.character]
  )
}

export function useMetaSearch(): FullMetaSearch {
  const raw = useRawSearch()
  const scope = useCodexScope()
  return useMemo(
    () => ({
      ...validateMetaSearch(raw),
      bracket: scope.bracket,
      ...(scope.character ? { character: scope.character } : {})
    }),
    [raw, scope.bracket, scope.character]
  )
}

export function useTableSearch(): FullTableSearch {
  const raw = useRawSearch()
  const meta = useMetaSearch()
  return useMemo(() => ({ ...meta, ...validateTableSearch(raw) }), [meta, raw])
}

/**
 * Which kind the tab is currently about, wherever you are in it — the browse
 * route says it in the path, the meta routes say it in a search param, and the
 * sub-nav's freshness whisper needs an answer either way.
 */
export function useActiveKind(): CodexKind {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const raw = useRawSearch()
  return useMemo(() => {
    const segments = pathname.split('/').filter(Boolean)
    if (segments[1] === 'browse' && isCodexKind(segments[2])) return segments[2]
    return validateMetaSearch(raw).kind ?? 'cards'
  }, [pathname, raw])
}
