/**
 * Self-check for the run journal's *post-run pipeline* — `AnalysisRunner.ts`.
 * Its siblings cover persistence (`journal-selfcheck.mjs`) and the recorder's
 * state machine (`journal-recorder-selfcheck.mjs`); nothing here re-tests those.
 *
 * The repo has no test runner and this work package must not add one, so this
 * script is the acceptance harness: it bundles the modules under test with the
 * esbuild that already ships inside vite, drives the runner against canned run
 * files, a stubbed advisor and a stubbed metrics source in throwaway
 * directories, and asserts the things the plan actually promises —
 *
 *   - the findings math: dead cards vs never-drawn, dead draws, half-dead extra
 *     copies, removals passed, and the severity of every kind of draft mistake;
 *   - the budget: ≤12 requests, ≤10 replays, spacing between them, cache hits
 *     counted as nothing, live-captured advice never replayed;
 *   - the offline path: `partial` with the local findings intact and a footnote
 *     that says why;
 *   - resumability: a review killed mid-flight finishes on the next launch
 *     without re-spending the budget;
 *   - `reanalyze`: prior analysis cleared, budget reset, status pushed.
 *
 *   node scripts/journal-analysis-selfcheck.mjs [--keep]
 */

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const keep = process.argv.includes('--keep')

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0
const failures = []
const tempDirs = []

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, `expected ${e}, got ${a}`)
}

async function section(name, fn) {
  console.log(`\n${name}`)
  try {
    await fn()
  } catch (err) {
    failures.push(`${name} (threw)`)
    console.log(`  FAIL ${name} threw: ${err && err.stack ? err.stack : err}`)
  }
}

async function freshDir(tag) {
  const dir = await mkdtemp(join(tmpdir(), `journal-analysis-${tag}-`))
  tempDirs.push(dir)
  return join(dir, 'runs')
}

// ── bundle the TypeScript under test ─────────────────────────────────────────

const outDir = join(tmpdir(), 'journal-analysis-selfcheck-bundle')
const entry = join(outDir, 'entry.ts')
const outFile = join(outDir, 'analysis.mjs')
await mkdir(outDir, { recursive: true })
await writeFile(
  entry,
  [
    `export * from ${JSON.stringify(join(repo, 'src/main/journal/RunStore.ts').replace(/\\/g, '/'))}`,
    `export * from ${JSON.stringify(join(repo, 'src/main/journal/AnalysisRunner.ts').replace(/\\/g, '/'))}`,
    ''
  ].join('\n'),
  'utf8'
)

let build
try {
  ;({ build } = await import('esbuild'))
} catch {
  console.error('esbuild not found — run `npm install` first (it ships inside vite).')
  process.exit(2)
}

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { '@shared/journal': join(repo, 'src/shared/journal.ts') },
  external: ['electron'],
  logLevel: 'warning'
})

const mod = await import(pathToFileURL(outFile).href)
const {
  RunStore,
  AnalysisRunner,
  analyzeCardUse,
  bracketFor,
  buildOfferFindings,
  collectOffers,
  countShops,
  evidenceOf,
  grade,
  localFindings,
  newRunFile,
  newRunId,
  prettifyId,
  readPriorAnalysis,
  severityForGap,
  severityForPass
} = mod

// ── the canned run ───────────────────────────────────────────────────────────

const AT = 1786662011000
const ROOM = 60_000

/** One event, in the shape the recorder writes it. */
function ev(t, type, fields = {}) {
  return { t, type, ...fields }
}

/**
 * A complete, closed run with everything the pipeline reads: a deck whose
 * tallies contain a dead card, a never-drawn card and a half-dead second copy;
 * two shops, one of which removed a card; three offers needing advice and one
 * that already carries it; and an aborted combat whose counts must not appear.
 */
