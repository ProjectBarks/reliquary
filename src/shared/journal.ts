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
 *
 * `'death'`, `'victory'` and `'abandoned'` are what the game's own history file
 * proves once `SaveScribe` merges it (save-merge-plan §3.4) — the only source
 * that can tell those three apart. `'abandoned'` is additive: a consumer that
 * predates it must fall through to its unknown-outcome branch rather than
 * assume the run is unfinished.
 */
export type RunOutcome = 'ended' | 'death' | 'victory' | 'superseded' | 'abandoned'

/** Whether we watched the run start, or attached to one already in progress. */
export type ObservedFrom = 'start' | 'mid-run'

/**
 * Why an observation segment ended. `run-ended` is the run itself concluding
 * (death or victory) — without it, a run that died on-screen recorded as
 * `process-gone`, which is a statement about the game's process, not the run.
 */
export type SessionEndReason = 'menu' | 'process-gone' | 'app-quit' | 'character-switch' | 'run-ended'

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
  /**
   * The other players' character ids, as seen during this segment. Per-session
   * rather than per-run because drop-in/drop-out is a real possibility the
   * multiplayer reader cannot yet rule out (Q3/Q4) — a run whose roster changed
   * should say so rather than average itself into one wrong answer.
   */
  otherCharacterIds?: string[]
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

// ── the game's own save file, merged in ──────────────────────────────────────

/**
 * Everything below is normalised from `…\SlayTheSpire2\…\saves\history\<start_time>.run`
 * — the game's own end-of-run ledger — by `main/journal/SaveScribe.ts`
 * (save-merge-plan §3.4).
 *
 * It is a **separate section rather than synthetic events** on purpose. The
 * header's first rule is that events are history *we observed*; interleaving
 * save-derived pseudo-events would forge observations, break `eventCount`
 * folding, and make every event consumer guess at provenance. A section keeps
 * the union honest: the event log stays what the overlay saw, `saveData` stays
 * what the game wrote, and the ledger UI joins them at render time.
 *
 * Nullability follows the same rule as the rest of this file: a field the save
 * did not carry is `null`, never `0`. The shapes are the game's, renamed to the
 * journal's camelCase and nothing more — no derivation, no interpretation.
 */

/** `win` / `was_abandoned` / `killed_by_*` collapsed to the one fact they encode. */
export type SaveResult = 'victory' | 'death' | 'abandoned'

/**
 * How the save file was tied to this run. `'run-key'` is the exact join
 * (`RunFile.runStartTime === start_time === the file's own name`); `'window+deck'`
 * is the fallback for journal runs recorded before the run-key reader landed.
 */
export type SaveMatchedBy = 'run-key' | 'window+deck'

/** A card as the save lists it: id, when it joined the deck, upgrade level. */
export interface SaveCardRef {
  id: string
  /** The game's floor number, not our room index. Null when absent. */
  floorAdded: number | null
  upgradeLevel: number | null
}

/** A relic with its obtain floor and whatever per-relic counters it carries. */
export interface SaveRelicRef {
  id: string
  floorAdded: number | null
  /** `props.ints` flattened (`{ CombatsSeen: 4 }`); null when the relic has none. */
  props: Record<string, number> | null
}

export interface SavePotionRef {
  id: string
  slotIndex: number | null
}

/** An end-of-run accolade (`{ id: 'DAMAGE_LEADER', rarity: 'bronze' }`). */
export interface SaveBadge {
  id: string
  rarity: string | null
}

/**
 * One player's end state.
 *
 * `playerKey` is **opaque and local**. In multiplayer the game writes each
 * player's SteamID64 into `players[].id`, which is a personal identifier: it is
 * kept only as the string that joins a roster row to its `SaveFloorRow`
 * per-player stats, it never leaves the machine, and telemetry carries counts
 * and booleans about this roster, never its contents (save-merge-plan §3.6).
 */
export interface SavePlayer {
  playerKey: string
  /**
   * True when this row is the local player — solo (`id: 1`), or an id equal to
   * the SteamID64 naming the save directory. Null rather than a guess when the
   * roster cannot be attributed (save-merge-plan Q3).
   */
  isLocal: boolean | null
  /** Normalised the journal's way: `CHARACTER.IRONCLAD` → `IRONCLAD`. */
  character: string
  maxPotionSlots: number | null
  finalDeck: SaveCardRef[]
  relics: SaveRelicRef[]
  /** Held at the end of the run, not everything ever owned. */
  potions: SavePotionRef[]
  badges: SaveBadge[]
}

