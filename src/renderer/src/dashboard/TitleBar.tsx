import { createLink } from '@tanstack/react-router'
import styled from 'styled-components'
import { useMaximized } from '../hooks/useIpc'
import { UpdateBanner } from './UpdateBanner'

/** The three top-level dashboard tabs. */
export type TabId = 'home' | 'codex' | 'settings'

const TABS = [
  { id: 'home', label: 'Home', to: '/' },
  { id: 'codex', label: 'Codex', to: '/codex' },
  { id: 'settings', label: 'Settings', to: '/settings' }
] as const satisfies readonly { id: TabId; label: string; to: string }[]

/**
 * Which tab owns a URL, from its first path segment — the tabs are the roots of
 * the shell's route subtrees, so `/codex/browse/cards` is still the Codex tab.
 * Anything unrecognised reads as Home, which is where the router sends it.
 */
export function tabForPath(pathname: string): TabId {
  const segment = pathname.split('/')[1] ?? ''
  return segment === 'codex' || segment === 'settings' ? segment : 'home'
}

/**
 * Custom frameless titlebar: a drag region carrying the app mark, the tab nav,
 * and minimize/maximize/close controls. Replaces the native OS window frame.
 * The bar itself is a drag region (-webkit-app-region: drag); every interactive
 * child opts back out with no-drag so clicks aren't swallowed by the drag.
 */
export function TitleBar({ active }: { active: TabId }): JSX.Element {
  const maximized = useMaximized()
  const ctl = (a: 'minimize' | 'maximize' | 'close') => (): void =>
    window.spectra?.windowControl(a)

  return (
    <Bar>
      <Brand>
        <Gem viewBox="0 0 24 24" aria-hidden>
          <path d="M12 2.5 L20 7 L20 17 L12 21.5 L4 17 L4 7 Z" />
          <path
            className="facet"
            d="M12 7 L16.2 9.6 L16.2 14.4 L12 17 L7.8 14.4 L7.8 9.6 Z M12 2.5 L12 7 M20 7 L16.2 9.6 M20 17 L16.2 14.4 M12 21.5 L12 17 M4 17 L7.8 14.4 M4 7 L7.8 9.6"
          />
          <circle cx="12" cy="12" r="2.3" style={{ fill: 'var(--brand)', stroke: 'none' }} />
        </Gem>
        <span>Reliquary</span>
      </Brand>

      <Tabs>
        {/* The paint comes from `active` (the shell's one reading of the URL);
            activeOptions only decides which link gets aria-current, and Home
            has to be exact or it would claim every route beneath '/'. */}
        {TABS.map((t) => (
          <Tab
            key={t.id}
            to={t.to}
            activeOptions={{ exact: t.to === '/' }}
            $active={active === t.id}
          >
            {t.label}
          </Tab>
        ))}
      </Tabs>

      {/* Balanced side columns keep the tabs optically centred whether or not
          the update pill is showing, so nothing shifts when one appears. */}
      <Right>
        <UpdateBanner />
        <Controls>
        <Ctl onClick={ctl('minimize')} title="Minimize" aria-label="Minimize">
          <svg viewBox="0 0 12 12">
            <line x1="2.5" y1="6" x2="9.5" y2="6" />
          </svg>
        </Ctl>
        <Ctl onClick={ctl('maximize')} title={maximized ? 'Restore' : 'Maximize'} aria-label="Maximize">
          {maximized ? (
            <svg viewBox="0 0 12 12">
              <rect x="3" y="3" width="6" height="6" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12">
              <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
            </svg>
          )}
        </Ctl>
        <Ctl $danger onClick={ctl('close')} title="Close" aria-label="Close">
          <svg viewBox="0 0 12 12">
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
          </svg>
        </Ctl>
        </Controls>
      </Right>
    </Bar>
  )
}

const Bar = styled.header`
  -webkit-app-region: drag;
  flex: 0 0 auto;
  height: 46px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid oklch(1 0 0 / 8%);
`

const Brand = styled.div`
  flex: 1 1 0;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 150px;
  font-family: var(--font-display);
  font-size: 18px;
  letter-spacing: 0.5px;
  color: var(--sts-color-cream);
  i {
    font-style: normal;
    color: var(--brand);
    margin-left: 5px;
  }
`

const Gem = styled.svg`
  width: 20px;
  height: 20px;
  fill: none;
  stroke: var(--brand);
  stroke-width: 1.4;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 6px oklch(0.68 0.19 300 / 50%));
  .facet {
    stroke-width: 1;
    opacity: 0.6;
  }
`

const Tabs = styled.nav`
  -webkit-app-region: no-drag;
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  gap: 6px;
`

/** Right column, weighted to match Brand so Tabs stays centred. */
const Right = styled.div`
  flex: 1 1 0;
  min-width: 150px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
`

/**
 * A tab is a real link now — one route each, so middle-click, the back button
 * and a deep-linked window all behave. The styling is unchanged from the button
 * it replaces; an anchor's only visual differences here are the UA underline and
 * link colour, and the colour was already being set. `$active` stays transient
 * so styled-components keeps it out of the DOM.
 */
const TabAnchor = styled.a<{ $active: boolean }>`
  -webkit-app-region: no-drag;
  cursor: pointer;
  text-decoration: none;
  padding: 7px 18px;
  border-radius: 8px;
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.5px;
  color: ${(p) => (p.$active ? '#1a1613' : 'var(--sts-color-cream)')};
  background: ${(p) => (p.$active ? 'var(--brand)' : 'transparent')};
  border: 1px solid ${(p) => (p.$active ? 'var(--brand)' : 'transparent')};
  box-shadow: ${(p) => (p.$active ? '2px 2px 0 oklch(0 0 0 / 30%)' : 'none')};
  transition:
    background 0.12s ease,
    color 0.12s ease;
  &:hover {
    background: ${(p) => (p.$active ? 'var(--brand)' : 'oklch(1 0 0 / 8%)')};
  }
`

/** The anchor above, taught to navigate the router (and to type-check `to`). */
const Tab = createLink(TabAnchor)

const Controls = styled.div`
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 4px;
`

const Ctl = styled.button<{ $danger?: boolean }>`
  -webkit-app-region: no-drag;
  cursor: pointer;
  width: 34px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--sts-color-cream);
  transition: background 0.12s ease;
  svg {
    width: 12px;
    height: 12px;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    fill: none;
  }
  &:hover {
    background: ${(p) => (p.$danger ? 'var(--sts-color-red)' : 'oklch(1 0 0 / 12%)')};
    color: ${(p) => (p.$danger ? '#fff' : 'var(--sts-color-cream)')};
  }
`
