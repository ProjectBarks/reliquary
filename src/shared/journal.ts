/**
 * The run journal's on-disk domain model — run files, the catalog index, the
 * event log and the embedded snapshot — shared by main, preload and renderer.
 *
 * It lives beside `codex.ts` for the same reason: a self-contained schema large
 * enough to bury the StS2 domain shapes if it were mixed into `types.ts`, which
 * re-exports it so `@shared/types` stays the single import every surface reaches
 * for.
 *
 * Three properties this schema is designed around, all of them consequences of
 * the fact that these files are *user data* and outlive any one app version:
 *
 *   1. **Nullability is honest.** Everything the readers cannot see is `null`,
 *      never a zero standing in for "unknown": `act` is null while `RunState`
 *      is absent (audit A4 — act 0 and "no idea" are otherwise the same value),
 *      `startedAt` is null when we joined a run already in progress,
 *      `playerCount` is null until the multiplayer reader proves otherwise.
 *      A count that might be a guess travels with `countsArePartial`.
 *   2. **Events are history; the snapshot is the present.** Nothing replays an
 *      event log to answer "where is this run" — the catalog, the matcher, the
 *      Current Run header and resume all read the snapshot alone. The snapshot
 *      carries `eventCount` so a reader that wants exactness can fold
 *      `events[eventCount:]` over it (the crash-recovery path).
 *   3. **Unknown fields survive.** Consumers must ignore event types they do
 *      not know (`RunEvent` admits them by construction) and must never rewrite
 *      a file whose `schema` is higher than theirs — see `JOURNAL_SCHEMA`.
 */

/**
 * Schema version of run files *and* the catalog. Bumped only for incompatible
 * shape changes; new nullable fields and new event types are additive and do
 * not bump it. A file with a higher schema is listed as unreadable rather than
 * guessed at or migrated destructively.
 */
export const JOURNAL_SCHEMA = 1

// ── lifecycle vocabulary ─────────────────────────────────────────────────────

/**
 * Where a run is in its life. Suspension is not an end: only `closed` and
 * `abandoned` are terminal, and a `suspended` run stays a resume candidate
 * forever (staleness is display-only). `recording` files found at startup are
 * crash orphans and get demoted to `suspended`.
 */
export type RunLifecycleState = 'recording' | 'suspended' | 'closed' | 'abandoned'

/**
 * How a run finished, `null` while it is still alive. `'ended'` is the honest
 * label until the game-over screen variant reader lands and can say death vs
 * victory; `'superseded'` means the game itself invalidated the save when a new
 * run started on the same character.
 */
export type RunOutcome = 'ended' | 'death' | 'victory' | 'superseded'

/** Whether we watched the run start, or attached to one already in progress. */
export type ObservedFrom = 'start' | 'mid-run'

/** Why an observation segment ended. */
export type SessionEndReason = 'menu' | 'process-gone' | 'app-quit' | 'character-switch'

/** Why there is a hole in the observation: play we missed, or a restored save. */
export type GapReason = 'unobserved-play' | 'save-restore'

/** Progress of the post-run analysis pipeline for a closed run. */
export type AnalysisStatus = 'none' | 'pending' | 'partial' | 'done' | 'failed'

// ── sessions ─────────────────────────────────────────────────────────────────

/**
 * One contiguous span during which the recorder observed this run. A run has
 * one or more; the gaps between them are either the game being closed or —
 * worse and more interesting — the game being played without us.
 */
export interface RunSession {
  /** 1-based, matches `session_attach.sid` in the event log. */
  sid: number
  attachedAt: number
  /** Null while the segment is the live one. */
  detachedAt: number | null
  reason: SessionEndReason | null
  /**
   * Monotonic-clock milliseconds actually observed in this segment. Durations
   * never come from wall-clock subtraction: a sleeping laptop, DST or an NTP
   * step would otherwise produce negative or inflated pace.
   */
  activeMs: number
  /** Players seen in `RunState._players`; null when the read was unavailable. */
  playerCount: number | null
  gameVersion: string | null
}

// ── events ───────────────────────────────────────────────────────────────────

/**
 * Every event carries a wall-clock stamp and a type. The store persists events
 * verbatim and interprets none of them — event derivation belongs to the
 * recorder, and forward compatibility depends on this file not caring.
 */
export interface RunEventBase {
  /** Epoch ms. */
  t: number
  type: string
}

export interface SessionAttachEvent extends RunEventBase {
  type: 'session_attach'
  sid: number
  /** True when this attach opened the file rather than resumed it. */
  fresh?: boolean
}

export interface SessionDetachEvent extends RunEventBase {
  type: 'session_detach'
  sid: number
  reason: SessionEndReason
}

/**
 * A hole in the record. `unobserved-play` is the run moving forward while we
 * were not watching; `save-restore` is the deck regressing to a subset of what
 * we last saw, which is a save restoration rather than a different run.
 */
