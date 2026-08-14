import { useEffect, useState } from 'react'
import styled, { keyframes } from 'styled-components'
import type { DiagnosticsState, UpdateState } from '@shared/types'
import { useDiagnostics, useTracker } from '../hooks/useIpc'
import { HomeScene, type SceneGems, type SceneState } from './HomeScene'

/**
 * Home: the one screen a stranger sees first, and the only place they can work
 * out whether this thing is working — now the "Living Spire" title scene,
 * driven by live diagnostics.
 *
 * The status indicators ARE the scene: the four relic gems orbiting the
 * spire's crown carry Game / Overlay / Advisor / Live data health, the state
 * line under the title names what is happening, and one quiet sentence says
 * what to do next. Someone who has just clicked past a SmartScreen warning and
 * launched an app that draws nothing visible needs that sentence — waiting
 * reads as waiting, not as a fault; only a real fault takes colour and darkens
 * the sky.
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

/**
 * Per-gem health, derived from the same diagnostics the old status cards read.
 * The detail strings surface in the hover captions, so each one answers "what
 * does this gem's colour mean right now?" in the scene's own voice.
 */
function readGems(diag: DiagnosticsState | null, phase: Phase, target: string): SceneGems {
  /* Before the first diagnostics snapshot nothing is known — everything holds
     amber rather than accusing a window that hasn't reported yet. */
  if (!diag) {
    return {
      game: { status: 'wait', detail: 'Starting up' },
      overlay: { status: 'wait', detail: 'Starting up' },
      advisor: { status: 'wait', detail: 'Starting up' },
      live: { status: 'off', detail: 'No run to read yet' }
    }
  }

  const demo = diag.mode === 'stub'
  const gameFound = diag.gameDetected
  const codex = diag.codex

  return {
    game: gameFound
      ? { status: 'ok', detail: `${target} is running` }
      : demo
        ? { status: 'off', detail: 'Game not running' }
        : { status: 'wait', detail: 'Watching for the game to start' },
    overlay: !diag.overlayCreated
      ? { status: 'bad', detail: 'Overlay window failed to open' }
      : !diag.overlayVisible
        ? {
            status: 'wait',
            detail: diag.hideHotkey
              ? `Hidden — ${keyCaps(diag.hideHotkey).join('+')} to show`
              : 'Hidden — no shortcut available'
          }
        : gameFound
          ? { status: 'ok', detail: 'Overlay riding above the game' }
          : demo
            ? { status: 'ok', detail: 'Overlay in demo mode' }
            : { status: 'wait', detail: 'Will attach once the game appears' },
    advisor: codex?.error
      ? { status: 'wait', detail: 'Win rates unavailable — overlays still work' }
      : codex?.state === 'ready'
        ? { status: 'ok', detail: `Advisor primed with ${codex.cardVocab} cards` }
        : { status: 'wait', detail: 'Fetching win rates' },
    live:
      phase === 'broken'
        ? { status: 'bad', detail: 'Cannot read run data from the game' }
        : demo
          ? { status: 'wait', detail: 'Replaying developer sample data' }
          : gameFound
            ? { status: 'ok', detail: 'Run data flowing in real time' }
            : { status: 'off', detail: 'No run to read yet' }
  }
}

/** Degraded still watches the run; the advisor gem carries the caveat. */
function sceneOf(phase: Phase): SceneState {
  return phase === 'degraded' ? 'connected' : phase
}

