import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type DiagnosticsState,
  type KeyedSnapshot,
  type LogLine,
  type RendererTelemetryEvent,
  type SpectraApi,
  type UpdateAction,
  type UpdateState,
  type Sts2Settings,
  type StubScenario,
  type TrackerState,
  type WindowAction
} from '@shared/types'

/**
 * The ONLY bridge between the sandboxed renderer and the main process.
 * Exposes a small, typed API on window.spectra — nothing else leaks through.
 */
const api: SpectraApi = {
  onData(cb: (snapshot: KeyedSnapshot) => void): () => void {
    const listener = (_e: unknown, snapshot: KeyedSnapshot): void => cb(snapshot)
    ipcRenderer.on(IPC.Data, listener)
    return () => ipcRenderer.removeListener(IPC.Data, listener)
  },

  onTracker(cb: (state: TrackerState) => void): () => void {
    const listener = (_e: unknown, state: TrackerState): void => cb(state)
    ipcRenderer.on(IPC.Tracker, listener)
    return () => ipcRenderer.removeListener(IPC.Tracker, listener)
  },

  onDiagnostics(cb: (state: DiagnosticsState) => void): () => void {
    const listener = (_e: unknown, state: DiagnosticsState): void => cb(state)
    ipcRenderer.on(IPC.Diagnostics, listener)
    return () => ipcRenderer.removeListener(IPC.Diagnostics, listener)
  },

  setInteractive(interactive: boolean): void {
    ipcRenderer.send(IPC.SetInteractive, interactive)
  },

  requestState(): void {
    ipcRenderer.send(IPC.RequestState)
  },

  setScenario(scenario: StubScenario): void {
    ipcRenderer.send(IPC.SetScenario, scenario)
  },

  setSettings(patch: Partial<Sts2Settings>): void {
    ipcRenderer.send(IPC.SetSettings, patch)
  },

  onLog(cb: (lines: LogLine[]) => void): () => void {
    const listener = (_e: unknown, lines: LogLine[]): void => cb(lines)
    ipcRenderer.on(IPC.Log, listener)
    return () => ipcRenderer.removeListener(IPC.Log, listener)
  },

  onWindowMaximized(cb: (maximized: boolean) => void): () => void {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on(IPC.WindowMaximized, listener)
    return () => ipcRenderer.removeListener(IPC.WindowMaximized, listener)
  },

  windowControl(action: WindowAction): void {
    ipcRenderer.send(IPC.WindowControl, action)
  },

  onUpdate(cb: (state: UpdateState) => void): () => void {
    const listener = (_e: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on(IPC.Update, listener)
    return () => ipcRenderer.removeListener(IPC.Update, listener)
  },

  updateAction(action: UpdateAction): void {
    ipcRenderer.send(IPC.UpdateAction, action)
  },

  report(event: RendererTelemetryEvent): void {
    // Renderers never reach the network themselves; main owns the only client.
    try {
      ipcRenderer.send(IPC.Telemetry, event)
    } catch {
      // reporting must never break the surface it is reporting on
    }
  }
}

contextBridge.exposeInMainWorld('spectra', api)
