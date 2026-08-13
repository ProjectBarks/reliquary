import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import styled from 'styled-components'
import type { CodexCard, CodexKind } from '@shared/codex'
import { Select } from '../dashboard/ui'
import { rarityColors } from '../overlays/sts2/theme'
import { prefetchArt, useLibraryEntries, type LibraryEntry } from './data'
import { DASH, compareNullable, fmtInt } from './format'
import {
  DEFAULT_LIBRARY_SORT,
  kindNoun,
  useBrowseSearch,
  useCodexScope,
  type FullBrowseSearch,
  type LibrarySort
} from './params'
import {
  Art,
  ArtPlate,
  Empty,
  ErrorState,
  Field,
  Loading,
  ResultCount,
  SearchAffordance,
  SearchIcon,
  SearchInput,
  SearchWrap,
  Segmented,
  Skeleton,
  Spacer,
  Toolbar,
  scrollbar
} from './parts'
import { getViewPref, setViewPref, useRecents, type CodexView } from './prefs'
import { rankItems } from './search'
import { TierBadge } from './tiers'
import { Detail, DetailModal } from './Detail'

/**
 * The compendium proper: 577 cards, 296 relics or 63 potions, filtered, sorted,
 * and shown either as art or as a list with a reading pane.
 *
 * Two modes rather than one because they answer different questions. The grid
 * is for recognising something — card art is how anyone who plays this game
 * actually identifies a card — and the list is for reading through a set with
 * the details open beside it. Which one you prefer is remembered; which one you
 * are *currently* using is in the URL, so a link says what it shows.
 *
 * Everything that narrows the view lives in the URL for the same reason. The
 * one exception is the text in the search box, which is mirrored locally and
 * debounced into the URL — typing "strike" should not put six entries in the
 * back button's history.
 */

const SEARCH_DEBOUNCE_MS = 175

