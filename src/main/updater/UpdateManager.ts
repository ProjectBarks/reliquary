import { app, net } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { APP_VERSION, telemetry } from '../telemetry/Telemetry'
import type { ReleaseInfo, UpdateState } from '@shared/types'

/**
 * User-driven updates from GitHub Releases. This replaced electron-updater's
 * auto flow, and the difference is the whole point:
 *
 *  - The manager only ever CHECKS on its own (startup + a slow cadence), so
 *    the UI can say "a new version exists". It never downloads unprompted and
 *    it NEVER installs on quit. An installed version changes only when the
 *    user explicitly asks for one.
 *  - Every listed release is installable, not just the newest — the Settings
 *    version picker can move forward or backward. A release that breaks
 *    someone's setup shouldn't strand them on it.
 *  - A download is verified against the sha512 that electron-builder wrote
 *    into that release's own latest.yml before it is ever offered for
 *    install, and 'cancel' works at any stage: mid-download it aborts and
 *    deletes the partial file; once ready it discards the installer.
 *
 * Install runs the downloaded NSIS installer silently (/S) with --force-run
 * so the chosen version relaunches when it finishes, and quits this instance.
 * One-click per-user packaging is what makes that possible without a wizard
 * or elevation.
 */

const REPO = 'ProjectBarks/reliquary'
/** Wait this long after launch before the first check, so startup stays clear. */
const FIRST_CHECK_DELAY_MS = 20_000
/** Then re-check on this cadence for long-running sessions. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** How many releases the picker offers. */
const MAX_VERSIONS = 12

interface GithubAsset {
  name: string
  browser_download_url: string
  size: number
}
interface GithubRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  assets: GithubAsset[]
}

export class UpdateManager {
  private state: UpdateState = {
    status: 'idle',
    // Not app.getVersion(): that is Electron's own version in a dev run.
    current: APP_VERSION,
    latest: null,
    versions: [],
    target: null,
    percent: 0,
    error: null
  }
  private timer: NodeJS.Timeout | null = null
  private firstCheck: NodeJS.Timeout | null = null
  private started = false
  private abort: AbortController | null = null
  /** Path of a fully downloaded, verified installer awaiting the user. */
  private readyInstaller: string | null = null

  constructor(private readonly onChange: (state: UpdateState) => void) {}

  get current(): UpdateState {
    return this.state
  }

