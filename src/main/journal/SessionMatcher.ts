import { createHash } from 'crypto'
import {
  runMode,
  type GapReason,
  type ObservedFrom,
  type RunLifecycleState,
  type RunMode
} from '@shared/journal'

/**
 * "Is this the same run I was watching yesterday?" — answered from content, in
 * pure functions, with no I/O and no clock.
 *
 * The whole design rests on three facts, in descending order of strength:
 *
 *   1. **The game names its own run.** `RunManager._startTime` (WP1's Q2 answer)
 *      is written into the save, so a resumed run reports the same value it
 *      reported before the quit. When both sides have it, matching is a lookup
 *      and the deck is not consulted at all — and, just as usefully, two runs
 *      with *different* start times are provably different runs, which is what
 *      collapses the ambiguity window to almost nothing.
 *   2. **Content is identity.** The owned deck (id + upgrade level, as a
 *      multiset) is readable on the first poll of any run and is byte-identical
 *      across a suspend/resume pair. Where the start time is missing — old
 *      files, a failed read — the deck still proves it.
 *   3. **The game keeps one live save per mode.** Not per character: StS2 writes
 *      one `current_run.save` and one `current_run_mp.save`, so starting any new
 *      solo run invalidates the previous solo run whatever character it used.
 *      Supersession therefore sweeps per mode.
 *
 * Two rules keep every automatic transition non-destructive (audit A5). The
 * matcher never demotes anything itself — it *proposes* a sweep that the
 * recorder applies only once the new run is confirmed — and a deck that has
 * gone backwards is read as a restored save, never as a stranger.
 *
 * And one rule comes from the user rather than the evidence: inside the
 * genuinely ambiguous window — no start-time evidence, two runs that have not
 * yet made a distinguishing choice — this returns `ambiguous` instead of
 * guessing. The recorder then opens a *new provisional* file (nothing is ever
 * recorded into the wrong run) and the Journal asks.
 */

// ── the fingerprint ──────────────────────────────────────────────────────────

/** What one stable sighting looks like, before it becomes a fingerprint. */
export interface SightingInput {
  character: string | null
  /** Null while `RunState` is absent; a null act never mints a fingerprint. */
  act: number | null
  /** `"<ID>#<upgradeLevel>"` entries, any order. */
  deck: string[]
  /** The deck list's own `_size`. Mismatch with `deck.length` ⇒ torn read. */
  deckSize: number | null
  deckPartial: boolean
  playerCount: number | null
  /** `RunManager._startTime`, unix seconds. */
  runStartTime: number | null
  totalFloor: number | null
}

export interface RunFingerprint {
  character: string
  /** Non-null by construction — see `buildFingerprint`. */
  act: number
  /** Sorted `"<ID>#<upgradeLevel>"` multiset. */
  deck: string[]
  deckHash: string
  deckSize: number
  playerCount: number | null
  runStartTime: number | null
  totalFloor: number | null
  mode: RunMode
}

/**
 * The candidate shape the matcher needs. `CatalogEntry` satisfies it, which is
 * the point: matching reads the catalog and opens no run file (audit A6).
 */
export interface MatchCandidate {
  id: string
  character: string
  actReached: number | null
  deck: string[] | null
  deckHash: string
  deckSize: number
  runStartTime: number | null
  playerCount: number | null
  lastSeenAt: number
  fileMtimeMs: number
  state: RunLifecycleState
}

/** `"<ID>#<upgradeLevel>"` — the one place the fingerprint's card key lives. */
export function deckCardKey(id: string, upgradeLevel: number): string {
  return `${id}#${upgradeLevel}`
}

/** Sorted multiset from raw cards. Order-independent by construction. */
export function deckMultiset(
  cards: ReadonlyArray<{ id: string; upgradeLevel: number }>
): string[] {
  return cards.map((c) => deckCardKey(c.id, c.upgradeLevel)).sort()
}

/** SHA-1 over the sorted multiset, exactly as journal-plan §2.4 specifies. */
export function deckHashOf(deck: readonly string[]): string {
  if (!deck.length) return ''
  return createHash('sha1').update(deck.join(',')).digest('hex')
}

/**
 * A fingerprint, or null when this poll must not be trusted as identity.
 *
 * The refusals are the audit's A3 and A4 made concrete: a torn deck read is a
 * short list of *real* cards that hashes to a plausible wrong value, and a null
 * act is "we do not know", which must never be compared against a real act 1.
 */
