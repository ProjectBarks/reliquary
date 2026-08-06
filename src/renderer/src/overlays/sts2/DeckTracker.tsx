import { useMemo, useState } from 'react'
import styled, { css } from 'styled-components'
import type { Sts2Card, Sts2CardData, Sts2PileState } from '@shared/types'
import { CardTile } from './CardTile'
import { useFloatingPanel } from '../../hooks/useFloatingPanel'
import { BG, resolveCost } from './theme'

/**
 * Draw-pile odds tracker: what is left to draw, grouped by card type, with
 * count/total and draw-% per group.
 *
 * It used to be a fixed-width strip that could only slide up and down the left
 * edge. It is now placeable anywhere and resizable, which changes the layout
 * problem entirely — a short, wide panel has to put the same content into
 * several columns.
 *
 * Wrapping is where grouping normally dies: once "Attack" and "Skill" sit side
 * by side, a bare list of rows gives no clue where one ends. Three things keep
 * it legible, in order of how much work they do:
 *
 *   1. Groups are atomic. `break-inside: avoid` means a type never splits
 *      across a column boundary, so every column break is also a group break.
 *   2. Each group carries a type-coloured spine down its left edge — the signal
 *      that survives being read horizontally instead of vertically.
 *   3. The header repeats per group, so a column that starts mid-panel still
 *      says what you are looking at.
 */

type GroupRow = Sts2Card & { count: number; total: number }
interface TypeGroup {
  type: string
  cards: GroupRow[]
  count: number
  total: number
}

export function DeckTracker({
  pileState,
  cardData,
  isPeekButtonVisible,
  storageKey = 'sts2.deckTracker.placement'
}: {
  pileState: Sts2PileState
  cardData: Sts2CardData | null
  isPeekButtonVisible: boolean
  /** Where placement persists. Distinct keys allow more than one panel. */
  storageKey?: string
}): JSX.Element {
  const [hidden, setHidden] = useState(false)
  const [hovered, setHovered] = useState(false)
  const panel = useFloatingPanel(storageKey)

  const cardsNotInDraw = useMemo(
    () => [
      ...pileState.discard,
      ...pileState.hand.filter((card) => card.isPermanent || card.hasBeenCycled)
    ],
    [pileState.discard, pileState.hand]
  )

  const groupedCards = useMemo(
    () =>
      groupByType(
        sortGroups(groupCards(pileState.draw, cardsNotInDraw, cardData), cardData),
        cardData
      ),
    [pileState.draw, cardsNotInDraw, cardData]
  )

  const active = hovered || panel.dragging || panel.resizing
  const drawLeft = pileState.draw.length

  if (hidden) {
    return (
      <Collapsed
        className="interactive"
        style={{ ...panel.style, width: 40, height: 40 }}
        onMouseEnter={panel.onEnter}
        onMouseLeave={panel.onLeave}
        onClick={() => setHidden(false)}
        title="Show deck tracker"
      >
        {'›'}
      </Collapsed>
    )
  }

  return (
    <>
      {/* Snap feedback is drawn behind the panel, not on it: the point is to
          show where it will land, which you cannot see if the panel covers it. */}
      {panel.snapHint ? <SnapGuide $ax={panel.snapHint.ax} $ay={panel.snapHint.ay} /> : null}

      <Shell
        className="interactive"
        style={panel.style}
        $active={active}
        $peek={!!isPeekButtonVisible}
        onMouseEnter={() => {
          setHovered(true)
          panel.onEnter()
        }}
        onMouseLeave={() => {
          setHovered(false)
          panel.onLeave()
        }}
      >
        <TitleBar $active={active} {...panel.gripHandlers}>
          <Grip aria-hidden>
            <span />
            <span />
            <span />
          </Grip>
          <Title>Draw pile</Title>
          <Remaining>{drawLeft}</Remaining>
          <Close
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setHidden(true)}
            title="Hide"
          >
            {'×'}
          </Close>
        </TitleBar>

        <Columns>
          {groupedCards.map((group) => (
            <Group key={group.type} $type={group.type}>
              <GroupHeader>
                <GroupName $type={group.type}>{typeLabel(group.type)}</GroupName>
                <GroupStats>
                  <span>{`${group.count}/${group.total}`}</span>
                  <DrawChance>{formatChance(group.count, drawLeft)}</DrawChance>
                </GroupStats>
              </GroupHeader>
              {group.cards.map((row) => (
                <CardTile
                  card={row}
                  jsonCard={cardData?.[row.id]}
                  key={getCardGroupKey(row, cardData)}
                />
              ))}
            </Group>
          ))}
        </Columns>

        <ResizeHandle
          $active={active}
          $ax={panel.placement.ax}
          $ay={panel.placement.ay}
          title="Drag to resize"
          {...panel.resizeHandlers}
        />
      </Shell>
    </>
  )
}

// ── grouping helpers (unchanged) ──

