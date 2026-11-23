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
        // The reader is forked from app.asar.unpacked, where no package.json
        // sits beside it to declare "type": "module" — a .js extension there
        // makes Node parse the ESM bundle as CommonJS and the child dies at
        // startup (the v0.5.0 packaged-only crash). `.mjs` states the module
        // type in the filename, independent of any package.json.
        output: {
          entryFileNames: (chunk) => (chunk.name === 'reader' ? '[name].mjs' : '[name].js')
        }
      }
    },
    plugins: [
      {
        // Only reader.mjs is unpacked (package.json asarUnpack). Any code the
        // reader shares with index.js gets hoisted into out/main/chunks/, which
        // stays inside app.asar, and the unpacked reader dies at startup with
        // ERR_MODULE_NOT_FOUND. Dev runs straight out of out/ and never sees it
        // (hit while building v0.10.3), so fail the build instead.
        name: 'reader-self-contained',
        generateBundle(_options, bundle) {
          const reader = Object.values(bundle).find(
            (c) => c.type === 'chunk' && c.isEntry && c.name === 'reader'
          )
          if (!reader || reader.type !== 'chunk') return
          const shared = [...reader.imports, ...reader.dynamicImports].filter((f) => f in bundle)
          if (shared.length) {
            this.error(
              `reader.mjs imports shared chunk(s) ${shared.join(', ')}; it runs from ` +
                'app.asar.unpacked and cannot load them. Keep readerProcess.ts\'s import ' +
                'graph free of value imports from main-process modules (type imports are fine).'
            )
          }
        }
      }
    ],
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
    plugins: [
      // React Compiler, targeting React 18: `target: '18'` makes the emitted
      // memo cache go through the `react-compiler-runtime` polyfill package
      // instead of React 19's built-in `react/compiler-runtime` entry.
      react({
        babel: {
          plugins: [['babel-plugin-react-compiler', { target: '18' }]]
        }
      })
    ]
  }
})
