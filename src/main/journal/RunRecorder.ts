import {
  runCohort,
  runMode,
  type AmbiguityResolution,
  type CatalogEntry,
  type DeckCountRow,
  type DeckGroupRow,
  type GapReason,
  type JournalCurrentRun,
  type RunCombat,
  type RunEvent,
  type RunEventBase,
  type RunFile,
  type RunOpenOffer,
  type RunSession,
  type SessionEndReason
} from '@shared/journal'
import type { RawCard, RawNGameState, RawPileState, RawVisibleItems } from '../scry/readers'
import type { RawSnapshot } from '../scry/readerProtocol'
import type { RawTapContext, RawTapSignal } from '../scry/provider'
import {
  buildFingerprint,
  deckDelta,
  deckHashOf,
  deckMultiset,
  matchSighting,
  normalizeCharacter,
  sameFingerprint,
  type MatchCandidate,
  type MatchVerdict,
  type RunFingerprint
} from './SessionMatcher'
import type { JournalIssueSink, RunStore } from './RunStore'

/**
 * The run journal's state machine: raw polls in, a run file out.
 *
 * It sits on the provider's raw tap rather than on `emitSnapshot`, because the
 * emitted snapshots are the renderer's contract and drop everything capture
 * needs — the owned deck, the exhaust pile, per-card instance addresses,
 * offered ids and prices, and the individual polls themselves (audit A1).
 *
 * Four things it is deliberately careful about, each because getting it wrong
 * costs a real run rather than a pixel:
 *
 *   1. **A torn read is not an observation.** A deck read racing a game-side
 *      mutation comes back short but non-empty; it would hash to a plausible
 *      wrong value and look like a diverged run. Every identity decision waits
 *      for three consecutive polls that agree, and any poll flagged
 *      `deckPartial` is discarded outright (audit A3).
 *   2. **Losing sight of the game is not the run ending.** `nGame: null` means
 *      menu *or* loading *or* a dead-pointer streak, and the reader fabricates
 *      `processGone` after 40 failed polls with the game still running. So the
 *      menu debounce pauses while reads are failing, and a `processGone` that
 *      the detector does not corroborate within one detect cycle is treated as
 *      a reader hiccup (audit A11).
 *   3. **Nothing is retired on a hunch.** A verdict's supersession list is held
 *      until the new run is *confirmed* — a deck mutation, a room, or a minute
 *      of continuous recording — so a transient misread cannot permanently
 *      abandon a live run (audit A5).
 *   4. **When it genuinely cannot tell, it asks.** Inside the pre-first-pick
 *      window the matcher returns `ambiguous`; the recorder then opens a *new
 *      provisional* file and raises the banner. No event is ever written into a
 *      run that might not be the right one.
 *
 * Everything is injected — store, clocks, environment, telemetry sinks — so the
 * whole machine runs under plain node in `scripts/journal-recorder-selfcheck.mjs`.
 */

// ── cadences ─────────────────────────────────────────────────────────────────

/** The reader's real poll interval (`readerProcess.ts`), not the plan's stale ~150 ms. */
export const POLL_MS = 250

/** Identity waits for agreement across this many polls (~750 ms). */
const SIGHTING_STABLE_POLLS = 3

/** Mirrors the provider's offer debounce, for the same reason: memory flickers. */
const OFFER_STABLE_POLLS = 3

/** Quit-to-menu debounce. Long act loads stay under it; a real quit does not. */
const MENU_DEBOUNCE_MS = 10_000

/** One detect cycle. A `processGone` unconfirmed for this long was a hiccup. */
const PROCESS_GONE_GRACE_MS = 2_000

/** `isGameOver` must hold this many polls before a run is closed (Q9). */
const GAME_OVER_POLLS = 2

/** How long after an offer vanishes a deck gain still counts as its pick. */
const PICK_DEADLINE_MS = 10_000

/** Force a flush this often during a long combat, so a crash costs little. */
const HEARTBEAT_MS = 60_000

/** Continuous recording after which a new run is confirmed and may sweep. */
const CONFIRM_MS = 60_000

/**
 * Floor on catalog pushes made *because the ledger moved* (rooms, offers, deck
 * changes). It is the freshness budget of the Current Run view: the file is
 * already flushed on those boundaries, this is only how often the renderer is
 * told to come and read it again. Below a second the trailing edge of a fight
 * would push per poll; much above it and a pickup takes visibly long to appear.
 */
const LEDGER_PUBLISH_MS = 1_200

/** A runaway event count is a bug, not a run (§5.4). */
const MAX_EVENTS = 20_000
const KEEP_EVENTS = 2_000

/** Sources whose offers add a card to the deck, and so can be pick-inferred. */
const ADDITIVE_SOURCES = new Set(['cardReward', 'chooseACard', 'merchant'])

/**
 * Append a derived event.
 *
 * `RunEvent` names only the session-layer types; everything the recorder
 * derives (`room_enter`, `offer_shown`, `deck_add`…) is deliberately not
 * enumerated in the shared model, because the store round-trips events verbatim
 * and consumers must skip the ones they do not know. Pushing a literal straight
 * into `RunEvent[]` would therefore trip excess-property checking on every
 * field that makes the event worth recording; inferring the literal's own type
 * first is the one narrow place that fiction is admitted.
 */
function pushEvent<T extends RunEventBase>(events: RunEvent[], event: T): void {
  events.push(event)
}

// ── options ──────────────────────────────────────────────────────────────────

export interface RunRecorderOptions {
  store: RunStore
  /** Wall clock for timestamps. Injectable so tests can pin them. */
  now?: () => number
  /**
   * Monotonic milliseconds. Durations never come from wall-clock subtraction: a
   * sleeping laptop, DST or an NTP step would otherwise produce a negative or
   * wildly inflated pace.
   */
  monotonic?: () => number
  env?: Record<string, string | undefined>
  onIssue?: JournalIssueSink
  /** Shaped like `telemetry.capture` — the non-error half of the reporting. */
  onEvent?: (name: string, props: Record<string, unknown>) => void
  /** Publishes the `journal.currentRun` keyed snapshot. */
  onCurrentRun?: (value: JournalCurrentRun | null) => void
  /** Publishes a catalog push whenever the Archive's view of the world moves. */
  onCatalog?: (entries: CatalogEntry[]) => void
  /**
   * A run reached a terminal state and is queued for review. The post-run
   * pipeline (WP6) hangs off this rather than off the store, because "closed"
   * is a fact only the state machine knows — the file merely records it.
   */
  onRunClosed?: (id: string) => void
  /**
   * A run stopped being observed without ending: quit to menu, the process went
   * away, the app is quitting. Separate from `onRunClosed` because the two mean
   * opposite things to the journal — but the same thing to `SaveScribe`, which
   * hangs off both: the game writes its history file when a run *ends*, and
   * from here we cannot tell a quit-to-menu from an abandon confirmed one
   * screen later. Sweeping on both is what makes that distinction the save
   * file's problem instead of ours.
   */
  onRunSuspended?: (id: string, reason: SessionEndReason) => void
  menuDebounceMs?: number
  processGoneGraceMs?: number
  confirmMs?: number
  pickDeadlineMs?: number
  heartbeatMs?: number
}

// ── internal shapes ──────────────────────────────────────────────────────────

/** Per-combat instance tracking; nothing here is persisted until the row closes. */
interface OpenCombat {
  row: RunCombat
  /** baseAddress → where that instance was last seen, and what it is. */
  loc: Map<string, { where: 'hand' | 'pile'; id: string }>
  drawn: Map<string, number>
  plays: Map<string, number>
  /**
   * Poll seq of the last turn change — bulk discards ride just behind it.
   * Null until a turn actually changes: combat *starting* is not a turn change,
   * and treating it as one would swallow the first plays of every fight.
   */
  sideChangedSeq: number | null
  lastHand: number
  lastDraw: number
  startedMono: number
  lastFlushMono: number
}

interface ActiveSession {
  sid: number
  startedMono: number
  playerCount: number | null
  otherCharacterIds: string[]
}