export function buildFingerprint(input: SightingInput): RunFingerprint | null {
  const character = normalizeCharacter(input.character ?? '')
  if (!character) return null
  if (input.act === null || !Number.isFinite(input.act)) return null
  if (input.deckPartial) return null
  if (input.deckSize === null) return null
  if (input.deck.length !== input.deckSize) return null
  if (!input.deck.length) return null
  const deck = [...input.deck].sort()
  return {
    character,
    act: input.act,
    deck,
    deckHash: deckHashOf(deck),
    deckSize: deck.length,
    playerCount: input.playerCount,
    runStartTime: input.runStartTime,
    totalFloor: input.totalFloor,
    mode: runMode(input.playerCount)
  }
}

/** Upper-case, trimmed — matching and grouping are never case-sensitive. */
export function normalizeCharacter(character: string): string {
  return character.trim().toUpperCase()
}

/** True when two fingerprints describe the same observation. */
export function sameFingerprint(a: RunFingerprint | null, b: RunFingerprint | null): boolean {
  if (!a || !b) return false
  return (
    a.character === b.character &&
    a.act === b.act &&
    a.deckHash === b.deckHash &&
    a.deckSize === b.deckSize &&
    a.runStartTime === b.runStartTime
  )
}

// ── predicates ───────────────────────────────────────────────────────────────

/**
 * How a sighting relates to one candidate. `EXACT` is the identity proof;
 * `REGRESSED` is a restored save; `DIVERGED` is everything the others refused.
 */
export type MatchRelation = 'EXACT' | 'EVOLVED' | 'REGRESSED' | 'DIVERGED'

/** A deck this small, this shallow and this repetitive could be a fresh run. */
const STARTER_MAX_CARDS = 12
/**
 * Starter decks are four or five distinct cards. Reliquary has no basic-id
 * vocabulary in the main process (the codex catalogs are async and optional),
 * so distinctness stands in for the plan's "≥80 % basic ids" test. It errs
 * toward *not* calling a deck starter-shaped, and the cost of that error is a
 * new file rather than a wrong merge.
 */
const STARTER_MAX_DISTINCT = 6

export function isStarterShaped(deck: readonly string[], act: number | null): boolean {
  if (act !== 0) return false
  if (!deck.length || deck.length > STARTER_MAX_CARDS) return false
  return new Set(deck.map(baseId)).size <= STARTER_MAX_DISTINCT
}

/** Removals are rare — a few per run — so the budget is small and absolute. */
function removalTolerance(candidateSize: number): number {
  return Math.max(2, Math.ceil(0.15 * candidateSize))
}

/**
 * Relation of a fingerprint to a candidate's stored multiset.
 *
 * The predicates run over **base ids** rather than `"<ID>#<upg>"` (audit A2):
 * on the string form, three campfire upgrades during unobserved play read as
 * three removals plus three additions, which blows a 12-card deck's budget of
 * two and gets a live run superseded. Upgrades are then re-checked separately —
 * they may only go *up* — so a deck that lost upgrade levels is still refused.
 */
export function relate(f: RunFingerprint, candidate: MatchCandidate): MatchRelation {
  const cDeck = candidate.deck
  if (!cDeck || !cDeck.length) {
    // No multiset to compare (a terminal row, or a file from before A6). The
    // hash is all there is, and it either matches or says nothing.
    return f.deckHash && f.deckHash === candidate.deckHash ? 'EXACT' : 'DIVERGED'
  }
  if (f.deckHash === candidate.deckHash) return 'EXACT'

  const cIds = countBy(cDeck.map(baseId))
  const fIds = countBy(f.deck.map(baseId))
  const cUpg = upgradeSums(cDeck)
  const fUpg = upgradeSums(f.deck)
  const tolerance = removalTolerance(cDeck.length)

  let removed = 0
  let kept = 0
  let added = 0
  for (const [id, cCount] of cIds) {
    const fCount = fIds.get(id) ?? 0
    removed += Math.max(0, cCount - fCount)
    kept += Math.min(cCount, fCount)
  }
  for (const [id, fCount] of fIds) {
    added += Math.max(0, fCount - (cIds.get(id) ?? 0))
  }
  const retention = kept / cDeck.length

  // Upgrades only ever go up within one run. Ids the sighting holds *fewer*
  // copies of are exempt: a removal legitimately takes its upgrade level away.
  let upgradesGrew = true
  let upgradesShrank = true
  for (const [id, cCount] of cIds) {
    const fCount = fIds.get(id) ?? 0
    const c = cUpg.get(id) ?? 0
    const fSum = fUpg.get(id) ?? 0
    if (fCount >= cCount && fSum < c) upgradesGrew = false
    if (fSum > c) upgradesShrank = false
  }

  // A restored save (audit A5): the deck went backwards and nowhere else. Read
  // before DIVERGED and never allowed to supersede, because the one thing that
  // must not happen is retiring a live run over a save-scum.
  if (added === 0 && removed <= tolerance && upgradesShrank && removed + added > 0) {
    return 'REGRESSED'
  }
  if (added === 0 && upgradesShrank && f.deckHash !== candidate.deckHash && removed === 0) {
    // Same base ids and same count, strictly lower upgrade levels.
    return 'REGRESSED'
  }

  const actOk = candidate.actReached === null || f.act >= candidate.actReached
  if (actOk && removed <= tolerance && retention >= 0.75 && upgradesGrew) return 'EVOLVED'
  return 'DIVERGED'
}

