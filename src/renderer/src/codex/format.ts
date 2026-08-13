/**
 * Number and time formatting for the Codex.
 *
 * One rule runs through this file: a missing number is never a zero. The
 * compendium's metrics are genuinely null-heavy — `elo` and `pick_rate` are
 * absent from every relic and potion row, and from every character-filtered
 * card table — so every formatter here answers `null` with the same middle dot
 * rather than an invented figure. A table full of honest dots is readable; a
 * table full of fabricated zeroes is worse than no table.
 */

/** What a missing value looks like, everywhere in the Codex. */
export const DASH = '·'

/**
 * Sample sizes, abbreviated the way the overlay's stat tips abbreviate them
 * (`fmtCount` in CodexClient): thousands lose their tail once the number is big
 * enough that the tail stops meaning anything.
 */
export function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

/** Full-precision counts for table cells, where alignment does the compressing. */
export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH
  return Math.round(n).toLocaleString()
}

/** Percentages arrive already ×100 from the API, so this only sets precision. */
export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return DASH
  return `${n.toFixed(digits)}%`
}

/** Codex Score, 0–100. Whole numbers read as grades; decimals read as noise. */
export function fmtScore(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH
  return n.toFixed(1)
}

/** Elo is an integer scale; showing a decimal implies precision it lacks. */
export function fmtElo(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH
  return String(Math.round(n))
}

export type Confidence = 'high' | 'med' | 'low'

/**
 * Sample-size confidence, on the same 2000/300 thresholds the overlay's stat
 * tips use — a number that means "high" in the overlay must not mean "medium"
 * here, or the two surfaces are quietly disagreeing about the same card.
 */
export function confidenceFor(picks: number | null | undefined): Confidence | null {
  if (picks == null || !Number.isFinite(picks)) return null
  if (picks >= 2000) return 'high'
  if (picks >= 300) return 'med'
  return 'low'
}

/** Below this a sample is thin enough to warn about in a tier list. */
export const LOW_SAMPLE = 300

export function confidenceLabel(c: Confidence | null): string {
  return c === 'high' ? 'high confidence' : c === 'med' ? 'medium confidence' : c === 'low' ? 'low confidence' : ''
}

/**
 * "4 minutes ago" for the freshness whisper. Coarse on purpose: the cache is
 * revalidated on a half-hour cadence, so second-level precision would only
 * animate a number nobody is reading.
 */
export function relativeTime(epochMs: number | null | undefined): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return 'unknown'
  const secs = Math.max(0, Math.round((Date.now() - epochMs) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

/** "SOME_CARD_ID" -> "Some Card Id", for ids with no catalog row behind them. */
export function prettifyId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Comparator factory that always sinks nulls, in either direction.
 *
 * Sorting by a mostly-null column is the common case here, not the exception,
 * and JavaScript's default treatment (`null < 1`) would float every unknown to
 * the top of an ascending sort — putting the rows we know least about first.
 */
export function compareNullable(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: 'asc' | 'desc'
): number {
  const av = a == null || !Number.isFinite(a) ? null : a
  const bv = b == null || !Number.isFinite(b) ? null : b
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  return dir === 'asc' ? av - bv : bv - av
}
