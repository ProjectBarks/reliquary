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
  Spinner,
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
    key: 'enableFreeTrackerLayout',
    label: 'Movable deck tracker',
    desc: 'Place the tracker anywhere and drag its corner to set the space it may use — the cards arrange themselves to fit. Off keeps the classic left-edge strip.'
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

/** Electron accelerator -> keycaps. Which one bound depends on what was free. */
function keyCaps(accel: string): string[] {
  const mac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
  return accel.split('+').map((k) => (k === 'CommandOrControl' ? (mac ? 'Cmd' : 'Ctrl') : k))
}

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
  /** A version picked in the dropdown but not yet acted on; null = current. */
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => window.spectra?.onUpdate(setUpd), [])

  const devMode = diag?.mode === 'stub'
  const tele = diag?.telemetry as TelemetryStatus | undefined
  const issues = tele?.aggregatedIssues ?? []
  const checking = upd?.status === 'checking'
  const downloading = upd?.status === 'downloading'
  const busy = checking || downloading

  const current = upd?.current ?? diag?.appVersion ?? '—'
  // The running version belongs in the picker even when it is no longer on
  // the release list (a dev build, a pulled release).
  const versions =
    upd?.versions.some((v) => v.version === current) || !upd
      ? (upd?.versions ?? [])
      : [
          { version: current, publishedAt: '', installerUrl: '', manifestUrl: null, size: null },
          ...upd.versions
        ]
  const picked = selected ?? current
  const isUpgrade = upd?.latest != null && picked === upd.latest

  const [railExpanded, setRailExpanded] = useState(false)
  // Four tokens covers "the new one, mine, and a couple back" on one line;
  // the rest sit behind an "older" token. The current and armed versions
  // always stay visible, even when they fall outside the newest four.
  const shownVersions = railExpanded
    ? versions
    : versions.filter(
        (v, i) => i < 4 || v.version === current || v.version === picked
      )

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
                {diag?.hideHotkey ? (
                  <>
                    Press{' '}
                    {keyCaps(diag.hideHotkey).map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}{' '}
                    any time to hide or show it.
                  </>
                ) : (
                  'No hide shortcut could be registered — every candidate is already taken by another app.'
                )}
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
              {/* With no rail (dev build, no release list yet) the label must
                  carry the number itself. */}
              <RowLabel>Version{versions.length > 1 ? '' : ` ${current}`}</RowLabel>
              {/* Every version is a token you can see and press — no dropdown
                  to open, no hidden list. Arming one only changes the copy and
                  the buttons; nothing happens until it is confirmed. */}
              {versions.length > 1 ? (
                <VersionRail role="radiogroup" aria-label="Choose a version">
                  {shownVersions.map((v) => (
                    <VersionChip
                      key={v.version}
                      role="radio"
                      aria-checked={v.version === picked}
                      $current={v.version === current}
                      $armed={
                        (v.version === picked && picked !== current) ||
                        v.version === upd?.target
                      }
                      disabled={busy || upd?.status === 'ready'}
                      onClick={() =>
                        setSelected(v.version === current ? null : v.version)
                      }
                    >
                      {v.version}
                      {v.version === current ? (
                        <ChipTag>current</ChipTag>
                      ) : v.version === upd?.latest ? (
                        <ChipTag $new>new</ChipTag>
                      ) : null}
                    </VersionChip>
                  ))}
                  {!railExpanded && versions.length > shownVersions.length ? (
                    <MoreChip onClick={() => setRailExpanded(true)}>
                      {versions.length - shownVersions.length} older
                    </MoreChip>
                  ) : null}
                </VersionRail>
              ) : null}
              {downloading ? (
                <Track
                  role="progressbar"
                  aria-valuenow={upd?.percent ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <Fill style={{ transform: `scaleX(${Math.max(0.02, (upd?.percent ?? 0) / 100)})` }} />
                </Track>
              ) : null}
              {upd?.error ? <Mono className="err">{upd.error}</Mono> : null}
            </RowMain>
            <RowAside>
              {upd?.status === 'ready' ? (
                <>
                  <Button $primary onClick={() => window.spectra?.updateAction({ action: 'install' })}>
                    Restart &amp; install {upd.target}
                  </Button>
                  <Button onClick={() => window.spectra?.updateAction({ action: 'cancel' })}>
                    Cancel
                  </Button>
                </>
              ) : downloading ? (
                <Button onClick={() => window.spectra?.updateAction({ action: 'cancel' })}>
                  Cancel
                </Button>
              ) : picked !== current ? (
                <>
                  <Button
                    $primary
                    onClick={() => window.spectra?.updateAction({ action: 'download', version: picked })}
                  >
                    {isUpgrade ? 'Update to' : 'Switch to'} {picked}
                  </Button>
                  <Button onClick={() => setSelected(null)}>Cancel</Button>
                </>
              ) : (
                <Button
                  disabled={checking}
                  onClick={() => window.spectra?.updateAction({ action: 'check' })}
                  aria-busy={checking}
                >
                  {checking ? <Spinner /> : null}
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

          {/* Someone who just clicked past a SmartScreen warning deserves a
              straight answer about what this reads. Stated once, here, rather
              than on Home where it would raise a worry most people never had. */}
          <Row>
            <RowMain>
              <RowLabel>How Reliquary reads your run</RowLabel>
              <RowDesc>
                It reads the game&rsquo;s memory from outside the process, the same way a
                screen reader reads a window. It never modifies the game, installs no mod, and
                touches no save file. The source is public.
              </RowDesc>
            </RowMain>
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
                reader process: {Number(diag?.readerRestarts ?? 0)} restart
                {diag?.readerRestarts === 1 ? '' : 's'} ·{' '}
                {diag?.snapshotAgeMs == null
                  ? 'no reads yet'
                  : `last read ${Math.round(diag.snapshotAgeMs / 1000)}s ago`}
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


const Wrap = styled.div`
  max-width: 680px;
  margin: 0 auto;
  padding: 28px 24px 56px;
  @media (max-width: 520px) {
    padding: 20px 14px 40px;
  }
`

/**
 * Download progress as length rather than a number. A percentage has to be read
 * and compared against the last one you read; a bar is understood at a glance,
 * which is all this needs since nothing is blocked on it finishing.
 */
/** The version rail: every installable version inline, current marked. */
const VersionRail = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin: 9px 0 2px;
`

const VersionChip = styled.button<{ $current: boolean; $armed: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* Every control in this row — chip, older-token, action button — is
     exactly 34px tall, so the rail and its buttons read as one system. */
  height: 34px;
  cursor: ${(p) => (p.$current ? 'default' : 'pointer')};
  font-family: var(--font-display);
  font-size: 13.5px;
  letter-spacing: 0.02em;
  padding: 0 13px;
  border-radius: 8px;
  color: ${(p) => (p.$armed ? '#1b1512' : p.$current ? 'var(--ink)' : 'var(--ink-dim)')};
  background: ${(p) =>
    p.$armed
      ? 'var(--brand-soft)'
      : p.$current
        ? 'oklch(1 0 0 / 9%)'
        : 'oklch(1 0 0 / 4%)'};
  border: 1px solid
    ${(p) =>
      p.$armed
        ? 'var(--brand)'
        : p.$current
          ? 'var(--line-strong)'
          : 'var(--line)'};
  box-shadow: ${(p) => (p.$armed ? '3px 3px 0 oklch(0 0 0 / 30%)' : '2px 2px 0 oklch(0 0 0 / 18%)')};
  /* The armed token sits lifted — the same "picked up" read as a card in
     hand. Dashboard motion keeps the app's shared ease; the overshoot spring
     belongs to the in-game tracker alone. */
  transform: ${(p) => (p.$armed ? 'translateY(-2px)' : 'none')};
  transition:
    background 130ms ease,
    color 130ms ease,
    border-color 130ms ease,
    box-shadow 130ms ease,
    transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
  &:hover:not(:disabled) {
    color: ${(p) => (p.$armed ? '#1b1512' : 'var(--ink)')};
    border-color: ${(p) => (p.$armed ? 'var(--brand)' : 'var(--line-strong)')};
    transform: translateY(${(p) => (p.$armed ? '-2px' : '-1px')});
  }
  @media (prefers-reduced-motion: reduce) {
    transform: none;
    transition: none;
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

const ChipTag = styled.span<{ $new?: boolean }>`
  font-family: var(--font-body);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${(p) => (p.$new ? 'var(--brand)' : 'var(--ink-faint)')};
`

const MoreChip = styled.button`
  display: inline-flex;
  align-items: center;
  height: 34px;
  cursor: pointer;
  font-family: var(--font-body);
  font-size: 11.5px;
  color: var(--ink-faint);
  background: none;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  padding: 0 13px;
  transition: color 130ms ease, border-color 130ms ease;
  &:hover {
    color: var(--ink);
    border-color: var(--ink-faint);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

const Track = styled.div`
  margin-top: 8px;
  height: 4px;
  border-radius: 2px;
  background: oklch(1 0 0 / 8%);
  overflow: hidden;
`

const Fill = styled.div`
  width: 100%;
  height: 100%;
  border-radius: 2px;
  background: var(--brand);
  /* scaleX rather than width: a width transition relayouts the row on every
     frame, while a transform composites on its own layer. The bar holds no
     content, so there is nothing for the scale to distort. */
  transform-origin: left center;
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`

const Kbd = styled.kbd`
  margin-right: 3px;
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
  height: min(300px, 50vh);
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