// ── the decision table ───────────────────────────────────────────────────────

/**
 * Which row of §2.4 produced a verdict. `D0` is new since the plan body: WP1
 * found the game's own run key, and it outranks every content test. `D8` is not
 * an outcome — it is the ranking that picks which candidate the other rows are
 * applied against — so it is reported through `ranked`/`considered` instead.
 */
export type DecisionRow = 'D0' | 'D1' | 'D2' | 'D3' | 'D3R' | 'D4' | 'D5' | 'D6' | 'D7'

export interface MatchVerdict {
  /** `ambiguous` records into a NEW provisional file and raises the banner. */
  kind: 'resume' | 'new' | 'ambiguous'
  rule: DecisionRow
  /** The run to resume, or (for `ambiguous`) the run we could not rule out. */
  candidateId: string | null
  /** A hole to record on resume: play we missed, or a restored save. */
  gap: GapReason | null
  observedFrom: ObservedFrom
  /**
   * Runs the game has certainly invalidated, to demote **once this decision is
   * confirmed** — never at sighting time (audit A5). Same mode only, and never
   * the run being resumed or the run behind an ambiguity banner.
   */
  supersede: string[]
  /** Set when the observation contradicts the model and we want it reported. */
  anomaly: string | null
  /** Candidate ids in the order they scored, best first. */
  ranked: string[]
  considered: number
  /** One line, for the log and for a failing test's message. */
  why: string
}

export interface MatchOptions {
  /**
   * Every resumable run, any character — the supersession pool. Defaults to
   * `candidates`, which is the same-character subset and therefore sweeps less
   * than the one-save-per-mode rule allows.
   */
  sweepPool?: readonly MatchCandidate[]
}

/**
 * Apply §2.4 to one sighting. Pure: no store, no clock, no telemetry — the
 * caller decides what to do with the verdict, which is what makes every row
 * testable against a scripted sequence.
 */
