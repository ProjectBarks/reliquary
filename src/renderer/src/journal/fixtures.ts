import {
  JOURNAL_SCHEMA,
  runCohort,
  type CatalogEntry,
  type JournalCurrentRun,
  type JournalJson,
  type RunCombat,
  type RunEvent,
  type RunFile,
  type Sts2EnemiesState,
  type Sts2PileState
} from '@shared/types'
import type { JournalFixtures } from './data'

/**
 * Canned journal data for the design harness at `#/mock/journal/:view`.
 *
 * **Dev builds only.** Nothing outside `JournalMock.tsx` may import this
 * module, and `JournalMock` itself is only referenced from the
 * `import.meta.env.DEV` branch of the route tree — which the bundler statically
 * folds away, taking this file with it. `npx electron-vite build` and then
 * grepping `out/renderer` for `FEEL_NO_PAIN` is the check that it is still
 * true.
 *
 * The run below is the blend mockup's fixture, re-expressed in the *real*
 * types: a 45-room Ironclad death with the same rooms, the same picks, the same
 * two shops and the same four findings. Re-expressing it rather than inventing
 * something new is the point — the mockup was iterated four times against these
 * exact numbers, so a screenshot of this harness is directly comparable to
 * `shot-blend.png`, and any drift is a regression rather than a difference of
 * content.
 *
 * Two things about it are deliberately *not* the mockup:
 *
 *   - Floors are exact (`floor: n` on every `room_enter`), because WP1 found
 *     the game's own counter. The mockup's `≈ floor 45` hedge is gone.
 *   - The events are generated from a room script rather than written out, so
 *     the fold in `derive.ts` is exercised by the same shapes the recorder
 *     actually writes — `offer_shown` before `deck_add`, `offer_resolved` after
 *     the *next* `room_enter`, `deck_upgrade` pairing a remove with an add.
 */

// ── the room script ─────────────────────────────────────────────────────────

interface RoomSpec {
  type: 'combat' | 'event' | 'merchant' | 'other'
  enemies?: number
  /** A card offer: what was shown, at what price, and what was taken. */
  offer?: {
    source: 'cardReward' | 'merchant' | 'event'
    cards: string[]
    costs?: Record<string, number>
    pick?: string
  }
  /** Priced relics/potions on a merchant's shelf — the sightings strip's source. */
  stock?: Record<string, number>
  removed?: string
  upgraded?: string
  /** An event's unconditional deck addition (no offer behind it). */
  add?: string
  /** The act index (0-based) the run moved to after this room. */
  actAfter?: number
  gameOver?: boolean
}

const REWARD = (cards: string[], pick?: string): RoomSpec['offer'] => ({
  source: 'cardReward',
  cards,
  pick
})

/**
 * Everything in this file that is *computed* — the script, the events, the run
 * files, the catalog — is built inside a function rather than at module scope,
 * and that is a bundling requirement rather than a style: Rollup keeps any
 * module whose top level calls a function, even when nothing imports it, so a
 * `const SCRIPT = [... REWARD(...) ...]` up here would drag every card id in
 * this file into the production bundle. Literals are pure and drop; calls are
 * not and do not. `npm run build` followed by
 * `grep FEEL_NO_PAIN out/renderer` is the check.
 */
