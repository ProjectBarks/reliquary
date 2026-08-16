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
 * parked near the bottom-right stays measured from the bottom-right at any
 * resolution. The anchor is pure bookkeeping: dragging never snaps or pulls
 * toward it (magnetic edges were tried and removed — they made dragging feel
 * broken); the panel sits exactly where it is dropped.
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
  /** Kept for stored-placement compatibility; always true since snapping was removed. */
  free: boolean
}

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

export interface FloatingPanelOptions {
  /**
   * Where the panel sits before the user has ever moved it. Each panel's
   * default is its old fixed anchor, so turning free placement on moves
   * nothing until someone drags it.
   */
  defaults?: Partial<PanelPlacement>
  /**
   * Size floor. The tracker's minimum exists because its columns need room;
   * a content-sized panel (the attack forecast) is smaller than that and
   * would be clamped to a rectangle it never occupies, which would throw off
   * the anchor arithmetic that positions it.
   */
  minW?: number
  minH?: number
}

export interface FloatingPanel {
  placement: PanelPlacement
  dragging: boolean
  resizing: boolean
  style: React.CSSProperties
  onEnter: () => void
  onLeave: () => void
  gripHandlers: { onPointerDown: (e: React.PointerEvent) => void }
  resizeHandlers: { onPointerDown: (e: React.PointerEvent) => void }
  reset: () => void
  /**
   * Overwrite the stored size, synchronously enough that a resize begun in the
   * same event reads it. The tracker calls this with its VISIBLE (hugged) size
   * on resize-start, so the drag grows from the edge under the cursor instead
   * of popping out to a stale desired rectangle.
   */
  setSize: (w: number, h: number) => void
  /**
   * Report the RENDERED box when it is smaller than the stored placement (the
   * deck tracker's area-budget model). Pure ref write — call it every render;
   * it never re-renders. All drag/position math then uses this box, which is
   * the one the user is actually dragging.
   */
  syncVisual: (w: number, h: number) => void
}

export function useFloatingPanel(
  storageKey: string,
  options: FloatingPanelOptions = {}
): FloatingPanel {
  const base: PanelPlacement = { ...DEFAULT, ...options.defaults }
  const minW = options.minW ?? MIN_W
  const minH = options.minH ?? MIN_H

  const [placement, setPlacement] = useState<PanelPlacement>(() => read(storageKey, base, minW, minH))
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)

  const ref = useRef(placement)
  ref.current = placement
  // Read inside pointer handlers, which are bound once for the life of a drag —
  // closing over the values directly would change their identity and break the
  // listener teardown.
  const limits = useRef({ base, minW, minH })
  limits.current = { base, minW, minH }
  const mode = useRef<'idle' | 'drag' | 'resize'>('idle')
  const interactive = useRef(false)
  const origin = useRef({ x: 0, y: 0, rect: { left: 0, top: 0, w: 0, h: 0 } })
  /**
   * The RENDERED box, when it differs from the stored placement. The deck
   * tracker's placement is an area budget ("the space it may use") while its
   * shell shrinks to the packed content — but every pixel a drag computes is
   * about the box on screen. Doing right/bottom-anchored math with the area
   * width while the CSS positions the smaller shell made the panel jump by
   * (area − content) at drag start and every time the anchor flipped mid-drag:
   * the "random teleport" bug. Consumers whose rendered box IS the placement
   * never call syncVisual and nothing changes for them.
   */
  const visual = useRef<{ w: number; h: number } | null>(null)

  const setInteractive = useCallback((v: boolean) => {
    if (interactive.current === v) return
    interactive.current = v
    window.spectra?.setInteractive(v)
  }, [])

  /** Live pixel rect of the panel — the box on screen, not the stored area. */
  const rectOf = useCallback((p: PanelPlacement): { left: number; top: number } => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = visual.current?.w ?? p.w
    const h = visual.current?.h ?? p.h
    const x = (p.dx / 100) * vw
    const y = (p.dy / 100) * vh
    const left = p.ax === 'left' ? x : p.ax === 'right' ? vw - w - x : (vw - w) / 2 + x
    const top = p.ay === 'top' ? y : p.ay === 'bottom' ? vh - h - y : (vh - h) / 2 + y
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
        const { minW: lo, minH: loH } = limits.current
        const w = clamp(o.rect.w + (e.clientX - o.x) * signX, lo, Math.min(MAX_W, vw - 24))
        const h = clamp(o.rect.h + (e.clientY - o.y) * signY, loH, vh - 24)
        setPlacement((p) => ({ ...p, w, h }))
        return
      }
      if (mode.current !== 'drag') return

      const left = o.rect.left + (e.clientX - o.x)
      const top = o.rect.top + (e.clientY - o.y)
      const vw2 = visual.current?.w ?? ref.current.w
      const vh2 = visual.current?.h ?? ref.current.h
      const { ax, ay } = nearestAnchor(left, top, vw2, vh2, vw, vh)
      setPlacement((p) => toPlacement(p, left, top, vw, vh, ax, ay, vw2, vh2))
    },
    []
  )

  const onUp = useCallback(() => {
    mode.current = 'idle'
    setDragging(false)
    setResizing(false)
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
    style,
    onEnter: useCallback(() => setInteractive(true), [setInteractive]),
    onLeave: useCallback(() => {
      if (mode.current === 'idle') setInteractive(false)
    }, [setInteractive]),
    gripHandlers: { onPointerDown: (e) => begin(e, 'drag') },
    resizeHandlers: { onPointerDown: (e) => begin(e, 'resize') },
    reset: useCallback(() => setPlacement(limits.current.base), []),
    setSize: useCallback((w: number, h: number) => {
      // No-op guard, not an optimisation: a content-sized panel reports its
      // measured size back through here, and an unconditional setState would
      // re-render, re-measure, and never settle.
      if (ref.current.w === w && ref.current.h === h) return
      // Mutate the ref too: begin() runs in the same tick and reads it before
      // React commits the state update.
      ref.current = { ...ref.current, w, h }
      setPlacement(ref.current)
    }, []),
    syncVisual: useCallback((w: number, h: number) => {
      visual.current = { w, h }
    }, [])
  }
}

