import { useCallback, useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import styled from 'styled-components'
import type { CodexKind, MetricsRow } from '@shared/codex'
import { useLibraryEntries, type LibraryEntry } from './data'
import { DASH, compareNullable, fmtElo, fmtInt, fmtPct, fmtScore, prettifyId } from './format'
import {
  useCodexScope,
  useTableSearch,
  type SortDir,
  type TableColumn,
  type Variant
} from './params'
import { Empty, ErrorState, Loading, Segmented, Skeleton } from './parts'
import { TierBadge } from './tiers'
import { useArtPreview } from './ArtPreview'

/**
 * Every number, for every entry, sortable.
 *
 * The tier list is the answer; this is the working. It exists so that a grade
 * is never something the app just asserts — you can sort by elo, see that a
 * card is drafted far above its win rate, and decide for yourself. Which is
 * also why the definitions are written out under the table instead of living in
 * an about box: a column called "Elo" that nobody explains is a column that
 * gets misread.
 *
 * The null columns are the honest part. In the current snapshot `elo` is
 * populated only for bracket-level card tables (and null for 26 rows even
 * there), `pick_rate` is null everywhere, and every `pick_rate_by_act` entry is
 * null. Those cells render `·`, the sorts sink them, and nothing anywhere
 * substitutes a zero.
 */

interface Row {
  id: string
  upgraded: boolean
  name: string
  color: string | null
  art: string | null
  tier: string | null
  score: number | null
  elo: number | null
  win: number | null
  pick: number | null
  seen: number | null
  runs: number | null
  wins: number | null
  losses: number | null
  acts: Array<number | null>
}

const COLUMN_HELP: Record<TableColumn | 'rank' | 'wl', string> = {
  rank: 'Position in the current sort',
  name: 'Name in the compendium; a trailing + is the upgraded version',
  tier: 'Letter grade from the Codex Score: S ≥90, A ≥78, B ≥65, C ≥50, D ≥35, else F',
  score: 'Codex Score (0–100, Bayesian-shrunk win rate) — a small sample is pulled toward the average rather than trusted',
  elo: 'Revealed preference from card-reward picks: what players choose when given the choice. Only measured where reward picks happen',
  win: 'Percentage of runs containing this that were won — read it against the baseline win rate above',
  pick: 'Percentage of the times it was offered that it was taken',
  seen: 'How many times it was offered',
  runs: 'How many runs it appeared in — the sample behind every other number in the row',
  a1: 'Pick rate in Act 1',
  a2: 'Pick rate in Act 2',
  a3: 'Pick rate in Act 3',
  wl: 'Wins and losses among runs containing this'
}

export function MetricsTableView(): JSX.Element {
  const search = useTableSearch()
  const kind: CodexKind = search.kind ?? 'cards'
  const scope = useCodexScope()
  const { entries, metrics, index, loading, error, retry } = useLibraryEntries(
    kind,
    scope.bracket,
    scope.character
  )
  const navigate = useNavigate()
  const preview = useArtPreview()

  const variant: Variant = search.variant ?? 'base'
  const sort: TableColumn = search.sort ?? 'score'
  const dir: SortDir = search.dir ?? defaultDir(sort)

  const go = useCallback(
    (patch: Partial<typeof search>) => {
      navigate({ to: '/codex/meta/table', search: { ...search, ...patch }, replace: true })
    },
    [navigate, search]
  )

  const byId = useMemo(() => {
    const map = new Map<string, LibraryEntry>()
    for (const entry of entries) map.set(entry.id, entry)
    return map
  }, [entries])

  const colors = useMemo(() => colorOptions(entries), [entries])

  const rows = useMemo(() => {
    const source = metrics.data?.rows ?? []
    const wanted = source.filter((r) =>
      variant === 'both' ? true : variant === 'upgraded' ? r.upgraded : !r.upgraded
    )
    return wanted.map((r) => toRow(r, byId.get(r.id) ?? null))
  }, [metrics.data, variant, byId])

  const filtered = useMemo(() => {
    if (!search.color) return rows
    const wanted = search.color.toLowerCase()
    return rows.filter((r) => (r.color ?? '').toLowerCase() === wanted)
  }, [rows, search.color])

  const sorted = useMemo(() => sortRows(filtered, sort, dir), [filtered, sort, dir])

  const showElo = kind === 'cards' && index.hasElo
  const showActs = kind === 'cards'

  if (error && !entries.length && !metrics.data) return <ErrorState message={error} onRetry={retry} />
  if (metrics.error && !metrics.data) return <ErrorState message={metrics.error} onRetry={metrics.refresh} />
  if (loading && !sorted.length) {
    return (
      <>
        <Loading label="Fetching the metrics table…" />
        <Skeleton style={{ height: 360 }} />
      </>
    )
  }

  const header = (column: TableColumn, label: string, numeric: boolean): JSX.Element => (
    <Th
      $numeric={numeric}
      $on={sort === column}
      aria-sort={sort === column ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <ThButton
        type="button"
        $numeric={numeric}
        title={COLUMN_HELP[column]}
        onClick={() =>
          go(
            sort === column
              ? { dir: dir === 'asc' ? 'desc' : 'asc' }
              : { sort: column, dir: defaultDir(column) }
          )
        }
      >
        {label}
        <Arrow aria-hidden>{sort === column ? (dir === 'asc' ? '▴' : '▾') : ''}</Arrow>
      </ThButton>
    </Th>
  )

  return (
    <>
      <Controls>
        {kind === 'cards' ? (
          <Segmented
            label="Card version"
            value={variant}
            onChange={(v) => go({ variant: v })}
            options={[
              { value: 'base', label: 'Base' },
              { value: 'upgraded', label: 'Upgraded' },
              { value: 'both', label: 'Both' }
            ]}
          />
        ) : null}
        {kind === 'cards' && colors.length > 1 ? (
          <Pills role="group" aria-label="Colour">
            <Pill type="button" $on={!search.color} onClick={() => go({ color: undefined })}>
              All
            </Pill>
            {colors.map((c) => (
              <Pill
                key={c}
                type="button"
                $on={search.color === c}
                $tone={`var(--sts-${c}-primary, var(--ink-dim))`}
                onClick={() => go({ color: search.color === c ? undefined : c })}
              >
                {c}
              </Pill>
            ))}
          </Pills>
        ) : null}
      </Controls>

      {!sorted.length ? (
        <Empty>No matches.</Empty>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th $numeric $narrow title={COLUMN_HELP.rank}>
                  #
                </Th>
                {header('name', kind === 'cards' ? 'Card' : 'Name', false)}
                {header('tier', 'Tier', false)}
                {header('score', 'Score', true)}
                {showElo ? header('elo', 'Elo', true) : null}
                {header('win', 'Win%', true)}
                {header('pick', 'Pick%', true)}
                {header('seen', 'Seen', true)}
                {header('runs', 'Runs', true)}
                {showActs ? header('a1', 'A1', true) : null}
                {showActs ? header('a2', 'A2', true) : null}
                {showActs ? header('a3', 'A3', true) : null}
                <Th $numeric title={COLUMN_HELP.wl}>
                  W–L
                </Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <Tr
                  key={`${row.id}:${row.upgraded ? 'u' : 'b'}`}
                  tabIndex={0}
                  role="link"
                  title={`Open ${row.name}`}
                  onClick={() =>
                    navigate({
                      to: '/codex/browse/$kind/$id',
                      params: { kind, id: row.id },
                      search: {
                        bracket: scope.bracket,
                        ...(scope.character ? { character: scope.character } : {})
                      }
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    navigate({
                      to: '/codex/browse/$kind/$id',
                      params: { kind, id: row.id },
                      search: {
                        bracket: scope.bracket,
                        ...(scope.character ? { character: scope.character } : {})
                      }
                    })
                  }}
                  {...preview.bind(row.art, row.name)}
                >
                  <Td $numeric $faint>
                    {i + 1}
                  </Td>
                  <Td>
                    <NameCell style={row.color ? { color: `var(--sts-${row.color}-primary)` } : undefined}>
                      {row.name}
                      {row.upgraded ? '+' : ''}
                    </NameCell>
                  </Td>
                  <Td>
                    <TierBadge $tier={row.tier}>{row.tier ?? DASH}</TierBadge>
                  </Td>
                  <Num value={fmtScore(row.score)} />
                  {showElo ? <Num value={fmtElo(row.elo)} /> : null}
                  <Num value={fmtPct(row.win)} />
                  <Num value={fmtPct(row.pick)} />
                  <Num value={fmtInt(row.seen)} />
                  <Num value={fmtInt(row.runs)} />
                  {showActs ? <Num value={fmtPct(row.acts[0], 0)} /> : null}
                  {showActs ? <Num value={fmtPct(row.acts[1], 0)} /> : null}
                  {showActs ? <Num value={fmtPct(row.acts[2], 0)} /> : null}
                  <Num
                    value={
                      row.wins != null || row.losses != null
                        ? `${fmtInt(row.wins)}–${fmtInt(row.losses)}`
                        : DASH
                    }
                  />
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <Footnotes>
        <dt>Score</dt>
        <dd>
          Codex Score, 0–100: a win rate shrunk toward the cohort average in proportion to how
          little was seen, so a card taken forty times cannot outrank one taken forty thousand on
          luck alone.
        </dd>
        <dt>Elo</dt>
        <dd>
          Revealed preference, derived from what players pick out of card rewards. It measures
          reputation, not results — a gap between elo and score is the interesting part.
          {showElo ? null : ' Not measured in this slice, so the column is hidden rather than blank.'}
        </dd>
        <dt>Win% and W–L</dt>
        <dd>
          Runs containing the entry that ended in a win. Only meaningful against the baseline win
          rate in the line above the table — half of all cards sit near it by construction.
        </dd>
        <dt>Pick%, Seen, Runs</dt>
        <dd>
          How often it was offered, and how often it was taken. `·` means the snapshot does not
          record that number for this slice; it never means zero.
        </dd>
      </Footnotes>

      {preview.preview}
    </>
  )
}

// ── model ───────────────────────────────────────────────────────────────────

function toRow(row: MetricsRow, entry: LibraryEntry | null): Row {
  const card = entry?.kind === 'cards' ? entry.item : null
  return {
    id: row.id,
    upgraded: row.upgraded,
    name: entry?.name ?? prettifyId(row.id),
    color: card?.color ?? null,
    art: entry?.art ?? null,
    tier: row.tier,
    score: row.score,
    elo: row.elo,
    win: row.win_rate,
    pick: row.pick_rate,
    seen: row.offered,
    runs: row.picks,
    wins: row.wins,
    losses: row.losses,
    acts: row.pick_rate_by_act ?? [null, null, null]
  }
}

/** Which colours the loaded catalog actually contains, in a stable order. */
function colorOptions(entries: LibraryEntry[]): string[] {
  const set = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'cards') continue
    if (entry.item.color) set.add(entry.item.color.toLowerCase())
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

/** Numbers want their biggest value first; a name wants its alphabet first. */
function defaultDir(column: TableColumn): SortDir {
  return column === 'name' || column === 'tier' ? 'asc' : 'desc'
}

function sortRows(rows: Row[], column: TableColumn, dir: SortDir): Row[] {
  const out = rows.slice()
  const byName = (a: Row, b: Row): number => a.name.localeCompare(b.name) || Number(a.upgraded) - Number(b.upgraded)
  if (column === 'name') {
    return out.sort((a, b) => (dir === 'asc' ? byName(a, b) : byName(b, a)))
  }
  if (column === 'tier') {
    // Tier sorts by the score behind it, not by the letter: alphabetical would
    // put A above B above C purely by luck of the Latin alphabet and then
    // scatter the ungraded rows through the middle.
    return out.sort((a, b) => compareNullable(a.score, b.score, dir === 'asc' ? 'asc' : 'desc') || byName(a, b))
  }
  const pick = (r: Row): number | null => {
    switch (column) {
      case 'score':
        return r.score
      case 'elo':
        return r.elo
      case 'win':
        return r.win
      case 'pick':
        return r.pick
      case 'seen':
        return r.seen
      case 'runs':
        return r.runs
      case 'a1':
        return r.acts[0] ?? null
      case 'a2':
        return r.acts[1] ?? null
      case 'a3':
        return r.acts[2] ?? null
      default:
        return null
    }
  }
  return out.sort((a, b) => compareNullable(pick(a), pick(b), dir) || byName(a, b))
}

function Num({ value }: { value: string }): JSX.Element {
  return (
    <Td $numeric $faint={value === DASH}>
      {value}
    </Td>
  )
}

// ── styling ─────────────────────────────────────────────────────────────────

const Controls = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 14px;
  padding: 0 2px 12px;
`

const Pills = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const Pill = styled.button<{ $on: boolean; $tone?: string }>`
  cursor: pointer;
  padding: 3px 10px;
  border-radius: 999px;
  font-family: inherit;
  font-size: 11px;
  text-transform: capitalize;
  color: ${(p) => (p.$on ? '#1a1613' : (p.$tone ?? 'var(--ink-dim)'))};
  background: ${(p) => (p.$on ? (p.$tone ?? 'var(--brand)') : 'var(--fill)')};
  border: 1px solid ${(p) => (p.$on ? 'transparent' : 'var(--line)')};
  &:hover {
    background: ${(p) => (p.$on ? (p.$tone ?? 'var(--brand)') : 'var(--fill-hover)')};
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

/**
 * The table scrolls inside its own box rather than with the page.
 *
 * That is what makes `position: sticky` on the header actually work: a sticky
 * cell sticks to its nearest scrolling ancestor, and since this element has to
 * scroll horizontally anyway (thirteen columns will not fit a narrow window),
 * it is already that ancestor. Letting the page scroll instead would leave the
 * header stuck to a box that never moves — visually identical to not being
 * sticky at all, on a table 600 rows long.
 */
const TableWrap = styled.div`
  max-height: calc(100vh - 280px);
  min-height: 220px;
  overflow: auto;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(38, 35, 33, 0.55);
  &::-webkit-scrollbar {
    width: 9px;
    height: 8px;
  }
  &::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 16%);
    border-radius: 4px;
  }
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
`

const Th = styled.th<{ $numeric?: boolean; $on?: boolean; $narrow?: boolean }>`
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 0;
  width: ${(p) => (p.$narrow ? '44px' : 'auto')};
  text-align: ${(p) => (p.$numeric ? 'right' : 'left')};
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.3px;
  color: ${(p) => (p.$on ? 'var(--brand)' : 'var(--ink-dim)')};
  background: #221f1d;
  border-bottom: 1px solid var(--line-strong);
  white-space: nowrap;
  ${(p) => (p.$narrow ? 'padding: 8px 10px;' : '')}
`

const ThButton = styled.button<{ $numeric: boolean }>`
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: ${(p) => (p.$numeric ? 'flex-end' : 'flex-start')};
  gap: 3px;
  padding: 8px 10px;
  cursor: pointer;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  &:hover {
    color: var(--ink);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }
`

const Arrow = styled.span`
  width: 8px;
  font-size: 9px;
  line-height: 1;
`

const Tr = styled.tr`
  cursor: pointer;
  &:nth-child(even) {
    background: oklch(1 0 0 / 2%);
  }
  &:hover {
    background: var(--fill-hover);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }
`

const Td = styled.td<{ $numeric?: boolean; $faint?: boolean }>`
  padding: 6px 10px;
  text-align: ${(p) => (p.$numeric ? 'right' : 'left')};
  color: ${(p) => (p.$faint ? 'var(--ink-faint)' : 'var(--ink)')};
  border-top: 1px solid var(--line);
  white-space: nowrap;
`

const NameCell = styled.span`
  display: inline-block;
  max-width: 26ch;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
`

const Footnotes = styled.dl`
  margin: 18px 2px 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--ink-faint);
  dt {
    margin-top: 8px;
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.3px;
    color: var(--ink-dim);
  }
  dd {
    margin: 2px 0 0;
  }
`
