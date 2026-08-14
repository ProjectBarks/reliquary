import { createHash } from 'crypto'
import { watch } from 'fs'
import { copyFile, readdir, readFile, stat, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  CatalogEntry,
  DeckGroupRow,
  RunFile,
  RunSaveData,
  SaveAncientChoice,
  SaveBadge,
  SaveCardChoice,
  SaveCardRef,
  SaveChoiceRef,
  SaveEnchant,
  SaveEventChoice,
  SaveFloorPlayerStats,
  SaveFloorRow,
  SaveMatchedBy,
  SavePlayer,
  SavePotionRef,
  SaveRelicRef,
  SaveResult,
  SaveRoom,
  SaveTransform
} from '@shared/journal'
import { cardBaseId, groupDeck } from './RunRecorder'
import {
  isRetryable,
  normalizeRunCharacter,
  writeAtomic,
  type JournalIssueSink,
  type RunStore
} from './RunStore'

/**
 * The bridge between the journal and the game's own end-of-run ledger:
 * `%APPDATA%\SlayTheSpire2\steam\<steamid>\profile<N>\saves\history\<start_time>.run`
 * (save-merge-plan §3).
 *
 * The join is *exact*, which is what makes this module small: the history
 * file's own name is the run's `start_time` in unix seconds, and that is the
 * same number the recorder already stores as `RunFile.runStartTime`. Matching
 * is a catalog lookup, not a heuristic, and the fallback below exists only for
 * journal runs recorded before that reader landed.
 *
 * Four rules it never bends:
 *
 *   1. **Read-only toward the game.** Nothing under `SlayTheSpire2\` is
 *      written, renamed, moved or deleted — not even a lock file, not even a
 *      temp. The game may be mid-write while we look; a file that will not open
 *      is copied *elsewhere* and parsed there, and a file whose `(size, mtime)`
 *      is still moving is left for the next sweep. Being wrong here corrupts a
 *      save, which is not a bug anyone gets to recover from.
 *   2. **Only merge what is provably over.** A history file merges only if it
 *      says `win`, `was_abandoned`, or names a killer (§3.2). Whether the game
 *      ever snapshots a *live* run into `history\` is unproven (Q1), so a file
 *      with three negative signals is parked and re-examined rather than used
 *      to close a run that is still being played.
 *   3. **Never guess at a match.** An exact key match whose character
 *      contradicts the run is a `conflict`, not a merge; two rows on one key,
 *      or an ambiguous fallback, park as `unmatched`. A save with no journal
 *      run behind it is not a failure at all — it is a run played before
 *      Reliquary, and importing those is deliberately not this module's job.
 *   4. **Additive, never destructive.** The merge fills nulls, upgrades
 *      `outcome` (the one field the save knows better than we ever could), and
 *      attaches everything else under `RunFile.saveData`. A live observation is
 *      not overwritten; a disagreement between the journal's deck and the
 *      save's raises telemetry instead of a silent rewrite (Q8).
 *
 * Sweeps are incremental through `save-index.json` — a sidecar in the
 * **journal's** directory, never the game's — keyed by path with the file's
 * `(mtime, size)` and what we decided about it. A merged file with an unchanged
 * stat is never opened again, so the steady state of a sweep is one `readdir`
 * and one `stat` per file.
 *
 * Everything is injected (directories, clock, sleep, an fs adapter, telemetry
 * sinks) so the whole thing runs under plain node in
 * `scripts/journal-savescribe-selfcheck.mjs`.
 */

// ── configuration ────────────────────────────────────────────────────────────

/** The sidecar's name inside the journal's runs directory. */
export const SAVE_INDEX_FILE = 'save-index.json'

/** Sidecar shape version. Bumped only if the statuses stop meaning what they mean. */
export const SAVE_INDEX_SCHEMA = 1

/**
 * The highest `schema_version` we have actually inspected. A file above this is
 * parked, never guessed at — the same policy `JOURNAL_SCHEMA` applies to our own
 * files, for the same reason. Extend it after reading a real file from the new
 * build, not before.
 */
export const MAX_SAVE_SCHEMA = 9

/** A history file is 4–300 KB. Anything past this is not one, and is not read. */
const MAX_SAVE_BYTES = 8 * 1024 * 1024

/** fs.watch fires several times per write; one sweep per burst is enough. */
const DEFAULT_WATCH_DEBOUNCE_MS = 2000

/**
 * How long a sweep waits before re-stat'ing its candidates. One sleep per
 * sweep, not per file: the point is to let an in-flight write finish, and the
 * game writes one run file at a time.
 */
const DEFAULT_STABILITY_MS = 1000

/** Retry ladder for a file the game still has open. */
const READ_RETRY_MS = [60, 200, 500]

/** The Steam app id of Slay the Spire 2 — how the cloud mirror is located. */
const STS2_APP_ID = '2868840'

// ── the sidecar ──────────────────────────────────────────────────────────────

/**
 * What we decided about one history file, and why we can skip it next time.
 *
 * `merged` / `unsupported-schema` / `unparseable` / `conflict` / `too-large`
 * are settled: unless the file itself changes, the answer cannot. `not-terminal`
 * and `retry-later` are re-examined every sweep by design — they are the two
 * states a later write is expected to resolve. `unmatched` is settled *for the
 * catalog as it stands*, so it is re-examined only when a run that could match
 * it appears.
 */
export type SaveFileStatus =
  | 'merged'
  | 'unmatched'
  | 'not-terminal'
  | 'unsupported-schema'
  | 'unparseable'
  | 'conflict'
  | 'retry-later'
  | 'too-large'

export interface SaveIndexRow {
  mtimeMs: number
  bytes: number
  status: SaveFileStatus
  /** The run this file merged into; null for every other status. */
  runId: string | null
  /** When we last decided this. */
  at: number
}

export interface SaveIndexFile {
  schema: number
  updatedAt: number
  /** Keyed by absolute path — a profile switch must never mix two ledgers. */
  files: Record<string, SaveIndexRow>
}

/** Statuses a later sweep cannot improve on unless the file itself moves. */
const SETTLED: ReadonlySet<SaveFileStatus> = new Set<SaveFileStatus>([
  'merged',
  'unsupported-schema',
  'unparseable',
  'conflict',
  'too-large'
])

// ── the fs adapter ───────────────────────────────────────────────────────────

export interface SaveFileStat {
  size: number
  mtimeMs: number
}

export interface SaveWatcher {
  close(): void
}

/**
 * Every filesystem call this module makes, in one injectable surface. Not
 * abstraction for its own sake: the failure that matters most here — a history
 * file the game holds open, which `readFile` refuses and `copyFile` gets
 * through — cannot be provoked from a test on a real directory, and a module
 * whose most important branch is untestable is a module whose most important
 * branch is wrong.
 */
