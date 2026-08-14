import { useCallback, useMemo, useRef, useState, type FocusEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import styled from 'styled-components'
import { prefetchArt } from './data'

/**
 * The floating art preview shared by the tier list and the metrics table.
 *
 * Both of those views trade art for density — a table row is a name and eleven
 * numbers, a tier row is sixty small chips — and the cost of that trade is that
 * you stop being able to *see* the card. The preview buys the density back:
 * hover or focus a row and the full render appears beside it, big enough to
 * read, without the layout moving a pixel.
 *
 * It is one component because two implementations would drift, and it flips at
 * the viewport edges because a preview that opens off-screen is a preview that
 * taught you to stop hovering.
 */

const WIDTH = 170
const HEIGHT = 230
/** Breathing room between the anchor and the card, and against the window. */
const GAP = 12
const MARGIN = 8

interface PreviewTarget {
  src: string
  alt: string
  rect: DOMRect
  /** Cursor X at open time when following the cursor; null for keyboard focus. */
  cursorX: number | null
}

export interface ArtPreviewBinding {
  onMouseEnter: (e: MouseEvent<HTMLElement>) => void
  onMouseLeave: () => void
  onFocus: (e: FocusEvent<HTMLElement>) => void
  onBlur: () => void
  /** Present only when the preview follows the cursor. Writes to the DOM, never to state. */
  onMouseMove?: (e: MouseEvent<HTMLElement>) => void
}

export interface ArtPreviewApi {
  /** Spread onto any row/chip that should show art while it is hovered or focused. */
  bind: (src: string | null | undefined, alt: string) => ArtPreviewBinding
  /** Render this once, anywhere in the subtree. It portals itself to the body. */
  preview: JSX.Element | null
}

export interface ArtPreviewOptions {
  /**
   * Keep the preview beside the cursor as it travels along the anchor, instead
   * of parking it at the anchor's edge. The metrics table wants this: a row is
   * the full width of the screen, and a preview pinned to the row's edge sits
   * exactly on top of the name column the reader is trying to read. Vertical
   * placement is unchanged — still centred on the anchor and clamped.
   */
  followCursorX?: boolean
}

export function useArtPreview(options?: ArtPreviewOptions): ArtPreviewApi {
  const followCursorX = options?.followCursorX ?? false
  const [target, setTarget] = useState<PreviewTarget | null>(null)
  /** The floating card's DOM node, moved directly on mousemove — a re-render
   *  per pointer event would rebuild the whole owning view to move one div. */
  const floating = useRef<HTMLDivElement | null>(null)

  const open = useCallback(
    (src: string | null | undefined, alt: string, el: HTMLElement, clientX?: number) => {
      if (!src) return
      prefetchArt(src)
      setTarget({ src, alt, rect: el.getBoundingClientRect(), cursorX: clientX ?? null })
    },
    []
  )

  const close = useCallback(() => setTarget(null), [])

  const bind = useCallback(
    (src: string | null | undefined, alt: string): ArtPreviewBinding => ({
      onMouseEnter: (e) => open(src, alt, e.currentTarget, followCursorX ? e.clientX : undefined),
      onMouseLeave: close,
      onFocus: (e) => open(src, alt, e.currentTarget),
      onBlur: close,
      ...(followCursorX
        ? {
            onMouseMove: (e: MouseEvent<HTMLElement>) => {
              const node = floating.current
              if (node) node.style.left = `${cursorLeft(e.clientX)}px`
            }
          }
        : null)
    }),
    [close, open, followCursorX]
  )

  const preview = useMemo(() => {
    if (!target) return null
    return createPortal(
      <Floating ref={floating} style={place(target.rect, target.cursorX)} aria-hidden>
        <PreviewArt src={target.src} alt={target.alt} />
      </Floating>,
      document.body
    )
  }, [target])

  return { bind, preview }
}

/**
 * Beside the anchor, on whichever side has room; vertically centred on it and
 * clamped to the window. Computed at open time from a live rect rather than
 * tracked with a listener — the anchor cannot move while it is being hovered,
 * and a scroll or resize dismisses the preview by moving the pointer anyway.
 *
 * With a cursor position, the X comes from the cursor instead (see
 * `cursorLeft`); the Y placement is the same either way.
 */
function place(rect: DOMRect, atCursorX: number | null): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const roomRight = vw - rect.right
  const left =
    atCursorX != null
      ? cursorLeft(atCursorX)
      : roomRight >= WIDTH + GAP + MARGIN
        ? rect.right + GAP
        : Math.max(MARGIN, rect.left - WIDTH - GAP)
  const top = Math.min(
    Math.max(MARGIN, rect.top + rect.height / 2 - HEIGHT / 2),
    Math.max(MARGIN, vh - HEIGHT - MARGIN)
  )
  return { left, top }
}

/** Just to the cursor's right; to its left near the window's edge; always on screen. */
function cursorLeft(clientX: number): number {
  const vw = window.innerWidth
  const left = clientX + GAP + WIDTH > vw - MARGIN ? clientX - GAP - WIDTH : clientX + GAP
  return Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - WIDTH - MARGIN))
}

/** Eager, unlike every other image in the tab: it was asked for by a hover. */
const PreviewArt = styled.img.attrs({ decoding: 'async', draggable: false })`
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
`

const Floating = styled.div`
  position: fixed;
  z-index: 70;
  width: ${WIDTH}px;
  height: ${HEIGHT}px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  pointer-events: none;
  border-radius: 12px;
  border: 1px solid var(--line-strong);
  background: #201d1b;
  box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);
`