export function Home(): JSX.Element {
  const diag = useDiagnostics()
  const tracker = useTracker()
  const [update, setUpdate] = useState<UpdateState | null>(null)
  useEffect(() => window.spectra?.onUpdate(setUpdate), [])
  // "Not now" is remembered per version: quiet until something new exists.
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('update.dismissed'))
  const dismiss = (version: string | null): void => {
    if (version) localStorage.setItem('update.dismissed', version)
    setDismissed(version)
  }
  const target = tracker?.target ?? 'Slay the Spire 2'
  const state = readPhase(diag ?? null, target)
  const gems = readGems(diag ?? null, state.phase, target)

  return (
    <SceneHost>
      <HomeScene
        scene={sceneOf(state.phase)}
        line={state.headline}
        sub={state.action}
        gems={gems}
      >
        <Dock>
          {/* The titlebar pill announces an update from every tab; here on the
              status screen it earns a full line, because "a new version exists"
              IS status. It only ever announces and offers — nothing downloads
              or installs unless one of these buttons is pressed. */}
          {update?.status === 'available' && dismissed !== update.latest ? (
            <UpdateStrip $ready={false}>
              <StripGem />
              <span>Version {update.latest} is available.</span>
              <RestartButton
                onClick={() => window.spectra?.updateAction({ action: 'download' })}
              >
                Update
              </RestartButton>
              <QuietButton onClick={() => dismiss(update.latest)}>Not now</QuietButton>
            </UpdateStrip>
          ) : update?.status === 'downloading' ? (
            <UpdateStrip $ready={false}>
              <span>
                Downloading {update.target ?? 'update'}
                {update.percent > 0 ? ` — ${update.percent}%` : '…'}
              </span>
              <QuietButton onClick={() => window.spectra?.updateAction({ action: 'cancel' })}>
                Cancel
              </QuietButton>
            </UpdateStrip>
          ) : update?.status === 'ready' ? (
            <UpdateStrip $ready>
              <StripGem />
              <span>Version {update.target} is downloaded.</span>
              <RestartButton onClick={() => window.spectra?.updateAction({ action: 'install' })}>
                Restart to install
              </RestartButton>
              <QuietButton onClick={() => window.spectra?.updateAction({ action: 'cancel' })}>
                Cancel
              </QuietButton>
            </UpdateStrip>
          ) : null}

          {/* An expert affordance. It only earns the newcomer's sightline once
              there is actually an overlay on screen to hide — and only when a
              key genuinely bound, because naming a dead shortcut is worse than
              saying nothing. */}
          {diag?.gameDetected && diag?.hideHotkey ? (
            <Keys>
              {keyCaps(diag.hideHotkey).map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
              <span>hide or show every overlay</span>
            </Keys>
          ) : null}
        </Dock>
      </HomeScene>
    </SceneHost>
  )
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

/**
 * Split an Electron accelerator into keycaps, in the platform's own words.
 * Which shortcut bound depends on what was free on this machine, so it cannot
 * be hardcoded — the app used to print Ctrl+Shift+H even when nothing bound.
 */
function keyCaps(accel: string): string[] {
  return accel.split('+').map((k) => (k === 'CommandOrControl' ? (isMac ? 'Cmd' : 'Ctrl') : k))
}

const rise = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: none; }
`

/**
 * The scene's Stage positions itself absolutely, so Home provides the frame it
 * fills: the full tab area, no scroll — the painting owns the whole surface.
 */
const SceneHost = styled.div`
  position: relative;
  height: 100%;
  overflow: hidden;
`

/** Bottom-center column for the chrome that floats over the painting. */
const Dock = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 26px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  pointer-events: none;
  > * {
    pointer-events: auto;
  }
`

const UpdateStrip = styled.div<{ $ready: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  max-width: min(560px, calc(100% - 48px));
  padding: 10px 16px;
  border-radius: 11px;
  font-size: 13px;
  color: ${(p) => (p.$ready ? 'var(--ink)' : 'oklch(1 0 0 / 78%)')};
  /* Scene glass rather than the dashboard's stone: this strip sits on the
     painting itself, beside the gem captions, and should match their material. */
  background: ${(p) =>
    p.$ready ? 'color-mix(in oklch, var(--brand) 22%, var(--panel-veil))' : 'var(--panel-veil)'};
  border: 1px solid
    ${(p) => (p.$ready ? 'color-mix(in oklch, var(--brand) 45%, transparent)' : 'var(--trim-gold)')};
  box-shadow:
    0 10px 30px oklch(0 0 0 / 45%),
    inset 0 1px 0 oklch(1 0 0 / 10%);
  animation: ${rise} 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

/** A small faceted relic-gem, echoing the app mark — drawn, not typed. */
function StripGem(): JSX.Element {
  return (
    <GemMark viewBox="0 0 14 14" aria-hidden>
      <path d="M7 1.5 L12 4.25 L12 9.75 L7 12.5 L2 9.75 L2 4.25 Z" />
      <circle cx="7" cy="7" r="1.6" />
    </GemMark>
  )
}

const GemMark = styled.svg`
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--brand);
  stroke-width: 1.1;
  stroke-linejoin: round;
  circle {
    fill: var(--brand);
    stroke: none;
  }
`

const QuietButton = styled.button`
  cursor: pointer;
  font-family: inherit;
  font-size: var(--fs-base);
  color: oklch(1 0 0 / 70%);
  background: none;
  border: 1px solid oklch(1 0 0 / 18%);
  border-radius: 8px;
  padding: 5px 13px;
  transition: border-color 120ms ease, color 120ms ease;
  &:hover {
    color: var(--ink);
    border-color: oklch(1 0 0 / 32%);
  }
`

const RestartButton = styled.button`
  cursor: pointer;
  font-family: inherit;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--sts-color-cream);
  background: color-mix(in oklch, var(--brand) 30%, transparent);
  border: 1px solid color-mix(in oklch, var(--brand) 55%, transparent);
  border-radius: 8px;
  padding: 5px 13px;
  transition: background 120ms ease;
  &:hover {
    background: color-mix(in oklch, var(--brand) 42%, transparent);
  }
`

const Keys = styled.div`
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 14px;
  border-radius: 999px;
  background: var(--panel-veil);
  border: 1px solid oklch(1 0 0 / 12%);
  font-size: 13px;
  color: oklch(1 0 0 / 72%);
  kbd {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
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
