import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import styled from 'styled-components'
import type { Sts2Enemy } from '@shared/types'
import { useFloatingPanel, type PanelPlacement } from '../../hooks/useFloatingPanel'
import { GripDots } from './PanelChrome'
import { attackIntentAsset, BG } from './theme'

/**
 * Incoming-attack summary: total damage + hit count from enemy intents, with a
 * count-up animation. Ported from the original (FTUE onboarding callouts
 * omitted). CombatSide: 1 = Player, 2 = Enemy.
 *
 * Placement works exactly like the movable deck tracker's — same hook, same
 * anchor-plus-offset persistence, same snap guide, same grip mark — because it
 * had the same problem: parked at the right edge, it covers whatever the
 * encounter happens to put there. The one difference is that this panel is
 * content-sized rather than area-defined, so there is no corner to drag; its
 * measured size is fed back to the hook, which needs a real rectangle for the
 * anchor arithmetic and the on-screen clamping.
 */

const PLAYER = 1
const ENEMY = 2
const COUNT_UP_DURATION = 1500
const ANIMATE_DELAY = 200
const FADE_TRANSLATE = '8px'

/** Where the panel sat when it was fixed chrome: 20% down, flush right. */
const DEFAULT_TOP_PCT = 20
/** Superseded by the placement record; still read once so nobody's panel jumps. */
const LEGACY_TOP_PCT_KEY = 'sts2.attackSummary.topPct'
const PLACEMENT_KEY = 'sts2.attackSummary.placement'
/** Rough first-paint guess; a layout effect replaces it with the real box. */
const SEED_W = 96
const SEED_H = 120

export function AttackSummary({
  enemies,
  isCombatInProgress,
  currentSide,
  isObscured
}: {
  enemies: Sts2Enemy[] | null
  isCombatInProgress: boolean
  currentSide?: number
  isObscured: boolean
}): JSX.Element {
  const isReady = useRef(false)
  isReady.current ||= enemies?.some((x) => (x.intents?.length ?? 0) > 0) ?? false

  const { damage, hits } = useStableAttackInfo(enemies, currentSide)

  const defaults = useMemo(legacyPlacement, [])
  const panel = useFloatingPanel(PLACEMENT_KEY, { defaults, minW: 40, minH: 40 })
  const shellRef = useMeasuredSize(panel.setSize)

  const shouldCountUp = useRef<boolean | null>(null)
  if (shouldCountUp.current === null && currentSide === PLAYER && hits > 0) {
    shouldCountUp.current = hits > 1
  }

  const isHidden = !isReady.current || isObscured || !isCombatInProgress
  const p = panel.placement
  // Flush against an edge it is actually snapped to, rounded everywhere else —
  // the old shape was a right-edge tab, and it should stay one only when it is
  // still sitting on the right edge.
  const flush = p.dx !== 0 ? null : p.ax === 'right' ? 'right' : p.ax === 'left' ? 'left' : null

  return (
    <>

      <Container
        ref={shellRef}
        $hidden={isHidden}
        $obscured={isObscured}
        $flush={flush}
        style={{ ...panel.style, width: 'auto', height: 'auto' }}
      >
        <Grip
          className="interactive"
          $active={panel.dragging}
          title="Drag to move"
          onMouseEnter={panel.onEnter}
          onMouseLeave={panel.onLeave}
          {...panel.gripHandlers}
        >
          <GripDots />
        </Grip>
        <strong>Attacks</strong>
        <span>{hits === 0 ? '(None)' : `(${hits} ${hits === 1 ? 'Hit' : 'Hits'})`}</span>
        <Intent style={{ opacity: hits === 0 ? 0.25 : hits === 1 ? 0.5 : 1 }}>
          <img src={attackIntentAsset(damage)} style={{ width: 65, height: 65 }} />
          <DamageValue value={damage} countUp={shouldCountUp.current ?? false} visible={hits > 0} />
        </Intent>
      </Container>
    </>
  )
}

