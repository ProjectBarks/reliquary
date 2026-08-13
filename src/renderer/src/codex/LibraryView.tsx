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
import type { CodexKind } from '@shared/codex'
import { rarityColors } from '../overlays/sts2/theme'
import { prefetchArt, useLibraryEntries, type LibraryEntry } from './data'
import { DASH, compareNullable, fmtInt } from './format'
import {
  DEFAULT_LIBRARY_SORT,
  DEFAULT_TABLE_COLUMN,
  defaultTableDir,
  kindNoun,
  useBrowseSearch,
  useCodexScope,
  type FullBrowseSearch,
  type LibrarySort,
  type SortDir,
  type TableColumn,
  type Variant
} from './params'
import {
  Art,
  ArtPlate,
  Empty,
  ErrorState,
  FilterIcon,
  GridIcon,
  IconSegmented,
  ListIcon,
  Loading,
  OptionChip,
  Popover,
  PopoverGroup,
  PopoverNote,
  QuietLink,
  ResultCount,
  SearchAffordance,
  SearchIcon,
  SearchInput,
  SearchWrap,
  Skeleton,
  SortIcon,
  Spacer,
  TableIcon,
  TierIcon,
  Toolbar,
  scrollbar
} from './parts'
import { getModePref, setModePref, useRecents, type CodexMode } from './prefs'
import { rankItems } from './search'
import { TierBadge } from './tiers'
import { Detail, DetailModal } from './Detail'
import { TierListView, TierSkeleton } from './TierListView'
import { MetricsTableView } from './MetricsTableView'
import { useArtPreview } from './ArtPreview'

/**
 * One kind of thing, four ways of looking at it.
 *
 * Grid and list are for recognising and reading — card art is how anyone who
 * plays this game actually identifies a card, and the list puts the details
 * beside the set. Tier and table are the same catalog read as a population:
 * what the community's runs say, at a glance and in full. They used to live in
 * a separate "Meta" section with its own kind switcher, which meant two
 * controls for "which kind am I looking at" and one mental model split across
 * two places. They are modes now.
 *
 * That merge is what makes the toolbar work. One search box, one filter set and
 * one cohort feed all four modes, so narrowing to Rare Powers and then flipping
 * to the tier list narrows the tier list — instead of throwing the question
 * away at the boundary between two screens.
 *
 * Everything that decides what is on screen lives in the URL. The one exception
 * is the text in the search box, which is mirrored locally and debounced into
 * the URL — typing "strike" should not put six entries in the back button.
 */

const SEARCH_DEBOUNCE_MS = 175

const MODE_OPTIONS = [
  { value: 'grid' as const, icon: <GridIcon />, label: 'Art grid' },
  { value: 'list' as const, icon: <ListIcon />, label: 'List with a reading pane' },
  { value: 'tier' as const, icon: <TierIcon />, label: 'Tier list' },
  { value: 'table' as const, icon: <TableIcon />, label: 'Metrics table' }
]

