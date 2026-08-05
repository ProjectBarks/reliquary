import { useState } from 'react'
import styled from 'styled-components'
import { TitleBar, type TabId } from './TitleBar'
import { Home } from './Home'
import { Debug } from './Debug'
import { Logs } from './Logs'
import { ErrorBoundary, reportEvent } from '../telemetry'

/**
 * Dashboard shell (#/). The window is frameless + opaque, so Windows 11 draws the
 * native drop shadow and rounded corners; this just paints the surface (a custom
 * titlebar with drag + window controls + tabs above the active tab's content).
 * No CSS shadow/padding/rounding — the OS handles all of that.
 */
export function Shell(): JSX.Element {
  const [tab, setTab] = useState<TabId>('home')

  const selectTab = (next: TabId): void => {
    setTab(next)
    reportEvent('tab_viewed', { tab: next })
  }

  return (
    <Frame className="dashboard">
      <TitleBar active={tab} onTab={selectTab} />
      <Content>
        {/* Per-tab isolation: a crash in Debug's JSON viewer must not take the
            Logs tab with it, since Logs is where a user goes to describe it. */}
        <ErrorBoundary name={`tab:${tab}`} fallback={<TabCrashed />}>
          {tab === 'home' && <Home />}
          {tab === 'debug' && <Debug />}
          {tab === 'logs' && <Logs />}
        </ErrorBoundary>
      </Content>
    </Frame>
  )
}

function TabCrashed(): JSX.Element {
  return (
    <Crashed>
      <strong>This tab hit an error.</strong>
      <span>It has been reported. Switch tabs and back to retry.</span>
    </Crashed>
  )
}

const Crashed = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 32px auto;
  max-width: 380px;
  padding: 20px 22px;
  border-radius: 12px;
  border: 1px solid oklch(1 0 0 / 10%);
  background: oklch(1 0 0 / 4%);
  text-align: center;
  font-size: 13px;
  line-height: 1.5;
  color: oklch(1 0 0 / 62%);
  strong {
    color: var(--sts-color-cream);
    font-size: 14px;
  }
`

const Frame = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: radial-gradient(120% 120% at 50% 0%, #2a2622 0%, #171512 62%, #100e0c 100%);
  color: var(--sts-color-cream);
`

const Content = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  &::-webkit-scrollbar {
    width: 9px;
  }
  &::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 16%);
    border-radius: 4px;
  }
`
