import { app, ipcMain, globalShortcut, Menu, shell, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { OverlayWindow } from './overlay/OverlayWindow'
import { DashboardWindow } from './windows/DashboardWindow'
import { Sts2Stub } from './stub/sts2Stub'
import { DemoClock, JournalDemoDriver } from './stub/journalDemoDriver'
import {
  Sts2ScryProvider,
  type ProcessState,
  type RawTapContext,
  type RawTapSignal
} from './scry/provider'
import type { RawSnapshot } from './scry/readerProtocol'
import { RunStore, resolveRunsDir, serializeRun } from './journal/RunStore'
import { RunRecorder } from './journal/RunRecorder'
import {
  AnalysisRunner,
  type AnalysisAdvisor,
  type AnalysisMetricsSource,
  type MetricsAnswer
} from './journal/AnalysisRunner'
import { codexHttp } from './codex/http'
import { installLogCapture, setLogSink, logHistory } from './logBus'
import {
  applyGpuCrashMitigation,
  gpuAccelerationDisabled,
  installGpuCrashGuard
} from './gpuCrashGuard'
import { SettingsStore } from './settings/SettingsStore'
import { CompendiumService } from './codex/CompendiumService'
import { UpdateManager } from './updater/UpdateManager'
import { APP_VERSION, telemetry } from './telemetry/Telemetry'
import { installAppTelemetry, installProcessTelemetry } from './telemetry/install'
import {
  IPC,
  isCodexBracket,
  type AmbiguityResolution,
  type AnalysisStatus,
  type CatalogEntry,
  type CodexCatalogKind,
  type JournalPushMessage,
  type JournalResult,
  type RunFile,
  type MetricsQuery,
  type RendererTelemetryEvent,
  type UpdateCommand,
  type DiagnosticsState,
  type KeyedSnapshot,
  type Sts2Key,
  type Sts2Settings,
  type StubScenario,
  type TrackerState,
  type WindowAction
} from '@shared/types'

// A GUI app's stdout can die under it (launched from a script or console that
// exits, output redirected to a closed pipe). Every console.log then raises
// EPIPE, which the uncaught-exception reporter would file as a fatal issue —
// hundreds per minute, drowning real reports. Dead stdout is not an error for
// this app; the Logs tab and telemetry are the surfaces that matter.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code !== 'EPIPE') throw err
  })
}

// Catch stray throws/rejections so one bad callback can't silently kill the app,
// and report them. Routed through console.* so the in-app Logs tab sees them too.
installProcessTelemetry()

// Must run before app is ready: disables HWA if prior runs kept losing the GPU.
applyGpuCrashMitigation()

/**
 * Main process: owns the two windows (dashboard + transparent overlay) and the
 * StS2 data source. It runs the live scry provider (memory reader pinned to the
 * live game window) by default. The stub provider is a developer-only fallback,
 * enabled with SPECTRA_STUB, never a silent default. Data flows source -> IPC
 * -> renderer on a single keyed channel.
 */

const GAME_LABEL = 'Slay the Spire 2'

/**
 * Global hotkeys to hide/show every overlay, in preference order.
 *
 * A global accelerator is exclusive per machine, so the first choice is often
 * already owned by something else — telemetry shows the binding failing on real
 * installs. Falling through a short list means the user keeps a working way to
 * hide an always-on-top window, and whichever one binds is reported so the UI
 * can name the real key instead of a dead one.
 */
const HIDE_OVERLAY_ACCELERATORS = [
  'CommandOrControl+Shift+H',
  'Alt+Shift+H',
  'CommandOrControl+Alt+H'
]

/** The accelerator that actually bound this launch, or null if none did. */
let hideOverlayAccelerator: string | null = null

const overlay = new OverlayWindow()
const dashboard = new DashboardWindow()

let overlayHidden = false

let scryProvider: Sts2ScryProvider | null = null
let stub: Sts2Stub | null = null
let runStore: RunStore | null = null
let recorder: RunRecorder | null = null
let analysis: AnalysisRunner | null = null
let settingsStore: SettingsStore | null = null
let updater: UpdateManager | null = null
let usingScry = false
let journalDemo: JournalDemoDriver | null = null

/**
 * The scripted stub run (`stub/journalDemoDriver.ts`), and whether this launch
 * wants it.
 *
 * Stub mode is the only mode with no reader, so it is the only mode where the
 * recorder would otherwise never observe anything — and a journal nobody can
 * see working is a journal nobody can trust. `SPECTRA_JOURNAL_DEMO=0` opts out;
 * `=1` replays it over an archive that already has runs (the default is to seed
 * an empty one only, so ten dev launches do not leave thirty demo runs behind).
 *
 * Live mode never constructs the clock, so the recorder there is handed exactly
 * what it is handed today.
 */
