import styled from 'styled-components'

/**
 * Corner badge that makes the data source unambiguous. Shows a loud warning
 * ONLY while the overlay is rendering hardcoded stub data (developer build).
 * When live — whether or not the game is detected yet — it renders nothing,
 * keeping the overlay clean; the dashboard surfaces game-detection status.
 */
export function ModeBadge({ mode }: { mode: 'live' | 'stub' }): JSX.Element | null {
  if (mode === 'stub') {
    return <Badge>STUB DATA — not the live game</Badge>
  }
  return null
}

const Badge = styled.div`
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 9999;
  pointer-events: none;
  font-family: Kreon, serif;
  letter-spacing: 1px;
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 6px;
  box-shadow: 4px 4px 0 oklch(0 0 0 / 30%);
  color: #1a1512;
  background: var(--sts-color-orange);
  border: 1px solid oklch(1 0 0 / 10%);
`
