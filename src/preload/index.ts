import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AmbiguityResolution,
  type AnalysisStatus,
  type CatalogEntry,
  type CatalogPayload,
  type CodexCatalogKind,
  type CodexPushMessage,
  type DiagnosticsState,
  type JournalPushMessage,
  type JournalResult,
  type RunFile,
  type MetricsPayload,
  type MetricsQuery,
  type KeyedSnapshot,
  type LogLine,
  type RendererTelemetryEvent,
  type SpectraApi,
  type UpdateCommand,
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

  openExternal(url: string): void {
    ipcRenderer.send(IPC.OpenExternal, url)
  },

  // The codex channels are the only invoke/response pair in this bridge. Main
  // resolves them with `{data,…}` or `{error}` and never rejects, so there is
  // deliberately no try/catch here to flatten a rejection into — a throw
  // escaping these would mean a bug in main, and swallowing it would hide it.
  codexCatalog<K extends CodexCatalogKind>(kind: K): Promise<CatalogPayload<K>> {
    return ipcRenderer.invoke(IPC.CodexCatalog, kind)
  },

  codexMetrics(query: MetricsQuery): Promise<MetricsPayload> {
    return ipcRenderer.invoke(IPC.CodexMetrics, query)
  },

  codexRefresh(kind: CodexCatalogKind): Promise<void> {
    return ipcRenderer.invoke(IPC.CodexRefresh, kind)
  },

  onCodexPush(cb: (message: CodexPushMessage) => void): () => void {
    const listener = (_e: unknown, message: CodexPushMessage): void => cb(message)
    ipcRenderer.on(IPC.CodexPush, listener)
    return () => ipcRenderer.removeListener(IPC.CodexPush, listener)
  },

  // The run journal, on the same spine as the codex block above: invoke for the
  // Archive's questions, one push for the answers that change under it, and the
  // live run on the keyed snapshot channel rather than here.
  journalList(): Promise<JournalResult<CatalogEntry[]>> {
    return ipcRenderer.invoke(IPC.JournalList)
  },

  journalGet(id: string): Promise<JournalResult<RunFile>> {
    return ipcRenderer.invoke(IPC.JournalGet, id)
  },

  journalDelete(id: string): Promise<JournalResult<boolean>> {
    return ipcRenderer.invoke(IPC.JournalDelete, id)
  },

  journalReanalyze(id: string): Promise<JournalResult<AnalysisStatus>> {
    return ipcRenderer.invoke(IPC.JournalReanalyze, id)
  },

  journalExport(id: string): Promise<JournalResult<{ path: string; bytes: number }>> {
    return ipcRenderer.invoke(IPC.JournalExport, id)
  },

  journalResolveAmbiguity(
    id: string,
    resolution: AmbiguityResolution
  ): Promise<JournalResult<{ id: string; merged: boolean }>> {
    return ipcRenderer.invoke(IPC.JournalResolveAmbiguity, { id, resolution })
  },

  onJournalPush(cb: (message: JournalPushMessage) => void): () => void {
    const listener = (_e: unknown, message: JournalPushMessage): void => cb(message)
    ipcRenderer.on(IPC.JournalPush, listener)
    return () => ipcRenderer.removeListener(IPC.JournalPush, listener)
  },

  onUpdate(cb: (state: UpdateState) => void): () => void {
    const listener = (_e: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on(IPC.Update, listener)
    return () => ipcRenderer.removeListener(IPC.Update, listener)
  },

  updateAction(command: UpdateCommand): void {
    ipcRenderer.send(IPC.UpdateAction, command)
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