function cannedRun(tag = 'a41f3c') {
  const id = newRunId('ironclad', AT, tag)
  const run = newRunFile(id, {
    character: 'ironclad',
    observedFrom: 'start',
    startedAt: AT,
    firstSeenAt: AT,
    playerCount: 1
  })
  run.state = 'closed'
  run.outcome = 'ended'
  run.endedAt = AT + 30 * ROOM
  run.analysisStatus = 'pending'
  run.actReached = 2
  run.roomsEntered = 25
  run.floorReached = 25
  run.signature = { deckHash: 'c1f4', relicHash: null, core: ['CARNAGE', 'INFLAME'] }
  run.finalDeck = [
    { id: 'STRIKE', upgradeLevel: 0, count: 4 },
    { id: 'DEFEND', upgradeLevel: 0, count: 4 },
    { id: 'BASH', upgradeLevel: 1, count: 1 },
    { id: 'TWIN_STRIKE', upgradeLevel: 0, count: 1 },
    { id: 'CARNAGE', upgradeLevel: 0, count: 2 },
    { id: 'INFLAME', upgradeLevel: 0, count: 1 },
    { id: 'BODY_SLAM', upgradeLevel: 0, count: 1 }
  ]
  run.combats = [
    {
      startT: AT + ROOM,
      endT: AT + ROOM + 40_000,
      roomIndex: 1,
      enemies: 2,
      drawn: [
        { id: 'STRIKE', count: 10 },
        { id: 'DEFEND', count: 8 },
        { id: 'BASH', count: 3 },
        { id: 'TWIN_STRIKE', count: 11 },
        { id: 'CARNAGE', count: 4 },
        { id: 'INFLAME', count: 2 }
      ],
      plays: [
        { id: 'STRIKE', count: 9 },
        { id: 'DEFEND', count: 8 },
        { id: 'BASH', count: 3 },
        { id: 'CARNAGE', count: 1 },
        { id: 'INFLAME', count: 2 }
      ]
    },
    // Interrupted, restarted by the game on resume: excluded from every total,
    // and if it were not, TWIN_STRIKE would stop looking dead.
    {
      startT: AT + 2 * ROOM,
      endT: AT + 2 * ROOM + 5000,
      roomIndex: 2,
      enemies: 1,
      aborted: true,
      drawn: [{ id: 'TWIN_STRIKE', count: 4 }],
      plays: [{ id: 'TWIN_STRIKE', count: 5 }]
    }
  ]

  const events = []
  events.push(ev(AT, 'run_start'))
  events.push(ev(AT, 'session_attach', { sid: 1, fresh: true }))
  events.push(ev(AT + ROOM, 'room_enter', { roomType: 'combat', roomIndex: 1, actIndex: 0, floor: 1 }))

  // R2 — a shop. Barricade sits in the stock and is never bought, and no card
  // is removed here: one removal passed.
  events.push(ev(AT + 2 * ROOM, 'room_enter', { roomType: 'merchant', roomIndex: 2, actIndex: 0, floor: 2 }))
  events.push(
    ev(AT + 2 * ROOM + 1000, 'offer_shown', {
      eid: 101,
      source: 'merchant',
      offered: ['BARRICADE', 'HAND_DRILL'],
      costs: { BARRICADE: 187, HAND_DRILL: 165, RED_SKULL: 220 },
      deckBefore: ['STRIKE#0', 'DEFEND#0', 'BASH#0']
    })
  )
  events.push(ev(AT + 2 * ROOM + 20_000, 'offer_resolved', { eid: 101, picked: null, reason: 'deadline' }))

  // R3 — a second shop, this one used for a removal.
  events.push(ev(AT + 3 * ROOM, 'room_enter', { roomType: 'merchant', roomIndex: 3, actIndex: 0, floor: 3 }))
  events.push(ev(AT + 3 * ROOM + 5000, 'deck_remove', { id: 'ASCENDERS_BANE', upgradeLevel: 0 }))

  // R12 — the classic: the worst card in the reward, and it never got played.
  events.push(ev(AT + 12 * ROOM, 'room_enter', { roomType: 'combat', roomIndex: 12, actIndex: 1, floor: 12 }))
  events.push(
    ev(AT + 12 * ROOM + 4000, 'offer_shown', {
      eid: 112,
      source: 'cardReward',
      offered: ['TWIN_STRIKE', 'FEEL_NO_PAIN', 'CLOTHESLINE'],
      costs: {},
      deckBefore: ['STRIKE#0', 'STRIKE#0', 'DEFEND#0', 'BASH#1', 'CARNAGE#0']
    })
  )
  events.push(ev(AT + 12 * ROOM + 6000, 'deck_add', { id: 'TWIN_STRIKE', upgradeLevel: 0, offerEid: 112 }))
  events.push(ev(AT + 12 * ROOM + 6000, 'offer_resolved', { eid: 112, picked: 'TWIN_STRIKE', reason: 'picked' }))

  // R20 — advice captured live while playing. Must never be replayed, and the
  // pick was the best option, so it must produce no finding at all.
  events.push(ev(AT + 20 * ROOM, 'room_enter', { roomType: 'combat', roomIndex: 20, actIndex: 2, floor: 20 }))
  events.push(
    ev(AT + 20 * ROOM + 4000, 'offer_shown', {
      eid: 120,
      source: 'cardReward',
      offered: ['ANGER', 'CLEAVE'],
      costs: {},
      deckBefore: ['STRIKE#0', 'DEFEND#0'],
      advice: {
        ANGER: { score: 0.5, base: 0.4, reasons: ['Inflame 62%'] },
        CLEAVE: { score: 0.2, base: 0.19, reasons: [] }
      }
    })
  )
  events.push(ev(AT + 20 * ROOM + 6000, 'offer_resolved', { eid: 120, picked: 'ANGER', reason: 'picked' }))

  // R25 — a strong card passed entirely.
  events.push(ev(AT + 25 * ROOM, 'room_enter', { roomType: 'event', roomIndex: 25, actIndex: 2, floor: 25 }))
  events.push(
    ev(AT + 25 * ROOM + 4000, 'offer_shown', {
      eid: 125,
      source: 'chooseACard',
      offered: ['LIMIT_BREAK', 'IMPERVIOUS'],
      costs: {},
      deckBefore: ['STRIKE#0', 'DEFEND#0', 'CARNAGE#0']
    })
  )
  events.push(ev(AT + 25 * ROOM + 40_000, 'offer_resolved', { eid: 125, picked: null, reason: 'deadline' }))
  events.push(ev(AT + 26 * ROOM, 'game_over', { result: 'ended' }))

  run.events = events
  run.snapshot = {
    ...run.snapshot,
    act: 2,
    roomIndex: 25,
    deck: ['STRIKE#0', 'DEFEND#0'],
    deckSize: 2,
    eventCount: events.length
  }
  run.sessions = [
    { sid: 1, attachedAt: AT, detachedAt: AT + 26 * ROOM, reason: 'process-gone', activeMs: 26 * ROOM, playerCount: 1, gameVersion: '1.3.0.123' }
  ]
  run.pace = { elapsedMs: 26 * ROOM, roomsEntered: 25, perRoomAvgMs: Math.round((26 * ROOM) / 25) }
  return run
}