export interface SaveFsAdapter {
  readdir(dir: string): Promise<string[]>
  stat(path: string): Promise<SaveFileStat>
  readFile(path: string): Promise<string>
  copyFile(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  /** Null when this platform or directory refuses to be watched — never fatal. */
  watch(dir: string, onChange: () => void): SaveWatcher | null
}

export const nodeSaveFs: SaveFsAdapter = {
  readdir: (dir) => readdir(dir),
  stat: async (path) => {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
  readFile: (path) => readFile(path, 'utf8'),
  copyFile: (from, to) => copyFile(from, to),
  unlink: (path) => unlink(path),
  watch: (dir, onChange) => {
    try {
      // `persistent: false` plus the unref below: a watcher on a directory the
      // user may never touch must not be the reason the process refuses to exit.
      const watcher = watch(dir, { persistent: false }, () => onChange())
      ;(watcher as unknown as { unref?: () => void }).unref?.()
      watcher.on('error', () => {
        /* a vanished or unwatchable directory is the startup sweep's problem */
      })
      return watcher
    } catch {
      return null
    }
  }
}

// ── options ──────────────────────────────────────────────────────────────────

export interface SaveScribeOptions {
  store: RunStore
  /**
   * `%APPDATA%` (Electron's `app.getPath('appData')`). Null disables discovery
   * entirely, which is what a stub or capture process gets.
   */
  appDataDir?: string | null
  /** Steam's install root, for the cloud-mirror fallback only. */
  steamDir?: string | null
  /**
   * Explicit history directories. When set, discovery is skipped entirely —
   * the self-check's fixture tree and the `SPECTRA_SAVE_DIR` escape hatch.
   */
  historyDirs?: string[]
  /** Where `save-index.json` lives. Defaults to the store's own directory. */
  indexDir?: string
  /** Where a locked file is copied to be parsed. Never a game directory. */
  tmpDir?: string
  env?: Record<string, string | undefined>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fs?: SaveFsAdapter
  onIssue?: JournalIssueSink
  /** Shaped like `telemetry.capture`. */
  onEvent?: (name: string, props: Record<string, unknown>) => void
  /** `journal:push {kind:'catalog'}` — an open Archive refreshes from this. */
  onCatalog?: (entries: CatalogEntry[]) => void
  /**
   * A run gained save data and owes a fresh review. Wired to
   * `AnalysisRunner.enqueue`, and kept as a callback for the same reason the
   * recorder's `onRunClosed` is: the queue is the app's, not this module's.
   */
  onMerged?: (id: string) => void
  watchDebounceMs?: number
  stabilityMs?: number
  maxFileBytes?: number
}

export interface SweepResult {
  reason: string
  /** History files seen on disk. */
  files: number
  /** Of those, how many the index let us skip without opening. */
  skipped: number
  parsed: number
  merged: number
  unmatched: number
  notTerminal: number
  unsupported: number
  unparseable: number
  conflicts: number
  retryLater: number
  durationMs: number
}

function emptySweep(reason: string): SweepResult {
  return {
    reason,
    files: 0,
    skipped: 0,
    parsed: 0,
    merged: 0,
    unmatched: 0,
    notTerminal: 0,
    unsupported: 0,
    unparseable: 0,
    conflicts: 0,
    retryLater: 0,
    durationMs: 0
  }
}

// ── the parsed save file ─────────────────────────────────────────────────────

/**
 * One history file, normalised. Everything `RunSaveData` carries plus the three
 * raw outcome signals, because the terminality gate reads them individually and
 * `result === null` is exactly "none of them fired".
 */
export interface SaveRun {
  schemaVersion: number
  seed: string
  startTime: number
  runTimeS: number | null
  win: boolean
  wasAbandoned: boolean
  killedByEncounter: string | null
  killedByEvent: string | null
  /** Null when the file proves nothing about the run having ended (§3.2). */
  result: SaveResult | null
  ascension: number | null
  gameMode: string | null
  buildId: string | null
  modifiers: string[]
  acts: string[]
  players: SavePlayer[]
  floors: SaveFloorRow[]
}

export type SaveParseResult =
  | { ok: true; save: SaveRun }
  | { ok: false; reason: 'unparseable' }
  | { ok: false; reason: 'unsupported-schema'; schema: number }

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * Which processes may look at the real game directories at all.
 *
 * The mirror image of `resolveRunsDir`'s rule, and load-bearing for the same
 * reason: a stub or capture process journals into `runs-stub/`, so merging the
 * user's *real* save history into a synthetic archive would attach a real run's
 * ledger to a fixture. `SPECTRA_SAVE_DIR` is the deliberate escape hatch —
 * point a dev launch at a fixture tree and the whole pipeline runs on it.
 */
export function saveDiscoveryDirs(
  env: Record<string, string | undefined> = process.env
): string[] | null {
  const override = env['SPECTRA_SAVE_DIR']
  if (override) return override.split(';').filter(Boolean)
  const synthetic =
    !!env['SPECTRA_JOURNAL_STUB'] || !!env['SPECTRA_CAPTURE'] || !!env['SPECTRA_STUB']
  return synthetic ? [] : null
}

/** `…\SlayTheSpire2\steam` — the root the game itself writes. */
export function primarySaveRoot(appData: string): string {
  return join(appData, 'SlayTheSpire2', 'steam')
}

/** `…\Steam\userdata` — where the cloud mirror lives, if it is ever needed. */
export function steamUserdataRoot(steamDir: string): string {
  return join(steamDir, 'userdata')
}

/** `profile1`, `profile2`… — the only directory names a profile can have. */
function isProfileDir(name: string): boolean {
  return /^profile\d+$/i.test(name)
}

/** A history file, and not the `.backup` sibling the game writes beside it. */
export function isHistoryFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.run')
}

/** The join key, straight off the file name: `1786603375.run` → `1786603375`. */
export function startTimeFromFileName(name: string): number | null {
  const match = /^(\d+)\.run$/i.exec(name)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * The SteamID64 naming the directory a history file came from. In multiplayer
 * that id also appears in the save's own roster, which is the only way to tell
 * which player row is the local one (Q3).
 */
export function steamIdFromPath(path: string): string | null {
  const match = /[\\/]steam[\\/](\d{5,})[\\/]/i.exec(path)
  return match ? match[1] : null
}

// ── parsing ──────────────────────────────────────────────────────────────────

type Bag = Record<string, unknown>

function isRecord(v: unknown): v is Bag {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function strings(v: unknown): string[] {
  return list(v).filter((x): x is string => typeof x === 'string')
}

/**
 * `NONE.NONE` is the game's null — the field is always present and names
 * nothing. Collapsing it here is what lets the terminality gate and the outcome
 * badge both read one nullable string.
 */
function killer(v: unknown): string | null {
  const s = str(v)
  return s === null || s === 'NONE.NONE' ? null : s
}

/** `CHARACTER.IRONCLAD` / `CARD.STRIKE_IRONCLAD` → the part after the dot. */
export function stripSavePrefix(id: string): string {
  const dot = id.indexOf('.')
  return dot === -1 ? id : id.slice(dot + 1)
}

function cardRef(v: unknown): SaveCardRef | null {
  if (typeof v === 'string') return { id: v, floorAdded: null, upgradeLevel: null }
  if (!isRecord(v)) return null
  const id = str(v['id'])
  if (!id) return null
  return {
    id,
    floorAdded: num(v['floor_added_to_deck']),
    upgradeLevel: num(v['current_upgrade_level'])
  }
}

function cardRefs(v: unknown): SaveCardRef[] {
  return list(v)
    .map(cardRef)
    .filter((c): c is SaveCardRef => c !== null)
}

/**
 * `props: { ints: [{ name, value }] }` → `{ CombatsSeen: 4 }`. Only the integer
 * bag is flattened; it is the only one observed, and inventing a shape for the
 * others would be worse than dropping them.
 */
function relicProps(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null
  const out: Record<string, number> = {}
  for (const entry of list(v['ints'])) {
    if (!isRecord(entry)) continue
    const name = str(entry['name'])
    const value = num(entry['value'])
    if (name !== null && value !== null) out[name] = value
  }
  return Object.keys(out).length ? out : null
}

function relicRefs(v: unknown): SaveRelicRef[] {
  const out: SaveRelicRef[] = []
  for (const entry of list(v)) {
    if (typeof entry === 'string') {
      out.push({ id: entry, floorAdded: null, props: null })
      continue
    }
    if (!isRecord(entry)) continue
    const id = str(entry['id'])
    if (!id) continue
    out.push({
      id,
      floorAdded: num(entry['floor_added_to_deck']),
      props: relicProps(entry['props'])
    })
  }
  return out
}

function potionRefs(v: unknown): SavePotionRef[] {
  const out: SavePotionRef[] = []
  for (const entry of list(v)) {
    if (typeof entry === 'string') {
      out.push({ id: entry, slotIndex: null })
      continue
    }
    if (!isRecord(entry)) continue
    const id = str(entry['id'])
    if (!id) continue
    out.push({ id, slotIndex: num(entry['slot_index']) })
  }
  return out
}

function badges(v: unknown): SaveBadge[] {
  const out: SaveBadge[] = []
  for (const entry of list(v)) {
    if (!isRecord(entry)) continue
    const id = str(entry['id'])
    if (!id) continue
    out.push({ id, rarity: str(entry['rarity']) })
  }
  return out
}

function cardChoices(v: unknown): SaveCardChoice[] {
  const out: SaveCardChoice[] = []
  for (const entry of list(v)) {
    if (!isRecord(entry)) continue
    const card = cardRef(entry['card'])
    if (!card) continue
    out.push({ id: card.id, wasPicked: entry['was_picked'] === true, floorAdded: card.floorAdded })
  }
  return out
}

/** `relic_choices` / `potion_choices`: `{ choice, was_picked }`. */
function choiceRefs(v: unknown): SaveChoiceRef[] {
  const out: SaveChoiceRef[] = []
  for (const entry of list(v)) {
    if (!isRecord(entry)) continue
    const id = str(entry['choice']) ?? str(entry['id'])
    if (!id) continue
    out.push({ id, wasPicked: entry['was_picked'] === true })
  }
  return out
}

function transforms(v: unknown): SaveTransform[] {
  const out: SaveTransform[] = []
  for (const entry of list(v)) {
    if (!isRecord(entry)) continue
    const from = cardRef(entry['original_card'])
    const to = cardRef(entry['final_card'])
    if (!from || !to) continue
    out.push({ from: from.id, to: to.id })
  }
  return out
}

function enchants(v: unknown): SaveEnchant[] {
  const out: SaveEnchant[] = []
  for (const entry of list(v)) {
    if (!isRecord(entry)) continue
    const card = cardRef(entry['card'])
    const enchantment = str(entry['enchantment'])
    if (!card || !enchantment) continue
    const inner = isRecord(entry['card']) ? (entry['card'] as Bag)['enchantment'] : null
    out.push({
      id: card.id,
      enchantment,
      amount: isRecord(inner) ? num(inner['amount']) : null
    })
  }
  return out
}

function ancientChoices(v: unknown): SaveAncientChoice[] {
  const out: SaveAncientChoice[] = []
  for (const entry of list(v)) {
    if (!isRecord(entry)) continue
    const title = entry['title']
    const id = str(entry['TextKey']) ?? (isRecord(title) ? str(title['key']) : null)
    if (!id) continue
    out.push({ id, wasChosen: entry['was_chosen'] === true })
  }
  return out
}

/**
 * The dynamic-text bag on an event choice, flattened to scalars. The game wraps
 * each variable in a `DynamicString`-ish record with one populated field of
 * three; the flattening picks whichever one carries a value, because the point
 * of keeping it at all is a readable "you lost 7 HP", not the wrapper.
 */
function eventVariables(v: unknown): Record<string, string | number | boolean> | null {
  if (!isRecord(v)) return null
  const out: Record<string, string | number | boolean> = {}
  for (const [name, raw] of Object.entries(v)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[name] = raw
      continue
    }
    if (!isRecord(raw)) continue
    const s = str(raw['string_value'])
    if (s !== null) {
      out[name] = s
      continue
    }
    const d = num(raw['decimal_value'])
    if (d !== null && d !== 0) {
      out[name] = d
      continue
    }
    if (typeof raw['bool_value'] === 'boolean' && raw['bool_value']) {
      out[name] = true
      continue
    }
    if (d !== null) out[name] = d
  }
  return Object.keys(out).length ? out : null
}

function eventChoices(v: unknown): SaveEventChoice[] {
  const out: SaveEventChoice[] = []
  for (const entry of list(v)) {
    if (typeof entry === 'string') {
      out.push({ key: entry, variables: null })
      continue
    }
    if (!isRecord(entry)) continue
    const title = entry['title']
    const key = isRecord(title) ? str(title['key']) : str(title)
    if (!key) continue
    out.push({ key, variables: eventVariables(entry['variables']) })
  }
  return out
}

function floorStats(v: unknown): SaveFloorPlayerStats | null {
  if (!isRecord(v)) return null
  const playerId = v['player_id']
  const playerKey =
    typeof playerId === 'number' || typeof playerId === 'string' ? String(playerId) : ''
  if (!playerKey) return null
  return {
    playerKey,
    currentHp: num(v['current_hp']),
    maxHp: num(v['max_hp']),
    damageTaken: num(v['damage_taken']),
    hpHealed: num(v['hp_healed']),
    maxHpGained: num(v['max_hp_gained']),
    maxHpLost: num(v['max_hp_lost']),
    currentGold: num(v['current_gold']),
    goldGained: num(v['gold_gained']),
    goldLost: num(v['gold_lost']),
    goldSpent: num(v['gold_spent']),
    goldStolen: num(v['gold_stolen']),
    stolenLoot: num(v['stolen_loot']),
    cardChoices: cardChoices(v['card_choices']),
    cardsGained: cardRefs(v['cards_gained']),
    cardsRemoved: cardRefs(v['cards_removed']),
    cardsTransformed: transforms(v['cards_transformed']),
    cardsUpgraded: strings(v['upgraded_cards']),
    cardsDowngraded: strings(v['downgraded_cards']),
    cardsEnchanted: enchants(v['cards_enchanted']),
    relicChoices: choiceRefs(v['relic_choices']),
    relicsRemoved: strings(v['relics_removed']),
    potionChoices: choiceRefs(v['potion_choices']),
    potionsUsed: strings(v['potion_used']),
    potionsDiscarded: strings(v['potion_discarded']),
    boughtRelics: strings(v['bought_relics']),
    boughtColorless: strings(v['bought_colorless']),
    boughtPotions: strings(v['bought_potions']),
    restChoices: strings(v['rest_site_choices']),
    ancientChoices: ancientChoices(v['ancient_choice']),
    eventChoices: eventChoices(v['event_choices']),
    completedQuests: strings(v['completed_quests'])
  }
}

function rooms(v: unknown): SaveRoom[] {
  const out: SaveRoom[] = []
  for (const entry of list(v)) {
    if (!isRecord(entry)) continue
    out.push({
      modelId: str(entry['model_id']),
      roomType: str(entry['room_type']),
      monsterIds: strings(entry['monster_ids']),
      turnsTaken: num(entry['turns_taken'])
    })
  }
  return out
}

/**
 * `players[].id` is `1` in a solo file and the player's SteamID64 in a
 * multiplayer one. Whichever it is, it is kept only as the opaque string that
 * joins a roster row to its per-floor stats (§3.6).
 */
function player(v: unknown, localSteamId: string | null): SavePlayer | null {
  if (!isRecord(v)) return null
  const id = v['id']
  const playerKey = typeof id === 'number' || typeof id === 'string' ? String(id) : ''
  if (!playerKey) return null
  const character = str(v['character'])
  return {
    playerKey,
    // Solo files say `1` and mean us. Multiplayer files name every player, and
    // the only honest attribution is the id that also names the directory the
    // file came from — anything else is `players[0]` with a story attached.
    isLocal:
      playerKey === '1'
        ? true
        : localSteamId === null
          ? null
          : playerKey === localSteamId,
    character: character === null ? '' : normalizeRunCharacter(stripSavePrefix(character)),
    maxPotionSlots: num(v['max_potion_slot_count']),
    finalDeck: cardRefs(v['deck']),
    relics: relicRefs(v['relics']),
    potions: potionRefs(v['potions']),
    badges: badges(v['badges'])
  }
}

/**
 * The outcome truth table, verified across the whole history directory on this
 * machine (§1.3). `null` is the fourth row — all three signals negative — and
 * means "this file does not prove the run ended", which is a different
 * statement from "the run is still going".
 */
export function saveResultOf(input: {
  win: boolean
  wasAbandoned: boolean
  killedByEncounter: string | null
  killedByEvent: string | null
}): SaveResult | null {
  if (input.win) return 'victory'
  // Order matters: an abandoned run still names the room it was abandoned in,
  // so `killed_by` alone would call it a death.
  if (input.wasAbandoned) return 'abandoned'
  if (input.killedByEncounter || input.killedByEvent) return 'death'
  return null
}

/**
 * Parse one history file. Refuses a newer `schema_version` outright: the whole
 * value of this feature is that the numbers are the game's own, and guessing at
 * a shape we have not read would quietly invent them instead.
 */
export function parseSaveRun(text: string, sourcePath = ''): SaveParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  if (!isRecord(raw)) return { ok: false, reason: 'unparseable' }
  const schemaVersion = num(raw['schema_version']) ?? 0
  if (schemaVersion > MAX_SAVE_SCHEMA) {
    return { ok: false, reason: 'unsupported-schema', schema: schemaVersion }
  }
  const startTime = num(raw['start_time'])
  // Without the join key the file is not a history file we can use for
  // anything — every path downstream is keyed by it.
  if (startTime === null || startTime <= 0) return { ok: false, reason: 'unparseable' }
  if (!Array.isArray(raw['players'])) return { ok: false, reason: 'unparseable' }

  const localSteamId = steamIdFromPath(sourcePath)
  const acts = strings(raw['acts'])
  const players = list(raw['players'])
    .map((p) => player(p, localSteamId))
    .filter((p): p is SavePlayer => p !== null)

  const floors: SaveFloorRow[] = []
  let globalFloor = 0
  const history = list(raw['map_point_history'])
  for (let act = 0; act < history.length; act++) {
    const points = list(history[act])
    for (let floorInAct = 0; floorInAct < points.length; floorInAct++) {
      const point = points[floorInAct]
      if (!isRecord(point)) continue
      globalFloor++
      floors.push({
        act,
        actId: acts[act] ?? null,
        floorInAct,
        globalFloor,
        mapPointType: str(point['map_point_type']),
        rooms: rooms(point['rooms']),
        players: list(point['player_stats'])
          .map(floorStats)
          .filter((s): s is SaveFloorPlayerStats => s !== null)
      })
    }
  }

  const win = raw['win'] === true
  const wasAbandoned = raw['was_abandoned'] === true
  const killedByEncounter = killer(raw['killed_by_encounter'])
  const killedByEvent = killer(raw['killed_by_event'])

  return {
    ok: true,
    save: {
      schemaVersion,
      seed: str(raw['seed']) ?? '',
      startTime,
      runTimeS: num(raw['run_time']),
      win,
      wasAbandoned,
      killedByEncounter,
      killedByEvent,
      result: saveResultOf({ win, wasAbandoned, killedByEncounter, killedByEvent }),
      ascension: num(raw['ascension']),
      gameMode: str(raw['game_mode']),
      buildId: str(raw['build_id']),
      modifiers: strings(raw['modifiers']),
      acts,
      players,
      floors
    }
  }
}

/** The persisted section, once a save has been matched to a run. */
export function toSaveData(
  save: SaveRun,
  source: { path: string; mtimeMs: number; bytes: number },
  matchedBy: SaveMatchedBy,
  mergedAt: number
): RunSaveData {
  if (save.result === null) throw new Error('refusing to merge a non-terminal save file')
  return {
    mergedAt,
    sourceFile: source.path,
    sourceMtimeMs: source.mtimeMs,
    sourceBytes: source.bytes,
    matchedBy,
    schemaVersion: save.schemaVersion,
    seed: save.seed,
    startTime: save.startTime,
    runTimeS: save.runTimeS,
    result: save.result,
    killedByEncounter: save.killedByEncounter,
    killedByEvent: save.killedByEvent,
    ascension: save.ascension,
    gameMode: save.gameMode,
    buildId: save.buildId,
    modifiers: save.modifiers,
    acts: save.acts,
    players: save.players,
    floors: save.floors
  }
}

// ── the merge ────────────────────────────────────────────────────────────────

export interface SaveMergeOutcome {
  /** Field names actually changed. Empty means the merge was a no-op. */
  changed: string[]
  /** The journal's own final deck disagreed with the save's (Q8 probe). */
  deckMismatch: boolean
  /** Null when the roster could not be attributed — see `SavePlayer.isLocal`. */
  localPlayer: SavePlayer | null
}

/**
 * Which roster row is us.
 *
 * `isLocal` answers it outright when the file said so (solo, or a multiplayer
 * id matching the save directory). Failing that, a single-player roster is
 * unambiguous, and a character match against the journal's own run is the last
 * honest option. Anything past that is `players[0]` wearing a costume, so the
 * answer is null and the fields that need a local player simply stay unfilled.
 */
export function localPlayerOf(players: readonly SavePlayer[], character: string): SavePlayer | null {
  const flagged = players.filter((p) => p.isLocal === true)
  if (flagged.length === 1) return flagged[0]
  if (players.length === 1) return players[0]
  const want = normalizeRunCharacter(character)
  const byCharacter = players.filter((p) => p.character === want)
  return byCharacter.length === 1 ? byCharacter[0] : null
}

/** `["CARD.STRIKE#0", …]` from the save's deck rows, in the journal's own form. */
function deckMultisetOf(player: SavePlayer): string[] {
  return player.finalDeck
    .map((card) => `${stripSavePrefix(card.id)}#${card.upgradeLevel ?? 0}`)
    .sort()
}

function sameDeck(a: readonly DeckGroupRow[], b: readonly DeckGroupRow[]): boolean {
  const key = (rows: readonly DeckGroupRow[]): string =>
    rows
      .map((r) => `${r.id}#${r.upgradeLevel}x${r.count}`)
      .sort()
      .join(',')
  return key(a) === key(b)
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/**
 * Fold a matched save into its run file (§3.4).
 *
 * The rule the whole function obeys: **null → value, and `outcome` → the
 * truth**. Every other field the journal observed live stays exactly as
 * observed, because the save cannot see what we saw either — it has no pace, no
 * per-combat tallies and no offer context, and a "merge" that overwrote those
 * would be trading a measurement for a summary.
 *
 * `outcome` is the single exception, and only because the recorder's `'ended'`
 * is an admission rather than an observation: nothing in memory distinguishes
 * death from victory, and the save file is the only thing on this machine that
 * does. `countsArePartial` is deliberately untouched — it describes the
 * *observed* counts, and they are still as partial as they were.
 */
export function mergeSaveIntoRun(run: RunFile, data: RunSaveData, at: number): SaveMergeOutcome {
  const changed: string[] = []
  const local = localPlayerOf(data.players, run.character)
  let deckMismatch = false

  const prior = run.saveData ?? null
  if (
    !prior ||
    prior.sourceFile !== data.sourceFile ||
    prior.sourceMtimeMs !== data.sourceMtimeMs ||
    prior.result !== data.result
  ) {
    changed.push('saveData')
  }
  run.saveData = data

  if (run.outcome !== data.result) {
    run.outcome = data.result
    changed.push('outcome')
  }
  // A proven-terminal file ends the run's life as a resume candidate — the
  // f8d60a case, where the journal had it parked as `suspended` forever while
  // the game had known for hours that it was abandoned.
  const state = data.result === 'abandoned' ? 'abandoned' : 'closed'
  if (run.state !== state) {
    run.state = state
    changed.push('state')
  }
  if (run.endedAt === null) {
    // The file's mtime is when the run ended; its name is when it started.
    run.endedAt = data.sourceMtimeMs
    changed.push('endedAt')
  }
  if (run.runStartTime === null) {
    run.runStartTime = data.startTime
    changed.push('runStartTime')
  }
  if (run.ascension === null && data.ascension !== null) {
    run.ascension = data.ascension
    changed.push('ascension')
  }
  if (run.gameVersion === null && data.buildId !== null) {
    run.gameVersion = data.buildId
    changed.push('gameVersion')
  }

  const floors = data.floors.length
  if (floors > 0 && (run.floorReached === null || run.floorReached < floors)) {
    run.floorReached = floors
    changed.push('floorReached')
  }
  const actReached = data.floors.length ? data.floors[data.floors.length - 1].act : null
  const nextAct = maxOrNull(run.actReached, actReached)
  if (nextAct !== run.actReached) {
    run.actReached = nextAct
    changed.push('actReached')
  }
  const players = data.players.length
  if (players > 0 && (run.playerCount === null || run.playerCount < players)) {
    run.playerCount = players
    changed.push('playerCount')
  }

  if (local) {
    const saveDeck = groupDeck(deckMultisetOf(local))
    if (run.finalDeck === null) {
      if (saveDeck.length) {
        run.finalDeck = saveDeck
        changed.push('finalDeck')
      }
    } else if (saveDeck.length && !sameDeck(run.finalDeck, saveDeck)) {
      // Never a silent overwrite: the journal's deck carries upgrade levels as
      // *observed at close*, and a disagreement is evidence about one of the two
      // readers rather than a field to fix (Q8).
      deckMismatch = true
    }
    const relics = local.relics.map((r) => stripSavePrefix(r.id))
    if (run.relics.length === 0 && relics.length) {
      run.relics = relics
      changed.push('relics')
    }
    const potions = local.potions.map((p) => stripSavePrefix(p.id))
    if (run.potions.length === 0 && potions.length) {
      run.potions = potions
      changed.push('potions')
    }
    if (run.signature.relicHash === null && relics.length) {
      run.signature = { ...run.signature, relicHash: relicHashOf(relics) }
      changed.push('relicHash')
    }
  }

  // One event, describing the merge itself and nothing it merged: this really
  // is an observation we made, at a time we can name, and it belongs in the
  // observed-history stream. The content it brought does not, which is the
  // whole reason `saveData` is a section.
  const already = run.events.some(
    (e) => e.type === 'save_merged' && (e as unknown as Bag)['file'] === data.sourceFile
  )
  if (!already) {
    run.events.push({
      t: at,
      type: 'save_merged',
      file: data.sourceFile,
      result: data.result,
      matchedBy: data.matchedBy
    } as unknown as RunFile['events'][number])
    // The event carries nothing a fold could apply, so the snapshot is already
    // current — catching the counter up keeps `events[eventCount:]` meaning
    // "not yet folded" rather than "one merge marker and nothing else".
    run.snapshot.eventCount = run.events.length
    changed.push('events')
  }

  return { changed, deckMismatch, localPlayer: local }
}

/** SHA-1 over the sorted relic ids — the same shape as `deckHashOf`. */
export function relicHashOf(relics: readonly string[]): string {
  if (!relics.length) return ''
  return createHash('sha1').update([...relics].sort().join(',')).digest('hex')
}

// ── matching ─────────────────────────────────────────────────────────────────

export type SaveMatch =
  | { kind: 'matched'; entry: CatalogEntry; matchedBy: SaveMatchedBy }
  | { kind: 'recording'; entry: CatalogEntry }
  | { kind: 'unmatched'; candidates: number }
  | { kind: 'conflict'; entry: CatalogEntry }

/** True when any roster row is the character this journal run recorded. */
function rosterHas(save: SaveRun, character: string): boolean {
  const want = normalizeRunCharacter(character)
  return save.players.some((p) => p.character === want)
}

/**
 * The exact half of the match (§3.3.1): `runStartTime === start_time`, which is
 * also the file's own name. No tolerance, no window — the two numbers are the
 * same number, written by the same game, and the linkage test on f8d60a proved
 * it end to end.
 */
export function matchByRunKey(entries: readonly CatalogEntry[], save: SaveRun): SaveMatch | null {
  const exact = entries.filter((e) => !e.unreadable && e.runStartTime === save.startTime)
  if (!exact.length) return null
  const agreeing = exact.filter((e) => rosterHas(save, e.character))
  if (!agreeing.length) {
    // The key is exact, so this is a contradiction rather than a near miss:
    // something is wrong with one of the two records and merging would bake it
    // in. Park it and say so.
    return { kind: 'conflict', entry: exact[0] }
  }
  // A run still being recorded is the live one. It will close or suspend within
  // seconds and the next sweep merges it then; closing it from here would race
  // the recorder for ownership of a file it is holding.
  const settled = agreeing.filter((e) => e.state !== 'recording')
  if (!settled.length) return { kind: 'recording', entry: agreeing[0] }
  if (settled.length === 1) return { kind: 'matched', entry: settled[0], matchedBy: 'run-key' }
  // Several rows on one key can only come from the ambiguity banner's
  // provisional files. Prefer the settled answer; if there genuinely is not
  // one, park rather than pick (the same principle as D4).
  const decided = settled.filter((e) => e.ambiguity === null || e.ambiguity.resolution !== null)
  if (decided.length === 1) return { kind: 'matched', entry: decided[0], matchedBy: 'run-key' }
  return { kind: 'unmatched', candidates: settled.length }
}

/** The journal's view of a candidate's deck, in base ids, for the subset test. */
function baseMultiset(cards: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const card of cards) {
    const id = cardBaseId(card)
    out.set(id, (out.get(id) ?? 0) + 1)
  }
  return out
}

/** Every card the journal saw is in the save's final deck, counting copies. */
export function deckIsSubset(journalDeck: readonly string[], player: SavePlayer): boolean {
  const have = baseMultiset(player.finalDeck.map((c) => stripSavePrefix(c.id)))
  for (const [id, count] of baseMultiset(journalDeck)) {
    if ((have.get(id) ?? 0) < count) return false
  }
  return true
}

/**
 * Whether a journal run *could* be this save: same character, and our
 * observation window overlaps the run's life as the save describes it
 * (`start_time` → the file's mtime, which is when the run ended).
 */
export function windowOverlaps(entry: CatalogEntry, save: SaveRun, mtimeMs: number): boolean {
  const from = save.startTime * 1000
  return entry.lastSeenAt >= from && entry.firstSeenAt <= mtimeMs
}

// ── the module ───────────────────────────────────────────────────────────────

export class SaveScribe {
  private readonly store: RunStore
  private readonly fs: SaveFsAdapter
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onIssue: JournalIssueSink
  private readonly onEvent: (name: string, props: Record<string, unknown>) => void
  private readonly onCatalogCb: ((entries: CatalogEntry[]) => void) | null
  private readonly onMergedCb: ((id: string) => void) | null
  private readonly indexDir: string
  private readonly tmpDir: string
  private readonly appDataDir: string | null
  private readonly steamDir: string | null
  private readonly configuredDirs: string[] | null
  private readonly watchDebounceMs: number
  private readonly stabilityMs: number
  private readonly maxFileBytes: number

