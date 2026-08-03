import { useSyncExternalStore } from 'react'
import type {
  DiagnosticsState,
  KeyedSnapshot,
  LogLine,
  Sts2Key,
  Sts2Settings,
  Sts2StateMap,
  TrackerState
} from '@shared/types'

/**
 * Renderer-side keyed state store.
 *
 * Mirrors the original app's `useIpc(channel)` ergonomics: components read a
 * single key and re-render when its value changes. A module-level store holds
 * the latest value per key, fed by the preload bridge, so multiple components
 * reading the same key share one subscription.
 */

type Listener = () => void

const LOG_CAP = 2000

const values = new Map<string, unknown>()
let tracker: TrackerState | null = null
let diagnostics: DiagnosticsState | null = null
let logs: LogLine[] = []
let maximized = false

const keyListeners = new Map<string, Set<Listener>>()
const trackerListeners = new Set<Listener>()
const diagListeners = new Set<Listener>()
const logListeners = new Set<Listener>()
const maxListeners = new Set<Listener>()

function notify(set: Set<Listener>): void {
  for (const l of set) l()
}

let wired = false
function ensureWired(): void {
  if (wired) return
  // The preload bridge is absent when the bundle is loaded outside Electron
  // (e.g. viewing the dev server directly in a browser). No-op there.
  if (typeof window === 'undefined' || !window.spectra) return
  wired = true
  window.spectra.onData((snap: KeyedSnapshot) => {
    values.set(snap.key, snap.value)
    notify(keyListeners.get(snap.key) ?? new Set())
  })
  window.spectra.onTracker((state) => {
    tracker = state
    notify(trackerListeners)
  })
  window.spectra.onDiagnostics((state) => {
    diagnostics = state
    notify(diagListeners)
  })
  window.spectra.onLog((lines) => {
    // Append and cap; new array reference so useSyncExternalStore re-renders.
    const next = logs.concat(lines)
    logs = next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next
    notify(logListeners)
  })
  window.spectra.onWindowMaximized((m) => {
    maximized = m
    notify(maxListeners)
  })
  // Replay everything main already knows about.
  window.spectra.requestState()
}

function subscribeKey(key: string, l: Listener): () => void {
  ensureWired()
  let set = keyListeners.get(key)
  if (!set) {
    set = new Set()
    keyListeners.set(key, set)
  }
  set.add(l)
  return () => set!.delete(l)
}

/** Read one keyed state value; re-renders when it changes. */
export function useIpc<K extends Sts2Key>(key: K): Sts2StateMap[K] | null {
  return useSyncExternalStore(
    (l) => subscribeKey(key, l),
    () => (values.get(key) as Sts2StateMap[K] | undefined) ?? null
  )
}

/** Convenience: read a single overlay setting flag (defaults to true). */
export function useSetting(flag: keyof Sts2Settings): boolean {
  const settings = useIpc('sts2.settings')
  return settings?.[flag] ?? true
}

export function useTracker(): TrackerState | null {
  return useSyncExternalStore(
    (l) => {
      ensureWired()
      trackerListeners.add(l)
      return () => trackerListeners.delete(l)
    },
    () => tracker
  )
}

export function useDiagnostics(): DiagnosticsState | null {
  return useSyncExternalStore(
    (l) => {
      ensureWired()
      diagListeners.add(l)
      return () => diagListeners.delete(l)
    },
    () => diagnostics
  )
}

/** Captured main-process log lines (oldest first, capped). */
export function useLogs(): LogLine[] {
  return useSyncExternalStore(
    (l) => {
      ensureWired()
      logListeners.add(l)
      return () => logListeners.delete(l)
    },
    () => logs
  )
}

/** Whether the dashboard window is currently maximized. */
export function useMaximized(): boolean {
  return useSyncExternalStore(
    (l) => {
      ensureWired()
      maxListeners.add(l)
      return () => maxListeners.delete(l)
    },
    () => maximized
  )
}