// ── stubbed network ──────────────────────────────────────────────────────────

const ADVICE = {
  // Keyed by the sorted offered ids, the way the stub is asked for them.
  'CLOTHESLINE,FEEL_NO_PAIN,TWIN_STRIKE': {
    FEEL_NO_PAIN: { score: 0.44, base: 0.31, reasons: ['Bloodletting 68%', 'Offering 71%', 'exhaust package'] },
    TWIN_STRIKE: { score: 0.12, base: 0.2, reasons: [] },
    CLOTHESLINE: { score: 0.3, base: 0.3, reasons: [] }
  },
  'BARRICADE,HAND_DRILL': {
    BARRICADE: { score: 0.52, base: 0.4, reasons: ['Body Slam 74%'] },
    HAND_DRILL: { score: 0.22, base: 0.22, reasons: [] }
  },
  'IMPERVIOUS,LIMIT_BREAK': {
    LIMIT_BREAK: { score: 0.61, base: 0.45, reasons: ['Demon Form 77%', 'Inflame 66%'] },
    IMPERVIOUS: { score: 0.28, base: 0.3, reasons: [] }
  }
}

function advisorStub(opts = {}) {
  const calls = []
  return {
    calls,
    ready: () => opts.ready !== false,
    advise: async (deck, offered) => {
      calls.push({ deck: [...deck], offered: [...offered] })
      if (opts.fail) return null
      return ADVICE[[...offered].sort().join(',')] ?? null
    }
  }
}