export interface GapEvent extends RunEventBase {
  type: 'gap'
  reason: GapReason
  actFrom: number | null
  actTo: number | null
  deckAdded: string[]
  deckRemoved: string[]
}

/** Recorded on the run that lost, naming the run that replaced it. */
export interface SupersededEvent extends RunEventBase {
  type: 'superseded'
  by: string
}

/**
 * Raised when a sighting is genuinely ambiguous (same character, both runs
 * inside the pre-first-pick window). The recorder opens a *new provisional*
 * file — never a silent merge — and the Journal asks the user to resolve it.
 */
export interface AmbiguityRaisedEvent extends RunEventBase {
  type: 'ambiguity_raised'
  candidateId: string
}

/** The user's answer to the banner, or the file's own record of being merged. */
export interface AmbiguityResolvedEvent extends RunEventBase {
  type: 'ambiguity_resolved'
  candidateId: string
  resolution: AmbiguityResolution
}

export type KnownRunEvent =
  | SessionAttachEvent
  | SessionDetachEvent
  | GapEvent
  | SupersededEvent
  | AmbiguityRaisedEvent
  | AmbiguityResolvedEvent

/**
 * The recorder writes many more event types than this file names (room_enter,
 * offer_shown, deck_add …, journal-plan §2.2). They are deliberately not
 * enumerated here: the store round-trips them, and a consumer that meets a type
 * it does not know must skip it rather than fail the file.
 */
export type RunEvent = KnownRunEvent | RunEventBase

// ── deck, combats, snapshot ──────────────────────────────────────────────────

/** A grouped multiset row, as the run file stores a final deck. */
export interface DeckGroupRow {
  id: string
  upgradeLevel: number
  count: number
}

/**
 * One combat. `aborted` marks a combat interrupted by suspension: the game
 * restarts it from the top on resume, so its counts are excluded from the run
 * aggregates rather than double-counted.
 */
export interface RunCombat {
  startT: number
  endT: number | null
  roomIndex: number
  /** Enemies at combat start; null when the read was unavailable. */
  enemies: number | null
  plays: DeckCountRow[]
  drawn: DeckCountRow[]
  aborted?: boolean
}

export interface DeckCountRow {
  id: string
  count: number
}

/** An offer awaiting pick inference — carried in the snapshot so a resume can finish it. */
export interface RunOpenOffer {
  /** Event id of the `offer_shown` this will resolve. */
  eid: number
  source: string
  offered: string[]
  shownAt: number
  /** The deadline after which no deck gain counts as a pick. */
  deadlineAt: number
}

/**
 * Derived state, current as of every flush. This is what the catalog, the
 * matcher and the Current Run header read; none of them ever folds the log.
 */
export interface RunSnapshot {
  at: number
  /** Null when `RunState` was unreadable — never 0 as a stand-in (audit A4). */
  act: number | null
  /** Rooms *we* counted, not the game's floor number. */
  roomIndex: number
  roomType: string | null
  /** The fingerprint multiset: sorted `"<ID>#<upgradeLevel>"`. */
  deck: string[]
  /** SHA-1 over `deck`. Empty string only for a run with no deck read yet. */
  deckHash: string
  /**
   * The deck's own reported size. It differs from `deck.length` only on a torn
   * read, which is exactly why it is stored separately (audit A3).
   */
  deckSize: number
  /** How many events are folded into this snapshot. */
  eventCount: number
  combatAgg: {
    plays: Record<string, number>
    drawn: Record<string, number>
  }
  openCombat: RunCombat | null
  openOffer: RunOpenOffer | null
  paceActiveMs: number
}

// ── ambiguity (the resolution banner's state) ────────────────────────────────

/** `null` while the question stands; the user's answer once they give one. */
export type AmbiguityResolution = 'fresh' | 'resumed'

/**
 * A provisional run: one the matcher could not distinguish from an existing
 * candidate inside the pre-first-pick window. The data is never lost — the
 * provisional file records everything — but the Journal shows a non-blocking
 * banner ("Fresh run, or resuming <candidate>?"). Resolving as `resumed` merges
 * this file into the candidate; ignoring it forever leaves it standing as its
 * own run, which is the honest default.
 */
export interface RunAmbiguity {
  candidateId: string
  raisedAt: number
  resolution: AmbiguityResolution | null
  resolvedAt: number | null
}

// ── the run file ─────────────────────────────────────────────────────────────

/** Deck/relic signature, versioned by presence: old files compare on deck only. */
export interface RunSignature {
  deckHash: string
  /** Null until the owned-relic reader ships. */
  relicHash: string | null
  /** Top non-basic ids, for a human group label ("Demon Form ramp"). */
  core: string[]
}

export interface RunPace {
  elapsedMs: number
  roomsEntered: number
  perRoomAvgMs: number | null
}

/**
 * `userData/runs/<id>.json`. Event-sourced with an embedded snapshot; extends
 * journal-plan §2.3 with the session layer.
 */