export function matchSighting(
  f: RunFingerprint,
  candidates: readonly MatchCandidate[],
  opts: MatchOptions = {}
): MatchVerdict {
  const pool = opts.sweepPool ?? candidates
  const sweep = (keep: readonly string[]): string[] =>
    pool
      .filter(
        (c) =>
          (c.state === 'suspended' || c.state === 'recording') &&
          runMode(c.playerCount) === f.mode &&
          !keep.includes(c.id)
      )
      .map((c) => c.id)

  const mine = candidates.filter(
    (c) =>
      normalizeCharacter(c.character) === f.character &&
      (c.state === 'suspended' || c.state === 'recording')
  )

  // ── D0 — the game's own run key, when both sides have one ────────────────
  // An exact match resumes regardless of what the deck says: the value came out
  // of the save file, so it cannot be coincidence, and content is demoted to
  // corroboration (which the gap reason below still reports).
  if (f.runStartTime !== null) {
    const keyed = mine.find((c) => c.runStartTime === f.runStartTime)
    if (keyed) {
      const rel = relate(f, keyed)
      return {
        kind: 'resume',
        rule: 'D0',
        candidateId: keyed.id,
        gap: gapFor(rel, f, keyed),
        observedFrom: 'start',
        supersede: sweep([keyed.id]),
        anomaly: null,
        ranked: [keyed.id],
        considered: mine.length,
        why: `run start time ${f.runStartTime} matches ${keyed.id} (deck ${rel})`
      }
    }
  }

  // Candidates the run key positively rules out are not candidates at all —
  // two different start times are two different runs, whatever the decks say.
  const viable = mine.filter(
    (c) => !(f.runStartTime !== null && c.runStartTime !== null && c.runStartTime !== f.runStartTime)
  )

  const starter = isStarterShaped(f.deck, f.act)

  // ── D1 — nothing to match against ────────────────────────────────────────
  if (!viable.length) {
    return {
      kind: 'new',
      rule: 'D1',
      candidateId: null,
      gap: null,
      observedFrom: starter ? 'start' : 'mid-run',
      supersede: sweep([]),
      anomaly: null,
      ranked: [],
      considered: mine.length,
      why: mine.length
        ? 'every same-character candidate reports a different run start time'
        : 'no suspended candidate for this character'
    }
  }

  // ── D8 — rank, then apply the table to the winner ────────────────────────
  const ranked = [...viable].sort((a, b) => score(f, b) - score(f, a) || recency(b) - recency(a))
  const best = ranked[0]!
  const rankedIds = ranked.map((c) => c.id)
  const rel = relate(f, best)
  const bestStarter = isStarterShaped(best.deck ?? [], best.actReached)

  // ── D4 — the provably ambiguous window (USER DECISION: never guess) ──────
  // Two runs neither of which has yet made a distinguishing choice, and no run
  // key to separate them. The plan's own policy was to pick and accept a
  // near-zero cost; the user's answer is to record into a new provisional file
  // and ask. Nothing is lost either way — the provisional holds every event —
  // and the banner's "resuming" answer merges it back.
  const noKeyEvidence = f.runStartTime === null || best.runStartTime === null
  if (
    noKeyEvidence &&
    starter &&
    bestStarter &&
    best.actReached === f.act &&
    (rel === 'EXACT' || isSubsetByCard(best.deck ?? [], f.deck) || isSubsetByCard(f.deck, best.deck ?? []))
  ) {
    return {
      kind: 'ambiguous',
      rule: 'D4',
      candidateId: best.id,
      gap: null,
      observedFrom: 'start',
      // Deliberately empty: an unanswered question must not retire anything.
      supersede: [],
      anomaly: null,
      ranked: rankedIds,
      considered: viable.length,
      why: `indistinguishable from ${best.id} inside the pre-first-pick window`
    }
  }

  if (rel === 'EXACT') {
    // ── D7 — the deck is identical but the act went backwards ─────────────
    // Impossible for one run. Reported rather than papered over, and — unlike
    // the plan body — it supersedes nothing, because "our model is wrong" is
    // the worst possible moment to retire a file.
    if (best.actReached !== null && f.act < best.actReached) {
      return {
        kind: 'new',
        rule: 'D7',
        candidateId: null,
        gap: null,
        observedFrom: starter ? 'start' : 'mid-run',
        supersede: [],
        anomaly: 'exact-deck-act-regression',
        ranked: rankedIds,
        considered: viable.length,
        why: `deck matches ${best.id} but act ${f.act} < ${best.actReached}`
      }
    }
    // ── D2 — identity proof ────────────────────────────────────────────────
    const advanced = best.actReached !== null && f.act > best.actReached
    return {
      kind: 'resume',
      rule: 'D2',
      candidateId: best.id,
      gap: advanced ? 'unobserved-play' : null,
      observedFrom: 'start',
      supersede: sweep([best.id]),
      anomaly: null,
      ranked: rankedIds,
      considered: viable.length,
      why: `exact deck match with ${best.id}`
    }
  }

  // ── D3R — a restored save, never a stranger, never a supersession ────────
  if (rel === 'REGRESSED') {
    return {
      kind: 'resume',
      rule: 'D3R',
      candidateId: best.id,
      gap: 'save-restore',
      observedFrom: 'start',
      supersede: [],
      anomaly: null,
      ranked: rankedIds,
      considered: viable.length,
      why: `deck is a strict regression of ${best.id} — restored save`
    }
  }

  // ── D3 — play happened while we were not looking ─────────────────────────
  if (rel === 'EVOLVED') {
    return {
      kind: 'resume',
      rule: 'D3',
      candidateId: best.id,
      gap: 'unobserved-play',
      observedFrom: 'start',
      supersede: sweep([best.id]),
      anomaly: null,
      ranked: rankedIds,
      considered: viable.length,
      why: `deck evolved from ${best.id} the way a run evolves`
    }
  }

  // ── D5 — a starter deck cannot be a 20-card run that regressed ───────────
  if (starter && best.deckSize > STARTER_MAX_CARDS) {
    return {
      kind: 'new',
      rule: 'D5',
      candidateId: null,
      gap: null,
      observedFrom: 'start',
      supersede: sweep([]),
      anomaly: null,
      ranked: rankedIds,
      considered: viable.length,
      why: `starter-shaped sighting against a ${best.deckSize}-card candidate`
    }
  }

  // ── D6 — diverged: we missed both the abandonment and the new run's start ─
  return {
    kind: 'new',
    rule: 'D6',
    candidateId: null,
    gap: null,
    observedFrom: starter ? 'start' : 'mid-run',
    supersede: sweep([]),
    anomaly: null,
    ranked: rankedIds,
    considered: viable.length,
    why: `no candidate relates to this deck (best ${best.id} diverged)`
  }
}

