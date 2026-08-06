import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Free placement + resize for an overlay panel, with edges and corners that
 * attract.
 *
 * The old tracker could only slide up and down the left edge. Freeing it in two
 * axes creates a problem the constrained version never had: the game window
 * changes size (windowed, borderless, a different monitor), and a panel parked
 * at raw pixel coordinates ends up in the wrong place — or off-screen entirely.
 *
 * So placement is stored as an ANCHOR plus an offset, not as a point. A panel
 * snapped to the bottom-right stays in the bottom-right at any resolution; only
 * a deliberately free-floating panel keeps a proportional position. Snapping is
 * therefore not decoration — it is what makes the position durable.
 */

export type AnchorX = 'left' | 'center' | 'right'
export type AnchorY = 'top' | 'middle' | 'bottom'

export interface PanelPlacement {
  /** Which region the panel is pinned to. */
  ax: AnchorX
  ay: AnchorY
  /** Offset from that anchor, as a percentage of the viewport. */
  dx: number
  dy: number
  /** Panel size in CSS px. Width drives how many columns the content uses. */
  w: number
  h: number
  /** True when the last drop landed outside any snap zone. */
  free: boolean
}

/** How close (px) to an edge before it attracts. */
const SNAP_PX = 56
export const MIN_W = 180
export const MAX_W = 900
export const MIN_H = 120

const DEFAULT: PanelPlacement = {
  ax: 'left',
  ay: 'top',
  dx: 0,
  dy: 15,
  w: 268,
  h: 420,
  free: false
}

export interface FloatingPanel {
  placement: PanelPlacement
  dragging: boolean
  resizing: boolean
  /** The snap target the panel would land on right now, for live feedback. */
  snapHint: { ax: AnchorX; ay: AnchorY } | null
  style: React.CSSProperties
  onEnter: () => void
  onLeave: () => void
  gripHandlers: { onPointerDown: (e: React.PointerEvent) => void }
  resizeHandlers: { onPointerDown: (e: React.PointerEvent) => void }
  reset: () => void
}

export function useFloatingPanel(storageKey: string): FloatingPanel {
  const [placement, setPlacement] = useState<PanelPlacement>(() => read(storageKey))
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [snapHint, setSnapHint] = useState<{ ax: AnchorX; ay: AnchorY } | null>(null)

  const ref = useRef(placement)
  ref.current = placement
  const mode = useRef<'idle' | 'drag' | 'resize'>('idle')
  const interactive = useRef(false)
  const origin = useRef({ x: 0, y: 0, rect: { left: 0, top: 0, w: 0, h: 0 } })

  const setInteractive = useCallback((v: boolean) => {
    if (interactive.current === v) return
    interactive.current = v
    window.spectra?.setInteractive(v)
  }, [])

  /** Live pixel rect of the panel, derived from the stored anchor. */
  const rectOf = useCallback((p: PanelPlacement): { left: number; top: number } => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const x = (p.dx / 100) * vw
    const y = (p.dy / 100) * vh
    const left = p.ax === 'left' ? x : p.ax === 'right' ? vw - p.w - x : (vw - p.w) / 2 + x
    const top = p.ay === 'top' ? y : p.ay === 'bottom' ? vh - p.h - y : (vh - p.h) / 2 + y
    return { left, top }
  }, [])

  const onMove = useCallback(
    (e: PointerEvent) => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const o = origin.current

      if (mode.current === 'resize') {
        // Resize away from whichever corner the panel is anchored at, so the
        // anchored edge stays put and the panel grows into open space.
        const signX = ref.current.ax === 'right' ? -1 : 1
        const signY = ref.current.ay === 'bottom' ? -1 : 1
        const w = clamp(o.rect.w + (e.clientX - o.x) * signX, MIN_W, Math.min(MAX_W, vw - 24))
        const h = clamp(o.rect.h + (e.clientY - o.y) * signY, MIN_H, vh - 24)
        setPlacement((p) => ({ ...p, w, h }))
        return
      }
      if (mode.current !== 'drag') return

      const left = o.rect.left + (e.clientX - o.x)
      const top = o.rect.top + (e.clientY - o.y)
      const { ax, ay, snapped } = nearestAnchor(left, top, ref.current.w, ref.current.h, vw, vh)
      setSnapHint(snapped ? { ax, ay } : null)
      setPlacement((p) => toPlacement(p, left, top, vw, vh, ax, ay, snapped))
    },
    []
  )

  const onUp = useCallback(() => {
    mode.current = 'idle'
    setDragging(false)
    setResizing(false)
    setSnapHint(null)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (!isOverInteractive()) setInteractive(false)
  }, [onMove, setInteractive])

  const begin = useCallback(
    (e: React.PointerEvent, next: 'drag' | 'resize') => {
      e.preventDefault()
      e.stopPropagation()
      setInteractive(true)
      const r = rectOf(ref.current)
      origin.current = {
        x: e.clientX,
        y: e.clientY,
        rect: { left: r.left, top: r.top, w: ref.current.w, h: ref.current.h }
      }
      mode.current = next
      if (next === 'drag') setDragging(true)
      else setResizing(true)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [onMove, onUp, rectOf, setInteractive]
  )

  // Persist once movement settles, not on every frame.
  useEffect(() => {
    if (dragging || resizing) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(ref.current))
    } catch {
      /* storage unavailable outside Electron */
    }
  }, [dragging, resizing, storageKey])

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setInteractive(false)
    },
    [onMove, onUp, setInteractive]
  )

  const p = placement
  const style: React.CSSProperties = {
    width: p.w,
    height: p.h,
    ...(p.ax === 'left'
      ? { left: `${p.dx}%` }
      : p.ax === 'right'
        ? { right: `${p.dx}%` }
        : { left: '50%', marginLeft: `calc(${p.dx}% - ${p.w / 2}px)` }),
    ...(p.ay === 'top'
      ? { top: `${p.dy}%` }
      : p.ay === 'bottom'
        ? { bottom: `${p.dy}%` }
        : { top: '50%', marginTop: `calc(${p.dy}% - ${p.h / 2}px)` })
  }

  return {
    placement,
    dragging,
    resizing,
    snapHint,
    style,
    onEnter: useCallback(() => setInteractive(true), [setInteractive]),
    onLeave: useCallback(() => {
      if (mode.current === 'idle') setInteractive(false)
    }, [setInteractive]),
    gripHandlers: { onPointerDown: (e) => begin(e, 'drag') },
    resizeHandlers: { onPointerDown: (e) => begin(e, 'resize') },
    reset: useCallback(() => setPlacement(DEFAULT), [])
  }
}

