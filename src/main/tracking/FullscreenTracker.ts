import { screen } from 'electron'
import { WindowTracker } from './WindowTracker'
import type { TrackerState } from '@shared/types'

/**
 * Simplest tracker: always pin to the primary display's work area.
 * No native dependencies — a guaranteed-to-run default.
 */
export class FullscreenTracker extends WindowTracker {
  constructor(intervalMs: number, private label = 'Primary Display') {
    super(intervalMs)
  }

  sample(): TrackerState {
    const display = screen.getPrimaryDisplay()
    const { x, y, width, height } = display.bounds
    return {
      attached: true,
      target: this.label,
      bounds: { x, y, width, height }
    }
  }
}