  private index = new Map<string, SaveIndexRow>()
  private indexLoaded = false
  private indexDirty = false

  private dirs: string[] | null = null
  private watchers: SaveWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingReason: string | null = null
  private sweeping: Promise<SweepResult> | null = null
  private sweepAgain: string | null = null
  private disposed = false
  private tmpSeq = 0

  constructor(opts: SaveScribeOptions) {
    this.store = opts.store
    this.fs = opts.fs ?? nodeSaveFs
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? defaultSleep
    this.onIssue = opts.onIssue ?? ((): void => {})
    this.onEvent = opts.onEvent ?? ((): void => {})
    this.onCatalogCb = opts.onCatalog ?? null
    this.onMergedCb = opts.onMerged ?? null
    this.indexDir = opts.indexDir ?? opts.store.dir
    this.tmpDir = opts.tmpDir ?? tmpdir()
    this.appDataDir = opts.appDataDir ?? null
    this.steamDir = opts.steamDir ?? null
    // An explicit list wins; otherwise the env decides whether this process is
    // allowed near the real game directories at all.
    this.configuredDirs = opts.historyDirs ?? saveDiscoveryDirs(opts.env ?? process.env)
    this.watchDebounceMs = opts.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
    this.stabilityMs = opts.stabilityMs ?? DEFAULT_STABILITY_MS
    this.maxFileBytes = opts.maxFileBytes ?? MAX_SAVE_BYTES
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Discover, watch, and sweep once. Called after the store's own scan, off the
   * startup path — the first sweep of a fresh install reads the whole history
   * directory, and nothing about that belongs in front of the first paint.
   *
   * No game installed, no profile played, a stub process: all of them resolve to
   * zero directories and this quietly does nothing.
   */
  async start(): Promise<SweepResult> {
    if (this.disposed) return emptySweep('disposed')
    const dirs = await this.historyDirs()
    if (!dirs.length) {
      this.onEvent('journal_save_idle', { dirs: 0 })
      return emptySweep('no-history-dirs')
    }
    this.watchAll(dirs)
    return this.sweep('startup')
  }

  /**
   * A trigger fired (a run closed or suspended, a watcher saw a write). Sweeps
   * are debounced and coalesced: `fs.watch` reports one write several times, and
   * a close is followed by a watch event for the same file moments later.
   */
  schedule(reason: string, delayMs = this.watchDebounceMs): void {
    if (this.disposed) return
    this.pendingReason = this.pendingReason ?? reason
    if (this.timer) return
    const handle = setTimeout(() => {
      this.timer = null
      const why = this.pendingReason ?? reason
      this.pendingReason = null
      void this.sweep(why).catch(() => {
        /* sweep reports its own failures */
      })
    }, delayMs)
    ;(handle as unknown as { unref?: () => void }).unref?.()
    this.timer = handle
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        /* best effort */
      }
    }
    this.watchers = []
  }