const journalDemoWanted = (): boolean =>
  !!process.env['SPECTRA_STUB'] && process.env['SPECTRA_JOURNAL_DEMO'] !== '0'
const demoClock: DemoClock | null = journalDemoWanted() ? new DemoClock() : null

let scryLoaded = false
let scryLoadError: string | null = null

let processState: ProcessState = { detected: false, pid: null, bounds: null, active: false }
let trackerState: TrackerState = { attached: false, bounds: null, target: GAME_LABEL }

// Latest value per key so a freshly-mounted renderer can replay on demand.
const lastState = new Map<Sts2Key, unknown>()

function broadcast(channel: string, payload: unknown): void {
  // Guard against a window/webContents torn down between the null check and the
  // send — a `send` on destroyed webContents throws, and from a timer callback
  // that throw escapes uncaught (a prime crashpad-kill suspect).
  for (const win of [overlay.browserWindow, dashboard.browserWindow]) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(channel, payload)
      } catch (err) {
        // Window is tearing down. Harmless in isolation, but a burst of these
        // means a renderer died without us noticing, so it is worth counting.
        telemetry.issue('broadcast_failed', 'warn', { channel }, err)
      }
    }
  }
}

/**
 * The Codex compendium. Constructed eagerly but *does nothing* until a renderer
 * invokes one of its channels — no network, no disk, not even a userData path
 * resolution — so it can be a plain const instead of another nullable that
 * every call site has to re-check.
 */
const compendium = new CompendiumService((message) => broadcast(IPC.CodexPush, message))

function diagnostics(): DiagnosticsState {
  const b = overlay.browserWindow?.getBounds() ?? null
  return {
    mode: usingScry ? 'live' : 'stub',
    overlayCreated: !!overlay.browserWindow,
    overlayVisible: overlay.browserWindow?.isVisible() ?? false,
    overlayBounds: b,
    scryModuleLoaded: usingScry ? scryProvider?.scryModuleLoaded ?? false : scryLoaded,
    scryLoadError: usingScry ? scryProvider?.scryError ?? scryLoadError : scryLoadError,
    gameDetected: usingScry ? processState.detected : false,
    gamePid: usingScry ? processState.pid : null,
    scenario: stub?.getScenario() ?? 'combat',
    codex: usingScry ? scryProvider?.codexStatus ?? null : null,
    telemetry: telemetry.status(),
    appVersion: APP_VERSION,
    readerRestarts: usingScry ? scryProvider?.readerRestarts ?? 0 : 0,
    snapshotAgeMs: usingScry ? scryProvider?.snapshotAgeMs ?? null : null,
    hideHotkey: hideOverlayAccelerator
  }
}

function pushDiagnostics(): void {
  broadcast(IPC.Diagnostics, diagnostics())
}

/**
 * Toggle the whole overlay window on/off. The overlay is focusable:false and
 * click-through, so keyboard input never reaches its renderer — a main-process
 * global shortcut is the only reliable way to bind a hide key that works while
 * the game holds focus. Hiding the window itself (rather than a CSS flag) also
 * guarantees it stops intercepting any input while hidden.
 */
function toggleOverlayHidden(): void {
  const win = overlay.browserWindow
  if (!win) return
  overlayHidden = !overlayHidden
  if (overlayHidden) win.hide()
  else win.showInactive()
  if (process.env['SPECTRA_DEBUG']) {
    console.log(`[spectra] overlay ${overlayHidden ? 'hidden' : 'shown'} via hotkey`)
  }
  telemetry.capture('overlay_toggled', { hidden: overlayHidden, via: 'hotkey' })
  pushDiagnostics()
}

/** Per-key counters so we can tell "never arrived" from "arrived empty". */
const snapshotCounts = new Map<Sts2Key, number>()

