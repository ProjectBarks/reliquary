import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import styled, { keyframes } from 'styled-components'
import type { Sts2LayoutState, Sts2Rect, Sts2StatPanel } from '@shared/types'
// The A–F palette is shared with the Codex tab, which grades the same cards —
// two copies would eventually disagree about what a "B" looks like.
import { TIER_COLORS } from '../../codex/tiers'

/**
 * Reward / merchant / event / ancient stat panels.
 *
 * These "hover tips" are anchored to the card/relic/potion/choice slots the scry
 * provider locates in live game memory: each panel's x/y is a fractional screen
 * position computed from the item's on-screen control (layoutState). Only the
 * stat rows themselves are placeholder analytics. Uses the original HoverTip
 * styling (border-image webp frame, Kreon, gold headers).
 */

export function StatPanels({
  panels,
  gameTips
}: {
  panels: Sts2StatPanel[]
  gameTips?: Sts2LayoutState['gameTips']
}): JSX.Element {
  // Match the original: only the item the game reports as hovered shows its full
  // stat tip (renderer `hoveredCard = cards?.find(x => x.isHovered)`), so at most
  // one panel is on screen at a time instead of every item's tip overlapping.
  const visible = panels.filter((p) => p.isHovered)
  const obstacles = gameTips ? [...gameTips.text, ...gameTips.card] : []
  return (
    <>
      {visible.map((panel, i) => (
        <Panel key={`${panel.header}-${i}`} panel={panel} obstacles={obstacles} />
      ))}
    </>
  )
}

