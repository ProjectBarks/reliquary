import styled from 'styled-components'
import type { StubScenario, Sts2Settings } from '@shared/types'
import { useDiagnostics, useIpc, useTracker } from '../hooks/useIpc'
import { Card, CardTitle, Hint, Mono, Status } from './ui'
import { JsonView } from './JsonView'

/**
 * Debug tab: everything that isn't the pretty landing — live diagnostics, the
 * overlay toggles, the dev scenario switcher, and a raw dump of the keyed game
 * state. Moved here so Home stays clean.
 */

const SCENARIOS: { id: StubScenario; label: string; hint: string }[] = [
  { id: 'combat', label: 'Combat', hint: 'Deck tracker + attack summary' },
  { id: 'reward', label: 'Card Reward', hint: 'Reward pick/win stats' },
  { id: 'merchant', label: 'Merchant', hint: 'Shop card stats' },
  { id: 'event', label: 'Event', hint: 'Event choice info' },
  { id: 'ancient', label: 'Ancient', hint: 'Ancient choice stats' },
  { id: 'idle', label: 'Idle', hint: 'No room — overlays hidden' }
]

const SETTING_LABELS: { key: keyof Sts2Settings; label: string }[] = [
  { key: 'enableDeckTracker', label: 'Deck Tracker' },
  { key: 'enableAttackSummary', label: 'Attack Summary' },
  { key: 'enableCardRewardStats', label: 'Card Reward Stats' },
  { key: 'enableShopStats', label: 'Shop Stats' },
  { key: 'enableAncientChoiceStats', label: 'Ancient Choice Stats' },
  { key: 'enableDebugStats', label: 'Debug Stats' }
]

export function Debug(): JSX.Element {
  const diag = useDiagnostics()
  const tracker = useTracker()
  const settings = useIpc('sts2.settings')

  const nGameState = useIpc('sts2.nGameState')
  const pileState = useIpc('sts2.pileState')
  const enemiesState = useIpc('sts2.enemiesState')
  const layoutState = useIpc('sts2.layoutState')

  const scenario = diag?.scenario ?? 'combat'
  const devMode = diag?.mode === 'stub'

  return (
    <Wrap>
      <Grid>
        <Card>
          <CardTitle>Status</CardTitle>
          <Status ok={diag?.mode !== 'stub'}>
            Data source: {diag?.mode === 'stub' ? 'STUB (developer data)' : 'LIVE (scry)'}
          </Status>
          <Status ok={diag?.overlayCreated}>
            Overlay window: {diag?.overlayCreated ? 'created' : 'missing'}
          </Status>
          <Status ok={diag?.overlayVisible}>
            Overlay visible: {diag?.overlayVisible ? 'yes' : 'no'}
          </Status>
          <Mono>
            bounds:{' '}
            {diag?.overlayBounds
              ? `${diag.overlayBounds.width}×${diag.overlayBounds.height} @ ${diag.overlayBounds.x},${diag.overlayBounds.y}`
              : '—'}
          </Mono>
          <Status ok={diag?.gameDetected}>
            Game window: {diag?.gameDetected ? 'detected' : 'not found'}
            {tracker ? ` (${tracker.target})` : ''}
          </Status>
          <Status ok={diag?.scryModuleLoaded}>
            Scry module: {diag?.scryModuleLoaded ? 'loaded' : 'not loaded'}
          </Status>
          {diag && !diag.scryModuleLoaded && diag.scryLoadError ? (
            <Mono className="err">{diag.scryLoadError}</Mono>
          ) : null}
        </Card>

        <Card>
          <CardTitle>Spire Codex Advisor</CardTitle>
          <Status ok={diag?.codex?.state === 'ready'}>
            Snapshot: {diag?.codex?.state ?? 'idle'}
            {diag?.codex?.apiVersion != null ? ` (v${diag.codex.apiVersion})` : ''}
          </Status>
          <Mono>
            vocab: {diag?.codex?.cardVocab ?? 0} cards · {diag?.codex?.relicVocab ?? 0} relics
          </Mono>
          <Mono>
            runtime coverage: {diag?.codex?.idsResolved ?? 0}/{diag?.codex?.idsSeen ?? 0} offered ids
            resolved
          </Mono>
          {diag?.codex?.error ? <Mono className="err">{diag.codex.error}</Mono> : null}
        </Card>

        {devMode ? (
          <Card>
            <CardTitle>Scenario (dev)</CardTitle>
            <Hint>Stub-only: switch to exercise each overlay without the game running.</Hint>
            <Buttons>
              {SCENARIOS.map((s) => (
                <ScenarioBtn
                  key={s.id}
                  $active={scenario === s.id}
                  onClick={() => window.spectra.setScenario(s.id)}
                  title={s.hint}
                >
                  {s.label}
                </ScenarioBtn>
              ))}
            </Buttons>
          </Card>
        ) : null}

        <Card>
          <CardTitle>Overlay Toggles</CardTitle>
          {SETTING_LABELS.map(({ key, label }) => (
            <Toggle key={key}>
              <input
                type="checkbox"
                checked={settings?.[key] ?? true}
                onChange={(e) => window.spectra.setSettings({ [key]: e.target.checked })}
              />
              <span>{label}</span>
            </Toggle>
          ))}
        </Card>
      </Grid>

      <Card>
        <CardTitle>Live State</CardTitle>
        <DumpGrid>
          <Dump label="nGameState" value={nGameState} />
          <Dump label="enemiesState" value={enemiesState} />
          <Dump label="layoutState" value={layoutState} />
          <Dump
            label="pileState (sizes)"
            value={
              pileState
                ? {
                    draw: pileState.draw.length,
                    hand: pileState.hand.length,
                    discard: pileState.discard.length
                  }
                : null
            }
          />
        </DumpGrid>
      </Card>
    </Wrap>
  )
}

function Dump({ label, value }: { label: string; value: unknown }): JSX.Element {
  return (
    <div>
      <DumpLabel>{label}</DumpLabel>
      <JsonView data={value} />
    </div>
  )
}

const Wrap = styled.div`
  max-width: 920px;
  margin: 0 auto;
  padding: 24px 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
`

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
`

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

const ScenarioBtn = styled.button<{ $active: boolean }>`
  cursor: pointer;
  padding: 8px 12px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  color: ${(p) => (p.$active ? '#1a1613' : 'var(--sts-color-cream)')};
  background: ${(p) => (p.$active ? 'var(--brand)' : 'rgba(0,0,0,0.3)')};
  border: 1px solid ${(p) => (p.$active ? 'var(--brand)' : 'oklch(1 0 0 / 15%)')};
  transition: background 0.12s ease;
  &:hover {
    background: ${(p) => (p.$active ? 'var(--brand)' : 'rgba(255,255,255,0.08)')};
  }
`

const Toggle = styled.label`
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  padding: 4px 0;
  cursor: pointer;
  input {
    width: 16px;
    height: 16px;
    accent-color: var(--brand);
    cursor: pointer;
  }
`

const DumpGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
`

const DumpLabel = styled.div`
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent-teal);
  margin-bottom: 4px;
`