/**
 * The panel's opening position: its old fixed spot, but carrying over a height
 * the user had already dragged it to under the vertical-only scheme. Without
 * this, shipping free placement would silently reset everyone's panel to 20%.
 */
function legacyPlacement(): Partial<PanelPlacement> {
  let dy = DEFAULT_TOP_PCT
  try {
    const raw = localStorage.getItem(LEGACY_TOP_PCT_KEY)
    const n = raw != null ? Number.parseFloat(raw) : NaN
    if (Number.isFinite(n)) dy = Math.min(85, Math.max(0, n))
  } catch {
    /* storage unavailable outside Electron */
  }
  return { ax: 'right', ay: 'top', dx: 0, dy, w: SEED_W, h: SEED_H, free: false }
}

/**
 * Keep the hook's idea of the panel's rectangle in step with the box the
 * browser actually laid out. The hit count changes the width mid-combat, and a
 * stale width would make a right-anchored panel jump the moment it is grabbed.
 */
function useMeasuredSize(setSize: (w: number, h: number) => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = (): void => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setSize(rect.width, rect.height)
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [setSize])
  return ref
}

function useStableAttackInfo(
  enemies: Sts2Enemy[] | null,
  currentSide?: number
): { damage: number; hits: number } {
  let hits = 0
  let damage = 0
  for (const enemy of enemies ?? []) {
    if (!enemy.intents) continue
    for (const intent of enemy.intents) {
      const valueLabel = intent.valueLabel?.replace(/\[.+?\]/g, '') ?? '0'
      if (intent.type.endsWith('SingleAttackIntent') || intent.type.endsWith('DeathBlowIntent')) {
        hits++
        damage += toInt(valueLabel)
      } else if (intent.type.endsWith('MultiAttackIntent')) {
        const [damageValue, hitValue] = valueLabel.split('x').map((x: string) => toInt(x.trim()))
        hits += hitValue
        damage += damageValue * hitValue
      }
    }
  }
  const [stable, setStable] = useState({ damage, hits })
  useEffect(() => {
    if (currentSide === ENEMY) return
    setStable((prev) =>
      prev.damage === damage && prev.hits === hits ? prev : { damage, hits }
    )
  }, [currentSide, damage, hits])
  return stable
}

function toInt(value: string): number {
  const n = Number.parseInt(value)
  return Number.isFinite(n) ? n : 0
}

function useCountUp(target: number, countUp: boolean, duration: number, delay: number): number {
  const [display, setDisplay] = useState(countUp ? 0 : target)
  const targetRef = useRef(target)
  targetRef.current = target
  const animatingRef = useRef(false)
  useEffect(() => {
    if (!countUp) return
    animatingRef.current = true
    setDisplay(0)
    let raf = 0
    let start = 0
    const step = (now: number): void => {
      if (!start) start = now + delay
      const dt = Math.max(now - start, 0)
      const t = Math.min(dt / duration, 1)
      const eased = 1 - (1 - t) * (1 - t)
      setDisplay(Math.round(targetRef.current * eased))
      if (t < 1) raf = requestAnimationFrame(step)
      else animatingRef.current = false
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      animatingRef.current = false
    }
  }, [countUp, duration, delay])
  useEffect(() => {
    if (!animatingRef.current) setDisplay(target)
  }, [target])
  return display
}

const DAMAGE_TEXT_PROPS = {
  x: 4,
  y: 22,
  fontFamily: 'Kreon, serif',
  fontSize: 21,
  stroke: 'oklch(0 0 0 / 40%)',
  strokeWidth: 3
} as const

const DAMAGE_TEXT_STYLE = { letterSpacing: '0.5px' } as const

