import { useCallback, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styled from 'styled-components'
import { useTransientLayer } from './parts'

/**
 * A keyword in a card's text, with its rulebook entry one hover away.
 *
 * Slay the Spire's card text is dense with terms that have exact meanings —
 * Exhaust, Innate, Retain — and a compendium that shows the word without the
 * rule is asking the reader to already know the thing they came here to learn.
 * The term stays inline and marked with a dotted underline (the long-standing
 * "there is more here" convention), so nothing about the sentence changes until
 * you ask.
 *
 * It is reachable by keyboard, because a definition that only exists on hover
 * does not exist for anyone navigating with Tab.
 */

const WIDTH = 280
const GAP = 8
const MARGIN = 8

export function KeywordTerm({
  term,
  description
}: {
  term: string
  description: string
}): JSX.Element {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<{ left: number; top: number } | null>(null)

  const open = useCallback(() => {
    const el = anchor.current
    if (!el) return
    setBox(place(el.getBoundingClientRect()))
  }, [])

  const close = useCallback(() => setBox(null), [])

  return (
    <>
      <Term
        ref={anchor}
        tabIndex={0}
        role="button"
        aria-describedby={box ? id : undefined}
        aria-label={`${term} — keyword`}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        {term}
      </Term>
      {box ? <Tip id={id} term={term} description={description} at={box} onDismiss={close} /> : null}
    </>
  )
}

/**
 * The bubble itself, as its own component so that it can claim the Escape key
 * only while it exists — the layer stack in `parts.tsx` decides which of the
 * open surfaces a keypress belongs to, and a hook cannot be called
 * conditionally.
 */
function Tip({
  id,
  term,
  description,
  at,
  onDismiss
}: {
  id: string
  term: string
  description: string
  at: { left: number; top: number }
  onDismiss: () => void
}): JSX.Element {
  useTransientLayer(onDismiss)
  return createPortal(
    <Bubble id={id} role="tooltip" style={at}>
      <BubbleTerm>{term}</BubbleTerm>
      <BubbleBody>{description}</BubbleBody>
    </Bubble>,
    document.body
  )
}

/**
 * Below the word by default — that is where the eye already is — and above it
 * when the window's bottom edge would clip it. Horizontally clamped so a
 * keyword at the right margin doesn't push the panel off the screen.
 */
function place(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // 200px is a generous guess at the tallest a definition gets; being wrong
  // only costs a flip that wasn't needed, never a clipped panel.
  const estimated = 200
  const below = rect.bottom + GAP
  const top = below + estimated > vh - MARGIN ? Math.max(MARGIN, rect.top - GAP - estimated) : below
  const left = Math.min(Math.max(MARGIN, rect.left - 8), Math.max(MARGIN, vw - WIDTH - MARGIN))
  return { left, top }
}

const Term = styled.span`
  cursor: help;
  border-bottom: 1px dotted currentColor;
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: 2px;
  }
`

const Bubble = styled.div`
  position: fixed;
  z-index: 80;
  width: ${WIDTH}px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--line-strong);
  background: #201d1b;
  box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);
  pointer-events: none;
`

const BubbleTerm = styled.div`
  font-family: var(--font-display);
  font-size: 14px;
  letter-spacing: 0.3px;
  color: var(--sts-color-gold);
  margin-bottom: 3px;
`

const BubbleBody = styled.div`
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-dim);
`
