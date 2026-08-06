import { createRequire } from 'module'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Loads the two vendored native modules that the original Untapped companion
 * uses, bypassing their published loaders:
 *
 *   - `untapped-scry`      — memory reader. Its stock `lib/index.js` pulls the
 *     binary path from `@mapbox/node-pre-gyp` (a dep we don't vendor), so we
 *     require the prebuilt `.node` directly. Exports Scry/DotNetCoreScry/
 *     GodotScry/Il2CppScry/MonoScry.
 *   - `untapped-node-native` — Win32 window/process helpers (getWindowInfo →
 *     pid + client rect). Its own index.js already requires the `.node`
 *     directly, so we can load it as-is.
 *
 * createRequire (not the bundler's require) keeps electron-vite from trying to
 * resolve these vendored paths at build time.
 *
 * This module deliberately does NOT import `electron`. It is loaded inside a
 * utilityProcess, where `app` does not exist — importing it there fails the
 * whole child with "does not provide an export named 'app'". The host passes
 * the paths it resolved instead, via the environment.
 */

const APP_PATH = process.env['RELIQUARY_APP_PATH'] || process.cwd()
const req = createRequire(join(APP_PATH, 'package.json'))

function firstExisting(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function vendorRoots(): string[] {
  // The host resolves these with Electron's `app` and hands them over, because
  // packaged builds put the binary in <resources>/vendor rather than in the
  // asar and only the main process can work that out.
  const fromHost = (process.env['RELIQUARY_VENDOR_ROOTS'] ?? '')
    .split(';')
    .map((r) => r.trim())
    .filter(Boolean)
  return [...fromHost, join(APP_PATH, 'vendor'), join(process.cwd(), 'vendor')]
}

// ── untapped-scry (memory reader) ──────────────────────────────────────────

export interface RawScry {
  connect(pid: number): unknown
}
export interface ScryModule {
  Scry: RawScry & { connect(pid: number): unknown }
  DotNetCoreScry: new (raw: unknown, opts?: { enumerateProperties?: boolean }) => DotNetCoreScry
  GodotScry: new (raw: unknown) => GodotScryInstance
  Il2CppScry?: unknown
  MonoScry?: unknown
}
export interface DotNetCoreScry {
  getModule(name: string, dotnetVersion: string): unknown
}
export interface GodotScryInstance {
  getGodotEngine(godotVersion: string, dotnetVersion: string): unknown
}

let scryCache: ScryModule | null = null
let scryError: string | null = null

export function loadScryModule(): { module: ScryModule | null; error: string | null } {
  if (scryCache) return { module: scryCache, error: null }
  if (scryError) return { module: null, error: scryError }

  const binaryName = 'untapped-scry.node'
  const candidates = vendorRoots().map((root) =>
    join(root, 'untapped-scry', 'lib', 'binding', 'napi-v5', binaryName)
  )
  const binary = firstExisting(...candidates)
  if (!binary) {
    scryError = `untapped-scry native binary not found (looked in: ${candidates.join(', ')})`
    // A broken/incomplete install. Knowing WHERE we looked is the whole fix.
    return { module: null, error: scryError }
  }
  try {
    const mod = req(binary) as ScryModule
    if (!mod.Scry || !mod.GodotScry || !mod.DotNetCoreScry) {
      scryError = `untapped-scry loaded but missing exports (got: ${Object.keys(mod).join(', ')})`
      return { module: null, error: scryError }
    }
    scryCache = mod
    return { module: mod, error: null }
  } catch (err) {
    scryError = err instanceof Error ? err.message : String(err)
    return { module: null, error: scryError }
  }
}

// ── untapped-node-native (Win32 window/process helpers) ─────────────────────

export interface WindowInfo {
  findWindowError: string | null
  openProcessError: string | null
  hwnd: number
  exists: boolean
  active: boolean
  rect: { x: number; y: number; width: number; height: number }
  pid: number
}
export interface NodeNativeModule {
  getWindowInfo(windowClassName: string, windowName: string): WindowInfo
}

let nativeCache: NodeNativeModule | null = null
let nativeError: string | null = null

export function loadNodeNative(): { module: NodeNativeModule | null; error: string | null } {
  if (nativeCache) return { module: nativeCache, error: null }
  if (nativeError) return { module: null, error: nativeError }

  const indexPath = firstExisting(
    ...vendorRoots().map((root) => join(root, 'untapped-node-native', 'lib', 'index.js'))
  )
  if (!indexPath) {
    nativeError = 'untapped-node-native not found'
    return { module: null, error: nativeError }
  }
  try {
    nativeCache = req(indexPath) as NodeNativeModule
    return { module: nativeCache, error: null }
  } catch (err) {
    nativeError = err instanceof Error ? err.message : String(err)
    return { module: null, error: nativeError }
  }
}