function Panel({
  panel,
  obstacles
}: {
  panel: Sts2StatPanel
  obstacles: Sts2Rect[]
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Start where the old code put it. If measurement or the game's tip rects are
  // unavailable this is also where it stays, so the previous behaviour is the
  // floor rather than a corner-of-the-screen fallback.
  const [style, setStyle] = useState<CSSProperties>(() => besideItemStyle(panel))

  // The placement resolves to PIXELS, so unlike the percentage anchors it used
  // to use it does not survive the viewport changing underneath it — a window
  // resize, or the overlay's zoom factor being re-applied when the game's
  // resolution changes. Both arrive as a resize event; refit on them.
  const [viewport, setViewport] = useState(0)
  useEffect(() => {
    const onResize = (): void => setViewport((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The panel's height depends on its content, so a row arriving (deck advice
  // resolving) has to re-run the fit — hence the content in the key, not just
  // the geometry.
  const fitKey = JSON.stringify([
    viewport,
    panel.x,
    panel.y,
    panel.w,
    panel.h,
    panel.header,
    panel.rows,
    panel.reasons ?? null,
    panel.deckAdvicePending ?? false,
    obstacles
  ])

  // Where we last put it, and for which item. A placement that is still clear
  // is never revised, which is what keeps a 250ms poll from flapping the panel
  // around: the game's tips appear, resize and settle over several frames, so
  // consecutive polls legitimately disagree about how many tips exist and how
  // big they are. Re-deciding on every one of those would move the panel two or
  // three times per hover, which reads worse than the overlap did.
  //
  // Chasing the optimum is the wrong goal here — a tooltip that holds still and
  // is readable beats one that keeps finding a slightly better seat. Only an
  // actual collision earns a move. Keyed per hovered item upstream, so this
  // resets when the player hovers something else; the anchor check covers the
  // case where the same item's own geometry moves.
  const held = useRef<{ anchor: string; left: number; top: number } | null>(null)
  const anchor = `${panel.x},${panel.y},${panel.w},${panel.h}`

  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const parentWidth = parent.clientWidth
    const parentHeight = parent.clientHeight
    if (!parentWidth || !parentHeight) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const boxes = obstacles.map((o) => ({
      left: o.x * parentWidth,
      top: o.y * parentHeight,
      width: o.w * parentWidth,
      height: o.h * parentHeight
    }))

    // Already somewhere that works for this item? Stay there.
    const current = held.current
    if (current && current.anchor === anchor) {
      const box = {
        left: current.left,
        top: current.top,
        width: rect.width,
        height: rect.height
      }
      if (boxes.every((o) => overlapArea(box, o) === 0)) return
    }

    const placed = placePanel(
      panel,
      { width: rect.width, height: rect.height },
      { width: parentWidth, height: parentHeight },
      boxes
    )
    // Replaces the whole style object on purpose: the fallback anchors with
    // `right`, and a leftover `right` alongside a new `left` would stretch the
    // panel across the screen instead of moving it.
    setStyle({ left: placed.left, top: placed.top })
    held.current = { anchor, ...placed }
    // fitKey is the serialised form of `panel` + `obstacles`; both are rebuilt
    // from IPC JSON every poll, so depending on them by identity would re-run
    // this on every tick that changed nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey])

  return (
    <Anchor ref={ref} style={style}>
      <HoverTip>
        <HoverTipBackground />
        <Content>
          <strong>{panel.header}</strong>
          {panel.known === false ? (
            <NoData>No Codex data for this item</NoData>
          ) : (
            <>
              <Table>
                <tbody>
                  {panel.deckAdvicePending && !panel.deckScored ? (
                    <tr>
                      <td>For your deck</td>
                      <td>
                        <LoadingDots />
                      </td>
                    </tr>
                  ) : null}
                  {panel.rows.map(([label, value], r) => (
                    <tr key={r}>
                      <td>{label}</td>
                      <td style={valueStyle(label, value)}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {panel.reasons && panel.reasons.length > 0 && (
                <Reasons>
                  {panel.reasons.slice(0, 4).map((reason, r) => (
                    <li key={r}>{reason}</li>
                  ))}
                </Reasons>
              )}
            </>
          )}
        </Content>
      </HoverTip>
    </Anchor>
  )
}

function tierColor(value: string): string | undefined {
  return TIER_COLORS[value.trim().charAt(0).toUpperCase()]
}

/**
 * Colour the *text* of a stat value (no chips): letter grades by A–F rank, and
 * the deck-conditioned lift green when positive / red when negative.
 */
function valueStyle(label: string, value: string): CSSProperties | undefined {
  // Both the global Tier and the deck-conditioned "For your deck" are A–F grades,
  // coloured the same way (A green → F red).
  if (label === 'Tier' || label === 'For your deck') {
    const c = tierColor(value)
    return c ? { color: c, fontWeight: 400 } : undefined
  }
  return undefined
}

/** Animated three-dot placeholder shown while deck advice is still loading. */
function LoadingDots(): JSX.Element {
  return (
    <Dots title="loading deck advice…" aria-label="loading">
      <span />
      <span />
      <span />
    </Dots>
  )
}

/** Gap between the panel and whatever it sits next to, in overlay pixels. */
const GAP_PX = 12

/**
 * Place the tip BESIDE the item, not on it. `panel.x/y` is the item's centre and
 * `panel.w/h` its size (both screen fractions). Mirroring the original's
 * useHoverTipPosition fallback: align the tip's top to the item's top edge
 * (`y - h/2`) and sit it just off a vertical edge (`x ± w/2`) with a small gap.
 * Items on the left half get the tip on their right; items on the right half get
 * it on their left, so tips never run off-screen. The 12px gap scales with the
 * overlay's zoom factor, so it tracks the game's UI scale.
 *
 * This is the placement used before the game's own tip rects were readable, and
 * it is still the *preferred* one — see `placePanel`. It stays as the pre-layout
 * fallback so nothing flashes in the top-left corner on the first frame.
 */
function besideItemStyle(panel: Sts2StatPanel): CSSProperties {
  const top = `${(panel.y - panel.h / 2) * 100}%`
  if (panel.x <= 0.5) {
    return { top, left: `calc(${(panel.x + panel.w / 2) * 100}% + ${GAP_PX}px)` }
  }
  return { top, right: `calc(${(1 - (panel.x - panel.w / 2)) * 100}% + ${GAP_PX}px)` }
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Area the two boxes share, in square pixels; 0 when they merely touch. */
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Choose where the stat panel goes so it does not cover the game's own tooltip.
 *
 * The problem this solves: the game draws its keyword/relic explanations right
 * beside the hovered item, which is precisely where we were putting ours. Two
 * tooltips stacked on the same pixels leave neither readable, and the game's is
 * the one the player asked for by hovering.
 *
 * Candidates are tried in order of how much they resemble the placement we
 * would have chosen anyway, and the FIRST one that touches nothing wins — so
 * with no game tips on screen (or none in the way) this returns exactly the old
 * position, to the pixel:
 *
 *   1. beside the item, preferred side          ← the historical placement
 *   2. same side, pushed below the tips blocking it
 *   3. same side, pulled above them
 *   4–6. the same three on the item's other side
 *
 * Staying on the preferred side and moving DOWN is tried before crossing to the
 * other side because that is where the eye already is — and because it is what
 * the original companion did: its primary branch stacked its tip directly under
 * the game's, and only went looking for another side when that did not fit.
 *
 * If everything collides — a cramped window where the game's tips span the free
 * space — the least-covered candidate is used rather than hiding the panel:
 * partially covered still beats absent, and absent has no way to explain itself.
 *
 * All coordinates are overlay pixels (the zoom-scaled CSS pixel space the
 * panels already live in), not fractions.
 */
function placePanel(
  panel: Sts2StatPanel,
  size: { width: number; height: number },
  parent: { width: number; height: number },
  obstacles: Box[]
): { left: number; top: number } {
  const { width: parentWidth, height: parentHeight } = parent
  const itemLeft = (panel.x - panel.w / 2) * parentWidth
  const itemRight = (panel.x + panel.w / 2) * parentWidth
  const itemTop = (panel.y - panel.h / 2) * parentHeight
  // Items on the left half get their tip on the right and vice versa, so a tip
  // never runs off the near edge.
  const preferRight = panel.x <= 0.5

  const fit = (left: number, top: number): Box => ({
    left: Math.max(0, Math.min(left, parentWidth - size.width)),
    top: Math.max(0, Math.min(top, parentHeight - size.height)),
    width: size.width,
    height: size.height
  })

  const candidates: Box[] = []
  for (const right of [preferRight, !preferRight]) {
    const left = right ? itemRight + GAP_PX : itemLeft - GAP_PX - size.width
    const beside = fit(left, itemTop)
    candidates.push(beside)
    // Only the tips sharing a vertical band with this candidate can be escaped
    // by moving up or down; one off to the side is not what is in the way.
    const inTheWay = obstacles.filter(
      (o) => o.left < beside.left + beside.width && o.left + o.width > beside.left
    )
    if (inTheWay.length === 0) continue
    const below = Math.max(...inTheWay.map((o) => o.top + o.height)) + GAP_PX
    const above = Math.min(...inTheWay.map((o) => o.top)) - GAP_PX - size.height
    candidates.push(fit(left, below))
    candidates.push(fit(left, above))
  }

  let best = candidates[0] ?? fit(itemRight + GAP_PX, itemTop)
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    let score = 0
    for (const obstacle of obstacles) score += overlapArea(candidate, obstacle)
    if (score === 0) return { left: candidate.left, top: candidate.top }
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return { left: best.left, top: best.top }
}

const Anchor = styled.div`
  position: absolute;
`

const blink = keyframes`
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-1px); }
`

const Dots = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 1em;
  color: var(--brand);
  span {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    animation: ${blink} 1.1s ease-in-out infinite both;
  }
  span:nth-child(2) {
    animation-delay: 0.15s;
  }
  span:nth-child(3) {
    animation-delay: 0.3s;
  }
`

const backgroundUrl = 'https://static.untapped.gg/untapped-companion/sts2/sts2-hover-tip.webp'

const HoverTip = styled.div`
  width: 260px;
  position: relative;
  display: flow-root;
  filter: drop-shadow(9px 9px 0 oklch(0 0 0 / 30%));
`

const HoverTipBackground = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  z-index: -1;
  width: 100%;
  height: 100%;

  border-image: url(${backgroundUrl}) 24 fill / 24px stretch;
  background-image: url(${backgroundUrl});
  background-size: 100% 100%;
  background-repeat: no-repeat;
  filter: brightness(1) saturate(0);
`

const Content = styled.div`
  margin: 12px 21px 18px 21px;
  font-family: Kreon;
  text-shadow: 2px 2px 0 oklch(0 0 0 / 50%);
  letter-spacing: 1px;
  color: #fff6e2;

  strong {
    font-size: 22px;
    font-weight: 400;
    color: var(--brand);
    display: block;
    margin-bottom: 4px;
  }
`

const NoData = styled.div`
  font-size: 15px;
  font-weight: 300;
  color: #8a857c;
  font-style: italic;
`

const Reasons = styled.ul`
  margin: 8px 0 0 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
  font-weight: 300;

  li {
    position: relative;
    padding-left: 12px;
    line-height: 1.35;
    color: #87ceeb;
  }

  li::before {
    content: '›';
    position: absolute;
    left: 0;
    color: var(--brand);
  }
`

const Table = styled.table`
  border-collapse: collapse;
  font-size: 16px;
  font-weight: 300;
  white-space: nowrap;
  width: 100%;

  td {
    padding: 1px 0;
    text-align: right;
  }

  td:first-child {
    text-align: left;
    padding-right: 16px;
  }
`
