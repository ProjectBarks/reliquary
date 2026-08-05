import { app } from 'electron'
import { telemetry } from '../telemetry/Telemetry'
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
 */

const req = createRequire(join(app.getAppPath(), 'package.json'))

function firstExisting(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function vendorRoots(): string[] {
  const roots: string[] = []
  // Packaged: the native module ships as an extraResource at
  // `<resources>/vendor` (electron-builder `extraResources: from vendor to vendor`),
  // NOT inside app.asar — so look there first.
  if (app.isPackaged) roots.push(join(process.resourcesPath, 'vendor'))
  roots.push(join(app.getAppPath(), 'vendor'), join(process.cwd(), 'vendor'))
  return roots
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
    telemetry.issue('scry_binary_missing', 'error', {
      candidates,
      packaged: process.env['NODE_ENV'] !== 'development'
    })
    return { module: null, error: scryError }
  }
  try {
    const mod = req(binary) as ScryModule
    if (!mod.Scry || !mod.GodotScry || !mod.DotNetCoreScry) {
      scryError = `untapped-scry loaded but missing exports (got: ${Object.keys(mod).join(', ')})`
      telemetry.issue('scry_missing_exports', 'error', { exports: Object.keys(mod) })
      return { module: null, error: scryError }
    }
    scryCache = mod
    return { module: mod, error: null }
  } catch (err) {
    scryError = err instanceof Error ? err.message : String(err)
    telemetry.issue('scry_require_failed', 'error', { binary }, err)
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
    telemetry.issue('node_native_require_failed', 'error', {}, err)
    return { module: null, error: nativeError }
  }
}