  /** Resolves when no sweep is in flight — the self-check's join point. */
  async idle(): Promise<void> {
    while (this.sweeping) await this.sweeping
  }

  // ── discovery ──────────────────────────────────────────────────────────────

  /**
   * Every populated `saves\history\` directory, cached after the first success.
   *
   * Cached only on success: a user who installs the game after Reliquary should
   * not have to restart the app, and re-enumerating three directories on a
   * sweep that found nothing costs nothing.
   */
  private async historyDirs(): Promise<string[]> {
    if (this.dirs && this.dirs.length) return this.dirs
    const found = await this.discover()
    this.dirs = found
    return found
  }

  private async discover(): Promise<string[]> {
    if (this.configuredDirs !== null) {
      // Explicit list (fixtures, `SPECTRA_SAVE_DIR`, or the empty list a stub
      // process gets): trusted as given, minus anything that is not there.
      const out: string[] = []
      for (const dir of this.configuredDirs) {
        if (await this.isDir(dir)) out.push(dir)
      }
      return out
    }
    if (!this.appDataDir) return []
    const primary = await this.scanRoot(primarySaveRoot(this.appDataDir))
    if (primary.length) return primary
    // Fallback only (§3.1): the Steam cloud mirror lags sync and has no
    // `.backup` siblings, so it is never watched alongside the real thing —
    // only used when the game's own root is not there at all.
    const mirror = await this.scanMirror()
    if (mirror.length) {
      this.onIssue('journal_save_mirror_used', 'info', { dirs: mirror.length })
    }
    return mirror
  }

