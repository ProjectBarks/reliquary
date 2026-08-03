import type { CSSProperties } from 'react'
import styled, { keyframes } from 'styled-components'
import type { Sts2StatPanel } from '@shared/types'

/**
 * Reward / merchant / event / ancient stat panels.
 *
 * These "hover tips" are anchored to the card/relic/potion/choice slots the scry
 * provider locates in live game memory: each panel's x/y is a fractional screen
 * position computed from the item's on-screen control (layoutState). Only the
 * stat rows themselves are placeholder analytics. Uses the original HoverTip
 * styling (border-image webp frame, Kreon, gold headers).
 */

export function StatPanels({ panels }: { panels: Sts2StatPanel[] }): JSX.Element {
  // Match the original: only the item the game reports as hovered shows its full
  // stat tip (renderer `hoveredCard = cards?.find(x => x.isHovered)`), so at most
  // one panel is on screen at a time instead of every item's tip overlapping.
  const visible = panels.filter((p) => p.isHovered)
  return (
    <>
      {visible.map((panel, i) => (
        <Anchor key={`${panel.header}-${i}`} style={anchorStyle(panel)}>
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
      ))}
    </>
  )
}

/**
 * Place the tip BESIDE the item, not on it. `panel.x/y` is the item's centre and
 * `panel.w/h` its size (both screen fractions). Mirroring the original's
 * useHoverTipPosition fallback: align the tip's top to the item's top edge
 * (`y - h/2`) and sit it just off a vertical edge (`x ± w/2`) with a small gap.
 * Items on the left half get the tip on their right; items on the right half get
 * it on their left, so tips never run off-screen. The 12px gap scales with the
 * overlay's zoom factor, so it tracks the game's UI scale.
 */
// Letter-grade palette: A best (green) → F worst (red). Handles "A", "A+", "S", etc.
const TIER_COLORS: Record<string, string> = {
  S: '#7fff00',
  A: '#7fff00',
  B: '#2aebbe',
  C: '#efc851',
  D: '#ffa518',
  E: '#ff5555',
  F: '#ff5555'
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

function anchorStyle(panel: Sts2StatPanel): CSSProperties {
  const top = `${(panel.y - panel.h / 2) * 100}%`
  if (panel.x <= 0.5) {
    return { top, left: `calc(${(panel.x + panel.w / 2) * 100}% + 12px)` }
  }
  return { top, right: `calc(${(1 - (panel.x - panel.w / 2)) * 100}% + 12px)` }
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
