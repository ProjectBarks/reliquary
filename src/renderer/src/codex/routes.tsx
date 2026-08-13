import { useState } from 'react'
import {
  Navigate,
  Outlet,
  createRoute,
  useRouterState,
  type AnyRoute
} from '@tanstack/react-router'
import { CodexLayout } from './CodexLayout'
import { LibraryView } from './LibraryView'
import {
  isCodexKind,
  legacyMetaTarget,
  useCodexSearch,
  validateBrowseSearch,
  validateCodexSearch,
  validateLegacyMetaSearch
} from './params'

/**
 * The Codex's route subtree, built onto whatever parent the app hands it.
 *
 * ```
 * /codex                        CodexLayout (sub-nav, cohort selects, pin rail)
 * ├─ ''                         → /codex/browse/cards
 * ├─ browse/$kind               LibraryView — grid, list, tier or table
 * │   └─ $id                    …with the entry open (pane in list, modal else)
 * └─ meta/**                    redirects to the mode the old URL meant
 * ```
 *
 * It is a factory rather than a module-level tree so that `App.tsx` stays the
 * single place that knows the *shape* of the app — this file only knows the
 * shape of the Codex, and it can be grafted under the shell (or, later, under a
 * standalone quick-peek window) without either side importing the other's tree.
 *
 * Three structural decisions:
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
 *   - The `meta` subtree is three redirects and no screen. Tier list and table
 *     are modes of `browse/$kind` now, but the old URLs are in recents, in the
 *     back button and in whatever anyone pasted anywhere, and a dead link to a
 *     view that still exists under a different name is the worst kind.
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

  // One validator on the parent covers all three: a child's search is merged
  // with its parent's, so `tiers` and `table` need no vocabulary of their own.
  const metaRoute = createRoute({
    getParentRoute: () => codexRoute,
    path: 'meta',
    validateSearch: validateLegacyMetaSearch,
    component: Outlet
  })

  const metaIndexRoute = createRoute({
    getParentRoute: () => metaRoute,
    path: '/',
    component: LegacyTiers
  })

  const metaTiersRoute = createRoute({
    getParentRoute: () => metaRoute,
    path: 'tiers',
    component: LegacyTiers
  })

  const metaTableRoute = createRoute({
    getParentRoute: () => metaRoute,
    path: 'table',
    component: LegacyTable
  })

  return codexRoute.addChildren([
    codexIndexRoute,
    browseRoute.addChildren([browseDetailRoute]),
    metaRoute.addChildren([metaIndexRoute, metaTiersRoute, metaTableRoute])
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
function Browse(): JSX.Element | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const segments = pathname.split('/').filter(Boolean)

  // The router state updates BEFORE this component unmounts, so during any
  // navigation away (to a /mock harness, to settings) Browse re-renders once
  // with the destination's pathname. Treating that render's segments[2] as "an
  // unknown kind" fired the typo-fallback redirect below and hijacked the
  // navigation back to cards. If the path isn't ours, the next match owns the
  // screen — render nothing and let the transition finish.
  if (segments[0] !== 'codex' || segments[1] !== 'browse') return null

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

function LegacyTiers(): JSX.Element {
  return <LegacyMeta mode="tier" />
}

function LegacyTable(): JSX.Element {
  return <LegacyMeta mode="table" />
}

/**
 * An old meta URL, translated: same kind, same cohort, same highlight, same
 * table sort — as a mode on the browse route.
 *
 * The target is computed once, at mount. This component re-renders during its
 * own navigation with the destination's search already in the router state, and
 * translating *that* would produce a second redirect built out of the answer to
 * the first.
 */
function LegacyMeta({ mode }: { mode: 'tier' | 'table' }): JSX.Element {
  const raw = useRouterState({
    select: (s) => s.location.search as unknown as Record<string, unknown>
  })
  const [target] = useState(() => legacyMetaTarget(raw, mode))
  return (
    <Navigate
      to="/codex/browse/$kind"
      params={{ kind: target.kind }}
      search={target.search}
      replace
    />
  )
}

/** A hand-typed `%` in an id should not throw — it should just not decode. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