function script(): RoomSpec[] {
  return [
    { type: 'combat' },
    { type: 'combat' },
    { type: 'combat', offer: REWARD(['ANGER', 'CLEAVE', 'FLEX'], 'ANGER') },
    { type: 'event' },
    { type: 'combat', offer: REWARD(['SHRUG_IT_OFF', 'CLASH', 'THUNDERCLAP'], 'SHRUG_IT_OFF') },
    { type: 'other' },
    { type: 'combat', offer: REWARD(['POMMEL_STRIKE', 'IRON_WAVE', 'CLOTHESLINE'], 'POMMEL_STRIKE') },
    { type: 'combat', enemies: 2 },
    {
      type: 'merchant',
      offer: {
        source: 'merchant',
        cards: ['WHIRLWIND', 'SEVER_SOUL'],
        costs: { WHIRLWIND: 156, SEVER_SOUL: 142 },
        pick: 'WHIRLWIND'
      },
      removed: 'STRIKE'
    },
    { type: 'combat', offer: REWARD(['IRON_WAVE', 'HEAVY_BLADE', 'RAMPAGE']) },
    { type: 'other', upgraded: 'BASH' },
    {
      type: 'combat',
      offer: REWARD(['TWIN_STRIKE', 'FEEL_NO_PAIN', 'HEMOKINESIS'], 'TWIN_STRIKE')
    },
    { type: 'event', add: 'BLOODLETTING' },
    { type: 'other', upgraded: 'INFLAME' },
    {
      type: 'combat',
      offer: REWARD(['DEMON_FORM', 'JUGGERNAUT', 'BERSERK'], 'DEMON_FORM'),
      actAfter: 1
    },
    { type: 'combat' },
    { type: 'combat', offer: REWARD(['UPPERCUT', 'SEEING_RED', 'ENTRENCH'], 'UPPERCUT') },
    { type: 'event' },
    { type: 'combat', offer: REWARD(['CARNAGE', 'DROPKICK', 'RUPTURE'], 'CARNAGE') },
    { type: 'other' },
    { type: 'combat', offer: REWARD(['DISARM', 'BLOOD_FOR_BLOOD', 'INFERNAL_BLADE'], 'DISARM') },
    { type: 'other', upgraded: 'SHRUG_IT_OFF' },
    { type: 'combat', enemies: 2 },
    { type: 'combat', offer: REWARD(['BATTLE_TRANCE', 'FLAME_BARRIER', 'PUMMEL'], 'BATTLE_TRANCE') },
    { type: 'event', add: 'BODY_SLAM' },
    { type: 'combat' },
    {
      type: 'merchant',
      offer: { source: 'merchant', cards: ['SENTINEL'], costs: { SENTINEL: 128 } },
      stock: { ASHWATER: 48 }
    },
    {
      type: 'merchant',
      offer: { source: 'merchant', cards: ['BARRICADE'], costs: { BARRICADE: 187 } },
      stock: { BREAD: 203 }
    },
    { type: 'other', upgraded: 'POMMEL_STRIKE' },
    { type: 'combat', offer: REWARD(['OFFERING', 'REAPER', 'BLUDGEON'], 'OFFERING'), actAfter: 2 },
    { type: 'combat', offer: REWARD(['ANGER', 'WILD_STRIKE', 'HEADBUTT'], 'ANGER') },
    { type: 'combat' },
    {
      type: 'event',
      offer: { source: 'event', cards: ['IMPERVIOUS', 'LIMIT_BREAK'], pick: 'IMPERVIOUS' }
    },
    { type: 'combat', offer: REWARD(['CARNAGE', 'IMMOLATE', 'FIEND_FIRE'], 'CARNAGE') },
    { type: 'other', upgraded: 'BATTLE_TRANCE' },
    { type: 'combat', enemies: 3 },
    { type: 'combat' },
    { type: 'other' },
    { type: 'combat' },
    { type: 'event' },
    { type: 'combat' },
    { type: 'merchant', offer: { source: 'merchant', cards: ['CORRUPTION'], costs: { CORRUPTION: 214 } } },
    { type: 'combat' },
    { type: 'other' },
    { type: 'combat', gameOver: true }
  ]
}

