import { useEffect, useState } from 'react'
import styled from 'styled-components'
import { Navigate, useParams } from '@tanstack/react-router'
import { HomeScene, type SceneGems, type SceneState } from './HomeScene'

/**
 * Home design harness (#/mock/home/d) — the "Living Spire" scene fed canned
 * states instead of live diagnostics. Dev server only, never shipped.
 *
 * States are switchable via the route (d, d-connected, d-waiting, d-demo,
 * d-broken) or the small toolbar, and a `?hover=<gem>` hash query pins a gem
 * caption open for screenshots. Legacy variants a/b/c redirect here.
 */

interface SceneDef {
  line: string
  gems: SceneGems
}

const SCENES: Record<SceneState, SceneDef> = {
  connected: {
    line: 'Watching your run',
    gems: {
      game: { status: 'ok', detail: 'Slay the Spire 2 is running' },
      overlay: { status: 'ok', detail: 'Overlay riding above the game' },
      advisor: { status: 'ok', detail: 'Advisor ready with counsel' },
      live: { status: 'ok', detail: 'Run data flowing in real time' }
    }
  },
  waiting: {
    line: 'Waiting for Slay the Spire 2',
    gems: {
      game: { status: 'wait', detail: 'Watching for the game to start' },
      overlay: { status: 'wait', detail: 'Will attach once the game appears' },
      advisor: { status: 'ok', detail: 'Advisor ready with counsel' },
      live: { status: 'off', detail: 'No run to read yet' }
    }
  },
  demo: {
    line: 'Showing demo data',
    gems: {
      game: { status: 'off', detail: 'Game not running' },
      overlay: { status: 'ok', detail: 'Overlay in demo mode' },
      advisor: { status: 'ok', detail: 'Advisor ready with counsel' },
      live: { status: 'wait', detail: 'Replaying a canned demo run' }
    }
  },
  broken: {
    line: "Can't read the game",
    gems: {
      game: { status: 'ok', detail: 'Slay the Spire 2 is running' },
      overlay: { status: 'ok', detail: 'Overlay riding above the game' },
      advisor: { status: 'wait', detail: 'Waiting for live data' },
      live: { status: 'bad', detail: 'Cannot read run data from the game' }
    }
  }
}

function parseState(variant: string | undefined): SceneState {
  const v = (variant ?? 'd').replace(/^d-?/, '')
  if (v === 'waiting' || v === 'demo' || v === 'broken' || v === 'connected') {
    return v === 'connected' ? 'connected' : v
  }
  return 'connected'
}

export function HomeMock(): JSX.Element {
  // Non-strict: this route only exists in a dev build, so it is not in the
  // router's registered path types.
  const { variant } = useParams({ strict: false }) as { variant?: string }
  if (variant === 'a' || variant === 'b' || variant === 'c') {
    return <Navigate to="/mock/home/$variant" params={{ variant: 'd' }} replace />
  }
  return <MockScene variant={variant} />
}

function MockScene({ variant }: { variant: string | undefined }): JSX.Element {
  const [scene, setScene] = useState<SceneState>(() => parseState(variant))

  useEffect(() => {
    setScene(parseState(variant))
  }, [variant])

  const def = SCENES[scene]
  return (
    <HomeScene scene={scene} line={def.line} gems={def.gems}>
      <Toolbar>
        {(['connected', 'waiting', 'demo', 'broken'] as const).map((s) => (
          <ToolButton key={s} $active={scene === s} onClick={() => setScene(s)}>
            {s}
          </ToolButton>
        ))}
      </Toolbar>
    </HomeScene>
  )
}

const Toolbar = styled.div`
  position: absolute;
  right: 12px;
  bottom: 10px;
  display: flex;
  gap: 6px;
  opacity: 0.55;
  transition: opacity 0.2s;
  &:hover {
    opacity: 1;
  }
`

const ToolButton = styled.button<{ $active: boolean }>`
  appearance: none;
  cursor: pointer;
  font-size: var(--fs-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 4px 9px;
  border-radius: 999px;
  color: ${(p) => (p.$active ? 'var(--sts-color-gold)' : 'oklch(1 0 0 / 55%)')};
  background: var(--panel-veil);
  border: 1px solid ${(p) => (p.$active ? 'var(--trim-gold)' : 'oklch(1 0 0 / 14%)')};
`