const METRIC_ROWS = [
  { id: 'FEEL_NO_PAIN', upgraded: false, tier: 'A', score: 71, win_rate: 54.2, offered: 1000, picked: 610 },
  { id: 'FEEL_NO_PAIN', upgraded: true, tier: 'S', score: 80, win_rate: 58 },
  { id: 'TWIN_STRIKE', upgraded: false, tier: 'D', score: 22, win_rate: 41.1, offered: 1000, picked: 180 },
  { id: 'LIMIT_BREAK', upgraded: false, tier: 'A', score: 68, win_rate: 53, offered: 900, picked: 500 },
  { id: 'BARRICADE', upgraded: false, tier: 'A', score: 66, win_rate: 52.4, offered: 800, picked: 470 },
  { id: 'CARNAGE', upgraded: false, tier: 'B', score: 51, win_rate: 49.5, offered: 1000, picked: 580 },
  { id: 'INFLAME', upgraded: false, tier: 'B', score: 55, win_rate: 50.2, offered: 1000, picked: 610 },
  { id: 'BODY_SLAM', upgraded: false, tier: 'C', score: 40, win_rate: 47 }
]

function metricsStub(opts = {}) {
  const calls = []
  return {
    calls,
    cards: async (query) => {
      calls.push(query)
      if (opts.fail) return null
      return {
        bracket: query.bracket,
        character: query.character.toUpperCase(),
        totalRuns: 18_412,
        characterRuns: 4210,
        rows: METRIC_ROWS,
        apiVersion: 41,
        // Default: fetched now, i.e. a real request. `cached: true` backdates it.
        fetchedAt: opts.cached ? 1 : Date.now() + 60_000
      }
    }
  }
}

/** A runner wired to a throwaway store, with a sleep the test can watch. */
async function harness(tag, opts = {}) {
  const dir = await freshDir(tag)
  const issues = []
  const events = []
  const statuses = []
  const sleeps = []
  const store = new RunStore({ baseDir: dir, env: {}, onIssue: () => {}, debounceMs: 5 })
  const advisor = opts.advisor === null ? null : (opts.advisor ?? advisorStub())
  const metrics = opts.metrics === null ? null : (opts.metrics ?? metricsStub())
  const runner = new AnalysisRunner({
    store,
    advisor,
    metrics,
    onIssue: (key, severity, props) => issues.push({ key, severity, props }),
    onEvent: (name, props) => events.push({ name, props }),
    onStatus: (id, status) => statuses.push({ id, status }),
    onCatalog: () => {},
    sleep: async (ms) => {
      sleeps.push(ms)
      if (opts.onSleep) await opts.onSleep(ms)
    },
    ...(opts.options ?? {})
  })
  return { dir, store, runner, advisor, metrics, issues, events, statuses, sleeps }
}

/** Put a canned run on disk and in the store, ready to be analysed. */
async function seed(store, tag) {
  const run = cannedRun(tag)
  store.save(run, { immediate: true })
  await store.flush()
  return run
}

// ── 1. the local half: card use, dead draws, shops ───────────────────────────

await section('card use is read from the per-combat tallies, aborted rows excluded', async () => {
  const use = analyzeCardUse(cannedRun())
  eq('one card was drawn and never played', use.deadCards, 1)
  eq('and it is named', use.neverUsed.map((r) => r.id), ['TWIN_STRIKE'])
  eq('with its draws intact', use.neverUsed[0].drawn, 11)
  ok(
    'the aborted combat is not counted (it would have made it look played)',
    use.playedById['TWIN_STRIKE'] === undefined
  )
  // 10-9 + 8-8 + 3-3 + 11-0 + 4-1 + 2-2 = 15
  eq('dead draws are the draws that produced no play', use.deadDraws, 15)
  eq('a card never drawn is not a dead card', use.neverDrawn, [{ id: 'BODY_SLAM', copies: 1, drawn: 0, played: 0, dead: 0 }])
  eq('a second copy that never landed is half-dead, not dead', use.halfDead, ['CARNAGE'])
  eq('counts are present', use.countsMissing, false)
})

await section('a run with no combats says so instead of reporting zeroes', async () => {
  const run = cannedRun()
  run.combats = []
  run.snapshot = { ...run.snapshot, combatAgg: { plays: {}, drawn: {} } }
  const use = analyzeCardUse(run)
  eq('counts are missing', use.countsMissing, true)
  eq('no dead cards are claimed', use.deadCards, 0)
  eq('and dead draws are null, not zero', use.deadDraws, null)
  eq('which yields no local finding', localFindings(use, 6), [])
})

await section('removals passed: a shop the deck did not shrink in', async () => {
  const shops = countShops(cannedRun())
  eq('both shops counted', shops.shops, 2)
  eq('one of them removed nothing', shops.removalsPassed, 1)
})

