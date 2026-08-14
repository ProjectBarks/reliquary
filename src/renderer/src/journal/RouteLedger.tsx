import { useCallback, useState, type KeyboardEvent } from 'react'
import styled, { keyframes } from 'styled-components'
import { useArtPreview } from '../codex/ArtPreview'
import { DASH } from '../codex/format'
import { TierBadge, tierForScore } from '../codex/tiers'
import { useEntities, type EntityLookup } from './art'
import type {
  DerivedRoute,
  RouteCard,
  RouteLine,
  RouteOffer,
  RouteOfferOption,
  RouteRoom
} from './derive'
import {
  offerAdviceText,
  offerOutcomeText,
  offerSourceText,
  routeNoteText,
  routeOffer
} from './derive'
import { ROOM_KIND_LABEL, ROOM_KIND_TONE } from './format'
import { Art, Flag, Note, Num, OutlineChip, TBox, Table } from './parts'

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
 * Two things changed after the first read-through of a real run.
 *
 * **Pickups are cards, so they are drawn as cards.** The row used to carry an
 * 18px sprite, which is how the game shows a card in a *list* and not how
 * anybody recognises one. It now carries the same 34×44 framed render the Deck
 * Ledger uses, upgraded art when the card was upgraded on acquisition, the same
 * initials plate when the CDN has no file, and the same 51px row rhythm that
 * geometry forces. Hovering or focusing one opens the shared 170×230 preview,
 * because a thumbnail small enough to fit a table is still too small to read.
 *
 * **A reward screen is more than its outcome.** A row shows what was taken; the
 * question it provokes is what else was on offer, and the log has the answer.
 * Rows whose room showed an offer expand on click into the screen as it stood:
 * every option as a framed card, its grade when advice was captured, its price
 * in a shop, and a mark on the one that was taken. Only those rows are
 * expandable, and only those rows show the chevron — an affordance on a row
 * that does nothing when you click it is worse than no affordance.
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
  const preview = useArtPreview()

  /**
   * Which offer rows are open, by row key.
   *
   * A set rather than a single id because the reader comparing two rewards four
   * rooms apart is the exact case the panel exists for, and closing one to open
   * the other would make that comparison impossible. Keyed by `line.key`, which
   * already survives a room index the recorder repeated.
   */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  // Escape closes everything, from anywhere in the table. It is the gesture a
  // reader already has for "put that away", and reaching for the chevron they
  // opened three panels ago is not a gesture at all.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    setOpen((prev) => (prev.size === 0 ? prev : new Set()))
  }, [])

  if (route.empty) {
    return <Note>No rooms recorded yet. The ledger fills in as the run moves.</Note>
  }

  const totals = route.totals

  return (
    <TBox onKeyDown={onKeyDown}>
      <RouteTable>
        <colgroup>
          <col style={{ width: compact ? '12%' : '6%' }} />
          <col style={{ width: compact ? '18%' : '9%' }} />
          <col style={{ width: compact ? '32%' : '38%' }} />
          <col style={{ width: compact ? '38%' : '41%' }} />
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
              expanded={open.has(line.key)}
              onToggle={toggle}
              bind={preview.bind}
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
      {preview.preview}
    </TBox>
  )
}

/** The shared preview's binder, threaded down rather than re-created per row. */
type Bind = ReturnType<typeof useArtPreview>['bind']

function Line({
  line,
  entities,
  outcomeWord,
  flag,
  compact,
  expanded,
  onToggle,
  bind
}: {
  line: RouteLine
  entities: EntityLookup
  outcomeWord: string
  flag: string | null
  compact: boolean
  expanded: boolean
  onToggle: (key: string) => void
  bind: Bind
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
          <GapLine>
            <OutlineChip $tone="var(--sts-color-orange)">Gap</OutlineChip>
            <GapNote>{line.note}</GapNote>
          </GapLine>
        </td>
      </GapRow>
    )
  }

  const offer = routeOffer(line)
  const panelId = `offer-${line.key}`

  return (
    <>
      <RoomRow
        $end={line.end}
        $open={expanded}
        $clickable={offer !== null}
        onClick={offer === null ? undefined : () => onToggle(line.key)}
      >
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
            DASH
          )}
        </td>
        <td className={line.pickup || line.passed.length ? '' : 'dim'}>
          <PickupCell>
            <Pickup room={line} entities={entities} flagged={flag !== null} bind={bind} />
            {offer ? (
              <Chevron
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                aria-label={chevronLabel(expanded, offer.options.length)}
                title={chevronLabel(expanded, offer.options.length)}
                $open={expanded}
              >
                ▸
              </Chevron>
            ) : null}
          </PickupCell>
        </td>
        {compact ? null : <td className="r">{flag ? <Flag>{flag}</Flag> : null}</td>}
      </RoomRow>
      {offer && expanded ? (
        <OfferRow>
          <td colSpan={span}>
            <OfferPanel id={panelId} offer={offer} entities={entities} bind={bind} />
          </td>
        </OfferRow>
      ) : null}
    </>
  )
}

