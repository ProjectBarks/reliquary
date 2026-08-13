import styled, { keyframes } from 'styled-components'
import { useParams } from 'react-router-dom'

/**
 * Home redesign mockups (#/mock/home/:variant — a|b|c). Dev-only harness:
 * three "dead simple" structures rendered in the StS2 title-screen language —
 * painted sky, one luminous landmark, sparse glowing text. Static states.
 */
export function HomeMock(): JSX.Element {
  const { variant } = useParams()
  const v = variant === 'b' ? 'b' : variant === 'c' ? 'c' : 'a'
  return (
    <Sky>
      <Stars />
      {v !== 'c' ? <Spire $lit={v === 'b'} $tone={v === 'b' ? 'ok' : 'idle'} /> : null}
      {v === 'a' ? (
        <Center>
          <Word>Reliquary</Word>
          <StateLine>Watching your run</StateLine>
          <DotRow>
            {[
              ['Game', true],
              ['Overlay', true],
              ['Advisor', true],
              ['Live data', true]
            ].map(([label, on]) => (
              <Dot key={String(label)} $on={!!on}>
                <i />
                {label}
              </Dot>
            ))}
          </DotRow>
        </Center>
      ) : v === 'b' ? (
        <Center>
          <WordSmall>Reliquary</WordSmall>
          <StateLine $big>Watching your run</StateLine>
          <Hint>The spire burns green while everything is connected.</Hint>
        </Center>
      ) : (
        <Center>
          <PanelCard>
            <Word>Reliquary</Word>
            <StateLine>Watching your run</StateLine>
            <Segments>
              {['Game', 'Overlay', 'Advisor', 'Live data'].map((s) => (
                <Seg key={s} $on>
                  {s}
                </Seg>
              ))}
            </Segments>
          </PanelCard>
        </Center>
      )}
    </Sky>
  )
}

const drift = keyframes`0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}`
const glow = keyframes`0%,100%{opacity:.75}50%{opacity:1}`

/** The title screen's painted sky: warm horizon burning up into starry indigo. */
const Sky = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
  background:
    radial-gradient(120% 55% at 50% 118%, #b65f38 0%, #7c3f34 26%, transparent 62%),
    radial-gradient(90% 40% at 18% 108%, #e08a4d 0%, transparent 55%),
    linear-gradient(to top, #3c2436 0%, #251c33 38%, #141327 70%, #0c0c1c 100%);
`

const Stars = styled.div`
  position: absolute;
  inset: 0;
  background-image:
    radial-gradient(1.2px 1.2px at 12% 18%, oklch(1 0 0 / 55%) 50%, transparent 51%),
    radial-gradient(1px 1px at 32% 9%, oklch(1 0 0 / 40%) 50%, transparent 51%),
    radial-gradient(1.4px 1.4px at 58% 14%, oklch(1 0 0 / 50%) 50%, transparent 51%),
    radial-gradient(1px 1px at 76% 24%, oklch(1 0 0 / 38%) 50%, transparent 51%),
    radial-gradient(1.2px 1.2px at 88% 8%, oklch(1 0 0 / 48%) 50%, transparent 51%),
    radial-gradient(1px 1px at 45% 30%, oklch(1 0 0 / 30%) 50%, transparent 51%);
`

/** The landmark. In variant B its light IS the status indicator. */
const Spire = styled.div<{ $lit: boolean; $tone: 'ok' | 'idle' }>`
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 130px;
  height: 66%;
  transform: translateX(-50%);
  clip-path: polygon(50% 0%, 63% 22%, 58% 24%, 70% 58%, 62% 60%, 74% 100%, 26% 100%, 38% 60%, 30% 58%, 42% 24%, 37% 22%);
  background: linear-gradient(to top, #1d1830 0%, #241f3c 55%, #2c2a4e 100%);
  box-shadow: ${(p) =>
    p.$lit
      ? 'inset 3px 0 9px -3px var(--sts-color-green), inset -3px 0 9px -3px var(--sts-color-green)'
      : 'inset 3px 0 9px -4px var(--sts-color-aqua), inset -3px 0 9px -4px var(--sts-color-aqua)'};
  &::after {
    content: '';
    position: absolute;
    left: 50%;
    top: -7px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    transform: translateX(-50%);
    background: ${(p) => (p.$lit ? 'var(--sts-color-green)' : 'var(--sts-color-aqua)')};
    box-shadow: 0 0 18px 5px
      ${(p) =>
        p.$lit
          ? 'color-mix(in oklch, var(--sts-color-green) 55%, transparent)'
          : 'color-mix(in oklch, var(--sts-color-aqua) 55%, transparent)'};
    animation: ${glow} 3.2s ease-in-out infinite;
  }
`

const Center = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  text-align: center;
`

const Word = styled.h1`
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(44px, 7vw, 64px);
  letter-spacing: 0.01em;
  color: var(--sts-color-cream);
  text-shadow:
    0 2px 0 oklch(0 0 0 / 55%),
    0 0 34px oklch(0.7 0.12 300 / 35%);
  animation: ${drift} 7s ease-in-out infinite;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

const WordSmall = styled(Word)`
  font-size: 30px;
  animation: none;
`

const StateLine = styled.p<{ $big?: boolean }>`
  margin: 0;
  font-family: var(--font-display);
  font-size: ${(p) => (p.$big ? '24px' : '16px')};
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--sts-color-gold);
  text-shadow: 0 1px 0 oklch(0 0 0 / 60%);
`

const Hint = styled.p`
  margin: 2px 0 0;
  font-size: 13px;
  color: oklch(1 0 0 / 62%);
`

const DotRow = styled.div`
  display: flex;
  gap: 26px;
  margin-top: 18px;
`

const Dot = styled.span<{ $on: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: oklch(1 0 0 / 72%);
  i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${(p) => (p.$on ? 'var(--sts-color-green)' : 'oklch(1 0 0 / 25%)')};
    box-shadow: ${(p) => (p.$on ? '0 0 8px var(--sts-color-green)' : 'none')};
  }
`

const PanelCard = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 38px 54px 30px;
  border-radius: 14px;
  background: oklch(0.17 0.02 320 / 78%);
  border: 1px solid color-mix(in oklch, var(--sts-color-gold) 38%, transparent);
  box-shadow:
    inset 0 1px 0 oklch(1 0 0 / 8%),
    0 18px 50px oklch(0 0 0 / 50%);
`

const Segments = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 8px;
`

const Seg = styled.span<{ $on: boolean }>`
  font-size: 11.5px;
  letter-spacing: 0.07em;
  padding: 6px 14px;
  border-radius: 999px;
  color: ${(p) => (p.$on ? 'var(--sts-color-cream)' : 'oklch(1 0 0 / 45%)')};
  background: oklch(1 0 0 / 6%);
  border: 1px solid
    ${(p) =>
      p.$on ? 'color-mix(in oklch, var(--sts-color-green) 45%, transparent)' : 'var(--line)'};
`