/** The final deck, as `finalDeck` stores it: grouped by id and upgrade level. */
const FINAL_DECK = [
  { id: 'DEFEND', upgradeLevel: 0, count: 4 },
  { id: 'STRIKE', upgradeLevel: 0, count: 4 },
  { id: 'ANGER', upgradeLevel: 0, count: 2 },
  { id: 'CARNAGE', upgradeLevel: 0, count: 2 },
  { id: 'BASH', upgradeLevel: 1, count: 1 },
  { id: 'POMMEL_STRIKE', upgradeLevel: 1, count: 1 },
  { id: 'SHRUG_IT_OFF', upgradeLevel: 0, count: 1 },
  { id: 'SHRUG_IT_OFF', upgradeLevel: 1, count: 1 },
  { id: 'BATTLE_TRANCE', upgradeLevel: 1, count: 1 },
  { id: 'INFLAME', upgradeLevel: 1, count: 1 },
  { id: 'BLOODLETTING', upgradeLevel: 0, count: 1 },
  { id: 'UPPERCUT', upgradeLevel: 0, count: 1 },
  { id: 'DISARM', upgradeLevel: 0, count: 1 },
  { id: 'WHIRLWIND', upgradeLevel: 0, count: 1 },
  { id: 'OFFERING', upgradeLevel: 0, count: 1 },
  { id: 'DEMON_FORM', upgradeLevel: 0, count: 1 },
  { id: 'IMPERVIOUS', upgradeLevel: 0, count: 1 },
  { id: 'TWIN_STRIKE', upgradeLevel: 0, count: 1 },
  { id: 'BODY_SLAM', upgradeLevel: 0, count: 1 }
]

/**
 * Draw and play tallies, keyed by base id — which is how the recorder keys them
 * (`bump(combat.plays, card.id)`), upgrade level and all. `TWIN_STRIKE` and
 * `BODY_SLAM` are the never-played pair the mockup's F-04 is about.
 */
const DRAWN: Record<string, number> = {
  DEFEND: 55,
  STRIKE: 52,
  POMMEL_STRIKE: 24,
  BASH: 21,
  SHRUG_IT_OFF: 37,
  BATTLE_TRANCE: 16,
  INFLAME: 16,
  BLOODLETTING: 15,
  UPPERCUT: 15,
  ANGER: 15,
  CARNAGE: 17,
  DISARM: 11,
  WHIRLWIND: 13,
  OFFERING: 9,
  DEMON_FORM: 12,
  IMPERVIOUS: 7,
  TWIN_STRIKE: 11,
  BODY_SLAM: 8
}

const PLAYS: Record<string, number> = {
  DEFEND: 47,
  STRIKE: 41,
  POMMEL_STRIKE: 22,
  BASH: 19,
  SHRUG_IT_OFF: 34,
  BATTLE_TRANCE: 16,
  INFLAME: 15,
  BLOODLETTING: 14,
  UPPERCUT: 13,
  ANGER: 12,
  CARNAGE: 11,
  DISARM: 10,
  WHIRLWIND: 9,
  OFFERING: 8,
  DEMON_FORM: 7,
  IMPERVIOUS: 5,
  TWIN_STRIKE: 0,
  BODY_SLAM: 0
}

// ── event generation ────────────────────────────────────────────────────────

/**
 * `2026-08-12T23:40:11Z` and `2026-08-13T10:00:00Z`, as literals.
 *
 * `Date.parse(…)` would read better and would also be a top-level *call*, which
 * is exactly what keeps this module in the production bundle (see `script`
 * above). The comment is the price of the tree-shake.
 */
const START = 1_786_578_011_000
const NOW = 1_786_615_200_000
const PER_ROOM_MS = 69_000

/**
 * One event.
 *
 * `RunEvent` is a union whose open member is `RunEventBase`, so an object
 * literal carrying `roomType` or `eid` fails TypeScript's excess-property check
 * even though the recorder writes exactly those fields — the type is
 * deliberately open at runtime and closed at the literal. This helper is the
 * single, named place that widening happens, rather than a cast at each of the
 * dozen call sites below.
 */
function ev(t: number, type: string, fields: Record<string, unknown> = {}): RunEvent {
  return { t, type, ...fields } as RunEvent
}