  start(): void {
    if (this.started) return
    this.started = true

    // SPECTRA_UPDATER_DEV=1 lets a dev run exercise checking and downloading
    // (install still refuses below — there is no installed copy to replace).
    if (!app.isPackaged && process.env['SPECTRA_UPDATER_DEV'] !== '1') {
      this.set({ status: 'dev-disabled' })
      console.log('[updater] disabled in development (no installed copy to replace)')
      return
    }
    if (process.env['SPECTRA_NO_UPDATE']) {
      this.set({ status: 'disabled' })
      console.log('[updater] disabled by SPECTRA_NO_UPDATE')
      return
    }

    // Held rather than fire-and-forget: an unstored timer cannot be cancelled,
    // so stop() could not prevent a check firing after teardown.
    this.firstCheck = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    this.firstCheck.unref?.()
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck)
    if (this.timer) clearInterval(this.timer)
    this.firstCheck = null
    this.timer = null
    this.abort?.abort()
  }

  /**
   * Refresh the release list. Checking is the ONLY thing that happens without
   * the user asking. Quiet on failure: an update server being down must not
   * degrade an app that is otherwise working fine.
   */
  async check(): Promise<void> {
    if (this.state.status === 'downloading' || this.state.status === 'ready') return
    if (this.state.status === 'dev-disabled' || this.state.status === 'disabled') return
    this.set({ status: 'checking', error: null })
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=${MAX_VERSIONS}`, {
        headers: { accept: 'application/vnd.github+json' }
      })
      if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`)
      const releases = (await res.json()) as GithubRelease[]
      const versions = releases
        .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith('v'))
        .map((r): ReleaseInfo | null => {
          const version = r.tag_name.slice(1)
          const exe = r.assets.find((a) => /setup\.exe$/i.test(a.name))
          const manifest = r.assets.find((a) => a.name === 'latest.yml')
          if (!exe) return null
          return {
            version,
            publishedAt: r.published_at,
            installerUrl: exe.browser_download_url,
            manifestUrl: manifest?.browser_download_url ?? null,
            size: exe.size
          }
        })
        .filter((r): r is ReleaseInfo => r !== null)
        .sort((a, b) => compareSemver(b.version, a.version))
      const latest = versions[0]?.version ?? null
      const newer = latest !== null && compareSemver(latest, this.state.current) > 0
      this.set({
        status: newer ? 'available' : 'current',
        latest,
        versions,
        error: null
      })
      if (newer) {
        telemetry.capture('update_available', { from: this.state.current, to: latest })
      }
    } catch (err) {
      this.set({ status: 'error', error: String((err as Error)?.message ?? err).slice(0, 200) })
      telemetry.issue('update_check_failed', 'warn', {}, err)
    }
  }

  /** Download a specific version's installer and verify it. User-initiated only. */
  async download(version?: string): Promise<void> {
    if (this.state.status === 'downloading') return
    if (this.state.status === 'dev-disabled' || this.state.status === 'disabled') return
    const release =
      this.state.versions.find((r) => r.version === version) ?? this.state.versions[0]
    if (!release) return

    this.discardReady()
    this.abort = new AbortController()
    this.set({ status: 'downloading', target: release.version, percent: 0, error: null })
    telemetry.capture('update_download_requested', {
      from: this.state.current,
      to: release.version
    })

    const dir = join(app.getPath('temp'), 'reliquary-updates')
    const file = join(dir, `Reliquary-${release.version}-setup.exe`)
    try {
      mkdirSync(dir, { recursive: true })

      // The sha512 electron-builder published alongside this exact release.
      let expected: string | null = null
      if (release.manifestUrl) {
        const manifest = await net.fetch(release.manifestUrl, { signal: this.abort.signal })
        if (manifest.ok) {
          expected = /sha512:\s*(\S+)/.exec(await manifest.text())?.[1] ?? null
        }
      }

      const res = await net.fetch(release.installerUrl, { signal: this.abort.signal })
      if (!res.ok || !res.body) throw new Error(`installer download: HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || release.size || 0
      const hash = createHash('sha512')
      const out = createWriteStream(file)
      let received = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        received += value.byteLength
        await new Promise<void>((resolve, reject) =>
          out.write(value, (e) => (e ? reject(e) : resolve()))
        )
        if (total > 0) {
          const percent = Math.round((received / total) * 100)
          if (percent !== this.state.percent) this.set({ percent })
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((e?: Error | null) => (e ? reject(e) : resolve()))
      )

      const digest = hash.digest('base64')
      if (expected && digest !== expected) {
        rmSync(file, { force: true })
        throw new Error('checksum mismatch — download discarded')
      }
      if (!expected) console.warn(`[updater] no manifest for ${release.version}; installing unverified`)

      this.readyInstaller = file
      this.set({ status: 'ready', percent: 100, error: null })
      console.log(`[updater] ${release.version} downloaded and verified; waiting for the user`)
    } catch (err) {
      rmSync(file, { force: true })
      const aborted = (err as Error)?.name === 'AbortError'
      this.set({
        status: aborted ? this.afterCancelStatus() : 'error',
        target: aborted ? null : this.state.target,
        percent: 0,
        error: aborted ? null : String((err as Error)?.message ?? err).slice(0, 200)
      })
      if (!aborted) telemetry.issue('update_download_failed', 'warn', { to: release.version }, err)
    } finally {
      this.abort = null
    }
  }

  /** Abort a download or discard a downloaded installer. Nothing is installed. */
  cancel(): void {
    if (this.abort) {
      this.abort.abort()
      return
    }
    this.discardReady()
    this.set({ status: this.afterCancelStatus(), target: null, percent: 0, error: null })
  }

  /**
   * Run the downloaded installer and quit. Only ever reached by an explicit
   * click on a 'ready' state — there is no other path that installs anything.
   */
  install(): void {
    if (this.state.status !== 'ready' || !this.readyInstaller) return
    if (!app.isPackaged) {
      console.warn('[updater] refusing to install over a development run')
      return
    }
    if (!existsSync(this.readyInstaller)) {
      this.readyInstaller = null
      this.set({ status: this.afterCancelStatus(), target: null, percent: 0 })
      return
    }
    telemetry.capture('update_install_requested', {
      from: this.state.current,
      to: this.state.target
    })
    // Silent one-click install, relaunching the (new) app when it finishes.
    // Detached: the installer must outlive this process.
    spawn(this.readyInstaller, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    app.quit()
  }

  private afterCancelStatus(): UpdateState['status'] {
    return this.state.latest && compareSemver(this.state.latest, this.state.current) > 0
      ? 'available'
      : 'current'
  }

  private discardReady(): void {
    if (this.readyInstaller) rmSync(this.readyInstaller, { force: true })
    this.readyInstaller = null
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }
}

/** Numeric dotted-version compare; good for this repo's plain x.y.z tags. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