await section('offers fold out of the log with their room, deck and advice', async () => {
  const offers = collectOffers(cannedRun())
  eq('four offers', offers.length, 4)
  eq('in the order shown', offers.map((o) => o.eid), [101, 112, 120, 125])
  eq('attributed to the room they were shown in', offers[1].roomIndex, 12)
  eq('with the act they were shown in', offers[1].act, 1)
  eq('the deck as it was at that floor', offers[1].deckBefore.length, 5)
  eq('a skip is a null pick', offers[0].picked, null)
  eq('live advice is recognised', offers[2].adviceLive, true)
  eq('and the rest have none yet', offers[3].advice, null)
  eq('shop prices ride along', offers[0].costs.BARRICADE, 187)
})

await section('grading thresholds', async () => {
  eq('a 0–1 probability becomes a 0–100 grade', grade({ score: 0.44, base: 0, reasons: [] }), 44)
  eq('no advice, no grade', grade(undefined), null)
  eq('a two-point gap is noise, not a mistake', severityForGap(2), null)
  eq('eight points is major', severityForGap(8), 'major')
  eq('fifteen is severe', severityForGap(15), 'severe')
  eq('passing a mediocre card is correct play', severityForPass(44), null)
  eq('passing a good one is noted', severityForPass(47), 'noted')
  eq('passing a great one is severe', severityForPass(61), 'severe')
  eq('reasons split into label and value', evidenceOf(['Bloodletting 68%', 'exhaust package']), [
    { label: 'Bloodletting', value: '68%' },
    { label: 'exhaust package', value: null }
  ])
  eq('ids are prettified without a name table', prettifyId('TWIN_STRIKE'), 'Twin Strike')
  eq('a solo run compares against the solo bracket', bracketFor(1), 'solo')
  eq('a 2P run against 2p', bracketFor(2), '2p')
  eq('an unreadable player count claims nothing', bracketFor(null), 'all')
})

await section('a finding is only built where the model actually graded both cards', async () => {
  const use = analyzeCardUse(cannedRun())
  const offers = collectOffers(cannedRun())
  const ungraded = offers.map((o) => ({ ...o, advice: null }))
  eq('no advice, no findings', buildOfferFindings(ungraded, use, new Map(), 6), [])

  const partial = offers.map((o) =>
    o.eid === 112
      ? { ...o, advice: { FEEL_NO_PAIN: { score: 0.44, base: 0.3, reasons: [] } } }
      : { ...o, advice: null }
  )
  eq(
    'an ungraded pick is not evidence of a mistake',
    buildOfferFindings(partial, use, new Map(), 6),
    []
  )
})

// ── 2. the whole pipeline, online ────────────────────────────────────────────

