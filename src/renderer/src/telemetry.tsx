import React from 'react'
import type { RendererTelemetryEvent } from '@shared/types'

/**
 * Renderer-side error capture.
 *
 * Renderers have no network access of their own — everything here is forwarded
 * over IPC to the main process, which owns the only telemetry client. That keeps
 * a single egress point and means the overlay's strict CSP stays intact.
 *
 * The overlay is the surface that matters most: it is click-through and
 * frameless, so when React throws, the user sees *nothing at all* — no error,
 * no blank box, just a game with no overlay on it. Those failures have to be
 * reported from here or they are never reported.
 */

/** Which window this bundle is running in, inferred from the route. */
export function surface(): RendererTelemetryEvent['surface'] {
  if (typeof location === 'undefined') return 'unknown'
  return location.hash.includes('/overlay/') ? 'overlay' : 'dashboard'
}

function send(event: RendererTelemetryEvent): void {
  try {
    window.spectra?.report(event)
  } catch {
    // Reporting must never break the surface it is reporting on.
  }
}

export function reportError(
  name: string,
  err: unknown,
  props: Record<string, unknown> = {},
  componentStack?: string
): void {
  const e = err as Error | undefined
  send({
    kind: 'error',
    name,
    surface: surface(),
    message: e?.message ?? String(err),
    stack: e?.stack?.split('\n').slice(0, 24).join('\n'),
    componentStack,
    props
  })
}

export function reportEvent(name: string, props: Record<string, unknown> = {}): void {
  send({ kind: 'event', name, surface: surface(), props })
}

export function reportCrumb(name: string, message: string): void {
  send({ kind: 'crumb', name, surface: surface(), message })
}

/** Global handlers. Call once at bundle start, before React mounts. */
export function installRendererTelemetry(): void {
  window.addEventListener('error', (e) => {
    reportError('window_error', e.error ?? e.message, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno
    })
  })

  window.addEventListener('unhandledrejection', (e) => {
    reportError('unhandled_rejection', e.reason)
  })

  // Resource load failures (fonts, images) fire a non-bubbling error on the
  // element, which the handler above never sees.
  window.addEventListener(
    'error',
    (e) => {
      const t = e.target as HTMLElement | null
      if (!t || t === (window as unknown as HTMLElement) || !t.tagName) return
      reportEvent('resource_load_failed', {
        tag: t.tagName,
        src: (t as HTMLImageElement).src ?? (t as HTMLLinkElement).href ?? null
      })
    },
    true
  )

  reportEvent('renderer_ready', {
    dpr: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    hash: location.hash
  })
}

interface BoundaryProps {
  /** Identifies which part of the UI failed, e.g. 'overlay' or 'DeckTracker'. */
  name: string
  children: React.ReactNode
  /** Rendered instead of the children after a crash. Defaults to nothing. */
  fallback?: React.ReactNode
}

interface BoundaryState {
  failed: boolean
}

/**
 * Contains a render crash to one subtree and reports it.
 *
 * Without this a single bad snapshot unmounts the entire overlay for the rest of
 * the session, because React tears down the whole tree on an unhandled render
 * error. Wrapping each panel means one broken panel costs that panel only.
 */
export class ErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportError('render_failed', error, { boundary: this.props.name }, info.componentStack ?? undefined)
  }

  componentDidUpdate(prev: BoundaryProps): void {
    // New children after a failure: give the subtree another chance rather than
    // leaving it dead until the app restarts. The next snapshot is usually fine.
    if (this.state.failed && prev.children !== this.props.children) {
      this.setState({ failed: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) return this.props.fallback ?? null
    return this.props.children
  }
}
