import { Navigate, createRoute, useRouterState, type AnyRoute } from '@tanstack/react-router'
import { CodexLayout } from './CodexLayout'
import { LibraryView } from './LibraryView'
import { MetaLayout } from './MetaLayout'
import { MetricsTableView } from './MetricsTableView'
import { TierListView } from './TierListView'
import {
  isCodexKind,
  useCodexSearch,
  useMetaSearch,
  validateBrowseSearch,
  validateCodexSearch,
  validateMetaSearch,
  validateTableSearch
} from './params'

/**
 * The Codex's route subtree, built onto whatever parent the app hands it.
 *
 * ```
 * /codex                        CodexLayout (sub-nav, cohort selects, pin rail)
 * ├─ ''                         → /codex/browse/cards
 * ├─ browse/$kind               LibraryView
 * │   └─ $id                    …with the entry open (pane in list, modal in grid)
 * └─ meta                       MetaLayout (kind switcher, summary line)
 *     ├─ ''                     → /codex/meta/tiers
 *     ├─ tiers                  TierListView
 *     └─ table                  MetricsTableView
 * ```
 *
 * It is a factory rather than a module-level tree so that `App.tsx` stays the
 * single place that knows the *shape* of the app — this file only knows the
 * shape of the Codex, and it can be grafted under the shell (or, later, under a
 * standalone quick-peek window) without either side importing the other's tree.
 *
 * Two structural decisions:
 *
 *   - `$id` is a **child** of `browse/$kind`, not a sibling. Opening an entry
 *     must not remount the library: a sibling route would rebuild 577 tiles,
 *     lose the scroll position, and re-run the search effects every time
 *     someone clicked a card. The child renders nothing at all; the parent
 *     reads the id and decides where to put it.
 *   - Route components read the path rather than calling into route objects.
 *     A component that reaches back into the route it belongs to makes the
 *     route's own type depend on itself, and TypeScript answers that with
 *     `any` — which would silently un-type every link in the tab.
 */
export function codexRouteTree<TParent extends AnyRoute>(parent: TParent) {
  const codexRoute = createRoute({
    getParentRoute: () => parent,
    path: '/codex',
    component: CodexLayout,
    // The cohort is declared here, at the top of the subtree, so every route
    // below inherits it — one bracket, one character, for the whole tab.
    validateSearch: validateCodexSearch
  })

  const codexIndexRoute = createRoute({
    getParentRoute: () => codexRoute,
    path: '/',
    component: CodexIndex
  })

  const browseRoute = createRoute({
    getParentRoute: () => codexRoute,
    path: 'browse/$kind',
    validateSearch: validateBrowseSearch,
    component: Browse
  })

  const browseDetailRoute = createRoute({
    getParentRoute: () => browseRoute,
    path: '$id',
    component: BrowseDetail
  })

  const metaRoute = createRoute({
    getParentRoute: () => codexRoute,
    path: 'meta',
    validateSearch: validateMetaSearch,
    component: MetaLayout
  })

  const metaIndexRoute = createRoute({
    getParentRoute: () => metaRoute,
    path: '/',
    component: MetaIndex
  })

  const tiersRoute = createRoute({
    getParentRoute: () => metaRoute,
    path: 'tiers',
    component: TierListView
  })

  const tableRoute = createRoute({
    getParentRoute: () => metaRoute,
    path: 'table',
    validateSearch: validateTableSearch,
    component: MetricsTableView
  })

  return codexRoute.addChildren([
    codexIndexRoute,
    browseRoute.addChildren([browseDetailRoute]),
    metaRoute.addChildren([metaIndexRoute, tiersRoute, tableRoute])
  ])
}

/** `/codex` on its own has no opinion; cards is the one everybody wants. */
function CodexIndex(): JSX.Element {
  const search = useCodexSearch()
  return <Navigate to="/codex/browse/$kind" params={{ kind: 'cards' }} search={search} replace />
}

/**
 * `/codex/browse/$kind` and `/codex/browse/$kind/$id` are the same screen, so
 * they are read from one place: the path segments. An unknown kind — a typo, a
 * stale bookmark, a link from a future version — lands on cards rather than on
 * an error, because there is a perfectly good screen to show and no reason to
 * make the reader's mistake their problem.
 */
function Browse(): JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const segments = pathname.split('/').filter(Boolean)
  const kind = segments[2]
  const id = segments[3] ? safeDecode(segments[3]) : undefined

  if (!isCodexKind(kind)) {
    return <Navigate to="/codex/browse/$kind" params={{ kind: 'cards' }} replace />
  }
  return <LibraryView kind={kind} detailId={id} />
}

/** The detail is drawn by its parent, in the slot the current layout dictates. */
function BrowseDetail(): null {
  return null
}

function MetaIndex(): JSX.Element {
  const search = useMetaSearch()
  return <Navigate to="/codex/meta/tiers" search={search} replace />
}

/** A hand-typed `%` in an id should not throw — it should just not decode. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