export function LibraryView({ kind, detailId }: { kind: CodexKind; detailId?: string }): JSX.Element {
  const scope = useCodexScope()
  const search = useBrowseSearch()
  const navigate = useNavigate()
  const { entries, loading, error, retry, metrics, index, table } = useLibraryEntries(
    kind,
    scope.bracket,
    scope.character
  )

  const mode: CodexMode = search.mode ?? getModePref()
  const sort: LibrarySort = search.sort ?? DEFAULT_LIBRARY_SORT
  const variant: Variant = search.variant ?? 'base'
  const col: TableColumn = search.col ?? DEFAULT_TABLE_COLUMN
  const dir: SortDir = search.dir ?? defaultTableDir(col)

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

  /**
   * Which rows the table could possibly show, for the purpose of counting
   * filter options.
   *
   * This is the fix for the complaint that started it: Curse, Event, Quest,
   * Status and Token were offered as colours on a table that has no metric
   * rows for any of them, so choosing one emptied the screen. A filter option
   * is only real if something would survive it, and in table mode "something"
   * means a metrics row of the current variant.
   */
  const eligible = useMemo(() => {
    if (mode !== 'table') return null
    return (entry: LibraryEntry): boolean =>
      variant === 'upgraded'
        ? index.upgraded.has(entry.id)
        : variant === 'base'
          ? index.base.has(entry.id)
          : index.base.has(entry.id) || index.upgraded.has(entry.id)
  }, [mode, variant, index])

  const searched = useMemo(() => rankItems(entries, search.q ?? ''), [entries, search.q])
  const groups = useMemo(
    () => facetGroups(eligible ? searched.filter(eligible) : searched, search, kind),
    [searched, search, kind, eligible]
  )

  const filtered = useMemo(() => searched.filter((e) => matches(e, search, kind)), [searched, search, kind])
  const shown = useMemo(
    () => sortEntries(filtered, sort, Boolean(search.q) && sort === DEFAULT_LIBRARY_SORT),
    [filtered, sort, search.q]
  )

  const activeFilters = useMemo(() => filterKeys(kind).filter((k) => search[k]), [kind, search])
  const filtersActive = activeFilters.length > 0 || Boolean(search.q)

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

  // Tier and table read the metrics, not the catalog: showing an "Unrated"
  // list of 577 entries while the table is still in flight would be a screen
  // that is wrong rather than one that is waiting.
  const metaMode = mode === 'tier' || mode === 'table'
  const waiting = loading || (metaMode && !table && metrics.loading)
  const blank = !entries.length || (metaMode && !table)

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

        <Spacer />

        <IconSegmented
          label="View mode"
          value={mode}
          onChange={(next) => {
            setModePref(next)
            // The ring belongs to the arrival, not to the kind: carrying a
            // highlight from the tier list into the grid would leave a mark
            // nobody asked for on a screen that has no way to explain it.
            go({ mode: next, highlight: undefined })
          }}
          options={MODE_OPTIONS}
        />

        {/* Tier order is fixed by score and the table sorts from its own
            headers, so a sort control in those modes would be a second, quieter
            authority over an order it does not own. */}
        {mode === 'grid' || mode === 'list' ? (
          <Popover
            label="Sort"
            title={`Sort — ${sortOptions.find((o) => o.value === sort)?.label ?? 'Compendium order'}`}
            icon={<SortIcon />}
            badge={sort !== DEFAULT_LIBRARY_SORT}
            width={236}
          >
            {(close) => (
              <PopoverGroup name="Sort by">
                {sortOptions.map((o) => (
                  <OptionChip
                    key={o.value}
                    on={sort === o.value}
                    onSelect={() => {
                      go({ sort: o.value === DEFAULT_LIBRARY_SORT ? undefined : o.value })
                      close()
                    }}
                  >
                    {o.label}
                  </OptionChip>
                ))}
              </PopoverGroup>
            )}
          </Popover>
        ) : null}

        <Popover
          label="Filter"
          title={activeFilters.length ? `Filter — ${activeFilters.length} applied` : 'Filter'}
          icon={<FilterIcon />}
          badge={activeFilters.length}
          width={292}
        >
          {() => (
            <FilterPanel
              groups={groups}
              search={search}
              hasData={Boolean(entries.length) && (mode !== 'table' || Boolean(table))}
              clearable={activeFilters.length > 0}
              onPick={(key, value) => go({ [key]: value } as Partial<FullBrowseSearch>)}
              onClear={() =>
                go({ type: undefined, rarity: undefined, keyword: undefined, color: undefined, pool: undefined })
              }
            />
          )}
        </Popover>
      </Toolbar>

      {error ? <ErrorState message={error} onRetry={retry} /> : null}
      {!error && metrics.error && entries.length ? (
        <ErrorState
          title="Community metrics unavailable"
          message={`${metrics.error} — the catalog below is complete, but scores and tiers are missing.`}
          onRetry={metrics.refresh}
        />
      ) : null}

      {waiting && blank ? (
        <>
          <Loading label={loadingLabel(mode, kind)} />
          {mode === 'grid' ? (
            <GridSkeleton kind={kind} />
          ) : mode === 'list' ? (
            <ListSkeleton />
          ) : mode === 'tier' ? (
            <TierSkeleton />
          ) : (
            <Skeleton style={{ height: 360 }} />
          )}
        </>
      ) : null}

      {/* A count of nothing and an italic "No matches." under an error panel
          would be three ways of saying the same failure. */}
      {!error && (!waiting || !blank) ? (
        mode === 'table' ? (
          <MetricsTableView
            kind={kind}
            entries={filtered}
            filtersActive={filtersActive}
            table={table}
            bracket={scope.bracket}
            character={scope.character}
            variant={variant}
            col={col}
            dir={dir}
            onChange={(patch) => go(patch)}
            onOpen={openEntry}
          />
        ) : (
          <>
            <ResultCount aria-live="polite">
              {shown.length === entries.length
                ? `${fmtInt(entries.length)} ${kind}`
                : `${fmtInt(shown.length)} of ${fmtInt(entries.length)} ${kind}`}
            </ResultCount>

            {!shown.length && !waiting ? (
              <Empty>No matches.</Empty>
            ) : mode === 'tier' ? (
              <TierListView
                kind={kind}
                entries={shown}
                highlight={search.highlight}
                onOpen={openEntry}
              />
            ) : mode === 'grid' ? (
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
        )
      ) : null}

      {/* The list gives the detail a column of its own; every other mode is a
          full-width surface with nowhere to put one, so it arrives as a modal. */}
      {mode !== 'list' && detailId ? (
        <DetailModal kind={kind} id={detailId} onClose={closeDetail} />
      ) : null}
    </>
  )
}

function loadingLabel(mode: CodexMode, kind: CodexKind): string {
  if (mode === 'tier') return 'Building the tier list…'
  if (mode === 'table') return 'Fetching the metrics table…'
  return `Fetching the ${kind} compendium…`
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
  const preview = useArtPreview()
  const isCards = kind === 'cards'

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
            {...preview.bind(entry.art, entry.name)}
          >
            {/* Cards get the framed render the grid and the tier list use. A
                square crop of the art is not how anyone recognises a card, and
                44px of frame reads at a glance where 26px of crop does not. */}
            <RowThumb $card={isCards}>
              {isCards ? (
                entry.art ? (
                  <Art src={entry.art} alt="" />
                ) : null
              ) : entry.thumb ? (
                <Art src={entry.thumb} alt="" />
              ) : null}
            </RowThumb>
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

      {preview.preview}
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

type FilterKey = 'type' | 'rarity' | 'keyword' | 'color' | 'pool'

const FILTER_NAMES: Record<FilterKey, string> = {
  type: 'Type',
  rarity: 'Rarity',
  keyword: 'Keyword',
  color: 'Colour',
  pool: 'Pool'
}

/** Which questions are worth asking about a kind. Cards have colours; relics have pools. */
function filterKeys(kind: CodexKind): FilterKey[] {
  return kind === 'cards' ? ['type', 'rarity', 'keyword', 'color'] : ['rarity', 'pool']
}

/**
 * What one entry answers for one filter — a list, because keywords are many
 * and everything else is one or none.
 */
function valuesFor(entry: LibraryEntry, key: FilterKey): string[] {
  if (entry.kind === 'cards') {
    const card = entry.item
    switch (key) {
      case 'type':
        return card.type ? [card.type] : []
      case 'rarity':
        return card.rarity ? [card.rarity] : []
      case 'color':
        return card.color ? [card.color] : []
      case 'keyword':
        return (card.keywords ?? []).filter((k): k is string => Boolean(k))
      default:
        return []
    }
  }
  if (key === 'rarity') return entry.item.rarity_key ? [entry.item.rarity_key] : []
  if (key === 'pool') return entry.item.pool ? [entry.item.pool] : []
  return []
}

function eq(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.toLowerCase() === b!.toLowerCase()
}

/**
 * Does this entry survive the filters — optionally ignoring one of them?
 *
 * The `skip` is what makes the option counts honest. Counting "Rare" against a
 * set that already has the Rare filter applied would tell you that Rare has
 * results and every other rarity has none, which is true and useless. Each
 * group is counted against the others, so what you see is what choosing it
 * would give you.
 */
function matches(
  entry: LibraryEntry,
  search: FullBrowseSearch,
  kind: CodexKind,
  skip?: FilterKey
): boolean {
  for (const key of filterKeys(kind)) {
    if (key === skip) continue
    const want = search[key]
    if (!want) continue
    if (!valuesFor(entry, key).some((v) => eq(v, want))) return false
  }
  return true
}

interface FacetGroup {
  key: FilterKey
  name: string
  values: string[]
}

/**
 * The filter menus, built from the data that is actually loaded — and only the
 * options that would leave something on screen.
 *
 * A dead chip is clutter, so a zero-count option is not rendered at all rather
 * than rendered greyed out; and until the catalog arrives there is nothing to
 * count, so the panel says so instead of flashing a row of chips that are about
 * to vanish. The one option that survives a zero count is the one currently
 * applied: hiding that would leave a filter narrowing the screen with no
 * control anywhere to turn it off.
 */
function facetGroups(pool: LibraryEntry[], search: FullBrowseSearch, kind: CodexKind): FacetGroup[] {
  const out: FacetGroup[] = []
  for (const key of filterKeys(kind)) {
    const counts = new Set<string>()
    for (const entry of pool) {
      if (!matches(entry, search, kind, key)) continue
      for (const value of valuesFor(entry, key)) counts.add(value)
    }
    const active = search[key]
    if (active && ![...counts].some((v) => eq(v, active))) counts.add(active)
    // One option plus "Any" is a question with a single answer.
    if (counts.size < 2) continue
    out.push({ key, name: FILTER_NAMES[key], values: [...counts].sort((a, b) => a.localeCompare(b)) })
  }
  return out
}

function FilterPanel({
  groups,
  search,
  hasData,
  clearable,
  onPick,
  onClear
}: {
  groups: FacetGroup[]
  search: FullBrowseSearch
  hasData: boolean
  clearable: boolean
  onPick: (key: FilterKey, value: string | undefined) => void
  onClear: () => void
}): JSX.Element {
  if (!hasData) return <PopoverNote>Waiting for the compendium…</PopoverNote>
  if (!groups.length) return <PopoverNote>Nothing left to narrow here.</PopoverNote>
  return (
    <>
      {groups.map((group) => (
        <PopoverGroup key={group.key} name={group.name}>
          <OptionChip on={!search[group.key]} onSelect={() => onPick(group.key, undefined)}>
            Any
          </OptionChip>
          {group.values.map((value) => (
            <OptionChip
              key={value}
              caps
              on={eq(value, search[group.key])}
              tone={group.key === 'color' ? `var(--sts-${value.toLowerCase()}-primary, var(--ink-dim))` : undefined}
              onSelect={() => onPick(group.key, value)}
            >
              {value}
            </OptionChip>
          ))}
        </PopoverGroup>
      ))}
      {clearable ? (
        <ClearRow>
          <QuietLink type="button" onClick={onClear}>
            Clear filters
          </QuietLink>
        </ClearRow>
      ) : null}
    </>
  )
}

const ClearRow = styled.div`
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
`

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
  grid-template-columns: minmax(240px, 300px) 1fr;
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
  padding: 5px 8px;
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

/**
 * The aspect ratio is declared rather than left to the image, so a row is its
 * final height before any art has loaded and the column does not shuffle under
 * the cursor as the CDN answers.
 */
const RowThumb = styled.span<{ $card: boolean }>`
  width: ${(p) => (p.$card ? '44px' : '26px')};
  aspect-ratio: ${(p) => (p.$card ? '400 / 520' : '1')};
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
