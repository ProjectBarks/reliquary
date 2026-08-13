import { useEffect } from 'react'
import { Navigate, useNavigate, useParams } from '@tanstack/react-router'
import styled from 'styled-components'
import { DEFAULT_BRACKET, codexImageUrl } from '@shared/codex'
import { Compare } from './Compare'
import { installCodexFixtures } from './data'
import { FIXTURE_IDS, fixturePayload } from './fixtures'
import { setBracketPref, setCharacterPref, setModePref, togglePin, usePins } from './prefs'

/**
 * Codex design harness (`#/mock/codex/:view`) — the real tab, fed canned data.
 * Dev server only; the route is fenced out of production in `App.tsx`.
 *
 * The compendium is the hardest surface in the app to iterate on: it needs a
 * live community API, a warm disk cache, and a snapshot that changes under you
 * between two screenshots of the same screen. This route installs
 * `fixtures.ts` into the renderer's store and then **gets out of the way** —
 * it navigates to the genuine `/codex/**` route for the view you asked for, so
 * what you are looking at is the shipping component tree in the shipping
 * shell, not a facsimile of it. Only the bytes underneath are fake.
 *
 * Views:
 *   browse-grid    the art grid
 *   browse-list    the list with a reading pane, one entry open
 *   tiers          S–F by Codex Score
 *   table          every column, base + upgraded rows
 *   detail-modal   the grid with an entry open over it
 *   compare        the compare modal, with a pick already made
 *
 * The fixtures stay installed for the rest of the session, which is the point:
 * once you are in, every link in the tab — relics, potions, another cohort,
 * the pinned rail — keeps working against canned data. Reload the window to
 * get the real API back.
 */

const VIEWS = ['browse-grid', 'browse-list', 'tiers', 'table', 'detail-modal', 'compare'] as const

type MockView = (typeof VIEWS)[number]

function isMockView(v: string | undefined): v is MockView {
  return VIEWS.includes(v as MockView)
}

export function CodexMock(): JSX.Element {
  // Non-strict: this route only exists in a dev build, so its params are not
  // in the router's registered types.
  const { view } = useParams({ strict: false }) as { view?: string }
  useHarness(isMockView(view) ? view : 'browse-grid')

  if (!isMockView(view)) {
    return <Navigate to="/mock/codex/$view" params={{ view: 'browse-grid' }} replace />
  }

  // Compare's second entry is component state, not a URL, so it is the one
  // view that cannot be reached by navigating; it gets a stage of its own.
  if (view === 'compare') return <CompareStage />

  // Every view is a mode of one route now, so the harness says which mode
  // rather than which screen — the same URL a reader produces by clicking the
  // toolbar, which is the point of pointing the harness at real routes.
  const search = { bracket: DEFAULT_BRACKET } as const
  switch (view) {
    case 'browse-list':
      return (
        <Navigate
          to="/codex/browse/$kind/$id"
          params={{ kind: 'cards', id: FIXTURE_IDS.card }}
          search={{ ...search, mode: 'list' }}
          replace
        />
      )
    case 'detail-modal':
      return (
        <Navigate
          to="/codex/browse/$kind/$id"
          params={{ kind: 'cards', id: FIXTURE_IDS.rareCard }}
          search={{ ...search, mode: 'grid' }}
          replace
        />
      )
    case 'tiers':
      return (
        <Navigate
          to="/codex/browse/$kind"
          params={{ kind: 'cards' }}
          search={{ ...search, mode: 'tier' }}
          replace
        />
      )
    case 'table':
      return (
        <Navigate
          to="/codex/browse/$kind"
          params={{ kind: 'cards' }}
          search={{ ...search, mode: 'table', variant: 'both' }}
          replace
        />
      )
    case 'browse-grid':
    default:
      return (
        <Navigate
          to="/codex/browse/$kind"
          params={{ kind: 'cards' }}
          search={{ ...search, mode: 'grid' }}
          replace
        />
      )
  }
}

/**
 * Everything the harness has to own so that two runs of it look the same.
 *
 * The URL carries the cohort and the layout, but the *preferences* behind them
 * do not — and a screenshot that silently inherits whatever character filter
 * the last dev session left in localStorage is a screenshot of a different
 * screen. Pinning them here is not tidiness; it is the difference between a
 * reproducible harness and a coincidence.
 */
function useHarness(view: MockView): void {
  // All of this happens during render rather than in an effect, and that timing
  // is the whole trick: this component's only job is to redirect, and a child
  // `<Navigate>`'s effect runs *before* its parent's. Anything left in an effect
  // here would land after the codex had already mounted, subscribed and read
  // the preferences it was supposed to be told about. (Same reason `TrackerMock`
  // seeds its panel positions in the body.)
  installCodexFixtures(fixturePayload)
  setBracketPref(DEFAULT_BRACKET)
  setCharacterPref(null)
  setModePref(
    view === 'browse-list' ? 'list' : view === 'tiers' ? 'tier' : view === 'table' ? 'table' : 'grid'
  )

  // Pins are the exception: `togglePin` notifies its subscribers, and notifying
  // one during another component's render is how you get React's "cannot update
  // while rendering" warning. The rail redraws reactively, so an effect is both
  // safe and soon enough.
  const pins = usePins()
  useEffect(() => {
    // Only ever seeds an empty rail — clobbering a real dev profile's pins to
    // decorate a screenshot would be a poor trade.
    if (pins.length) return
    // Art goes through the same resolver the rail's real writers use, so the
    // chips paint from the CDN rather than showing two empty discs.
    togglePin({
      kind: 'relics',
      id: 'AKABEKO',
      name: 'Akabeko',
      art: codexImageUrl('/static/images/relics/akabeko.webp')
    })
    togglePin({
      kind: 'cards',
      id: FIXTURE_IDS.card,
      name: 'Bash',
      art: codexImageUrl('/static/images/cards/bash.webp')
    })
    // `pins` is read as a one-shot condition on mount, deliberately not tracked:
    // re-running this when pins change is exactly the loop it must not be.
  }, [])
}

function CompareStage(): JSX.Element {
  const navigate = useNavigate()
  useAutoPick(FIXTURE_IDS.compareName)
  return (
    <Stage className="dashboard">
      <Compare
        kind="cards"
        baseId={FIXTURE_IDS.card}
        onClose={() => navigate({ to: '/mock/codex/$view', params: { view: 'browse-grid' } })}
      />
    </Stage>
  )
}

/**
 * Choose the comparison's other side by clicking the picker, the way a reader
 * would.
 *
 * The alternative was an optional `otherId` prop on `Compare` — a seam in a
 * shipping component's API that exists only for a dev harness, and one more
 * code path nobody exercises in production. Driving the real control instead
 * costs a handful of frames of polling and proves the control works.
 */
function useAutoPick(label: string): void {
  useEffect(() => {
    let raf = 0
    let remaining = 120
    const tick = (): void => {
      const dialog = document.querySelector('[role="dialog"]')
      const candidate = dialog
        ? Array.from(dialog.querySelectorAll('button')).find((b) =>
            b.textContent?.trim().startsWith(label)
          )
        : undefined
      if (candidate) {
        candidate.click()
        return
      }
      if (--remaining > 0) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [label])
}

/** The dashboard's surface, so the modal floats on the app rather than on white. */
const Stage = styled.div`
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 120% at 50% 0%, #2a2622 0%, #171512 62%, #100e0c 100%);
  color: var(--sts-color-cream);
`
