import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { telemetry } from '../telemetry/Telemetry'
import type { UpdateState } from '@shared/types'

/**
 * Over-the-air updates via electron-updater, served from GitHub Releases.
 *
 * electron-builder publishes `latest.yml` next to the installer; the updater
 * polls that, downloads the new NSIS package in the background, and swaps it in
 * on quit. No update server to run.
 *
 * Two decisions worth stating:
 *
 *  - Installation happens on QUIT, never mid-session. Reliquary is pinned over a
 *    running game; relaunching underneath someone mid-run would be worse than
 *    shipping the fix a session later.
 *  - A failed update check is a non-event for the user. It is reported, but it
 *    never surfaces a dialog and never blocks startup — an update server being
 *    down must not degrade an app that is otherwise working fine.
 */

/** Wait this long after launch before the first check, so startup stays clear. */
const FIRST_CHECK_DELAY_MS = 20_000
/** Then re-check on this cadence for long-running sessions. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export class AutoUpdater {
  private state: UpdateState = { status: 'idle', version: null, percent: 0, error: null }
  private timer: NodeJS.Timeout | null = null
  private started = false

  constructor(private readonly onChange: (state: UpdateState) => void) {}

  get current(): UpdateState {
    return this.state
  }

  start(): void {
    if (this.started) return
    this.started = true

    // An unpackaged run has no installer to replace, and electron-updater
    // throws rather than no-ops. Report the state so the UI can explain itself.
    if (!app.isPackaged) {
      this.set({ status: 'dev-disabled' })
      console.log('[updater] disabled in development (no packaged installer to replace)')
      return
    }
    if (process.env['SPECTRA_NO_UPDATE']) {
      this.set({ status: 'disabled' })
      console.log('[updater] disabled by SPECTRA_NO_UPDATE')
      return
    }

    autoUpdater.autoDownload = true
    // Install on quit, not mid-session — see the class comment.
    autoUpdater.autoInstallOnAppQuit = true
    // We ship a full NSIS installer, never a web installer. This is an updater
    // RUNTIME property — it is not an electron-builder `nsis` build option, and
    // putting it there fails the build on an unknown config key.
    autoUpdater.disableWebInstaller = true
    autoUpdater.logger = {
      info: (m: unknown) => console.log(`[updater] ${String(m)}`),
      warn: (m: unknown) => console.warn(`[updater] ${String(m)}`),
      error: (m: unknown) => console.error(`[updater] ${String(m)}`),
      debug: () => {}
    }

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }))

    autoUpdater.on('update-available', (info) => {
      this.set({ status: 'downloading', version: info.version, percent: 0, error: null })
      telemetry.capture('update_available', { from: app.getVersion(), to: info.version })
    })

    autoUpdater.on('update-not-available', () => this.set({ status: 'current', error: null }))

    autoUpdater.on('download-progress', (p) => {
      this.set({ status: 'downloading', percent: Math.round(p.percent) })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version, percent: 100, error: null })
      console.log(`[updater] ${info.version} downloaded; installs on quit`)
      telemetry.capture('update_downloaded', { from: app.getVersion(), to: info.version })
    })

    autoUpdater.on('error', (err) => {
      // Never fatal: a broken update path must not degrade a working app.
      this.set({ status: 'error', error: String(err?.message ?? err).slice(0, 200) })
      telemetry.issue('update_failed', 'warn', { app_version: app.getVersion() }, err)
    })

    setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS).unref?.()
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Check now. Safe to call any time; failures are reported, never thrown. */
  check(): void {
    if (!app.isPackaged || this.state.status === 'ready') return
    void autoUpdater.checkForUpdates().catch((err) => {
      this.set({ status: 'error', error: String(err?.message ?? err).slice(0, 200) })
      telemetry.issue('update_check_failed', 'warn', {}, err)
    })
  }

  /** Quit and install a downloaded update, at the user's request. */
  installNow(): void {
    if (this.state.status !== 'ready') return
    telemetry.capture('update_install_requested', { to: this.state.version })
    // isSilent=false so the NSIS installer shows progress; isForceRunAfter=true
    // so the user lands back in the app rather than at their desktop.
    autoUpdater.quitAndInstall(false, true)
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }
}