function noteWords(room: RouteRoom, entities: EntityLookup, outcomeWord: string): string {
  const name = (id: string): string => entities.card(id).name
  return room.notes.map((note) => routeNoteText(note, name, outcomeWord)).join(' · ')
}

function Pickup({
  room,
  entities,
  flagged,
  bind
}: {
  room: RouteRoom
  entities: EntityLookup
  flagged: boolean
  bind: Bind
}): JSX.Element {
  if (!room.pickup && room.passed.length === 0) return <>{DASH}</>
  // With a pickup the row's accent is spent; the cards that were offered and
  // left ride the tooltip instead of adding three struck names to the line.
  // The full list is one click away on any row that carries an offer.
  const passedNames = room.passed.map((card) => entities.card(card.id).name)
  return (
    <PickupWrap title={passedNames.length ? `passed: ${passedNames.join(' · ')}` : undefined}>
      {room.pickup ? (
        <CardChip
          card={room.pickup}
          entities={entities}
          tone={flagged ? 'plain' : 'gold'}
          bind={bind}
        />
      ) : (
        room.passed.map((card) => (
          <CardChip key={`p-${card.id}`} card={card} entities={entities} tone="gone" bind={bind} />
        ))
      )}
    </PickupWrap>
  )
}

/**
 * A card in a route row: the framed render, the name, and a price in a shop.
 *
 * `entities.card(id, upgradeLevel)` is what picks the `_upg` art, so a card
 * upgraded at the moment it was acquired shows the upgraded face here without
 * this component knowing the CDN's file naming. A miss falls back to the
 * initials plate inside an identical 34×44 box, so a 404 never reflows a row.
 */
function CardChip({
  card,
  entities,
  tone,
  bind
}: {
  card: RouteCard
  entities: EntityLookup
  tone: 'gold' | 'plain' | 'gone'
  bind: Bind
}): JSX.Element {
  const entity = entities.card(card.id, card.upgradeLevel)
  return (
    <Pk tabIndex={0} {...bind(entity.render, entity.name)}>
      <Art entity={entity} variant="render" />
      <Name $tone={tone}>
        {entity.name}
        {card.upgradeLevel > 0 ? '+' : ''}
      </Name>
      {card.cost != null && tone !== 'gold' ? <Cost>{card.cost}g</Cost> : null}
    </Pk>
  )
}

/**
 * The reward screen, reopened.
 *
 * Every option the room showed, in the order it showed them, with whatever the
 * file knows about each: a grade when advice was captured live or replayed
 * afterwards, a price when the room was a shop, and a plate on the one that was
 * taken. The ones that were left are plain rather than struck through — the
 * point of the panel is to let you judge the choice, and pre-crossing three of
 * four cards makes that judgement for you.
 *
 * The head line names the source and says where the grades came from, because
 * live advice is what the player was actually looking at and replayed advice is
 * the model's hindsight; a reader weighing a criticism needs to know which.
 */
