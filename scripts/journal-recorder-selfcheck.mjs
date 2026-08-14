/**
 * Self-check for the run journal's *behaviour* — `SessionMatcher.ts` (the
 * decision table) and `RunRecorder.ts` (the state machine). Its sibling,
 * `journal-selfcheck.mjs`, covers persistence; nothing here re-tests that.
 *
 * The repo has no test runner and this work package must not add one, so this
 * script is the acceptance harness: it bundles the modules under test with the
 * esbuild that already ships inside vite, drives the recorder with scripted
 * raw-poll sequences against throwaway directories, and asserts every row of
 * the plan's decision table D1–D10 plus the cases the audit and WP1 added —
 * resume by the game's own run key, three campfire upgrades that must NOT
 * supersede, a save-scum regression, the ambiguity window and both answers to
 * its banner, and per-mode supersession.
 *
 *   node scripts/journal-recorder-selfcheck.mjs [--keep]
 */

import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
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
  const dir = await mkdtemp(join(tmpdir(), `journal-recorder-${tag}-`))
  tempDirs.push(dir)
  return join(dir, 'runs')
}

/** Let the recorder's async tails (resume, supersession sweeps) land. */
const settle = () => new Promise((r) => setTimeout(r, 10))

// ── bundle the TypeScript under test ─────────────────────────────────────────

