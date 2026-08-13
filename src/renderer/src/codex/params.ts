import { useMemo } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { isCodexBracket, type CodexBracket, type CodexKind } from '@shared/codex'
import { getBracketPref, getCharacterPref, getModePref, isCodexMode, type CodexMode } from './prefs'

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

/**
 * Everything `browse/$kind` can say about what it is showing.
 *
 * This one route now carries all four modes, so it carries the union of what
 * they each need: the library's own sort, the tier list's scroll target, and
 * the table's column sort and variant. That is the point of the merge — a kind
 * is one place, and switching how you look at it neither changes route nor
 * throws away the filters you had set.
 *
 * The table's column sort is `col`, not `sort`, because `sort` already means
 * the library's ordering and the two vocabularies do not overlap ("win" is not
 * a library sort; "order" is not a column). One name for two meanings on one
 * route would make a link's behaviour depend on which mode happened to read it.
 */
export interface BrowseSearch {
  q?: string
  mode?: CodexMode
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
  /** An entity to scroll to and ring, handed over from a detail's footer link. */
  highlight?: string
  /** Table mode: which column is sorted, and which way. */
  col?: TableColumn
  dir?: SortDir
  /** Table mode: which of a card's two rows to list. */
  variant?: Variant
}

export function validateBrowseSearch(search: Record<string, unknown>): BrowseSearch {
  const out: BrowseSearch = {}
  const q = str(search['q'])
  if (q) out.q = q
  if (isCodexMode(search['mode'])) out.mode = search['mode']
  const sort = oneOf(search['sort'], LIBRARY_SORTS)
  if (sort) out.sort = sort
  for (const key of ['type', 'rarity', 'keyword', 'color', 'pool', 'highlight'] as const) {
    const value = str(search[key])
    if (value) out[key] = value
  }
  const col = oneOf(search['col'], TABLE_COLUMNS)
  if (col) out.col = col
  const dir = oneOf(search['dir'], ['asc', 'desc'] as const)
  if (dir) out.dir = dir
  const variant = oneOf(search['variant'], ['base', 'upgraded', 'both'] as const)
  if (variant) out.variant = variant
  return out
}

/** The full search a `/codex/browse/**` link has to satisfy. */
export type FullBrowseSearch = CodexSearch & BrowseSearch

// ── table vocabulary ────────────────────────────────────────────────────────

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

export const DEFAULT_TABLE_COLUMN: TableColumn = 'score'

/** Numbers want their biggest value first; a name wants its alphabet first. */
export function defaultTableDir(column: TableColumn): SortDir {
  return column === 'name' || column === 'tier' ? 'asc' : 'desc'
}

// ── /codex/meta/** — the shape the old URLs used ────────────────────────────

/**
 * What a `/codex/meta`, `/codex/meta/tiers` or `/codex/meta/table` link could
 * say, kept only so those links can be turned into their `browse` equivalents.
 *
 * The meta subtree is gone, but the URLs are not: they are in recents, in the
 * back button, in whatever someone pasted into a chat two days ago. Reading
 * them costs one validator and one redirect each; breaking them costs a reader
 * a blank screen with no way to guess what replaced it.
 */
export interface LegacyMetaSearch {
  kind?: CodexKind
  highlight?: string
  /** The old table route's column sort, which is `col` now. */
  sort?: TableColumn
  dir?: SortDir
  color?: string
  variant?: Variant
}

/**
 * The `browse` URL an old `/codex/meta/**` link was asking for.
 *
 * Pure, and taking the raw search rather than reading the router, so the
 * redirect component can freeze its answer at mount — it re-renders during its
 * own navigation with the *destination's* search, and recomputing from that
 * would have it redirect to a translation of a URL it just wrote.
 */
export function legacyMetaTarget(
  raw: Record<string, unknown>,
  mode: 'tier' | 'table'
): { kind: CodexKind; search: FullBrowseSearch } {
  const legacy = validateLegacyMetaSearch(raw)
  const scope = validateCodexSearch(raw)
  const character = scope.character ?? getCharacterPref()
  return {
    kind: legacy.kind ?? 'cards',
    search: {
      bracket: scope.bracket ?? getBracketPref(),
      ...(character ? { character } : {}),
      mode,
      ...(legacy.highlight ? { highlight: legacy.highlight } : {}),
      ...(legacy.color ? { color: legacy.color } : {}),
      ...(legacy.variant ? { variant: legacy.variant } : {}),
      // The table's column sort was `sort` when the table had a route of its
      // own; on `browse` that name already belongs to the library's ordering.
      ...(legacy.sort ? { col: legacy.sort } : {}),
      ...(legacy.dir ? { dir: legacy.dir } : {})
    }
  }
}

export function validateLegacyMetaSearch(search: Record<string, unknown>): LegacyMetaSearch {
  const out: LegacyMetaSearch = {}
  if (isCodexKind(search['kind'])) out.kind = search['kind']
  const highlight = str(search['highlight'])
  if (highlight) out.highlight = highlight
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

/**
 * How the current kind is being looked at: the URL if it says, otherwise the
 * remembered preference, otherwise the art grid.
 *
 * Read from the raw search rather than from a route context so the layout — an
 * ancestor of the browse route, and mounted on the redirect routes too — can
 * ask the same question without knowing where it is.
 */
export function useBrowseMode(): CodexMode {
  const raw = useRawSearch()
  return useMemo(() => (isCodexMode(raw['mode']) ? raw['mode'] : getModePref()), [raw])
}

/**
 * Which kind the tab is currently about. The browse route says it in the path;
 * anywhere else — the index redirect, the legacy meta redirects — cards is the
 * one everybody wants.
 */
export function useActiveKind(): CodexKind {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return useMemo(() => {
    const segments = pathname.split('/').filter(Boolean)
    if (segments[1] === 'browse' && isCodexKind(segments[2])) return segments[2]
    return 'cards'
  }, [pathname])
}
