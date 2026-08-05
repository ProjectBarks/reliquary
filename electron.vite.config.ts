import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

/** Reliquary's PostHog project (US cloud, project 532681). Write-only — see below. */
const POSTHOG_PROJECT_KEY = 'phc_zUEL8ZYufd2os6ckVP5V5fGN8mrpvkyJMhAzkAzqz7wq'
const POSTHOG_HOST = 'https://us.i.posthog.com'

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
      __POSTHOG_KEY__: JSON.stringify(process.env['POSTHOG_KEY'] ?? POSTHOG_PROJECT_KEY),
      __POSTHOG_HOST__: JSON.stringify(process.env['POSTHOG_HOST'] ?? POSTHOG_HOST)
    },
    build: {
      rollupOptions: {
        // native/optional deps must stay external (not bundled)
        external: ['node-window-manager']
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