function emitSnapshot(snap: KeyedSnapshot): void {
  lastState.set(snap.key, snap.value)
  snapshotCounts.set(snap.key, (snapshotCounts.get(snap.key) ?? 0) + 1)
  // A snapshot that is null or the wrong shape produces a blank overlay with no
  // error anywhere — exactly the bug class that is impossible to report. Check
  // it at the boundary where we still know which key it was.
  telemetry.guard(
    'snapshot_validate',
    () => {
      const v = snap.value as Record<string, unknown> | null
      if (v == null) {
        // `journal.currentRun` is null whenever no run is being recorded, which
        // is most of the time and is the answer, not a missing one.
        if (snap.key !== 'journal.currentRun') {
          telemetry.issue('snapshot_null', 'warn', { key: snap.key })
        }
      } else if (snap.key === 'sts2.cardData' && Object.keys(v).length === 0) {
        telemetry.issue('carddata_empty', 'warn', { key: snap.key })
      }
      if (snapshotCounts.get(snap.key) === 1) {
        telemetry.capture('snapshot_first', { key: snap.key })
      }
    },
    undefined,
    { key: snap.key }
  )
  if (process.env['SPECTRA_DEBUG']) {
    const v = snap.value as any
    let brief = ''
    if (snap.key === 'sts2.pileState') brief = `draw=${v?.draw?.length} hand=${v?.hand?.length} discard=${v?.discard?.length}`
    else if (snap.key === 'sts2.nGameState') brief = `room=${v?.room?.type} char=${v?.localPlayer?.characterId}`
    else if (snap.key === 'sts2.enemiesState') brief = `enemies=${v?.enemies?.length} inProgress=${v?.isCombatInProgress}`
    else if (snap.key === 'sts2.cardData') brief = `cards=${Object.keys(v ?? {}).length}`
    else if (snap.key === 'sts2.layoutState') brief = `source=${v?.source} panels=${v?.panels?.length}`
    console.log(`[spectra:emit] ${snap.key} ${brief}`)
  }
  broadcast(IPC.Data, snap)
}

/**
 * The run journal. The store owns persistence, the recorder owns meaning, and
 * both are constructed here because both need things only the app can answer:
 * the userData directory, the single-instance lock (a second process must never
 * write the same catalog), and the real clocks.
 *
 * Constructed eagerly but *idle*: `recorder.start()` — which runs the
 * rebuild-by-scan — is deliberately deferred to after the dashboard has
 * painted, and sightings observed before it finishes are held rather than acted
 * on (audit A10). A held sighting costs nothing: the next poll 250 ms later
 * carries the same facts.
 */
/**
 * Draft-advice replays for the post-run review, on the provider's own advisor.
 *
 * `ready()` is the politeness gate: no provider means no client (stub mode, or
 * a launch where scry never came up), and a cooling endpoint means the shared
 * `codexHttp` has just been rate-limited — replaying into that would spend a
 * request to be told no, and would do it while the live overlay needs the same
 * endpoint. Either way the pipeline records the offer as ungraded and stays
 * `partial`, which the user can upgrade with one click later.
 */
const journalAdvisor: AnalysisAdvisor = {
  ready: () => !!scryProvider && !codexHttp.cooling('/api/draft-advice'),
  advise: async (deck, offered) => {
    const client = scryProvider?.codexClient
    if (!client) return null
    return client.advise(deck, offered)
  }
}

/**
 * The character-sliced metrics table, through the compendium — which means a
 * 30-minute cache the Codex tab has usually filled already, and one shared
 * in-flight request when it has not. `fetchedAt` travels with the answer so the
 * pipeline can tell a real request from a cache hit and count only the former
 * against its budget.
 */
const journalMetrics: AnalysisMetricsSource = {
  cards: async ({ character, bracket }): Promise<MetricsAnswer | null> => {
    const payload = await compendium.metrics({
      kind: 'cards',
      bracket: isCodexBracket(bracket) ? bracket : 'all',
      character
    })
    const table = payload.data
    if (!table) return null
    return {
      bracket: table.bracket,
      character: table.character,
      totalRuns: table.total_runs,
      characterRuns: table.character_runs,
      rows: table.rows,
      apiVersion: payload.apiVersion,
      fetchedAt: payload.fetchedAt
    }
  }
}

function wireJournal(): void {
  runStore = new RunStore({
    baseDir: resolveRunsDir(app.getPath('userData')),
    hasLock,
    onIssue: (key, severity, props, err) => telemetry.issue(key, severity, props, err)
  })
  // The post-run pipeline. Both of its network legs are *adapters* onto things
  // that already exist — the provider's advisor and the compendium's cache — so
  // the analysis can never open a second connection to spire-codex.com or count
  // the 15-req/min budget from its own corner.
  analysis = new AnalysisRunner({
    store: runStore,
    advisor: journalAdvisor,
    metrics: journalMetrics,
    onIssue: (key, severity, props, err) => telemetry.issue(key, severity, props, err),
    onEvent: (name, props) => telemetry.capture(name, props),
    onStatus: (id, status) => pushJournal({ kind: 'analysis', id, status }),
    onCatalog: (entries) => pushJournal({ kind: 'catalog', entries })
  })
  recorder = new RunRecorder({
    store: runStore,
    // Only in stub mode, and only so the scripted demo can compress its ~20
    // minutes into a few seconds of real time with internally consistent
    // timestamps. Un-engaged the clock *is* `Date.now`/`hrtime`, and in live
    // mode it is not constructed at all.
    ...(demoClock ? { now: demoClock.now, monotonic: demoClock.monotonic } : {}),
    onIssue: (key, severity, props, err) => telemetry.issue(key, severity, props, err),
    onEvent: (name, props) => telemetry.capture(name, props),
    onCurrentRun: (value) => emitSnapshot({ key: 'journal.currentRun', value }),
    onCatalog: (entries) => pushJournal({ kind: 'catalog', entries }),
    // A run closes; the review starts. Queued rather than awaited: the recorder
    // is on the poll path and must never wait for a network round trip.
    onRunClosed: (id) => analysis?.enqueue(id)
  })
  // Seed the key so a dashboard that opens before any run still learns the
  // answer ("no run in progress") through the ordinary RequestState replay.
  emitSnapshot({ key: 'journal.currentRun', value: null })
}

