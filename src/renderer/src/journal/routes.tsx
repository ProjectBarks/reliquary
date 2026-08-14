import { createRoute, useRouterState, type AnyRoute } from '@tanstack/react-router'
import { Loading } from '../codex/parts'
import { ArchiveView } from './ArchiveView'
import { CurrentRun } from './CurrentRun'
import { useJournalCatalog, useLatestFinishedRun } from './data'
import { NoRunsYet, RunReport } from './RunReport'
import { JournalLayout } from './JournalLayout'

/**
 * The Journal's route subtree, built onto whatever parent the app hands it.
 *
 * ```
 * /journal              JournalLayout (sub-nav, run picker, Export JSON)
 * ├─ ''                 the newest finished run's report, or the empty state
 * ├─ run/$id            one run's report
 * ├─ archive            every run on file
 * └─ current            the run happening right now
 * ```
 *
 * A factory rather than a module-level tree, exactly like `codexRouteTree`, so
 * `App.tsx` stays the only place that knows the *shape* of the app while this
 * file knows only the shape of the Journal.
 *
 * Two decisions worth stating:
 *
 *   - **The index renders the report, it does not redirect to it.** Sending
 *     `/journal` to `/journal/run/<newest>` would work, but it would put a URL
 *     in the back button that the reader never chose, and it would make the
 *     "Journal" sub-nav word point at a route that immediately stops being the
 *     one you are on. The index simply *is* the newest report; the picker is
 *     what mints a `run/$id` URL.
 *   - **Route components read the path, never the route object.** A component
 *     that reaches back into its own route makes the route's type depend on
 *     itself, and TypeScript answers that with `any` — which would silently
 *     un-type every link in the tab.
 */
export function journalRouteTree<TParent extends AnyRoute>(parent: TParent) {
  const journalRoute = createRoute({
    getParentRoute: () => parent,
    path: '/journal',
    component: JournalLayout
  })

  const indexRoute = createRoute({
    getParentRoute: () => journalRoute,
    path: '/',
    component: JournalIndex
  })

  const runRoute = createRoute({
    getParentRoute: () => journalRoute,
    path: 'run/$id',
    component: RunRoute
  })

  const archiveRoute = createRoute({
    getParentRoute: () => journalRoute,
    path: 'archive',
    component: ArchiveView
  })

  const currentRoute = createRoute({
    getParentRoute: () => journalRoute,
    path: 'current',
    component: CurrentRun
  })

  return journalRoute.addChildren([indexRoute, runRoute, archiveRoute, currentRoute])
}

/** `/journal` — the most recent finished run, or an honest empty page. */
function JournalIndex(): JSX.Element {
  const catalog = useJournalCatalog()
  const latest = useLatestFinishedRun()
  if (catalog.loading && !catalog.data) return <Loading label="Reading the archive…" />
  if (!latest) return <NoRunsYet />
  return <RunReport id={latest.id} />
}

/**
 * `/journal/run/$id`, read from the path.
 *
 * The router state updates *before* this component unmounts, so during any
 * navigation away it re-renders once with the destination's pathname. Rendering
 * a report for whatever `segments[2]` happens to be at that moment would fire a
 * `journal:get` for a nonsense id on every exit; if the path is not ours, the
 * next match owns the screen.
 */
function RunRoute(): JSX.Element | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] !== 'journal' || segments[1] !== 'run') return null
  const id = segments[2]
  if (!id) return <NoRunsYet />
  return <RunReport id={safeDecode(id)} />
}

/** A hand-typed `%` in an id should not throw — it should just not decode. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