function DamageValue({
  value,
  countUp,
  visible
}: {
  value: number
  countUp: boolean
  visible: boolean
}): JSX.Element {
  const display = useCountUp(value, countUp, COUNT_UP_DURATION, ANIMATE_DELAY)
  return (
    <svg
      className="damage-value"
      width={60}
      height={30}
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 200ms ease-out' }}
    >
      <text
        {...DAMAGE_TEXT_PROPS}
        fill="oklch(0 0 0 / 40%)"
        style={{ ...DAMAGE_TEXT_STYLE, textShadow: '1.5px 1.5px 0 oklch(0 0 0 / 20%)' }}
      >
        {display}
      </text>
      <text {...DAMAGE_TEXT_PROPS} fill="#fff" paintOrder="stroke" style={DAMAGE_TEXT_STYLE}>
        {display}
      </text>
    </svg>
  )
}

const Container = styled.div<{
  $hidden: boolean
  $obscured: boolean
  $flush: 'left' | 'right' | null
}>`
  position: absolute;

  opacity: ${(p) => (p.$hidden ? 0 : 1)};
  /* A faded-out panel must not keep eating clicks — it is invisible, and now it
     can be anywhere on screen rather than safely parked at the edge. */
  pointer-events: ${(p) => (p.$hidden ? 'none' : 'auto')};
  transform: translateX(${(p) => (p.$hidden ? FADE_TRANSLATE : '0')});
  transition: ${(p) =>
    p.$obscured ? 'none' : 'opacity 200ms ease-out, transform 200ms ease-out'};
  transition-delay: ${(p) => (p.$hidden ? '0ms' : `${ANIMATE_DELAY}ms`)};

  padding: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;

  color: var(--sts-color-cream);
  font-family: Kreon;
  text-shadow: 2px 2px 0 oklch(0 0 0 / 50%);
  letter-spacing: 1px;

  background: ${BG}88;
  border: 1px solid oklch(1 0 0 / 10%);
  border-radius: ${(p) =>
    p.$flush === 'right' ? '8px 0 0 8px' : p.$flush === 'left' ? '0 8px 8px 0' : '8px'};
  ${(p) => (p.$flush === 'right' ? 'border-right: none;' : '')}
  ${(p) => (p.$flush === 'left' ? 'border-left: none;' : '')}
  box-shadow: 7px 7px 0 oklch(0 0 0 / 30%);

  /* Direct children only. These describe the two text lines; as descendant
     selectors they also reached into the grip's dots, halving their opacity
     and pulling 2px out of each row of the mark. */
  > strong {
    color: var(--brand);
    font-size: 20px;
    margin-top: -2px;
  }

  > span {
    opacity: 0.5;
    font-size: 14px;
    margin-top: -2px;
  }
`

/**
 * The drag surface. Same mark and same grab/grabbing language as the tracker's
 * title bar, compressed to a strip: this panel has no title to sit beside, and
 * a full bar would cost more height than a panel this small can spare.
 */
const Grip = styled.div<{ $active: boolean }>`
  pointer-events: auto;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  /* The dot field's box is 9px but it draws 15px tall (each dot's shadow sits
     6px below it), so the padding is what actually centres the mark. */
  box-sizing: border-box;
  height: 18px;
  padding-bottom: 6px;
  margin: -6px -6px 2px -6px;
  cursor: grab;
  opacity: ${(p) => (p.$active ? 1 : 0.4)};
  background: ${(p) => (p.$active ? 'oklch(1 0 0 / 12%)' : 'transparent')};
  border-radius: 6px;
  transition:
    opacity 0.15s ease,
    background 0.15s ease;
  touch-action: none;
  &:hover {
    opacity: 1;
    background: oklch(1 0 0 / 12%);
  }
  &:active {
    cursor: grabbing;
  }
`

const Intent = styled.div`
  position: relative;
  margin: -4px;
  transition: opacity 200ms ease-out;

  .damage-value {
    position: absolute;
    bottom: 0;
    left: 0;
    overflow: visible;
  }
`