export function LibraryView({ kind, detailId }: { kind: CodexKind; detailId?: string }): JSX.Element {
  const scope = useCodexScope()
  const search = useBrowseSearch()
  const navigate = useNavigate()
  const { entries, loading, error, retry, metrics } = useLibraryEntries(
    kind,
    scope.bracket,
    scope.character
  )

  const view: CodexView = search.view ?? getViewPref()
  const sort: LibrarySort = search.sort ?? DEFAULT_LIBRARY_SORT

  // ── URL writers ───────────────────────────────────────────────────────────
  const go = useCallback(
    (patch: Partial<FullBrowseSearch>, options?: { replace?: boolean; keepDetail?: boolean }) => {
      const next = { ...search, ...patch }
      const replace = options?.replace ?? true
      if (detailId && options?.keepDetail !== false) {
        navigate({
          to: '/codex/browse/$kind/$id',
          params: { kind, id: detailId },
          search: next,
          replace
        })
        return
      }
      navigate({ to: '/codex/browse/$kind', params: { kind }, search: next, replace })
    },
    [detailId, kind, navigate, search]
  )

  const openEntry = useCallback(
    (id: string) => {
      navigate({ to: '/codex/browse/$kind/$id', params: { kind, id }, search })
    },
    [kind, navigate, search]
  )

  const closeDetail = useCallback(() => {
    navigate({ to: '/codex/browse/$kind', params: { kind }, search })
  }, [kind, navigate, search])

  // ── search box ────────────────────────────────────────────────────────────
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(search.q ?? '')
  // The URL is the authority; the box follows it when navigation changes it
  // (a back button, a link from elsewhere) but not while it is being typed in.
  useEffect(() => {
    setDraft((current) => (current === (search.q ?? '') ? current : (search.q ?? '')))
  }, [search.q])

  useEffect(() => {
    const value = draft.trim()
    if (value === (search.q ?? '')) return
    const t = window.setTimeout(() => go({ q: value || undefined }), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [draft, go, search.q])

  // `/` focuses the search from anywhere in the tab, the way every database
  // this one is competing with behaves — but never while you are already typing
  // somewhere, which would swallow the slash out of a search for "1/2 damage".
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      input.current?.focus()
      input.current?.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const clearSearch = useCallback(() => {
    setDraft('')
    go({ q: undefined })
  }, [go])

  // ── filtering, ranking, sorting ───────────────────────────────────────────
  const options = useMemo(() => filterOptions(entries), [entries])
  const filtered = useMemo(() => applyFilters(entries, search), [entries, search])
  const ranked = useMemo(() => rankItems(filtered, search.q ?? ''), [filtered, search.q])
  const shown = useMemo(
    () => sortEntries(ranked, sort, Boolean(search.q) && sort === DEFAULT_LIBRARY_SORT),
    [ranked, sort, search.q]
  )

  const sortOptions = useMemo(
    () =>
      [
        { value: 'order' as const, label: 'Compendium order' },
        { value: 'name' as const, label: 'Name A–Z' },
        { value: 'name-desc' as const, label: 'Name Z–A' },
        { value: 'score' as const, label: 'Score' },
        // Elo only exists where card-reward picks do. Offering it on a relics
        // table that can only ever sort into "everything is null" would be a
        // control that does nothing, which is worse than one that isn't there.
        ...(kind === 'cards' ? [{ value: 'elo' as const, label: 'Elo' }] : []),
        { value: 'winrate' as const, label: 'Win rate' }
      ] satisfies Array<{ value: LibrarySort; label: string }>,
    [kind]
  )

  return (
    <>
      <Toolbar>
        <SearchWrap>
          <SearchIcon viewBox="0 0 16 16" aria-hidden>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" />
          </SearchIcon>
          <SearchInput
            ref={input}
            type="search"
            value={draft}
            placeholder={`Search ${kind}…`}
            aria-label={`Search ${kind}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              if (draft) clearSearch()
              else input.current?.blur()
            }}
          />
          {draft ? (
            <SearchAffordance type="button" aria-label="Clear search" title="Clear (Esc)" onClick={clearSearch}>
              ✕
            </SearchAffordance>
          ) : (
            <SearchAffordance as="span" aria-hidden title="Press / to search">
              /
            </SearchAffordance>
          )}
        </SearchWrap>

        <Segmented
          label="Layout"
          value={view}
          onChange={(next) => {
            setViewPref(next)
            go({ view: next })
          }}
          options={[
            { value: 'grid', label: '⧉ Grid', title: 'Art grid' },
            { value: 'list', label: '☰ List', title: 'List with a reading pane' }
          ]}
        />

        <Field>
          Sort
          <Select
            aria-label="Sort"
            value={sort}
            onChange={(e) => go({ sort: e.target.value as LibrarySort })}
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>

        {kind === 'cards' ? (
          <>
            <FilterSelect name="Type" value={search.type} options={options.type} onChange={(v) => go({ type: v })} />
            <FilterSelect name="Rarity" value={search.rarity} options={options.rarity} onChange={(v) => go({ rarity: v })} />
            <FilterSelect name="Keyword" value={search.keyword} options={options.keyword} onChange={(v) => go({ keyword: v })} />
            <FilterSelect name="Colour" value={search.color} options={options.color} onChange={(v) => go({ color: v })} />
          </>
        ) : (
          <>
            <FilterSelect name="Rarity" value={search.rarity} options={options.rarity} onChange={(v) => go({ rarity: v })} />
            <FilterSelect name="Pool" value={search.pool} options={options.pool} onChange={(v) => go({ pool: v })} />
          </>
        )}
        <Spacer />
      </Toolbar>

      {error ? <ErrorState message={error} onRetry={retry} /> : null}
      {!error && metrics.error && entries.length ? (
        <ErrorState
          title="Community metrics unavailable"
          message={`${metrics.error} — the catalog below is complete, but scores and tiers are missing.`}
          onRetry={metrics.refresh}
        />
      ) : null}

      {loading && !entries.length ? (
        <>
          <Loading label={`Fetching the ${kind} compendium…`} />
          {view === 'grid' ? <GridSkeleton kind={kind} /> : <ListSkeleton />}
        </>
      ) : null}

      {/* A count of nothing and an italic "No matches." under an error panel
          would be three ways of saying the same failure. */}
      {!error && (!loading || entries.length) ? (
        <>
          <ResultCount aria-live="polite">
            {shown.length === entries.length
              ? `${fmtInt(entries.length)} ${kind}`
              : `${fmtInt(shown.length)} of ${fmtInt(entries.length)} ${kind}`}
          </ResultCount>

          {!shown.length && !loading ? (
            <Empty>No matches.</Empty>
          ) : view === 'grid' ? (
            <GridMode entries={shown} kind={kind} onOpen={openEntry} />
          ) : (
            <ListMode
              entries={shown}
              kind={kind}
              detailId={detailId}
              onOpen={openEntry}
              onClose={closeDetail}
            />
          )}
        </>
      ) : null}

      {view === 'grid' && detailId ? (
        <DetailModal kind={kind} id={detailId} onClose={closeDetail} />
      ) : null}
    </>
  )
}

// ── grid ────────────────────────────────────────────────────────────────────

function GridMode({
  entries,
  kind,
  onOpen
}: {
  entries: LibraryEntry[]
  kind: CodexKind
  onOpen: (id: string) => void
}): JSX.Element {
  const isCards = kind === 'cards'
  return (
    <Grid $cards={isCards}>
      {entries.map((entry) => (
        <Tile
          key={entry.id}
          type="button"
          $cards={isCards}
          onClick={() => onOpen(entry.id)}
          onMouseEnter={() => prefetchArt(entry.art)}
          onFocus={() => prefetchArt(entry.art)}
          title={entry.name}
        >
          {isCards ? (
            <CardArt>{entry.art ? <Art src={entry.art} alt={entry.name} /> : null}</CardArt>
          ) : (
            <SpriteArt>{entry.art ? <Art src={entry.art} alt="" /> : null}</SpriteArt>
          )}
          {entry.tier ? (
            <TierCorner>
              <TierBadge $tier={entry.tier}>{entry.tier}</TierBadge>
            </TierCorner>
          ) : null}
          {isCards ? <SrOnly>{entry.name}</SrOnly> : <TileName $tone={toneFor(entry)}>{entry.name}</TileName>}
        </Tile>
      ))}
    </Grid>
  )
}

/** Rarity tint for a sprite tile's caption — the one flash of colour it gets. */
function toneFor(entry: LibraryEntry): string | undefined {
  if (entry.kind === 'cards') return undefined
  const key = entry.item.rarity_key ?? entry.item.rarity ?? undefined
  return key ? rarityColors(key).light : undefined
}

// ── list ────────────────────────────────────────────────────────────────────

function ListMode({
  entries,
  kind,
  detailId,
  onOpen,
  onClose
}: {
  entries: LibraryEntry[]
  kind: CodexKind
  detailId?: string
  onOpen: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null)

  /**
   * Roving focus: ↓/↑ move between rows, Enter opens the focused one. Moving
   * focus rather than a separate "selection" means the browser scrolls the row
   * into view for us and a screen reader announces each one on arrival — two
   * behaviours that are fiddly to reimplement and easy to get subtly wrong.
   */
  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = list.current?.querySelectorAll<HTMLButtonElement>('[data-row]')
    if (!rows?.length) return
    e.preventDefault()
    const current = document.activeElement
    let at = -1
    rows.forEach((r, i) => {
      if (r === current) at = i
    })
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1)
    rows[next]?.focus()
    rows[next]?.scrollIntoView({ block: 'nearest' })
  }, [])

  return (
    <Split>
      <ListColumn ref={list} role="listbox" aria-label={`${kind} list`} onKeyDown={onKeyDown} tabIndex={-1}>
        {entries.map((entry) => (
          <ListRow
            key={entry.id}
            data-row
            type="button"
            role="option"
            aria-selected={entry.id === detailId}
            $on={entry.id === detailId}
            onClick={() => onOpen(entry.id)}
            onMouseEnter={() => prefetchArt(entry.art)}
          >
            <RowThumb>{entry.thumb ? <Art src={entry.thumb} alt="" /> : null}</RowThumb>
            <RowText>
              <RowName>{entry.name}</RowName>
              <RowMeta>{metaLine(entry)}</RowMeta>
            </RowText>
            <TierBadge $tier={entry.tier}>{entry.tier ?? DASH}</TierBadge>
          </ListRow>
        ))}
      </ListColumn>

      <PaneColumn>
        {detailId ? (
          <Pane>
            <Detail kind={kind} id={detailId} mode="pane" onClose={onClose} />
          </Pane>
        ) : (
          <PaneEmpty kind={kind} onOpen={onOpen} />
        )}
      </PaneColumn>
    </Split>
  )
}

/**
 * The reading pane before anything has been chosen.
 *
 * An instruction on its own would be a whole column of nothing saying "click a
 * thing". Offering what you were reading last time makes the same space useful
 * on the second visit, which is when a compendium is actually used — you come
 * back to the three cards you were weighing up, not to the alphabet.
 */
function PaneEmpty({ kind, onOpen }: { kind: CodexKind; onOpen: (id: string) => void }): JSX.Element {
  const recents = useRecents().filter((r) => r.kind === kind)
  return (
    <PaneEmptyWrap>
      <PanePrompt>Choose {kindNoun(kind) === 'card' ? 'a card' : `a ${kindNoun(kind)}`} to read it here.</PanePrompt>
      {recents.length ? (
        <>
          <RecentHead>Recently viewed</RecentHead>
          <Recents>
            {recents.map((r) => (
              <RecentChip key={r.id} type="button" onClick={() => onOpen(r.id)}>
                {r.art ? <Art src={r.art} alt="" /> : null}
                <span>{r.name}</span>
              </RecentChip>
            ))}
          </Recents>
        </>
      ) : null}
    </PaneEmptyWrap>
  )
}

/** The one-line summary under a name: what it is, not how good it is. */
function metaLine(entry: LibraryEntry): string {
  if (entry.kind === 'cards') {
    return [entry.item.type, entry.item.rarity, entry.item.color].filter(Boolean).join(' · ') || entry.id
  }
  return [entry.item.rarity, entry.item.pool].filter(Boolean).join(' · ') || entry.id
}

// ── filters ─────────────────────────────────────────────────────────────────

interface FilterOptions {
  type: string[]
  rarity: string[]
  keyword: string[]
  color: string[]
  pool: string[]
}

/**
 * Filter menus built from the data actually loaded, not from a hard-coded list.
 *
 * A menu that offers "Ancient" when the catalog has no ancients is a menu that
 * can produce an empty screen for no reason, and a hard-coded list silently
 * stops offering whatever the game adds next.
 */
function filterOptions(entries: LibraryEntry[]): FilterOptions {
  const type = new Set<string>()
  const rarity = new Set<string>()
  const keyword = new Set<string>()
  const color = new Set<string>()
  const pool = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'cards') {
      const card = entry.item
      if (card.type) type.add(card.type)
      if (card.rarity) rarity.add(card.rarity)
      if (card.color) color.add(card.color)
      for (const k of card.keywords ?? []) if (k) keyword.add(k)
    } else {
      if (entry.item.rarity_key) rarity.add(entry.item.rarity_key)
      if (entry.item.pool) pool.add(entry.item.pool)
    }
  }
  const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => a.localeCompare(b))
  return {
    type: sorted(type),
    rarity: sorted(rarity),
    keyword: sorted(keyword),
    color: sorted(color),
    pool: sorted(pool)
  }
}

function eq(a: string | null | undefined, b: string | undefined): boolean {
  return Boolean(b) && Boolean(a) && a!.toLowerCase() === b!.toLowerCase()
}

function applyFilters(entries: LibraryEntry[], search: FullBrowseSearch): LibraryEntry[] {
  const { type, rarity, keyword, color, pool } = search
  if (!type && !rarity && !keyword && !color && !pool) return entries
  return entries.filter((entry) => {
    if (entry.kind === 'cards') {
      const card = entry.item
      if (type && !eq(card.type, type)) return false
      if (rarity && !eq(card.rarity, rarity)) return false
      if (color && !eq(card.color, color)) return false
      if (keyword && !hasKeyword(card, keyword)) return false
      return true
    }
    if (rarity && !eq(entry.item.rarity_key, rarity)) return false
    if (pool && !eq(entry.item.pool, pool)) return false
    return true
  })
}

function hasKeyword(card: CodexCard, keyword: string): boolean {
  const wanted = keyword.toLowerCase()
  return (card.keywords ?? []).some((k) => k?.toLowerCase() === wanted)
}

function FilterSelect({
  name,
  value,
  options,
  onChange
}: {
  name: string
  value: string | undefined
  options: string[]
  onChange: (next: string | undefined) => void
}): JSX.Element | null {
  if (options.length < 2) return null
  return (
    <Field>
      {name}
      <Select
        aria-label={name}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </Field>
  )
}

// ── sorting ─────────────────────────────────────────────────────────────────

/**
 * `keepRelevance` is the "someone is typing" case: with a query active and no
 * explicit sort chosen, the ranked order *is* the right order, and re-sorting
 * it by compendium number would bury the exact-name match under everything that
 * merely mentions it.
 */
function sortEntries(entries: LibraryEntry[], sort: LibrarySort, keepRelevance: boolean): LibraryEntry[] {
  if (keepRelevance) return entries
  const byName = (a: LibraryEntry, b: LibraryEntry): number => a.name.localeCompare(b.name)
  const out = entries.slice()
  switch (sort) {
    case 'name':
      return out.sort(byName)
    case 'name-desc':
      return out.sort((a, b) => byName(b, a))
    case 'score':
      return out.sort((a, b) => compareNullable(a.score, b.score, 'desc') || byName(a, b))
    case 'elo':
      return out.sort((a, b) => compareNullable(a.elo, b.elo, 'desc') || byName(a, b))
    case 'winrate':
      return out.sort((a, b) => compareNullable(a.winRate, b.winRate, 'desc') || byName(a, b))
    case 'order':
    default:
      return out.sort(
        (a, b) => compareNullable(a.compendiumOrder, b.compendiumOrder, 'asc') || byName(a, b)
      )
  }
}

// ── skeletons ───────────────────────────────────────────────────────────────

function GridSkeleton({ kind }: { kind: CodexKind }): JSX.Element {
  const cards = kind === 'cards'
  return (
    <Grid $cards={cards} aria-hidden>
      {Array.from({ length: cards ? 12 : 18 }, (_, i) => (
        <Skeleton key={i} style={{ aspectRatio: cards ? '400 / 520' : '1' }} />
      ))}
    </Grid>
  )
}

function ListSkeleton(): JSX.Element {
  return (
    <Split aria-hidden>
      <ListColumn>
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} style={{ height: 46 }} />
        ))}
      </ListColumn>
      <PaneColumn>
        <Skeleton style={{ height: 320 }} />
      </PaneColumn>
    </Split>
  )
}

// ── styling ─────────────────────────────────────────────────────────────────

const Grid = styled.div<{ $cards: boolean }>`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(${(p) => (p.$cards ? '190px' : '116px')}, 1fr));
  gap: ${(p) => (p.$cards ? '14px' : '10px')};
  padding-bottom: 10px;
`

/**
 * `content-visibility: auto` lets the browser skip laying out and painting the
 * ~500 tiles that are off screen; `contain-intrinsic-size` tells it how much
 * room to leave for each so the scrollbar stays honest while they are skipped.
 * Together they are the difference between a smooth 577-card grid and one that
 * stutters on every wheel tick — without a virtualiser to keep in sync.
 */
const Tile = styled.button<{ $cards: boolean }>`
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: ${(p) => (p.$cards ? '0' : '8px 6px 9px')};
  cursor: pointer;
  border: 0;
  background: none;
  font-family: inherit;
  color: var(--ink-dim);
  content-visibility: auto;
  contain-intrinsic-size: auto ${(p) => (p.$cards ? '260px' : '150px')};
  transition:
    transform 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    filter 0.15s ease;

  &:hover {
    transform: scale(1.03);
    filter: drop-shadow(4px 5px 6px oklch(0 0 0 / 45%));
    color: var(--ink);
    z-index: 1;
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 3px;
    border-radius: 8px;
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
    &:hover {
      transform: none;
    }
  }
`

const CardArt = styled.div`
  width: 100%;
  aspect-ratio: 400 / 520;
  display: flex;
  align-items: center;
  justify-content: center;
`

const SpriteArt = styled(ArtPlate)`
  width: 100%;
  aspect-ratio: 1;
  padding: 12px;
`

const TierCorner = styled.span`
  position: absolute;
  top: 5px;
  right: 5px;
  pointer-events: none;
`

const TileName = styled.span<{ $tone?: string }>`
  font-size: 11px;
  line-height: 1.3;
  text-align: center;
  color: ${(p) => p.$tone ?? 'inherit'};
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
`

/** The card grid's names live in the art; screen readers still need them. */
const SrOnly = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

const Split = styled.div`
  display: grid;
  grid-template-columns: minmax(220px, 280px) 1fr;
  gap: 16px;
  align-items: start;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
`

const ListColumn = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: calc(100vh - 190px);
  overflow-y: auto;
  padding-right: 4px;
  ${scrollbar}
  /* The column is a listbox with roving focus on its rows; a ring around the
     whole 400px of it would say the container was selected. */
  &:focus {
    outline: none;
  }

  @media (max-width: 720px) {
    max-height: 320px;
  }
`

const ListRow = styled.button<{ $on: boolean }>`
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
  border-radius: 8px;
  border: 1px solid ${(p) => (p.$on ? 'var(--line-strong)' : 'transparent')};
  background: ${(p) => (p.$on ? 'var(--fill-hover)' : 'transparent')};
  font-family: inherit;
  color: var(--ink);
  &:hover {
    background: var(--fill);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -1px;
  }
`

const RowThumb = styled.span`
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
`

const RowText = styled.span`
  flex: 1;
  min-width: 0;
`

const RowName = styled.span`
  display: block;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const RowMeta = styled.span`
  display: block;
  font-size: 11px;
  color: var(--ink-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const PaneColumn = styled.div`
  min-width: 0;
`

const Pane = styled.div`
  position: sticky;
  top: 4px;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 190px);
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(38, 35, 33, 0.55);
  overflow: hidden;
`

const PaneEmptyWrap = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 8px;
`

const PanePrompt = styled.p`
  margin: 16px 0;
  text-align: center;
  font-size: 13px;
  font-style: italic;
  color: var(--ink-faint);
`

const RecentHead = styled.div`
  margin-top: 10px;
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--ink-faint);
`

const Recents = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 8px;
  max-width: 420px;
`

const RecentChip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  padding: 3px 10px 3px 4px;
  cursor: pointer;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--ink-dim);
  font-family: inherit;
  font-size: 11px;
  img {
    width: 20px;
    height: 20px;
    object-fit: contain;
  }
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  &:hover {
    background: var(--fill-hover);
    color: var(--ink);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`
