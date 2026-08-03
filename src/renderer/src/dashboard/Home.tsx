import styled, { keyframes } from 'styled-components'
import { useDiagnostics, useTracker } from '../hooks/useIpc'

/**
 * Home tab: the app's "face" — branding + at-a-glance health, styled to match
 * the in-game overlays. No controls or raw data here; those live under Debug.
 */
export function Home(): JSX.Element {
  const diag = useDiagnostics()
  const tracker = useTracker()

  const live = diag?.mode !== 'stub'
  const codexReady = diag?.codex?.state === 'ready'

  const gems: GemData[] = [
    {
      label: 'Data',
      value: live ? 'Live' : 'Stub',
      ok: live,
      hint: live ? 'reading the game' : 'developer demo data'
    },
    {
      label: 'Game',
      value: diag?.gameDetected ? 'Found' : 'Waiting',
      ok: !!diag?.gameDetected,
      hint: tracker?.target ?? 'Slay the Spire 2'
    },
    {
      label: 'Overlay',
      value: diag?.overlayVisible ? 'On' : 'Off',
      ok: !!diag?.overlayVisible,
      hint: diag?.overlayCreated ? 'window ready' : 'not created'
    },
    {
      label: 'Codex',
      value: codexReady ? 'Ready' : (diag?.codex?.state ?? 'idle'),
      ok: codexReady,
      hint: codexReady ? `${diag?.codex?.cardVocab ?? 0} cards primed` : 'advisor snapshot'
    }
  ]

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
        <Tag>Slay the Spire 2 companion</Tag>
      </Hero>

      <Gems>
        {gems.map((g) => (
          <Gem key={g.label} $ok={g.ok}>
            <Dot $ok={g.ok} />
            <GemLabel>{g.label}</GemLabel>
            <GemValue>{g.value}</GemValue>
            <GemHint>{g.hint}</GemHint>
          </Gem>
        ))}
      </Gems>

      <Keys>
        <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>
        <span>hide / show all overlays</span>
      </Keys>
    </Wrap>
  )
}

interface GemData {
  label: string
  value: string
  ok: boolean
  hint: string
}

const float = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
`

const Wrap = styled.div`
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 34px;
  padding: 40px 28px;
`

const Hero = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
`

const Mark = styled.svg`
  width: 64px;
  height: 64px;
  fill: none;
  stroke: var(--brand);
  stroke-width: 1.3;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 14px oklch(0.68 0.19 300 / 60%));
  animation: ${float} 5s ease-in-out infinite;
  .facet {
    stroke-width: 0.9;
    opacity: 0.6;
  }
`

const Word = styled.h1`
  font-family: 'Kreon', serif;
  font-size: 46px;
  letter-spacing: 1px;
  margin: 14px 0 0;
  color: var(--sts-color-cream);
  text-shadow: 3px 3px 0 oklch(0 0 0 / 45%);
  span {
    color: var(--brand);
  }
`

const Tag = styled.p`
  margin: 6px 0 0;
  font-size: 14px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: #9c9384;
`

const Gems = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  width: 100%;
  max-width: 720px;
  @media (max-width: 640px) {
    grid-template-columns: repeat(2, 1fr);
  }
`

const Gem = styled.div<{ $ok: boolean }>`
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 18px 12px 16px;
  border-radius: 14px;
  background: rgba(38, 35, 33, 0.6);
  border: 1px solid
    ${(p) => (p.$ok ? 'oklch(0.68 0.19 300 / 38%)' : 'oklch(1 0 0 / 10%)')};
  box-shadow: 5px 5px 0 oklch(0 0 0 / 22%);
  transition:
    transform 0.15s ease,
    border-color 0.2s ease;
  &:hover {
    transform: translateY(-3px);
  }
`

const Dot = styled.span<{ $ok: boolean }>`
  width: 11px;
  height: 11px;
  border-radius: 50%;
  margin-bottom: 4px;
  background: ${(p) => (p.$ok ? 'var(--brand)' : 'var(--sts-color-red)')};
  box-shadow: 0 0 10px ${(p) => (p.$ok ? 'var(--brand)' : 'var(--sts-color-red)')};
`

const GemLabel = styled.div`
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: #9c9384;
`

const GemValue = styled.div`
  font-family: 'Kreon', serif;
  font-size: 22px;
  color: var(--sts-color-cream);
`

const GemHint = styled.div`
  font-size: 11px;
  color: #7d7669;
  text-align: center;
`

const Keys = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #9c9384;
  kbd {
    font-family: 'Cascadia Code', Consolas, monospace;
    font-size: 12px;
    color: var(--sts-color-cream);
    background: oklch(1 0 0 / 8%);
    border: 1px solid oklch(1 0 0 / 15%);
    border-radius: 6px;
    padding: 2px 7px;
  }
  span {
    margin-left: 6px;
  }
`
