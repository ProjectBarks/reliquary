import styled, { keyframes } from 'styled-components'
import { useDiagnostics, useTracker } from '../hooks/useIpc'

/**
 * Home: the app's face, and the one screen that answers "is this working?"
 * without asking you to read anything.
 *
 * Four readouts, weighted rather than uniform. Whatever is wrong takes the
 * colour; whatever is fine stays quiet. A grid where every tile shouts equally
 * has to be read left to right every time — this one you glance at, and only a
 * problem stops your eye.
 */
export function Home(): JSX.Element {
  const diag = useDiagnostics()
  const tracker = useTracker()

  const live = diag?.mode !== 'stub'
  const codexReady = diag?.codex?.state === 'ready'
  const gameFound = !!diag?.gameDetected

  const gems: GemData[] = [
    {
      label: 'Game',
      value: gameFound ? 'Found' : 'Waiting',
      tone: gameFound ? 'ok' : 'idle',
      hint: gameFound ? 'reading live state' : (tracker?.target ?? 'Slay the Spire 2')
    },
    {
      label: 'Overlay',
      value: diag?.overlayVisible ? 'On' : diag?.overlayCreated ? 'Hidden' : 'Off',
      tone: diag?.overlayVisible ? 'ok' : diag?.overlayCreated ? 'idle' : 'bad',
      hint: diag?.overlayVisible ? 'drawing over the game' : 'Ctrl+Shift+H to show'
    },
    {
      label: 'Advisor',
      value: codexReady ? 'Ready' : cap(diag?.codex?.state ?? 'idle'),
      tone: codexReady ? 'ok' : 'idle',
      hint: codexReady ? `${diag?.codex?.cardVocab ?? 0} cards primed` : 'loading win rates'
    },
    {
      label: 'Data',
      value: live ? 'Live' : 'Demo',
      tone: live ? 'ok' : 'warn',
      hint: live ? 'from the running game' : 'developer sample data'
    }
  ]

  // Only the headline changes when something is off; the tiles carry the detail.
  // Naming the blocker here means you rarely need to open Settings at all.
  const headline = !live
    ? 'Running on demo data'
    : gameFound
      ? 'Watching your run'
      : 'Waiting for Slay the Spire 2'

  return (
    <Wrap>
      <Hero>
        <Mark viewBox="0 0 24 24" aria-hidden>
          <path d="M12 2.5 L20 7 L20 17 L12 21.5 L4 17 L4 7 Z" />
          <path
            className="facet"
            d="M12 7 L16.2 9.6 L16.2 14.4 L12 17 L7.8 14.4 L7.8 9.6 Z M12 2.5 L12 7 M20 7 L16.2 9.6 M20 17 L16.2 14.4 M12 21.5 L12 17 M4 17 L7.8 14.4 M4 7 L7.8 9.6"
          />
          <circle cx="12" cy="12" r="2.3" style={{ fill: 'var(--brand)', stroke: 'none' }} />
        </Mark>
        <Word>Reliquary</Word>
        <Headline $live={gameFound && live}>{headline}</Headline>
      </Hero>

      <Gems>
        {gems.map((g) => (
          <Gem key={g.label} $tone={g.tone}>
            <GemLabel>{g.label}</GemLabel>
            <GemValue $tone={g.tone}>{g.value}</GemValue>
            <GemHint>{g.hint}</GemHint>
          </Gem>
        ))}
      </Gems>

      <Keys>
        <kbd>Ctrl</kbd>
        <kbd>Shift</kbd>
        <kbd>H</kbd>
        <span>hide or show every overlay</span>
      </Keys>
    </Wrap>
  )
}

/** Raw provider states arrive lowercase; the tiles read as one voice. */
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

type Tone = 'ok' | 'warn' | 'bad' | 'idle'

interface GemData {
  label: string
  value: string
  tone: Tone
  hint: string
}

const toneColor = (t: Tone): string =>
  t === 'ok'
    ? 'var(--sts-color-green)'
    : t === 'warn'
      ? 'var(--sts-color-orange)'
      : t === 'bad'
        ? 'var(--sts-color-red)'
        : 'var(--ink-faint)'

const float = keyframes`
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-5px); }
`

const rise = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: none; }
`

const Wrap = styled.div`
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 44px;
  padding: 48px 28px 56px;
`

const Hero = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  /* The one authored entrance. Everything else is already in place. */
  animation: ${rise} 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

const Mark = styled.svg`
  width: 72px;
  height: 72px;
  fill: none;
  stroke: var(--brand);
  stroke-width: 1.3;
  stroke-linejoin: round;
  filter: drop-shadow(0 6px 20px oklch(0.68 0.19 300 / 45%));
  animation: ${float} 6s ease-in-out infinite;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
  .facet {
    stroke-width: 0.9;
    opacity: 0.55;
  }
`

const Word = styled.h1`
  font-family: var(--font-display);
  font-size: 52px;
  line-height: 1.05;
  letter-spacing: -0.01em;
  margin: 18px 0 0;
  color: var(--ink);
  text-shadow: 3px 3px 0 oklch(0 0 0 / 45%);
`

const Headline = styled.p<{ $live: boolean }>`
  margin: 10px 0 0;
  font-size: 14px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: ${(p) => (p.$live ? 'var(--brand-soft)' : 'var(--ink-dim)')};
`

const Gems = styled.div`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  width: 100%;
  max-width: 660px;
  @media (max-width: 620px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
`

const Gem = styled.div<{ $tone: Tone }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 16px 10px 14px;
  border-radius: 13px;
  background: rgba(38, 35, 33, 0.55);
  border: 1px solid var(--line);
  box-shadow: 5px 5px 0 oklch(0 0 0 / 22%);
  transition:
    transform 0.18s cubic-bezier(0.16, 1, 0.3, 1),
    border-color 0.2s ease;

  /* A problem earns the accent; a healthy tile stays quiet. */
  ${(p) =>
    p.$tone !== 'ok' && p.$tone !== 'idle'
      ? `border-color: color-mix(in oklch, ${toneColor(p.$tone)} 45%, transparent);`
      : ''}

  &:hover {
    transform: translateY(-3px);
    border-color: var(--line-strong);
  }
`

const GemLabel = styled.div`
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink-faint);
`

const GemValue = styled.div<{ $tone: Tone }>`
  font-family: var(--font-display);
  font-size: 24px;
  line-height: 1.15;
  color: ${(p) => (p.$tone === 'ok' || p.$tone === 'idle' ? 'var(--ink)' : toneColor(p.$tone))};
`

const GemHint = styled.div`
  font-size: 11px;
  line-height: 1.35;
  color: var(--ink-faint);
  text-align: center;
`

const Keys = styled.div`
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--ink-dim);
  kbd {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink);
    background: oklch(1 0 0 / 8%);
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    padding: 2px 7px;
  }
  span {
    margin-left: 8px;
  }
`
