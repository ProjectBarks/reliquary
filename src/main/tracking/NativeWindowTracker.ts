import { WindowTracker } from './WindowTracker'
import type { TrackerState } from '@shared/types'

/**
 * Minimal shape of the parts of `node-window-manager` we use. Declared locally
 * so this file type-checks whether or not the optional module is installed.
 */
interface NWWindow {
  getTitle(): string
  isVisible(): boolean
  getBounds(): { x?: number; y?: number; width?: number; height?: number }
}
interface NWManager {
  getWindows(): NWWindow[]
}

/**
 * Tracks a specific OS window by (case-insensitive) title substring, using the
 * optional `node-window-manager` native module. If that module isn't installed
 * or fails to load, callers should fall back to FullscreenTracker.
 *
 * This is the equivalent of Untapped's Win32ProcessWatcher.getWindowInfo(): it
 * finds the game window and reports its live bounds so the overlay follows it
 * as the player moves/resizes the game.
 */
export class NativeWindowTracker extends WindowTracker {
  private wm: NWManager | null = null

  constructor(
    intervalMs: number,
    private titleMatch: string,
    private label: string
  ) {
    super(intervalMs)
  }

  /** Attempt to load the native module. Returns false if unavailable. */
  static isAvailable(): boolean {
    try {
      require.resolve('node-window-manager')
      return true
    } catch {
      return false
    }
  }

  private ensureLoaded(): boolean {
    if (this.wm) return true
    try {
      // lazy require so a missing optional dep never crashes startup
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('node-window-manager') as { windowManager: NWManager }
      this.wm = mod.windowManager
      return true
    } catch {
      return false
    }
  }

  sample(): TrackerState {
    if (!this.ensureLoaded() || !this.wm) {
      return { attached: false, bounds: null, target: this.label }
    }
    const needle = this.titleMatch.toLowerCase()
    const match = this.wm
      .getWindows()
      .find((w) => (w.getTitle() || '').toLowerCase().includes(needle))

    if (!match || !match.isVisible()) {
      return { attached: false, bounds: null, target: this.label }
    }
    const b = match.getBounds()
    if (
      b.x === undefined ||
      b.y === undefined ||
      b.width === undefined ||
      b.height === undefined
    ) {
      return { attached: false, bounds: null, target: this.label }
    }
    return {
      attached: true,
      target: this.label,
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
    }
  }
}