  /** `<root>\<steamid>\[modded\]profile<N>\saves\history`. */
  private async scanRoot(root: string): Promise<string[]> {
    const out: string[] = []
    for (const steamId of await this.readdirSafe(root)) {
      const account = join(root, steamId)
      for (const base of [account, join(account, 'modded')]) {
        for (const name of await this.readdirSafe(base)) {
          if (!isProfileDir(name)) continue
          const history = join(base, name, 'saves', 'history')
          if (await this.isDir(history)) out.push(history)
        }
      }
    }
    return out
  }

  private async scanMirror(): Promise<string[]> {
    const steam = this.steamDir
    if (!steam) return []
    const root = steamUserdataRoot(steam)
    const out: string[] = []
    for (const account of await this.readdirSafe(root)) {
      // The directory name under `userdata` is the 32-bit account id, not the
      // SteamID64 used under %APPDATA% — which is why the app id is what we
      // look for rather than trying to relate the two.
      const remote = join(root, account, STS2_APP_ID, 'remote')
      for (const name of await this.readdirSafe(remote)) {
        if (!isProfileDir(name)) continue
        const history = join(remote, name, 'saves', 'history')
        if (await this.isDir(history)) out.push(history)
      }
    }
    return out
  }

  private watchAll(dirs: readonly string[]): void {
    if (this.watchers.length) return
    for (const dir of dirs) {
      const watcher = this.fs.watch(dir, () => this.schedule('watch'))
      if (watcher) this.watchers.push(watcher)
      else this.onIssue('journal_save_watch_failed', 'info', { dir })
    }
    this.onEvent('journal_save_watching', { dirs: dirs.length, watchers: this.watchers.length })
  }