/** One card offer, picked **or skipped** — the gap backfill the log cannot have. */
export interface SaveCardChoice {
  id: string
  wasPicked: boolean
  floorAdded: number | null
}

/** A relic or potion offer, picked or skipped. */
export interface SaveChoiceRef {
  id: string
  wasPicked: boolean
}

export interface SaveTransform {
  from: string
  to: string
}

/** A card enchanted at a rest site or event: which card, which enchantment. */
export interface SaveEnchant {
  id: string
  enchantment: string
  amount: number | null
}

/** The start-node (Neow-equivalent) offer, one row per option. */
export interface SaveAncientChoice {
  id: string
  wasChosen: boolean
}

/**
 * An event option as taken, by localisation key
 * (`DENSE_VEGETATION.pages.INITIAL.options.TRUDGE_ON.title`), with the dynamic
 * text bag flattened to scalars when the save carried one.
 */
export interface SaveEventChoice {
  key: string
  variables: Record<string, string | number | boolean> | null
}

/** Everything one player did, gained and lost on one floor. */
export interface SaveFloorPlayerStats {
  /** Joins to `SavePlayer.playerKey`. */
  playerKey: string

  currentHp: number | null
  maxHp: number | null
  damageTaken: number | null
  hpHealed: number | null
  maxHpGained: number | null
  maxHpLost: number | null

  currentGold: number | null
  goldGained: number | null
  goldLost: number | null
  goldSpent: number | null
  goldStolen: number | null
  stolenLoot: number | null

  cardChoices: SaveCardChoice[]
  cardsGained: SaveCardRef[]
  cardsRemoved: SaveCardRef[]
  cardsTransformed: SaveTransform[]
  cardsUpgraded: string[]
  cardsDowngraded: string[]
  cardsEnchanted: SaveEnchant[]

  relicChoices: SaveChoiceRef[]
  relicsRemoved: string[]

  potionChoices: SaveChoiceRef[]
  potionsUsed: string[]
  potionsDiscarded: string[]

  /** Shop purchases. Bought *cards* arrive in `cardsGained`, as the game files them. */
  boughtRelics: string[]
  boughtColorless: string[]
  boughtPotions: string[]

  restChoices: string[]
  ancientChoices: SaveAncientChoice[]
  eventChoices: SaveEventChoice[]
  completedQuests: string[]
}

/** What a map node actually resolved into, which is not always what it looked like. */
export interface SaveRoom {
  /** The concrete encounter or event: `ENCOUNTER.FOGMOG_NORMAL`, `EVENT.NEOW`. */
  modelId: string | null
  /** `monster | elite | boss | event | shop | rest_site | treasure`. */
  roomType: string | null
  monsterIds: string[]
  turnsTaken: number | null
}

/** One entered map point, flattened out of `map_point_history[act][floor]`. */
export interface SaveFloorRow {
  /** 0-based act index — the position in `map_point_history`. */
  act: number
  /** `acts[act]` (`ACT.OVERGROWTH`), null when the save listed fewer acts. */
  actId: string | null
  /** 0-based position within the act. */
  floorInAct: number
  /** 1-based across the whole run — the game's own floor number. */
  globalFloor: number
  /** As drawn on the map: `ancient | monster | elite | boss | shop | rest_site | treasure | unknown`. */
  mapPointType: string | null
  /** Usually one; kept as a list because the save models it as one. */
  rooms: SaveRoom[]
  players: SaveFloorPlayerStats[]
}

/**
 * The merged section on a `RunFile`. Null (or absent, on files written before
 * this shipped) until a history file for this run is found and merged.
 */
export interface RunSaveData {
  mergedAt: number
  /** Absolute path of the `.run` file, so a profile switch never mixes ledgers. */
  sourceFile: string
  sourceMtimeMs: number
  sourceBytes: number
  matchedBy: SaveMatchedBy
  /** The save's own `schema_version` (9 at time of writing). */
  schemaVersion: number
  /** The run's exact identity, and the one thing that survives everything. */
  seed: string
  /** Unix **seconds**, `== RunFile.runStartTime == the file's name`. */
  startTime: number
  /** Raw `run_time`; units unconfirmed (save-merge-plan Q2), so nothing displays it. */
  runTimeS: number | null
  result: SaveResult
  /** `ENCOUNTER.FOGMOG_NORMAL`; null when the save said `NONE.NONE`. */
  killedByEncounter: string | null
  killedByEvent: string | null
  ascension: number | null
  gameMode: string | null
  buildId: string | null
  modifiers: string[]
  /** The act *route* — always all three, regardless of how far the run got. */
  acts: string[]
  players: SavePlayer[]
  floors: SaveFloorRow[]
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
  /**
   * The game's own run start timestamp (`RunManager._startTime`, unix SECONDS),
   * or null when it was never readable. Unlike `startedAt` this is not our
   * observation — it is the value the game wrote into its save, which is why it
   * survives a quit and is the matcher's primary identity anchor. Stored on the
   * file *and* mirrored into the catalog row so matching an exact resume never
   * has to open a run file.
   */
  runStartTime: number | null
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

