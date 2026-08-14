import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { router } from './App'
import { queryClient } from './queryClient'
import { ErrorBoundary, installRendererTelemetry } from './telemetry'
import './overlay.css'

// Before React mounts, so a failure during the first render is still reported.
installRendererTelemetry()

// One provider for every window this bundle serves. The overlay routes run no
// queries, so for them this is inert context; the dashboard's codex tab is the
// consumer. See `queryClient.ts` for the caching posture.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary name="root">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