function buildEvents(SCRIPT: RoomSpec[]): { events: RunEvent[]; combats: RunCombat[] } {
  const events: RunEvent[] = []
  const combats: RunCombat[] = []
  let act = 0
  let t = START

  events.push(ev(t, 'run_start'))
  events.push(ev(t, 'session_attach', { sid: 1, fresh: true }))

  SCRIPT.forEach((spec, index) => {
    const roomIndex = index + 1
    t += PER_ROOM_MS
    events.push(
      ev(t, 'room_enter', { roomType: spec.type, roomIndex, actIndex: act, floor: roomIndex })
    )

    if (spec.type === 'combat') {
      events.push(ev(t + 1000, 'combat_start', { roomIndex, enemies: spec.enemies ?? 1 }))
    }

    if (spec.offer) {
      const eid = events.length
      events.push(
        ev(t + 4000, 'offer_shown', {
          eid,
          source: spec.offer.source,
          offered: spec.offer.cards,
          costs: { ...(spec.offer.costs ?? {}), ...(spec.stock ?? {}) },
          deckBefore: []
        })
      )
      if (spec.offer.pick) {
        events.push(
          ev(t + 6000, 'deck_add', { id: spec.offer.pick, upgradeLevel: 0, offerEid: eid })
        )
        events.push(
          ev(t + 6000, 'offer_resolved', { eid, picked: spec.offer.pick, reason: 'picked' })
        )
      } else {
        // A skip resolves on the deadline, which lands after the room is left —
        // exactly the ordering the fold has to survive.
        events.push(ev(t + 30_000, 'offer_resolved', { eid, picked: null, reason: 'deadline' }))
      }
    }

    if (spec.removed) {
      events.push(ev(t + 8000, 'deck_remove', { id: spec.removed, upgradeLevel: 0 }))
    }
    if (spec.upgraded) {
      events.push(ev(t + 8000, 'deck_upgrade', { id: spec.upgraded, upgradeLevel: 1, from: 0 }))
    }
    if (spec.add) {
      events.push(ev(t + 8000, 'deck_add', { id: spec.add, upgradeLevel: 0 }))
    }

    if (spec.type === 'combat') {
      const row: RunCombat = {
        startT: t + 1000,
        endT: t + 40_000,
        roomIndex,
        enemies: spec.enemies ?? 1,
        plays: [],
        drawn: []
      }
      combats.push(row)
      events.push(
        ev(t + 40_000, 'combat_end', {
          durationMs: 39_000,
          enemies: row.enemies,
          roomIndex,
          aborted: false
        })
      )
    }

    if (spec.actAfter !== undefined) {
      events.push(ev(t + 44_000, 'act_change', { from: act, to: spec.actAfter }))
      act = spec.actAfter
    }
    if (spec.gameOver) {
      events.push(ev(t + 44_000, 'game_over', { result: 'ended' }))
    }
  })

  return { events, combats }
}

// ── the analysis blob (the shape WP6 must emit; see analysis.ts) ─────────────