/**
 * D8's ordering: the run key outranks everything, an exact deck outranks a
 * plausible one, and recency only ever breaks a tie. Wall-clock plays no part
 * in identity — a two-week-old suspension with an exact deck still wins.
 */
function score(f: RunFingerprint, c: MatchCandidate): number {
  if (f.runStartTime !== null && c.runStartTime === f.runStartTime) return 1000
  const rel = relate(f, c)
  if (rel === 'EXACT') return 500
  if (rel === 'REGRESSED') return 300
  if (rel === 'EVOLVED') return 100 + retentionOf(f, c) * 100
  return 0
}

function recency(c: MatchCandidate): number {
  return c.lastSeenAt || c.fileMtimeMs
}

function retentionOf(f: RunFingerprint, c: MatchCandidate): number {
  const cDeck = c.deck
  if (!cDeck?.length) return 0
  const cIds = countBy(cDeck.map(baseId))
  const fIds = countBy(f.deck.map(baseId))
  let kept = 0
  for (const [id, count] of cIds) kept += Math.min(count, fIds.get(id) ?? 0)
  return kept / cDeck.length
}

function gapFor(rel: MatchRelation, f: RunFingerprint, c: MatchCandidate): GapReason | null {
  if (rel === 'EXACT') {
    return c.actReached !== null && f.act > c.actReached ? 'unobserved-play' : null
  }
  return rel === 'REGRESSED' ? 'save-restore' : 'unobserved-play'
}

// ── multiset helpers ─────────────────────────────────────────────────────────

/** `"BASH#1"` → `"BASH"`. Ids never contain `#`. */
export function baseId(card: string): string {
  const hash = card.lastIndexOf('#')
  return hash === -1 ? card : card.slice(0, hash)
}

function upgradeLevel(card: string): number {
  const hash = card.lastIndexOf('#')
  if (hash === -1) return 0
  const n = Number(card.slice(hash + 1))
  return Number.isFinite(n) ? n : 0
}

function countBy(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

function upgradeSums(deck: readonly string[]): Map<string, number> {
  const sums = new Map<string, number>()
  for (const card of deck) {
    const id = baseId(card)
    sums.set(id, (sums.get(id) ?? 0) + upgradeLevel(card))
  }
  return sums
}

/** Multiset ⊆ over full `"<ID>#<upg>"` keys. */
export function isSubsetByCard(sub: readonly string[], sup: readonly string[]): boolean {
  const have = countBy(sup)
  for (const [card, count] of countBy(sub)) {
    if ((have.get(card) ?? 0) < count) return false
  }
  return true
}

/** Added / removed between two multisets, as flat card-key lists. */
export function deckDelta(
  before: readonly string[],
  after: readonly string[]
): { added: string[]; removed: string[] } {
  const b = countBy(before)
  const a = countBy(after)
  const added: string[] = []
  const removed: string[] = []
  for (const [card, count] of a) {
    const delta = count - (b.get(card) ?? 0)
    for (let i = 0; i < delta; i++) added.push(card)
  }
  for (const [card, count] of b) {
    const delta = count - (a.get(card) ?? 0)
    for (let i = 0; i < delta; i++) removed.push(card)
  }
  return { added: added.sort(), removed: removed.sort() }
}
