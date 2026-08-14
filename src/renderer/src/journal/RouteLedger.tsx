import styled from 'styled-components'
import { useEntities, type EntityLookup } from './art'
import type { DerivedRoute, RouteCard, RouteLine, RouteRoom } from './derive'
import { routeNoteText } from './derive'
import { ROOM_KIND_LABEL, ROOM_KIND_TONE } from './format'
import { Art, Flag, Note, Num, OutlineChip, TBox, Table, Whisper } from './parts'

/**
 * The Route Ledger: every room in the order it was entered.
 *
 * It is the report's spine, and the blend spec's binding rule governs it — **one
 * accent per row, maximum**. A pickup's name is gold; a flagged row's pickup
 * name goes back to ink so the red `F-01` chip is the only colour in the line.
 * Room-type chips are outlines in the type's own hue because a room type is
 * data, not emphasis; the census strip above the table is the only place those
 * hues carry weight.
 *
 * The same component draws the Current Run's "route so far" panel in `compact`
 * mode. That was a day-one requirement rather than a refactor: two tables that
 * are nearly the same table drift within a week, and the live one is the one
 * nobody screenshots before shipping.
 */

export function CensusStrip({ census }: { census: DerivedRoute['census'] }): JSX.Element {
  const cells = [
    { kind: 'fight' as const, n: census.fight },
    { kind: 'event' as const, n: census.event },
    { kind: 'shop' as const, n: census.shop },
    { kind: 'other' as const, n: census.other }
  ]
  const total = Math.max(1, census.total)
  return (
    <Census>
      {cells.map((cell) => (
        <CensusCell key={cell.kind}>
          <CensusTop>
            <OutlineChip $tone={ROOM_KIND_TONE[cell.kind]}>
              {ROOM_KIND_LABEL[cell.kind]}
            </OutlineChip>
            <CensusNum>{cell.n}</CensusNum>
          </CensusTop>
          <CensusBar $pct={(cell.n / total) * 100} $tone={ROOM_KIND_TONE[cell.kind]} />
        </CensusCell>
      ))}
    </Census>
  )
}

export function RouteLedger({
  route,
  outcomeWord,
  flags,
  compact = false,
  collapsedBefore = null
}: {
  route: Pick<DerivedRoute, 'lines' | 'totals' | 'empty'>
  /** The word the last row uses — DEFEATED, VICTORIOUS, ENDED. */
  outcomeWord: string
  /** Finding refs by room index, from the analysis when there is one. */
  flags?: Map<number, string>
  /** The live panel's denser variant: no flag column, no footer. */
  compact?: boolean
  /** "…R01–R18 collapsed" — the live panel's leading line. */
  collapsedBefore?: number | null
}): JSX.Element {
  const entities = useEntities()

  if (route.empty) {
    return (
      <Note>
        No rooms recorded yet — the ledger fills in as the run moves.
      </Note>
    )
  }

  const totals = route.totals

  return (
    <TBox>
      <RouteTable $compact={compact}>
        <colgroup>
          <col style={{ width: compact ? '13%' : '6%' }} />
          <col style={{ width: compact ? '20%' : '9%' }} />
          <col style={{ width: compact ? '34%' : '43%' }} />
          <col style={{ width: compact ? '33%' : '36%' }} />
          {compact ? null : <col style={{ width: '6%' }} />}
        </colgroup>
        {compact ? null : (
          <thead>
            <tr>
              <th>R#</th>
              <th>Type</th>
              <th>Entry</th>
              <th>Pickup</th>
              <th className="r">Flag</th>
            </tr>
          </thead>
        )}
        <tbody>
          {collapsedBefore ? (
            <tr>
              <Collapsed colSpan={4}>…R01–R{pad(collapsedBefore)} collapsed</Collapsed>
            </tr>
          ) : null}
          {route.lines.map((line) => (
            <Line
              key={line.key}
              line={line}
              entities={entities}
              outcomeWord={outcomeWord}
              flag={line.kind === 'room' ? (flags?.get(line.roomIndex) ?? null) : null}
              compact={compact}
            />
          ))}
        </tbody>
        {compact ? null : (
          <tfoot>
            <tr>
              <td colSpan={5}>
                {totals.rooms} rooms · {totals.taken} cards taken · {totals.skipped} skipped ·{' '}
                {totals.upgrades} upgrade{totals.upgrades === 1 ? '' : 's'} · {totals.removals}{' '}
                removal{totals.removals === 1 ? '' : 's'}
              </td>
            </tr>
          </tfoot>
        )}
      </RouteTable>
    </TBox>
  )
}