// ── the recorder ─────────────────────────────────────────────────────────────

export class RunRecorder {
  private readonly store: RunStore
  private readonly now: () => number
  private readonly mono: () => number
  private readonly onIssue: JournalIssueSink
  private readonly onEvent: (name: string, props: Record<string, unknown>) => void
  private readonly onCurrentRunCb: ((value: JournalCurrentRun | null) => void) | null
  private readonly onCatalogCb: ((entries: CatalogEntry[]) => void) | null
  private readonly onRunClosedCb: ((id: string) => void) | null
  private readonly onRunSuspendedCb: ((id: string, reason: SessionEndReason) => void) | null
  private readonly debug: boolean
  private readonly menuDebounceMs: number
  private readonly goneGraceMs: number
  private readonly confirmMs: number
  private readonly pickDeadlineMs: number
  private readonly heartbeatMs: number

  /** Sightings are held until the startup scan finishes (audit A10). */
  private ready = false
  private disposed = false
  /** True from `flushSync` on: no more asynchronous writes are worth starting. */
  private quitting = false

  private run: RunFile | null = null
  private session: ActiveSession | null = null

  // Sighting stability.
  private pending: RunFingerprint | null = null
  private pendingPolls = 0
  private lastFingerprint: RunFingerprint | null = null

  // Observation context.
  private detected = true
  private errorStreak = 0
  private gameVersion: string | null = null
  private nullSince: number | null = null
  private pendingGoneAt: number | null = null
  private goneTimer: ReturnType<typeof setTimeout> | null = null
  private gameOverPolls = 0

  // Run-scoped derivation.
  private lastDeck: string[] | null = null
  private lastFloor: number | null = null
  private lastAct: number | null = null
  private lastTraveling = false
  /** The A7 corroborator: rooms counted off the travel edge instead of the floor. */
  private travelRooms = 0
  private floorRooms = 0
  private combat: OpenCombat | null = null
  private offerKey = ''
  private offerStreak = 0
  private inCombat = false

  // Deferred supersession (audit A5).
  private pendingSupersede: string[] = []
  private confirmDeadlineMono = 0

  /** Set on close, so a same-deck sighting right after can be reported (Q9). */
  private lastClose: { id: string; character: string; deckHash: string; at: number } | null = null
  private closeReported = false
  /** True while a resume is awaiting its file; a second sighting must not race it. */
  private opening = false

  private lastPublished = ''

  /**
   * The ledger-moved throttle. A room entered, an offer resolved or a deck
   * change means the *run file* now says something new, and the renderer only
   * refetches a held run file when a catalog row advances — so the ledger
   * boundaries publish one. Throttled, because a fight is a deck change every
   * few polls and a refetch per poll is not a live view, it is a poll loop.
   */
  private ledgerTimer: ReturnType<typeof setTimeout> | null = null
  private lastLedgerPublishMono = -Infinity