function pushJournal(message: JournalPushMessage): void {
  broadcast(IPC.JournalPush, message)
}

function wireScry(): void {
  scryProvider = new Sts2ScryProvider({
    emit: emitSnapshot,
    // The journal's real input: every poll, as read. Guarded inside the
    // provider, so a throw in here cannot cost the overlay a frame.
    onRaw: (raw: RawSnapshot, ctx: RawTapContext) => recorder?.observe(raw, ctx),
    onRawSignal: (signal: RawTapSignal) => recorder?.onSignal(signal),
    onProcess: (state: ProcessState) => {
      recorder?.onProcess(state)
      const was = processState
      processState = state
      if (was.detected !== state.detected) {
        telemetry.capture('game_process', {
          detected: state.detected,
          pid_present: state.pid != null,
          has_bounds: !!state.bounds
        })
      }
      if (state.detected && !state.bounds) {
        telemetry.issue('game_bounds_missing', 'warn', { pid_present: state.pid != null })
      }
      trackerState = {
        attached: state.detected && !!state.bounds,
        bounds: state.bounds,
        target: GAME_LABEL
      }
      if (state.detected && state.bounds) {
        telemetry.guard('overlay_apply_bounds', () => overlay.applyBounds(state.bounds!), undefined, {
          bounds: state.bounds
        })
      }
      broadcast(IPC.Tracker, trackerState)
      pushDiagnostics()
    }
  })
  scryProvider.start()
}

function wireStub(): void {
  stub = new Sts2Stub(emitSnapshot)
  stub.start()
}

/**
 * The stub's other half: a scripted run fed to the *real* recorder through the
 * same `observe`/`onProcess` surface the provider's raw tap uses.
 *
 * Started after `recorder.start()` — the rebuild-by-scan has to have finished,
 * because sightings before it are held (audit A10) and the demo's first three
 * polls would simply be dropped. It seeds an empty stub archive and otherwise
 * stands down: a demo that appended a fourth copy of itself on every dev launch
 * would be indistinguishable from a recorder bug.
 */
function startJournalDemo(): void {
  if (!demoClock || !recorder || !runStore || journalDemo) return
  const existing = runStore.list().length
  if (existing > 0 && process.env['SPECTRA_JOURNAL_DEMO'] !== '1') {
    console.log(
      `[spectra] journal demo skipped — ${existing} run(s) already in ${runStore.dir} ` +
        '(SPECTRA_JOURNAL_DEMO=1 replays it anyway)'
    )
    return
  }
  journalDemo = new JournalDemoDriver({
    recorder,
    clock: demoClock,
    log: (line) => console.log(`[spectra:journal-demo] ${line}`)
  })
  void journalDemo.start()
}

