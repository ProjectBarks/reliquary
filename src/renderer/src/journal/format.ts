import type {
  AnalysisStatus,
  CatalogEntry,
  RunFile,
  RunLifecycleState,
  RunOutcome
} from '@shared/types'
import { DASH } from '../codex/format'

/**
 * The Journal's formatters and its display vocabulary.
 *
 * It sits on top of `codex/format.ts` rather than beside it — `DASH`,
 * `fmtInt`, `relativeTime` and `prettifyId` are imported from there and
 * re-exported where a Journal component needs them, so the two tabs render a
 * missing number identically. What is *new* here is time-as-duration (the
 * compendium never had a stopwatch) and the run-state vocabulary from the
 * plan's §5.2 table, which is a table of words and therefore belongs in one
 * file rather than in five components' JSX.
 *
 * The same rule the compendium runs on applies unchanged: a missing number is
 * never a zero. A run we never saw the start of has no elapsed time, and it
 * says `·` rather than `0s` — "we did not watch" and "it took no time" are not
 * the same claim, and a report that cannot tell them apart is a report that
 * lies quietly.
 */

export { DASH, fmtInt, prettifyId, relativeTime } from '../codex/format'

// ── durations ───────────────────────────────────────────────────────────────

/**
 * "51m 33s", "1m 09s", "48s", "2h 04m".
 *
 * Seconds are zero-padded once minutes are present so a column of paces stays
 * rectangular; the leading unit never is, because `01m 09s` reads like a
 * timestamp rather than a length. Anything under a second rounds to `0s` — the
 * only place a zero is honest here, since it *was* measured.
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return DASH
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** A run's per-room pace, or `·` when there is no honest denominator. */
export function fmtPace(perRoomAvgMs: number | null | undefined): string {
  if (perRoomAvgMs == null || !Number.isFinite(perRoomAvgMs) || perRoomAvgMs <= 0) return DASH
  return fmtDuration(perRoomAvgMs)
}

/** Pace from its two parts, refusing to divide by a room count of zero. */
export function paceFrom(activeMs: number, rooms: number): number | null {
  if (!Number.isFinite(activeMs) || activeMs <= 0) return null
  if (!Number.isFinite(rooms) || rooms <= 0) return null
  return activeMs / rooms
}

/**
 * The ISO-ish stamp the run id already carries, e.g. `2026-08-12T23-40-11Z`.
 *
 * Run ids are minted by the store as `<stamp>-<character>-<short hash>`, and
 * the manifest whisper in the mockup prints the stamp and the tail separately.
 * Rather than re-deriving either from a timestamp — which would drift from the
 * id the moment the store's format changed — both are read back off the id, and
 * an id that does not look like one degrades to printing itself.
 */
export function runStamp(run: { id: string; firstSeenAt: number; startedAt: number | null }): {
  stamp: string
  tail: string
} {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-(.+)$/.exec(run.id)
  if (match) return { stamp: match[1], tail: match[2] }
  const at = run.startedAt ?? run.firstSeenAt
  const iso = Number.isFinite(at) ? new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 19) : ''
  return { stamp: iso ? `${iso}Z` : run.id, tail: run.id }
}

/**
 * "now", "3h", "2d", "14d" — recency in one column-width.
 *
 * `relativeTime` from the Codex writes sentences ("4 minutes ago"), which is
 * right for a freshness whisper and wrong for a ledger column: a table of runs
 * is scanned down the column, and the word "ago" repeated forty times is forty
 * repetitions of nothing. The full phrasing rides the cell's tooltip.
 */
