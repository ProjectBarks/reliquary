import { app, powerMonitor, screen } from 'electron'
import { telemetry } from './Telemetry'

/**
 * Process- and Electron-level instrumentation.
 *
 * Everything here is about capturing the failure modes that leave no JS stack:
 * the GPU process dying, a renderer being OOM-killed, the machine sleeping
 * mid-poll, a display being unplugged out from under an overlay that is pinned
 * to its coordinates. Those are the reports that otherwise arrive as "it just
 * stopped working".
 *
 * There is deliberately no periodic heartbeat. One was tried and grew to 52% of
 * all ingested events while answering nothing the rest could not:
 *   - died vs quit  -> an `app_ready` with no matching `app_exit`
 *   - a denominator -> `app_ready`, one per session rather than one per 5 min
 *   - session length at the moment of a crash -> every event already carries
 *     `uptime_ms`, so the crash report itself says how long it had been running
 * Signal per event matters more than event count; add periodic reporting back
 * only for a question none of the above can answer.
 */

/** Install before `app.whenReady()` so early failures are still captured. */
export function installProcessTelemetry(): void {
  process.on('uncaughtException', (err, origin) => {
    console.error('[spectra] uncaughtException', err)
    telemetry.issue('uncaught_exception', 'fatal', { origin }, err)
    // Do not exit: historically these came from timer callbacks touching a
    // torn-down window, and the app stays perfectly usable afterwards.
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[spectra] unhandledRejection', reason)
    telemetry.issue('unhandled_rejection', 'error', {}, reason)
  })

  process.on('warning', (w) => {
    telemetry.crumb('node-warning', `${w.name}: ${w.message}`)
  })

  // Memory pressure is a leading indicator of the renderer being killed.
  const MEM_SAMPLE_MS = 120_000
  const timer = setInterval(() => {
    telemetry.guard(
      'memory_sample',
      () => {
        const m = process.memoryUsage()
        const heapMb = Math.round(m.heapUsed / 1024 / 1024)
        const rssMb = Math.round(m.rss / 1024 / 1024)
        telemetry.crumb('memory', `rss=${rssMb}MB heap=${heapMb}MB`)
        if (rssMb > 1200) {
          telemetry.issue('memory_high', 'warn', { rss_mb: rssMb, heap_mb: heapMb })
        }
      },
      undefined
    )
  }, MEM_SAMPLE_MS)
  timer.unref?.()
}

/** Install after `app.whenReady()`. */
export function installAppTelemetry(): void {
  telemetry.capture('app_ready', {
    gpu_feature_status: telemetry.guard('gpu_status', () => app.getGPUFeatureStatus(), null),
    display_count: telemetry.guard('display_count', () => screen.getAllDisplays().length, 0),
    primary_scale: telemetry.guard('display_scale', () => screen.getPrimaryDisplay().scaleFactor, 1)
  })

  app.on('child-process-gone', (_e, d) => {
    telemetry.issue('child_process_gone', d.reason === 'clean-exit' ? 'info' : 'error', {
      child_type: d.type,
      reason: d.reason,
      exit_code: d.exitCode,
      service_name: d.serviceName,
      name: d.name
    })
  })

  app.on('render-process-gone', (_e, wc, d) => {
    telemetry.issue('render_process_gone', d.reason === 'clean-exit' ? 'info' : 'fatal', {
      reason: d.reason,
      exit_code: d.exitCode,
      url: telemetry.guard('rpg_url', () => wc.getURL(), null)
    })
  })

  // Display topology changes move or orphan the overlay, which is pinned to
  // absolute screen coordinates.
  const onDisplay = (change: string) => (): void => {
    telemetry.capture('display_changed', {
      change,
      display_count: telemetry.guard('dc', () => screen.getAllDisplays().length, 0)
    })
  }
  screen.on('display-added', onDisplay('display-added'))
  screen.on('display-removed', onDisplay('display-removed'))
  screen.on('display-metrics-changed', onDisplay('display-metrics-changed'))

  // Sleep/resume: the poll loop and the game window handle both go stale across
  // these, and the resulting breakage looks spontaneous to the user.
  const onPower = (event: string) => (): void => telemetry.capture('power_event', { event })
  telemetry.guard(
    'power_monitor',
    () => {
      powerMonitor.on('suspend', onPower('suspend'))
      powerMonitor.on('resume', onPower('resume'))
      powerMonitor.on('lock-screen', onPower('lock-screen'))
      powerMonitor.on('unlock-screen', onPower('unlock-screen'))
    },
    undefined
  )

  app.on('browser-window-created', (_e, win) => {
    const label = (): string => (win.isDestroyed() ? 'destroyed' : win.getTitle() || 'window')
    win.webContents.on('unresponsive', () =>
      telemetry.issue('window_unresponsive', 'warn', { window: label() })
    )
    win.webContents.on('responsive', () => telemetry.crumb('window', `${label()} responsive again`))
    win.webContents.on('preload-error', (_ev, path, error) =>
      telemetry.issue('preload_error', 'error', { preload: path }, error)
    )
    win.webContents.on('did-fail-load', (_ev, code, desc, url) => {
      if (code === -3) return // aborted by a redirect; not a failure
      telemetry.issue('renderer_load_failed', 'error', { code, desc, url })
    })
    win.webContents.on('console-message', (_ev, level, message, line, source) => {
      // Only errors — warnings from React/devtools would drown everything.
      if (level < 3) return
      telemetry.issue('renderer_console_error', 'warn', {
        message: String(message).slice(0, 500),
        source,
        line
      })
    })
  })
}