function Line({
  line,
  entities,
  outcomeWord,
  flag,
  compact
}: {
  line: RouteLine
  entities: EntityLookup
  outcomeWord: string
  flag: string | null
  compact: boolean
}): JSX.Element {
  const span = compact ? 4 : 5

  if (line.kind === 'act') {
    return (
      <ActRow>
        <td colSpan={span}>
          <b>ACT&nbsp;{line.act}</b>
          {line.note}
        </td>
      </ActRow>
    )
  }
  if (line.kind === 'gap') {
    return (
      <GapRow>
        <td colSpan={span}>
          <b>GAP</b>
          {line.note}
        </td>
      </GapRow>
    )
  }
  return (
    <RoomRow $end={line.end}>
      <td className="r" title={line.floor === null ? undefined : `floor ${line.floor}`}>
        R{pad(line.roomIndex)}
      </td>
      <td>
        <OutlineChip $tone={ROOM_KIND_TONE[line.room]}>{ROOM_KIND_LABEL[line.room]}</OutlineChip>
      </td>
      <td className={line.notes.length ? 'entry' : 'entry dim'}>
        {line.notes.length ? (
          line.end ? (
            <b>{noteWords(line, entities, outcomeWord)}</b>
          ) : (
            noteWords(line, entities, outcomeWord)
          )
        ) : (
          '—'
        )}
      </td>
      <td className={line.pickup || line.passed.length ? '' : 'dim'}>
        <Pickup room={line} entities={entities} flagged={flag !== null} />
      </td>
      {compact ? null : <td className="r">{flag ? <Flag>{flag}</Flag> : null}</td>}
    </RoomRow>
  )
}

function noteWords(room: RouteRoom, entities: EntityLookup, outcomeWord: string): string {
  const name = (id: string): string => entities.card(id).name
  return room.notes.map((note) => routeNoteText(note, name, outcomeWord)).join(' · ')
}

function Pickup({
  room,
  entities,
  flagged
}: {
  room: RouteRoom
  entities: EntityLookup
  flagged: boolean
}): JSX.Element {
  if (!room.pickup && room.passed.length === 0) return <>—</>
  // With a pickup the row's accent is spent; the cards that were offered and
  // left ride the tooltip instead of adding three struck names to the line.
  const passedNames = room.passed.map((card) => entities.card(card.id).name)
  return (
    <PickupWrap title={passedNames.length ? `passed: ${passedNames.join(' · ')}` : undefined}>
      {room.pickup ? (
        <CardChip card={room.pickup} entities={entities} tone={flagged ? 'plain' : 'gold'} />
      ) : (
        room.passed.map((card) => (
          <CardChip key={`p-${card.id}`} card={card} entities={entities} tone="gone" />
        ))
      )}
    </PickupWrap>
  )
}

function CardChip({
  card,
  entities,
  tone
}: {
  card: RouteCard
  entities: EntityLookup
  tone: 'gold' | 'plain' | 'gone'
}): JSX.Element {
  const entity = entities.card(card.id, card.upgradeLevel)
  return (
    <Pk>
      <Art entity={entity} variant="sprite" />
      <Name $tone={tone}>
        {entity.name}
        {card.upgradeLevel > 0 ? '+' : ''}
      </Name>
      {card.cost != null && tone !== 'gold' ? <Cost>{card.cost}g</Cost> : null}
    </Pk>
  )
}

