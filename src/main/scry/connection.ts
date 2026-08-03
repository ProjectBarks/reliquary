/**
 * Detects the running StS2 process and opens a scry connection to it.
 *
 * Mirrors the original companion's ScryConnectionBase.connect (decomp/scry
 * ~6949-6996) and its Win32 process watcher (decomp/core:22857 —
 * windowName "Slay the Spire 2", windowClassName "Engine"). We find the game
 * window via the vendored untapped-node-native helper, connect the memory
 * reader by pid, then build a GodotContext from the Godot engine + sts2 module.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { GodotContext } from './godot'
import { loadScryModule, loadNodeNative, type WindowInfo } from './native'

const STS2_GODOT_VERSION = '4.5.1'
const STS2_DOTNET_VERSION = '9.0.2'
const STS2_MODULE_NAME = 'sts2'
const WINDOW_CLASS = 'Engine'
const WINDOW_NAME = 'Slay the Spire 2'

export interface GameProcess {
  pid: number
  bounds: { x: number; y: number; width: number; height: number }
  active: boolean
}

export class ScryConnection {
  private context: GodotContext | null = null
  private raw: any = null
  private pid: number | null = null
  private lastError: string | null = null

  /** Locate the game window; null when it isn't running/visible. */
  static findGameProcess(): { proc: GameProcess | null; error: string | null } {
    const { module, error } = loadNodeNative()
    if (!module) return { proc: null, error }
    let info: WindowInfo
    try {
      info = module.getWindowInfo(WINDOW_CLASS, WINDOW_NAME)
    } catch (err) {
      return { proc: null, error: err instanceof Error ? err.message : String(err) }
    }
    if (!info.exists || !info.pid) return { proc: null, error: null }
    const rect = info.rect ?? { x: 0, y: 0, width: 0, height: 0 }
    return {
      proc: {
        pid: info.pid,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        active: info.active
      },
      error: null
    }
  }

  get connectedPid(): number | null {
    return this.pid
  }
  get error(): string | null {
    return this.lastError
  }
  isConnected(): boolean {
    return this.context !== null
  }

  /** Connect to the given pid and build the Godot context. Idempotent per-pid. */
  connect(pid: number): boolean {
    if (this.context && this.pid === pid) return true
    if (this.pid !== null && this.pid !== pid) this.disconnect()

    const { module, error } = loadScryModule()
    if (!module) {
      this.lastError = error
      return false
    }
    try {
      const raw = module.Scry.connect(pid)
      const dotnet = new module.DotNetCoreScry(raw, { enumerateProperties: false })
      const godot = new module.GodotScry(raw)
      this.context = new GodotContext(
        godot.getGodotEngine(STS2_GODOT_VERSION, STS2_DOTNET_VERSION),
        dotnet.getModule(STS2_MODULE_NAME, STS2_DOTNET_VERSION)
      )
      this.raw = raw
      this.pid = pid
      this.lastError = null
      return true
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.context = null
      this.raw = null
      this.pid = null
      return false
    }
  }

  getContext(): GodotContext | null {
    return this.context
  }

  /**
   * Rebuild the dotnet/godot views on the same raw connection. The game moving
   * things in memory can invalidate cached class handles; the original does the
   * same on a watcher crash (decomp/scry ~6984).
   */
  restart(): boolean {
    if (this.raw === null || this.pid === null) return false
    const { module } = loadScryModule()
    if (!module) return false
    try {
      const dotnet = new module.DotNetCoreScry(this.raw, { enumerateProperties: false })
      const godot = new module.GodotScry(this.raw)
      this.context = new GodotContext(
        godot.getGodotEngine(STS2_GODOT_VERSION, STS2_DOTNET_VERSION),
        dotnet.getModule(STS2_MODULE_NAME, STS2_DOTNET_VERSION)
      )
      return true
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  disconnect(): void {
    this.context = null
    this.raw = null
    this.pid = null
  }
}
