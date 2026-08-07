import { Fragment, useMemo, useState } from 'react'
import styled from 'styled-components'
import type { Sts2Card, Sts2CardData, Sts2PileState } from '@shared/types'
import { CardTile } from './CardTile'
import { useDraggableNav } from '../../hooks/useDraggableNav'
import { BG, resolveCost } from './theme'

/**
 * Draw-pile odds tracker, grouped by card type (Attack/Skill/Power/Other) with
 * count/total and draw-% per group. Collapsible. Ported 1:1 from the original
 * (decomp/renderer DeckTracker) — this is the flagship "cards" overlay.
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
  isPeekButtonVisible
}: {
  pileState: Sts2PileState
  cardData: Sts2CardData | null
  isPeekButtonVisible: boolean
}): JSX.Element {
  const [hidden, setHidden] = useState(false)
  const [hovered, setHovered] = useState(false)
  const nav = useDraggableNav('sts2.deckTracker.topPct', 15)

  const cardsNotInDraw = useMemo(
    () => [
      ...pileState.discard,
      ...pileState.hand.filter((card) => card.isPermanent || card.hasBeenCycled)
    ],
    [pileState.discard, pileState.hand]
  )

  const groupedCards = useMemo(
    () => groupByType(sortGroups(groupCards(pileState.draw, cardsNotInDraw, cardData), cardData), cardData),
    [pileState.draw, cardsNotInDraw, cardData]
  )

  return (
    <Container
      className="interactive"
      $hidden={hidden}
      style={{ top: `${nav.topPct}%` }}
      onMouseEnter={() => {
        setHovered(true)
        nav.onEnter()
      }}
      onMouseLeave={() => {
        setHovered(false)
        nav.onLeave()
      }}
    >
      <Panel $peek={!!isPeekButtonVisible} $hidden={hidden}>
        <Section>
          {groupedCards.map((group) => (
            <Fragment key={group.type}>
              <GroupHeader>
                <span>{typeLabel(group.type)}</span>
                <GroupStats>
                  <span>{`${group.count}/${group.total}`}</span>
                  <DrawChance>{formatChance(group.count, pileState.draw.length)}</DrawChance>
                </GroupStats>
              </GroupHeader>
              {group.cards.map((row) => (
                <CardTile card={row} jsonCard={cardData?.[row.id]} key={getCardGroupKey(row, cardData)} />
              ))}
            </Fragment>
          ))}
        </Section>
      </Panel>
      <Buttons $hidden={hidden}>
        {!hidden && (
          <GripButton
            $show={hovered || nav.dragging}
            title="Drag to move vertically"
            {...nav.gripHandlers}
          >
            {'\u2807'}
          </GripButton>
        )}
        <IconButton
          $show={hovered || hidden}
          $attached={hidden}
          onClick={() => setHidden((h) => !h)}
        >
          {hidden ? '\u203A' : '\u00D7'}
        </IconButton>
      </Buttons>
    </Container>
  )
}

// ── grouping helpers (pure, ported) ──

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
    if (existing) {
      existing.total++
    } else {
      groups.set(key, { ...card, count: 0, total: 1 })
    }
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

// ── styled (ported) ──

const PANEL_WIDTH = 180
const PANEL_LEFT_OFFSET = 7
const BUTTON_SIZE = 40
const BUTTON_GAP = 10

const Container = styled.div<{ $hidden: boolean }>`
  position: absolute;
  top: 15%;
  left: 0;
  width: ${(p) => (p.$hidden ? '0' : 'auto')};
  height: ${(p) => (p.$hidden ? '0' : 'auto')};
`

const Panel = styled.div<{ $peek: boolean; $hidden: boolean }>`
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: ${PANEL_WIDTH}px;
  max-height: 58vh;
  overflow-y: auto;
  margin-left: -${PANEL_LEFT_OFFSET}px;
  padding: 10px 10px 10px 17px;

  transform: translateX(
    ${(p) => (p.$hidden ? 'calc(-100% - 20px)' : p.$peek ? '-60%' : '0')}
  );
  transform-origin: left top;
  opacity: ${(p) => (p.$hidden ? 0 : 1)};
  pointer-events: ${(p) => (p.$hidden ? 'none' : 'auto')};
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
  &:hover {
    transform: translateX(${(p) => (p.$hidden ? 'calc(-100% - 20px)' : '0')});
  }

  color: var(--sts-color-cream);
  font-family: 'Kreon', sans-serif;
  letter-spacing: 1px;

  background: ${BG}88;
  border-radius: 0 8px 8px 0;
  border: 1px solid oklch(1 0 0 / 10%);
  border-left: none;
  box-shadow: 7px 7px 0 oklch(0 0 0 / 30%);

  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 20%);
    border-radius: 3px;
  }
`

const Buttons = styled.div<{ $hidden: boolean }>`
  position: absolute;
  top: 0;
  left: ${(p) => (p.$hidden ? '0' : '100%')};
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px 12px ${(p) => (p.$hidden ? '0' : `${BUTTON_GAP}px`)};
  transition: left 0.2s ease;
`

const IconButton = styled.button<{ $show: boolean; $attached: boolean }>`
  pointer-events: auto;
  width: ${BUTTON_SIZE}px;
  height: ${BUTTON_SIZE}px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  color: var(--sts-color-cream);
  background: ${BG}cc;
  border: 1px solid oklch(1 0 0 / 20%);
  ${(p) =>
    p.$attached &&
    `
      border-left: none;
      margin-left: -${PANEL_LEFT_OFFSET}px;
      width: ${BUTTON_SIZE + PANEL_LEFT_OFFSET}px;
    `}
  border-radius: ${(p) => (p.$attached ? '0 8px 8px 0' : '8px')};
  box-shadow: 7px 7px 0 oklch(0 0 0 / 30%);
  opacity: ${(p) => (p.$show ? 1 : 0)};
  transition:
    opacity 0.15s ease,
    background 0.15s ease;
  &:hover {
    background: ${BG};
    color: white;
  }
`

const GripButton = styled.button<{ $show: boolean }>`
  pointer-events: auto;
  width: ${BUTTON_SIZE}px;
  height: ${BUTTON_SIZE}px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: grab;
  font-size: 20px;
  line-height: 1;
  color: var(--sts-color-cream);
  background: ${BG}cc;
  border: 1px solid oklch(1 0 0 / 20%);
  border-radius: 8px;
  box-shadow: 7px 7px 0 oklch(0 0 0 / 30%);
  opacity: ${(p) => (p.$show ? 1 : 0)};
  transition:
    opacity 0.15s ease,
    background 0.15s ease;
  touch-action: none;
  &:hover {
    background: ${BG};
    color: white;
  }
  &:active {
    cursor: grabbing;
  }
`

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;
`

const GroupHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--brand);
  margin-bottom: -2px;
  text-shadow: 2px 2px 0 oklch(0 0 0 / 50%);

  &:not(:first-child) {
    margin-top: 2px;
  }
`

const GroupStats = styled.div`
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--sts-color-cream);
`

const DrawChance = styled.span`
  color: var(--brand);
`