/**
 * Which anchor a rect at (left, top) should adopt.
 *
 * Distance to each edge decides it; the centre is only chosen when the panel is
 * genuinely near the middle on that axis, so "centre" never wins by accident
 * from being merely not-near-an-edge.
 */
function nearestAnchor(
  left: number,
  top: number,
  w: number,
  h: number,
  vw: number,
  vh: number
): { ax: AnchorX; ay: AnchorY; snapped: boolean } {
  const distLeft = left
  const distRight = vw - (left + w)
  const distTop = top
  const distBottom = vh - (top + h)
  const centreX = Math.abs(left + w / 2 - vw / 2)
  const centreY = Math.abs(top + h / 2 - vh / 2)

  let ax: AnchorX = 'left'
  let snappedX = false
  if (distLeft <= SNAP_PX && distLeft <= distRight) {
    ax = 'left'
    snappedX = true
  } else if (distRight <= SNAP_PX) {
    ax = 'right'
    snappedX = true
  } else if (centreX <= SNAP_PX) {
    ax = 'center'
    snappedX = true
  }

  let ay: AnchorY = 'top'
  let snappedY = false
  if (distTop <= SNAP_PX && distTop <= distBottom) {
    ay = 'top'
    snappedY = true
  } else if (distBottom <= SNAP_PX) {
    ay = 'bottom'
    snappedY = true
  } else if (centreY <= SNAP_PX) {
    ay = 'middle'
    snappedY = true
  }

  // An un-snapped axis keeps a proportional position, expressed from whichever
  // side it is nearer to, so it drifts sensibly when the window resizes.
  if (!snappedX) ax = left + w / 2 < vw / 2 ? 'left' : 'right'
  if (!snappedY) ay = top + h / 2 < vh / 2 ? 'top' : 'bottom'
  return { ax, ay, snapped: snappedX || snappedY }
}

function toPlacement(
  prev: PanelPlacement,
  left: number,
  top: number,
  vw: number,
  vh: number,
  ax: AnchorX,
  ay: AnchorY,
  snapped: boolean
): PanelPlacement {
  const clampedLeft = clamp(left, 0, Math.max(0, vw - prev.w))
  const clampedTop = clamp(top, 0, Math.max(0, vh - prev.h))
  const dx =
    ax === 'left'
      ? (clampedLeft / vw) * 100
      : ax === 'right'
        ? ((vw - prev.w - clampedLeft) / vw) * 100
        : ((clampedLeft + prev.w / 2 - vw / 2) / vw) * 100
  const dy =
    ay === 'top'
      ? (clampedTop / vh) * 100
      : ay === 'bottom'
        ? ((vh - prev.h - clampedTop) / vh) * 100
        : ((clampedTop + prev.h / 2 - vh / 2) / vh) * 100
  // Snapping pulls the offset to zero on the snapped axes; that is what makes
  // the panel sit flush rather than a few stray pixels off the edge.
  return {
    ...prev,
    ax,
    ay,
    dx: snapped && ax !== 'center' && Math.abs(dx) < (SNAP_PX / vw) * 100 ? 0 : dx,
    dy: snapped && ay !== 'middle' && Math.abs(dy) < (SNAP_PX / vh) * 100 ? 0 : dy,
    free: !snapped
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function read(key: string): PanelPlacement {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return DEFAULT
    const p = JSON.parse(raw) as Partial<PanelPlacement>
    return {
      ...DEFAULT,
      ...p,
      w: clamp(Number(p.w) || DEFAULT.w, MIN_W, MAX_W),
      h: clamp(Number(p.h) || DEFAULT.h, MIN_H, 4000)
    }
  } catch {
    return DEFAULT
  }
}

/** True when the cursor is over an opted-in interactive region. */
function isOverInteractive(): boolean {
  return !!document.querySelector('.sts2-overlay .interactive:hover')
}