const ANALYSIS: JournalJson = {
  apiVersion: 41,
  requests: 11,
  budget: 12,
  draftErrors: 3,
  removalsPassed: 2,
  bestPass: { id: 'LIMIT_BREAK', score: 47, tier: 'A' },
  halfDead: ['CARNAGE'],
  findings: [
    {
      ref: 'F-01',
      severity: 'severe',
      title: 'Took Twin Strike over Feel No Pain',
      at: 'R12',
      roomIndex: 12,
      passed: { id: 'FEEL_NO_PAIN', score: 44, tier: 'A' },
      taken: { id: 'TWIN_STRIKE', score: 12, tier: 'D' },
      outcome: 'taken',
      evidence: [
        { label: 'Bloodletting', value: '68%' },
        { label: 'Offering', value: '71%' },
        { label: 'exhaust package in deck' }
      ],
      verdict:
        'Twin Strike then proved the grade right by never being played once across eleven draws.',
      mono: 'cardReward · act 1 · deck 18 · advice captured live'
    },
    {
      ref: 'F-02',
      severity: 'major',
      title: 'Left Barricade in the shop',
      at: 'R28',
      roomIndex: 28,
      passed: { id: 'BARRICADE', score: 41, tier: 'A' },
      taken: { id: 'BARRICADE', score: null, tier: null },
      outcome: 'left-in-stock',
      cost: 187,
      evidence: [
        { label: 'Body Slam', value: '74%' },
        { label: 'Shrug It Off ×2', value: '62%' }
      ],
      verdict: 'Body Slam sat dead for eight draws because block never persisted without it.',
      mono: 'merchant stock 187g · deck 25 · advice replayed post-run · purchase absence confirmed by deck'
    },
    {
      ref: 'F-03',
      severity: 'major',
      title: 'Took Impervious over Limit Break',
      at: 'R33',
      roomIndex: 33,
      passed: { id: 'LIMIT_BREAK', score: 47, tier: 'A' },
      taken: { id: 'IMPERVIOUS', score: 28, tier: 'B' },
      outcome: 'taken',
      evidence: [
        { label: 'Demon Form', value: '77%' },
        { label: 'Inflame+', value: '66%' },
        { label: 'Anger ×2', value: '58%' }
      ],
      verdict: 'The ramp package was one card from going exponential; Impervious was merely fine.',
      mono: 'event choice · act 3 · deck 25 · advice replayed'
    },
    {
      ref: 'F-04',
      severity: 'noted',
      title: 'Three cards did nothing all run',
      at: 'deck rows 12 · 18 · 19',
      roomIndex: null,
      evidence: [{ label: '19 draws, zero plays' }, { label: '71 dead draws this run' }],
      verdict: 'Three dead cards is one full redraw per combat, and two shops offered the removal.',
      mono: 'local · no network cost · deck ledger rows 12, 18, 19',
      minis: [
        { id: 'TWIN_STRIKE', label: 'taken R12', tally: '0 / 11 drawn' },
        { id: 'BODY_SLAM', label: 'event add R25', tally: '0 / 8 drawn' },
        { id: 'CARNAGE', label: 'taken R34', tally: '0 plays · 2nd copy' }
      ]
    }
  ],
  // Three footnotes rather than one, because the footnote block is now chips
  // with their sentences on hover (`footnoteTail`) and the mock is where that
  // is looked at: PROXY exercises the parsed tail, LOCAL the counted one, and
  // OFFLINE the fixed actionable tail that stays visible on purpose.
  footnotes: [
    {
      chip: 'PROXY',
      text: '4,210 Ironclad runs in bracket (18,412 total) · core picked 58–61% when offered · decks with most of this core ≈ 9–14% — proxy, the API cannot count exact deck matches'
    },
    {
      chip: 'LOCAL',
      text: '2 of 4 shops left without a card removed · card use is counted from pile transitions at 250 ms, so play counts are approximate and aborted combats are excluded'
    },
    {
      chip: 'OFFLINE',
      text: 'spire-codex.com could not be reached for part of this review — the local findings are complete; reviewing the run again adds the draft-advice replays'
    }
  ]
}

// ── the run files ───────────────────────────────────────────────────────────

const DEATH_ID = '2026-08-12T23-40-11Z-ironclad-a41f3c'
const MP_ID = '2026-08-11T18-02-55Z-silent-7b19cd'
const PROVISIONAL_ID = '2026-08-13T09-12-40Z-ironclad-7d0e91'
const CANDIDATE_ID = '2026-08-13T08-58-02Z-ironclad-2c77ab'
const VICTORY_ID = '2026-07-30T20-05-02Z-regent-9c22b4'
const FUTURE_ID = '2026-08-13T21-14-00Z-necrobinder-ff01aa'

interface Bundle {
  deathRun: RunFile
  mpRun: RunFile
  base: CatalogEntry[]
  provisional: CatalogEntry
  candidate: CatalogEntry
  liveRun: JournalCurrentRun
  livePiles: Sts2PileState
  liveEnemies: Sts2EnemiesState
}

let cached: Bundle | null = null

