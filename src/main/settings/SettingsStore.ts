import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { DEFAULT_SETTINGS, type Sts2Settings } from '@shared/types'

/**
 * Owns the user's overlay settings for the whole app (both live and stub modes)
 * and persists them to `userData/settings.json` so toggles survive relaunch.
 * Previously settings were emitted once from each provider and the SetSettings
 * IPC only reached the dev stub — so in live play the toggles were dead no-ops.
 * This is the single writer; `index.ts` emits `sts2.settings` from it.
 */
export class SettingsStore {
  private settings: Sts2Settings = { ...DEFAULT_SETTINGS }
  private readonly file: string

  constructor() {
    this.file = join(app.getPath('userData'), 'settings.json')
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Sts2Settings>
      // Merge over defaults so a newly-added toggle gets a sane value.
      this.settings = { ...DEFAULT_SETTINGS, ...raw }
    } catch {
      // First run / unreadable file → defaults.
    }
  }

  get(): Sts2Settings {
    return { ...this.settings }
  }

  /** Merge a patch, persist, and return the new full settings. */
  patch(p: Partial<Sts2Settings>): Sts2Settings {
    this.settings = { ...this.settings, ...p }
    try {
      writeFileSync(this.file, JSON.stringify(this.settings, null, 2))
    } catch (err) {
      console.warn('[spectra] failed to persist settings', err)
    }
    return this.get()
  }
}