function wireIpc(): void {
  /**
   * Wrap an IPC handler so a bad payload from a renderer degrades that one
   * message instead of throwing out of the ipcMain dispatcher, where it would
   * surface as an uncaughtException with no indication of which channel caused it.
   */
  const on = (channel: string, fn: (e: Electron.IpcMainEvent, ...a: never[]) => void): void => {
    ipcMain.on(channel, (e, ...args) => {
      telemetry.guard(`ipc:${channel}`, () => fn(e, ...(args as never[])), undefined, { channel })
    })
  }

  /**
   * The invoke/response twin of `on`. Same reasoning — a throw must not escape
   * the dispatcher — but the failure mode differs: an unguarded rejection here
   * reaches the renderer as "Error invoking remote method '<channel>'", which
   * names the pipe and hides the cause. The fallback is a value the caller can
   * actually render.
   */
  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (...args: A) => Promise<R>,
    fallback: R
  ): void => {
    ipcMain.handle(channel, (_e, ...args) =>
      telemetry.guardAsync(`ipc:${channel}`, () => fn(...(args as A)), fallback, { channel })
    )
  }

  on(IPC.SetInteractive, (_e, interactive: boolean) => {
    overlay.setInteractive(!!interactive)
  })

  // Renderer-side errors and events. Renderers have no network access of their
  // own, so main is the single egress point for everything reported.
  on(IPC.Telemetry, (_e, ev: RendererTelemetryEvent) => {
    if (!ev || typeof ev.name !== 'string') return
    const base = { surface: ev.surface, ...(ev.props ?? {}) }
    if (ev.kind === 'crumb') {
      telemetry.crumb(`renderer:${ev.surface}`, `${ev.name} ${ev.message ?? ''}`)
    } else if (ev.kind === 'event') {
      telemetry.capture(ev.name, base)
    } else {
      telemetry.issue(`renderer:${ev.name}`, 'error', {
        ...base,
        error_message: ev.message,
        error_stack: ev.stack,
        component_stack: ev.componentStack
      })
    }
  })
  on(IPC.RequestState, (e) => {
    const wc = e.sender
    for (const [key, value] of lastState.entries()) {
      wc.send(IPC.Data, { key, value } as KeyedSnapshot)
    }
    wc.send(IPC.Tracker, trackerState)
    wc.send(IPC.Diagnostics, diagnostics())
    // Replay retained log history and current window state to this window.
    const history = logHistory()
    if (history.length) wc.send(IPC.Log, history)
    if (updater) wc.send(IPC.Update, updater.current)
    dashboard.emitMaximized()
  })
  on(IPC.SetScenario, (_e, scenario: StubScenario) => {
    stub?.setScenario(scenario)
    pushDiagnostics()
  })
  on(IPC.SetSettings, (_e, patch: Partial<Sts2Settings>) => {
    // Single owner for both live and stub modes; persists + re-emits so toggles
    // actually take effect during real play and survive relaunch.
    if (!settingsStore) return
    telemetry.capture('settings_changed', { keys: Object.keys(patch ?? {}), patch })
    const next = settingsStore.patch(patch)
    // Applied before the snapshot so an opt-out takes effect on this very tick.
    telemetry.setOptOut(!next.enableTelemetry)
    emitSnapshot({ key: 'sts2.settings', value: next })
  })
  on(IPC.UpdateAction, (_e, cmd: UpdateCommand) => {
    switch (cmd?.action) {
      case 'download':
        void updater?.download(cmd.version)
        break
      case 'install':
        updater?.install()
        break
      case 'cancel':
        updater?.cancel()
        break
      default:
        void updater?.check()
    }
  })

  on(IPC.WindowControl, (_e, action: WindowAction) => {
    dashboard.control(action)
  })

  // The Codex compendium. Lazy on purpose: nothing here touches the network
  // until a renderer asks, so a cold or unreachable spire-codex.com costs the
  // launch nothing. The service resolves `{error}` rather than rejecting, so
  // the fallbacks below only fire if the service itself is missing.
  handle(IPC.CodexCatalog, (kind: CodexCatalogKind) => compendium.catalog(kind), {
    error: 'compendium unavailable'
  })
  handle(IPC.CodexMetrics, (query: MetricsQuery) => compendium.metrics(query), {
    error: 'compendium unavailable'
  })
  handle(IPC.CodexRefresh, (kind: CodexCatalogKind) => compendium.refresh(kind), undefined)

  // ── the run journal ──
  // Same contract as the codex block: resolve `{data}` or `{error}`, never
  // reject. The fallbacks below are what a renderer sees if the guard itself
  // trips, which is why they are messages rather than empty successes — an
  // Archive that cannot tell "no runs" from "the journal is broken" lies.
  const journalUnavailable = 'journal unavailable'
  const withStore = async <T>(
    fn: (store: RunStore) => Promise<T> | T
  ): Promise<JournalResult<T>> => {
    if (!runStore) return { error: journalUnavailable }
    try {
      return { data: await fn(runStore) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  handle<[], JournalResult<CatalogEntry[]>>(
    IPC.JournalList,
    () => withStore((store) => store.list()),
    { error: journalUnavailable }
  )
  handle<[string], JournalResult<RunFile>>(
    IPC.JournalGet,
    (id) =>
      withStore(async (store) => {
        const run = await store.getRun(id)
        if (!run) throw new Error(`run ${id} not found`)
        return run
      }),
    { error: journalUnavailable }
  )
  handle<[string], JournalResult<boolean>>(
    IPC.JournalDelete,
    (id) =>
      withStore(async (store) => {
        const deleted = await store.delete(id)
        if (deleted) pushJournal({ kind: 'catalog', entries: store.list() })
        return deleted
      }),
    { error: journalUnavailable }
  )
  // Clears the prior review, queues the run, and resolves the moment it is
  // queued — the pipeline can take minutes (ten replays spaced 4.5 s apart) and
  // its progress reaches the open report as `journal:push` instead.
  handle<[string], JournalResult<AnalysisStatus>>(
    IPC.JournalReanalyze,
    (id) =>
      withStore(async () => {
        if (!analysis) throw new Error(journalUnavailable)
        return analysis.reanalyze(id)
      }),
    { error: journalUnavailable }
  )
  // "Export JSON" in the report header. The run file itself is inside userData
  // where nobody browses, so this writes a copy where the user actually looks
  // and hands back the path for the confirmation line.
  handle<[string], JournalResult<{ path: string; bytes: number }>>(
    IPC.JournalExport,
    (id) =>
      withStore(async (store) => {
        const run = await store.getRun(id)
        if (!run) throw new Error(`run ${id} not found`)
        const text = serializeRun(run)
        const path = join(app.getPath('downloads'), `reliquary-run-${id}.json`)
        await writeFile(path, text, 'utf8')
        telemetry.capture('journal_exported', { bytes: text.length })
        return { path, bytes: Buffer.byteLength(text) }
      }),
    { error: journalUnavailable }
  )
  handle<[{ id: string; resolution: AmbiguityResolution }], JournalResult<{ id: string; merged: boolean }>>(
    IPC.JournalResolveAmbiguity,
    (payload) =>
      withStore(async () => {
        if (!recorder) throw new Error(journalUnavailable)
        if (!payload || typeof payload.id !== 'string') throw new Error('bad payload')
        if (payload.resolution !== 'fresh' && payload.resolution !== 'resumed') {
          throw new Error('resolution must be "fresh" or "resumed"')
        }
        return recorder.resolveAmbiguity(payload.id, payload.resolution)
      }),
    { error: journalUnavailable }
  )

  // Deliberately an allow-list, not a generic opener: a compromised renderer
  // must not be able to launch arbitrary URLs (or file paths) via the shell.
  const EXTERNAL_LINKS = new Set([
    'https://github.com/ProjectBarks/reliquary',
    // Attribution: every number in the Codex tab is community data from here,
    // and "view the source" has to be a real link, not a footnote.
    'https://spire-codex.com'
  ])
  /**
   * The codex tab deep-links every entity's page (/cards/{id}, /relics/{id},
   * /potions/{id}) — 900+ exact Set entries would just restate "same origin",
   * so spire-codex.com is allowed by origin instead. Parsed, not prefix-matched:
   * "https://spire-codex.com.evil.tld/…" must not pass.
   */
  const isSpireCodexLink = (url: string): boolean => {
    try {
      return new URL(url).origin === 'https://spire-codex.com'
    } catch {
      return false
    }
  }
  on(IPC.OpenExternal, (_e, url: string) => {
    if (EXTERNAL_LINKS.has(url) || isSpireCodexLink(url)) void shell.openExternal(url)
  })
}

/**
 * Dev-only screenshot capture for the README. Run with SPECTRA_STUB=1 and
 * SPECTRA_CAPTURE=<dir>: captures the dashboard plus the overlay in combat +
 * reward stub scenarios (on a dark backdrop, since the overlay is transparent),
 * then quits.
 */
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for the post-run review to settle, so the report is photographed with
 * its findings rather than mid-`pending`. In stub mode there is no advisor and
 * usually no metrics table either, so this resolves as `partial` — the honest
 * state, and the one the screenshot should show.
 */
async function journalIdle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const pending = (runStore?.list() ?? []).filter((e) => e.analysisStatus === 'pending')
    if (!pending.length) return
    await delay(250)
  }
}