  // ── the sweep ──────────────────────────────────────────────────────────────

  /** Idempotent and serialised: a second call while one runs joins the first. */
  sweep(reason: string): Promise<SweepResult> {
    if (this.sweeping) {
      this.sweepAgain = reason
      return this.sweeping
    }
    const run = this.runSweep(reason).finally(() => {
      this.sweeping = null
      const again = this.sweepAgain
      this.sweepAgain = null
      // A trigger that landed mid-sweep may have been about a file this sweep
      // had already walked past; re-arm the debounce rather than re-run now.
      if (again && !this.disposed) this.schedule(again)
    })
    this.sweeping = run
    return run
  }

  private async runSweep(reason: string): Promise<SweepResult> {
    const started = this.now()
    const result = emptySweep(reason)
    if (this.disposed) return result
    const dirs = await this.historyDirs()
    if (!dirs.length) return result
    await this.loadIndex()

    /** Files that need opening, with the stat that made us think so. */
    const candidates: Array<{ path: string; name: string; stat: SaveFileStat }> = []

    for (const dir of dirs) {
      for (const name of await this.readdirSafe(dir)) {
        // `.run.backup` is the game's own second copy and never a source of
        // truth; the suffix test excludes it by construction.
        if (!isHistoryFileName(name)) continue
        result.files++
        const path = join(dir, name)
        const info = await this.statSafe(path)
        if (!info) continue
        const prior = this.index.get(path)
        if (prior && prior.mtimeMs === info.mtimeMs && prior.bytes === info.size) {
          if (this.settled(prior, name)) {
            result.skipped++
            continue
          }
        }
        if (info.size > this.maxFileBytes) {
          this.park(path, info, 'too-large')
          this.onIssue('journal_save_too_large', 'warn', { bytes: info.size })
          continue
        }
        candidates.push({ path, name, stat: info })
      }
    }

    if (candidates.length) {
      // One settle for the whole sweep. The game writes a history file in one
      // go at run end, so a candidate whose `(size, mtime)` moved across this
      // sleep is being written right now and is left for the next sweep.
      await this.sleep(this.stabilityMs)
      for (const candidate of candidates) {
        if (this.disposed) break
        const after = await this.statSafe(candidate.path)
        if (!after) continue
        if (after.mtimeMs !== candidate.stat.mtimeMs || after.size !== candidate.stat.size) {
          this.park(candidate.path, after, 'retry-later')
          result.retryLater++
          continue
        }
        await this.consider(candidate.path, after, result)
      }
    }

    await this.saveIndex()
    result.durationMs = this.now() - started
    this.onEvent('journal_save_sweep', { ...result })
    return result
  }