function getCardGroupKey(card: Sts2Card, cardData: Sts2CardData | null): string {
  return `${resolveCost(card, cardData?.[card.id]) ?? ''}|${card.id}|${card.upgradeLevel}|${
    card.enchantment ?? ''
  }`
}

function groupCards(
  draw: Sts2Card[],
  notInDraw: Sts2Card[],
  cardData: Sts2CardData | null
): GroupRow[] {
  const groups = new Map<string, GroupRow>()
  for (const card of draw) {
    const key = getCardGroupKey(card, cardData)
    const existing = groups.get(key)
    if (existing) {
      existing.count++
      existing.total++
    } else {
      groups.set(key, { ...card, count: 1, total: 1 })
    }
  }
  for (const card of notInDraw) {
    const key = getCardGroupKey(card, cardData)
    const existing = groups.get(key)
    if (existing) existing.total++
    else groups.set(key, { ...card, count: 0, total: 1 })
  }
  return [...groups.values()]
}

const TYPE_ORDER: Record<string, number> = {
  attack: 0,
  skill: 1,
  power: 2,
  status: 3,
  curse: 4,
  quest: 5
}

function groupByType(cards: GroupRow[], cardData: Sts2CardData | null): TypeGroup[] {
  const byType = new Map<string, GroupRow[]>()
  for (const row of cards) {
    let type = cardData?.[row.id]?.type?.toLowerCase() ?? ''
    if (TYPE_ORDER[type] === undefined || TYPE_ORDER[type] > TYPE_ORDER.power) type = 'other'
    const bucket = byType.get(type)
    if (bucket) bucket.push(row)
    else byType.set(type, [row])
  }
  return [...byType.entries()]
    .map(([type, groupCardsArr]) => ({
      type,
      cards: groupCardsArr,
      count: groupCardsArr.reduce((sum, card) => sum + card.count, 0),
      total: groupCardsArr.reduce((sum, card) => sum + card.total, 0)
    }))
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99))
}

function formatChance(count: number, total: number): string {
  if (total === 0) return '-'
  return `${Math.round((count / total) * 100)}%`
}

function typeLabel(type: string): string {
  switch (type) {
    case 'attack':
      return 'Attack'
    case 'skill':
      return 'Skill'
    case 'power':
      return 'Power'
    default:
      return 'Other'
  }
}

function sortGroups(groups: GroupRow[], cardData: Sts2CardData | null): GroupRow[] {
  return groups.sort((a, b) => {
    const aData = cardData?.[a.id]
    const bData = cardData?.[b.id]
    const costDiff = resolveCost(a, aData).localeCompare(resolveCost(b, bData))
    if (costDiff !== 0) return costDiff
    const nameDiff = (aData?.name ?? a.id).localeCompare(bData?.name ?? b.id)
    if (nameDiff !== 0) return nameDiff
    if (a.upgradeLevel !== b.upgradeLevel) return a.upgradeLevel - b.upgradeLevel
    return (a.enchantment ?? '').localeCompare(b.enchantment ?? '')
  })
}

// ── styling ──

/** One hue per card type — the thing that keeps a group readable once wrapped. */
const TYPE_HUE: Record<string, string> = {
  attack: 'var(--sts-color-red)',
  skill: 'var(--sts-color-blue)',
  power: 'var(--sts-color-purple)',
  other: '#9c9384'
}
const hueOf = (t: string): string => TYPE_HUE[t] ?? TYPE_HUE.other

const Shell = styled.div<{ $active: boolean; $peek: boolean }>`
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
  background: ${BG}e8;
  border: 1px solid ${(p) => (p.$active ? 'oklch(1 0 0 / 26%)' : 'oklch(1 0 0 / 12%)')};
  box-shadow: 7px 7px 0 oklch(0 0 0 / 30%);
  transition:
    border-color 0.18s ease,
    opacity 0.18s ease;
  opacity: ${(p) => (p.$peek ? 0.35 : 1)};
`

const TitleBar = styled.div<{ $active: boolean }>`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 9px;
  cursor: grab;
  user-select: none;
  border-bottom: 1px solid oklch(1 0 0 / 10%);
  background: ${(p) => (p.$active ? 'oklch(1 0 0 / 6%)' : 'transparent')};
  transition: background 0.18s ease;
  &:active {
    cursor: grabbing;
  }
`

/** Six dots — the standard "this is a drag handle" mark, drawn not typed. */
const Grip = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 3px);
  gap: 3px;
  flex: 0 0 auto;
  span {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: oklch(1 0 0 / 45%);
    box-shadow: 0 6px 0 oklch(1 0 0 / 45%);
  }
`

const Title = styled.div`
  flex: 1;
  min-width: 0;
  font-family: 'Kreon', serif;
  font-size: 14px;
  letter-spacing: 0.4px;
  color: var(--sts-color-cream);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const Remaining = styled.div`
  flex: 0 0 auto;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  color: var(--sts-color-cream);
  background: oklch(1 0 0 / 9%);
  border-radius: 9px;
  padding: 1px 7px;
`

