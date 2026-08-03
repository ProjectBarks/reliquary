import { useState } from 'react'
import styled from 'styled-components'
import { TitleBar, type TabId } from './TitleBar'
import { Home } from './Home'
import { Debug } from './Debug'
import { Logs } from './Logs'

/**
 * Dashboard shell (#/). The window is frameless + opaque, so Windows 11 draws the
 * native drop shadow and rounded corners; this just paints the surface (a custom
 * titlebar with drag + window controls + tabs above the active tab's content).
 * No CSS shadow/padding/rounding — the OS handles all of that.
 */
export function Shell(): JSX.Element {
  const [tab, setTab] = useState<TabId>('home')

  return (
    <Frame className="dashboard">
      <TitleBar active={tab} onTab={setTab} />
      <Content>
        {tab === 'home' && <Home />}
        {tab === 'debug' && <Debug />}
        {tab === 'logs' && <Logs />}
      </Content>
    </Frame>
  )
}

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
