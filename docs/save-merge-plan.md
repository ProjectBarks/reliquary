# Save-file merge plan â€” the full ledger from the game's own history files

**Status: investigation complete (2026-08-14), implementation not started.**
Follows from the WP1 findings in `session-tracking-plan.md` ("the game's own save
files carry everything, including the seed â€¦ it deserves its own WP rather than
being forgotten"). This is that WP.

Everything below was verified against the real files on this machine, including a
run the journal and the game both recorded (`f8d60a`). Steam ids are redacted as
`<steamid>` / `<teammate-steamid-N>`.

---

## 1. Findings

### 1.1 Directory layout (as observed on this machine)

Two copies of the same data exist:

**Primary (game-written):** `%APPDATA%\SlayTheSpire2\steam\<steamid>\`

```
<steamid>\
  profile.save                  { "last_profile_id": 1, "schema_version": 2 }
  profile.save.backup
  settings.save / .backup
  profile1\
    replays\latest.mcr
    saves\
      prefs.save / .backup
      progress.save / .backup   (~212 KB, profile progression; rewritten at run end)
      history\
        1774237522.run          â† one file per ENDED run, named by the run's
        1774237522.run.backup      start_time (unix seconds)
        â€¦                       60 .run files, 2026-03-23 â†’ 2026-08-14,
        1786603375.run             4 KB (instant abandon) â€¦ 282 KB (3-act MP win)
  profile2\saves\               (empty â€” never played)
  profile3\saves\               (empty)
```

**Mirror (Steam Cloud):** `C:\Program Files (x86)\Steam\userdata\<accountid>\2868840\remote\profile1\saves\history\`
â€” byte-identical `.run` set (no `.backup` siblings), plus `remotecache.vdf`.
Note the directory name there is the *account id* (32-bit), not the SteamID64
used under `%APPDATA%`. Two account dirs exist under `userdata\`; only one has
`2868840`.

Other facts:

- No `current_run.save` / `current_run_mp.save` existed at inspection time (no
  live run). WP1's decomp read says they appear beside `history\` during a run.
- No `modded\` subdir exists on this machine, but WP1 documented the
  `<steamid>[\modded]\profile<N>` variant â€” discovery should tolerate it.
- File mtime = when the run **ended**, filename = when it **started**. Proof:
  `1785808668.run` (started Aug 3) has mtime Aug 13 01:48 â€” a run suspended for
  ten days, resumed, and finished. The two can be arbitrarily far apart.
- History files are never pruned by the game as far as we can see (March files
  still present in August).

### 1.2 File format

Plain, pretty-printed JSON (CRLF, UTF-8, no BOM, no compression, no encoding).
`schema_version: 9` on current files (`build_id: "v0.107.1"`). Small enough to
parse whole (4â€“282 KB).

### 1.3 Schema as observed

Top level (all fields present on every file inspected):

| Field | Type | Example (from `1786603375.run`) | Notes |
|---|---|---|---|
| `schema_version` | int | `9` | gate merges on `<= 9` until verified higher |
| `build_id` | string | `"v0.107.1"` | matches journal `gameVersion` |
| `seed` | string | `"DHDDFVFJ08"` | **exact run identity**, not readable in memory (WP1 Q2) |
| `start_time` | int (unix s) | `1786603375` | == filename == journal `runStartTime` |
| `run_time` | int | `40779` | seconds-ish; see open question Q2 |
| `win` | bool | `false` | |
| `was_abandoned` | bool | `true` | |
| `killed_by_encounter` | string | `"ENCOUNTER.FOGMOG_NORMAL"` | `"NONE.NONE"` when not killed by a fight |
| `killed_by_event` | string | `"NONE.NONE"` | e.g. `"EVENT.NEOW"` on an event death/abandon |
| `ascension` | int | `0` | journal's is `null` today â€” save is authoritative |
| `game_mode` | string | `"standard"` | |
| `modifiers` | array | `[]` | |
| `platform_type` | string | `"steam"` | |
| `acts` | string[] | `["ACT.OVERGROWTH","ACT.HIVE","ACT.GLORY"]` | the act *route*, always all 3 listed |
| `players` | Player[] | see below | **the MP roster** |
| `map_point_history` | MapPoint[][] | see below | one inner array per act actually entered |

Outcome truth table (verified across four files):

| `win` | `was_abandoned` | `killed_by_*` | Meaning |
|---|---|---|---|
| `true` | `false` | `NONE.NONE` | **victory** |
| `false` | `false` | encounter/event set | **death**, killer named |
| `false` | `true` | may still name where | **abandoned** (the killed_by shows the room the player abandoned in) |
| `false` | `false` | `NONE.NONE` | not observed; treat as *not terminal* (see Â§3.2) |

**`players[]`** â€” one entry per player. `id` is `1` in solo files and the
**SteamID64** in multiplayer files (verified: a 3P victory listed
`<teammate-steamid-1>` / `<teammate-steamid-2>` / `<steamid>`, characters
NECROBINDERÃ—2 + IRONCLAD). Each player carries:

- `character` (`"CHARACTER.IRONCLAD"`)
- `deck[]` â€” final deck: `{ id, floor_added_to_deck, current_upgrade_level? }` per card
- `relics[]` â€” `{ id, floor_added_to_deck, props? }` (props = per-relic counters,
  e.g. Fishing Rod `CombatsSeen: 4`)
- `potions[]` â€” held at end: `{ id, slot_index }`, plus `max_potion_slot_count`
- `badges[]` â€” end-of-run accolades: `{ id: "DAMAGE_LEADER", rarity: "bronze" }`

**`map_point_history`** â€” the per-floor ledger. Array index = floor within act.
Each map point:

- `map_point_type`: `ancient | monster | elite | boss | shop | rest_site | treasure | unknown`
  (`ancient` = the Neow-equivalent start node; `unknown` = a `?` node as drawn on the map)
- `rooms[]`: `{ model_id, room_type, turns_taken, monster_ids? }` â€” what the node
  *actually resolved to*: `room_type` is one of
  `monster | elite | boss | event | shop | rest_site | treasure`, `model_id` is
  the concrete encounter/event (`ENCOUNTER.FOGMOG_NORMAL`, `EVENT.DENSE_VEGETATION`,
  `ENCOUNTER.QUEEN_BOSS`â€¦), `monster_ids` the enemy list
  (`["MONSTER.FOGMOG","MONSTER.EYE_WITH_TEETH"]`), `turns_taken` per fight.
- `player_stats[]` â€” one per player (`player_id` joins to `players[].id`), each with:
  - economy: `current_gold`, `gold_gained`, `gold_lost`, `gold_spent`, `gold_stolen`, `stolen_loot`
  - health: `current_hp`, `max_hp`, `damage_taken`, `hp_healed`, `max_hp_gained`, `max_hp_lost`
  - `card_choices[]`: `{ card: { id, floor_added_to_deck? }, was_picked }` â€”
    **every card offer, picked AND skipped**
  - `cards_gained[]`, `cards_removed[]`, `cards_transformed[]` (`original_card` â†’ `final_card`),
    `upgraded_cards[]`, `downgraded_cards[]`
  - `relic_choices[]` (`{ choice, was_picked }`), `relics_removed[]`
  - `potion_choices[]`, `potion_used[]`, `potion_discarded[]`
  - shops: `bought_relics[]`, `bought_colorless[]` (bought cards appear in `cards_gained`)
  - `rest_site_choices[]` (`["HEAL"]` â€¦)
  - `ancient_choice[]` (the start-node offer with `was_chosen` per option)
  - `event_choices[]`: the localization key of the option taken
    (`"DENSE_VEGETATION.pages.INITIAL.options.TRUDGE_ON.title"`), with a
    `variables` bag for dynamic text (e.g. `HpLoss: 7`, `Relic: "Sword of Stone"`)

### 1.4 Identity linkage test â€” PASSED, exact

The run the journal recorded as
`%APPDATA%\reliquary\runs\2026-08-14T06-02-42Z-ironclad-f8d60a.json`:

| | Journal file | Save file `history\1786603375.run` |
|---|---|---|
| join key | `runStartTime: 1786603375` | `start_time: 1786603375` (= filename) |
| character | `IRONCLAD` | `CHARACTER.IRONCLAD` |
| version | `v0.107.1` | `v0.107.1` |
| deck (13 cards) | `ARMAMENTS, BASH, 4Ã—DEFEND, MOLTEN_FIST, STAMPEDE, 4Ã—STRIKE, STRIKE+1` | identical, plus `floor_added_to_deck` per card |
| state/outcome | `suspended` / `null` | `was_abandoned: true`, abandoned at `ENCOUNTER.FOGMOG_NORMAL`, floor 6 |

**The join key is `RunFile.runStartTime === parseInt(basename(file))
=== json.start_time`, exact equality in unix seconds, no tolerance needed.**
This is precisely what WP1 predicted ("matched a completed run against the live
save by comparing `start_time`") and what SessionMatcher's D0 already treats as
primary identity. Bonus finding: the save's `start_time` predates the journal's
`startedAt` by ~23 h â€” the recorder attached to a resumed run and called it
`observedFrom: 'start'`; the save gives the authoritative run birth time.

And this same run is the merge's poster child: the journal has it parked as
`suspended` (a resume candidate forever, outcome unknown) while the save proves
it terminal-abandoned. No memory read could have told us.

---

## 2. What the merge unlocks

Mapped to the journal's current honest gaps (fields that are `null`/`'ended'`/
missing by design today):

| Journal gap today | Save field that fills it |
|---|---|
| `outcome: 'ended'` â€” recorder cannot tell death from victory (D9) | `win` / `was_abandoned` / `killed_by_*` â†’ **victory / death (with killer named) / abandoned** |
| `suspended` runs that were actually abandoned in-game stay resume candidates forever | terminal save file exists â‡’ state upgraded to terminal |
| HP and gold: unreadable live in v1 | `current_hp`/`max_hp`/`current_gold` **per floor per player**, plus full deltas (damage_taken, hp_healed, gold_spentâ€¦) |
| Enemy names: `combat_start` only counts `enemies: 3` | `monster_ids` + `model_id` + `turns_taken` per fight |
| Room types have null holes (`roomType: null` in f8d60a's events at floors 2 and 7) and rest/treasure/boss are unreliable live | `room_type` + `map_point_type` for **every** floor, including what `?` nodes resolved into |
| Card offers we never saw (gap windows, app closed, `offer_resolved` reason `'deadline'`) | `card_choices` with `was_picked` for every offer of the run â€” **gap backfill** |
| `relics: []`, `potions: []` (owned-relic reader not shipped; `signature.relicHash: null`) | full relic list with obtain floors and per-relic counters; potions held, used, discarded, and offered |
| Purge/purchase economics invisible | `cards_removed`, `bought_relics`, `bought_colorless`, `gold_spent` per shop floor â€” `AnalysisRunner.countShops()`'s "removals passed" becomes exact instead of event-inferred |
| Ascension `null` | `ascension` |
| Seed: no identity beyond `runStartTime` | `seed` â€” exact, survives everything |
| MP roster: `otherCharacterIds` best-effort per session | `players[]` â€” authoritative characters, final decks, relics and badges for every player |
| `floorReached` from live floor reader only | authoritative floor count from `map_point_history` length |
| Run duration across closed-app play | `run_time` (units caveat, Q2) |

**What the save does NOT have â€” the merge is a union, not a replacement:**

- Per-card **played/drawn tallies** per combat (`combats[].plays/drawn`) â€” only
  the journal's 250 ms pile observation has these.
- **Pace**: per-room wall time, `activeMs`, combat durations. The save has
  `turns_taken`, not seconds.
- **Offers as experienced**: `offer_shown` order, `deckBefore` at the moment of
  the offer, shop **prices** (the save records *what* was bought, never for how
  much â€” only the aggregate `gold_spent` per floor).
- Intra-run timeline: when in wall-clock time each floor happened; session
  boundaries; save-restore forensics.
- Anything about a run **in progress** (history files describe ended runs).

So the run report's shape stays: live observation remains the spine for pace,
combat detail and offer context; the save contributes outcome, economy/health
ledgers, enemy names, ownership and backfill.

---

## 3. Architecture â€” `SaveScribe` in `src\main\journal\`

One new module, `src\main\journal\SaveScribe.ts`, owned by the same main-process
journal layer as `RunRecorder`/`RunStore`. Read-only toward the game's
directories â€” **it never writes, renames or locks anything under
`SlayTheSpire2\`** â€” and writes only through `RunStore`.

### 3.1 Discovery & watch strategy

**Discovery** (at startup and lazily re-checked when a watch fires):

1. Root: `%APPDATA%\SlayTheSpire2\steam\`. Enumerate `<steamid>` dirs (usually
   one). Under each, enumerate `profile<N>` and the optional `modded\profile<N>`
   variant; a profile participates if `saves\history\` exists. `profile.save`'s
   `last_profile_id` tells us the active profile but we watch **all** populated
   profiles â€” it is one watcher per directory and profiles 2/3 are empty today.
2. **Fallback only** (root missing â€” e.g. a Proton/odd install): Steam userdata
   mirror `â€¦\Steam\userdata\<accountid>\2868840\remote\profile<N>\saves\history\`,
   located via the registry `SteamPath` or the default path, scanning account
   dirs for `2868840`. Never watch both â€” the mirror lags cloud sync and has no
   `.backup` siblings; %APPDATA% is what the game itself writes.

**Triggers** (three, cheap, all funnel into one debounced sweep):

1. **Recorder close/suspend** â€” when `RunRecorder` closes a run (D9) or a
   session detaches with reason `menu`/`process-gone`/`run-ended`, schedule a
   sweep. This is the common case: the history file's mtime and the journal's
   detach landed within 7 s of each other on f8d60a.
2. **`fs.watch` on each `history\` directory** (non-recursive, debounced ~2 s)
   â€” catches runs that end while Reliquary is open but not recording (game
   window there, overlay attached to menu), and MP runs ended by a host.
3. **Startup sweep** â€” covers everything that happened while the app was closed
   (see Â§3.4). No polling loop; `fs.watch` on a local NTFS dir is reliable, and
   the startup sweep is the safety net for anything it misses.

**Defensive read** (the game may be mid-write; it also writes `.backup`
siblings): on trigger, wait until the file's `(size, mtime)` is stable across
two stats ~1 s apart, then read fully into memory and `JSON.parse`. On
`EBUSY`/`EPERM`/parse failure, retry with backoff (3Ã—, then park the file as
`retry-later` for the next sweep). Ignore `*.run.backup`. Never merge a file
whose `schema_version` exceeds the highest we have verified (currently **9**) â€”
park as `unsupported-schema` and emit telemetry, same policy as
`JOURNAL_SCHEMA`'s "never guess at a newer schema".

### 3.2 Terminality check before matching

Only merge files that are provably ended: `win === true`, or
`was_abandoned === true`, or `killed_by_encounter/event !== "NONE.NONE"`. A file
with all three negative signals is not evidence of an ended run (WP1 could not
confirm whether the game ever snapshots history mid-run) â€” park it as
`not-terminal` and re-examine on the next sweep; if a later write flips a
signal, merge then. This costs nothing and can never close a live run wrongly.

### 3.3 Match strategy

The join key is exact, so matching is a catalog lookup, not a heuristic:

1. **Primary**: `catalog.entries.find(e => e.runStartTime === saveStartTime)` â€”
   `runStartTime` is already mirrored on every `CatalogEntry` for D0. Character
   must also agree (normalize `CHARACTER.IRONCLAD` â†’ `IRONCLAD` via the existing
   `normalizeRunCharacter`); a key match with a character mismatch is a
   contradiction â€” park as `conflict`, emit `journal_save_match_anomaly`, never
   merge. Multiple rows with the same key (possible only via the ambiguity
   banner's provisional files): prefer the non-provisional; if genuinely
   ambiguous, **park as `unmatched` â€” never guess** (same principle as D4).
2. **Fallback** (journal runs recorded before the WP1 reader, or whose
   `runStartTime` is null): candidate set = same character AND some observation
   session overlapping `[start_time, file mtime]` AND the journal's last-seen
   deck multiset âŠ† the save's final deck (base-id comparison, as A2 does).
   Unique candidate â‡’ merge with provenance `matchedBy: 'window+deck'`. Zero or
   several â‡’ **park as `unmatched`**.
3. **No journal run at all** (runs from before Reliquary, 60 files deep):
   not a match failure â€” an *import* opportunity, Phase 3 (Â§6).

Parking is persisted in a small sidecar `userData\runs\save-index.json`
(`{ file, mtimeMs, bytes, status: merged|unmatched|not-terminal|unsupported-schema|conflict|retry-later, runId? }`)
so sweeps are incremental: a file whose `(mtime, size)` is unchanged and whose
status is terminal (`merged`) is skipped forever.

### 3.4 Merge semantics

**Recommendation: a new additive `saveData` section on `RunFile` â€” not
synthetic events.** The journal's own doctrine is "events are history *we
observed*; nullability is honest" (`journal.ts` header). Interleaving
save-derived pseudo-events would forge observations, break
`snapshot.eventCount` folding, and complicate every event consumer. A separate
section keeps provenance perfect, and the ledger UI unions the two sources at
render time. No `JOURNAL_SCHEMA` bump â€” a new optional field is exactly the
additive case the schema comment already blesses; old app versions ignore it.

```ts
/** Everything merged from the game's own history file. Null until merged. */
saveData: null | {
  mergedAt: number
  sourceFile: string            // absolute path of the .run file
  sourceMtimeMs: number
  matchedBy: 'run-key' | 'window+deck'
  schemaVersion: number         // the save's own schema_version (9)
  seed: string
  startTime: number             // unix s, == runStartTime
  runTimeS: number | null       // raw run_time; units unconfirmed (Q2)
  result: 'victory' | 'death' | 'abandoned'
  killedByEncounter: string | null
  killedByEvent: string | null
  ascension: number
  gameMode: string
  acts: string[]
  players: SavePlayer[]         // roster: character, finalDeck (id+floor+upgrade),
                                // relics (id+floor+props), potions, badges.
                                // MP steam ids stored as an opaque local-only
                                // playerKey â€” see privacy note.
  floors: SaveFloorRow[]        // flattened map_point_history: act, floorInAct,
                                // globalFloor, mapPointType, roomType, modelId,
                                // monsterIds, turnsTaken, and per-player stats
                                // (hp/gold snapshot + deltas, cardChoices with
                                // wasPicked, gains/removals/transforms/upgrades,
                                // relicChoices, potion events, purchases,
                                // restChoice, ancientChoice, eventChoice)
}
```

Normalized (~15â€“25 KB), not the raw blob â€” the raw file stays on disk in the
game's own directory if forensics ever need it.

**Field upgrades applied to the run file at merge time** (only ever nullâ†’value
or `'ended'`â†’specific; a merge never overwrites a live observation with save
data, except `outcome`, where the save is strictly more informed):

- `outcome`: `'ended'`/`null` â†’ `'victory' | 'death'`; abandoned runs get the
  new additive outcome value `'abandoned'` (renderers must already tolerate
  unknown strings per the schema's forward-compatibility rule; the Archive
  displays it as its own badge).
- `state`: `suspended` â†’ `abandoned`/`closed` when the save is terminal â€” this
  is the f8d60a fix; the run stops being a resume candidate, and the matcher
  will refuse it naturally (terminal rows are already excluded).
- `endedAt`: null â†’ save file mtime (best available estimate).
- `ascension`, `floorReached`, `actReached`, `playerCount`: null/lower â†’ save's
  authoritative values.
- `finalDeck`: null â†’ grouped from the save's deck (only when the journal never
  computed one; a journal-computed final deck from live observation wins ties â€”
  it carries upgrade levels *as observed at close*, and any disagreement emits
  `journal_save_deck_mismatch` telemetry instead of a silent overwrite).
- `relics`/`potions`: `[]` â†’ save's lists (ids; floors live in `saveData`).
- `signature.relicHash`: null â†’ hash over save relic ids, so run grouping can
  finally use relics.
- One **event** is appended, honestly describing the merge itself (not the
  merged content): `{ t, type: 'save_merged', file, result }` â€” an observation
  we really made, in the observed-history stream where it belongs.
- `countsArePartial` stays untouched â€” it describes *observed* counts, and they
  are still partial; the UI just no longer has to apologize for it (Â§4).

**Analysis re-queue**: after a merge that changed `outcome`, filled gaps, or
landed on a run with `analysisStatus: 'done'`, set `analysisStatus: 'pending'`
and `AnalysisRunner.enqueue(id)`. The analyzer gains save-aware inputs
opportunistically: `countShops()` uses real shop rooms, removals-passed becomes
exact, offers from `saveData.floors[].cardChoices` join `collectOffers()`'s
event-derived records for pick-rate context (marked as save-sourced so the
"card use is counted from pile transitions" footnote stays truthful).

**Catalog**: `catalogEntryFromRun` mirrors a `hasSaveData: boolean` (and the
upgraded outcome/state/ascension flow through the existing fields), then one
`JournalPush` `{ kind: 'catalog' }` as with any other mutation.

### 3.5 Retroactive sweep

On startup (after `RunStore.open()`/`scan()`, off the critical path, same
politeness as `AnalysisRunner`'s startup re-queue): walk every discovered
`history\` dir, skip files already terminal in `save-index.json`, run
Â§3.2â€“Â§3.4 on the rest. First run of the feature merges the entire back catalog
of journal-recorded runs in one pass (on this machine: 60 save files vs. a
young journal â€” most will be `unmatched`, which is correct and quiet).
Subsequent startups are incremental (`(mtime,size)` gate) â€” near-free.

### 3.6 Privacy

- Save files are **read** locally and never copied off the machine; nothing
  under `SlayTheSpire2\` is ever written, moved or deleted.
- Merged content stays in `%APPDATA%\reliquary\runs\` like every other journal
  byte: local only.
- MP teammate SteamID64s are personal identifiers: `saveData.players` stores
  them only as opaque local `playerKey` strings used to join `player_stats`
  rows; **telemetry never carries them** (events report counts and booleans:
  `journal_save_merged { matched_by, result, floors, players, ms }`).
- The seed is not sensitive and may appear in UI and telemetry.

---

## 4. UI touches (small)

- **Ledger rows sourced from the save** (hp/gold columns, enemy names, backfilled
  offer rows, purge/purchase rows) get one quiet provenance mark â€” a small
  glyph with the tooltip "from the game's save file" â€” on the *first* save-sourced
  column group per table, not per cell. No color shouting; the data is
  first-class, the mark is for honesty.
- **Limitations copy that disappears when `saveData` is present**: "HP and gold
  aren't readable in v1", "room types may be incomplete", "death vs victory not
  yet detected", the `'ended'` outcome badge, and the Archive's
  "suspended" row for runs the save proves abandoned. The copy stays for
  unmerged runs â€” the limitation is real until the file lands.
- **Outcome badges**: `Victory` / `Death â€” Fogmog` (killer named from
  `killedByEncounter`) / `Abandoned`. The Archive gains an ascension column for
  merged runs.
- **Unmatched saves**: a one-line Archive footer ("3 game history files aren't
  linked to any recorded run"), not a banner. No resolution UI in this WP â€”
  ambiguity is not expected (`start_time` is exact); the footer is a window
  into `save-index.json`, and Phase 3's import naturally shrinks it.
- **No new ambiguity flows**: the seed/start-time key is exact, so unlike
  session matching there is no D4-style "ask the user" case. Conflicts park
  silently and count in the footer.

---

## 5. Open questions (with recommended defaults)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Does the game ever write `history\<key>.run` *before* the run ends (e.g. on suspend-to-menu of a resumable run)? f8d60a's file appeared at abandon time, but one observation is not proof. | Assume it can; Â§3.2's terminality gate makes the answer harmless. Add telemetry (`journal_save_not_terminal`) so one evening of play answers it. |
| Q2 | `run_time` units. A 67-min 3P victory shows `4024` (â‰ˆ seconds of active play); the multi-session abandoned run shows `40779` (11.3 h â€” plausibly cumulative including map-idle). | Store raw as `runTimeS`, display nothing from it in v1; the journal's `activeMs` remains the pace denominator. Revisit with more samples. |
| Q3 | `players[].id` is `1` in solo, SteamID64 in MP. Is the local player identifiable in MP by matching the `<steamid>` directory name? | Yes on the evidence (own id appeared in the 3P roster). Use dir-name match, fall back to "roster order unknown" rather than guessing `players[0]`. |
| Q4 | Multiple profiles / `modded\`: watch all or active only? | Watch every populated `history\` dir (it is â‰¤3 watchers); tag `saveData.sourceFile` so a profile switch never mixes ledgers. |
| Q5 | Should unmatched saves with no journal run be *imported* as save-only Archive rows? | Yes, but Phase 3, behind one setting (default on). They arrive `observedFrom`-less with `countsArePartial: true`, no events/combats, `saveData` only â€” instant 60-run history for the Archive's win-rate and cohort baselines. |
| Q6 | Steam-cloud mirror: ever needed on this machine? | No â€” implement discovery fallback only, no watcher, log when used. |
| Q7 | `schema_version` bumps with game patches. | Hard-gate at â‰¤9, park `unsupported-schema`, telemetry with the new version number so support is a data-driven one-liner (extend the gate after inspecting a real file). |
| Q8 | Does a *journal-observed* final deck ever disagree with the save's? (torn reads, MP attribution) | Ship the `journal_save_deck_mismatch` probe; treat the save as tie-breaker only after the probe proves it clean. |

---

## 6. Implementation phasing

**WP-S1 â€” SaveScribe: discover, match, merge (main process only).**
`SaveScribe.ts` + `save-index.json` + `saveData` on `RunFile`/`journal.ts` +
outcome/state upgrades + analysis re-queue + startup and close-triggered sweeps
+ telemetry probes (Q1, Q8). *Acceptance:* on this machine, the f8d60a run flips
`suspended/null` â†’ `abandoned/'abandoned'` with `saveData.result: 'abandoned'`
and killer `ENCOUNTER.FOGMOG_NORMAL`; every journal run whose `runStartTime`
has a history file merges; all other save files are parked with an explicit
status; a second sweep is a no-op (index gate verified); nothing under
`SlayTheSpire2\` is opened for write; a live game with the overlay attached
survives a full sweep (defensive-read path exercised).

**WP-S2 â€” the full ledger in the UI + save-aware analysis.**
Route Ledger/report rows union `saveData.floors` (hp/gold columns, enemy names,
backfilled offers marked save-sourced, purchases/purges, rest choices); outcome
badges incl. killer; ascension column; limitations copy conditional on
`saveData`; unmatched-saves footer; `AnalysisRunner` consumes exact shops/
removals/offers with an updated footnote. *Acceptance:* a merged run's report
shows an hp/gold-per-floor strip and named fights with the provenance glyph;
an unmerged run still shows the v1 limitation copy verbatim; analysis of a
merged run reports exact removals-passed and re-ran automatically after merge.

**WP-S3 (optional) â€” save-only import + fallbacks.**
Q5 import of pre-Reliquary saves as Archive rows (cohort-split win rates get 60
runs of history immediately); Steam-cloud discovery fallback; `modded\`
profiles. *Acceptance:* Archive shows imported runs distinctly ("from save file
only", no pace/combat data), toggling the setting hides/re-imports cleanly, and
cohort baselines ("your 2P average") update to include them.

# User decisions (2026-08-14)

- **Pre-Reliquary history is NEVER imported in this phase.** No auto-import and
  no Settings button yet — bulk import is fully deferred behind a future
  setting (WP-S3 stays on the shelf). What ships now is only the automatic
  JOIN: listen for writes/edits to the game's save files and merge each
  terminal file into the run the journal itself recorded (exact runStartTime
  match; close/suspend triggers + fs.watch + startup sweep). Save files for
  runs the journal never recorded are left entirely alone.
