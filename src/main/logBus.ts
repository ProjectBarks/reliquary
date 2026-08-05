import { inspect } from 'util'
import { telemetry } from './telemetry/Telemetry'
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

  // Every log line becomes breadcrumb context for the next error report, and
  // anything logged at error level is reported on its own. Console output is
  // the app's richest description of what it was doing, so it is worth carrying
  // into the crash report rather than leaving on the user's machine.
  try {
    telemetry.noteLog(level, line.text)
    if (level === 'error') {
      telemetry.issue(`console_error:${fingerprint(line.text)}`, 'error', { message: line.text })
    } else if (level === 'warn') {
      telemetry.crumb('warn', line.text)
    }
  } catch {
    // logging must never fail because of telemetry
  }
}

/**
 * Collapse a log message to a stable key so the same failure aggregates even
 * though its numbers, ids, and addresses differ every time.
 */
function fingerprint(text: string): string {
  return text
    .replace(/0x[0-9a-f]+/gi, '<addr>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
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
