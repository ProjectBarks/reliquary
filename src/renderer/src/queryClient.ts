import { QueryClient } from '@tanstack/react-query'

/**
 * The one QueryClient for the whole renderer bundle.
 *
 * A module export rather than something built inside a component because two
 * non-component call sites need it: the codex push subscription (main
 * broadcasts revalidated compendium data on `IPC.CodexPush`, and `codex/data.ts`
 * folds those pushes into this cache) and the refresh actions (which
 * invalidate keys from event handlers).
 *
 * Defaults are tuned for what the renderer actually queries — the spire-codex
 * compendium, served by the main process from its own disk cache:
 *
 *   - `staleTime: Infinity` / `refetchOnMount: false`: the compendium snapshot
 *     changes rarely (weeks between API versions). Nothing refetches on
 *     remount or navigation; a cached catalog answers instantly forever.
 *     Freshness arrives the other way round — main revalidates on its own
 *     schedule and *pushes*, which lands in the cache via
 *     `setQueryData`/`invalidateQueries` in `codex/data.ts`.
 *   - `gcTime: 24h`: keep unmounted tables (other brackets, other kinds)
 *     around so flipping back to them is instant for the life of the session.
 *   - No focus/reconnect refetching: this is a desktop app whose windows gain
 *     and lose focus constantly while a game runs; focus is not a freshness
 *     signal here.
 *   - `retry: false`: the "network" is an IPC invoke to the local main
 *     process. It does not fail transiently — main owns its own HTTP retries
 *     and answers from cache — so a failure should surface immediately.
 *   - `networkMode: 'always'`: same reason. react-query's online/offline
 *     pausing keys off `navigator.onLine`, but an offline machine can still
 *     complete these invokes (main serves its disk cache), so queries must
 *     never sit paused waiting for a browser online event.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: 24 * 60 * 60 * 1000,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
      networkMode: 'always'
    }
  }
})
