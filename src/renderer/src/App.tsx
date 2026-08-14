import {
  Navigate,
  Outlet,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter
} from '@tanstack/react-router'
import { Shell } from './dashboard/Shell'
import { Home } from './dashboard/Home'
import { Settings } from './dashboard/Settings'
import { codexRouteTree } from './codex/routes'
import { journalRouteTree } from './journal/routes'
import { Sts2Overlay } from './overlays/sts2/Sts2Overlay'
import { TrackerMock } from './overlays/sts2/TrackerMock'
import { HomeMock } from './dashboard/HomeMock'
import { CodexMock } from './codex/CodexMock'
import { JournalMock } from './journal/JournalMock'

/**
 * One React bundle, several screens, selected by the window's hash route
 * (each BrowserWindow loads the same index.html with a different hash):
 *   #/             -> Shell > Home
 *   #/settings     -> Shell > Settings
 *   #/codex        -> Shell > Codex
 *   #/journal      -> Shell > Journal
 *   #/overlay/sts2 -> Sts2Overlay (transparent, click-through overlay window)
 *
 * The tree is code-based on purpose: file-based routing would need a Vite
 * plugin and a generated route file, and electron-vite's three-config build is
 * not worth complicating for a tree this small.
 */

const rootRoute = createRootRoute({
  component: Outlet,
  // Any unknown hash (a stale deep link, a typo in a loadURL) lands on Home
  // rather than a blank window — a frameless window with nothing in it looks
  // exactly like a crash.
  notFoundComponent: () => <Navigate to="/" replace />
})

/**
 * The dashboard chrome. Pathless (an `id`, not a `path`) so the overlay window's
 * route can sit beside it at the top level: a parent with path '/' would want to
 * claim every URL below it, and the overlay must render with no titlebar at all.
 */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: Shell
})

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: Home
})

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  component: Settings
})

/**
 * The compendium's whole subtree, built by the feature that owns it. Everything
 * under `/codex` — browse, detail, tier list, metrics table — hangs off this
 * one line; see `codex/routes.tsx` for the shape.
 */
const codexRoute = codexRouteTree(shellRoute)

/**
 * The run journal's subtree — report, archive, current run — owned the same
 * way; see `journal/routes.tsx`.
 */
const journalRoute = journalRouteTree(shellRoute)

const overlayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/overlay/sts2',
  component: Sts2Overlay
})

/**
 * The design harnesses: the deck tracker's (#/mock/tracker), the Home scene's
 * (#/mock/home/d) and the Codex's (#/mock/codex/browse-grid). Dev server only,
 * never shipped.
 *
 * The router has no conditional route registration, so these are gated the way
 * the old element tree gated them — by not being in the tree at all in a
 * production build. The routes are *built* inside the branch too, because
 * `import.meta.env.DEV` is statically replaced: the whole branch, and with it
 * the only references to the harness components, drops out of a prod bundle.
 */
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/mock/tracker',
        component: TrackerMock
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/mock/home/$variant',
        component: HomeMock
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/mock/codex/$view',
        component: CodexMock
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/mock/journal/$view',
        component: JournalMock
      })
    ]
  : []

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([indexRoute, settingsRoute, codexRoute, journalRoute]),
  overlayRoute,
  ...devRoutes
])

/**
 * Hash history, not browser history: production loads the renderer over
 * `file://`, where a path-based history has nothing to push onto.
 */
export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  // Nothing here is fetched on navigation yet, and the windows are small enough
  // that hover-preloading would only add work.
  defaultPreload: false
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
