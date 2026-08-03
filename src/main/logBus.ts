import { inspect } from 'util'
import type { LogLine } from '@shared/types'

/**
 * Main-process log capture for the in-app Logs tab.
 *
 * Patches console.log/warn/error so every line is (a) still printed to the real
 * stdout/stderr (so the detached dev log keeps working) and (b) mirrored into a
 * bounded ring buffer and pushed to any registered sink (the renderer bridge).
 * History is replayed to freshly-mounted windows via `history()`.
 */

const RING_SIZE = 1000
const buffer: LogLine[] = []
let sink: ((line: LogLine) => void) | null = null
let installed = false

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3, colors: false })))
    .join(' ')
}

function record(level: LogLine['level'], args: unknown[]): void {
  const line: LogLine = { t: Date.now(), level, text: format(args) }
  buffer.push(line)
  if (buffer.length > RING_SIZE) buffer.shift()
  sink?.(line)
}

/** Patch console once so all main-process logging is captured. Idempotent. */
export function installLogCapture(): void {
  if (installed) return
  installed = true
  const levels: LogLine['level'][] = ['log', 'warn', 'error']
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      record(level, args)
    }
  }
}

/** Register the single live sink (the broadcaster). Replaces any prior sink. */
export function setLogSink(fn: ((line: LogLine) => void) | null): void {
  sink = fn
}

/** Snapshot of the retained log lines, oldest first. */
export function logHistory(): LogLine[] {
  return buffer.slice()
}
