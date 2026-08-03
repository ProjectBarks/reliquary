import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import type { WindowBounds } from '@shared/types'

/**
 * A reusable transparent, frameless, always-on-top, click-through overlay window.
 *
 * This mirrors the technique real game overlays use:
 *   - transparent + frameless so only your React UI is visible
 *   - alwaysOnTop at 'screen-saver' level so it floats above fullscreen games
 *   - setIgnoreMouseEvents(true, { forward: true }) so clicks pass THROUGH to the
 *     game until you explicitly make a region interactive.
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null
  private interactive = false

  create(): BrowserWindow {
    this.win = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      // keep it out of screen capture of the game if desired:
      // (comment out if you WANT it captured by OBS)
      // contentProtection handled below via setContentProtection
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })

    // Float above fullscreen games.
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    // Start fully click-through.
    this.setInteractive(false)

    // Open external links in the user's browser, never in the overlay.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    this.win.on('closed', () => {
      this.win = null
    })

    return this.win
  }

  /**
   * Load the renderer at a hash route (dev server URL in dev, built HTML in
   * prod). The single React bundle uses HashRouter, so `hash` selects which
   * screen this window shows (e.g. '/overlay/sts2').
   */
  load(hash: string, devServerUrl?: string): void {
    if (!this.win) return
    const suffix = hash.startsWith('#') ? hash : `#${hash}`
    if (devServerUrl) {
      this.win.loadURL(`${devServerUrl}${suffix}`)
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'), { hash: suffix })
    }
  }

  show(): void {
    this.win?.showInactive() // show without stealing focus from the game
  }

  /**
   * Toggle whether the overlay swallows mouse input.
   *  - interactive=false: clicks pass through to the game (default HUD mode)
   *  - interactive=true:  overlay receives clicks (menus, drag, config)
   */
  setInteractive(interactive: boolean): void {
    if (!this.win) return
    this.interactive = interactive
    if (interactive) {
      this.win.setIgnoreMouseEvents(false)
      this.win.setFocusable(true)
    } else {
      // forward:true still lets us receive mousemove for hover effects.
      this.win.setIgnoreMouseEvents(true, { forward: true })
      this.win.setFocusable(false)
    }
  }

  isInteractive(): boolean {
    return this.interactive
  }

  /** Pin the overlay exactly over the given screen rectangle. */
  applyBounds(b: WindowBounds): void {
    if (!this.win) return
    // The native getWindowInfo rect is in PHYSICAL screen pixels, but Electron's
    // setBounds/setPosition expect device-independent pixels (DIP). On any
    // monitor scaled != 100% (125/150/200%), passing physical px straight
    // through offsets and mis-sizes the overlay by (scaleFactor - 1). Convert
    // first — this mirrors the original's screenToDipRect step and is the main
    // fix for panels being visibly misaligned from the game.
    const phys = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height)
    }
    const dip = screen.screenToDipRect(this.win, phys)
    this.win.setPosition(Math.ceil(dip.x), Math.ceil(dip.y))
    this.win.setBounds({
      x: Math.ceil(dip.x),
      y: Math.ceil(dip.y),
      width: Math.ceil(dip.width),
      height: Math.ceil(dip.height)
    })
    // Scale the whole overlay so fixed-pixel panels (deck tracker, hover tips)
    // track the game's own 1080p-referenced UI scale. Percentage/fraction
    // anchors are unaffected; only pixel sizes grow/shrink. Mirrors the
    // original's `zoom = renderedHeight / 1080` sent to the renderer.
    const zoom = dip.height / 1080
    if (zoom > 0 && Number.isFinite(zoom)) this.win.webContents.setZoomFactor(zoom)
  }

  get browserWindow(): BrowserWindow | null {
    return this.win
  }
}
