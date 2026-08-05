import { useEffect, useState } from 'react'
import styled from 'styled-components'
import type { StubScenario, Sts2Settings, UpdateState } from '@shared/types'
import { useDiagnostics, useIpc, useLogs, useTracker } from '../hooks/useIpc'
import {
  Button,
  Chevron,
  DisclosureBody,
  DisclosureButton,
  Mono,
  Panel,
  Pip,
  Row,
  RowAside,
  RowDesc,
  RowLabel,
  RowMain,
  Section,
  SectionHead,
  SectionNote,
  SectionTitle,
  Switch
} from './ui'
import { JsonView } from './JsonView'
import { Logs } from './Logs'

/**
 * The single screen behind Home: everything you can change, everything you can
 * check, and — folded away — everything you'd only need when something breaks.
 *
 * The ordering is by who needs it and how often: overlay switches first (the
 * only thing most people ever touch), then the health readout that answers "why
 * isn't it showing", then updates and the privacy statement. Logs, raw game
 * state, and the dev scenario switcher live under one disclosure, because
 * surfacing them by default makes a companion app look like a debugger.
 */

const SETTINGS: { key: keyof Sts2Settings; label: string; desc: string }[] = [
  {
    key: 'enableDeckTracker',
    label: 'Deck tracker',
    desc: 'What is left in your draw pile, hand and discard during a fight.'
  },
  {
    key: 'enableAttackSummary',
    label: 'Incoming attacks',
    desc: 'Total damage the enemies are about to deal you next turn.'
  },
  {
    key: 'enableCardRewardStats',
    label: 'Card reward stats',
    desc: 'Win rates and how well each card fits your current deck.'
  },
  {
    key: 'enableShopStats',
    label: 'Shop stats',
    desc: 'The same card numbers while browsing the merchant.'
  },
  {
    key: 'enableAncientChoiceStats',
    label: 'Ancient & event stats',
    desc: 'Numbers on ancient choices and event rewards.'
  },
  {
    key: 'enableDebugStats',
    label: 'Extra detail',
    desc: 'Raw sample sizes and scores alongside each stat.'
  }
]

const SCENARIOS: { id: StubScenario; label: string }[] = [
  { id: 'combat', label: 'Combat' },
  { id: 'reward', label: 'Card reward' },
  { id: 'merchant', label: 'Merchant' },
  { id: 'event', label: 'Event' },
  { id: 'ancient', label: 'Ancient' },
  { id: 'idle', label: 'Idle' }
]

/** Raw provider states arrive lowercase; the UI reads as one voice. */
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

interface TelemetryStatus {
  enabled?: boolean
  installId?: string
  sessionId?: string
  eventsSent?: number
  deliveryFailed?: boolean
  aggregatedIssues?: Array<{ key: string; count: number }>
}

