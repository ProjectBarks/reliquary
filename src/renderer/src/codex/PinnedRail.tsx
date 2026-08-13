import type { MouseEvent } from 'react'
import { createLink } from '@tanstack/react-router'
import styled from 'styled-components'
import { ChipAnchor } from './parts'
import { useCodexSearch } from './params'
import { unpin, usePins, PIN_MAX } from './prefs'

/**
 * The pinned rail: the handful of things you are actually thinking about,
 * kept one click away from everywhere in the tab.
 *
 * Deck-building is comparative — you are never asking "is this card good", you
 * are asking "is this card better than the four I already have in mind" — and
 * the browse view can only hold one of them on screen at a time. The rail is
 * the working set.
 *
 * It is hidden entirely when empty. An empty dock with a "pin something!" hint
 * would take a permanent bite out of the viewport to advertise a feature to
 * someone who has already seen the ☆ on every detail page.
 */

const PinLink = createLink(ChipAnchor)

export function PinnedRail(): JSX.Element | null {
  const pins = usePins()
  const codexSearch = useCodexSearch()
  if (!pins.length) return null

  return (
    <Rail aria-label={`Pinned (${pins.length} of ${PIN_MAX})`}>
      <Track>
        {pins.map((pin) => (
          <Slot key={`${pin.kind}:${pin.id}`}>
            <PinLink
              to="/codex/browse/$kind/$id"
              params={{ kind: pin.kind, id: pin.id }}
              search={codexSearch}
              title={`${pin.name} — ${pin.kind.slice(0, -1)}`}
              onContextMenu={(e: MouseEvent<HTMLAnchorElement>) => {
                // Right-click unpins. The ✕ is the discoverable way; this is
                // the fast way, and it costs nothing to support both.
                e.preventDefault()
                unpin(pin.kind, pin.id)
              }}
            >
              <Thumb aria-hidden>
                {pin.art ? <img src={pin.art} alt="" loading="lazy" decoding="async" /> : null}
              </Thumb>
              <Name>{pin.name}</Name>
            </PinLink>
            <Unpin
              type="button"
              aria-label={`Unpin ${pin.name}`}
              title="Unpin"
              onClick={() => unpin(pin.kind, pin.id)}
            >
              ✕
            </Unpin>
          </Slot>
        ))}
      </Track>
    </Rail>
  )
}

const Rail = styled.nav`
  flex: 0 0 auto;
  border-top: 1px solid var(--line);
  background: oklch(0 0 0 / 16%);
`

const Track = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 1180px;
  margin: 0 auto;
  padding: 8px 22px;
  overflow-x: auto;
  scrollbar-width: thin;
  &::-webkit-scrollbar {
    height: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 16%);
    border-radius: 3px;
  }
  @media (max-width: 560px) {
    padding: 8px 12px;
  }
`

/**
 * The ✕ sits *outside* the link rather than inside it — a button inside an
 * anchor is invalid, and more practically, an unpin control inside the click
 * target it removes is a control you hit by accident.
 */
const Slot = styled.div`
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;

  &:hover button,
  &:focus-within button {
    opacity: 1;
  }
`

const Unpin = styled.button`
  position: absolute;
  top: -3px;
  right: -3px;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: #26221f;
  color: var(--ink-dim);
  font-size: 9px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.13s ease;
  &:hover {
    color: var(--sts-color-red);
  }
  &:focus-visible {
    opacity: 1;
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`

const Thumb = styled.span`
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  overflow: hidden;
  background: var(--fill);
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
`

const Name = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`