  /**
   * The game's own history file for this run, merged in by `SaveScribe`. Null
   * until that happens, and **absent** on every file written before the merge
   * shipped — which is why it is optional rather than required: an additive
   * field must not make a year of existing run files invalid. Read it as
   * `run.saveData ?? null`.
   */
  saveData?: RunSaveData | null
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
  /**
   * The game's own run start time (seconds), mirrored from the run file. It is
   * the matcher's *primary* anchor — an exact match resumes regardless of deck
   * state — so it has to be answerable from the catalog alone, for the same
   * reason `deck` is here (audit A6).
   */
  runStartTime: number | null

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

  /**
   * True once the run's own history file has been merged (`RunFile.saveData`).
   * Mirrored here so the Archive can mark a row — and the unmatched-saves
   * footer can count — without opening a run file. Optional for the same
   * reason as `RunFile.saveData`: rows predating the merge simply lack it.
   */
  hasSaveData?: boolean
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

/**
 * Which of the game's two live saves a run occupies. StS2 keeps exactly one
 * `current_run.save` and one `current_run_mp.save` (WP1 findings, Q2), so a new
 * run supersedes the previous run *of the same mode* — not of the same
 * character, which is what the plan body assumed before the save layout was
 * known. Cohorts split further (2P/3P/4P); supersession does not care how many.
 */
export type RunMode = 'sp' | 'mp'

export function runMode(playerCount: number | null | undefined): RunMode {
  return playerCount != null && playerCount > 1 ? 'mp' : 'sp'
}

// ── live "current run" key + push channel ────────────────────────────────────

/**
 * The `journal.currentRun` keyed snapshot: **liveness only**.
 *
 * It used to be a second description of the run — character, act, deck size, a
 * `recentRoute` of bare room rows — published beside the run file that already
 * held all of it. Two descriptions of one run is two derivations, and they
 * drifted: the file's events carry pickups, skips and deck deltas, and the
 * keyed rows structurally could not, so the live view showed a route with an
 * empty pickup column while the report of the same run showed the cards
 * (observed live, 2026-08-14).
 *
 * So the run FILE is the single source of truth and `derive.ts` is the single
 * derivation — the Current Run view fetches the file by `runId` and folds it
 * with the very functions the report uses. What is left here is the handful of
 * facts a file on disk legitimately cannot carry:
 *
 *   - `runId` — *which* archived run is the live one. Everything else is looked
 *     up from it, which is what makes drift impossible rather than unlikely.
 *   - `elapsedActiveMs` — observed play time including the session in progress,
 *     which only the recorder's monotonic clock knows. `run.pace` is not
 *     written until the run closes.
 *   - `inCombat` / `lastSeenAt` — the heartbeat. A file cannot say "right now".
 *
 * Nothing derived belongs here. Anything added back becomes a second engine.
 *
 * `null` while no run is being recorded.
 */
export interface JournalCurrentRun {
  /** The live run's id — the key to its file, and to everything derived. */
  runId: string
  /**
   * Monotonic-clock ms of observation, closed sessions plus the live one. Both
   * the elapsed readout and the pace denominator; the file's own `pace` block
   * is only filled in at close.
   */
  elapsedActiveMs: number
  /** Wall clock of the last poll that saw this run. */
  lastSeenAt: number
  inCombat: boolean
}

/**
 * Pushed on `IPC.JournalPush` whenever the Archive's view of the world moves.
 * Shaped like `CodexPushMessage` on purpose — same spine, same discipline: the
 * renderer never polls, and a change made while a view is open arrives without
 * a refocus.
 */
export type JournalPushMessage =
  | { kind: 'catalog'; entries: CatalogEntry[] }
  | { kind: 'analysis'; id: string; status: AnalysisStatus }

/** Every journal invoke resolves one of these; none of them ever rejects. */
export type JournalResult<T> = { data: T } | { error: string }