/** Built once, on the first `journalFixtures` call, and reused after that. */
function build(): Bundle {
  const SCRIPT = script()
  const BUILT = buildEvents(SCRIPT)
  const ELAPSED_MS = SCRIPT.length * PER_ROOM_MS

  const deathRun: RunFile = {
    schema: JOURNAL_SCHEMA,
    id: DEATH_ID,
    character: 'IRONCLAD',
    gameVersion: '1.3.0.123',
    state: 'closed',
    outcome: 'death',
    observedFrom: 'start',
    startedAt: START,
    runStartTime: Math.floor(START / 1000),
    firstSeenAt: START,
    lastSeenAt: START + ELAPSED_MS,
    endedAt: START + ELAPSED_MS,
    countsArePartial: false,
    truncatedEvents: false,
    ambiguity: null,
    supersededBy: null,
    playerCount: 1,
    actReached: 2,
    roomsEntered: SCRIPT.length,
    floorReached: SCRIPT.length,
    ascension: null,
    sessions: [
      {
        sid: 1,
        attachedAt: START,
        detachedAt: START + ELAPSED_MS,
        reason: 'process-gone',
        activeMs: ELAPSED_MS,
        playerCount: 1,
        otherCharacterIds: [],
        gameVersion: '1.3.0.123'
      }
    ],
    snapshot: {
      at: START + ELAPSED_MS,
      act: 2,
      roomIndex: SCRIPT.length,
      roomType: 'combat',
      deck: FINAL_DECK.flatMap((row) =>
        Array.from({ length: row.count }, () => `${row.id}#${row.upgradeLevel}`)
      ),
      deckHash: 'a41f3cbe1d2f',
      deckSize: FINAL_DECK.reduce((n, row) => n + row.count, 0),
      eventCount: BUILT.events.length,
      combatAgg: { plays: PLAYS, drawn: DRAWN },
      openCombat: null,
      openOffer: null,
      paceActiveMs: ELAPSED_MS
    },
    events: BUILT.events,
    combats: BUILT.combats,
    signature: {
      deckHash: 'a41f3cbe1d2f',
      relicHash: null,
      core: ['DEMON_FORM', 'INFLAME', 'UPPERCUT', 'WHIRLWIND']
    },
    finalDeck: FINAL_DECK,
    relics: [],
    potions: [],
    pace: {
      elapsedMs: ELAPSED_MS,
      roomsEntered: SCRIPT.length,
      perRoomAvgMs: ELAPSED_MS / SCRIPT.length
    },
    analysisStatus: 'done',
    analysis: ANALYSIS
  }

  /**
   * The second run file exists for one reason: the *pending* review state. It is
   * a 2P run joined mid-way, so it also exercises the partial-counts whispers and
   * the thin-cohort footnote (one 2P run on file cannot average against itself).
   */
  const mpRun: RunFile = {
    ...deathRun,
    id: MP_ID,
    character: 'SILENT',
    outcome: 'ended',
    observedFrom: 'mid-run',
    startedAt: null,
    runStartTime: null,
    firstSeenAt: START - 86_400_000,
    lastSeenAt: START - 80_000_000,
    endedAt: START - 80_000_000,
    countsArePartial: true,
    playerCount: 2,
    actReached: 1,
    roomsEntered: 22,
    floorReached: 24,
    analysisStatus: 'pending',
    analysis: null,
    snapshot: { ...deathRun.snapshot, act: 1, deckSize: 23 },
    signature: { deckHash: '7b19cd0a', relicHash: null, core: ['CATALYST', 'FOOTWORK'] },
    pace: { elapsedMs: 22 * 63_000, roomsEntered: 22, perRoomAvgMs: 63_000 }
  }

  // ── the catalog ─────────────────────────────────────────────────────────────

  function entryFor(
    run: RunFile,
    overrides: Partial<CatalogEntry> = {}
  ): CatalogEntry {
    return {
      id: run.id,
      character: run.character,
      startedAt: run.startedAt,
      firstSeenAt: run.firstSeenAt,
      lastSeenAt: run.lastSeenAt,
      state: run.state,
      outcome: run.outcome,
      observedFrom: run.observedFrom,
      actReached: run.actReached,
      roomsEntered: run.roomsEntered,
      countsArePartial: run.countsArePartial,
      deckSize: run.snapshot.deckSize,
      deckHash: run.snapshot.deckHash,
      deck: null,
      core: run.signature.core,
      runStartTime: run.runStartTime,
      playerCount: run.playerCount,
      activeMs: run.pace.elapsedMs,
      analysisStatus: run.analysisStatus,
      ambiguity: run.ambiguity,
      supersededBy: run.supersededBy,
      schema: run.schema,
      unreadable: false,
      file: `runs/${run.id}.json`,
      fileBytes: 48_213,
      fileMtimeMs: run.lastSeenAt,
      ...overrides
    }
  }

  const soloSibling: CatalogEntry = entryFor(deathRun, {
    id: '2026-08-09T19-22-10Z-ironclad-3ba901',
    startedAt: START - 3 * 86_400_000,
    firstSeenAt: START - 3 * 86_400_000,
    lastSeenAt: START - 3 * 86_400_000 + 40 * 106_000,
    outcome: 'ended',
    actReached: 1,
    roomsEntered: 31,
    deckSize: 24,
    activeMs: 31 * 106_000,
    analysisStatus: 'done'
  })

  const victory: CatalogEntry = entryFor(deathRun, {
    id: VICTORY_ID,
    character: 'REGENT',
    outcome: 'victory',
    startedAt: Date.parse('2026-07-30T20:05:02Z'),
    firstSeenAt: Date.parse('2026-07-30T20:05:02Z'),
    lastSeenAt: Date.parse('2026-07-30T21:03:14Z'),
    actReached: 2,
    roomsEntered: 52,
    deckSize: 31,
    activeMs: 52 * 67_000,
    core: ['GLASS_KNIFE', 'ACCURACY']
  })

  const candidate: CatalogEntry = entryFor(deathRun, {
    id: CANDIDATE_ID,
    state: 'suspended',
    outcome: null,
    startedAt: NOW - 3_600_000,
    firstSeenAt: NOW - 3_600_000,
    lastSeenAt: NOW - 3_500_000,
    actReached: 0,
    roomsEntered: 3,
    deckSize: 12,
    activeMs: 240_000,
    analysisStatus: 'none'
  })

  const provisional: CatalogEntry = entryFor(deathRun, {
    id: PROVISIONAL_ID,
    state: 'recording',
    outcome: null,
    startedAt: NOW - 1_500_000,
    firstSeenAt: NOW - 1_500_000,
    lastSeenAt: NOW,
    actReached: 1,
    roomsEntered: 23,
    deckSize: 19,
    activeMs: 1_458_000,
    analysisStatus: 'none',
    ambiguity: { candidateId: CANDIDATE_ID, raisedAt: NOW - 1_500_000, resolution: null, resolvedAt: null }
  })

  /** A file from a newer build: listed, dimmed, and honest about why. */
  const future: CatalogEntry = entryFor(deathRun, {
    id: FUTURE_ID,
    character: 'NECROBINDER',
    state: 'closed',
    outcome: null,
    lastSeenAt: NOW - 600_000,
    schema: JOURNAL_SCHEMA + 1,
    unreadable: true,
    actReached: null,
    roomsEntered: 0,
    deckSize: 0,
    activeMs: 0,
    analysisStatus: 'none'
  })

  const BASE_CATALOG: CatalogEntry[] = [
    entryFor(deathRun),
    entryFor(mpRun),
    soloSibling,
    victory,
    future
  ]

  // ── the live keys ───────────────────────────────────────────────────────────

  const liveRun: JournalCurrentRun = {
    runId: PROVISIONAL_ID,
    state: 'recording',
    character: 'IRONCLAD',
    act: 1,
    roomIndex: 23,
    floor: 23,
    roomType: 'combat',
    deckSize: 19,
    paceActiveMs: 23 * 63_000,
    elapsedActiveMs: 23 * 63_000,
    recentRoute: [19, 20, 21, 22, 23].map((roomIndex, i) => ({
      t: NOW - (5 - i) * 63_000,
      roomIndex,
      floor: roomIndex,
      act: 1,
      roomType: ['combat', 'other', 'combat', 'other', 'combat'][i] ?? 'combat'
    })),
    playerCount: 1,
    cohort: runCohort(1),
    observedFrom: 'start',
    countsArePartial: false,
    ambiguity: null,
    startedAt: NOW - 1_500_000,
    lastSeenAt: NOW,
    inCombat: true
  }

  const card = (id: string): Sts2PileState['hand'][number] => ({
    id,
    upgradeLevel: 0,
    enchantment: null,
    isPermanent: false,
    hasBeenCycled: false,
    cost: 1,
    defaultCost: 1,
    costsX: false
  })

  const livePiles: Sts2PileState = {
    hand: ['STRIKE', 'DEFEND', 'ANGER', 'INFLAME', 'BASH'].map(card),
    draw: ['STRIKE', 'STRIKE', 'DEFEND', 'DEFEND', 'CARNAGE', 'DISARM', 'UPPERCUT', 'WHIRLWIND', 'OFFERING'].map(card),
    discard: ['STRIKE', 'DEFEND', 'SHRUG_IT_OFF', 'POMMEL_STRIKE'].map(card)
  }

  const liveEnemies: Sts2EnemiesState = {
    enemies: [{ name: 'Cultist', intents: [] }, { name: 'Cultist', intents: [] }],
    isCombatInProgress: true,
    currentSide: 1
  }

  return {
    deathRun,
    mpRun,
    base: BASE_CATALOG,
    provisional,
    candidate,
    liveRun,
    livePiles,
    liveEnemies
  }
}