function OfferPanel({
  id,
  offer,
  entities,
  bind
}: {
  id: string
  offer: RouteOffer
  entities: EntityLookup
  bind: Bind
}): JSX.Element {
  return (
    <Panel id={id}>
      <PanelHead>
        <OutlineChip $tone={offer.shop ? 'var(--sts-color-gold)' : 'var(--brand-soft)'}>
          {offerSourceText(offer.source)}
        </OutlineChip>
        <PanelNote>
          {offer.options.length} offered · {offerOutcomeText(offer)}
        </PanelNote>
        <PanelNote className="quiet">{offerAdviceText(offer)}</PanelNote>
      </PanelHead>
      <Options>
        {offer.options.map((option) => (
          <Option key={option.id} option={option} offer={offer} entities={entities} bind={bind} />
        ))}
      </Options>
      {offer.stock.length ? (
        <Stock>
          {/* Relics and potions have no framed render on the CDN, so the shelf
              keeps the sprite it has always had rather than an empty plate. */}
          <StockCap>also on the shelf</StockCap>
          {offer.stock.map((item) => {
            const entity = entities.item(item.id)
            return (
              <StockChip key={item.id}>
                <Art entity={entity} variant="sprite" />
                <span>{entity.name}</span>
                {item.cost === null ? null : <Cost>{item.cost}g</Cost>}
              </StockChip>
            )
          })}
        </Stock>
      ) : null}
    </Panel>
  )
}

function Option({
  option,
  offer,
  entities,
  bind
}: {
  option: RouteOfferOption
  offer: RouteOffer
  entities: EntityLookup
  bind: Bind
}): JSX.Element {
  const entity = entities.card(option.id, option.upgradeLevel)
  const grade = tierForScore(option.score)
  return (
    <OptionCard
      $taken={option.taken}
      tabIndex={0}
      title={option.reasons.length ? option.reasons.join(' · ') : undefined}
      {...bind(entity.render, entity.name)}
    >
      <Art entity={entity} variant="render" />
      <OptionText>
        <OptionName $taken={option.taken}>
          {entity.name}
          {option.upgradeLevel > 0 ? '+' : ''}
        </OptionName>
        <OptionMeta>
          {option.score === null ? null : (
            <>
              <TierBadge $tier={grade}>{grade ?? DASH}</TierBadge>
              <Score>{option.score}</Score>
            </>
          )}
          {option.cost === null ? null : <Cost>{option.cost}g</Cost>}
          {option.taken ? <Took>{offer.shop ? 'bought' : 'taken'}</Took> : null}
        </OptionMeta>
      </OptionText>
    </OptionCard>
  )
}

/** The disclosure's label, which is also its tooltip: one sentence, no dashes. */
function chevronLabel(expanded: boolean, options: number): string {
  return `${expanded ? 'Hide' : 'Show'} the ${options} option${
    options === 1 ? '' : 's'
  } this room offered`
}

/** `R7` reads as a typo beside `R45`; the ledger's row labels are fixed width. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
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
  font-size: var(--fs-2xl);
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

const RouteTable = styled(Table)`
  table-layout: fixed;

  tbody td.r:first-child {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
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

/**
 * 51px rows, matching the Deck Ledger.
 *
 * Not a taste call: a 44px-tall framed render needs the height, and the only
 * two tables in the tab that draw card art should breathe at the same rate or
 * the report reads as two documents stapled together. The height lives on the
 * room row rather than on every cell in the table, so the act break, the gap
 * note and the offer panel stay as tall as their own content.
 */
const RoomRow = styled.tr<{ $end: boolean; $open: boolean; $clickable: boolean }>`
  td {
    height: 51px;
    padding-top: 3px;
    padding-bottom: 3px;
  }
  ${(p) => (p.$clickable ? 'cursor: pointer;' : '')}
  ${(p) =>
    p.$open
      ? `
    td { background: var(--fill-hover); }
    td:first-child { box-shadow: inset 1px 0 0 var(--brand-deep); }
  `
      : ''}
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

/**
 * The act divider: a filled band with a Kreon act number, the one milestone
 * marker the ledger carries. It is loud on purpose and it is the only row that
 * is, which is what makes it legible as a milestone.
 */
const ActRow = styled.tr`
  td {
    background: #1b1815;
    border-top: 1px solid var(--line-strong);
    padding: 5px 12px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    letter-spacing: 0.3px;
    color: var(--ink-faint);
  }
  &:hover td {
    background: #1b1815;
  }
  td b {
    font-family: var(--font-display);
    font-size: var(--fs-sm);
    letter-spacing: 1.4px;
    font-weight: 500;
    margin-right: 10px;
    color: var(--brand-soft);
  }
