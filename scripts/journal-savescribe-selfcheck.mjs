/**
 * Self-check for `SaveScribe.ts` — the merge of the game's own history files
 * into the journal's run files (docs/save-merge-plan.md, WP-S1).
 *
 * Its siblings cover persistence (`journal-selfcheck.mjs`), the state machine
 * (`journal-recorder-selfcheck.mjs`) and the review pipeline
 * (`journal-analysis-selfcheck.mjs`); nothing here re-tests those. What it does
 * test is everything that can go wrong between a `.run` file on disk and a
 * merged `saveData` section:
 *
 *   - **discovery** over a fixture `%APPDATA%` tree, including `modded\`
 *     profiles and the profiles that were never played;
 *   - **parsing** the real schema — the outcome truth table, the per-floor
 *     ledger, card offers picked *and* skipped, relic counters, the multiplayer
 *     roster and its opaque player keys;
 *   - **the terminality gate**, which is the one thing standing between this
 *     module and closing a run somebody is still playing;
 *   - **matching**: the exact run-key join, the window+deck fallback, and every
 *     way of declining to guess — character conflict, ambiguity, no candidate;
 *   - **merging**: outcome and state upgrades, the fields it fills, the fields
 *     it must not touch, and the one event it appends;
 *   - **the sweep's economics**: a second sweep opens nothing, a file that
 *     changes is re-read, and a merge is idempotent;
 *   - **the defensive read**, driven through an fs adapter that refuses the
 *     locked file exactly as Windows does;
 *   - and, asserted after every single case, that **nothing under the game's
 *     directory was written, renamed or even touched**.
 *
 *   node scripts/journal-savescribe-selfcheck.mjs [--keep]
 */

import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, utimes } from 'fs/promises'
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
  const dir = await mkdtemp(join(tmpdir(), `savescribe-${tag}-`))
  tempDirs.push(dir)
  return dir
}

// ── bundle the TypeScript under test ─────────────────────────────────────────

