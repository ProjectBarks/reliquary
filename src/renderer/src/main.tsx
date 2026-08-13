import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './App'
import { ErrorBoundary, installRendererTelemetry } from './telemetry'
import './overlay.css'

// Before React mounts, so a failure during the first render is still reported.
installRendererTelemetry()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary name="root">
      <RouterProvider router={router} />
    </ErrorBoundary>
  </React.StrictMode>
)
