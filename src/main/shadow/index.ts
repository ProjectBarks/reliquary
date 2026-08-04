import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { KeyedSnapshot, Sts2Key } from '@shared/types'

/**
 * Shadow harness for the native-reader replacement spike.
 *
 * Two jobs:
 *   1. RECORD — capture every snapshot the current (proprietary scry) provider
 *      emits to a JSONL file. This is ground truth: the fixture any
 *      reimplementation must reproduce.
 *   2. COMPARE — when a candidate source (e.g. an in-process game mod pushing
 *      state over a socket) supplies its own snapshot for the same key, diff it
 *      against the primary and log every mismatch so gaps can be worked down
 *      iteratively.
 *
 * Enabled with SPECTRA_SHADOW=1. Writes to <userData>/shadow/.
 */

let dir: string | null = null
let enabled = false

/** Latest primary snapshot per key, for the comparer to diff against. */
const primary = new Map<Sts2Key, unknown>()

const stats = {
  recorded: 0,
  compared: 0,
  matched: 0,
  mismatched: 0,
  missingFromCandidate: 0
}

export function initShadow(): boolean {
  enabled = !!process.env['SPECTRA_SHADOW']
  if (!enabled) return false
  dir = join(app.getPath('userData'), 'shadow')
  mkdirSync(dir, { recursive: true })
  console.log(`[shadow] recording enabled → ${dir}`)
  return true
}

export function isShadowEnabled(): boolean {
  return enabled
}

function write(file: string, obj: unknown): void {
  if (!dir) return
  try {
    appendFileSync(join(dir, file), JSON.stringify(obj) + '\n')
  } catch {
    /* never let telemetry break the app */
  }
}

/** Record a primary-provider snapshot as ground truth. */
export function recordPrimary(snap: KeyedSnapshot): void {
  if (!enabled) return
  primary.set(snap.key, snap.value)
  stats.recorded++
  write('primary.jsonl', { t: Date.now(), key: snap.key, value: snap.value })
}

/**
 * Compare a candidate source's snapshot against the last primary one for the
 * same key. Logs a structured diff for every field that disagrees.
 */
export function compareCandidate(key: Sts2Key, candidate: unknown, source = 'mod'): void {
  if (!enabled) return
  stats.compared++
  if (!primary.has(key)) {
    stats.missingFromCandidate++
    write('diffs.jsonl', { t: Date.now(), key, source, kind: 'no-primary-baseline' })
    return
  }
  const diffs = diff(primary.get(key), candidate)
  if (diffs.length === 0) {
    stats.matched++
    return
  }
  stats.mismatched++
  write('diffs.jsonl', { t: Date.now(), key, source, kind: 'mismatch', count: diffs.length, diffs })
}

/** Structural diff → list of {path, primary, candidate}. Bounded output. */
export function diff(a: unknown, b: unknown, path = '', out: DiffEntry[] = []): DiffEntry[] {
  if (out.length >= 50) return out // cap so one bad frame can't flood the log
  if (a === b) return out
  const ta = kindOf(a)
  const tb = kindOf(b)
  if (ta !== tb) {
    out.push({ path: path || '$', primary: brief(a), candidate: brief(b), reason: `type ${ta}≠${tb}` })
    return out
  }
  if (ta === 'array') {
    const A = a as unknown[]
    const B = b as unknown[]
    if (A.length !== B.length) {
      out.push({ path: path || '$', primary: `len ${A.length}`, candidate: `len ${B.length}`, reason: 'length' })
    }
    for (let i = 0; i < Math.min(A.length, B.length); i++) diff(A[i], B[i], `${path}[${i}]`, out)
    return out
  }
  if (ta === 'object') {
    const A = a as Record<string, unknown>
    const B = b as Record<string, unknown>
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
      diff(A[k], B[k], path ? `${path}.${k}` : k, out)
    }
    return out
  }
  out.push({ path: path || '$', primary: brief(a), candidate: brief(b), reason: 'value' })
  return out
}

export interface DiffEntry {
  path: string
  primary: string
  candidate: string
  reason: string
}

function kindOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function brief(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > 120 ? s.slice(0, 117) + '…' : s
}

/** Snapshot of how well the candidate is tracking the primary. */
export function shadowStats(): typeof stats & { fidelity: number } {
  const fidelity = stats.compared ? stats.matched / stats.compared : 0
  return { ...stats, fidelity }
}

/** Write a run summary (call on quit). */
export function flushShadowSummary(): void {
  if (!enabled) return
  const s = shadowStats()
  write('summary.jsonl', { t: Date.now(), ...s })
  console.log(
    `[shadow] recorded=${s.recorded} compared=${s.compared} ` +
      `matched=${s.matched} mismatched=${s.mismatched} fidelity=${(s.fidelity * 100).toFixed(1)}%`
  )
}