async function captureScreens(dir: string): Promise<void> {
  const ov = overlay.browserWindow
  const dash = dashboard.browserWindow
  if (!ov || !dash) return
  const ready = (w: BrowserWindow): Promise<void> =>
    w.webContents.isLoading()
      ? new Promise((r) => w.webContents.once('did-finish-load', () => r()))
      : Promise.resolve()
  await Promise.all([ready(ov), ready(dash)])
  // The Journal's views are only worth a screenshot once the scripted stub run
  // has played out; the driver finishes in a few seconds, but "a few" is not a
  // number this rig should guess at. Capped, so a driver that never resolves
  // costs a late screenshot rather than a hung capture run.
  if (journalDemo) {
    await Promise.race([journalDemo.done, delay(90_000)])
    await runStore?.flush()
    await journalIdle()
  }
  await delay(2800) // let webfonts, stub data, and intro animations settle
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dashboard.png'), (await dash.webContents.capturePage()).toPNG())
  // Optional route walk: SPECTRA_CAPTURE_ROUTES="/codex/browse/cards,/codex/meta/tiers"
  // captures the dashboard at each hash route (filename derived from the route).
  // Exists for verifying multi-view features (the codex tab) without hand-driving
  // the window; harmless when unset.
  const routes = (process.env['SPECTRA_CAPTURE_ROUTES'] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  for (const route of routes) {
    await dash.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(route)}`)
    await delay(2200) // route render + remote art
    const name = route.replace(/^[#/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '')
    writeFileSync(join(dir, `dash-${name || 'root'}.png`), (await dash.webContents.capturePage()).toPNG())
  }
  await ov.webContents.insertCSS(
    '.sts2-overlay{background:radial-gradient(120% 90% at 50% 0%,#241a33,#140f1c 60%,#0c0910)}'
  )
  for (const [scenario, file] of [
    ['combat', 'overlay-combat.png'],
    ['reward', 'overlay-reward.png']
  ] as const) {
    stub?.setScenario(scenario)
    await delay(1600)
    writeFileSync(join(dir, file), (await ov.webContents.capturePage()).toPNG())
  }
  console.log(`[spectra] captured screenshots → ${dir}`)
  app.quit()
}

// Single-instance lock: focus the existing window instead of launching a second
// overlay + scry connection that would fight over the same game. A capture run
// is exempt (it's a short-lived one-shot alongside the real instance).
const devStubEarly = (): boolean => !!process.env['SPECTRA_STUB']

const hasLock = process.env['SPECTRA_CAPTURE'] ? true : app.requestSingleInstanceLock()
if (!hasLock) {
  telemetry.capture('second_instance_exit')
  app.quit()
}
app.on('second-instance', () => {
  telemetry.capture('second_instance_focus')
  const win = dashboard.browserWindow
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

if (hasLock)
  app.whenReady().then(() => {
  // Telemetry first: everything below it is worth reporting if it fails.
  telemetry.init()
  telemetry.setContext({ hwa_disabled: gpuAccelerationDisabled() })
  installAppTelemetry()

  // No default Electron application menu on a frameless companion app.
  Menu.setApplicationMenu(null)
  // Capture main-process console output for the in-app Logs tab, then stream new
  // lines to every window. History is replayed per-window on RequestState.
  installLogCapture()
  setLogSink((line) => broadcast(IPC.Log, [line]))

  // Recover from GPU/renderer crashes (the transparent-window device-loss kill).
  installGpuCrashGuard()

  // Owns user settings for both modes; persists to userData.
  settingsStore = new SettingsStore()
  telemetry.setOptOut(!settingsStore.get().enableTelemetry)

  // Windows taskbar identity (grouping + correct icon/notifications).
  app.setAppUserModelId('me.brandonbarker.reliquary')

  // The native binary is deliberately NOT loaded here. It lives in the forked
  // reader process, so a segfault inside it cannot take this process — and
  // therefore the windows, the overlay and the crash reporter — down with it.
  // Its load status arrives from the child instead.
  telemetry.setContext({ mode: devStubEarly() ? 'stub' : 'live' })
  // Live is the default. Stub is a developer-only flag, never a silent fallback:
  // if the native module can't load we still run live so the dashboard surfaces
  // the real error instead of masking it with fake data.
  const devStub = devStubEarly()
  usingScry = !devStub
  if (devStub) {
    console.log('[spectra] SPECTRA_STUB dev flag set; using stub data (scenario switcher active).')
  } else {
    console.log('[spectra] live mode; the reader process reports its own status.')
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']

  const t0 = Date.now()
  const watchLoad = (label: string, win: BrowserWindow | null): void => {
    if (!win) {
      telemetry.issue('window_create_failed', 'fatal', { window: label })
      return
    }
    const timer = setTimeout(
      () => telemetry.issue('window_load_stalled', 'error', { window: label, waited_ms: 15_000 }),
      15_000
    )
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      telemetry.capture('window_ready', { window: label, ms: Date.now() - t0 })
    })
  }

  dashboard.create()
  dashboard.load(devUrl)
  watchLoad('dashboard', dashboard.browserWindow)
  dashboard.browserWindow?.webContents.once('did-finish-load', () => dashboard.show())

  overlay.create()
  overlay.load(process.env['SPECTRA_MOCK'] ? '/mock/tracker' : '/overlay/sts2', devUrl)
  watchLoad('overlay', overlay.browserWindow)
  overlay.browserWindow?.webContents.once('did-finish-load', () => {
    overlay.show()
    pushDiagnostics()
  })

  // Before the provider, so the raw tap has something to hand its polls to.
  wireJournal()
  if (usingScry) wireScry()
  else wireStub()
  wireIpc()

  // The rebuild-by-scan runs off the startup path (audit A10): parsing every
  // run file before the first window paints is how a journal feature becomes a
  // launch regression. Nothing is lost by waiting — the game cannot start a run
  // faster than this, and a sighting arriving early is simply held.
  //
  // Held, though, means *not recorded*, so this must not depend on a window
  // that might never finish loading: the backstop fires regardless.
  let journalStarted = false
  const startJournal = (): void => {
    if (journalStarted) return
    journalStarted = true
    void recorder
      ?.start()
      // Only after the scan: the pipeline's own resume sweep reads the catalog,
      // and before the scan the catalog is whatever the last launch left.
      .then(() => analysis?.start())
      // Stub mode only, and a no-op everywhere else.
      .then(() => startJournalDemo())
      .catch((err) => {
        telemetry.issue('journal_start_failed', 'error', {}, err)
      })
  }
  if (dashboard.browserWindow) {
    dashboard.browserWindow.webContents.once('did-finish-load', startJournal)
    setTimeout(startJournal, 20_000).unref?.()
  } else {
    startJournal()
  }

  // Seed the renderer with persisted settings (single owner; both modes).
  emitSnapshot({ key: 'sts2.settings', value: settingsStore.get() })

  // Updates from GitHub Releases, strictly user-driven: this only CHECKS on
  // its own, so the UI can announce a new version. Downloading and installing
  // happen exclusively on click, and any listed version can be chosen.
  updater = new UpdateManager((state) => broadcast(IPC.Update, state))
  updater.start()

  const tried: string[] = []
  for (const accel of HIDE_OVERLAY_ACCELERATORS) {
    tried.push(accel)
    if (telemetry.guard('hotkey_register', () => globalShortcut.register(accel, toggleOverlayHidden), false)) {
      hideOverlayAccelerator = accel
      break
    }
  }
  if (!hideOverlayAccelerator) {
    console.warn(
      `[spectra] no hide-overlay hotkey could be registered (tried ${tried.join(', ')}); all are taken by other apps.`
    )
    telemetry.issue('hotkey_register_failed', 'warn', { tried })
  } else {
    console.log(`[spectra] hide-overlay hotkey: ${hideOverlayAccelerator}`)
    if (hideOverlayAccelerator !== HIDE_OVERLAY_ACCELERATORS[0]) {
      telemetry.capture('hotkey_fallback_used', { accelerator: hideOverlayAccelerator, tried })
    }
  }
  pushDiagnostics()

  const captureDir = process.env['SPECTRA_CAPTURE']
  if (captureDir) void captureScreens(captureDir)
}).catch((err) => {
  console.error('[spectra] startup failed', err)
  telemetry.issue('startup_failed', 'fatal', {}, err)
})

/** Set once the final telemetry batch has been flushed, so the deferred quit
 *  below runs exactly once instead of looping through will-quit forever. */
let telemetryFlushed = false

app.on('will-quit', (e) => {
  globalShortcut.unregisterAll()
  scryProvider?.stop()
  stub?.stop()
  journalDemo?.stop()
  updater?.stop()
  // Synchronous, because the process will not be alive for a promise, and
  // idempotent, because `will-quit` fires twice (the telemetry flush below
  // preventDefaults the first one). A live run ends its session honestly here
  // rather than being found as a crash orphan next launch.
  // Stopped before the synchronous flush, so a mid-flight review cannot dirty
  // the store after it has been written. An analysis interrupted here is
  // `partial` on disk and resumes next launch, which is exactly the contract.
  analysis?.dispose()
  telemetry.guard('journal_quit_flush', () => recorder?.flushSync(), undefined)
  recorder?.dispose()
  runStore?.dispose()
  // Hold the quit briefly so the final batch — including the exit-time issue
  // summaries, which are the only record of failures that never crossed a
  // report threshold — actually leaves the process.
  if (telemetryFlushed || !telemetry.isEnabled()) return
  telemetryFlushed = true
  e.preventDefault()
  const done = (): void => app.quit()
  // Never let a hung network call block quit.
  const bail = setTimeout(done, 3000)
  void telemetry.shutdown('will-quit').finally(() => {
    clearTimeout(bail)
    done()
  })
})

app.on('window-all-closed', () => app.quit())
