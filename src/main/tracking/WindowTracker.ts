import { EventEmitter } from 'events'
import type { TrackerState, WindowBounds } from '@shared/types'

/**
 * Base class for anything that reports "where should the overlay sit".
 *
 * Emits:
 *   'update' (state: TrackerState) — whenever attach status or bounds change.
 *
 * Swap implementations without touching the rest of the app: the overlay just
 * listens for 'update' and repositions itself.
 */
export abstract class WindowTracker extends EventEmitter {
  protected timer: NodeJS.Timeout | null = null
  protected last: TrackerState = { attached: false, bounds: null, target: '' }

  constructor(protected intervalMs: number) {
    super()
  }

  abstract sample(): TrackerState

  start(): void {
    const tick = (): void => {
      const next = this.sample()
      if (this.changed(next)) {
        this.last = next
        this.emit('update', next)
      }
    }
    tick()
    this.timer = setInterval(tick, this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get state(): TrackerState {
    return this.last
  }

  private changed(next: TrackerState): boolean {
    const a = this.last
    const b = next
    if (a.attached !== b.attached || a.target !== b.target) return true
    if (!a.bounds || !b.bounds) return a.bounds !== b.bounds
    return (
      a.bounds.x !== b.bounds.x ||
      a.bounds.y !== b.bounds.y ||
      a.bounds.width !== b.bounds.width ||
      a.bounds.height !== b.bounds.height
    )
  }
}

/** Utility: are two bounds effectively equal? Exposed for tests/consumers. */
export function boundsEqual(a: WindowBounds | null, b: WindowBounds | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