await section('a closed run is reviewed end to end', async () => {
  const h = await harness('full')
  const run = await seed(h.store, 'full01')
  h.runner.enqueue(run.id)
  await h.runner.idle()

  const after = await h.store.getRun(run.id)
  eq('done', after.analysisStatus, 'done')
  const a = after.analysis
  eq('the blob names its own status', a.status, 'done')
  eq('nothing failed', a.error, null)
  eq('the API version is recorded', a.apiVersion, 41)

  // 1 metrics GET + 3 replays (the fourth offer already had advice).
  eq('one request per ungraded offer, plus the metrics table', a.requests, 4)
  eq('under the plan budget', a.budget, 12)
  eq('no draft errors', a.draftErrors, 0)
  eq('nothing left ungraded', a.pending, [])
  eq('the replays are named for resumability', a.replayed.sort(), [101, 112, 125])
  eq('the offer with live advice was never replayed', h.advisor.calls.length, 3)
  ok(
    'replays send the deck as it was at that floor, ids only',
    h.advisor.calls.every((c) => c.deck.every((id) => !id.includes('#')))
  )
  eq('later offers are replayed first', h.advisor.calls.map((c) => c.offered.length), [2, 3, 2])
  eq('and they are spaced', h.sleeps, [4500, 4500])

  // The summary strip.
  eq('four findings', a.findings.length, 4)
  eq('two of them severe', a.findings.filter((f) => f.severity === 'severe').length, 2)
  eq('dead cards', a.deadCards, 1)
  eq('dead draws', a.deadDraws, 15)
  eq('removals passed', a.removalsPassed, 1)
  eq('the best card passed all run', a.bestPass, { id: 'LIMIT_BREAK', score: 61, tier: 'A' })
  eq('half-dead rows are listed for the ledger', a.halfDead, ['CARNAGE'])

  // The findings themselves.
  eq('refs run in order', a.findings.map((f) => f.ref), ['F-01', 'F-02', 'F-03', 'F-04'])
  const first = a.findings[0]
  eq('the worst draft mistake leads', first.title, 'Took Twin Strike over Feel No Pain')
  eq('at the room it happened in', [first.at, first.roomIndex], ['R12', 12])
  eq('the card that was passed, graded', first.passed, { id: 'FEEL_NO_PAIN', score: 44, tier: 'A' })
  eq('the card that was taken, graded', first.taken, { id: 'TWIN_STRIKE', score: 12, tier: 'D' })
  eq('outcome', first.outcome, 'taken')
  eq('the synergy evidence is carried through', first.evidence[0], { label: 'Bloodletting', value: '68%' })
  ok('and the verdict names what the run proved', /never being played across 11 draws/.test(first.verdict))
  ok('the provenance line says where the advice came from', /advice replayed post-run/.test(first.mono))

  const shop = a.findings.find((f) => f.outcome === 'left-in-stock')
  eq('the shop finding is priced', shop.cost, 187)
  eq('and its "taken" slot is the same card, ungraded', shop.taken, { id: 'BARRICADE', score: null, tier: null })
  eq('major, not severe', shop.severity, 'major')

  const local = a.findings.find((f) => f.roomIndex === null)
  eq('the local finding is last and quiet', local.severity, 'noted')
  eq('it names the dead card', local.minis[0].id, 'TWIN_STRIKE')
  eq('with the damning tally', local.minis[0].tally, '0 / 11 drawn')

  // Footnotes and the proxy.
  const chips = a.footnotes.map((f) => f.chip)
  eq('a labelled proxy and the local caveat', chips, ['PROXY', 'LOCAL'])
  ok('the proxy names the cohort it came from', /4,210 runs/.test(a.footnotes[0].text))
  ok('and refuses to claim an exact deck match', /cannot count exact deck matches/.test(a.footnotes[0].text))
  eq('the popularity block is labelled too', a.popularity.note, 'proxy')
  eq('core pick rates are derived from offered/picked', a.popularity.corePickRates, { CARNAGE: 58, INFLAME: 61 })
  eq('deck context joins the metrics table', a.deckContext.find((r) => r.id === 'CARNAGE').tier, 'B')

  // The pushes an open report live-updates from.
  eq('the status was pushed as it moved', h.statuses.map((s) => s.status).slice(-1), ['done'])
  ok('and it went partial first', h.statuses.some((s) => s.status === 'partial'))
  ok('the run was reported', !!h.events.find((e) => e.name === 'journal_analysis_done'))
})

await section('a cached metrics answer costs nothing', async () => {
  const h = await harness('cached', { metrics: metricsStub({ cached: true }) })
  const run = await seed(h.store, 'cach01')
  h.runner.enqueue(run.id)
  await h.runner.idle()
  const a = (await h.store.getRun(run.id)).analysis
  eq('three replays and no request for the cache hit', a.requests, 3)
  eq('the proxy is there all the same', a.popularity.characterRuns, 4210)
  eq('done', a.status, 'done')
})

await section('a multiplayer run is tagged and caveated', async () => {
  const h = await harness('mp')
  const run = cannedRun('mp0001')
  run.playerCount = 2
  h.store.save(run, { immediate: true })
  await h.store.flush()
  h.runner.enqueue(run.id)
  await h.runner.idle()
  const a = (await h.store.getRun(run.id)).analysis
  eq('the cohort is recorded', a.cohort, '2p')
  eq('and the community bracket matched to it', h.metrics.calls[0].bracket, '2p')
  ok('with a caveat of its own', a.footnotes.some((f) => f.chip === 'MP'))
})

// ── 3. budget, errors, offline ───────────────────────────────────────────────

await section('the budget is a hard cap, and what it cost is named', async () => {
  const h = await harness('budget', { options: { budget: 3, maxReplays: 10 } })
  const run = await seed(h.store, 'budg01')
  h.runner.enqueue(run.id)
  await h.runner.idle()
  const a = (await h.store.getRun(run.id)).analysis
  eq('not one request more than the budget', a.requests, 3)
  eq('metrics plus two replays', h.advisor.calls.length, 2)
  eq('the offer that went ungraded is named', a.pending.length, 1)
  eq('so the review is partial, not done', a.status, 'partial')
  ok('and it says why', a.footnotes.some((f) => f.chip === 'BUDGET'))
})