`

/**
 * A hole in the record: play the recorder did not see, or a restored save.
 *
 * It used to borrow the act divider's filled band, which made a caveat about
 * the *data* look like a milestone in the *run* and read as imported from
 * somewhere else entirely. It is now written in the ledger's own vocabulary —
 * a hairline rule, an outline chip in the type's colour exactly like the room
 * types beside it, and the detail in the same quiet mono as every other honesty
 * note in the tab. Orange rather than violet because it is still a caveat.
 */
const GapRow = styled.tr`
  td {
    padding: 7px 12px;
    background: transparent;
    border-top: 1px solid var(--line);
  }
  &:hover td {
    background: transparent;
  }
`

const GapLine = styled.span`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
`

const GapNote = styled.span`
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.2px;
  color: var(--ink-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Collapsed = styled.td`
  color: var(--ink-faint);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  &:hover {
    background: transparent;
  }
`

const PickupCell = styled.span`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
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
  gap: 9px;
  min-width: 0;
  border-radius: 6px;
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
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
  font-size: var(--fs-sm);
  color: var(--ink-faint);
`

/**
 * The disclosure, and the row's whole keyboard story.
 *
 * It carries no click handler of its own: the click it fires bubbles to the
 * row, which is the one place the toggle lives. That is what makes Enter and
 * Space work without a second implementation of them, and it keeps the row and
 * the chevron incapable of disagreeing about what is open.
 */
const Chevron = styled.button<{ $open: boolean }>`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-faint);
  font-size: var(--fs-sm);
  line-height: 1;
  cursor: pointer;
  transform: rotate(${(p) => (p.$open ? '90deg' : '0deg')});
  transition:
    transform 120ms ease,
    color 120ms ease,
    background 120ms ease;
  tr:hover & {
    color: var(--ink-dim);
    background: var(--fill);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`

const OfferRow = styled.tr`
  td {
    padding: 0 12px 12px;
    border-top: 0;
    background: var(--fill-hover);
  }
  &:hover td {
    background: var(--fill-hover);
  }
`

/**
 * The panel arrives rather than appearing: 110ms of fade and a two-pixel rise,
 * enough to tie it to the row it came from and short enough that a reader
 * opening four of them never waits. Motion-sensitive readers get it instantly.
 */
const reveal = keyframes`
  from { opacity: 0; transform: translateY(-2px); }
  to   { opacity: 1; transform: none; }
`

const Panel = styled.div`
  border-radius: 10px;
  border: 1px solid var(--line);
  background: rgba(30, 27, 24, 0.75);
  padding: 10px 12px 12px;
  animation: ${reveal} 110ms ease-out;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

const PanelHead = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
`

const PanelNote = styled.span`
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.2px;
  color: var(--ink-dim);
  &.quiet {
    color: var(--ink-faint);
  }
`

const Options = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
`

/**
 * One option. The taken card gets the gold edge and a plate; the rest are
 * plain, not struck — the panel is for judging the choice, and crossing out
 * everything that was left makes the judgement before the reader does.
 */
const OptionCard = styled.div<{ $taken: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 6px 9px;
  border-radius: 8px;
  background: ${(p) => (p.$taken ? 'oklch(0.83 0.16 86 / 8%)' : 'var(--fill)')};
  border: 1px solid ${(p) => (p.$taken ? 'var(--sts-color-gold)' : 'var(--line)')};
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

const OptionText = styled.span`
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
`

const OptionName = styled.span<{ $taken: boolean }>`
  font-family: var(--font-body);
  font-weight: 500;
  font-size: var(--fs-sm);
  color: ${(p) => (p.$taken ? 'var(--sts-color-gold)' : 'var(--ink)')};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const OptionMeta = styled.span`
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
`

const Score = styled(Num)`
  font-family: var(--font-display);
  font-size: var(--fs-sm);
  color: var(--ink-dim);
`

const Took = styled.span`
  font-family: var(--font-body);
  font-size: var(--fs-2xs);
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  line-height: 1.7;
  padding: 0 6px;
  border-radius: 6px;
  white-space: nowrap;
  color: var(--sts-color-gold);
  border: 1px solid color-mix(in oklab, var(--sts-color-gold) 42%, transparent);
`

const Stock = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
`

const StockCap = styled.span`
  font-family: var(--font-body);
  font-size: var(--fs-2xs);
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--ink-faint);
`

const StockChip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--ink-dim);
`