// ── what the harness installs, per view ─────────────────────────────────────

export const FIXTURE_IDS = {
  /** The 45-room Ironclad death with a complete review. */
  death: DEATH_ID,
  /** The 2P run whose review is still queued. */
  pending: MP_ID
} as const

export type JournalMockView =
  | 'report'
  | 'pending'
  | 'current'
  | 'archive'
  | 'ambiguity'
  | 'empty'

/**
 * The fixture set for a view.
 *
 * It varies by view because the *states* vary: the ambiguity banner only exists
 * when a provisional run and its candidate are both in the catalog, and the
 * LIVE view only exists when a run is being recorded. Building one universal
 * fixture would mean every screenshot carrying every state at once, which is
 * precisely the screenshot nobody can review.
 */
export function journalFixtures(view: JournalMockView): JournalFixtures {
  const data = (cached ??= build())
  const runs = { [DEATH_ID]: data.deathRun, [MP_ID]: data.mpRun }
  if (view === 'empty') {
    // A first launch: the archive exists and is genuinely empty, which is not
    // the same screen as "the archive could not be read" and has to be
    // reviewable as its own thing. An empty catalog rather than a missing one —
    // `catalog: []` resolves, so every view renders its designed empty state
    // instead of an error.
    return { catalog: [], runs: {}, currentRun: null, piles: null, enemies: null }
  }
  if (view === 'ambiguity') {
    return {
      catalog: [data.provisional, data.candidate, ...data.base],
      runs,
      currentRun: { ...data.liveRun, ambiguity: data.provisional.ambiguity },
      piles: data.livePiles,
      enemies: data.liveEnemies
    }
  }
  if (view === 'current') {
    return {
      catalog: data.base,
      runs,
      currentRun: data.liveRun,
      piles: data.livePiles,
      enemies: data.liveEnemies
    }
  }
  if (view === 'archive') {
    // The Archive carries the provisional row as well, because "a provisional
    // run is visibly marked" is one of the things this list has to get right
    // and it cannot be reviewed on a catalog that contains no such run. It also
    // puts the banner above the table, which is exactly where a reader would
    // meet it — `ArchiveView` mounts it unconditionally.
    return {
      catalog: [data.provisional, data.candidate, ...data.base],
      runs,
      currentRun: null,
      piles: null,
      enemies: null
    }
  }
  // The report view is read *after* a run, so there is nothing live:
  // `currentRun: null` is what makes the Current Run tab show its idle state
  // rather than a stale plaque.
  return { catalog: data.base, runs, currentRun: null, piles: null, enemies: null }
}