  /**
   * Whether an unchanged file can be skipped without opening it.
   *
   * The `unmatched` case is the interesting one: it is settled only relative to
   * the catalog, and the catalog grows. But the join key is the file's own
   * *name*, so asking "could this match now?" costs no I/O at all — which is
   * what keeps a directory of sixty pre-Reliquary saves free on every sweep.
   */
  private settled(row: SaveIndexRow, name: string): boolean {
    if (SETTLED.has(row.status)) return true
    if (row.status !== 'unmatched') return false
    const startTime = startTimeFromFileName(name)
    const entries = this.store.list()
    if (startTime !== null && entries.some((e) => e.runStartTime === startTime)) return false
    // A run with no run key of its own is a fallback candidate for any save.
    return !entries.some((e) => !e.unreadable && e.runStartTime === null)
  }

  private async consider(path: string, info: SaveFileStat, result: SweepResult): Promise<void> {
    const text = await this.readDefensively(path)
    if (text === null) {
      this.park(path, info, 'retry-later')
      result.retryLater++
      return
    }
    result.parsed++
    const parsed = parseSaveRun(text, path)
    if (!parsed.ok) {
      if (parsed.reason === 'unsupported-schema') {
        this.park(path, info, 'unsupported-schema')
        result.unsupported++
        // The version number is the whole point of the probe: extending the
        // gate is a one-line change once we have seen a file from that build.
        this.onIssue('journal_save_unsupported_schema', 'warn', {
          schema: parsed.schema,
          max: MAX_SAVE_SCHEMA
        })
        return
      }
      this.park(path, info, 'unparseable')
      result.unparseable++
      // Quarantine-by-skip: the file is the game's and is never touched, so the
      // index row *is* the quarantine.
      this.onIssue('journal_save_unparseable', 'warn', { bytes: info.size })
      return
    }
    const save = parsed.save

    if (save.result === null) {
      // Q1's probe. If this never fires, the game only ever writes history at
      // run end and the gate is free insurance; if it does, the gate is the
      // reason a live run was not closed under the player.
      this.park(path, info, 'not-terminal')
      result.notTerminal++
      this.onEvent('journal_save_not_terminal', {
        floors: save.floors.length,
        players: save.players.length,
        age_s: Math.max(0, Math.round(this.now() / 1000 - save.startTime))
      })
      return
    }

    const match = this.match(save, info.mtimeMs)
    switch (match.kind) {
      case 'conflict':
        this.park(path, info, 'conflict')
        result.conflicts++
        this.onIssue('journal_save_match_anomaly', 'warn', {
          reason: 'character-mismatch',
          run_character: match.entry.character,
          save_players: save.players.length
        })
        return
      case 'recording':
        // The live run. Not a failure, not a park worth remembering — the next
        // sweep after it closes will find it again.
        this.park(path, info, 'retry-later')
        result.retryLater++
        return
      case 'unmatched':
        this.park(path, info, 'unmatched')
        result.unmatched++
        if (match.candidates > 1) {
          this.onIssue('journal_save_match_anomaly', 'warn', {
            reason: 'ambiguous',
            candidates: match.candidates
          })
        }
        return
      case 'matched':
        await this.merge(path, info, save, match.entry, match.matchedBy, result)
        return
    }
  }

  private match(save: SaveRun, mtimeMs: number): SaveMatch {
    const entries = this.store.list()
    const exact = matchByRunKey(entries, save)
    if (exact) return exact
    // The fallback (§3.3.2), for runs recorded before the run-key reader
    // landed. Deliberately narrow: only rows with no key of their own, only the
    // same character, only inside the save's own lifetime, and only when the
    // journal's deck is a subset of the save's final deck.
    const candidates = entries.filter(
      (e) =>
        !e.unreadable &&
        e.runStartTime === null &&
        e.state !== 'recording' &&
        rosterHas(save, e.character) &&
        windowOverlaps(e, save, mtimeMs)
    )
    if (candidates.length !== 1) return { kind: 'unmatched', candidates: candidates.length }
    const entry = candidates[0]
    const local = localPlayerOf(save.players, entry.character)
    if (!local) return { kind: 'unmatched', candidates: 0 }
    const deck = entry.deck ?? null
    // Without a deck to compare there is no second signal, and a window overlap
    // on its own is not identity — park rather than merge on a coincidence.
    if (!deck || !deck.length || !deckIsSubset(deck, local)) {
      return { kind: 'unmatched', candidates: 0 }
    }
    return { kind: 'matched', entry, matchedBy: 'window+deck' }
  }