/** `R7` reads as a typo beside `R45`; the ledger's row labels are fixed width. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** The whisper under the ledger, when the run's counts are known to be partial. */
export function RoutePartialNote(): JSX.Element {
  return (
    <Whisper style={{ margin: '10px 2px 0' }}>
      counts are partial — this run was joined mid-way or played while we were not watching
    </Whisper>
  )
}

// ── surfaces ────────────────────────────────────────────────────────────────

const Census = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1px;
  background: var(--line);
  border-radius: 11px;
  overflow: hidden;
  margin-bottom: 12px;
`

const CensusCell = styled.div`
  background: #1e1b18;
  padding: 11px 14px 12px;
  min-width: 0;
`

const CensusTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
`

const CensusNum = styled(Num)`
  font-family: var(--font-display);
  font-size: 22px;
  line-height: 1.15;
  color: var(--ink);
`

const CensusBar = styled.span<{ $pct: number; $tone: string }>`
  display: block;
  height: 5px;
  margin-top: 7px;
  border-radius: 3px;
  background: var(--fill);
  overflow: hidden;
  &::after {
    content: '';
    display: block;
    height: 100%;
    width: ${(p) => Math.max(2, Math.min(100, p.$pct))}%;
    border-radius: 3px;
    background: ${(p) => p.$tone};
  }
`

const RouteTable = styled(Table)<{ $compact: boolean }>`
  table-layout: fixed;

  tbody td {
    height: ${(p) => (p.$compact ? '28px' : '30px')};
  }
  tbody td.r:first-child {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-faint);
    letter-spacing: 0.3px;
  }
  tbody td.entry {
    color: var(--ink-dim);
    white-space: normal;
    line-height: 1.4;
  }
  tbody td.entry.dim {
    color: var(--ink-faint);
  }
`

const RoomRow = styled.tr<{ $end: boolean }>`
  ${(p) =>
    p.$end
      ? `
    td { background: oklch(0.62 0.21 22 / 9%); }
    &:hover td { background: oklch(0.62 0.21 22 / 13%); }
    td.r:first-child { color: var(--sts-color-red); }
    td.entry b { color: var(--sts-color-red); font-weight: 600; }
  `
      : ''}
`

const dividerRow = `
  td {
    background: #1b1815;
    border-top: 1px solid var(--line-strong);
    padding: 5px 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.3px;
    color: var(--ink-faint);
  }
  &:hover td {
    background: #1b1815;
  }
  td b {
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 1.4px;
    font-weight: 500;
    margin-right: 10px;
  }
`

const ActRow = styled.tr`
  ${dividerRow}
  td b {
    color: var(--brand-soft);
  }
`

/**
 * A hole in the record, drawn in the same row grammar as an act break.
 *
 * It is new since the mockup — the recorder can now tell you that the run moved
 * while nobody was watching — and it is orange rather than violet because it is
 * a caveat about the data, not a milestone in the run.
 */
const GapRow = styled.tr`
  ${dividerRow}
  td b {
    color: var(--sts-color-orange);
  }
`

const Collapsed = styled.td`
  color: var(--ink-faint);
  font-family: var(--font-mono);
  font-size: 11px;
  &:hover {
    background: transparent;
  }
`

const PickupWrap = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
`

const Pk = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const Name = styled.span<{ $tone: 'gold' | 'plain' | 'gone' }>`
  color: ${(p) =>
    p.$tone === 'gold'
      ? 'var(--sts-color-gold)'
      : p.$tone === 'plain'
        ? 'var(--ink)'
        : 'var(--ink-faint)'};
  text-decoration: ${(p) => (p.$tone === 'gone' ? 'line-through' : 'none')};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Cost = styled(Num)`
  font-family: var(--font-display);
  font-size: 12px;
  color: var(--ink-faint);
`