export function Settings(): JSX.Element {
  const diag = useDiagnostics()
  const tracker = useTracker()
  const settings = useIpc('sts2.settings')
  const logs = useLogs()

  const nGameState = useIpc('sts2.nGameState')
  const pileState = useIpc('sts2.pileState')
  const enemiesState = useIpc('sts2.enemiesState')
  const layoutState = useIpc('sts2.layoutState')

  const [upd, setUpd] = useState<UpdateState | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => window.spectra?.onUpdate(setUpd), [])

  const devMode = diag?.mode === 'stub'
  const tele = diag?.telemetry as TelemetryStatus | undefined
  const issues = tele?.aggregatedIssues ?? []
  const checking = upd?.status === 'checking'

  const copyReport = async (): Promise<void> => {
    const report = [
      `Reliquary ${diag?.appVersion ?? '?'}`,
      `mode=${diag?.mode} game=${diag?.gameDetected ? 'found' : 'not found'} ` +
        `overlay=${diag?.overlayVisible ? 'visible' : 'hidden'} scry=${diag?.scryModuleLoaded}`,
      diag?.scryLoadError ? `scryError: ${diag.scryLoadError}` : '',
      `codex=${diag?.codex?.state ?? 'idle'} vocab=${diag?.codex?.cardVocab ?? 0}`,
      diag?.codex?.error ? `codexError: ${diag.codex.error}` : '',
      `update=${upd?.status ?? 'idle'}${upd?.error ? ` (${upd.error})` : ''}`,
      issues.length ? `issues: ${issues.map((i) => `${i.key}×${i.count}`).join(', ')}` : 'issues: none',
      '',
      '--- recent log ---',
      ...logs.slice(-60).map((l) => `${l.level.toUpperCase()} ${l.text}`)
    ]
      .filter(Boolean)
      .join('\n')
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch {
      // Clipboard can be refused; leave the button in its resting state rather
      // than claiming a copy that did not happen.
    }
  }

  return (
    <Wrap>
      <Section>
        <SectionHead>
          <SectionTitle>Overlays</SectionTitle>
          <SectionNote>What Reliquary draws over the game</SectionNote>
        </SectionHead>
        <Panel>
          {SETTINGS.map(({ key, label, desc }) => (
            <Row key={key}>
              <RowMain>
                <RowLabel>{label}</RowLabel>
                <RowDesc>{desc}</RowDesc>
              </RowMain>
              <RowAside>
                <Switch
                  label={label}
                  checked={settings?.[key] ?? true}
                  onChange={(next) => window.spectra.setSettings({ [key]: next })}
                />
              </RowAside>
            </Row>
          ))}
        </Panel>
      </Section>

      <Section>
        <SectionHead>
          <SectionTitle>Status</SectionTitle>
          <SectionNote>Why the overlay is or isn&rsquo;t showing</SectionNote>
        </SectionHead>
        <Panel>
          <Row>
            <RowMain>
              <RowLabel>{tracker?.target ?? 'Slay the Spire 2'}</RowLabel>
              <RowDesc>
                {diag?.gameDetected
                  ? 'Reliquary is attached and reading the game.'
                  : 'Start the game and this will connect on its own.'}
              </RowDesc>
            </RowMain>
            <RowAside>
              <Pip $tone={diag?.gameDetected ? 'ok' : 'idle'}>
                {diag?.gameDetected ? 'Connected' : 'Waiting'}
              </Pip>
            </RowAside>
          </Row>

          <Row>
            <RowMain>
              <RowLabel>Overlay window</RowLabel>
              <RowDesc>
                Press <Kbd>Ctrl</Kbd> <Kbd>Shift</Kbd> <Kbd>H</Kbd> any time to hide or show it.
              </RowDesc>
            </RowMain>
            <RowAside>
              <Pip $tone={diag?.overlayVisible ? 'ok' : diag?.overlayCreated ? 'warn' : 'bad'}>
                {diag?.overlayVisible ? 'Showing' : diag?.overlayCreated ? 'Hidden' : 'Not created'}
              </Pip>
            </RowAside>
          </Row>

          <Row>
            <RowMain>
              <RowLabel>Draft advisor</RowLabel>
              <RowDesc>
                {diag?.codex?.state === 'ready'
                  ? `${diag.codex.cardVocab ?? 0} cards and ${diag.codex.relicVocab ?? 0} relics loaded.`
                  : 'Win-rate data from Spire Codex.'}
              </RowDesc>
              {diag?.codex?.error ? <Mono className="err">{diag.codex.error}</Mono> : null}
            </RowMain>
            <RowAside>
              <Pip $tone={diag?.codex?.state === 'ready' ? 'ok' : 'idle'}>
                {diag?.codex?.state === 'ready'
                  ? 'Ready'
                  : cap(diag?.codex?.state ?? 'idle')}
              </Pip>
            </RowAside>
          </Row>

          {!diag?.scryModuleLoaded || devMode ? (
            <Row>
              <RowMain>
                <RowLabel>Game reader</RowLabel>
                <RowDesc>
                  {devMode
                    ? 'Running on demo data — no real game is being read.'
                    : 'The component that reads live state could not load.'}
                </RowDesc>
                {diag?.scryLoadError ? <Mono className="err">{diag.scryLoadError}</Mono> : null}
              </RowMain>
              <RowAside>
                <Pip $tone={devMode ? 'warn' : 'bad'}>{devMode ? 'Demo data' : 'Failed'}</Pip>
              </RowAside>
            </Row>
          ) : null}
        </Panel>
      </Section>

      <Section>
        <SectionHead>
          <SectionTitle>Updates</SectionTitle>
        </SectionHead>
        <Panel>
          <Row>
            <RowMain>
              <RowLabel>Version {diag?.appVersion ?? '—'}</RowLabel>
              <RowDesc>{updateLabel(upd)}</RowDesc>
              {upd?.error ? <Mono className="err">{upd.error}</Mono> : null}
            </RowMain>
            <RowAside>
              {upd?.status === 'ready' ? (
                <Button $primary onClick={() => window.spectra?.updateAction('install')}>
                  Restart &amp; install
                </Button>
              ) : (
                <Button disabled={checking} onClick={() => window.spectra?.updateAction('check')}>
                  {checking ? 'Checking…' : 'Check for updates'}
                </Button>
              )}
            </RowAside>
          </Row>
        </Panel>
      </Section>

      <Section>
        <SectionHead>
          <SectionTitle>Privacy</SectionTitle>
        </SectionHead>
        <Panel>
          <Row>
            <RowMain>
              <RowLabel>Anonymous crash reports</RowLabel>
              <RowDesc>
                Errors and version info only — never your deck, your run, your account, or your file
                paths. Sharing them is what makes silent breakage fixable.
              </RowDesc>
              {tele?.deliveryFailed ? (
                <Mono className="err">Reports are not reaching the server right now.</Mono>
              ) : null}
            </RowMain>
            <RowAside>
              <Switch
                label="Anonymous crash reports"
                checked={settings?.enableTelemetry ?? true}
                onChange={(next) => window.spectra.setSettings({ enableTelemetry: next })}
              />
            </RowAside>
          </Row>
        </Panel>
      </Section>

      <Advanced>
        <DisclosureButton
          $open={open}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          type="button"
        >
          <Chevron />
          Technical details
          {issues.length ? <IssueCount>{issues.length}</IssueCount> : null}
        </DisclosureButton>

        {open ? (
          <DisclosureBody>
            <AdvancedInner>
              <Blurb>
                Everything below is for diagnosing a problem. If you&rsquo;re reporting one, copy it
                and paste it into the issue.
              </Blurb>
              <Button onClick={() => void copyReport()}>
                {copied ? 'Copied' : 'Copy for a bug report'}
              </Button>

              <SubHead>Session</SubHead>
              <Mono>
                reporting can also be forced off for a launch with{' '}
                <Code>SPECTRA_TELEMETRY=0</Code>
              </Mono>
              <Mono>
                install {tele?.installId ?? '—'} · session {tele?.sessionId ?? '—'} ·{' '}
                {tele?.eventsSent ?? 0} events sent
              </Mono>
              <Mono className={issues.length ? 'err' : undefined}>
                {issues.length
                  ? `issues: ${issues.map((i) => `${i.key}×${i.count}`).join(', ')}`
                  : 'no issues recorded this session'}
              </Mono>
              <Mono>
                overlay bounds:{' '}
                {diag?.overlayBounds
                  ? `${diag.overlayBounds.width}×${diag.overlayBounds.height} @ ${diag.overlayBounds.x},${diag.overlayBounds.y}`
                  : '—'}
              </Mono>

              {devMode ? (
                <>
                  <SubHead>Demo scenario</SubHead>
                  <Buttons>
                    {SCENARIOS.map((s) => (
                      <Button
                        key={s.id}
                        $primary={(diag?.scenario ?? 'combat') === s.id}
                        onClick={() => window.spectra.setScenario(s.id)}
                      >
                        {s.label}
                      </Button>
                    ))}
                  </Buttons>
                </>
              ) : null}

              <SubHead>Log</SubHead>
              <LogFrame>
                <Logs embedded />
              </LogFrame>

              <SubHead>Live game state</SubHead>
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
            </AdvancedInner>
          </DisclosureBody>
        ) : null}
      </Advanced>
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

/** One plain sentence for whatever the updater is doing. */
function updateLabel(u: UpdateState | null): string {
  switch (u?.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading ${u.version ?? 'update'}${u.percent ? ` — ${u.percent}%` : ''}`
    case 'ready':
      return `${u.version} is ready and installs when you quit.`
    case 'current':
      return 'You are on the latest version.'
    case 'error':
      return 'Could not check for updates. It will try again later.'
    case 'dev-disabled':
      return 'Updates are off in a development build.'
    case 'disabled':
      return 'Updates are switched off.'
    default:
      return 'Updates install automatically when you quit.'
  }
}

const Wrap = styled.div`
  max-width: 680px;
  margin: 0 auto;
  padding: 28px 24px 56px;
`

const Kbd = styled.kbd`
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-dim);
  background: oklch(1 0 0 / 7%);
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  padding: 1px 5px;
`

const Code = styled.code`
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-dim);
`

const Advanced = styled.div`
  margin-top: 34px;
  border-top: 1px solid var(--line);
  padding-top: 6px;
`

const IssueCount = styled.span`
  margin-left: auto;
  font-family: var(--font-body);
  font-size: 11px;
  font-weight: 600;
  color: var(--sts-color-orange);
  background: oklch(0.78 0.15 70 / 14%);
  border-radius: 10px;
  padding: 2px 9px;
`

const AdvancedInner = styled.div`
  padding: 4px 2px 0;
`

const Blurb = styled.p`
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-dim);
  max-width: 62ch;
`

const SubHead = styled.h3`
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin: 26px 0 8px;
`

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

const LogFrame = styled.div`
  height: 300px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--line);
`

const DumpGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
`

const DumpLabel = styled.div`
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  margin-bottom: 4px;
`
