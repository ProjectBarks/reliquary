import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    // Baked in at build time so release builds report without the user needing
    // to set anything. A PostHog PROJECT key is write-only and designed to ship
    // in clients; it grants no read access. A runtime POSTHOG_KEY still wins,
    // and SPECTRA_TELEMETRY=0 disables reporting entirely.
    define: {
      // app.getVersion() returns Electron's version in an unpackaged run, which
      // would make dev and release reports disagree about what "version" means.
      __APP_VERSION__: JSON.stringify(pkg.version),
      __POSTHOG_KEY__: JSON.stringify(process.env['POSTHOG_KEY'] ?? ''),
      __POSTHOG_HOST__: JSON.stringify(process.env['POSTHOG_HOST'] ?? 'https://us.i.posthog.com')
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
