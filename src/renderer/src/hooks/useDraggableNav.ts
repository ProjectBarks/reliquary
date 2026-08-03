import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Vertical drag + hover-interactivity + persistence for a combat nav panel.
 *
 * The overlay window is click-through by default; a panel only receives input
 * while the cursor is over it (onEnter → main makes the window capture clicks,
 * onLeave → hand input back to the game). Dragging adds a wrinkle: if the cursor
 * leaves the panel mid-drag the window would flip back to click-through and the
 * OS would stop delivering mouse events, killing the drag. So while a drag is in
 * progress we suppress the leave-release and keep the window interactive until
 * pointerup.
 *
 * Position is stored as a percentage of the viewport height (0..85). Using a
 * fraction of `innerHeight` keeps it correct under the overlay's zoom factor
 * (both clientY and innerHeight are in the same post-zoom CSS-pixel space), and
 * it survives relaunch via localStorage (per-origin, in the app's userData).
 */
export function useDraggableNav(
  storageKey: string,
  defaultPct: number
): {
  topPct: number
  dragging: boolean
  onEnter: () => void
  onLeave: () => void
  gripHandlers: { onPointerDown: (e: React.PointerEvent) => void }
} {
  const [topPct, setTopPct] = useState(() => readPct(storageKey, defaultPct))
  const [dragging, setDragging] = useState(false)

  const topPctRef = useRef(topPct)
  topPctRef.current = topPct
  const draggingRef = useRef(false)
  const interactive = useRef(false)
  const start = useRef({ y: 0, pct: 0 })

  const setInteractive = useCallback((v: boolean) => {
    if (interactive.current === v) return
    interactive.current = v
    window.spectra?.setInteractive(v)
  }, [])

  const onMove = useCallback((e: PointerEvent) => {
    if (!draggingRef.current) return
    const dyPct = ((e.clientY - start.current.y) / window.innerHeight) * 100
    setTopPct(clamp(start.current.pct + dyPct))
  }, [])

  const onUp = useCallback(() => {
    draggingRef.current = false
    setDragging(false)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    // Reconcile input ownership: the cursor may have ended off the panel.
    if (!isOverInteractive()) setInteractive(false)
  }, [onMove, setInteractive])

  const onGripDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setInteractive(true)
      start.current = { y: e.clientY, pct: topPctRef.current }
      draggingRef.current = true
      setDragging(true)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [onMove, onUp, setInteractive]
  )

  const onEnter = useCallback(() => setInteractive(true), [setInteractive])
  const onLeave = useCallback(() => {
    if (!draggingRef.current) setInteractive(false)
  }, [setInteractive])

  // Persist the resting position once a drag settles (guarded so the write
  // happens on release, not on every mousemove frame).
  useEffect(() => {
    if (!dragging) {
      try {
        localStorage.setItem(storageKey, String(topPctRef.current))
      } catch {
        /* storage may be unavailable outside Electron */
      }
    }
  }, [dragging, storageKey])

  // Release input and detach listeners if we unmount mid-hover/drag.
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setInteractive(false)
    },
    [onMove, onUp, setInteractive]
  )

  return { topPct, dragging, onEnter, onLeave, gripHandlers: { onPointerDown: onGripDown } }
}

function clamp(pct: number): number {
  return Math.min(85, Math.max(0, pct))
}

function readPct(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    const n = raw != null ? Number.parseFloat(raw) : NaN
    return Number.isFinite(n) ? clamp(n) : fallback
  } catch {
    return fallback
  }
}

/** True when the cursor is currently over an opted-in interactive region. */
function isOverInteractive(): boolean {
  const el = document.querySelector('.sts2-overlay .interactive:hover')
  return !!el
}
