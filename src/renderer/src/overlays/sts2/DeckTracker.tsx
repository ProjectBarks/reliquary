import { useMemo, useState } from 'react'
import styled, { css } from 'styled-components'
import type { Sts2Card, Sts2CardData, Sts2PileState } from '@shared/types'
import { CardTile } from './CardTile'
import { useFloatingPanel } from '../../hooks/useFloatingPanel'
import { BG, resolveCost } from './theme'
import {
  COL_GAP,
  DENSITIES,
  layoutBalance,
  layoutPacker,
  layoutScale,
  layoutSqueeze,
  type LayoutGroup,
  type LayoutMode,
  type TrackerLayout
} from './trackerLayout'

/**
 * Draw-pile odds tracker: what is left to draw, grouped by card type, with
 * count/total and draw-% per group. Placeable anywhere, resizable.
 *
 * The visual language is the original strip's: bare type headers over tight
 * rows on one translucent surface. The earlier boxed-well treatment made
 * groups obvious but spent ~28px of chrome per group; what actually carries
 * grouping across columns is cheaper — a type-hued header with a matching
 * hairline, atomic (or explicitly "continued") column breaks, and a ruled
 * gutter between columns.
 *
 * Where the content goes is trackerLayout's job. All modes except 'flow'
 * guarantee NO scrollbar: content is computed to fit the box, the shell
 * shrinks to hug whatever is actually used, and anything that truly cannot
 * fit is declared in a "+N hidden" chip.
 */

type GroupRow = Sts2Card & { count: number; total: number }

const TITLEBAR_H = 30
const PAD = 7
/** Shell border, both sides. */
const EDGE = 2
/** Line reserved for the "+N hidden" chip when content overflows. */
const CHIP_H = 22

export function DeckTracker({
  pileState,
  cardData,
  isPeekButtonVisible,
  mode = 'balance',
  storageKey = 'sts2.deckTracker.placement'
}: {
  pileState: Sts2PileState
  cardData: Sts2CardData | null
  isPeekButtonVisible: boolean
  /** Layout strategy; see trackerLayout.ts. */
  mode?: LayoutMode
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
  const p = panel.placement

  const availW = p.w - PAD * 2 - EDGE
  const availH = p.h - TITLEBAR_H - PAD * 2 - EDGE

  const layout: TrackerLayout<GroupRow> | null = useMemo(() => {
    if (mode === 'flow') return null
    const run = (h: number): TrackerLayout<GroupRow> => {
      switch (mode) {
        case 'packer':
          return layoutPacker(groupedCards, h)
        case 'scale':
          return layoutScale(groupedCards, availW, h)
        case 'squeeze':
          return layoutSqueeze(groupedCards, availW, h, (row) => row.count === 0)
        default:
          return layoutBalance(groupedCards, availW, h)
      }
    }
    const first = run(availH)
    // Overflow costs a line: the "+N hidden" chip gets its own row, so it
    // never sits on top of a card.
    return first.hiddenRows > 0 ? run(availH - CHIP_H) : first
  }, [mode, groupedCards, availW, availH])

  // The shell hugs its content: the dragged rectangle is a maximum, not a
  // hole to keep open. Because anchored edges are expressed as inset from
  // that edge, shrinking always pulls the far edge inward — a panel pinned
  // bottom-right stays flush bottom-right and gives space back top-left.
  const style: React.CSSProperties = { ...panel.style }
  if (layout) {
    const cols = layout.columns.length
    const contentW = cols > 0 ? cols * layout.colW + (cols - 1) * COL_GAP : 120
    const shellW = Math.min(
      Math.max(p.w, mode === 'packer' ? contentW + PAD * 2 + EDGE : 0),
      contentW + PAD * 2 + EDGE
    )
    const chipH = layout.hiddenRows > 0 ? CHIP_H : 0
    const shellH = Math.min(p.h, layout.usedH + chipH + TITLEBAR_H + PAD * 2 + EDGE)
    style.width = shellW
    style.height = shellH
    if (p.ax === 'center') style.marginLeft = `calc(${p.dx}% - ${shellW / 2}px)`
    if (p.ay === 'middle') style.marginTop = `calc(${p.dy}% - ${shellH / 2}px)`
  }

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
        style={style}
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

        {layout ? (
          <Body>
            {layout.columns.map((column, i) => (
              <Col key={i} style={{ width: layout.colW, gap: layout.density.groupGap }}>
                {column.map((seg) => (
                  <Seg key={`${seg.group.type}·${seg.part}`} style={{ gap: layout.density.rowGap }}>
                    <GroupHeader
                      $type={seg.group.type}
                      style={{ height: layout.density.headerH - layout.density.rowGap }}
                    >
                      <GroupName $type={seg.group.type}>
                        {typeLabel(seg.group.type)}
                        {seg.part > 1 ? <Cont> · cont</Cont> : null}
                      </GroupName>
                      {seg.part === 1 ? (
                        <GroupStats>
                          <span>{`${seg.group.count}/${seg.group.total}`}</span>
                          <DrawChance>{formatChance(seg.group.count, drawLeft)}</DrawChance>
                        </GroupStats>
                      ) : null}
                    </GroupHeader>
                    {seg.rows.map((row) => (
                      <CardTile
                        card={row}
                        jsonCard={cardData?.[row.id]}
                        rowH={layout.density.rowH}
                        fontSize={layout.density.font}
                        countSize={layout.density.countFont}
                        key={getCardGroupKey(row, cardData)}
                      />
                    ))}
                    {seg.showSummary ? (
                      <Summary style={{ height: layout.density.rowH }}>
                        {`+${seg.group.collapsed} ${seg.group.collapsedLabel}`}
                      </Summary>
                    ) : null}
                  </Seg>
                ))}
              </Col>
            ))}
            {layout.hiddenRows > 0 ? <HiddenChip>{`+${layout.hiddenRows} hidden`}</HiddenChip> : null}
          </Body>
        ) : (
          <FlowColumns>
            {groupedCards.map((group) => (
              <FlowGroup key={group.type}>
                <GroupHeader $type={group.type} style={{ height: 17 }}>
                  <GroupName $type={group.type}>{typeLabel(group.type)}</GroupName>
                  <GroupStats>
                    <span>{`${group.count}/${group.total}`}</span>
                    <DrawChance>{formatChance(group.count, drawLeft)}</DrawChance>
                  </GroupStats>
                </GroupHeader>
                {group.rows.map((row) => (
                  <CardTile
                    card={row}
                    jsonCard={cardData?.[row.id]}
                    key={getCardGroupKey(row, cardData)}
                  />
                ))}
              </FlowGroup>
            ))}
          </FlowColumns>
        )}

        <ResizeHandle
          $active={active}
          $ax={p.ax}
          $ay={p.ay}
          title="Drag to resize"
          {...panel.resizeHandlers}
        />
      </Shell>
    </>
  )
}