  constructor(opts: RunRecorderOptions) {
    this.store = opts.store
    this.now = opts.now ?? Date.now
    this.mono = opts.monotonic ?? defaultMonotonic
    this.onIssue = opts.onIssue ?? ((): void => {})
    this.onEvent = opts.onEvent ?? ((): void => {})
    this.onCurrentRunCb = opts.onCurrentRun ?? null
    this.onCatalogCb = opts.onCatalog ?? null
    this.onRunClosedCb = opts.onRunClosed ?? null
    this.onRunSuspendedCb = opts.onRunSuspended ?? null
    this.debug = !!(opts.env ?? process.env)['SPECTRA_DEBUG']
    this.menuDebounceMs = opts.menuDebounceMs ?? MENU_DEBOUNCE_MS
    this.goneGraceMs = opts.processGoneGraceMs ?? PROCESS_GONE_GRACE_MS
    this.confirmMs = opts.confirmMs ?? CONFIRM_MS
    this.pickDeadlineMs = opts.pickDeadlineMs ?? PICK_DEADLINE_MS
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Opens the store, runs the rebuild-by-scan, and takes ownership of any
   * `recording` file left behind by a killed process. Sightings observed before
   * this resolves are simply not acted on — a held sighting is lossless,
   * because the next poll 250 ms later carries the same facts.
   */
  async start(): Promise<void> {
    await this.store.open()
    await this.store.scan()
    await this.demoteOrphans()
    this.ready = true
    this.publishCatalog()
    this.publishCurrentRun()
  }

  /**
   * Crash orphans: a `recording` file whose process died. Fold whatever events
   * the snapshot had not absorbed, close the dangling combat as aborted, and
   * demote to `suspended` — which makes it a full resume candidate, exactly
   * like an honest quit-to-menu would have.
   */
  private async demoteOrphans(): Promise<void> {
    const orphans = this.store.list().filter((e) => e.state === 'recording' && !e.unreadable)
    if (!orphans.length) return
    for (const entry of orphans) {
      const run = await this.store.getRun(entry.id)
      if (!run) continue
      foldTrailingEvents(run)
      const at = run.lastSeenAt || this.now()
      this.abortOpenCombat(run, at)
      const live = run.sessions[run.sessions.length - 1]
      if (live && live.detachedAt === null) {
        live.detachedAt = at
        live.reason = 'app-quit'
        pushEvent(run.events, { t: at, type: 'session_detach', sid: live.sid, reason: 'app-quit' })
      }
      run.state = 'suspended'
      refreshSnapshot(run, at)
      this.store.save(run, { immediate: true })
      this.onIssue('journal_orphan_demoted', 'info', {
        id: run.id,
        events: run.events.length,
        aborted_combat: run.combats.some((c) => c.aborted)
      })
    }
    await this.store.flush()
  }

  /** Stops timers. The caller flushes; this only lets the process exit. */
  dispose(): void {
    this.disposed = true
    if (this.goneTimer) clearTimeout(this.goneTimer)
    this.goneTimer = null
    if (this.ledgerTimer) clearTimeout(this.ledgerTimer)
    this.ledgerTimer = null
  }

  /**
   * `will-quit`: end the live session honestly and write synchronously.
   * Idempotent, because `will-quit` fires twice.
   *
   * `quitting` matters more than it looks: an `immediate` save starts the
   * store's *asynchronous* flush, which drains the dirty set synchronously and
   * then awaits — so the synchronous write that follows would find nothing to
   * do, and the run's last minutes would only come back as a crash orphan next
   * launch. On this path the work is left dirty on purpose.
   */
  flushSync(): void {
    this.quitting = true
    if (this.run && this.session) this.suspend('app-quit')
    this.store.flushSync()
  }

  // ── inputs ─────────────────────────────────────────────────────────────────

  /** The window detector. Corroborates (or refutes) a `processGone`. */
  onProcess(state: { detected: boolean }): void {
    this.detected = state.detected
    if (!state.detected) {
      this.pendingGoneAt = null
      if (this.goneTimer) clearTimeout(this.goneTimer)
      this.goneTimer = null
      this.suspend('process-gone')
      this.publishCurrentRun()
    }
  }

  /** The out-of-band half of the raw tap. */
  onSignal(signal: RawTapSignal): void {
    switch (signal.type) {
      case 'gameVersion':
        this.gameVersion = signal.version
        break
      case 'readFailed':
        this.errorStreak = signal.errorStreak
        break
      case 'processGone':
        this.errorStreak = signal.errorStreak
        // The reader synthesises this after 40 failed polls with the game still
        // running, so on its own it is not evidence the game is gone. Wait one
        // detect cycle for the detector to agree; if it does not, this was a
        // dead-pointer streak inside a live run and the run keeps recording.
        this.pendingGoneAt = this.now()
        if (this.goneTimer) clearTimeout(this.goneTimer)
        this.goneTimer = setTimeout(() => {
          this.goneTimer = null
          if (this.pendingGoneAt === null) return
          this.pendingGoneAt = null
          if (this.detected) {
            this.onIssue('journal_process_gone_uncorroborated', 'info', {
              error_streak: this.errorStreak
            })
            return
          }
          this.suspend('process-gone')
          this.publishCurrentRun()
        }, this.goneGraceMs)
        ;(this.goneTimer as unknown as { unref?: () => void }).unref?.()
        break
    }
  }

  /**
   * One poll. Everything the recorder knows arrives here, undeduplicated —
   * which is what makes "the same values for three consecutive polls" a
   * question that can be asked at all.
   */
  observe(raw: RawSnapshot, ctx: RawTapContext): void {
    if (this.disposed) return
    this.detected = ctx.detected
    this.errorStreak = ctx.errorStreak
    if (ctx.gameVersion) this.gameVersion = ctx.gameVersion
    const at = this.now()

    // A snapshot means the reader is alive and reading, which settles a pending
    // `processGone` in favour of "hiccup" without waiting out the grace window.
    if (this.pendingGoneAt !== null && raw.nGame) {
      this.pendingGoneAt = null
      if (this.goneTimer) clearTimeout(this.goneTimer)
      this.goneTimer = null
    }

    if (!raw.nGame) {
      this.pending = null
      this.pendingPolls = 0
      this.observeAbsence(at)
      this.publishCurrentRun()
      return
    }
    this.nullSince = null

    if (this.run) this.observeRunning(raw, raw.nGame, at, ctx)
    this.observeSighting(raw, raw.nGame, at)
    this.publishCurrentRun()
  }

  /**
   * `nGame: null` — menu, a loading screen, or reads failing inside a live run.
   * The debounce only accumulates while reads are healthy: a dead-pointer
   * streak and a quit-to-menu are the same wire value, and only the streak
   * tells them apart (audit A11).
   */
  private observeAbsence(at: number): void {
    if (!this.run) return
    if (this.errorStreak > 0) {
      // Freeze the clock rather than reset it, so a flapping read cannot hold
      // the debounce open forever either.
      if (this.nullSince !== null) this.nullSince = at - this.elapsedNull(at)
      return
    }
    if (this.nullSince === null) {
      this.nullSince = at
      return
    }
    if (at - this.nullSince >= this.menuDebounceMs) this.suspend('menu')
  }

  private elapsedNull(at: number): number {
    return this.nullSince === null ? 0 : at - this.nullSince
  }

  // ── sighting → the decision table ──────────────────────────────────────────

  /**
   * A sighting is a fingerprint that has survived three consecutive polls
   * unchanged. Building one refuses a torn deck read and a null act outright,
   * so an unstable game state simply produces no sighting rather than a wrong
   * one.
   */
  private observeSighting(raw: RawSnapshot, nGame: RawNGameState, at: number): void {
    const pile = raw.pile
    const fingerprint = pile
      ? buildFingerprint({
          character: nGame.characterId,
          act: nGame.currentActIndex,
          deck: deckMultiset(pile.deck),
          deckSize: pile.deckSize,
          deckPartial: pile.deckPartial,
          playerCount: nGame.playerCount,
          runStartTime: nGame.runStartTime,
          totalFloor: nGame.totalFloor
        })
      : null
    if (!fingerprint) {
      this.pending = null
      this.pendingPolls = 0
      return
    }
    if (sameFingerprint(this.pending, fingerprint)) this.pendingPolls++
    else {
      this.pending = fingerprint
      this.pendingPolls = 1
    }
    if (this.pendingPolls < SIGHTING_STABLE_POLLS) return

    // D10: a character change is a suspension of the current run — switching
    // characters does not kill it — followed by this table for the new one.
    if (this.run && this.run.character !== fingerprint.character) {
      this.suspend('character-switch')
    }
    if (this.run) {
      this.lastFingerprint = fingerprint
      this.trackRunKey(fingerprint, at)
      return
    }
    if (!this.ready || this.opening) return

    // The game-over screen is still up. Opening a file here would fabricate a
    // second, mid-run copy of the run we just closed — the exact duplicate the
    // plan names as its worst outcome.
    if (nGame.isGameOver) return

    // Same guard, one step further out: a closed run whose deck is still on
    // screen is a *false close*, not a new run. Recording it again would give
    // the Archive two rows for one evening, so the sighting is refused and
    // reported instead, and the guard lifts the moment the deck changes.
    if (this.lastClose) {
      if (this.lastClose.deckHash === fingerprint.deckHash) {
        if (!this.closeReported) {
          this.closeReported = true
          this.onIssue('journal_close_then_exact_sighting', 'warn', {
            closed_id: this.lastClose.id,
            after_ms: at - this.lastClose.at
          })
        }
        return
      }
      this.lastClose = null
      this.closeReported = false
    }

    this.lastFingerprint = fingerprint
    this.openFrom(fingerprint, at, nGame.roomType)
  }

  /**
   * The runtime verification WP3 owes §6: does a *resumed* run report its
   * original start time? Every poll of a live run compares the value against
   * what the file recorded, and a change without an intervening suspension is
   * exactly the observation that would falsify using it as identity.
   */
  private trackRunKey(f: RunFingerprint, at: number): void {
    const run = this.run
    if (!run || f.runStartTime === null) return
    if (run.runStartTime === null) {
      run.runStartTime = f.runStartTime
      this.store.save(run)
      return
    }
    if (run.runStartTime === f.runStartTime) return
    this.onIssue('journal_runstart_changed', 'warn', {
      id: run.id,
      stored: run.runStartTime,
      observed: f.runStartTime,
      delta_sec: f.runStartTime - run.runStartTime,
      act: f.act
    })
    this.dbg(
      `run start time changed under a live run: ${run.runStartTime} → ${f.runStartTime} — ` +
        'the game key is NOT stable across this transition'
    )
    run.runStartTime = f.runStartTime
    run.lastSeenAt = Math.max(run.lastSeenAt, at)
    this.store.save(run)
  }

  /** Runs the decision table and opens, resumes, or provisionally forks a file. */
  private openFrom(f: RunFingerprint, at: number, roomType: string | null): void {
    // `CatalogEntry` satisfies `MatchCandidate` structurally, which is the whole
    // point of A6: matching reads rows and opens no run file but the winner's.
    const candidates: MatchCandidate[] = this.store.candidates(f.character)
    const sweepPool: MatchCandidate[] = this.store.list()
    const verdict = matchSighting(f, candidates, { sweepPool })

    this.onEvent('journal_match', {
      rule: verdict.rule,
      kind: verdict.kind,
      considered: verdict.considered,
      has_run_key: f.runStartTime !== null,
      act: f.act,
      deck_size: f.deckSize,
      mode: f.mode
    })
    this.dbg(`match ${verdict.rule} → ${verdict.kind}: ${verdict.why}`)
    if (verdict.anomaly) {
      this.onIssue('journal_match_anomaly', 'warn', {
        anomaly: verdict.anomaly,
        rule: verdict.rule,
        why: verdict.why
      })
    }

    if (verdict.kind === 'resume' && verdict.candidateId) {
      this.opening = true
      void this.resume(verdict, f, at).finally(() => {
        this.opening = false
      })
      return
    }
    this.openNew(verdict, f, at, roomType)
  }

  /** Resume path — the same code whether the gap was 10 seconds or three days. */
  private async resume(verdict: MatchVerdict, f: RunFingerprint, at: number): Promise<void> {
    const id = verdict.candidateId!
    const run = await this.store.getRun(id)
    if (!run) {
      // The row promised a file that is not there. Rebuild-by-scan will drop
      // the row; meanwhile a new file is the only non-destructive answer.
      this.onIssue('journal_resume_file_missing', 'warn', { id })
      this.openNew({ ...verdict, kind: 'new', candidateId: null }, f, at, null)
      return
    }
    // The Q1/WP1 verification hook: what the file remembers versus what the
    // game reports now. `matched: true` on a genuine quit-and-resume is the
    // evidence that collapses §2's matching to a lookup.
    this.onEvent('journal_runstart_verify', {
      matched: run.runStartTime !== null && run.runStartTime === f.runStartTime,
      stored: run.runStartTime,
      observed: f.runStartTime,
      rule: verdict.rule,
      gap: verdict.gap,
      elapsed_ms: at - run.lastSeenAt
    })
    this.dbg(
      `resume ${id} via ${verdict.rule}: run key stored=${run.runStartTime ?? '—'} ` +
        `observed=${f.runStartTime ?? '—'} (${
          run.runStartTime !== null && run.runStartTime === f.runStartTime ? 'MATCH' : 'no match'
        })`
    )
    if (run.runStartTime === null && f.runStartTime !== null) run.runStartTime = f.runStartTime

    this.adopt(run, f, at)
    if (verdict.gap) this.recordGap(run, f, verdict.gap, at)
    this.attachSession(run, f, at, false)
    this.holdSupersession(verdict.supersede)
    this.settleOfferAcrossGap(run, f, at)
  }

  /**
   * New-file path, including the provisional fork the ambiguity banner needs.
   *
   * `roomType` is the sighting's own room, carried in separately because the
   * fingerprint deliberately does not hold it: the room a run is standing in is
   * not part of its identity, but it *is* the first row of its route, and
   * passing null here labelled every run's opening room `other` in the Route
   * Ledger — a fight, an event and a shop all read the same.
   */
  private openNew(
    verdict: MatchVerdict,
    f: RunFingerprint,
    at: number,
    roomType: string | null
  ): void {
    const ambiguous = verdict.kind === 'ambiguous' && verdict.candidateId
    const run = this.store.createRun({
      character: f.character,
      observedFrom: verdict.observedFrom,
      startedAt: verdict.observedFrom === 'start' ? at : null,
      firstSeenAt: at,
      runStartTime: f.runStartTime,
      gameVersion: this.gameVersion,
      playerCount: f.playerCount,
      ambiguity: ambiguous
        ? { candidateId: verdict.candidateId!, raisedAt: at, resolution: null, resolvedAt: null }
        : null
    })
    this.adopt(run, f, at)
    if (verdict.observedFrom === 'start') {
      pushEvent(run.events, { t: at, type: 'run_start' })
    }
    if (ambiguous) {
      pushEvent(run.events, { t: at, type: 'ambiguity_raised', candidateId: verdict.candidateId! })
      this.onEvent('journal_ambiguity_raised', { candidate: verdict.candidateId })
      this.dbg(`ambiguous sighting — provisional run ${run.id} pending the banner`)
    }
    this.attachSession(run, f, at, true)
    if (verdict.observedFrom === 'start' && f.totalFloor !== null) {
      // The room we are standing in when a run begins. Without this the counter
      // starts at zero and every route row is off by one for the run's life —
      // the floor rising edge can only ever see the *next* room.
      this.enterRoom(run, at, f.totalFloor, roomType)
    } else if (f.totalFloor !== null) {
      // A mid-run attach has no observed first room, but the game's own floor
      // number does — so the header can be honest instead of starting at zero.
      run.floorReached = f.totalFloor
    }
    // Held *after* the opening room, so that room does not count as the
    // confirmation: an opening room is part of the sighting, not evidence
    // beyond it (audit A5).
    this.holdSupersession(verdict.supersede)
  }

  /** Point the recorder's run-scoped state at a file and its current reality. */
  private adopt(run: RunFile, f: RunFingerprint, at: number): void {
    this.run = run
    run.state = 'recording'
    run.lastSeenAt = Math.max(run.lastSeenAt, at)
    this.lastDeck = [...f.deck]
    this.lastAct = f.act
    this.lastFloor = f.totalFloor
    this.lastFingerprint = f
    this.combat = null
    this.offerKey = ''
    this.offerStreak = 0
    this.gameOverPolls = 0
    this.nullSince = null
    this.travelRooms = 0
    this.floorRooms = 0
    if (run.snapshot.openCombat) {
      // A combat we were inside when we lost sight of the run. The game restarts
      // it from the top on resume (Q8), so its tallies are excluded rather than
      // double-counted.
      this.abortOpenCombat(run, at)
    }
  }

  private attachSession(run: RunFile, f: RunFingerprint, at: number, fresh: boolean): void {
    const sid = (run.sessions[run.sessions.length - 1]?.sid ?? 0) + 1
    const session: RunSession = {
      sid,
      attachedAt: at,
      detachedAt: null,
      reason: null,
      activeMs: 0,
      playerCount: f.playerCount,
      otherCharacterIds: [],
      gameVersion: this.gameVersion
    }
    run.sessions.push(session)
    pushEvent(run.events, { t: at, type: 'session_attach', sid, fresh })
    this.session = {
      sid,
      startedMono: this.mono(),
      playerCount: f.playerCount,
      otherCharacterIds: []
    }
    if (this.gameVersion) run.gameVersion = this.gameVersion
    this.applyPlayerCount(run, f.playerCount, [])
    this.commit(run, at, true)
    this.publishCatalog()
  }

  /**
   * A hole in the record. `unobserved-play` is the run moving on without us;
   * `save-restore` is the deck going backwards, which is a restored save rather
   * than a different run.
   */
  private recordGap(run: RunFile, f: RunFingerprint, reason: GapReason, at: number): void {
    const before = run.snapshot.deck
    const { added, removed } = deckDelta(before, f.deck)
    pushEvent(run.events, {
      t: at,
      type: 'gap',
      reason,
      actFrom: run.snapshot.act,
      actTo: f.act,
      deckAdded: added,
      deckRemoved: removed
    })
    // Any gap makes every count downstream an under-count, and the Archive says
    // so rather than presenting a partial number as a total.
    run.countsArePartial = true
    this.onEvent('journal_gap', {
      reason,
      act_from: run.snapshot.act,
      act_to: f.act,
      added: added.length,
      removed: removed.length
    })
  }

  /**
   * An offer that was still open when we lost the run. If the deck gained one
   * of the offered cards while we were away, that is the pick; otherwise the
   * deadline has long passed and it was a skip. Either way the row closes —
   * an offer left open forever would sit in the snapshot for the run's life.
   */
  private settleOfferAcrossGap(run: RunFile, f: RunFingerprint, at: number): void {
    const offer = run.snapshot.openOffer
    if (!offer) return
    const { added } = deckDelta(run.snapshot.deck, f.deck)
    const gained = added.map(cardBaseId).filter((id) => offer.offered.includes(id))
    const picked = gained.length === 1 ? gained[0]! : gained.length > 1 ? `ambiguous:${gained[0]!}` : null
    pushEvent(run.events, { t: at, type: 'offer_resolved', eid: offer.eid, picked, acrossGap: true })
    run.snapshot.openOffer = null
    this.commit(run, at)
  }

  // ── recording ──────────────────────────────────────────────────────────────

  /** Everything derived while a run is live. Ordered the way a poll reads. */
  private observeRunning(
    raw: RawSnapshot,
    nGame: RawNGameState,
    at: number,
    ctx: RawTapContext
  ): void {
    const run = this.run!
    run.lastSeenAt = Math.max(run.lastSeenAt, at)

    // ── D9: game over, with the two-poll guard (Q9) ──
    if (nGame.isGameOver) {
      this.gameOverPolls++
      if (this.gameOverPolls >= GAME_OVER_POLLS) {
        this.close(run, at)
        return
      }
    } else if (this.gameOverPolls) {
      this.gameOverPolls = 0
    }

    if (nGame.playerCount !== null) {
      this.applyPlayerCount(run, nGame.playerCount, nGame.otherCharacterIds)
    }

    // ── act ──
    if (nGame.currentActIndex !== null && nGame.currentActIndex !== this.lastAct) {
      if (this.lastAct !== null && nGame.currentActIndex > this.lastAct) {
        pushEvent(run.events, { t: at, type: 'act_change', from: this.lastAct, to: nGame.currentActIndex })
      }
      this.lastAct = nGame.currentActIndex
      run.actReached = maxOrNull(run.actReached, nGame.currentActIndex)
    }

    // ── rooms: the game's own floor is the boundary (WP1 findings retire A7) ──
    if (nGame.totalFloor !== null) {
      if (this.lastFloor === null) this.lastFloor = nGame.totalFloor
      else if (nGame.totalFloor > this.lastFloor) {
        for (let floor = this.lastFloor + 1; floor <= nGame.totalFloor; floor++) {
          this.enterRoom(run, at, floor, nGame.roomType)
        }
        this.lastFloor = nGame.totalFloor
      }
    }
    // The travel edge is kept only as a corroborator: it undercounts two
    // consecutive rooms of the same type, which is why it is no longer the
    // boundary, but a divergence between the two counters is worth knowing.
    if (this.lastTraveling && !nGame.isTraveling) this.travelRooms++
    this.lastTraveling = nGame.isTraveling

    if (raw.pile) this.observeCombat(raw.pile, raw.enemies, ctx, at)
    if (raw.pile && !raw.pile.deckPartial) this.observeDeck(run, raw.pile, at)
    this.observeOffers(run, raw.items, at)
    this.expireOffer(run, at)
    this.maybeConfirm(at)
    this.maybeHeartbeat(run, at)
  }

  private enterRoom(run: RunFile, at: number, floor: number, roomType: string | null): void {
    run.roomsEntered++
    this.floorRooms++
    run.floorReached = maxOrNull(run.floorReached, floor)
    pushEvent(run.events, {
      t: at,
      type: 'room_enter',
      roomType,
      roomIndex: run.roomsEntered,
      actIndex: this.lastAct,
      floor
    })
    // A room boundary also closes any open offer's inference window: whatever
    // the deck did before we left the room is the answer.
    this.resolveOffer(run, at, 'room-change')
    this.confirmNow(at, 'room_enter')
    this.commit(run, at, true)
    this.publishLedgerMoved()
  }

  /**
   * Per-combat draw/play tallies from per-instance addresses (journal-plan §3.1).
   * Nothing here is trusted when the deck read came back short: a truncated poll
   * that also shows the hand or draw pile shrinking is indistinguishable from a
   * turn's worth of real plays, and inventing plays is worse than missing them
   * (WP1 deviation 4).
   */
  private observeCombat(
    pile: RawPileState,
    enemies: RawSnapshot['enemies'],
    ctx: RawTapContext,
    at: number
  ): void {
    const run = this.run!
    const inProgress = enemies?.isCombatInProgress ?? false
    const side = enemies?.currentSide ?? 1

    if (inProgress && !this.combat) {
      this.combat = {
        row: {
          startT: at,
          endT: null,
          roomIndex: run.roomsEntered,
          enemies: enemies ? enemies.enemies.length : null,
          plays: [],
          drawn: []
        },
        loc: new Map(),
        drawn: new Map(),
        plays: new Map(),
        sideChangedSeq: null,
        lastHand: pile.hand.length,
        lastDraw: pile.draw.length,
        startedMono: this.mono(),
        lastFlushMono: this.mono()
      }
      pushEvent(run.events, {
        t: at,
        type: 'combat_start',
        roomIndex: run.roomsEntered,
        enemies: this.combat.row.enemies
      })
      run.snapshot.openCombat = this.combat.row
      this.inCombat = true
      this.commit(run, at)
      return
    }
    if (!inProgress && this.combat) {
      this.closeCombat(run, at, false)
      this.inCombat = false
      return
    }
    if (!inProgress || !this.combat) return

    const combat = this.combat
    if (side !== 1) combat.sideChangedSeq = ctx.seq
    const shrank = pile.hand.length < combat.lastHand || pile.draw.length < combat.lastDraw
    const suspect = pile.deckPartial && shrank
    combat.lastHand = pile.hand.length
    combat.lastDraw = pile.draw.length
    if (suspect) {
      this.onIssue('journal_combat_tick_discarded', 'debug', {
        hand: pile.hand.length,
        draw: pile.draw.length
      })
      return
    }

    const seen = new Map<string, { where: 'hand' | 'pile'; id: string }>()
    for (const card of pile.hand) seen.set(addr(card), { where: 'hand', id: card.id })
    for (const card of [...pile.draw, ...pile.discard, ...pile.exhaust]) {
      if (!seen.has(addr(card))) seen.set(addr(card), { where: 'pile', id: card.id })
    }

    // Drawn: an instance seen in hand for the first time this combat.
    for (const [key, now] of seen) {
      if (now.where !== 'hand') continue
      const before = combat.loc.get(key)
      if (before?.where === 'hand') continue
      bump(combat.drawn, now.id)
    }
    // Played: it was in hand on the player's turn and is no longer — either in a
    // pile (a normal play) or gone entirely (powers leave play). Bulk discards
    // ride just behind a turn change, so those polls are not counted.
    const bulkDiscard = combat.sideChangedSeq !== null && ctx.seq - combat.sideChangedSeq <= 2
    for (const [key, before] of combat.loc) {
      if (before.where !== 'hand') continue
      const now = seen.get(key)
      if (now?.where === 'hand') continue
      if (side !== 1 || bulkDiscard) continue
      bump(combat.plays, before.id)
    }
    combat.loc = seen
  }

  private closeCombat(run: RunFile, at: number, aborted: boolean): void {
    const combat = this.combat
    if (!combat) return
    this.combat = null
    combat.row.endT = at
    combat.row.plays = rows(combat.plays)
    combat.row.drawn = rows(combat.drawn)
    if (aborted) combat.row.aborted = true
    run.combats.push(combat.row)
    run.snapshot.openCombat = null
    pushEvent(run.events, {
      t: at,
      type: 'combat_end',
      durationMs: at - combat.row.startT,
      enemies: combat.row.enemies,
      roomIndex: combat.row.roomIndex,
      aborted
    })
    this.commit(run, at, true)
  }

  /** Deck deltas — the backbone of pick inference and of the ledger. */
  private observeDeck(run: RunFile, pile: RawPileState, at: number): void {
    const deck = deckMultiset(pile.deck)
    const before = this.lastDeck
    if (!before) {
      this.lastDeck = deck
      return
    }
    if (before.length === deck.length && before.every((c, i) => c === deck[i])) return
    const { added, removed } = deckDelta(before, deck)
    this.lastDeck = deck

    // An upgrade reads as one copy leaving and a higher copy of the same id
    // arriving. Pairing them keeps the ledger honest — three campfire upgrades
    // are not six deck changes.
    const pendingRemoved = [...removed]
    const offer = run.snapshot.openOffer
    for (const card of added) {
      const id = cardBaseId(card)
      const level = cardUpgradeLevel(card)
      const priorIndex = pendingRemoved.findIndex(
        (r) => cardBaseId(r) === id && cardUpgradeLevel(r) < level
      )
      if (priorIndex !== -1) {
        const [prior] = pendingRemoved.splice(priorIndex, 1)
        pushEvent(run.events, {
          t: at,
          type: 'deck_upgrade',
          id,
          upgradeLevel: level,
          from: cardUpgradeLevel(prior!)
        })
        continue
      }
      const fromOffer = offer && offer.offered.includes(id) ? offer.eid : undefined
      pushEvent(run.events, {
        t: at,
        type: 'deck_add',
        id,
        upgradeLevel: level,
        ...(fromOffer === undefined ? {} : { offerEid: fromOffer })
      })
      if (fromOffer !== undefined) this.resolveOffer(run, at, 'picked', id)
    }
    for (const card of pendingRemoved) {
      pushEvent(run.events, {
        t: at,
        type: 'deck_remove',
        id: cardBaseId(card),
        upgradeLevel: cardUpgradeLevel(card)
      })
    }
    // A deck mutation is the strongest possible confirmation that this run is
    // the one being played: no other run could have produced it.
    this.confirmNow(at, 'deck-mutation')
    this.commit(run, at)
    this.publishLedgerMoved()
  }

  /**
   * Offers. Ids and prices only exist on the raw items — the emitted layout
   * state carries a display name and geometry (audit A1) — and the same
   * stability debounce the provider uses keeps a mid-transition flicker from
   * opening a phantom offer.
   */
  private observeOffers(run: RunFile, items: RawVisibleItems | null, at: number): void {
    if (!items || !ADDITIVE_SOURCES.has(items.source)) {
      this.offerKey = ''
      this.offerStreak = 0
      return
    }
    const offered = items.items.filter((i) => i.kind === 'card' && i.id).map((i) => i.id as string)
    if (offered.length < 1) {
      this.offerKey = ''
      this.offerStreak = 0
      return
    }
    const key = `${items.source}|${[...offered].sort().join(',')}`
    if (key === this.offerKey) this.offerStreak++
    else {
      this.offerKey = key
      this.offerStreak = 1
    }
    if (this.offerStreak !== OFFER_STABLE_POLLS) return
    if (run.snapshot.openOffer && run.snapshot.openOffer.source === items.source) return

    const eid = run.events.length
    const costs: Record<string, number> = {}
    for (const item of items.items) {
      if (item.id && item.cost !== undefined) costs[item.id] = item.cost
    }
    pushEvent(run.events, {
      t: at,
      type: 'offer_shown',
      eid,
      source: items.source,
      offered,
      costs,
      deckBefore: [...(this.lastDeck ?? run.snapshot.deck)]
    })
    const open: RunOpenOffer = {
      eid,
      source: items.source,
      offered,
      shownAt: at,
      deadlineAt: at + this.pickDeadlineMs
    }
    run.snapshot.openOffer = open
    this.commit(run, at)
  }

  /** The deadline half of pick inference: silence past it is a skip. */
  private expireOffer(run: RunFile, at: number): void {
    const offer = run.snapshot.openOffer
    if (!offer) return
    // The window only starts once the offer is off screen; while the panels are
    // still up, the player has not decided yet.
    if (this.offerStreak > 0 && this.offerKey.startsWith(`${offer.source}|`)) {
      offer.deadlineAt = at + this.pickDeadlineMs
      return
    }
    if (at < offer.deadlineAt) return
    this.resolveOffer(run, at, 'deadline')
  }

  private resolveOffer(run: RunFile, at: number, reason: string, picked?: string): void {
    const offer = run.snapshot.openOffer
    if (!offer) return
    run.snapshot.openOffer = null
    pushEvent(run.events, {
      t: at,
      type: 'offer_resolved',
      eid: offer.eid,
      picked: picked ?? null,
      reason
    })
    this.commit(run, at)
    this.publishLedgerMoved()
  }

  // ── deferred supersession (audit A5) ───────────────────────────────────────

  private holdSupersession(ids: readonly string[]): void {
    this.pendingSupersede = ids.filter((id) => id !== this.run?.id)
    this.confirmDeadlineMono = this.mono() + this.confirmMs
    if (!this.pendingSupersede.length) return
    this.dbg(`holding supersession of ${this.pendingSupersede.join(', ')} until confirmed`)
  }

  private maybeConfirm(at: number): void {
    if (!this.pendingSupersede.length) return
    if (this.mono() < this.confirmDeadlineMono) return
    this.confirmNow(at, 'dwell')
  }

  /**
   * Apply the held sweep. The trigger is evidence that this run is real — a
   * deck mutation, a room boundary, or a minute of continuous recording — never
   * the sighting itself, so a torn read cannot retire a live run.
   */
  private confirmNow(at: number, trigger: string): void {
    const ids = this.pendingSupersede
    if (!ids.length) return
    this.pendingSupersede = []
    const by = this.run?.id ?? null
    if (!by) return
    void (async (): Promise<void> => {
      for (const id of ids) {
        const loser = await this.store.getRun(id)
        if (!loser || loser.state === 'closed' || loser.state === 'abandoned') continue
        loser.state = 'abandoned'
        loser.outcome = 'superseded'
        loser.supersededBy = by
        loser.endedAt = at
        pushEvent(loser.events, { t: at, type: 'superseded', by })
        refreshSnapshot(loser, at)
        this.store.save(loser, { immediate: true })
        this.onEvent('journal_superseded', { id, by, trigger })
      }
      this.publishCatalog()
    })()
  }

  // ── suspension & close ─────────────────────────────────────────────────────

  private suspend(reason: SessionEndReason): void {
    const run = this.run
    const session = this.session
    if (!run || !session) return
    const at = this.now()
    this.closeCombatOnSuspend(run, at)
    const row = run.sessions.find((s) => s.sid === session.sid)
    if (row) {
      row.detachedAt = at
      row.reason = reason
      row.activeMs += Math.max(0, Math.round(this.mono() - session.startedMono))
      row.playerCount = session.playerCount
      row.otherCharacterIds = [...session.otherCharacterIds]
    }
    pushEvent(run.events, { t: at, type: 'session_detach', sid: session.sid, reason })
    run.state = 'suspended'
    run.lastSeenAt = Math.max(run.lastSeenAt, at)
    this.commit(run, at, true)
    this.dbg(`suspended ${run.id} (${reason})`)
    this.onEvent('journal_suspend', { reason, rooms: run.roomsEntered, act: run.actReached })
    // After the file is already `suspended` on disk, for the same reason the
    // close path defers its callback: the listener reads the run back through
    // the store and must never see a half-detached file.
    this.onRunSuspendedCb?.(run.id, reason)
    this.run = null
    this.session = null
    this.pending = null
    this.pendingPolls = 0
    this.pendingSupersede = []
    this.inCombat = false
    this.publishCatalog()
  }

  private closeCombatOnSuspend(run: RunFile, at: number): void {
    if (this.combat) this.closeCombat(run, at, true)
  }

  /** Terminal. A closed run never re-enters matching. */
  private close(run: RunFile, at: number): void {
    this.closeCombatOnSuspend(run, at)
    this.resolveOffer(run, at, 'run-ended')
    const session = this.session
    if (session) {
      const row = run.sessions.find((s) => s.sid === session.sid)
      if (row) {
        row.detachedAt = at
        // The run concluding is not the process going away — a death on screen
        // recorded as 'process-gone' was a statement about the wrong thing.
        row.reason = 'run-ended'
        row.activeMs += Math.max(0, Math.round(this.mono() - session.startedMono))
      }
    }
    // Honest until the game-over screen variant reader lands: the overlay scan
    // says a run ended, not how.
    pushEvent(run.events, { t: at, type: 'game_over', result: 'ended' })
    run.state = 'closed'
    run.outcome = 'ended'
    run.endedAt = at
    run.lastSeenAt = Math.max(run.lastSeenAt, at)
    run.finalDeck = groupDeck(run.snapshot.deck)
    run.analysisStatus = 'pending'
    // Aborted combats are excluded: the game restarts an interrupted combat from
    // its start, so counting both halves would double every card in it (Q8).
    const agg = aggregateCombats(run.combats)
    run.snapshot.combatAgg = agg
    run.pace = {
      elapsedMs: run.sessions.reduce((sum, s) => sum + (s.activeMs || 0), 0),
      roomsEntered: run.roomsEntered,
      perRoomAvgMs: run.roomsEntered
        ? Math.round(run.sessions.reduce((sum, s) => sum + (s.activeMs || 0), 0) / run.roomsEntered)
        : null
    }
    this.commit(run, at, true)
    this.onEvent('journal_closed', {
      rooms: run.roomsEntered,
      act: run.actReached,
      floor: run.floorReached,
      deck_size: run.snapshot.deckSize,
      cohort: runCohort(run.playerCount),
      sessions: run.sessions.length,
      // The A7 corroborator, reported so the room rule can be corrected from the
      // field rather than from an argument.
      rooms_by_floor: this.floorRooms,
      rooms_by_travel: this.travelRooms
    })
    this.lastClose = {
      id: run.id,
      character: run.character,
      deckHash: run.snapshot.deckHash,
      at
    }
    this.closeReported = false
    this.pending = null
    this.pendingPolls = 0
    this.run = null
    this.session = null
    this.pendingSupersede = []
    this.inCombat = false
    this.publishCatalog()
    // Last, and after the file is already `pending` on disk: the pipeline reads
    // the run back through the store, so it must never see a half-closed file.
    this.onRunClosedCb?.(run.id)
  }

  // ── the ambiguity banner ───────────────────────────────────────────────────

  /**
   * The user's answer. `'fresh'` just clears the flag and the provisional run
   * stands on its own. `'resumed'` merges it into the candidate — events,
   * sessions and combats fold in, the candidate takes the provisional's current
   * state, and the provisional file is removed, because after a merge it holds
   * nothing the candidate does not.
   */
  async resolveAmbiguity(
    id: string,
    resolution: AmbiguityResolution
  ): Promise<{ id: string; merged: boolean }> {
    const provisional = await this.store.getRun(id)
    if (!provisional || !provisional.ambiguity) {
      throw new Error(`no unresolved ambiguity on ${id}`)
    }
    const at = this.now()
    const candidateId = provisional.ambiguity.candidateId
    provisional.ambiguity = { ...provisional.ambiguity, resolution, resolvedAt: at }
    pushEvent(provisional.events, { t: at, type: 'ambiguity_resolved', candidateId, resolution })

    if (resolution === 'fresh') {
      refreshSnapshot(provisional, at)
      this.store.save(provisional, { immediate: true })
      await this.store.flush()
      this.publishCatalog()
      this.onEvent('journal_ambiguity_resolved', { resolution, merged: false })
      return { id: provisional.id, merged: false }
    }

    const candidate = await this.store.getRun(candidateId)
    if (!candidate) {
      // The run we could not rule out is gone. The provisional was always the
      // safe answer; leave it standing rather than failing the user's click.
      this.onIssue('journal_merge_candidate_missing', 'warn', { id, candidateId })
      refreshSnapshot(provisional, at)
      this.store.save(provisional, { immediate: true })
      this.publishCatalog()
      return { id: provisional.id, merged: false }
    }

    mergeRunInto(candidate, provisional, at)
    refreshSnapshot(candidate, at)
    this.store.save(candidate, { immediate: true })
    // The live recorder may be writing into the provisional right now; move it
    // over before the file disappears under it.
    if (this.run?.id === provisional.id) {
      this.run = candidate
      const live = candidate.sessions[candidate.sessions.length - 1]
      if (live && this.session) this.session = { ...this.session, sid: live.sid }
    }
    await this.store.flush()
    await this.store.delete(provisional.id)
    this.publishCatalog()
    this.publishCurrentRun()
    this.onEvent('journal_ambiguity_resolved', { resolution, merged: true })
    return { id: candidate.id, merged: true }
  }

  // ── publishing ─────────────────────────────────────────────────────────────

  /** The live keyed snapshot. Deduplicated: the poll rate is not a push rate. */
  private publishCurrentRun(): void {
    if (!this.onCurrentRunCb) return
    const value = this.currentRun()
    const json = JSON.stringify(value)
    if (json === this.lastPublished) return
    this.lastPublished = json
    this.onCurrentRunCb(value)
  }

  /**
   * Liveness, and nothing else.
   *
   * Everything the Current Run view prints about the run — character, act,
   * rooms, deck, and above all the route with its pickups — is read from the
   * run *file* by `runId` and folded by the renderer's one derivation. This
   * publishes only what a file cannot say: which run is live, how long we have
   * been watching it, and whether a fight is on screen right now.
   */
  currentRun(): JournalCurrentRun | null {
    const run = this.run
    if (!run) return null
    const activeMs =
      run.sessions.reduce((sum, s) => sum + (s.activeMs || 0), 0) +
      (this.session ? Math.max(0, Math.round(this.mono() - this.session.startedMono)) : 0)
    return {
      runId: run.id,
      elapsedActiveMs: activeMs,
      lastSeenAt: run.lastSeenAt,
      inCombat: this.inCombat
    }
  }

  private publishCatalog(): void {
    this.onCatalogCb?.(this.store.list())
  }

  /**
   * "The run file just gained something a reader can see."
   *
   * Every catalog row carries `lastSeenAt`, and the renderer's push handler
   * already refetches any run file it is holding whose row advanced — so the
   * live Route Ledger needs no channel of its own, only a reason to be told.
   * This is that reason, throttled to `LEDGER_PUBLISH_MS` with a trailing edge
   * so the last change in a burst is never the one that goes unannounced.
   *
   * Called from the boundaries where the ledger's *rendered* content changes —
   * a room, an offer resolving, a deck delta — and nowhere else. Combat tallies
   * and pace do not move a row and do not push.
   */
  private publishLedgerMoved(): void {
    if (this.ledgerTimer) return
    const since = this.mono() - this.lastLedgerPublishMono
    if (since >= LEDGER_PUBLISH_MS) {
      this.lastLedgerPublishMono = this.mono()
      this.publishCatalog()
      return
    }
    this.ledgerTimer = setTimeout(() => {
      this.ledgerTimer = null
      this.lastLedgerPublishMono = this.mono()
      this.publishCatalog()
    }, LEDGER_PUBLISH_MS - since)
    // Never hold the process open for a freshness hint.
    ;(this.ledgerTimer as unknown as { unref?: () => void }).unref?.()
  }

  // ── small internals ────────────────────────────────────────────────────────

  /** Refresh the snapshot and hand the file to the store. */
  private commit(run: RunFile, at: number, immediate = false): void {
    if (run.events.length > MAX_EVENTS) this.truncate(run)
    refreshSnapshot(run, at, this.lastDeck ?? undefined, this.lastAct, this.lastFloor)
    this.store.save(run, { immediate: immediate && !this.quitting })
  }

  /**
   * A runaway event count is a loop, not a run. Keep the tail (which is what a
   * recovery fold needs), keep the snapshot (which is the present), and say so
   * in the file rather than silently dropping history.
   */
  private truncate(run: RunFile): void {
    const dropped = run.events.length - KEEP_EVENTS
    run.events = run.events.slice(-KEEP_EVENTS)
    run.truncatedEvents = true
    run.snapshot.eventCount = Math.max(0, run.snapshot.eventCount - dropped)
    this.onIssue('journal_events_truncated', 'warn', { id: run.id, dropped })
  }

  private maybeHeartbeat(run: RunFile, at: number): void {
    const combat = this.combat
    if (!combat) return
    const nowMono = this.mono()
    if (nowMono - combat.lastFlushMono < this.heartbeatMs) return
    combat.lastFlushMono = nowMono
    this.commit(run, at, true)
  }

  private applyPlayerCount(run: RunFile, count: number | null, others: string[]): void {
    if (this.session && count !== null) {
      this.session.playerCount = count
      for (const id of others) {
        const norm = normalizeCharacter(id)
        if (norm && !this.session.otherCharacterIds.includes(norm)) {
          this.session.otherCharacterIds.push(norm)
        }
      }
      const row = run.sessions.find((s) => s.sid === this.session!.sid)
      if (row) {
        row.playerCount = count
        row.otherCharacterIds = [...this.session.otherCharacterIds]
      }
    }
    if (count === null) return
    // Run level is the max over sessions: a run that was ever multiplayer is a
    // multiplayer run, and belongs in that cohort's averages for good.
    run.playerCount = run.playerCount === null ? count : Math.max(run.playerCount, count)
  }

  private abortOpenCombat(run: RunFile, at: number): void {
    const open = run.snapshot.openCombat
    if (!open) return
    open.endT = open.endT ?? at
    open.aborted = true
    run.combats.push(open)
    run.snapshot.openCombat = null
    pushEvent(run.events, { t: at, type: 'combat_end', durationMs: at - open.startT, aborted: true })
  }

  private dbg(message: string): void {
    if (this.debug) console.log(`[journal] ${message}`)
  }

  /** Exposed for the self-check and for diagnostics; never for control flow. */
  get activeRunId(): string | null {
    return this.run?.id ?? null
  }

  get mode(): 'sp' | 'mp' {
    return runMode(this.run?.playerCount ?? null)
  }
}

// ── pure helpers (exported for the self-check) ───────────────────────────────

function defaultMonotonic(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

function addr(card: RawCard): string {
  return String(card.baseAddress)
}

function bump(map: Map<string, number>, id: string): void {
  map.set(id, (map.get(id) ?? 0) + 1)
}

function rows(map: Map<string, number>): DeckCountRow[] {
  return [...map.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count)
}

function maxOrNull(current: number | null, next: number): number {
  return current === null ? next : Math.max(current, next)
}

export function cardBaseId(card: string): string {
  const hash = card.lastIndexOf('#')
  return hash === -1 ? card : card.slice(0, hash)
}

export function cardUpgradeLevel(card: string): number {
  const hash = card.lastIndexOf('#')
  if (hash === -1) return 0
  const n = Number(card.slice(hash + 1))
  return Number.isFinite(n) ? n : 0
}

/** The grouped multiset the run file stores as its final deck. */
export function groupDeck(deck: readonly string[]): DeckGroupRow[] {
  const counts = new Map<string, number>()
  for (const card of deck) counts.set(card, (counts.get(card) ?? 0) + 1)
  return [...counts.entries()]
    .map(([card, count]) => ({ id: cardBaseId(card), upgradeLevel: cardUpgradeLevel(card), count }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.upgradeLevel - b.upgradeLevel)
}

/** Run totals across combats, excluding the aborted ones (Q8). */
export function aggregateCombats(combats: readonly RunCombat[]): {
  plays: Record<string, number>
  drawn: Record<string, number>
} {
  const plays: Record<string, number> = {}
  const drawn: Record<string, number> = {}
  for (const combat of combats) {
    if (combat.aborted) continue
    for (const row of combat.plays) plays[row.id] = (plays[row.id] ?? 0) + row.count
    for (const row of combat.drawn) drawn[row.id] = (drawn[row.id] ?? 0) + row.count
  }
  return { plays, drawn }
}

/**
 * Bring the embedded snapshot up to date. The snapshot is what the catalog, the
 * matcher and the Current Run header read — none of them ever folds the log —
 * so it is refreshed on every commit rather than on a schedule.
 */
export function refreshSnapshot(
  run: RunFile,
  at: number,
  deck?: readonly string[],
  act?: number | null,
  floor?: number | null
): void {
  const cards = deck ? [...deck].sort() : run.snapshot.deck
  run.snapshot = {
    ...run.snapshot,
    at,
    act: act === undefined ? run.snapshot.act : act,
    roomIndex: run.roomsEntered,
    deck: cards,
    deckHash: deckHashOf(cards),
    deckSize: cards.length,
    eventCount: run.events.length,
    paceActiveMs: run.sessions.reduce((sum, s) => sum + (s.activeMs || 0), 0)
  }
  if (act !== undefined && act !== null) run.actReached = maxOrNull(run.actReached, act)
  if (floor !== undefined && floor !== null) run.floorReached = maxOrNull(run.floorReached, floor)
  run.signature = {
    ...run.signature,
    deckHash: run.snapshot.deckHash,
    core: coreOf(cards)
  }
  run.pace = {
    ...run.pace,
    elapsedMs: run.snapshot.paceActiveMs,
    roomsEntered: run.roomsEntered,
    perRoomAvgMs: run.roomsEntered
      ? Math.round(run.snapshot.paceActiveMs / run.roomsEntered)
      : null
  }
}

/**
 * The group label's raw material: the ids a deck holds few copies of. Without a
 * rarity table in the main process, "not one of the four most numerous ids" is
 * the honest approximation of "not a basic card".
 */
function coreOf(deck: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const card of deck) {
    const id = cardBaseId(card)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .filter(([, count]) => count <= 2)
    .slice(0, 4)
    .map(([id]) => id)
}

/**
 * The crash-recovery fold: apply the events the snapshot had not absorbed. This
 * is the whole reason the snapshot carries `eventCount` — the alternative is
 * replaying a full log to answer "where was this run", which the design refuses
 * to do anywhere.
 */
export function foldTrailingEvents(run: RunFile): void {
  const trailing = run.events.slice(run.snapshot.eventCount)
  if (!trailing.length) {
    run.snapshot.eventCount = run.events.length
    return
  }
  const deck = [...run.snapshot.deck]
  let act = run.snapshot.act
  let roomIndex = run.snapshot.roomIndex
  let roomType = run.snapshot.roomType
  for (const event of trailing) {
    const e = event as RunEvent & Record<string, unknown>
    switch (e.type) {
      case 'room_enter':
        roomIndex = typeof e['roomIndex'] === 'number' ? e['roomIndex'] : roomIndex + 1
        roomType = typeof e['roomType'] === 'string' ? e['roomType'] : null
        break
      case 'act_change':
        if (typeof e['to'] === 'number') act = e['to']
        break
      case 'deck_add':
        if (typeof e['id'] === 'string') {
          deck.push(`${e['id']}#${typeof e['upgradeLevel'] === 'number' ? e['upgradeLevel'] : 0}`)
        }
        break
      case 'deck_remove': {
        if (typeof e['id'] !== 'string') break
        const key = `${e['id']}#${typeof e['upgradeLevel'] === 'number' ? e['upgradeLevel'] : 0}`
        const index = deck.indexOf(key)
        if (index !== -1) deck.splice(index, 1)
        break
      }
      case 'deck_upgrade': {
        if (typeof e['id'] !== 'string') break
        const to = typeof e['upgradeLevel'] === 'number' ? e['upgradeLevel'] : 0
        const from = typeof e['from'] === 'number' ? e['from'] : to - 1
        const index = deck.indexOf(`${e['id']}#${from}`)
        if (index !== -1) deck.splice(index, 1)
        deck.push(`${e['id']}#${to}`)
        break
      }
    }
  }
  deck.sort()
  run.roomsEntered = Math.max(run.roomsEntered, roomIndex)
  run.snapshot = {
    ...run.snapshot,
    act,
    roomIndex,
    roomType,
    deck,
    deckHash: deckHashOf(deck),
    deckSize: deck.length,
    eventCount: run.events.length
  }
  run.actReached = act === null ? run.actReached : maxOrNull(run.actReached, act)
}

/**
 * Fold a provisional run into the candidate the user says it was. Events merge
 * in timestamp order (they are wall-clock stamped, so the two logs interleave
 * correctly), sessions are re-numbered, and the later of the two snapshots
 * wins — which is the provisional's, because it is the one that was live.
 */
export function mergeRunInto(candidate: RunFile, provisional: RunFile, at: number): void {
  const baseSid = candidate.sessions.reduce((max, s) => Math.max(max, s.sid), 0)
  const remap = new Map<number, number>()
  for (const session of provisional.sessions) {
    const sid = baseSid + session.sid
    remap.set(session.sid, sid)
    candidate.sessions.push({ ...session, sid })
  }
  for (const event of provisional.events) {
    const e = event as RunEvent & { sid?: number }
    pushEvent(
      candidate.events,
      typeof e.sid === 'number' ? { ...e, sid: remap.get(e.sid) ?? e.sid } : { ...e }
    )
  }
  candidate.events.sort((a, b) => a.t - b.t)
  pushEvent(candidate.events, { t: at, type: 'merged_from', id: provisional.id })
  candidate.combats.push(...provisional.combats)

  candidate.state = provisional.state
  candidate.outcome = provisional.outcome ?? candidate.outcome
  candidate.endedAt = provisional.endedAt ?? candidate.endedAt
  candidate.lastSeenAt = Math.max(candidate.lastSeenAt, provisional.lastSeenAt)
  candidate.roomsEntered += provisional.roomsEntered
  candidate.actReached =
    provisional.actReached === null
      ? candidate.actReached
      : maxOrNull(candidate.actReached, provisional.actReached)
  candidate.floorReached =
    provisional.floorReached === null
      ? candidate.floorReached
      : maxOrNull(candidate.floorReached, provisional.floorReached)
  candidate.playerCount =
    provisional.playerCount === null
      ? candidate.playerCount
      : maxOrNull(candidate.playerCount, provisional.playerCount)
  candidate.runStartTime = candidate.runStartTime ?? provisional.runStartTime
  candidate.gameVersion = provisional.gameVersion ?? candidate.gameVersion
  // A merge is a hole by construction: two observations of one run, joined on
  // the user's word rather than on evidence.
  candidate.countsArePartial = true
  candidate.ambiguity = null
  candidate.snapshot = {
    ...provisional.snapshot,
    roomIndex: candidate.roomsEntered,
    eventCount: candidate.events.length
  }
}