export function shortAgo(epochMs: number | null | undefined): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return DASH
  const mins = Math.max(0, Math.round((Date.now() - epochMs) / 60_000))
  if (mins < 2) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days}d`
  const weeks = Math.round(days / 7)
  return `${weeks}w`
}

/** "2026-08-12" — the calendar day a run belongs to, for the picker's label. */
export function runDay(at: number | null | undefined): string {
  if (at == null || !Number.isFinite(at)) return DASH
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── the run's own words ─────────────────────────────────────────────────────

/** Character ids are stored upper-cased; this is the display form. */
export function characterName(character: string | null | undefined): string {
  if (!character) return 'UNKNOWN'
  return character.toUpperCase()
}

/**
 * The CSS custom-property stem for a character's frame palette.
 *
 * `overlay.css` defines `--sts-ironclad-frame` and friends for the five
 * playable characters; anything else (a modded character, a future one, a read
 * that came back garbled) resolves to the colourless frame rather than to
 * nothing, so the plaque's left edge is always drawn.
 */
const CHARACTER_TINTS = new Set(['ironclad', 'silent', 'regent', 'necrobinder', 'defect', 'fool'])

export function characterTint(character: string | null | undefined): {
  frame: string
  edge: string
} {
  const key = (character ?? '').trim().toLowerCase()
  const stem = CHARACTER_TINTS.has(key) ? key : 'colorless'
  return {
    frame: `var(--sts-${stem}-frame)`,
    edge: `var(--sts-${stem}-frame-edge)`
  }
}

/** Room types the readers can distinguish, mapped onto the ledger's four chips. */
export type RoomKind = 'fight' | 'event' | 'shop' | 'other'

export function roomKind(roomType: string | null | undefined): RoomKind {
  if (roomType === 'combat') return 'fight'
  if (roomType === 'event') return 'event'
  if (roomType === 'merchant') return 'shop'
  return 'other'
}

export const ROOM_KIND_LABEL: Record<RoomKind, string> = {
  fight: 'FIGHT',
  event: 'EVENT',
  shop: 'SHOP',
  other: 'OTHER'
}

/**
 * The colour each room-type chip carries. Type is *data* here, not accent
 * (blend spec amendment B), which is why all four are outline chips rather than
 * the solid plates reserved for grades and severities.
 */
export const ROOM_KIND_TONE: Record<RoomKind, string> = {
  fight: 'var(--ink-dim)',
  event: 'var(--brand-soft)',
  shop: 'var(--sts-color-gold)',
  other: 'var(--sts-color-aqua)'
}

// ── lifecycle vocabulary (plan §5.2) ────────────────────────────────────────

export interface StateWord {
  /** The chip's text. */
  label: string
  /** Its colour, or null for the quiet outline. */
  tone: string | null
  /** Solid plate (a verdict) rather than an outline (a status). */
  solid: boolean
  /** The row's one-line gloss, or null when the chip says everything. */
  note: string | null
  /** The chip's tooltip: the long version of what the word admits to. */
  title?: string
}

const HOUR = 3600_000
const DAY = 24 * HOUR

/**
 * How a run should describe itself, from its state, its outcome and its age.
 *
 * Staleness is display-only and deliberately so: a suspended run stays a resume
 * candidate forever (§5.1), so "abandoned?" is a thing the Archive *says*, never
 * a thing the file *becomes*. The question mark is load-bearing — it is the
 * difference between a guess and a claim.
 */
export function stateWord(
  entry: Pick<CatalogEntry, 'state' | 'outcome' | 'lastSeenAt' | 'supersededBy'>,
  now: number = Date.now()
): StateWord {
  const { state, outcome } = entry
  if (state === 'recording') {
    return { label: 'LIVE', tone: 'var(--sts-color-aqua)', solid: false, note: null }
  }
  if (state === 'abandoned') {
    return {
      label: 'ABANDONED',
      tone: 'var(--sts-color-orange)',
      solid: false,
      note: entry.supersededBy ? 'superseded by a later run' : null
    }
  }
  if (state === 'suspended') {
    const age = now - entry.lastSeenAt
    if (age > 14 * DAY) return { label: 'ABANDONED', tone: null, solid: false, note: null }
    if (age > 48 * HOUR) return { label: 'ABANDONED?', tone: null, solid: false, note: null }
    return { label: 'SUSPENDED', tone: null, solid: false, note: 'resumes when you continue' }
  }
  // closed
  if (outcome === 'death') {
    return { label: 'DEFEATED', tone: 'var(--sts-color-red)', solid: true, note: null }
  }
  if (outcome === 'victory') {
    return { label: 'VICTORIOUS', tone: 'var(--sts-color-green)', solid: true, note: null }
  }
  if (outcome === 'superseded') {
    return { label: 'SUPERSEDED', tone: 'var(--sts-color-orange)', solid: false, note: null }
  }
  // `ENDED` is the honest label until the game-over-variant micro-reader lands:
  // the scan says a run ended, not how. The chip carries that in its tooltip
  // rather than in a note — a line of explanation on every second row of the
  // Archive would be noise, and the word itself is already the admission.
  return {
    label: 'ENDED',
    tone: 'var(--sts-color-gold)',
    solid: false,
    note: null,
    title: 'The run ended · death vs victory is not readable yet'
  }
}

/** The big word on the run report's result plate, and its tone. */
export function outcomeBanner(
  state: RunLifecycleState,
  outcome: RunOutcome | null
): { word: string; tone: 'red' | 'green' | 'gold' | 'aqua' } {
  if (state === 'recording') return { word: 'IN PROGRESS', tone: 'aqua' }
  if (outcome === 'death') return { word: 'DEFEATED', tone: 'red' }
  if (outcome === 'victory') return { word: 'VICTORIOUS', tone: 'green' }
  if (outcome === 'superseded') return { word: 'SUPERSEDED', tone: 'gold' }
  if (state === 'suspended') return { word: 'UNFINISHED', tone: 'gold' }
  return { word: 'ENDED', tone: 'gold' }
}

/** The Archive's column-width version of the same five words. */
export const ANALYSIS_SHORT: Record<AnalysisStatus, string> = {
  none: 'not reviewed',
  pending: 'queued',
  partial: 'partial',
  done: 'reviewed',
  failed: 'failed'
}

export const ANALYSIS_WORD: Record<AnalysisStatus, string> = {
  none: 'no analysis',
  pending: 'analysis pending',
  partial: 'analysis partial',
  done: 'analysis complete',
  failed: 'analysis failed'
}

/**
 * What v1 cannot read — the report's tooltip, not its text.
 *
 * It used to print under the run header, and printing it was the mistake: the
 * report has no HP column, no gold column and no ascension cell, so their
 * absence is already on the screen. A line naming six things the page is not
 * showing is a line the reader has to read to learn nothing. It rides the
 * manifest whisper's `title` now, where a reader who wonders *why* there is no
 * gold can find the answer and nobody else pays for it.
 *
 * Everything listed is genuinely unread — `ascension` is hard-null in every run
 * file, and `relics`/`potions` are hard-empty, by construction in
 * `RunStore.newRunFile`.
 */
export const HONESTY_LINE =
  'not readable in v1: hp · gold · ascension · owned relics · potions · enemy names'

/*
 * Footnote shortening used to live here (`footnoteTail`, its per-chip table and
 * a word clamp): the review printed a PACE / PROXY / LOCAL / BUDGET chip block
 * under the findings, and this file cut each footnote's sentence down to a tail
 * that would fit on one line. The block is gone from the report on the user's
 * call, so the shortening has gone with it rather than lingering as a formatter
 * with no reader. The footnotes themselves are untouched — the pipeline still
 * writes them, the run file still stores them, and the export still carries
 * every sentence verbatim.
 */

/** Whether this row is a provisional run still waiting on the ambiguity banner. */
export function isProvisional(
  entry: Pick<CatalogEntry, 'ambiguity'> | Pick<RunFile, 'ambiguity'>
): boolean {
  return Boolean(entry.ambiguity && entry.ambiguity.resolution === null)
}