await section('the replay cap holds even with budget to spare', async () => {
  const h = await harness('replays', { options: { maxReplays: 1 } })
  const run = await seed(h.store, 'repl01')
  h.runner.enqueue(run.id)
  await h.runner.idle()
  const a = (await h.store.getRun(run.id)).analysis
  eq('one replay only', h.advisor.calls.length, 1)
  eq('two offers deferred', a.pending.length, 2)
  eq('partial', a.status, 'partial')
})

await section('a draft-advice failure is counted, never thrown', async () => {
  const h = await harness('drafterr', { advisor: advisorStub({ fail: true }) })
  const run = await seed(h.store, 'derr01')
  h.runner.enqueue(run.id)
  await h.runner.idle()
  const a = (await h.store.getRun(run.id)).analysis
  eq('every failed replay is a draft error', a.draftErrors, 3)
  eq('and each one is still named as pending', a.pending.length, 3)
  eq('partial', a.status, 'partial')
  eq('the local findings survived', a.deadCards, 1)
  ok('and a finding was still produced from them', a.findings.some((f) => f.roomIndex === null))
})

await section('offline is partial with the local findings intact', async () => {
  const h = await harness('offline', { advisor: null, metrics: null })
  const run = await seed(h.store, 'offl01')
  h.runner.enqueue(run.id)
  await h.runner.idle()
  const after = await h.store.getRun(run.id)
  const a = after.analysis
  eq('partial, never failed', after.analysisStatus, 'partial')
  eq('no request was even attempted', a.requests, 0)
  eq('the local numbers are all there', [a.deadCards, a.deadDraws, a.removalsPassed], [1, 15, 1])
  eq('one local finding', a.findings.length, 1)
  eq('and it carries the dead card', a.findings[0].minis[0].id, 'TWIN_STRIKE')
  eq('no findings were invented from missing advice', a.findings[0].roomIndex, null)
  ok('the reason is stated', a.footnotes.some((f) => f.chip === 'OFFLINE'))
  eq('offline is recorded on the blob', a.offline, true)

  // The upgrade path: the network comes back and the review completes.
  const online = new AnalysisRunner({
    store: h.store,
    advisor: advisorStub(),
    metrics: metricsStub(),
    sleep: async () => {},
    onCatalog: () => {}
  })
  await online.reanalyze(run.id)
  await online.idle()
  const upgraded = await h.store.getRun(run.id)
  eq('done on the second pass', upgraded.analysisStatus, 'done')
  eq('with the full set of findings', upgraded.analysis.findings.length, 4)
})

await section('a cooling endpoint is not asked', async () => {
  const h = await harness('cooling', { advisor: advisorStub({ ready: false }) })
  const run = await seed(h.store, 'cool01')
  h.runner.enqueue(run.id)
  await h.runner.idle()
  const a = (await h.store.getRun(run.id)).analysis
  eq('no round trip was spent to be told no', h.advisor.calls.length, 0)
  eq('only the metrics request', a.requests, 1)
  eq('partial', a.status, 'partial')
  ok('reported as offline', a.offline)
})

// ── 4. resumability & reanalyze ──────────────────────────────────────────────

