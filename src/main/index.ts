import { app, ipcMain, globalShortcut, Menu, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { OverlayWindow } from './overlay/OverlayWindow'
import { DashboardWindow } from './windows/DashboardWindow'
import { Sts2Stub } from './stub/sts2Stub'
import { Sts2ScryProvider, type ProcessState } from './scry/provider'
import { loadScryModule } from './scry/native'
import { installLogCapture, setLogSink, logHistory } from './logBus'
import {
  applyGpuCrashMitigation,
  gpuAccelerationDisabled,
  installGpuCrashGuard
} from './gpuCrashGuard'
import { SettingsStore } from './settings/SettingsStore'
import { AutoUpdater } from './updater/AutoUpdater'
import { APP_VERSION, telemetry } from './telemetry/Telemetry'
import { installAppTelemetry, installProcessTelemetry } from './telemetry/install'
import {
  IPC,
  type RendererTelemetryEvent,
  type UpdateAction,
  type DiagnosticsState,
  type KeyedSnapshot,
  type Sts2Key,
  type Sts2Settings,
  type StubScenario,
  type TrackerState,
  type WindowAction
} from '@shared/types'

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

/** Global hotkey to hide/show every overlay (works while the game is focused). */
const HIDE_OVERLAY_ACCELERATOR = 'CommandOrControl+Shift+H'

const overlay = new OverlayWindow()
const dashboard = new DashboardWindow()

let overlayHidden = false

let scryProvider: Sts2ScryProvider | null = null
let stub: Sts2Stub | null = null
let settingsStore: SettingsStore | null = null
let updater: AutoUpdater | null = null
let usingScry = false

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

function diagnostics(): DiagnosticsState {
  const b = overlay.browserWindow?.getBounds() ?? null
  return {
    mode: usingScry ? 'live' : 'stub',
    overlayCreated: !!overlay.browserWindow,
    overlayVisible: overlay.browserWindow?.isVisible() ?? false,
    overlayBounds: b,
    scryModuleLoaded: scryLoaded,
    scryLoadError: usingScry ? scryProvider?.scryError ?? scryLoadError : scryLoadError,
    gameDetected: usingScry ? processState.detected : false,
    gamePid: usingScry ? processState.pid : null,
    scenario: stub?.getScenario() ?? 'combat',
    codex: usingScry ? scryProvider?.codexStatus ?? null : null,
    telemetry: telemetry.status(),
    appVersion: APP_VERSION
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
        telemetry.issue('snapshot_null', 'warn', { key: snap.key })
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

function wireScry(): void {
  scryProvider = new Sts2ScryProvider({
    emit: emitSnapshot,
    onProcess: (state: ProcessState) => {
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
    emitSnapshot({ key: 'sts2.settings', value: settingsStore.patch(patch) })
  })
  on(IPC.UpdateAction, (_e, action: UpdateAction) => {
    if (action === 'install') updater?.installNow()
    else updater?.check()
  })

  on(IPC.WindowControl, (_e, action: WindowAction) => {
    dashboard.control(action)
  })
}

/**
 * Dev-only screenshot capture for the README. Run with SPECTRA_STUB=1 and
 * SPECTRA_CAPTURE=<dir>: captures the dashboard plus the overlay in combat +
 * reward stub scenarios (on a dark backdrop, since the overlay is transparent),
 * then quits.
 */
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function captureScreens(dir: string): Promise<void> {
  const ov = overlay.browserWindow
  const dash = dashboard.browserWindow
  if (!ov || !dash) return
  const ready = (w: BrowserWindow): Promise<void> =>
    w.webContents.isLoading()
      ? new Promise((r) => w.webContents.once('did-finish-load', () => r()))
      : Promise.resolve()
  await Promise.all([ready(ov), ready(dash)])
  await delay(2800) // let webfonts, stub data, and intro animations settle
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dashboard.png'), (await dash.webContents.capturePage()).toPNG())
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
  installAppTelemetry(() => [overlay.browserWindow, dashboard.browserWindow])

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

  // Windows taskbar identity (grouping + correct icon/notifications).
  app.setAppUserModelId('me.brandonbarker.reliquary')

  const scry = loadScryModule()
  scryLoaded = !!scry.module
  scryLoadError = scry.error
  telemetry.setContext({ scry_module_loaded: scryLoaded, mode: devStubEarly() ? 'stub' : 'live' })
  if (!scryLoaded) {
    // Without the reader the app runs but can never show live data — the single
    // most important thing to know about a broken install.
    telemetry.issue('scry_module_load_failed', 'error', { reason: scry.error })
  }
  // Live is the default. Stub is a developer-only flag, never a silent fallback:
  // if the native module can't load we still run live so the dashboard surfaces
  // the real error instead of masking it with fake data.
  const devStub = devStubEarly()
  usingScry = !devStub
  if (devStub) {
    console.log('[spectra] SPECTRA_STUB dev flag set; using stub data (scenario switcher active).')
  } else if (scryLoaded) {
    console.log('[spectra] scry module loaded; using live game data.')
  } else {
    console.warn(
      `[spectra] scry module failed to load (${scry.error}); running live anyway — overlays will wait for the game and the dashboard shows the error.`
    )
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
  overlay.load('/overlay/sts2', devUrl)
  watchLoad('overlay', overlay.browserWindow)
  overlay.browserWindow?.webContents.once('did-finish-load', () => {
    overlay.show()
    pushDiagnostics()
  })

  if (usingScry) wireScry()
  else wireStub()
  wireIpc()

  // Seed the renderer with persisted settings (single owner; both modes).
  emitSnapshot({ key: 'sts2.settings', value: settingsStore.get() })

  // Over-the-air updates from GitHub Releases. Downloads in the background and
  // installs on quit, so a new build never interrupts a run in progress.
  updater = new AutoUpdater((state) => broadcast(IPC.Update, state))
  updater.start()

  const bound = globalShortcut.register(HIDE_OVERLAY_ACCELERATOR, toggleOverlayHidden)
  if (!bound) {
    console.warn(
      `[spectra] could not register hide-overlay hotkey (${HIDE_OVERLAY_ACCELERATOR}); it may be taken by another app.`
    )
    telemetry.issue('hotkey_register_failed', 'warn', { accelerator: HIDE_OVERLAY_ACCELERATOR })
  } else {
    console.log(`[spectra] hide-overlay hotkey: ${HIDE_OVERLAY_ACCELERATOR}`)
  }

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
  updater?.stop()
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
