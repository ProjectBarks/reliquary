import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

/** Reliquary's PostHog project (US cloud, project 532681). Write-only — see below. */
const POSTHOG_PROJECT_KEY = 'phc_zUEL8ZYufd2os6ckVP5V5fGN8mrpvkyJMhAzkAzqz7wq'
const POSTHOG_HOST = 'https://us.i.posthog.com'

/**
 * Resolve a build-time override.
 *
 * `??` is a footgun here. An env var set to an empty string is still *present*,
 * so `process.env.FOO ?? DEFAULT` keeps the '' and compiles the key out. CI
 * passes `env: FOO: ${{ vars.UNSET }}`, and whether that arrives as absent or
 * empty depends on the runner — a difference that would silently decide whether
 * a release reports anything. Empty means "unset"; opting out is an explicit
 * flag, never an accident of shell semantics.
 */
const buildEnv = (name: string, fallback: string): string => {
  if (process.env['POSTHOG_DISABLED'] === '1') return ''
  const v = process.env[name]
  return v != null && v.trim() !== '' ? v : fallback
}

const resolvedKey = buildEnv('POSTHOG_KEY', POSTHOG_PROJECT_KEY)

// Fail loudly rather than shipping a build that reports nothing. A silently
// keyless release looks completely healthy from the outside — the app runs, the
// installer works, and no diagnostics ever arrive to tell you otherwise.
if (!resolvedKey && process.env['POSTHOG_DISABLED'] !== '1') {
  throw new Error(
    'Build would produce no PostHog key. Set POSTHOG_KEY, or POSTHOG_DISABLED=1 to opt out deliberately.'
  )
}
console.log(
  resolvedKey
    ? `[build] telemetry key embedded (${resolvedKey.slice(0, 12)}…) → ${buildEnv('POSTHOG_HOST', POSTHOG_HOST)}`
    : '[build] telemetry disabled (POSTHOG_DISABLED=1)'
)

export default defineConfig({
  main: {
    // Baked in at build time so release builds report without the user needing
    // to set anything. A PostHog PROJECT key is write-only and designed to ship
    // in clients: it can send events and nothing else, grants no read access,
    // and is extractable from any built binary regardless of where it is kept —
    // so there is nothing to gain by hiding it. A runtime POSTHOG_KEY still
    // wins, and SPECTRA_TELEMETRY=0 disables reporting entirely.
    define: {
      // app.getVersion() returns Electron's version in an unpackaged run, which
      // would make dev and release reports disagree about what "version" means.
      __APP_VERSION__: JSON.stringify(pkg.version),
      __POSTHOG_KEY__: JSON.stringify(resolvedKey),
      __POSTHOG_HOST__: JSON.stringify(buildEnv('POSTHOG_HOST', POSTHOG_HOST))
    },
    build: {
      rollupOptions: {
        // Two main-process entries. `reader` is forked as a utilityProcess so
        // the native memory reader runs in its own OS process — a segfault
        // there kills that process alone instead of the whole app.
        input: {
          index: resolve('src/main/index.ts'),
          reader: resolve('src/main/scry/readerProcess.ts')
        },
        // native/optional deps must stay external (not bundled)
        external: ['node-window-manager'],
        output: { entryFileNames: '[name].js' }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
