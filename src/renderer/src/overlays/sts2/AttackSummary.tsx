import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import type { Sts2Enemy } from '@shared/types'
import { useDraggableNav } from '../../hooks/useDraggableNav'
import { attackIntentAsset, BG } from './theme'

/**
 * Incoming-attack summary: total damage + hit count from enemy intents, with a
 * count-up animation. Ported from the original (FTUE onboarding callouts
 * omitted). CombatSide: 1 = Player, 2 = Enemy.
 */

const PLAYER = 1
const ENEMY = 2
const COUNT_UP_DURATION = 1500
const ANIMATE_DELAY = 200
const FADE_TRANSLATE = '8px'
const TOP_OFFSET = '20%'

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
  const nav = useDraggableNav('sts2.attackSummary.topPct', 20)

  const shouldCountUp = useRef<boolean | null>(null)
  if (shouldCountUp.current === null && currentSide === PLAYER && hits > 0) {
    shouldCountUp.current = hits > 1
  }

  const isHidden = !isReady.current || isObscured || !isCombatInProgress

  return (
    <Container $hidden={isHidden} $obscured={isObscured} style={{ top: `${nav.topPct}%` }}>
      <Grip
        className="interactive"
        title="Drag to move vertically"
        onMouseEnter={nav.onEnter}
        onMouseLeave={nav.onLeave}
        {...nav.gripHandlers}
      >
        {'\u2807'}
      </Grip>
      <strong>Attacks</strong>
      <span>{hits === 0 ? '(None)' : `(${hits} ${hits === 1 ? 'Hit' : 'Hits'})`}</span>
      <Intent style={{ opacity: hits === 0 ? 0.25 : hits === 1 ? 0.5 : 1 }}>
        <img src={attackIntentAsset(damage)} style={{ width: 65, height: 65 }} />
        <DamageValue value={damage} countUp={shouldCountUp.current ?? false} visible={hits > 0} />
      </Intent>
    </Container>
  )
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

const Container = styled.div<{ $hidden: boolean; $obscured: boolean }>`
  position: absolute;
  top: ${TOP_OFFSET};
  right: 0;

  opacity: ${(p) => (p.$hidden ? 0 : 1)};
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
  border-radius: 8px 0 0 8px;
  border: 1px solid oklch(1 0 0 / 10%);
  border-right: none;
  box-shadow: 7px 7px 0 oklch(0 0 0 / 30%);

  strong {
    color: var(--brand);
    font-size: 20px;
    margin-top: -2px;
  }

  span {
    opacity: 0.5;
    font-size: 14px;
    margin-top: -2px;
  }
`

const Grip = styled.div`
  pointer-events: auto;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 14px;
  margin: -6px -6px 2px -6px;
  cursor: grab;
  font-size: 14px;
  line-height: 1;
  color: var(--sts-color-cream);
  opacity: 0.3;
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