await section('a review killed mid-flight resumes without re-spending the budget', async () => {
  const h = await harness('resume')
  const run = await seed(h.store, 'resu01')
  // Quit the app after the first replay lands.
  h.runner.enqueue(run.id)
  const advisor = h.advisor
  const firstCall = new Promise((resolve) => {
    const original = advisor.advise
    advisor.advise = async (deck, offered) => {
      const res = await original(deck, offered)
      resolve()
      return res
    }
  })
  await firstCall
  h.runner.dispose()
  await h.runner.idle()
  await h.store.flush()

  const midway = await h.store.getRun(run.id)
  eq('left partial on disk', midway.analysisStatus, 'partial')
  const prior = readPriorAnalysis(midway)
  eq('one replay is recorded as done', prior.replayed.length, 1)
  eq('the rest are named as owing', prior.pending.length, 2)
  ok('and the budget it spent is remembered', prior.requests === 2)
  const spentBefore = prior.requests
  const callsBefore = advisor.calls.length

  // Next launch: a fresh store over the same directory, a fresh runner.
  const store2 = new RunStore({ baseDir: h.dir, env: {}, onIssue: () => {}, debounceMs: 5 })
  await store2.open()
  await store2.scan()
  const advisor2 = advisorStub()
  const runner2 = new AnalysisRunner({
    store: store2,
    advisor: advisor2,
    metrics: metricsStub(),
    sleep: async () => {},
    onCatalog: () => {}
  })
  await runner2.start()
  await runner2.idle()

  const finished = await store2.getRun(run.id)
  eq('the remainder finished', finished.analysisStatus, 'done')
  const a = finished.analysis
  eq('the offer already replayed was not replayed again', advisor2.calls.length, 2)
  ok('the earlier spend carried over', a.requests > callsBefore + 1, `requests=${a.requests}`)
  ok('and it never exceeded the budget', a.requests <= a.budget)
  eq('every offer is graded now', a.pending, [])
  eq('with the full findings', a.findings.length, 4)
  ok('the resumed spend includes what the first attempt cost', a.requests >= spentBefore)
  store2.dispose()
  runner2.dispose()
})

await section('reanalyze clears the prior review and starts a fresh budget', async () => {
  const h = await harness('reanalyze')
  const run = await seed(h.store, 'rean01')
  h.runner.enqueue(run.id)
  await h.runner.idle()
  const before = await h.store.getRun(run.id)
  eq('the first review is done', before.analysisStatus, 'done')
  const firstBuilt = before.analysis.builtAt

  // Pretend it spent everything, the way an exhausted review would look.
  before.analysis = { ...before.analysis, requests: 12, findings: [], pending: [7] }
  h.store.save(before, { immediate: true })

  // A runner that will never drain its queue, so the state right after the
  // click can be observed at all — in the app the pipeline starts immediately.
  const parked = new AnalysisRunner({ store: h.store, advisor: null, metrics: null, onCatalog: () => {} })
  parked.dispose()
  const status = await parked.reanalyze(run.id)
  eq('queued', status, 'pending')
  const queued = await h.store.getRun(run.id)
  eq('the prior analysis is gone, not patched', queued.analysis, null)
  eq('and the status says so immediately', queued.analysisStatus, 'pending')

  await h.runner.reanalyze(run.id)
  ok(
    'the renderer heard about it before any work started',
    h.statuses.some((s) => s.status === 'pending')
  )
  await h.runner.idle()
  const after = await h.store.getRun(run.id)
  eq('done again', after.analysisStatus, 'done')
  eq('and the findings rebuilt', after.analysis.findings.length, 4)
  ok('rebuilt, not the old blob', after.analysis.builtAt >= firstBuilt)
  eq('the spent budget was reset with the review', after.analysis.pending, [])
  // Advice already on the log is reused: the second review pays for the metrics
  // table and nothing else, because no offer is ungraded any more.
  eq('advice already in the log is not bought twice', h.advisor.calls.length, 3)
  eq('so the re-review costs one request', after.analysis.requests, 1)
})

await section('the queue is serialized, and a missing run does not stall it', async () => {
  const h = await harness('queue')
  const a = await seed(h.store, 'que001')
  const b = await seed(h.store, 'que002')
  h.runner.enqueue('does-not-exist')
  h.runner.enqueue(a.id)
  h.runner.enqueue(a.id)
  h.runner.enqueue(b.id)
  await h.runner.idle()
  eq('both real runs were reviewed', [
    (await h.store.getRun(a.id)).analysisStatus,
    (await h.store.getRun(b.id)).analysisStatus
  ], ['done', 'done'])
  eq('the duplicate enqueue did not re-run it', h.advisor.calls.length, 6)
  ok('the missing run was reported', h.issues.some((i) => i.key === 'journal_analysis_run_missing'))
})

await section('start() picks up what a previous launch left pending', async () => {
  const h = await harness('startup')
  const run = await seed(h.store, 'star01')
  eq('the recorder left it pending', (await h.store.getRun(run.id)).analysisStatus, 'pending')
  await h.runner.start()
  await h.runner.idle()
  eq('and the pipeline picked it up on its own', (await h.store.getRun(run.id)).analysisStatus, 'done')
})

// ── report ───────────────────────────────────────────────────────────────────

if (!keep) {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
  await rm(outDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
