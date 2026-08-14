import { Navigate, useParams } from '@tanstack/react-router'
import { installJournalFixtures } from './data'
import { FIXTURE_IDS, journalFixtures, type JournalMockView } from './fixtures'

/**
 * Journal design harness (`#/mock/journal/:view`) — the real tab, fed canned
 * data. Dev server only; the route is fenced out of production in `App.tsx`.
 *
 * The Journal is the hardest surface in the app to iterate on, for a reason the
 * Codex never had: you cannot *make* one. A run report needs a 45-room run that
 * ended, a live view needs a game in progress, and an ambiguity banner needs the
 * matcher to have genuinely failed to tell two runs apart. Waiting for any of
 * those to happen in order to look at a screen is not iteration.
 *
 * So this route installs `fixtures.ts` into the renderer's journal store and
 * then **gets out of the way** — it navigates to the genuine `/journal/**`
 * route for the view you asked for, so what you are looking at is the shipping
 * component tree in the shipping shell. Only the bytes underneath are fake.
 *
 * Views:
 *   report      the finished-run report, with a complete review
 *   pending     the same report shape with the review still queued
 *   current     the LIVE view, mid-combat
 *   archive     the catalog list, including a provisional and an unreadable row
 *   ambiguity   the resolution banner over the live view
 *   empty       a first launch — every view's designed empty state
 *
 * The fixtures stay installed for the rest of the session, which is the point:
 * every link in the tab keeps working against canned data. Reload the window to
 * get the real journal back.
 */

const VIEWS: JournalMockView[] = [
  'report',
  'pending',
  'current',
  'archive',
  'ambiguity',
  'empty'
]

function isMockView(v: string | undefined): v is JournalMockView {
  return VIEWS.includes(v as JournalMockView)
}

export function JournalMock(): JSX.Element {
  // Non-strict: this route only exists in a dev build, so its params are not in
  // the router's registered types.
  const { view } = useParams({ strict: false }) as { view?: string }
  const resolved = isMockView(view) ? view : 'report'

  // Installed during render rather than in an effect, and that timing is the
  // whole trick: this component's only job is to redirect, and a child
  // `<Navigate>`'s effect runs *before* its parent's. Anything left in an
  // effect here would land after the Journal had already mounted, subscribed,
  // and fired a `journal:list` at a bridge that may not exist.
  installJournalFixtures(journalFixtures(resolved))

  if (!isMockView(view)) {
    return <Navigate to="/mock/journal/$view" params={{ view: 'report' }} replace />
  }

  switch (resolved) {
    case 'pending':
      return <Navigate to="/journal/run/$id" params={{ id: FIXTURE_IDS.pending }} replace />
    case 'current':
    case 'ambiguity':
      return <Navigate to="/journal/current" replace />
    case 'archive':
      return <Navigate to="/journal/archive" replace />
    // The index is the interesting one when there is nothing on file: it is the
    // screen a first-time reader actually lands on.
    case 'empty':
      return <Navigate to="/journal" replace />
    case 'report':
    default:
      return <Navigate to="/journal/run/$id" params={{ id: FIXTURE_IDS.death }} replace />
  }
}