  private async merge(
    path: string,
    info: SaveFileStat,
    save: SaveRun,
    entry: CatalogEntry,
    matchedBy: SaveMatchedBy,
    result: SweepResult
  ): Promise<void> {
    if (!this.store.writable) {
      // A second instance, or a capture run: reading was fine, writing is not.
      this.park(path, info, 'retry-later')
      result.retryLater++
      return
    }
    const run = await this.store.getRun(entry.id)
    if (!run) {
      this.park(path, info, 'unmatched')
      result.unmatched++
      this.onIssue('journal_save_run_missing', 'warn', { id: entry.id })
      return
    }
    const at = this.now()
    const data = toSaveData(save, { path, mtimeMs: info.mtimeMs, bytes: info.size }, matchedBy, at)
    const outcome = mergeSaveIntoRun(run, data, at)

    if (outcome.deckMismatch) {
      // Q8's probe: counts and booleans only, never the decks themselves.
      this.onIssue('journal_save_deck_mismatch', 'warn', {
        id: run.id,
        journal_rows: run.finalDeck?.length ?? 0,
        save_cards: outcome.localPlayer?.finalDeck.length ?? 0
      })
    }
    if (outcome.changed.length === 0) {
      // Same file, same answer: a re-merge after an mtime change that did not
      // change anything we read. Record it and move on.
      this.park(path, info, 'merged', run.id)
      return
    }

    // A run that gained an outcome, a floor ledger and a relic list is a run
    // whose review is out of date — including one that already said `done`.
    const requeue = run.analysisStatus !== 'pending'
    if (requeue) run.analysisStatus = 'pending'
    this.store.save(run, { immediate: true })
    this.park(path, info, 'merged', run.id)
    result.merged++

    this.onCatalogCb?.(this.store.list())
    if (requeue) this.onMergedCb?.(run.id)
    this.onEvent('journal_save_merged', {
      matched_by: matchedBy,
      result: data.result,
      floors: data.floors.length,
      players: data.players.length,
      changed: outcome.changed.length,
      requeued: requeue,
      ms: this.now() - at
    })
  }

  // ── defensive read ─────────────────────────────────────────────────────────

  /**
   * Read a file the game may be holding open.
   *
   * Direct read first, because that is what works. On the Win32 sharing errors
   * — the game mid-write, Defender, a backup agent — copy the file *out* of the
   * game's directory and parse the copy, then retry the whole ladder. The copy
   * is the only reason this can look at a locked file at all, and it goes to
   * the journal's temp directory: nothing new ever appears under
   * `SlayTheSpire2\`, not even for a millisecond.
   *
   * Null means "not this sweep" — the file is parked `retry-later`, which costs
   * one stat next time and nothing else.
   */
  private async readDefensively(path: string): Promise<string | null> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= READ_RETRY_MS.length; attempt++) {
      try {
        return await this.fs.readFile(path)
      } catch (err) {
        lastErr = err
        if (!isRetryable(err)) break
      }
      const copied = await this.readViaCopy(path)
      if (copied !== null) return copied
      const delay = READ_RETRY_MS[attempt]
      if (delay === undefined) break
      await this.sleep(delay)
    }
    this.onIssue('journal_save_read_failed', 'info', { locked: isRetryable(lastErr) }, lastErr)
    return null
  }

  private async readViaCopy(path: string): Promise<string | null> {
    const tmp = join(this.tmpDir, `reliquary-save-${process.pid}-${++this.tmpSeq}.run`)
    try {
      await this.fs.copyFile(path, tmp)
      return await this.fs.readFile(tmp)
    } catch {
      return null
    } finally {
      try {
        await this.fs.unlink(tmp)
      } catch {
        /* best effort — a stray temp is not worth a failed sweep */
      }
    }
  }

  // ── the sidecar ────────────────────────────────────────────────────────────

  private park(
    path: string,
    info: SaveFileStat,
    status: SaveFileStatus,
    runId: string | null = null
  ): void {
    this.index.set(path, {
      mtimeMs: info.mtimeMs,
      bytes: info.size,
      status,
      runId,
      at: this.now()
    })
    this.indexDirty = true
  }

  /** What the sidecar knows — the unmatched-saves footer's data source (WP-S2). */
  rows(): Array<SaveIndexRow & { file: string }> {
    return [...this.index.entries()].map(([file, row]) => ({ file, ...row }))
  }

  private async loadIndex(): Promise<void> {
    if (this.indexLoaded) return
    this.indexLoaded = true
    let text: string
    try {
      text = await this.fs.readFile(join(this.indexDir, SAVE_INDEX_FILE))
    } catch {
      // First run. An empty index means one full sweep, which is the correct
      // amount of work to do when we know nothing.
      return
    }
    const parsed = parseSaveIndex(text)
    if (!parsed) {
      this.onIssue('journal_save_index_corrupt', 'info', { bytes: text.length })
      return
    }
    for (const [file, row] of Object.entries(parsed.files)) this.index.set(file, row)
  }

  private async saveIndex(): Promise<void> {
    if (!this.indexDirty || !this.store.writable) return
    const file: SaveIndexFile = {
      schema: SAVE_INDEX_SCHEMA,
      updatedAt: this.now(),
      files: Object.fromEntries(this.index)
    }
    const path = join(this.indexDir, SAVE_INDEX_FILE)
    try {
      await writeAtomic(path, JSON.stringify(file, null, 2), () => `${path}.${process.pid}.tmp`)
      this.indexDirty = false
    } catch (err) {
      // The index is a cache over facts the files themselves carry: losing it
      // costs one full sweep, never a merge.
      this.onIssue('journal_save_index_write_failed', 'warn', {}, err)
    }
  }

  // ── small fs helpers ───────────────────────────────────────────────────────

  private async readdirSafe(dir: string): Promise<string[]> {
    try {
      return await this.fs.readdir(dir)
    } catch {
      return []
    }
  }

  private async statSafe(path: string): Promise<SaveFileStat | null> {
    try {
      return await this.fs.stat(path)
    } catch {
      return null
    }
  }

  private async isDir(path: string): Promise<boolean> {
    // `readdir` doubles as the directory test: a path that lists is a directory
    // we can read, which is the only property that matters here.
    try {
      await this.fs.readdir(path)
      return true
    } catch {
      return false
    }
  }
}

/** Returns null for anything that is not a sidecar we can use — a sweep rebuilds it. */
export function parseSaveIndex(text: string): SaveIndexFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !isRecord(raw['files'])) return null
  if (num(raw['schema']) !== SAVE_INDEX_SCHEMA) return null
  const files: Record<string, SaveIndexRow> = {}
  for (const [file, value] of Object.entries(raw['files'] as Bag)) {
    if (!isRecord(value)) continue
    const status = value['status']
    if (typeof status !== 'string') continue
    const mtimeMs = num(value['mtimeMs'])
    const bytes = num(value['bytes'])
    if (mtimeMs === null || bytes === null) continue
    files[file] = {
      mtimeMs,
      bytes,
      status: status as SaveFileStatus,
      runId: str(value['runId']),
      at: num(value['at']) ?? 0
    }
  }
  return { schema: SAVE_INDEX_SCHEMA, updatedAt: num(raw['updatedAt']) ?? 0, files }
}

/**
 * The stability wait, and deliberately **not** unref'd — unlike the debounce
 * timer in `schedule`, which must never be the reason the app refuses to quit.
 * The difference is that a sweep is already in flight here: an unref'd timer
 * that the loop drains past leaves `sweep()` pending forever, which hangs
 * `idle()` and strands every candidate the sweep had not reached yet.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