export interface RunFile {
  schema: number
  id: string
  /** Upper-cased at the recorder boundary; matching and grouping are case-insensitive. */
  character: string
  gameVersion: string | null

  state: RunLifecycleState
  outcome: RunOutcome | null
  observedFrom: ObservedFrom
  /** Null when `observedFrom === 'mid-run'` — we did not see the start. */
  startedAt: number | null
  firstSeenAt: number
  /** Clamped monotonically non-decreasing; a backwards wall clock never rewinds it. */
  lastSeenAt: number
  endedAt: number | null

  /** True on a mid-run attach or once any `gap` event exists. */
  countsArePartial: boolean
  /** Set when a runaway event count forced room-level coalescing (§5.4). */
  truncatedEvents: boolean
  /** Non-null while this run is a provisional answer awaiting the user. */
  ambiguity: RunAmbiguity | null
  /** Set on the loser of a supersession, naming the run that replaced it. */
  supersededBy: string | null

  /** Max over sessions; null when never readable. Drives the MP cohort split. */
  playerCount: number | null
  actReached: number | null
  roomsEntered: number
  /** Null until the floor reader lands; `roomIndex` is ours, this would be the game's. */
  floorReached: number | null
  ascension: number | null

  sessions: RunSession[]
  snapshot: RunSnapshot
  events: RunEvent[]
  combats: RunCombat[]

  signature: RunSignature
  /** Grouped multiset at run end; null while the run is unfinished. */
  finalDeck: DeckGroupRow[] | null
  relics: string[]
  potions: string[]
  pace: RunPace

  analysisStatus: AnalysisStatus
  /** Written by the post-run pipeline; null = not yet run. */
  analysis: JournalJson | null
}

/**
 * The analysis blob is the pipeline's own schema (WP6) and the store has no
 * business typing it. It is persisted and returned verbatim.
 */
export type JournalJson =
  | null
  | boolean
  | number
  | string
  | JournalJson[]
  | { [key: string]: JournalJson }

// ── the catalog ──────────────────────────────────────────────────────────────

/**
 * One Archive row. The catalog is a *cache* — run files are the truth — and is
 * always one rebuild-by-scan away from correct.
 *
 * It carries `deck` (audit A6) because the matcher's predicates (EVOLVED, the
 * subset tests behind D4 and REGRESSED) need a candidate's full multiset, and
 * the design's invariant is that matching opens no run file except the single
 * chosen candidate. ~26 short strings per open run is a cheap way to keep that
 * invariant true.
 *
 * It carries `fileMtimeMs`/`fileBytes` (audit A10) so the startup scan
 * full-parses only files whose stat moved, instead of every run ever recorded.
 */
export interface CatalogEntry {
  id: string
  character: string
  startedAt: number | null
  firstSeenAt: number
  lastSeenAt: number

  state: RunLifecycleState
  outcome: RunOutcome | null
  observedFrom: ObservedFrom
  actReached: number | null
  roomsEntered: number
  countsArePartial: boolean

  deckSize: number
  deckHash: string
  /**
   * The candidate multiset the matcher needs, kept for runs that can still be
   * resumed (`recording`/`suspended`) and dropped for terminal ones, which no
   * matcher will ever ask about.
   */
  deck: string[] | null
  core: string[]

  playerCount: number | null
  activeMs: number
  analysisStatus: AnalysisStatus
  /** Non-null while this run awaits the user's answer to the ambiguity banner. */
  ambiguity: RunAmbiguity | null
  supersededBy: string | null

  /** The file's own schema. Higher than ours ⇒ `unreadable`. */
  schema: number
  /**
   * True when the file exists but this app cannot render it (schema from a
   * newer version). The row is listed with an "update Reliquary" note rather
   * than dropped — dropping it would look like data loss.
   */
  unreadable: boolean

  file: string
  fileBytes: number
  fileMtimeMs: number
}

export interface RunCatalog {
  schema: number
  rebuiltAt: number
  entries: CatalogEntry[]
}

// ── multiplayer cohorts ──────────────────────────────────────────────────────

/**
 * Which archive a run compares against. Averages are split per player count,
 * never pooled and never excluded: a solo run compares against your solo runs,
 * a 2P run against your 2P runs. A cohort with too few runs says so instead of
 * borrowing another cohort's baseline.
 *
 * Ids line up with `CODEX_BRACKETS` so a local cohort can ask the API for the
 * matching community bracket. `playerCount: null` is treated as solo for
 * display but keeps its null in the file, so it is re-classifiable later.
 */
export type RunCohort = 'solo' | '2p' | '3p' | '4p'

export function runCohort(playerCount: number | null | undefined): RunCohort {
  if (playerCount === 2) return '2p'
  if (playerCount === 3) return '3p'
  if (playerCount && playerCount >= 4) return '4p'
  return 'solo'
}

/** "2P" / "Solo" — the Archive's badge text. */
export function cohortLabel(cohort: RunCohort): string {
  return cohort === 'solo' ? 'Solo' : cohort.toUpperCase()
}
