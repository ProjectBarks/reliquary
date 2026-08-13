import { useEffect, useRef } from 'react'
import { Outlet, useRouterState } from '@tanstack/react-router'
import styled from 'styled-components'
import { TitleBar, tabForPath, type TabId } from './TitleBar'
import { ErrorBoundary, reportEvent } from '../telemetry'

/**
 * Dashboard shell (#/, #/codex, #/settings). The window is frameless + opaque,
 * so Windows 11 draws the native drop shadow and rounded corners; this just
 * paints the surface (a custom titlebar with drag + window controls + tabs above
 * the active route's content). No CSS shadow/padding/rounding — the OS handles
 * all of that.
 *
 * Which tab is showing is the URL's business now, not local state: the tab is
 * simply the first path segment, so a route deep inside Codex still lights the
 * Codex tab, and every nested view the compendium grows is linkable.
 */
export function Shell(): JSX.Element {
  const tab = useRouterState({ select: (s) => tabForPath(s.location.pathname) })
  useTabViewed(tab)

  return (
    <Frame className="dashboard">
      <TitleBar active={tab} />
      <Content>
        {/* Per-tab isolation: a crash in Debug's JSON viewer must not take the
            Logs tab with it, since Logs is where a user goes to describe it.
            Keyed by tab so switching tabs remounts the boundary and a crashed
            tab gets a clean try. */}
        <ErrorBoundary key={tab} name={`tab:${tab}`} fallback={<TabCrashed />}>
          <Outlet />
        </ErrorBoundary>
      </Content>
    </Frame>
  )
}

/**
 * `tab_viewed`, once per arrival at a tab.
 *
 * The event used to hang off the tab button's click handler; now that the tabs
 * are links it hangs off the tab actually changing, so it still fires exactly
 * once per navigation and never on a re-render. The tab the window opens on is
 * deliberately not reported — that was never a view the user chose, and counting
 * it would put a `tab_viewed` under every launch.
 */
function useTabViewed(tab: TabId): void {
  const seen = useRef<TabId | null>(null)
  useEffect(() => {
    if (seen.current === null) {
      seen.current = tab
      return
    }
    if (seen.current === tab) return
    seen.current = tab
    reportEvent('tab_viewed', { tab })
  }, [tab])
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
  /* Warm dark stone, lit faintly from above — the dashboard's own surface.
     The Home scene paints its night sky over this; chrome and Settings stay
     on the quiet gray so panels and text sit exactly as measured. */
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
