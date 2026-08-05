import styled, { keyframes } from 'styled-components'
import type { DiagnosticsState } from '@shared/types'
import { useDiagnostics, useTracker } from '../hooks/useIpc'

/**
 * Home: the one screen a stranger sees first, and the only place they can work
 * out whether this thing is working.
 *
 * It is state-driven rather than a fixed readout. Someone who has just clicked
 * past a SmartScreen warning and launched an app that draws nothing visible
 * needs one sentence telling them what to do next — the previous version showed
 * "Overlay: On" while the screen was empty, which is technically true and
 * actively misleading. Waiting now reads as waiting, not as a fault; only a real
 * fault takes colour.
 */

type Phase = 'broken' | 'demo' | 'waiting' | 'degraded' | 'connected'

interface AppState {
  phase: Phase
  /** The one line that names what is happening. */
  headline: string
  /** What to do next, when there is something. Absent once nothing is required. */
  action: string | null
}

function readPhase(diag: DiagnosticsState | null, target: string): AppState {
  const live = diag?.mode !== 'stub'

  if (live && diag && !diag.scryModuleLoaded) {
    return {
      phase: 'broken',
      headline: 'Can’t read the game',
      action: 'Open Settings → Technical details and copy a report, so this can be fixed.'
    }
  }
  if (!live) {
    return {
      phase: 'demo',
      headline: 'Showing demo data',
      action: 'Nothing here comes from a real game — this build was started in demo mode.'
    }
  }
  if (!diag?.gameDetected) {
    return {
      phase: 'waiting',
      headline: `Waiting for ${target}`,
      action: `Start ${target}. Reliquary draws on top of the game window, not in here.`
    }
  }
  if (diag.codex?.error) {
    return {
      phase: 'degraded',
      headline: 'Watching your run',
      action: 'Card win rates are unavailable right now. The overlays still work.'
    }
  }
  return { phase: 'connected', headline: 'Watching your run', action: null }
}

export function Home(): JSX.Element {
  const diag = useDiagnostics()
  const tracker = useTracker()
  const target = tracker?.target ?? 'Slay the Spire 2'
  const state = readPhase(diag ?? null, target)

  const live = diag?.mode !== 'stub'
  const gameFound = !!diag?.gameDetected
  const codexReady = diag?.codex?.state === 'ready'
  const codexFailed = !!diag?.codex?.error

  const gems: GemData[] = [
    {
      label: 'Game',
      value: gameFound ? 'Found' : 'Waiting',
      tone: gameFound ? 'ok' : 'idle',
      hint: gameFound ? 'reading live state' : 'not running yet'
    },
    {
      // Before the game is running the overlay is on but covering nothing, so
      // "On" reads as a contradiction. "Ready" is the honest word for that.
      label: 'Overlay',
      value: !diag?.overlayCreated
        ? 'Off'
        : !diag.overlayVisible
          ? 'Hidden'
          : gameFound
            ? 'Showing'
            : 'Ready',
      tone: !diag?.overlayCreated ? 'bad' : 'ok',
      hint: !diag?.overlayCreated
        ? 'window failed to open'
        : !diag.overlayVisible
          ? 'Ctrl+Shift+H to show'
          : gameFound
            ? 'drawing over the game'
            : 'waiting for the game'
    },
    {
      label: 'Advisor',
      value: codexFailed ? 'Offline' : codexReady ? 'Ready' : 'Loading',
      tone: codexFailed ? 'warn' : 'ok',
      hint: codexFailed
        ? 'win rates unavailable'
        : codexReady
          ? `${diag?.codex?.cardVocab ?? 0} cards primed`
          : 'fetching win rates'
    },
    {
      label: 'Data',
      value: live ? 'Live' : 'Demo',
      tone: live ? 'ok' : 'warn',
      hint: live ? 'from the running game' : 'developer sample data'
    }
  ]

  return (
    <Wrap>
      <Middle>
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
          <Headline $phase={state.phase}>{state.headline}</Headline>
          {state.action ? <Action $phase={state.phase}>{state.action}</Action> : null}
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

        {/* An expert affordance. It only earns the newcomer's sightline once
            there is actually an overlay on screen to hide. */}
        {gameFound ? (
          <Keys>
            <kbd>Ctrl</kbd>
            <kbd>Shift</kbd>
            <kbd>H</kbd>
            <span>hide or show every overlay</span>
          </Keys>
        ) : null}
      </Middle>
    </Wrap>
  )
}

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
  padding: 40px 28px 48px;
  @media (max-width: 520px) {
    padding: 28px 18px 36px;
  }
`

/**
 * `margin: auto` rather than `justify-content: center`: a centred flex child
 * overflows equally in both directions, which puts the top of the content above
 * the scroll origin and makes it unreachable in a short window.
 */
const Middle = styled.div`
  margin: auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 40px;
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
  @media (max-width: 520px) {
    width: 58px;
    height: 58px;
  }
`

const Word = styled.h1`
  font-family: var(--font-display);
  font-size: clamp(38px, 6vw, 52px);
  line-height: 1.05;
  letter-spacing: -0.01em;
  margin: 18px 0 0;
  color: var(--ink);
  text-shadow: 3px 3px 0 oklch(0 0 0 / 45%);
`

const Headline = styled.p<{ $phase: Phase }>`
  margin: 10px 0 0;
  font-size: 14px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: ${(p) =>
    p.$phase === 'broken'
      ? 'var(--sts-color-red)'
      : p.$phase === 'demo'
        ? 'var(--sts-color-orange)'
        : p.$phase === 'connected' || p.$phase === 'degraded'
          ? 'var(--brand-soft)'
          : 'var(--ink-dim)'};
`

/**
 * The sentence that turns a status screen into an instruction. Measure is held
 * well inside the reading maximum because it is read at a glance, not settled
 * into.
 */
const Action = styled.p<{ $phase: Phase }>`
  margin: 12px 0 0;
  max-width: 44ch;
  font-size: 13.5px;
  line-height: 1.55;
  color: ${(p) => (p.$phase === 'broken' ? 'var(--ink)' : 'var(--ink-dim)')};
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

  /* A problem earns the accent; waiting and healthy both stay quiet. */
  ${(p) =>
    p.$tone === 'warn' || p.$tone === 'bad'
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
  color: ${(p) => (p.$tone === 'warn' || p.$tone === 'bad' ? toneColor(p.$tone) : 'var(--ink)')};
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