const Close = styled.button`
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  padding: 0;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  color: oklch(1 0 0 / 55%);
  background: none;
  border: 0;
  border-radius: 5px;
  &:hover {
    color: var(--sts-color-cream);
    background: oklch(1 0 0 / 10%);
  }
`

/**
 * The column engine. `column-width` rather than `column-count` so the number of
 * columns follows the width the user dragged, instead of the panel guessing.
 */
const Columns = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 8px 2px;
  columns: 168px auto;
  column-gap: 14px;
  /* A ruled gutter. Without it two adjacent columns read as one stream of
     cards, which is the exact confusion wrapping introduces. */
  column-rule: 1px solid oklch(1 0 0 / 10%);

  /* Fade the last few pixels so a clipped row reads as "more below" instead of
     as a rendering fault. Only applied when there is actually overflow. */
  mask-image: linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%);

  &::-webkit-scrollbar {
    width: 7px;
  }
  &::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 16%);
    border-radius: 4px;
  }
`

/**
 * A group reads as one bounded object rather than a run of rows.
 *
 * The first attempt used a thin coloured spine, which was invisible in practice:
 * the card tiles carry the character's own strong frame colour (every Ironclad
 * card is red), so a 2px red rail beside red cards said nothing. What survives
 * that competition is enclosure and space — a tinted well, a full-height rail,
 * and a clear gap — none of which the tiles themselves use.
 */
const Group = styled.div<{ $type: string }>`
  /* Atomic: a type never straddles a column boundary, so every column break is
     also a group break and no card is orphaned from its heading. */
  break-inside: avoid;
  page-break-inside: avoid;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 6px 8px 9px;
  margin-bottom: 14px;
  border-radius: 8px;
  border: 1px solid ${(p) => `color-mix(in oklch, ${hueOf(p.$type)} 26%, transparent)`};
  border-left: 3px solid ${(p) => hueOf(p.$type)};
  background: oklch(0 0 0 / 26%);
`

const GroupHeader = styled.div`
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding-bottom: 2px;
`

const GroupName = styled.span<{ $type: string }>`
  flex: 1;
  min-width: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  /* The heading takes the group's hue, so name and rail agree even when the
     rail is beside cards of a different colour. */
  color: ${(p) => hueOf(p.$type)};
`

const GroupStats = styled.div`
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  color: oklch(1 0 0 / 55%);
`

const DrawChance = styled.span`
  color: var(--sts-color-aqua);
`

/**
 * Sits at whichever corner points into open screen, so dragging it always grows
 * the panel away from the edge it is anchored to rather than fighting it.
 */
const ResizeHandle = styled.div<{ $active: boolean; $ax: string; $ay: string }>`
  position: absolute;
  width: 16px;
  height: 16px;
  cursor: ${(p) =>
    (p.$ax === 'right') === (p.$ay === 'bottom') ? 'nwse-resize' : 'nesw-resize'};
  opacity: ${(p) => (p.$active ? 1 : 0)};
  transition: opacity 0.18s ease;
  ${(p) => (p.$ax === 'right' ? css`left: 2px;` : css`right: 2px;`)}
  ${(p) => (p.$ay === 'bottom' ? css`top: 2px;` : css`bottom: 2px;`)}

  &::after {
    content: '';
    position: absolute;
    inset: 4px;
    border-right: 2px solid oklch(1 0 0 / 40%);
    border-bottom: 2px solid oklch(1 0 0 / 40%);
    border-radius: 0 0 3px 0;
    transform: rotate(
      ${(p) => (p.$ax === 'right' ? (p.$ay === 'bottom' ? 180 : 90) : p.$ay === 'bottom' ? 270 : 0)}deg
    );
  }
`

/** Where the panel will land, drawn behind it while dragging. */
const SnapGuide = styled.div<{ $ax: string; $ay: string }>`
  position: absolute;
  pointer-events: none;
  border-radius: 12px;
  border: 1px dashed color-mix(in oklch, var(--brand) 70%, transparent);
  background: color-mix(in oklch, var(--brand) 8%, transparent);
  inset: 6px;
  ${(p) =>
    p.$ax === 'left'
      ? css`right: 60%;`
      : p.$ax === 'right'
        ? css`left: 60%;`
        : css`left: 28%; right: 28%;`}
  ${(p) =>
    p.$ay === 'top'
      ? css`bottom: 60%;`
      : p.$ay === 'bottom'
        ? css`top: 60%;`
        : css`top: 28%; bottom: 28%;`}
`

const Collapsed = styled.button`
  position: absolute;
  display: grid;
  place-items: center;
  padding: 0;
  cursor: pointer;
  font-size: 20px;
  color: var(--sts-color-cream);
  background: ${BG}cc;
  border: 1px solid oklch(1 0 0 / 20%);
  border-radius: 8px;
  box-shadow: 5px 5px 0 oklch(0 0 0 / 30%);
`
