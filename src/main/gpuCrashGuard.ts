import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

/**
 * Survives the transparent-window GPU device-loss that otherwise reaps the app
 * with a bare `crashpad_client_win.cc(868) not connected` (no JS stack). Mirrors
 * the original companion's GpuCrashGuard: count GPU/renderer child-process
 * crashes, disable hardware acceleration after repeated hits, and relaunch once
 * so a single device-loss doesn't leave a dead overlay. Two transparent windows
 * (overlay + dashboard) make Windows GPU device-loss the prime crash suspect.
 */

interface CrashState {
  disableHwa: boolean
  crashes: number
  updatedAt: number
}

const DISABLE_AFTER = 2
const DECAY_MS = 60_000

function stateFile(): string {
  return join(app.getPath('userData'), 'gpu-crash-state.json')
}

function readState(): CrashState {
  try {
    return {
      disableHwa: false,
      crashes: 0,
      updatedAt: 0,
      ...(JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<CrashState>)
    }
  } catch {
    return { disableHwa: false, crashes: 0, updatedAt: 0 }
  }
}

function writeState(s: CrashState): void {
  try {
    writeFileSync(stateFile(), JSON.stringify(s))
  } catch {
    // best-effort
  }
}

/**
 * Call BEFORE `app.whenReady()`. If prior runs kept losing the GPU, launch with
 * hardware acceleration off (must be set before the app is ready).
 */
export function applyGpuCrashMitigation(): void {
  if (readState().disableHwa) {
    app.disableHardwareAcceleration()
    console.warn('[spectra] hardware acceleration disabled after repeated GPU crashes')
  }
}

/**
 * Call once after ready. Logs + persists GPU/renderer crashes and relaunches the
 * app a single time so a device-loss doesn't leave the overlay dead. After
 * DISABLE_AFTER crashes the next launch runs without hardware acceleration.
 */
export function installGpuCrashGuard(nowMs: () => number = Date.now): void {
  let relaunched = false
  const onCrash = (label: string): void => {
    const s = readState()
    s.crashes += 1
    s.updatedAt = nowMs()
    if (s.crashes >= DISABLE_AFTER) s.disableHwa = true
    writeState(s)
    console.error(
      `[spectra] ${label} — crash #${s.crashes}${s.disableHwa ? ' (HWA off next launch)' : ''}`
    )
    if (!relaunched) {
      relaunched = true
      app.relaunch()
      app.exit(0)
    }
  }

  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU' && details.reason !== 'clean-exit') {
      onCrash(`GPU process gone (${details.reason})`)
    }
  })
  app.on('render-process-gone', (_e, _wc, details) => {
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
      onCrash(`renderer gone (${details.reason})`)
    }
  })

  // Survived long enough → decay the counter so occasional, spread-out crashes
  // don't eventually trip the HWA-disable.
  setTimeout(() => {
    const s = readState()
    if (s.crashes > 0 && nowMs() - s.updatedAt > DECAY_MS - 5_000) {
      writeState({ disableHwa: s.disableHwa, crashes: 0, updatedAt: nowMs() })
    }
  }, DECAY_MS)
}