/**
 * Which anchor a rect at (left, top) should adopt.
 *
 * The anchor is bookkeeping, not behavior: it decides which side the stored
 * offset is measured from so the panel drifts sensibly across resolution and
 * window changes. It never moves the panel — snapping was removed after real
 * use found the magnetic pull toward edges made dragging feel broken; the
 * panel now sits exactly where it is dropped.
 */
function nearestAnchor(
  left: number,
  top: number,
  w: number,
  h: number,
  vw: number,
  vh: number
): { ax: AnchorX; ay: AnchorY } {
  return {
    ax: left + w / 2 < vw / 2 ? 'left' : 'right',
    ay: top + h / 2 < vh / 2 ? 'top' : 'bottom'
  }
}

function toPlacement(
  prev: PanelPlacement,
  left: number,
  top: number,
  vw: number,
  vh: number,
  ax: AnchorX,
  ay: AnchorY,
  // The box actually on screen. Defaults to the stored size; the deck tracker
  // passes its shrunk-to-content shell so anchored math matches what the eye
  // is dragging (see the `visual` ref).
  boxW: number = prev.w,
  boxH: number = prev.h
): PanelPlacement {
  const clampedLeft = clamp(left, 0, Math.max(0, vw - boxW))
  const clampedTop = clamp(top, 0, Math.max(0, vh - boxH))
  const dx =
    ax === 'left'
      ? (clampedLeft / vw) * 100
      : ax === 'right'
        ? ((vw - boxW - clampedLeft) / vw) * 100
        : ((clampedLeft + boxW / 2 - vw / 2) / vw) * 100
  const dy =
    ay === 'top'
      ? (clampedTop / vh) * 100
      : ay === 'bottom'
        ? ((vh - boxH - clampedTop) / vh) * 100
        : ((clampedTop + boxH / 2 - vh / 2) / vh) * 100
  return { ...prev, ax, ay, dx, dy, free: true }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function read(key: string, base: PanelPlacement, minW: number, minH: number): PanelPlacement {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return base
    const p = JSON.parse(raw) as Partial<PanelPlacement>
    return {
      ...base,
      ...p,
      w: clamp(Number(p.w) || base.w, minW, MAX_W),
      h: clamp(Number(p.h) || base.h, minH, 4000)
    }
  } catch {
    return base
  }
}

/** True when the cursor is over an opted-in interactive region. */
function isOverInteractive(): boolean {
  return !!document.querySelector('.sts2-overlay .interactive:hover')
}
