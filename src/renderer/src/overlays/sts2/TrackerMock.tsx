import { useState } from 'react'
import styled from 'styled-components'
import { DeckTracker } from './DeckTracker'
import { FIXTURE_PILE, FIXTURE_PILE_SMALL, FIXTURE_CARD_DATA } from './trackerFixture'

/**
 * Design harness for the deck tracker (#/mock/tracker).
 *
 * The real overlay is transparent, click-through, and driven by IPC from a
 * running game, which makes it a slow surface to iterate a layout on. This
 * renders the same component over a game-like backdrop with fixture data, so
 * placement, snapping, resizing and column wrapping can be exercised directly.
 *
 * Development only — not routed in the shipped app.
 */
/**
 * Preset placements shown side by side, so the effect of width on column count
 * — and whether groups survive wrapping — is visible in one look rather than by
 * dragging four times.
 */
const PRESETS = [
  { key: 'mock.a', label: '1 column · left edge', p: { ax: 'left', ay: 'top', dx: 0, dy: 4, w: 210, h: 620, free: false } },
  { key: 'mock.b', label: '2 columns · top right', p: { ax: 'right', ay: 'top', dx: 0, dy: 4, w: 400, h: 340, free: false } },
  { key: 'mock.c', label: '4 columns · bottom centre', p: { ax: 'center', ay: 'bottom', dx: 4, dy: 9, w: 790, h: 330, free: false } }
] as const

export function TrackerMock(): JSX.Element {
  const [small, setSmall] = useState(false)
  const [peek, setPeek] = useState(false)
  const [gallery, setGallery] = useState(true)

  // Seed each preset once so the panels open at the size they are meant to show.
  if (typeof localStorage !== 'undefined') {
    for (const preset of PRESETS) {
      if (!localStorage.getItem(preset.key)) {
        localStorage.setItem(preset.key, JSON.stringify(preset.p))
      }
    }
  }

  if (gallery) {
    return (
      <Stage className="sts2-overlay">
        <Backdrop />
        {PRESETS.map((preset) => (
          <DeckTracker
            key={preset.key}
            storageKey={preset.key}
            pileState={small ? FIXTURE_PILE_SMALL : FIXTURE_PILE}
            cardData={FIXTURE_CARD_DATA}
            isPeekButtonVisible={false}
          />
        ))}
        <Toolbar>
          <button onClick={() => setGallery(false)}>Single panel</button>
          <button onClick={() => setSmall((s) => !s)}>{small ? 'Full pile' : 'Nearly empty'}</button>
          <button
            onClick={() => {
              for (const preset of PRESETS) localStorage.removeItem(preset.key)
              location.reload()
            }}
          >
            Reset
          </button>
          <Note>every panel is the same component at a different width</Note>
        </Toolbar>
      </Stage>
    )
  }

  return (
    <Stage className="sts2-overlay">
      <Backdrop />
      <Toolbar>
        <button onClick={() => setSmall((s) => !s)}>{small ? 'Full pile' : 'Nearly empty'}</button>
        <button onClick={() => setPeek((p) => !p)}>{peek ? 'Peek off' : 'Peek on'}</button>
        <button onClick={() => setGallery(true)}>Gallery</button>
        <button
          onClick={() => {
            localStorage.removeItem('sts2.deckTracker.placement')
            location.reload()
          }}
        >
          Reset placement
        </button>
        <Note>drag the title bar · drag the corner to resize</Note>
      </Toolbar>

      <DeckTracker
        pileState={small ? FIXTURE_PILE_SMALL : FIXTURE_PILE}
        cardData={FIXTURE_CARD_DATA}
        isPeekButtonVisible={peek}
      />
    </Stage>
  )
}

const Stage = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
`

/** Stands in for the game: busy enough to judge contrast against. */
const Backdrop = styled.div`
  position: absolute;
  inset: 0;
  background:
    radial-gradient(60% 50% at 22% 28%, #3a2a45 0%, transparent 70%),
    radial-gradient(50% 45% at 78% 66%, #43301f 0%, transparent 70%),
    linear-gradient(160deg, #171320 0%, #241a26 45%, #120f16 100%);
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    background-image: repeating-linear-gradient(
      115deg,
      oklch(1 0 0 / 3%) 0 2px,
      transparent 2px 26px
    );
  }
`

const Toolbar = styled.div`
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: oklch(0 0 0 / 55%);
  border: 1px solid oklch(1 0 0 / 14%);
  button {
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    color: var(--sts-color-cream);
    background: oklch(1 0 0 / 8%);
    border: 1px solid oklch(1 0 0 / 16%);
    border-radius: 7px;
    padding: 5px 10px;
    &:hover {
      background: oklch(1 0 0 / 14%);
    }
  }
`

const Note = styled.span`
  font-size: 11px;
  color: oklch(1 0 0 / 45%);
  padding-left: 4px;
`