// ── grouping helpers ──

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

function groupByType(cards: GroupRow[], cardData: Sts2CardData | null): LayoutGroup<GroupRow>[] {
  const byType = new Map<string, GroupRow[]>()
  for (const row of cards) {
    let type = cardData?.[row.id]?.type?.toLowerCase() ?? ''
    if (TYPE_ORDER[type] === undefined || TYPE_ORDER[type] > TYPE_ORDER.power) type = 'other'
    const bucket = byType.get(type)
    if (bucket) bucket.push(row)
    else byType.set(type, [row])
  }
  return [...byType.entries()]
    .map(([type, rows]) => ({
      type,
      rows,
      count: rows.reduce((sum, card) => sum + card.count, 0),
      total: rows.reduce((sum, card) => sum + card.total, 0),
      collapsed: 0,
      collapsedLabel: ''
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

/** One hue per card type — what keeps a group identifiable once wrapped. */
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
  border-radius: 10px;
  background: ${BG}e0;
  border: 1px solid ${(p) => (p.$active ? 'oklch(1 0 0 / 26%)' : 'oklch(1 0 0 / 12%)')};
  box-shadow: 7px 7px 0 oklch(0 0 0 / 30%);
  transition:
    border-color 0.18s ease,
    opacity 0.18s ease;
  opacity: ${(p) => (p.$peek ? 0.35 : 1)};
`

const TitleBar = styled.div<{ $active: boolean }>`
  flex: 0 0 auto;
  height: ${TITLEBAR_H}px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 6px 0 9px;
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

/** Computed layout: explicit columns, no scrolling, hairline-ruled gutter. */
const Body = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  padding: ${PAD}px;
  overflow: hidden;
`

const Col = styled.div`
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  position: relative;

  & + & {
    margin-left: ${COL_GAP}px;
    &::before {
      content: '';
      position: absolute;
      left: ${-(COL_GAP / 2) - 0.5}px;
      top: 2px;
      bottom: 2px;
      width: 1px;
      background: oklch(1 0 0 / 9%);
    }
  }
`

const Seg = styled.div`
  display: flex;
  flex-direction: column;
`

const GroupHeader = styled.div<{ $type: string }>`
  display: flex;
  align-items: baseline;
  gap: 6px;
  box-sizing: border-box;
  border-bottom: 1px solid ${(p) => `color-mix(in oklch, ${hueOf(p.$type)} 45%, transparent)`};
`

const GroupName = styled.span<{ $type: string }>`
  flex: 1;
  min-width: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  color: ${(p) => hueOf(p.$type)};
  text-shadow: 1px 1px 0 oklch(0 0 0 / 55%);
`

const Cont = styled.span`
  font-weight: 400;
  color: oklch(1 0 0 / 45%);
  letter-spacing: 0.04em;
  text-transform: none;
`

const GroupStats = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  color: oklch(1 0 0 / 68%);
`

const DrawChance = styled.span`
  color: var(--sts-color-aqua);
`

/** One-line stand-in for rows folded away by the squeeze strategy. */
const Summary = styled.div`
  display: flex;
  align-items: center;
  padding-left: 4px;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  color: oklch(1 0 0 / 45%);
`

/** Honest overflow: content that genuinely cannot fit is counted, not clipped. */
const HiddenChip = styled.div`
  position: absolute;
  right: 6px;
  bottom: 5px;
  padding: 1px 7px;
  border-radius: 8px;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  color: var(--sts-color-cream);
  background: oklch(0 0 0 / 55%);
  border: 1px solid oklch(1 0 0 / 18%);
`

/** 'flow' control: CSS multicol + scroll, scrollbar kept out of the layout. */
const FlowColumns = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: ${PAD}px;
  columns: 168px auto;
  column-gap: ${COL_GAP}px;
  column-rule: 1px solid oklch(1 0 0 / 9%);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%);

  &::-webkit-scrollbar {
    width: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 2px;
  }
  &:hover::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 22%);
  }
`

const FlowGroup = styled.div`
  break-inside: avoid;
  page-break-inside: avoid;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
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
