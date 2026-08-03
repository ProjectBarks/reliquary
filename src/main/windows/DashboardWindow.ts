import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { iconPath } from '../assets'
import type { WindowAction } from '@shared/types'

/**
 * The app's main window (#/). Frameless + transparent so the renderer can paint
 * its own rounded, padded "floating panel" chrome and a custom titlebar (drag
 * region + minimize/maximize/close) that matches the in-game overlay styling —
 * no native OS window frame. Shares the React bundle with the overlay window;
 * HashRouter selects the route.
 */
export class DashboardWindow {
  private win: BrowserWindow | null = null

  create(): BrowserWindow {
    this.win = new BrowserWindow({
      width: 1000,
      height: 760,
      minWidth: 720,
      minHeight: 520,
      show: false,
      frame: false,
      // Opaque (not transparent) so Windows 11 draws a real native DWM drop
      // shadow + native rounded corners for us — a transparent window suppresses
      // the native shadow (the old CSS shadow looked clipped/"corny"). Keeping it
      // opaque also drops one transparent surface, easing GPU-crash pressure.
      transparent: false,
      backgroundColor: '#171512',
      hasShadow: true,
      roundedCorners: true,
      icon: iconPath(),
      title: 'Reliquary',
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // Keep the renderer's maximized styling in sync with the real window state.
    const emitMaximized = (): void => this.emitMaximized()
    this.win.on('maximize', emitMaximized)
    this.win.on('unmaximize', emitMaximized)

    this.win.on('closed', () => {
      this.win = null
    })

    return this.win
  }

  /** Load the dashboard route (#/) — dev server URL in dev, built HTML in prod. */
  load(devServerUrl?: string): void {
    if (!this.win) return
    if (devServerUrl) {
      this.win.loadURL(`${devServerUrl}#/`)
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '#/' })
    }
  }

  show(): void {
    this.win?.show()
  }

  /** Apply a titlebar control action from the renderer. */
  control(action: WindowAction): void {
    const win = this.win
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'close') win.close()
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
  }

  /** Push the current maximized state to the renderer. */
  emitMaximized(): void {
    if (!this.win) return
    this.win.webContents.send('spectra:window-maximized', this.win.isMaximized())
  }

  get browserWindow(): BrowserWindow | null {
    return this.win
  }
}