const outDir = join(tmpdir(), 'journal-recorder-selfcheck-bundle')
const entry = join(outDir, 'entry.ts')
const outFile = join(outDir, 'journal.mjs')
await mkdir(outDir, { recursive: true })
// One entry re-exporting all three modules, so the recorder and the store the
// test hands it are the same classes rather than two bundled copies.
await writeFile(
  entry,
  [
    `export * from ${JSON.stringify(join(repo, 'src/main/journal/RunStore.ts').replace(/\\/g, '/'))}`,
    `export * from ${JSON.stringify(join(repo, 'src/main/journal/SessionMatcher.ts').replace(/\\/g, '/'))}`,
    `export * from ${JSON.stringify(join(repo, 'src/main/journal/RunRecorder.ts').replace(/\\/g, '/'))}`,
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

const journal = await import(pathToFileURL(outFile).href)
const {
  RunStore,
  RunRecorder,
  buildFingerprint,
  matchSighting,
  relate,
  isStarterShaped,
  deckHashOf,
  groupDeck,
  aggregateCombats,
  foldTrailingEvents,
  mergeRunInto,
  newRunFile,
  newRunId,
  runFileName,
  serializeRun
} = journal

// ── fixtures ─────────────────────────────────────────────────────────────────

const STARTER = [
  'STRIKE#0',
  'STRIKE#0',
  'STRIKE#0',
  'STRIKE#0',
  'STRIKE#0',
  'DEFEND#0',
  'DEFEND#0',
  'DEFEND#0',
  'DEFEND#0',
  'BASH#0',
  'ASCENDERS_BANE#0',
  'DEFEND#0'
]

/** A deck deep enough that nothing about it looks like a fresh run. */
const DEEP = [
  ...STARTER.slice(0, 10),
  'CARNAGE#0',
  'INFLAME#1',
  'DEMON_FORM#0',
  'LIMIT_BREAK#0',
  'SHRUG_IT_OFF#0',
  'POMMEL_STRIKE#1',
  'IRON_WAVE#0',
  'WHIRLWIND#0'
]

let candSeq = 0
function candidate(over = {}) {
  const deck = over.deck ?? [...STARTER]
  candSeq++
  return {
    id: over.id ?? `cand-${candSeq}`,
    character: over.character ?? 'IRONCLAD',
    actReached: over.actReached === undefined ? 0 : over.actReached,
    deck: deck === null ? null : [...deck].sort(),
    deckHash: over.deckHash ?? deckHashOf([...(deck ?? [])].sort()),
    deckSize: over.deckSize ?? (deck ? deck.length : 0),
    runStartTime: over.runStartTime === undefined ? null : over.runStartTime,
    playerCount: over.playerCount === undefined ? 1 : over.playerCount,
    lastSeenAt: over.lastSeenAt ?? 1000 + candSeq,
    fileMtimeMs: over.fileMtimeMs ?? 1000 + candSeq,
    state: over.state ?? 'suspended'
  }
}

function fingerprint(over = {}) {
  const deck = over.deck ?? [...STARTER]
  const f = buildFingerprint({
    character: over.character ?? 'IRONCLAD',
    act: over.act === undefined ? 0 : over.act,
    deck,
    deckSize: deck.length,
    deckPartial: false,
    playerCount: over.playerCount === undefined ? 1 : over.playerCount,
    runStartTime: over.runStartTime === undefined ? null : over.runStartTime,
    totalFloor: over.totalFloor === undefined ? 1 : over.totalFloor
  })
  if (!f) throw new Error('fixture fingerprint was refused')
  return f
}

/**
 * `"ID#u"` → the RawCard shape the readers actually produce. The address is
 * derived from the card and its ordinal rather than from the pile it is in,
 * because in the game a card object keeps its address as it moves between
 * piles — which is the whole basis of play/draw tracking.
 */
function rawCards(list) {
  const seen = new Map()
  return list.map((card) => {
    const hash = card.lastIndexOf('#')
    // Nth copy of this exact card — stable as the hand reorders, which is what
    // a real object address is and what the fixture has to imitate.
    const nth = seen.get(card) ?? 0
    seen.set(card, nth + 1)
    return {
      id: hash === -1 ? card : card.slice(0, hash),
      upgradeLevel: hash === -1 ? 0 : Number(card.slice(hash + 1)),
      enchantment: null,
      costsX: false,
      cost: 1,
      defaultCost: 1,
      isPermanent: true,
      baseAddress: `${card}@${nth}`
    }
  })
}

/** One poll, in the exact shape the reader child puts on the wire. */
function poll(over = {}) {
  const deck = over.deck ?? [...STARTER]
  const deckPartial = over.deckPartial ?? false
  const nGame =
    over.nGame === null
      ? null
      : {
          roomType: over.roomType === undefined ? 'combat' : over.roomType,
          isMapOpen: false,
          isTraveling: over.traveling ?? false,
          isSubMenuOpen: false,
          isGameOver: over.gameOver ?? false,
          capstoneScreen: false,
          isInspectCardScreenOpen: false,
          isInspectRelicScreenOpen: false,
          currentActIndex: over.act === undefined ? 0 : over.act,
          characterId: over.character ?? 'ironclad',
          playerCount: over.playerCount === undefined ? 1 : over.playerCount,
          otherCharacterIds: over.otherCharacterIds ?? [],
          runStartTime: over.runStartTime === undefined ? null : over.runStartTime,
          totalFloor: over.floor === undefined ? 1 : over.floor
        }
  const pile =
    over.nGame === null
      ? null
      : {
          draw: rawCards(over.draw ?? []),
          discard: rawCards(over.discard ?? []),
          hand: rawCards(over.hand ?? []),
          exhaust: rawCards(over.exhaust ?? []),
          deck: rawCards(deck),
          deckSize: deckPartial ? deck.length + 1 : deck.length,
          deckPartial
        }
  const enemies =
    over.inCombat === undefined
      ? null
      : {
          enemies: [{ intents: [] }, { intents: [] }],
          isCombatInProgress: over.inCombat,
          currentSide: over.side ?? 1
        }
  const items = over.offer
    ? {
        source: over.offer.source ?? 'cardReward',
        items: over.offer.ids.map((id) => ({
          kind: 'card',
          id,
          isHovered: false,
          cx: 0.5,
          cy: 0.5,
          w: 0.1,
          h: 0.2
        }))
      }
    : null
  return { nGame, pile, enemies, items }
}

/** A recorder wired to a throwaway store, with clocks the test drives. */
async function harness(tag, opts = {}) {
  const dir = await freshDir(tag)
  const clock = { wall: 1786662011000, mono: 0 }
  const issues = []
  const events = []
  const pushed = []
  const catalogs = []
  let current = null
  const store = new RunStore({
    baseDir: dir,
    env: {},
    onIssue: (key, severity, props) => issues.push({ key, severity, props }),
    now: () => clock.wall,
    debounceMs: 5
  })
  const recorder = new RunRecorder({
    store,
    now: () => clock.wall,
    monotonic: () => clock.mono,
    env: {},
    onIssue: (key, severity, props) => issues.push({ key, severity, props }),
    onEvent: (name, props) => events.push({ name, props }),
    onCurrentRun: (value) => {
      current = value
      pushed.push(value)
    },
    onCatalog: (entries) => catalogs.push(entries),
    ...opts
  })
  let seq = 0
  const feed = async (over = {}, times = 1) => {
    for (let i = 0; i < times; i++) {
      recorder.observe(poll(over), {
        seq: ++seq,
        detected: over.detected ?? true,
        errorStreak: over.errorStreak ?? 0,
        gameVersion: '1.3.0.123'
      })
      clock.wall += 250
      clock.mono += 250
    }
    await settle()
  }
  const advance = (ms) => {
    clock.wall += ms
    clock.mono += ms
  }
  return {
    dir,
    store,
    recorder,
    clock,
    issues,
    events,
    pushed,
    catalogs,
    feed,
    advance,
    current: () => current,
    hasIssue: (key) => issues.some((i) => i.key === key),
    event: (name) => events.find((e) => e.name === name),
    async run() {
      return store.getRun(recorder.activeRunId)
    }
  }
}

const types = (run) => run.events.map((e) => e.type)

// ── 1. fingerprint refusals (audit A3/A4) ────────────────────────────────────

await section('a fingerprint is refused unless the poll can be trusted', async () => {
  const base = {
    character: 'IRONCLAD',
    act: 0,
    deck: [...STARTER],
    deckSize: STARTER.length,
    deckPartial: false,
    playerCount: 1,
    runStartTime: 1786000000,
    totalFloor: 1
  }
  ok('a clean poll mints one', buildFingerprint(base) !== null)
  eq('a torn deck read is refused (A3)', buildFingerprint({ ...base, deckPartial: true }), null)
  eq(
    'a short read of a longer deck is refused (A3)',
    buildFingerprint({ ...base, deckSize: STARTER.length + 1 }),
    null
  )
  eq('an unknown act is refused (A4)', buildFingerprint({ ...base, act: null }), null)
  eq('an unreachable deck is refused', buildFingerprint({ ...base, deckSize: null }), null)
  eq('no character means no run', buildFingerprint({ ...base, character: null }), null)
  eq('casing never matters', buildFingerprint({ ...base, character: ' ironclad ' }).character, 'IRONCLAD')
  eq(
    'the multiset is order-independent',
    buildFingerprint({ ...base, deck: [...STARTER].reverse() }).deckHash,
    buildFingerprint(base).deckHash
  )
  ok('a starter deck is recognised', isStarterShaped([...STARTER].sort(), 0))
  ok('a deep deck is not', !isStarterShaped([...DEEP].sort(), 1))
})

// ── 2. the decision table, row by row ────────────────────────────────────────

await section('D1 — nothing to match against', async () => {
  const fresh = matchSighting(fingerprint(), [])
  eq('new file', fresh.kind, 'new')
  eq('rule', fresh.rule, 'D1')
  eq('a starter deck is a run we watched start', fresh.observedFrom, 'start')

  const mid = matchSighting(fingerprint({ deck: [...DEEP], act: 1 }), [])
  eq('a deep deck with no candidate is a mid-run attach', mid.observedFrom, 'mid-run')
  eq('still D1', mid.rule, 'D1')
})

await section('D2 — exact deck match is identity', async () => {
  const c = candidate({ deck: [...DEEP], actReached: 1 })
  const v = matchSighting(fingerprint({ deck: [...DEEP], act: 1 }), [c])
  eq('resume', v.kind, 'resume')
  eq('rule', v.rule, 'D2')
  eq('the same run', v.candidateId, c.id)
  eq('no gap — we saw both ends', v.gap, null)

  // Recency never disqualifies: content is proof however old the file is.
  const ancient = candidate({ deck: [...DEEP], actReached: 1, lastSeenAt: 1 })
  const days = matchSighting(fingerprint({ deck: [...DEEP], act: 1 }), [ancient])
  eq('a two-week-old suspension still resumes', days.candidateId, ancient.id)
})

await section('D3 — evolved: play happened while we were away', async () => {
  const c = candidate({ deck: [...STARTER], actReached: 0 })
  const grown = [...STARTER, 'CARNAGE#0', 'INFLAME#0']
  const v = matchSighting(fingerprint({ deck: grown, act: 1 }), [c])
  eq('resume', v.kind, 'resume')
  eq('rule', v.rule, 'D3')
  eq('recorded as unobserved play', v.gap, 'unobserved-play')
  ok('the resumed run is not swept', !v.supersede.includes(c.id))
})

await section('D3 — three campfire upgrades must NOT supersede (audit A2)', async () => {
  // The arithmetic that made the plan wrong: on `"ID#upg"` strings this is
  // three removals against a budget of two, and the live run gets abandoned.
  const c = candidate({ deck: [...STARTER], actReached: 0 })
  const upgraded = [...STARTER]
  for (let i = 0; i < 3; i++) upgraded[i] = 'STRIKE#1'
  const v = matchSighting(fingerprint({ deck: upgraded, act: 0 }), [c])
  eq('relation is EVOLVED, not DIVERGED', relate(fingerprint({ deck: upgraded, act: 0 }), c), 'EVOLVED')
  eq('resume', v.kind, 'resume')
  eq('rule', v.rule, 'D3')
  eq('the real run is never superseded', v.supersede, [])

  // Five upgrades — the case the plan's retention test also failed.
  const five = [...STARTER]
  for (let i = 0; i < 5; i++) five[i] = i < 4 ? 'STRIKE#1' : 'DEFEND#1'
  eq('five upgrades still resume', matchSighting(fingerprint({ deck: five }), [c]).kind, 'resume')

  // And a deck that LOST upgrade levels is not "evolved" — it regressed.
  const downgraded = [...STARTER]
  const upCand = candidate({ deck: upgraded, actReached: 0 })
  eq(
    'losing upgrade levels is a regression, not evolution',
    relate(fingerprint({ deck: downgraded, act: 0 }), upCand),
    'REGRESSED'
  )
})

await section('D3R — a restored save resumes and sweeps nothing (audit A5)', async () => {
  const full = [...DEEP]
  const c = candidate({ deck: full, actReached: 2 })
  const scummed = full.slice(0, full.length - 2)
  const v = matchSighting(fingerprint({ deck: scummed, act: 2 }), [c])
  eq('resume', v.kind, 'resume')
  eq('rule', v.rule, 'D3R')
  eq('named as a save restore', v.gap, 'save-restore')
  eq('a subset match never supersedes', v.supersede, [])

  // Even across an act boundary, which is what falls through to D6 otherwise.
  const back = matchSighting(fingerprint({ deck: scummed, act: 1 }), [c])
  eq('regardless of act', back.rule, 'D3R')
})

await section('D4 — the ambiguous window asks instead of guessing (user decision)', async () => {
  const c = candidate({ deck: [...STARTER], actReached: 0 })
  const v = matchSighting(fingerprint({ deck: [...STARTER], act: 0 }), [c])
  eq('neither resumed nor forked silently', v.kind, 'ambiguous')
  eq('rule', v.rule, 'D4')
  eq('the run we could not rule out is named', v.candidateId, c.id)
  eq('an unanswered question retires nothing', v.supersede, [])

  // One distinguishing choice is all it takes to leave the window.
  const picked = matchSighting(fingerprint({ deck: [...STARTER, 'CARNAGE#0'], act: 0 }), [c])
  ok('one pick ends the ambiguity', picked.kind !== 'ambiguous', picked.rule)

  // And the game's own run key ends it immediately, even at deck parity.
  const keyed = candidate({ deck: [...STARTER], actReached: 0, runStartTime: 1786000000 })
  const sure = matchSighting(fingerprint({ deck: [...STARTER], runStartTime: 1786000000 }), [keyed])
  eq('a matching run key is never ambiguous', sure.kind, 'resume')
  eq('and it is D0', sure.rule, 'D0')
})

await section('D5 — a starter deck cannot be a deep run that regressed', async () => {
  const c = candidate({ deck: [...DEEP], actReached: 2 })
  const v = matchSighting(fingerprint({ deck: [...STARTER], act: 0 }), [c])
  eq('new run', v.kind, 'new')
  eq('rule', v.rule, 'D5')
  eq('observed from its start', v.observedFrom, 'start')
  ok('the abandoned run is queued for supersession', v.supersede.includes(c.id))
})

await section('D6 — diverged, and we missed both ends', async () => {
  const c = candidate({ deck: [...DEEP], actReached: 1 })
  const other = ['CARNAGE#0', 'WHIRLWIND#0', 'DEMON_FORM#0', 'INFLAME#0', 'IRON_WAVE#0',
    'POMMEL_STRIKE#0', 'SHRUG_IT_OFF#0', 'LIMIT_BREAK#0', 'BASH#2', 'CLOTHESLINE#0',
    'TWIN_STRIKE#0', 'FEEL_NO_PAIN#0', 'ANGER#0', 'CLEAVE#0']
  const v = matchSighting(fingerprint({ deck: other, act: 1 }), [c])
  eq('new file', v.kind, 'new')
  eq('rule', v.rule, 'D6')
  eq('joined mid-run', v.observedFrom, 'mid-run')
  ok('the stale run is queued for supersession', v.supersede.includes(c.id))
})

await section('D7 — exact deck, impossible act', async () => {
  const c = candidate({ deck: [...DEEP], actReached: 2 })
  const v = matchSighting(fingerprint({ deck: [...DEEP], act: 1 }), [c])
  eq('new file', v.kind, 'new')
  eq('rule', v.rule, 'D7')
  eq('reported, not papered over', v.anomaly, 'exact-deck-act-regression')
  eq('a contradiction retires nothing', v.supersede, [])
})

await section('D8 — several candidates: content outranks recency', async () => {
  const stale = candidate({ deck: [...DEEP], actReached: 1, lastSeenAt: 10 })
  const recent = candidate({ deck: [...STARTER, 'CARNAGE#0'], actReached: 0, lastSeenAt: 9_999_999 })
  const v = matchSighting(fingerprint({ deck: [...DEEP], act: 1 }), [stale, recent])
  eq('two candidates were weighed', v.considered, 2)
  eq('the exact match wins, not the newest', v.candidateId, stale.id)
  eq('best first', v.ranked[0], stale.id)
  eq('applied row', v.rule, 'D2')
  ok('the loser is queued for supersession', v.supersede.includes(recent.id))
})

await section('D0 — the game names its own run (WP1 findings)', async () => {
  // A deck that has moved on entirely still resumes: the key came out of the
  // save file, so it cannot be coincidence.
  const c = candidate({ deck: [...STARTER], actReached: 0, runStartTime: 1786000000 })
  const v = matchSighting(fingerprint({ deck: [...DEEP], act: 2, runStartTime: 1786000000 }), [c])
  eq('resume regardless of deck state', v.kind, 'resume')
  eq('rule', v.rule, 'D0')
  eq('the deck delta is still recorded as a gap', v.gap, 'unobserved-play')

  // And the negative form is just as useful: different keys, different runs.
  const other = candidate({ deck: [...DEEP], actReached: 2, runStartTime: 1785000000 })
  const fresh = matchSighting(fingerprint({ deck: [...DEEP], act: 2, runStartTime: 1786000000 }), [other])
  eq('a contradicting key disqualifies the candidate', fresh.kind, 'new')
  eq('so it reads as D1', fresh.rule, 'D1')
  ok('and the dead run is swept', fresh.supersede.includes(other.id))
})

await section('supersession sweeps per MODE, not per character', async () => {
  const soloOther = candidate({ character: 'SILENT', deck: [...DEEP], playerCount: 1 })
  const multi = candidate({ character: 'SILENT', deck: [...DEEP], playerCount: 3 })
  const mine = candidate({ deck: [...DEEP], actReached: 1, playerCount: 1 })
  const v = matchSighting(fingerprint({ deck: [...DEEP], act: 1, playerCount: 1 }), [mine], {
    sweepPool: [mine, soloOther, multi]
  })
  eq('resumes my run', v.candidateId, mine.id)
  ok("another character's solo save is dead — one current_run.save", v.supersede.includes(soloOther.id))
  ok('the multiplayer save is untouched', !v.supersede.includes(multi.id))

  const mp = matchSighting(fingerprint({ deck: [...STARTER], playerCount: 2 }), [], {
    sweepPool: [mine, soloOther, multi]
  })
  ok('a new MP run sweeps only the MP save', mp.supersede.includes(multi.id))
  ok('and leaves both solo saves alone', !mp.supersede.some((id) => id === mine.id || id === soloOther.id))
})

// ── 3. the recorder: opening, rooms, offers, decks ───────────────────────────

await section('a run opens once the sighting is stable', async () => {
  const h = await harness('open')
  await h.recorder.start()
  await h.feed({ floor: 1 }, 2)
  eq('two polls are not a sighting', h.recorder.activeRunId, null)
  await h.feed({ floor: 1 })
  ok('the third opens the run', h.recorder.activeRunId !== null)

  const run = await h.run()
  eq('recording', run.state, 'recording')
  eq('character normalised at the boundary', run.character, 'IRONCLAD')
  eq('observed from the start', run.observedFrom, 'start')
  eq('one session', run.sessions.length, 1)
  ok('run_start written', types(run).includes('run_start'))
  ok('session_attach written', types(run).includes('session_attach'))
  eq('the opening room is counted', run.roomsEntered, 1)
  eq('the live key is published', h.current().runId, run.id)
  // The key is liveness and nothing else: everything the Current Run view
  // prints is derived from the run FILE this id names. A field added back here
  // is a second derivation waiting to drift from `derive.ts`, which is exactly
  // the bug this shape was cut down to prevent.
  eq(
    '…and carries nothing derived',
    Object.keys(h.current()).sort().join(','),
    'elapsedActiveMs,inCombat,lastSeenAt,runId'
  )

  // A torn read never becomes a sighting, and never disturbs a live one.
  await h.feed({ floor: 1, deckPartial: true }, 3)
  eq('a torn poll does not open a second run', h.store.list().length, 1)
})

await section('rooms come from the game floor, and the route follows', async () => {
  const h = await harness('rooms')
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  await h.feed({ floor: 2, roomType: 'event' })
  await h.feed({ floor: 3, roomType: 'merchant' })
  // Two consecutive rooms of the SAME type — the case the old roomType-edge
  // rule silently dropped (audit A7, retired by the game's own counter).
  await h.feed({ floor: 4, roomType: 'merchant' })
  const run = await h.run()
  eq('every floor counted', run.roomsEntered, 4)
  eq("the game's floor is recorded", run.floorReached, 4)
  const rooms = run.events.filter((e) => e.type === 'room_enter')
  eq('one event each', rooms.length, 4)
  // The room a run opens on is the sighting's own room, not an unknown: without
  // it every run's first route row reads `other`, whatever it actually was.
  eq('the opening room carries its type', rooms[0].roomType, 'combat')
  eq('same-type rooms are not merged', rooms[3].roomType, 'merchant')
  // The route lives in the file's events and nowhere else — the live view folds
  // these very rows with the same `deriveRoute` the report uses.
  eq('the live key names the file that carries them', h.current().runId, run.id)

  // A floor jump while we were not looking still produces one row per floor.
  await h.feed({ floor: 7, roomType: 'combat' })
  eq('a skipped floor range is filled in', (await h.run()).roomsEntered, 7)
})

await section('a moved ledger announces itself so the live view can refetch', async () => {
  // The Current Run view renders the run FILE, and `data.ts` only refetches a
  // held file when its catalog row advances. So the boundaries that change what
  // the ledger *shows* — a room, an offer resolving, a deck delta — publish a
  // catalog. Without this the live route froze at whatever it was when the tab
  // was opened, while the file underneath it filled up.
  const h = await harness('ledger-push', { pickDeadlineMs: 3000 })
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)

  const afterOpen = h.catalogs.length
  h.advance(5000) // past the freshness floor
  await h.feed({ floor: 2, roomType: 'event' })
  ok('a new room publishes one', h.catalogs.length > afterOpen)
  const row = h.catalogs.at(-1).find((e) => e.id === h.recorder.activeRunId)
  eq('carrying the room it just entered', row.roomsEntered, 2)

  // The throttle is the other half: a fight is a deck change every few polls,
  // and a refetch per poll is a poll loop with extra steps.
  const afterRoom = h.catalogs.length
  await h.feed({ floor: 3, roomType: 'combat' })
  await h.feed({ floor: 4, roomType: 'combat' })
  eq('a burst inside the window does not', h.catalogs.length, afterRoom)

  // …but the trailing edge does: the last change in a burst must never be the
  // one that goes unannounced, or the live view stops one room short forever.
  await new Promise((r) => setTimeout(r, 1400))
  ok('the trailing edge still lands', h.catalogs.length > afterRoom)

  // A pick is a ledger change too — it is the one this whole unification is
  // about — so it announces itself once the window is open again.
  h.advance(5000)
  const afterBurst = h.catalogs.length
  await h.feed({ floor: 4, deck: [...STARTER, 'CARNAGE#0'] })
  ok('a deck change publishes one', h.catalogs.length > afterBurst)
})

await section('offers: pick inference from deck deltas', async () => {
  const h = await harness('offers', { pickDeadlineMs: 3000 })
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  const offer = { ids: ['CARNAGE', 'INFLAME', 'CLEAVE'] }
  await h.feed({ floor: 1, offer }, 3)
  let run = await h.run()
  const shown = run.events.filter((e) => e.type === 'offer_shown')
  eq('one offer, once stable', shown.length, 1)
  eq('with the ids the renderer never sees', shown[0].offered, ['CARNAGE', 'INFLAME', 'CLEAVE'])
  eq('and the deck it was offered against', shown[0].deckBefore.length, STARTER.length)

  // The panels vanish, the deck gains one of the offered cards: that is the pick.
  await h.feed({ floor: 1, deck: [...STARTER, 'INFLAME#0'] }, 2)
  run = await h.run()
  const resolved = run.events.filter((e) => e.type === 'offer_resolved')
  eq('resolved once', resolved.length, 1)
  eq('picked the card the deck gained', resolved[0].picked, 'INFLAME')
  const adds = run.events.filter((e) => e.type === 'deck_add')
  eq('and the add is tagged with the offer', adds[0].offerEid, shown[0].eid)
  eq('no open offer left in the snapshot', run.snapshot.openOffer, null)
})

await section('offers: silence past the deadline is a skip', async () => {
  const h = await harness('skips', { pickDeadlineMs: 2000 })
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  await h.feed({ floor: 1, offer: { ids: ['CARNAGE', 'INFLAME'] } }, 3)
  await h.feed({ floor: 1 })
  h.advance(5000)
  await h.feed({ floor: 1 })
  const run = await h.run()
  const resolved = run.events.filter((e) => e.type === 'offer_resolved')
  eq('resolved', resolved.length, 1)
  eq('as a skip', resolved[0].picked, null)
  eq('by the deadline', resolved[0].reason, 'deadline')
})

await section('deck deltas: upgrades are upgrades, not remove+add', async () => {
  const h = await harness('deck')
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  const upgraded = [...STARTER]
  upgraded[0] = 'STRIKE#1'
  await h.feed({ floor: 1, deck: upgraded }, 1)
  const run = await h.run()
  const kinds = run.events.filter((e) => e.type.startsWith('deck_')).map((e) => e.type)
  eq('one upgrade event, no churn', kinds, ['deck_upgrade'])
  const up = run.events.find((e) => e.type === 'deck_upgrade')
  eq('from and to are both recorded', [up.from, up.upgradeLevel], [0, 1])

  const removed = upgraded.filter((c) => c !== 'ASCENDERS_BANE#0')
  await h.feed({ floor: 1, deck: removed }, 1)
  const after = await h.run()
  const last = after.events[after.events.length - 1]
  eq('a removal is a removal', [last.type, last.id], ['deck_remove', 'ASCENDERS_BANE'])
  eq('the snapshot tracks the deck', after.snapshot.deckSize, removed.length)
})

// ── 4. combats ───────────────────────────────────────────────────────────────

await section('per-combat play and draw tallies', async () => {
  const h = await harness('combat')
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  // Combat starts, two cards in hand.
  await h.feed({ floor: 1, inCombat: true, hand: ['STRIKE#0', 'DEFEND#0'], draw: ['BASH#0'] })
  await h.feed({ floor: 1, inCombat: true, hand: ['STRIKE#0', 'DEFEND#0'], draw: ['BASH#0'] })
  // A card leaves hand for the discard on the player's turn: that is a play.
  await h.feed({ floor: 1, inCombat: true, hand: ['DEFEND#0'], draw: ['BASH#0'], discard: ['STRIKE#0'] })
  await h.feed({ floor: 1, inCombat: false })
  const run = await h.run()
  eq('one combat row', run.combats.length, 1)
  const combat = run.combats[0]
  eq('both cards counted as drawn', combat.drawn.length, 2)
  eq('the played card is counted once', combat.plays, [{ id: 'STRIKE', count: 1 }])
  ok('combat_start and combat_end written', types(run).includes('combat_end'))
  eq('no combat left open', run.snapshot.openCombat, null)
})

await section('a truncated pile read never invents a play (WP1 deviation 4)', async () => {
  const h = await harness('torn-combat')
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  await h.feed({ floor: 1, inCombat: true, hand: ['STRIKE#0', 'DEFEND#0'] })
  await h.feed({ floor: 1, inCombat: true, hand: ['STRIKE#0', 'DEFEND#0'] })
  // The hand "shrinks" on a poll whose deck read came back short: the shrink is
  // as likely to be the read as the player.
  await h.feed({ floor: 1, inCombat: true, hand: ['DEFEND#0'], deckPartial: true })
  await h.feed({ floor: 1, inCombat: false })
  const run = await h.run()
  eq('the suspicious tick was discarded', run.combats[0].plays, [])
  ok('and it is reported', h.hasIssue('journal_combat_tick_discarded'))
})

await section('an interrupted combat is aborted and excluded from aggregates', async () => {
  const h = await harness('abort', { menuDebounceMs: 1000 })
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  await h.feed({ floor: 1, inCombat: true, hand: ['STRIKE#0'] })
  await h.feed({ floor: 1, inCombat: true, hand: [], discard: ['STRIKE#0'] })
  // The game disappears mid-combat.
  h.recorder.onProcess({ detected: false })
  await settle()
  const run = await h.store.getRun(h.store.list()[0].id)
  eq('the run is suspended, not ended', run.state, 'suspended')
  eq('one combat row', run.combats.length, 1)
  eq('marked aborted', run.combats[0].aborted, true)
  eq('detach reason', run.sessions[0].reason, 'process-gone')
  eq(
    'aborted rows are excluded from the run aggregate',
    aggregateCombats(run.combats),
    { plays: {}, drawn: {} }
  )
})

// ── 5. suspension, resume, close ─────────────────────────────────────────────

await section('quit to menu and resume: one file, two sessions', async () => {
  const h = await harness('resume', { menuDebounceMs: 1000 })
  await h.recorder.start()
  await h.feed({ floor: 1, runStartTime: 1786000000 }, 3)
  const id = h.recorder.activeRunId
  await h.feed({ floor: 2, runStartTime: 1786000000 })

  // A loading screen: null nGame, but well under the debounce.
  await h.feed({ nGame: null })
  ok('a loading screen is not a suspension', h.recorder.activeRunId === id)

  h.advance(3000)
  await h.feed({ nGame: null })
  eq('past the debounce it suspends', h.recorder.activeRunId, null)
  let run = await h.store.getRun(id)
  eq('suspended', run.state, 'suspended')
  eq('detach reason', run.sessions[0].reason, 'menu')
  eq('the live key goes quiet', h.current(), null)

  // Three days later, same deck, same run key.
  h.advance(3 * 24 * 3600 * 1000)
  await h.feed({ floor: 2, runStartTime: 1786000000 }, 3)
  eq('the same file resumes', h.recorder.activeRunId, id)
  eq('exactly one run in the archive', h.store.list().length, 1)
  run = await h.store.getRun(id)
  eq('two sessions', run.sessions.length, 2)
  eq('recording again', run.state, 'recording')

  // The runtime verification hook the plan asks WP3 to add.
  const verify = h.events.filter((e) => e.name === 'journal_runstart_verify').pop()
  ok('the run-key verification fired', !!verify)
  eq('and it matched', [verify.props.matched, verify.props.stored], [true, 1786000000])
})

await section('a reader hiccup is not the game going away (audit A11)', async () => {
  const h = await harness('hiccup', { menuDebounceMs: 1000, processGoneGraceMs: 20 })
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  const id = h.recorder.activeRunId

  // Reads are failing inside a live run: `nGame: null` looks exactly like the
  // main menu, and only the error streak tells them apart.
  await h.feed({ nGame: null, errorStreak: 4 })
  h.advance(30_000)
  await h.feed({ nGame: null, errorStreak: 7 })
  eq('the menu debounce is paused while reads fail', h.recorder.activeRunId, id)

  // A fabricated processGone with the window still detected is a hiccup.
  h.recorder.onSignal({ type: 'processGone', errorStreak: 40 })
  await new Promise((r) => setTimeout(r, 40))
  eq('an uncorroborated processGone suspends nothing', h.recorder.activeRunId, id)
  ok('and it is reported', h.hasIssue('journal_process_gone_uncorroborated'))

  // Corroborated by the detector, it is a real suspension.
  h.recorder.onProcess({ detected: false })
  await settle()
  eq('a corroborated one does suspend', h.recorder.activeRunId, null)
})

await section('game over closes the run, behind a two-poll guard (Q9)', async () => {
  const h = await harness('close')
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  const id = h.recorder.activeRunId
  await h.feed({ floor: 2 })

  await h.feed({ floor: 2, gameOver: true })
  eq('one flicker does not close a run', h.recorder.activeRunId, id)
  await h.feed({ floor: 2, gameOver: true })
  eq('two consecutive polls do', h.recorder.activeRunId, null)

  const run = await h.store.getRun(id)
  eq('closed', run.state, 'closed')
  eq('honest outcome until the variant reader lands', run.outcome, 'ended')
  ok('game_over written', types(run).includes('game_over'))
  ok('the final deck is grouped', run.finalDeck.length > 0)
  eq('queued for analysis', run.analysisStatus, 'pending')
  eq('a closed run is never a candidate again', h.store.candidates('IRONCLAD').length, 0)

  // The false-close signature: the same deck reappearing right after a close
  // must NOT open a duplicate mid-run file.
  await h.feed({ floor: 2 }, 4)
  eq('no duplicate file', h.store.list().length, 1)
  ok('the suspect close is reported', h.hasIssue('journal_close_then_exact_sighting'))
})

await section('D10 — a character switch suspends rather than kills', async () => {
  const h = await harness('switch')
  await h.recorder.start()
  await h.feed({ floor: 1, runStartTime: 111 }, 3)
  const first = h.recorder.activeRunId
  await h.feed({ character: 'silent', deck: ['SNEAK#0', 'DEFEND#0', 'STRIKE#0', 'NEUTRALIZE#0'], runStartTime: 222 }, 3)
  const second = h.recorder.activeRunId
  ok('a second run opened', second && second !== first)
  const before = await h.store.getRun(first)
  eq('the first run is suspended, not closed', before.state, 'suspended')
  eq('with the right reason', before.sessions[0].reason, 'character-switch')
  ok('and it is still resumable', h.store.candidates('IRONCLAD').some((c) => c.id === first))
})

await section('mid-run attach is partial by construction', async () => {
  const h = await harness('midrun')
  await h.recorder.start()
  await h.feed({ deck: [...DEEP], act: 1, floor: 22 }, 3)
  const run = await h.run()
  eq('joined mid-run', run.observedFrom, 'mid-run')
  eq('and says so', run.countsArePartial, true)
  eq('no start time we can honestly claim', run.startedAt, null)
  eq('our own room count starts at zero', run.roomsEntered, 0)
  eq("but the game's floor is honest", run.floorReached, 22)
})

// ── 6. deferred supersession (audit A5) ──────────────────────────────────────

await section('supersession waits for the new run to be confirmed', async () => {
  const h = await harness('supersede', { confirmMs: 10_000_000 })
  await h.recorder.start()
  // An abandoned deep run sitting in the archive.
  const stale = h.store.createRun({
    character: 'ironclad',
    observedFrom: 'start',
    startedAt: 1,
    firstSeenAt: 1
  })
  stale.state = 'suspended'
  stale.snapshot = {
    ...stale.snapshot,
    act: 2,
    deck: [...DEEP].sort(),
    deckHash: deckHashOf([...DEEP].sort()),
    deckSize: DEEP.length
  }
  stale.actReached = 2
  h.store.save(stale, { immediate: true })
  await h.store.flush()

  await h.feed({ floor: 1 }, 3)
  const fresh = h.recorder.activeRunId
  ok('a new run opened (D5)', fresh && fresh !== stale.id)
  eq('the old run is NOT retired on the sighting alone', (await h.store.getRun(stale.id)).state, 'suspended')

  // A second room is evidence beyond the sighting.
  await h.feed({ floor: 2 })
  await settle()
  const loser = await h.store.getRun(stale.id)
  eq('confirmed, then swept', loser.state, 'abandoned')
  eq('with the reason named', loser.outcome, 'superseded')
  eq('and the successor named', loser.supersededBy, fresh)
  ok('the loser records it', loser.events.some((e) => e.type === 'superseded'))
})

// ── 7. the ambiguity banner, both answers ────────────────────────────────────

async function ambiguityFixture(tag) {
  const h = await harness(tag)
  await h.recorder.start()
  const older = h.store.createRun({
    character: 'ironclad',
    observedFrom: 'start',
    startedAt: 1,
    firstSeenAt: 1
  })
  older.state = 'suspended'
  older.actReached = 0
  older.roomsEntered = 2
  older.snapshot = {
    ...older.snapshot,
    act: 0,
    roomIndex: 2,
    deck: [...STARTER].sort(),
    deckHash: deckHashOf([...STARTER].sort()),
    deckSize: STARTER.length
  }
  older.sessions = [
    { sid: 1, attachedAt: 1, detachedAt: 2, reason: 'menu', activeMs: 1000, playerCount: 1, gameVersion: null }
  ]
  older.events = [
    { t: 1, type: 'session_attach', sid: 1, fresh: true },
    { t: 2, type: 'room_enter', roomType: 'combat', roomIndex: 1, actIndex: 0, floor: 1 },
    { t: 2, type: 'session_detach', sid: 1, reason: 'menu' }
  ]
  h.store.save(older, { immediate: true })
  await h.store.flush()

  await h.feed({ floor: 1 }, 3)
  return { h, older }
}

await section('an ambiguous sighting forks provisionally and raises the banner', async () => {
  const { h, older } = await ambiguityFixture('ambig')
  const provisionalId = h.recorder.activeRunId
  ok('a NEW file was opened, not a silent merge', provisionalId !== older.id)
  const provisional = await h.store.getRun(provisionalId)
  eq('flagged', provisional.ambiguity.candidateId, older.id)
  eq('unanswered', provisional.ambiguity.resolution, null)
  ok('the question is in the log', types(provisional).includes('ambiguity_raised'))
  eq('the candidate is untouched', (await h.store.getRun(older.id)).state, 'suspended')
  eq('the banner has something to show', h.store.pendingResolutions().length, 1)
  // The banner reads the catalog row, not the live key — one place, one answer.
  eq('and the row carries it', h.store.list().find((e) => e.id === provisionalId).ambiguity.candidateId, older.id)
})

await section("answering 'fresh' leaves the provisional standing", async () => {
  const { h, older } = await ambiguityFixture('ambig-fresh')
  const provisionalId = h.recorder.activeRunId
  const res = await h.recorder.resolveAmbiguity(provisionalId, 'fresh')
  eq('nothing merged', [res.id, res.merged], [provisionalId, false])
  eq('the banner clears', h.store.pendingResolutions().length, 0)
  const provisional = await h.store.getRun(provisionalId)
  eq('answered', provisional.ambiguity.resolution, 'fresh')
  ok('the answer is in the log', types(provisional).includes('ambiguity_resolved'))
  eq('both runs survive', h.store.list().length, 2)
  eq('the candidate is still resumable', (await h.store.getRun(older.id)).state, 'suspended')
})

await section("answering 'resumed' merges the provisional into the candidate", async () => {
  const { h, older } = await ambiguityFixture('ambig-merge')
  const provisionalId = h.recorder.activeRunId
  await h.feed({ floor: 2 })
  const provisional = await h.store.getRun(provisionalId)
  const provisionalEvents = provisional.events.length
  const provisionalRooms = provisional.roomsEntered
  const olderEvents = older.events.length
  const olderRooms = older.roomsEntered

  const res = await h.recorder.resolveAmbiguity(provisionalId, 'resumed')
  eq('the candidate survives', [res.id, res.merged], [older.id, true])
  eq('one run, not two', h.store.list().length, 1)
  ok('the provisional file is gone', !existsSync(join(h.dir, runFileName(provisionalId))))

  const merged = await h.store.getRun(older.id)
  ok('every event folded in', merged.events.length >= provisionalEvents + olderEvents)
  ok('in timestamp order', merged.events.every((e, i, all) => i === 0 || all[i - 1].t <= e.t))
  ok('the merge is recorded', types(merged).includes('merged_from'))
  eq('sessions were renumbered without collision', new Set(merged.sessions.map((s) => s.sid)).size, merged.sessions.length)
  eq('rooms add up', merged.roomsEntered, olderRooms + provisionalRooms)
  eq('a merge is honest about being partial', merged.countsArePartial, true)
  eq('the flag is gone', merged.ambiguity, null)
  eq('the banner is empty', h.store.pendingResolutions().length, 0)

  // The recorder was writing into the provisional; it must keep recording.
  eq('the live recorder followed the merge', h.recorder.activeRunId, older.id)
  await h.feed({ floor: 3 })
  eq('and keeps writing to the survivor', (await h.store.getRun(older.id)).roomsEntered >= 4, true)
})

// ── 8. crash orphans ─────────────────────────────────────────────────────────

await section('a crash orphan is demoted, folded and made resumable', async () => {
  const dir = await freshDir('orphan')
  await mkdir(dir, { recursive: true })
  const at = 1786662011000
  const id = newRunId('ironclad', at, 'orph01')
  const run = newRunFile(id, {
    character: 'ironclad',
    observedFrom: 'start',
    startedAt: at,
    firstSeenAt: at,
    runStartTime: 1786000000
  })
  run.state = 'recording'
  run.lastSeenAt = at + 1000
  run.roomsEntered = 2
  run.sessions = [
    { sid: 1, attachedAt: at, detachedAt: null, reason: null, activeMs: 500, playerCount: 1, gameVersion: null }
  ]
  run.snapshot = {
    ...run.snapshot,
    act: 0,
    roomIndex: 2,
    deck: [...STARTER].sort(),
    deckHash: deckHashOf([...STARTER].sort()),
    deckSize: STARTER.length,
    eventCount: 1,
    openCombat: { startT: at + 900, endT: null, roomIndex: 2, enemies: 2, plays: [{ id: 'STRIKE', count: 3 }], drawn: [] }
  }
  // One event the snapshot had not absorbed when the process died.
  run.events = [
    { t: at, type: 'session_attach', sid: 1, fresh: true },
    { t: at + 950, type: 'deck_add', id: 'CARNAGE', upgradeLevel: 0 }
  ]
  await writeFile(join(dir, runFileName(id)), serializeRun(run), 'utf8')

  const store = new RunStore({ baseDir: dir, env: {}, onIssue: () => {} })
  const issues = []
  const recorder = new RunRecorder({
    store,
    env: {},
    onIssue: (key, severity, props) => issues.push({ key, severity, props })
  })
  await recorder.start()

  const after = await store.getRun(id)
  eq('demoted to suspended', after.state, 'suspended')
  eq('the dangling session is closed', after.sessions[0].reason, 'app-quit')
  eq('the open combat is aborted', after.combats[0].aborted, true)
  eq('no combat left open', after.snapshot.openCombat, null)
  ok('the trailing event was folded', after.snapshot.deck.includes('CARNAGE#0'))
  eq('the snapshot is caught up', after.snapshot.eventCount, after.events.length)
  ok('the demotion is reported', issues.some((i) => i.key === 'journal_orphan_demoted'))
  eq('and it is a full resume candidate', store.candidates('IRONCLAD').length, 1)
  eq('with its run key intact', store.candidates('IRONCLAD')[0].runStartTime, 1786000000)
  store.dispose()
  recorder.dispose()
})

await section('the quit path writes synchronously, and twice is harmless', async () => {
  const h = await harness('quit')
  await h.recorder.start()
  await h.feed({ floor: 1 }, 3)
  const id = h.recorder.activeRunId
  await h.feed({ floor: 2 })

  // No awaits after this line: the real process would be gone.
  h.recorder.flushSync()
  const onDisk = JSON.parse(await readFile(join(h.dir, runFileName(id)), 'utf8'))
  eq('the session was ended honestly', onDisk.state, 'suspended')
  eq('with the quit reason', onDisk.sessions[0].reason, 'app-quit')
  eq('and the last room made it to disk', onDisk.roomsEntered, 2)
  ok('not left as a crash orphan', onDisk.sessions[0].detachedAt !== null)

  h.recorder.flushSync()
  ok('a second will-quit changes nothing', existsSync(join(h.dir, runFileName(id))))
  h.recorder.dispose()
  h.store.dispose()
})

// ── 9. pure derivation helpers ───────────────────────────────────────────────

await section('derivation helpers', async () => {
  eq(
    'the final deck is grouped by id and upgrade',
    groupDeck(['STRIKE#0', 'STRIKE#0', 'BASH#1']),
    [
      { id: 'BASH', upgradeLevel: 1, count: 1 },
      { id: 'STRIKE', upgradeLevel: 0, count: 2 }
    ]
  )
  eq(
    'aggregates skip aborted combats',
    aggregateCombats([
      { startT: 0, endT: 1, roomIndex: 1, enemies: 1, plays: [{ id: 'A', count: 2 }], drawn: [] },
      { startT: 2, endT: 3, roomIndex: 2, enemies: 1, plays: [{ id: 'A', count: 9 }], drawn: [], aborted: true }
    ]),
    { plays: { A: 2 }, drawn: {} }
  )

  // A fold that has to undo an upgrade the snapshot never saw.
  const run = newRunFile('x', { character: 'ironclad', observedFrom: 'start', startedAt: 0 })
  run.snapshot = { ...run.snapshot, deck: ['BASH#0', 'STRIKE#0'], deckSize: 2, eventCount: 0, roomIndex: 0 }
  run.events = [
    { t: 1, type: 'deck_upgrade', id: 'BASH', upgradeLevel: 1, from: 0 },
    { t: 2, type: 'room_enter', roomType: 'combat', roomIndex: 1, actIndex: 0, floor: 1 },
    { t: 3, type: 'act_change', from: 0, to: 1 }
  ]
  foldTrailingEvents(run)
  eq('the fold applied the upgrade', run.snapshot.deck, ['BASH#1', 'STRIKE#0'])
  eq('and the room', run.snapshot.roomIndex, 1)
  eq('and the act', run.snapshot.act, 1)
  eq('and caught the counter up', run.snapshot.eventCount, 3)

  // Merging two files must not collide session ids.
  const a = newRunFile('a', { character: 'ironclad', observedFrom: 'start', startedAt: 0 })
  a.sessions = [{ sid: 1, attachedAt: 0, detachedAt: 1, reason: 'menu', activeMs: 1, playerCount: 1, gameVersion: null }]
  a.events = [{ t: 0, type: 'session_attach', sid: 1 }]
  const b = newRunFile('b', { character: 'ironclad', observedFrom: 'start', startedAt: 2 })
  b.sessions = [{ sid: 1, attachedAt: 2, detachedAt: null, reason: null, activeMs: 1, playerCount: 1, gameVersion: null }]
  b.events = [{ t: 2, type: 'session_attach', sid: 1 }]
  mergeRunInto(a, b, 3)
  eq('sessions renumbered', a.sessions.map((s) => s.sid), [1, 2])
  eq('and their events with them', a.events.find((e) => e.t === 2).sid, 2)
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
