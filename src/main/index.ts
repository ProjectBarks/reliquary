import { app, ipcMain, globalShortcut, Menu, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { OverlayWindow } from './overlay/OverlayWindow'
import { DashboardWindow } from './windows/DashboardWindow'
import { Sts2Stub } from './stub/sts2Stub'
import { Sts2ScryProvider, type ProcessState } from './scry/provider'
import { loadScryModule } from './scry/native'
import { installLogCapture, setLogSink, logHistory } from './logBus'
import { applyGpuCrashMitigation, installGpuCrashGuard } from './gpuCrashGuard'
import { SettingsStore } from './settings/SettingsStore'
import {
  IPC,
  type DiagnosticsState,
  type KeyedSnapshot,
  type Sts2Key,
  type Sts2Settings,
  type StubScenario,
  type TrackerState,
  type WindowAction
} from '@shared/types'

// Catch stray throws/rejections so one bad callback can't silently kill the app.
// Routed through console.* so the in-app Logs tab captures them too.
process.on('uncaughtException', (err) => console.error('[spectra] uncaughtException', err))
process.on('unhandledRejection', (reason) => console.error('[spectra] unhandledRejection', reason))

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
      } catch {
        // window is tearing down; ignore
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
    codex: usingScry ? scryProvider?.codexStatus ?? null : null
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
  pushDiagnostics()
}

function emitSnapshot(snap: KeyedSnapshot): void {
  lastState.set(snap.key, snap.value)
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
      processState = state
      trackerState = {
        attached: state.detected && !!state.bounds,
        bounds: state.bounds,
        target: GAME_LABEL
      }
      if (state.detected && state.bounds) overlay.applyBounds(state.bounds)
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
  ipcMain.on(IPC.SetInteractive, (_e, interactive: boolean) => {
    overlay.setInteractive(!!interactive)
  })
  ipcMain.on(IPC.RequestState, (e) => {
    const wc = e.sender
    for (const [key, value] of lastState.entries()) {
      wc.send(IPC.Data, { key, value } as KeyedSnapshot)
    }
    wc.send(IPC.Tracker, trackerState)
    wc.send(IPC.Diagnostics, diagnostics())
    // Replay retained log history and current window state to this window.
    const history = logHistory()
    if (history.length) wc.send(IPC.Log, history)
    dashboard.emitMaximized()
  })
  ipcMain.on(IPC.SetScenario, (_e, scenario: StubScenario) => {
    stub?.setScenario(scenario)
    pushDiagnostics()
  })
  ipcMain.on(IPC.SetSettings, (_e, patch: Partial<Sts2Settings>) => {
    // Single owner for both live and stub modes; persists + re-emits so toggles
    // actually take effect during real play and survive relaunch.
    if (!settingsStore) return
    emitSnapshot({ key: 'sts2.settings', value: settingsStore.patch(patch) })
  })
  ipcMain.on(IPC.WindowControl, (_e, action: WindowAction) => {
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
const hasLock = process.env['SPECTRA_CAPTURE'] ? true : app.requestSingleInstanceLock()
if (!hasLock) app.quit()
app.on('second-instance', () => {
  const win = dashboard.browserWindow
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

if (hasLock)
  app.whenReady().then(() => {
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
  // Live is the default. Stub is a developer-only flag, never a silent fallback:
  // if the native module can't load we still run live so the dashboard surfaces
  // the real error instead of masking it with fake data.
  const devStub = !!process.env['SPECTRA_STUB']
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

  dashboard.create()
  dashboard.load(devUrl)
  dashboard.browserWindow?.webContents.once('did-finish-load', () => dashboard.show())

  overlay.create()
  overlay.load('/overlay/sts2', devUrl)
  overlay.browserWindow?.webContents.once('did-finish-load', () => {
    overlay.show()
    pushDiagnostics()
  })

  if (usingScry) wireScry()
  else wireStub()
  wireIpc()

  // Seed the renderer with persisted settings (single owner; both modes).
  emitSnapshot({ key: 'sts2.settings', value: settingsStore.get() })

  const bound = globalShortcut.register(HIDE_OVERLAY_ACCELERATOR, toggleOverlayHidden)
  if (!bound) {
    console.warn(
      `[spectra] could not register hide-overlay hotkey (${HIDE_OVERLAY_ACCELERATOR}); it may be taken by another app.`
    )
  } else {
    console.log(`[spectra] hide-overlay hotkey: ${HIDE_OVERLAY_ACCELERATOR}`)
  }

  const captureDir = process.env['SPECTRA_CAPTURE']
  if (captureDir) void captureScreens(captureDir)
}).catch((err) => {
  console.error('[spectra] startup failed', err)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  scryProvider?.stop()
  stub?.stop()
})

app.on('window-all-closed', () => app.quit())