const outDir = join(tmpdir(), 'journal-savescribe-selfcheck-bundle')
const entry = join(outDir, 'entry.ts')
const outFile = join(outDir, 'savescribe.mjs')
await mkdir(outDir, { recursive: true })
await writeFile(
  entry,
  [
    `export * from ${JSON.stringify(join(repo, 'src/main/journal/RunStore.ts').replace(/\\/g, '/'))}`,
    `export * from ${JSON.stringify(join(repo, 'src/main/journal/SaveScribe.ts').replace(/\\/g, '/'))}`,
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
  SaveScribe,
  parseSaveRun,
  parseSaveIndex,
  saveResultOf,
  localPlayerOf,
  deckIsSubset,
  matchByRunKey,
  mergeSaveIntoRun,
  toSaveData,
  startTimeFromFileName,
  isHistoryFileName,
  steamIdFromPath,
  stripSavePrefix,
  saveDiscoveryDirs,
  relicHashOf,
  SAVE_INDEX_FILE,
  MAX_SAVE_SCHEMA
} = mod

// ── fixtures: the game's own file format ─────────────────────────────────────

/** One `player_stats` row, with only the fields a case actually exercises. */
function stats(playerKey, extra = {}) {
  return {
    player_id: typeof playerKey === 'string' ? Number(playerKey) || playerKey : playerKey,
    current_hp: 60,
    max_hp: 80,
    damage_taken: 13,
    hp_healed: 0,
    current_gold: 118,
    gold_gained: 19,
    gold_spent: 0,
    ...extra
  }
}

/** One entered map point. */
function point(type, room, playerStats) {
  return { map_point_type: type, rooms: [room], player_stats: playerStats }
}

/**
 * A history file as the game writes it. Defaults describe a solo Ironclad run
 * that ended in a Fogmog fight; every case overrides only what it is about.
 */
function saveJson(opts = {}) {
  const id = opts.playerId ?? 1
  return {
    schema_version: opts.schemaVersion ?? 9,
    build_id: opts.buildId ?? 'v0.107.1',
    seed: opts.seed ?? 'DHDDFVFJ08',
    start_time: opts.startTime ?? 1786603375,
    run_time: 40779,
    win: opts.win ?? false,
    was_abandoned: opts.wasAbandoned ?? true,
    killed_by_encounter: opts.killedByEncounter ?? 'ENCOUNTER.FOGMOG_NORMAL',
    killed_by_event: opts.killedByEvent ?? 'NONE.NONE',
    ascension: opts.ascension ?? 3,
    game_mode: 'standard',
    modifiers: [],
    platform_type: 'steam',
    acts: ['ACT.OVERGROWTH', 'ACT.HIVE', 'ACT.GLORY'],
    players: opts.players ?? [
      {
        id,
        character: 'CHARACTER.IRONCLAD',
        max_potion_slot_count: 3,
        deck: opts.deck ?? [
          { id: 'CARD.STRIKE_IRONCLAD', floor_added_to_deck: 1 },
          { id: 'CARD.BASH', floor_added_to_deck: 1 },
          { id: 'CARD.ARMAMENTS', floor_added_to_deck: 1, current_upgrade_level: 1 }
        ],
        relics: [
          { id: 'RELIC.BURNING_BLOOD', floor_added_to_deck: 1 },
          {
            id: 'RELIC.FISHING_ROD',
            floor_added_to_deck: 1,
            props: { ints: [{ name: 'CombatsSeen', value: 4 }] }
          }
        ],
        potions: [{ id: 'POTION.SWIFT_POTION', slot_index: 1 }],
        badges: [{ id: 'DAMAGE_LEADER', rarity: 'bronze' }]
      }
    ],
    map_point_history: opts.mapPointHistory ?? [
      [
        point('ancient', { model_id: 'EVENT.NEOW', room_type: 'event' }, [
          stats(id, {
            ancient_choice: [
              { TextKey: 'PAELS_TEARS', was_chosen: false },
              { TextKey: 'PAELS_TOOTH', was_chosen: true }
            ]
          })
        ]),
        point(
          'monster',
          {
            model_id: 'ENCOUNTER.NIBBITS_WEAK',
            room_type: 'monster',
            monster_ids: ['MONSTER.NIBBIT'],
            turns_taken: 3
          },
          [
            stats(id, {
              card_choices: [
                { card: { id: 'CARD.SETUP_STRIKE', floor_added_to_deck: 1 }, was_picked: true },
                { card: { id: 'CARD.TREMBLE' }, was_picked: false },
                { card: { id: 'CARD.BLOOD_WALL' }, was_picked: false }
              ],
              cards_gained: [{ id: 'CARD.SETUP_STRIKE', floor_added_to_deck: 1 }],
              event_choices: [
                {
                  title: { key: 'BYRDONIS_NEST.pages.INITIAL.options.TAKE.title', table: 'events' },
                  variables: {
                    Card: {
                      type: 'DynamicString',
                      decimal_value: 0,
                      bool_value: false,
                      string_value: 'Byrdonis Egg'
                    }
                  }
                }
              ],
              rest_site_choices: ['SMITH'],
              upgraded_cards: ['CARD.ARMAMENTS'],
              cards_removed: [{ id: 'CARD.STRIKE_IRONCLAD', floor_added_to_deck: 1 }],
              bought_relics: ['RELIC.BRONZE_SCALES'],
              gold_spent: 150
            })
          ]
        ),
        point(
          'monster',
          {
            model_id: 'ENCOUNTER.FOGMOG_NORMAL',
            room_type: 'monster',
            monster_ids: ['MONSTER.FOGMOG', 'MONSTER.EYE_WITH_TEETH'],
            turns_taken: 4
          },
          [stats(id)]
        )
      ],
      // A second act, so the global floor counter has something to carry across.
      [point('monster', { model_id: 'ENCOUNTER.HIVE_ONE', room_type: 'monster' }, [stats(id)])]
    ]
  }
}

/** Write a history file, plus the `.run.backup` sibling the game keeps beside it. */
async function writeSave(dir, startTime, opts = {}) {
  const json = saveJson({ ...opts, startTime })
  const path = join(dir, `${startTime}.run`)
  const text = opts.raw ?? JSON.stringify(json, null, 2).replace(/\n/g, '\r\n')
  await writeFile(path, text, 'utf8')
  await writeFile(`${path}.backup`, text, 'utf8')
  return path
}

// ── fixtures: the journal's own side ─────────────────────────────────────────

async function newStore(tag) {
  const base = await freshDir(tag)
  const store = new RunStore({ baseDir: join(base, 'runs'), env: {}, now: () => 1_000_000 })
  await store.open()
  await store.scan()
  return store
}

/** A journal run in whatever state a case needs, persisted. */
async function seedRun(store, init = {}) {
  const run = store.createRun({
    character: init.character ?? 'ironclad',
    observedFrom: 'start',
    startedAt: init.startedAt ?? 1_786_600_000_000,
    runStartTime: init.runStartTime === undefined ? 1786603375 : init.runStartTime
  })
  run.state = init.state ?? 'suspended'
  run.outcome = init.outcome ?? null
  run.lastSeenAt = init.lastSeenAt ?? 1_786_690_000_000
  run.snapshot.deck = init.deck ?? ['STRIKE_IRONCLAD#0', 'BASH#0', 'ARMAMENTS#1']
  run.snapshot.deckSize = run.snapshot.deck.length
  run.analysisStatus = init.analysisStatus ?? 'done'
  if (init.finalDeck) run.finalDeck = init.finalDeck
  if (init.ambiguity) run.ambiguity = init.ambiguity
  store.save(run, { immediate: true })
  await store.flush()
  return run
}

/** A scribe wired for tests: no real waiting, no ambient environment. */
function newScribe(store, historyDirs, opts = {}) {
  const merged = []
  const catalogs = []
  const issues = []
  const events = []
  const scribe = new SaveScribe({
    store,
    historyDirs,
    env: {},
    now: opts.now ?? (() => 1_800_000_000_000),
    sleep: () => Promise.resolve(),
    stabilityMs: 0,
    watchDebounceMs: 1,
    tmpDir: opts.tmpDir,
    fs: opts.fs,
    onMerged: (id) => merged.push(id),
    onCatalog: (entries) => catalogs.push(entries),
    onIssue: (key, severity, props) => issues.push({ key, severity, props }),
    onEvent: (name, props) => events.push({ name, props }),
    ...(opts.appDataDir ? { appDataDir: opts.appDataDir, historyDirs: undefined } : {})
  })
  return { scribe, merged, catalogs, issues, events }
}

/** Fingerprint a directory tree so "we never wrote here" can be asserted, not asserted-ish. */
async function fingerprint(dir) {
  const names = (await readdir(dir)).sort()
  const out = []
  for (const name of names) {
    const s = await stat(join(dir, name))
    out.push(`${name}:${s.size}:${Math.round(s.mtimeMs)}`)
  }
  return out.join('|')
}

// ── 1. pure helpers ──────────────────────────────────────────────────────────

await section('file naming and identity', async () => {
  eq('a history file is recognised', isHistoryFileName('1786603375.run'), true)
  eq('the backup sibling is not', isHistoryFileName('1786603375.run.backup'), false)
  eq('nor is anything else', isHistoryFileName('progress.save'), false)
  eq('the name is the join key', startTimeFromFileName('1786603375.run'), 1786603375)
  eq('a non-numeric name has none', startTimeFromFileName('current_run.run'), null)
  eq(
    'the steam id comes off the path',
    steamIdFromPath('C:\\x\\SlayTheSpire2\\steam\\76561199096588786\\profile1\\saves\\history\\1.run'),
    '76561199096588786'
  )
  eq('and is null when the path has none', steamIdFromPath('C:\\fixtures\\history\\1.run'), null)
  eq('ids lose the game prefix', stripSavePrefix('CARD.STRIKE_IRONCLAD'), 'STRIKE_IRONCLAD')
  eq('and survive not having one', stripSavePrefix('STRIKE'), 'STRIKE')
})

await section('the outcome truth table (§1.3)', async () => {
  const call = (win, ab, enc, ev) =>
    saveResultOf({ win, wasAbandoned: ab, killedByEncounter: enc, killedByEvent: ev })
  eq('win', call(true, false, null, null), 'victory')
  eq('killed by an encounter', call(false, false, 'ENCOUNTER.QUEEN_BOSS', null), 'death')
  eq('killed by an event', call(false, false, null, 'EVENT.NEOW'), 'death')
  // The row that costs the most to get wrong: an abandoned run still names the
  // room it was abandoned in, so `killed_by` alone would call it a death.
  eq('abandoned, despite naming a room', call(false, true, 'ENCOUNTER.FOGMOG_NORMAL', null), 'abandoned')
  eq('all three negative proves nothing', call(false, false, null, null), null)
})

await section('discovery is refused to synthetic processes', async () => {
  eq('a live process discovers normally', saveDiscoveryDirs({}), null)
  eq('a stub process discovers nothing', saveDiscoveryDirs({ SPECTRA_STUB: '1' }), [])
  eq('a capture run discovers nothing', saveDiscoveryDirs({ SPECTRA_CAPTURE: '1' }), [])
  eq('a stub journal discovers nothing', saveDiscoveryDirs({ SPECTRA_JOURNAL_STUB: '1' }), [])
  eq(
    'and the escape hatch wins over all of it',
    saveDiscoveryDirs({ SPECTRA_STUB: '1', SPECTRA_SAVE_DIR: 'C:\\fixtures\\history' }),
    ['C:\\fixtures\\history']
  )
})

// ── 2. parsing the real schema ───────────────────────────────────────────────

await section('parsing one history file', async () => {
  const parsed = parseSaveRun(
    JSON.stringify(saveJson()),
    'C:\\x\\SlayTheSpire2\\steam\\76561199096588786\\profile1\\saves\\history\\1786603375.run'
  )
  ok('it parses', parsed.ok, JSON.stringify(parsed))
  const save = parsed.save
  eq('the seed survives', save.seed, 'DHDDFVFJ08')
  eq('the join key survives', save.startTime, 1786603375)
  eq('the outcome is decided', save.result, 'abandoned')
  eq('the killer is named', save.killedByEncounter, 'ENCOUNTER.FOGMOG_NORMAL')
  eq('and the empty one is null, not "NONE.NONE"', save.killedByEvent, null)
  eq('ascension comes from the save', save.ascension, 3)
  eq('the build id too', save.buildId, 'v0.107.1')

  eq('every entered floor is flattened', save.floors.length, 4)
  eq('the global floor counts across acts', save.floors.map((f) => f.globalFloor), [1, 2, 3, 4])
  eq('the act index rides along', save.floors.map((f) => f.act), [0, 0, 0, 1])
  eq('and names its act', save.floors[3].actId, 'ACT.HIVE')
  eq('the map point type is kept', save.floors[0].mapPointType, 'ancient')
  eq('as is what the node resolved into', save.floors[2].rooms[0].modelId, 'ENCOUNTER.FOGMOG_NORMAL')
  eq('with the enemies named', save.floors[2].rooms[0].monsterIds, [
    'MONSTER.FOGMOG',
    'MONSTER.EYE_WITH_TEETH'
  ])
  eq('and the turns counted', save.floors[2].rooms[0].turnsTaken, 4)

  const floor = save.floors[1].players[0]
  eq('hp is readable per floor', floor.currentHp, 60)
  eq('so is gold', floor.currentGold, 118)
  // The gap backfill: the journal can only record offers it was watching for.
  eq('every card offer is kept, picked and skipped', floor.cardChoices.length, 3)
  eq('with the pick marked', floor.cardChoices.filter((c) => c.wasPicked).map((c) => c.id), [
    'CARD.SETUP_STRIKE'
  ])
  eq('removals are kept', floor.cardsRemoved.map((c) => c.id), ['CARD.STRIKE_IRONCLAD'])
  eq('upgrades are kept', floor.cardsUpgraded, ['CARD.ARMAMENTS'])
  eq('rest choices are kept', floor.restChoices, ['SMITH'])
  eq('purchases are kept', floor.boughtRelics, ['RELIC.BRONZE_SCALES'])
  eq('and what they cost in aggregate', floor.goldSpent, 150)
  eq(
    'the event option is kept by key',
    floor.eventChoices[0].key,
    'BYRDONIS_NEST.pages.INITIAL.options.TAKE.title'
  )
  eq('with its dynamic text flattened', floor.eventChoices[0].variables, { Card: 'Byrdonis Egg' })
  eq('the start-node offer keeps every option', save.floors[0].players[0].ancientChoices.length, 2)
  eq(
    'and which was taken',
    save.floors[0].players[0].ancientChoices.filter((c) => c.wasChosen).map((c) => c.id),
    ['PAELS_TOOTH']
  )

  const player = save.players[0]
  eq('the character is normalised the journal way', player.character, 'IRONCLAD')
  eq('a solo roster is known to be us', player.isLocal, true)
  eq('the final deck carries obtain floors', player.finalDeck[0].floorAdded, 1)
  eq('and upgrade levels', player.finalDeck[2].upgradeLevel, 1)
  eq('relics carry their floor', player.relics[0].floorAdded, 1)
  eq('and their counters', player.relics[1].props, { CombatsSeen: 4 })
  eq('potions carry their slot', player.potions[0].slotIndex, 1)
  eq('badges survive', player.badges[0], { id: 'DAMAGE_LEADER', rarity: 'bronze' })
})

await section('parsing a multiplayer file', async () => {
  const me = 76561199096588786
  const them = 76561198063554980
  const roster = [me, them].map((id) => ({
    id,
    character: id === me ? 'CHARACTER.IRONCLAD' : 'CHARACTER.NECROBINDER',
    deck: [{ id: 'CARD.STRIKE_IRONCLAD' }],
    relics: [],
    potions: [],
    badges: []
  }))
  const parsed = parseSaveRun(
    JSON.stringify(
      saveJson({
        players: roster,
        win: true,
        wasAbandoned: false,
        killedByEncounter: 'NONE.NONE',
        mapPointHistory: [[point('boss', { model_id: 'ENCOUNTER.QUEEN_BOSS', room_type: 'boss' }, [
          stats(me),
          stats(them)
        ])]]
      })
    ),
    `C:\\x\\SlayTheSpire2\\steam\\${me}\\profile1\\saves\\history\\1786603375.run`
  )
  ok('it parses', parsed.ok)
  const save = parsed.save
  eq('the whole roster is kept', save.players.length, 2)
  // Q3: the local player is the id that also names the directory. Anything else
  // would be `players[0]` with a story attached.
  eq(
    'the local player is the one naming the directory',
    save.players.filter((p) => p.isLocal).map((p) => p.character),
    ['IRONCLAD']
  )
  eq('the teammate is known not to be us', save.players[1].isLocal, false)
  eq('player keys are opaque strings', typeof save.players[0].playerKey, 'string')
  eq('and they join the per-floor stats', save.floors[0].players.map((p) => p.playerKey), [
    String(me),
    String(them)
  ])
  eq('the outcome is a victory', save.result, 'victory')

  // Without a directory to attribute the roster to, the honest answer is "no idea".
  const anon = parseSaveRun(JSON.stringify(saveJson({ players: roster })), 'C:\\fixtures\\1.run')
  eq('an unattributable roster says so', anon.save.players.map((p) => p.isLocal), [null, null])
  eq('and no local player is picked', localPlayerOf(anon.save.players, 'DEFECT'), null)
  eq(
    'unless the character is unambiguous',
    localPlayerOf(anon.save.players, 'ironclad')?.character,
    'IRONCLAD'
  )
})

await section('refusing what it cannot read', async () => {
  eq('a truncated file is unparseable', parseSaveRun('{"schema_version":9,').reason, 'unparseable')
  eq('so is a JSON non-object', parseSaveRun('[]').reason, 'unparseable')
  eq(
    'so is a file with no join key',
    parseSaveRun(JSON.stringify({ schema_version: 9, players: [] })).reason,
    'unparseable'
  )
  const newer = parseSaveRun(JSON.stringify(saveJson({ schemaVersion: MAX_SAVE_SCHEMA + 1 })))
  eq('a newer schema is refused, not guessed at', newer.reason, 'unsupported-schema')
  eq('and reports the version it saw', newer.schema, MAX_SAVE_SCHEMA + 1)
  ok('the highest verified schema is 11', MAX_SAVE_SCHEMA === 11)
})

// ── 3. matching ──────────────────────────────────────────────────────────────

await section('matching is a lookup, not a heuristic', async () => {
  const save = parseSaveRun(JSON.stringify(saveJson())).save
  const row = (over) => ({
    id: 'a',
    character: 'IRONCLAD',
    runStartTime: 1786603375,
    state: 'suspended',
    ambiguity: null,
    unreadable: false,
    firstSeenAt: 0,
    lastSeenAt: 0,
    deck: null,
    ...over
  })

  eq('an exact key match merges', matchByRunKey([row()], save).matchedBy, 'run-key')
  eq('a different key does not match at all', matchByRunKey([row({ runStartTime: 5 })], save), null)
  eq(
    'the same key with the wrong character is a conflict',
    matchByRunKey([row({ character: 'DEFECT' })], save).kind,
    'conflict'
  )
  eq(
    'the live run is left to the recorder',
    matchByRunKey([row({ state: 'recording' })], save).kind,
    'recording'
  )
  // Two rows on one key can only come from the ambiguity banner's provisionals.
  const unresolved = { candidateId: 'b', raisedAt: 0, resolution: null, resolvedAt: null }
  eq(
    'two undecided rows on one key park rather than pick',
    matchByRunKey(
      [row({ ambiguity: unresolved }), row({ id: 'b', ambiguity: unresolved })],
      save
    ).kind,
    'unmatched'
  )
  eq(
    'but a decided one wins over a provisional',
    matchByRunKey([row({ id: 'b', ambiguity: unresolved }), row()], save).entry.id,
    'a'
  )
})

await section('the deck subset test behind the fallback', async () => {
  const save = parseSaveRun(JSON.stringify(saveJson())).save
  const player = save.players[0]
  ok('the journal deck is a subset', deckIsSubset(['STRIKE_IRONCLAD#0', 'BASH#0'], player))
  ok(
    'upgrade levels are ignored, as A2 does',
    deckIsSubset(['ARMAMENTS#0'], player),
    'base ids only'
  )
  ok('a card the save never had is not', !deckIsSubset(['DEMON_FORM#0'], player))
  ok('and neither is one copy too many', !deckIsSubset(['BASH#0', 'BASH#0'], player))
})

// ── 4. the merge itself ──────────────────────────────────────────────────────

await section('merging into a run file', async () => {
  const store = await newStore('merge-unit')
  const run = await seedRun(store)
  const save = parseSaveRun(JSON.stringify(saveJson())).save
  const data = toSaveData(save, { path: 'C:\\h\\1786603375.run', mtimeMs: 5000, bytes: 900 }, 'run-key', 7777)
  const outcome = mergeSaveIntoRun(run, data, 7777)

  eq('the section lands', run.saveData.seed, 'DHDDFVFJ08')
  eq('the outcome is upgraded', run.outcome, 'abandoned')
  eq('and the run stops being a resume candidate', run.state, 'abandoned')
  eq('the end time comes from the file mtime', run.endedAt, 5000)
  eq('ascension is filled', run.ascension, 3)
  eq('the floor count is authoritative', run.floorReached, 4)
  eq('so is the act reached', run.actReached, 1)
  eq('relics arrive', run.relics, ['BURNING_BLOOD', 'FISHING_ROD'])
  eq('potions arrive', run.potions, ['SWIFT_POTION'])
  eq('and the relic hash the signature was missing', run.signature.relicHash, relicHashOf(['BURNING_BLOOD', 'FISHING_ROD']))
  eq('the final deck is grouped from the save', run.finalDeck.length, 3)
  eq('no deck disagreement was found', outcome.deckMismatch, false)

  // The one event: an observation about the merge, never about its content.
  const merges = run.events.filter((e) => e.type === 'save_merged')
  eq('one merge event is appended', merges.length, 1)
  eq('naming the file', merges[0].file, 'C:\\h\\1786603375.run')
  eq('and how it matched', merges[0].matchedBy, 'run-key')
  eq('the snapshot counter keeps up', run.snapshot.eventCount, run.events.length)
  // §3.4: the observed counts are exactly as partial as they were.
  eq('countsArePartial is left alone', run.countsArePartial, false)

  // Idempotence: the same file merged twice changes nothing and appends nothing.
  const again = mergeSaveIntoRun(run, data, 8888)
  eq('a second merge of the same file changes nothing', again.changed, [])
  eq('and appends no second event', run.events.filter((e) => e.type === 'save_merged').length, 1)
})

await section('the merge fills nulls and nothing else', async () => {
  const store = await newStore('merge-respect')
  const run = await seedRun(store, {
    finalDeck: [{ id: 'DEMON_FORM', upgradeLevel: 0, count: 1 }]
  })
  run.relics = ['ALREADY_KNOWN']
  run.ascension = 20
  run.endedAt = 42
  const save = parseSaveRun(JSON.stringify(saveJson())).save
  const data = toSaveData(save, { path: 'C:\\h\\1.run', mtimeMs: 5000, bytes: 900 }, 'run-key', 7777)
  const outcome = mergeSaveIntoRun(run, data, 7777)

  eq('an observed final deck is not overwritten', run.finalDeck, [
    { id: 'DEMON_FORM', upgradeLevel: 0, count: 1 }
  ])
  // Q8's probe: the disagreement is reported, never silently resolved.
  eq('the disagreement is raised instead', outcome.deckMismatch, true)
  eq('an observed relic list is not overwritten', run.relics, ['ALREADY_KNOWN'])
  eq('an observed ascension is not overwritten', run.ascension, 20)
  eq('an observed end time is not overwritten', run.endedAt, 42)
  // The exception, and the only one: `'ended'` is an admission, not a reading.
  eq('but the outcome always defers to the save', run.outcome, 'abandoned')
})

await section('victory and death close the run', async () => {
  const store = await newStore('merge-outcomes')
  for (const [label, opts, result, state] of [
    ['a victory', { win: true, wasAbandoned: false, killedByEncounter: 'NONE.NONE' }, 'victory', 'closed'],
    ['a death', { win: false, wasAbandoned: false }, 'death', 'closed'],
    ['an abandon', {}, 'abandoned', 'abandoned']
  ]) {
    const run = await seedRun(store, { outcome: 'ended', state: 'suspended' })
    const save = parseSaveRun(JSON.stringify(saveJson(opts))).save
    const data = toSaveData(save, { path: `C:\\h\\${label}.run`, mtimeMs: 1, bytes: 1 }, 'run-key', 1)
    mergeSaveIntoRun(run, data, 1)
    eq(`${label} sets the outcome`, run.outcome, result)
    eq(`${label} sets the state`, run.state, state)
  }
})

// ── 5. the sweep, end to end ─────────────────────────────────────────────────

await section('a sweep merges the run it can and parks the rest', async () => {
  const store = await newStore('sweep')
  const game = join(await freshDir('sweep-game'), 'history')
  await mkdir(game, { recursive: true })

  const run = await seedRun(store, { runStartTime: 1786603375, analysisStatus: 'done' })
  await writeSave(game, 1786603375) // matches the run
  await writeSave(game, 1700000001, { win: true, wasAbandoned: false }) // no journal run
  await writeSave(game, 1700000002, {
    win: false,
    wasAbandoned: false,
    killedByEncounter: 'NONE.NONE'
  }) // not terminal
  await writeSave(game, 1700000003, { raw: '{ this is not json' }) // corrupt
  await writeSave(game, 1700000004, { schemaVersion: 99 }) // from a newer game

  const before = await fingerprint(game)
  const { scribe, merged, catalogs, events } = newScribe(store, [game])
  const result = await scribe.sweep('test')

  eq('every history file was seen', result.files, 5)
  eq('the backups were not', result.parsed, 5)
  eq('one merged', result.merged, 1)
  eq('one had no journal run behind it', result.unmatched, 1)
  eq('one proved nothing', result.notTerminal, 1)
  eq('one would not parse', result.unparseable, 1)
  eq('one was from a newer game', result.unsupported, 1)

  const after = await store.getRun(run.id)
  eq('the matched run is abandoned', after.state, 'abandoned')
  eq('with the save-derived outcome', after.outcome, 'abandoned')
  eq('and the killer named', after.saveData.killedByEncounter, 'ENCOUNTER.FOGMOG_NORMAL')
  eq('matched on the exact key', after.saveData.matchedBy, 'run-key')
  eq('its review is stale and re-queued', after.analysisStatus, 'pending')
  eq('and the queue was told', merged, [run.id])
  ok('the Archive was pushed', catalogs.length >= 1)
  eq('the catalog row says it has save data', store.entry(run.id).hasSaveData, true)
  ok(
    'the non-terminal file raised its probe',
    events.some((e) => e.name === 'journal_save_not_terminal')
  )

  // Rule 1, asserted rather than asserted-ish.
  eq('nothing under the game directory moved', await fingerprint(game), before)

  // §3.5: a second sweep opens nothing it has already decided about. The one
  // exception is the deliberate one — a `not-terminal` file is re-examined
  // every sweep, because a later write is exactly what is expected to resolve it.
  const second = await scribe.sweep('again')
  eq('the second sweep merges nothing', second.merged, 0)
  eq('it re-opens only the file that might still change', second.parsed, 1)
  eq('and skips every settled one', second.skipped, 4)
  eq('the game directory is still untouched', await fingerprint(game), before)

  // The sidecar lives with the journal, never with the game.
  const index = parseSaveIndex(await readFile(join(store.dir, SAVE_INDEX_FILE), 'utf8'))
  const statuses = Object.values(index.files)
    .map((r) => r.status)
    .sort()
  eq('every file is parked with a reason', statuses, [
    'merged',
    'not-terminal',
    'unmatched',
    'unparseable',
    'unsupported-schema'
  ])
  eq(
    'the merged row names its run',
    Object.values(index.files).find((r) => r.status === 'merged').runId,
    run.id
  )
  ok(
    'and the sidecar is not in the game directory',
    !(await readdir(game)).some((n) => n === SAVE_INDEX_FILE)
  )
  scribe.dispose()
})

await section('a non-terminal file is parked, not merged', async () => {
  const store = await newStore('gate')
  const game = join(await freshDir('gate-game'), 'history')
  await mkdir(game, { recursive: true })
  const run = await seedRun(store, { state: 'suspended', outcome: null })
  await writeSave(game, 1786603375, {
    win: false,
    wasAbandoned: false,
    killedByEncounter: 'NONE.NONE',
    killedByEvent: 'NONE.NONE'
  })

  const { scribe } = newScribe(store, [game])
  const result = await scribe.sweep('test')
  eq('nothing merged', result.merged, 0)
  eq('it is parked as not-terminal', result.notTerminal, 1)
  const after = await store.getRun(run.id)
  // The whole point of the gate: a run somebody may still be playing is not
  // closed on the strength of a file that never said it ended.
  eq('the run is still suspended', after.state, 'suspended')
  eq('with no outcome invented', after.outcome, null)
  eq('and no save data attached', after.saveData, null)

  // A later write that flips a signal merges on the next sweep, per §3.2.
  await writeSave(game, 1786603375)
  await utimes(join(game, '1786603375.run'), new Date(), new Date(Date.now() + 1000))
  const second = await scribe.sweep('after the run ended')
  eq('once the file says it ended, it merges', second.merged, 1)
  eq('and the run is abandoned', (await store.getRun(run.id)).state, 'abandoned')
  scribe.dispose()
})

await section('the live run is left to the recorder', async () => {
  const store = await newStore('live')
  const game = join(await freshDir('live-game'), 'history')
  await mkdir(game, { recursive: true })
  const run = await seedRun(store, { state: 'recording' })
  await writeSave(game, 1786603375)

  const { scribe } = newScribe(store, [game])
  const result = await scribe.sweep('test')
  eq('nothing merged into the live run', result.merged, 0)
  eq('it waits for the next sweep', result.retryLater, 1)
  eq('the run is still recording', (await store.getRun(run.id)).state, 'recording')

  // The recorder suspends it; the trigger fires; the sweep merges.
  const live = await store.getRun(run.id)
  live.state = 'suspended'
  store.save(live, { immediate: true })
  await store.flush()
  const second = await scribe.sweep('run-suspended')
  eq('once suspended it merges', second.merged, 1)
  scribe.dispose()
})

await section('a character contradiction is a conflict, never a merge', async () => {
  const store = await newStore('conflict')
  const game = join(await freshDir('conflict-game'), 'history')
  await mkdir(game, { recursive: true })
  const run = await seedRun(store, { character: 'necrobinder' })
  await writeSave(game, 1786603375) // an Ironclad save

  const { scribe, issues } = newScribe(store, [game])
  const result = await scribe.sweep('test')
  eq('it is a conflict', result.conflicts, 1)
  eq('nothing merged', result.merged, 0)
  eq('the run is untouched', (await store.getRun(run.id)).saveData, null)
  ok(
    'and the anomaly is reported',
    issues.some((i) => i.key === 'journal_save_match_anomaly' && i.props.reason === 'character-mismatch')
  )
  scribe.dispose()
})

await section('the window+deck fallback, for runs recorded before the run key', async () => {
  const store = await newStore('fallback')
  const game = join(await freshDir('fallback-game'), 'history')
  await mkdir(game, { recursive: true })
  // A pre-WP1 run: no run key of its own, but the right character, an
  // overlapping window, and a deck the save's final deck contains.
  const run = await seedRun(store, {
    runStartTime: null,
    startedAt: 1786603375 * 1000 + 60_000,
    lastSeenAt: 1786603375 * 1000 + 600_000,
    deck: ['STRIKE_IRONCLAD#0', 'BASH#0']
  })
  await writeSave(game, 1786603375)

  const { scribe } = newScribe(store, [game])
  const result = await scribe.sweep('test')
  eq('it merges', result.merged, 1)
  const after = await store.getRun(run.id)
  eq('and says how', after.saveData.matchedBy, 'window+deck')
  eq('the run key is adopted from the save', after.runStartTime, 1786603375)
  scribe.dispose()
})

await section('the fallback declines when it is not sure', async () => {
  const store = await newStore('fallback-decline')
  const game = join(await freshDir('fallback-decline-game'), 'history')
  await mkdir(game, { recursive: true })
  // Two keyless Ironclad runs in the same window: indistinguishable, so neither.
  await seedRun(store, {
    runStartTime: null,
    startedAt: 1786603375 * 1000 + 60_000,
    lastSeenAt: 1786603375 * 1000 + 600_000
  })
  await seedRun(store, {
    runStartTime: null,
    startedAt: 1786603375 * 1000 + 90_000,
    lastSeenAt: 1786603375 * 1000 + 900_000
  })
  await writeSave(game, 1786603375)

  const { scribe } = newScribe(store, [game])
  const result = await scribe.sweep('test')
  eq('nothing merged', result.merged, 0)
  eq('it parks as unmatched', result.unmatched, 1)

  // A run whose deck the save could not possibly have produced is not a match
  // either, however well the window lines up.
  const store2 = await newStore('fallback-deck')
  await seedRun(store2, {
    runStartTime: null,
    startedAt: 1786603375 * 1000 + 60_000,
    lastSeenAt: 1786603375 * 1000 + 600_000,
    deck: ['DEMON_FORM#0', 'OFFERING#0']
  })
  const { scribe: scribe2 } = newScribe(store2, [game])
  eq('a deck the save never had is not a match', (await scribe2.sweep('test')).merged, 0)
  scribe.dispose()
  scribe2.dispose()
})

await section('an unmatched save is re-examined only when a run could match it', async () => {
  const store = await newStore('unmatched-gate')
  const game = join(await freshDir('unmatched-gate-game'), 'history')
  await mkdir(game, { recursive: true })
  await writeSave(game, 1786603375)

  const { scribe } = newScribe(store, [game])
  eq('the first sweep parks it', (await scribe.sweep('one')).unmatched, 1)
  // Nothing changed: the file is skipped without being opened.
  eq('the second sweep opens nothing', (await scribe.sweep('two')).parsed, 0)
  // A run with that exact key appears — the key is the file's own name, so
  // noticing costs no I/O at all.
  await seedRun(store, { runStartTime: 1786603375 })
  const third = await scribe.sweep('three')
  eq('a matching run un-parks it', third.parsed, 1)
  eq('and it merges', third.merged, 1)
  scribe.dispose()
})

// ── 6. the defensive read ────────────────────────────────────────────────────

await section('a file the game is holding open is copied, then parsed', async () => {
  const store = await newStore('locked')
  const game = join(await freshDir('locked-game'), 'history')
  await mkdir(game, { recursive: true })
  const run = await seedRun(store)
  const target = await writeSave(game, 1786603375)

  // Windows refuses a read on a file opened without FILE_SHARE_READ, but a copy
  // through the shadow path still gets through. This adapter is that, exactly.
  const nodeFs = mod.nodeSaveFs
  let refused = 0
  let copies = 0
  const copyOnly = {
    ...nodeFs,
    readFile: async (path) => {
      if (path === target) {
        refused++
        const err = new Error('EBUSY: resource busy or locked')
        err.code = 'EBUSY'
        throw err
      }
      return nodeFs.readFile(path)
    },
    copyFile: async (from, to) => {
      copies++
      return nodeFs.copyFile(from, to)
    }
  }

  const tmpHome = await freshDir('locked-tmp')
  const { scribe } = newScribe(store, [game], { fs: copyOnly, tmpDir: tmpHome })
  const result = await scribe.sweep('test')
  eq('the direct read was refused', refused > 0, true)
  eq('so it went through a copy', copies > 0, true)
  eq('and the merge still landed', result.merged, 1)
  eq('the run has its save data', (await store.getRun(run.id)).saveData.seed, 'DHDDFVFJ08')
  // The copy is the whole reason a locked file is readable at all — and it must
  // never be made anywhere near the game's directory.
  eq('no copy was left behind', await readdir(tmpHome), [])
  ok(
    'and nothing new appeared beside the save',
    (await readdir(game)).sort().join(',') === '1786603375.run,1786603375.run.backup'
  )
  scribe.dispose()
})

await section('a file that is still being written waits for the next sweep', async () => {
  const store = await newStore('unstable')
  const game = join(await freshDir('unstable-game'), 'history')
  await mkdir(game, { recursive: true })
  await seedRun(store)
  const target = await writeSave(game, 1786603375)

  // The game, mid-write: the second stat of the stability check disagrees with
  // the first, which is precisely the signal to leave it alone.
  const nodeFs = mod.nodeSaveFs
  let stats = 0
  const growing = {
    ...nodeFs,
    stat: async (path) => {
      const s = await nodeFs.stat(path)
      if (path === target) stats++
      return path === target && stats > 1 ? { ...s, size: s.size + 512 } : s
    }
  }
  const { scribe } = newScribe(store, [game], { fs: growing })
  const result = await scribe.sweep('test')
  eq('nothing merged', result.merged, 0)
  eq('it waits', result.retryLater, 1)
  scribe.dispose()
})

// ── 7. discovery over a real directory tree ──────────────────────────────────

await section('discovery walks the profiles the game actually wrote', async () => {
  const store = await newStore('discovery')
  const appData = await freshDir('discovery-appdata')
  const steamId = '76561199096588786'
  const root = join(appData, 'SlayTheSpire2', 'steam', steamId)
  const p1 = join(root, 'profile1', 'saves', 'history')
  const modded = join(root, 'modded', 'profile1', 'saves', 'history')
  await mkdir(p1, { recursive: true })
  await mkdir(modded, { recursive: true })
  // A profile that exists but was never played, and a directory that is not a
  // profile at all — both must be walked past without complaint.
  await mkdir(join(root, 'profile2', 'saves'), { recursive: true })
  await mkdir(join(root, 'replays'), { recursive: true })

  await writeSave(p1, 1786603375)
  await writeSave(modded, 1700000009, { win: true, wasAbandoned: false })
  const run = await seedRun(store)

  const { scribe } = newScribe(store, undefined, { appDataDir: appData })
  const result = await scribe.start()
  eq('both populated profiles were walked', result.files, 2)
  eq('the run in the live profile merged', result.merged, 1)
  eq('the modded profile’s save has no run behind it', result.unmatched, 1)
  const after = await store.getRun(run.id)
  // Q4: the source path is recorded so a profile switch can never mix ledgers.
  ok('the source profile is recorded', after.saveData.sourceFile.includes(join('profile1', 'saves')))
  scribe.dispose()
})

await section('no game, no profile, no problem', async () => {
  const store = await newStore('absent')
  const { scribe, issues } = newScribe(store, undefined, {
    appDataDir: join(await freshDir('absent-appdata'), 'nothing-here')
  })
  const result = await scribe.start()
  eq('it finds nothing', result.files, 0)
  eq('and says so quietly', issues.filter((i) => i.severity === 'error').length, 0)
  eq('no sidecar is written for a directory that does not exist', (await readdir(store.dir)).includes(SAVE_INDEX_FILE), false)
  scribe.dispose()
})

await section('a read-only store never merges', async () => {
  const base = await freshDir('readonly')
  const store = new RunStore({ baseDir: join(base, 'runs'), env: {}, hasLock: false })
  await store.open()
  await store.scan()
  const game = join(await freshDir('readonly-game'), 'history')
  await mkdir(game, { recursive: true })
  await seedRun(store)
  await writeSave(game, 1786603375)
  const { scribe } = newScribe(store, [game])
  const result = await scribe.sweep('test')
  // A second instance may read the game's files all it likes; what it may not
  // do is write the archive the first instance owns.
  eq('nothing merged', result.merged, 0)
  eq('it waits for the instance that holds the lock', result.retryLater, 1)
  scribe.dispose()
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
