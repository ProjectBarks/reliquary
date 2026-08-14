import { cohortLabel, runCohort, type CatalogEntry, type RunCohort } from '@shared/types'

/**
 * Archive averages, split per player-count cohort.
 *
 * This is the user's decision (§"User decisions" 4) implemented literally: a
 * solo run compares against your solo runs, a 2P run against your 2P runs —
 * never pooled, never excluded. Pooling would let one four-player session drag
 * every solo pace comparison it appears in; excluding multiplayer runs would
 * quietly tell someone who plays co-op that their archive is empty.
 *
 * The consequence is that thin cohorts are the *normal* case rather than an
 * edge one — your first 2P run has no 2P archive behind it by construction —
 * so "not enough runs yet" is a first-class answer here, with its own sentence,
 * and never a silently borrowed baseline from another cohort.
 *
 * The audit assigned this computation to WP5 (A12.4): it is derivable from
 * catalog `activeMs`/`roomsEntered` and no component owned it. It lives in the
 * renderer, over `journal:list`, so it costs no IPC and updates with the push.
 */

/** How many other runs a cohort needs before its average means anything. */
export const COHORT_MIN_RUNS = 2

export interface CohortAverage {
  cohort: RunCohort
  label: string
  /** Mean milliseconds per room across the cohort's finished runs; null if thin. */
  perRoomAvgMs: number | null
  /** How many runs went into it (excluding the subject run). */
  runs: number
  /** True when there were too few runs to answer — render the empty state. */
  thin: boolean
}

/**
 * Which runs may vote.
 *
 * Only finished runs with observed counts: a run we joined mid-way, or one with
 * a hole in it, has a room count that is an under-count by construction
 * (`countsArePartial`), and dividing real time by too few rooms would invent a
 * slow pace out of an observation gap. Unreadable rows (a newer schema) carry
 * no trustworthy numbers at all.
 */
function eligible(entry: CatalogEntry): boolean {
  return (
    entry.state === 'closed' &&
    !entry.unreadable &&
    !entry.countsArePartial &&
    entry.roomsEntered > 0 &&
    entry.activeMs > 0
  )
}

/**
 * The average pace of the given cohort, excluding one run — the one being
 * compared, which must not be part of its own baseline.
 */
export function cohortPace(
  entries: readonly CatalogEntry[] | null | undefined,
  cohort: RunCohort,
  excludeId?: string | null
): CohortAverage {
  const rows = (entries ?? []).filter(
    (e) => e.id !== excludeId && runCohort(e.playerCount) === cohort && eligible(e)
  )
  const label = cohortLabel(cohort)
  if (rows.length < COHORT_MIN_RUNS) {
    return { cohort, label, perRoomAvgMs: null, runs: rows.length, thin: true }
  }
  // Mean of each run's own pace rather than total time over total rooms: the
  // question is "how does this run compare to a typical run of mine", and a
  // pooled ratio would let one marathon run dominate the answer.
  const sum = rows.reduce((acc, e) => acc + e.activeMs / e.roomsEntered, 0)
  return { cohort, label, perRoomAvgMs: sum / rows.length, runs: rows.length, thin: false }
}

/**
 * The sentence a thin cohort says instead of a number.
 *
 * Phrased as a fact about the archive, not as an apology: "first 2P run — no
 * archive average yet" tells the reader exactly what would fix it.
 */
export function thinCohortLine(avg: CohortAverage): string {
  const noun = avg.cohort === 'solo' ? 'solo' : avg.label
  if (avg.runs === 0) return `first ${noun} run — no archive average yet`
  return `${avg.runs} other ${noun} run${avg.runs === 1 ? '' : 's'} on file — not enough for an average yet`
}

/** How many finished runs each cohort holds, for the Archive's cohort strip. */
export function cohortCounts(
  entries: readonly CatalogEntry[] | null | undefined
): Record<RunCohort, number> {
  const counts: Record<RunCohort, number> = { solo: 0, '2p': 0, '3p': 0, '4p': 0 }
  for (const entry of entries ?? []) counts[runCohort(entry.playerCount)]++
  return counts
}
