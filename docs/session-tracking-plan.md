# Run Journal â€” Session Tracking & Recorder Architecture Plan

Extends `docs/journal-plan.md` (capture schema, pick inference, analysis pipeline,
strict-v1 data limits â€” none of that is restated here). This plan answers the questions
that plan deferred: **when does a run file open, close, resume, or die â€” and how do we
know two observations belong to the same run**, given abandonment, multiplayer, quit &
resume, crashes, and an app that can be launched mid-run or closed for days.

UI reference (fixed, do not redesign): `docs/mockups/journal-blend.html` +
`docs/mockups/shot-blend.png` / `shot-blend-full.png`, spec'd in
`docs/mockups/journal-blend-spec.md`.

Everything below is grounded in the current readers; every claimed signal carries a
file/line citation, and every gap is named as a gap.

---

## 1. Signal inventory â€” what lifecycle detection can actually see

The reader child polls the game at ~150 ms (`src/main/scry/provider.ts:41-43`) and the
provider re-emits change-driven keyed snapshots. The recorder consumes exactly the same
stream. Signals, grouped by lifecycle question:

### 1.1 Process & attach

| Signal | Source | Notes |
|---|---|---|
| Game window present / pid / bounds / focus | `connection.ts:35-54` (`findGameProcess`, window class `Engine` / name `Slay the Spire 2`, lines 19-20), surfaced as `process` messages (`readerProtocol.ts:36-41`) | Window-based; a hung-but-windowed game still "exists" |
| Attach success/failure | `connect` message (`readerProtocol.ts:42`), handled `provider.ts:196-209` | |
| Process gone | `processGone` (`readerProtocol.ts:43`) â†’ `provider.ts:271-282` `handleProcessGone()` â€” resets run state and emits idle snapshots | **Game quit-from-menu, game killed via task manager, and game crash are indistinguishable here.** All three are `processGone`. Design must not care. |
| Reader child crash (our side) | `ReaderHost` restarts with backoff (`ReaderHost.ts:24-26`), last snapshot cached (`ReaderHost.ts:39`) | Costs â‰¤ a few seconds of observation, not app state |
| Game build version | `readGameVersion` (`readers.ts:411-419`) | Goes in run file; a version change across a resume is worth recording |

### 1.2 In-run vs not

| Signal | Source | Notes |
|---|---|---|
| Scene is a run | `readNGameState` returns non-null only when the current scene is `NRun` (`readers.ts:173-176`); main menu is a recognized scene (`models.ts:252`, `NGame.getCurrentScene` 674-681) but reads as `nGame: null` | So: **process alive + `nGame` null = menu or loading screen**. We cannot distinguish "quit to menu" from "loading between scenes" instantaneously â€” only by persistence (debounce, Â§3.2). |
| Character id | `readers.ts:215` via `findLocalPlayer` â†’ `Player.getCharacterId()` (`models.ts:126-129`) | Reports transient `''` on menus/transitions; the provider already ignores empties (`provider.ts:302-309`) and **fires `resetRunState()` on a real character change** (`provider.ts:307`, definition 642-654). The recorder mirrors this trigger but must NOT treat character change as "old run dead" â€” see Â§2. |
| Act index | `readers.ts:214` (`run._state._currentActIndex`) | Monotonically non-decreasing within one run. 0-based. |
| Room type | `readers.ts:183-187` | Only `combat` / `merchant` / `event` / `other`. Room transitions = our room counter. |
| Game over | `readers.ts:189-195` â€” overlay stack scan for `NGameOverScreen` (`models.ts:253-254`) | Boolean only. **No death-vs-victory variant** (journal-plan Phase-2 gap); recorder writes `'ended'` until the micro-reader lands. |

### 1.3 Run content (identity material)

| Signal | Source | Notes |
|---|---|---|
| Owned deck, anywhere in a run | `RawPileState.deck` â€” `Player.Deck` (`models.ts:142-146`), read unconditionally in `readPileState` (`readers.ts:89-107`) | id + `upgradeLevel` + enchantment per card. **This is the identity backbone**: readable at attach time, on the very first poll of a resumed run. |
| Combat piles | `readers.ts:105-123` | Per-combat aggregation (journal-plan Â§3.1); not identity material |
| Offers / shop stock | `readVisibleItems` (`readers.ts:280-408`) | Event material only |
| Combat in progress / whose turn | `readEnemiesState` (`readers.ts:133-157`) | Suspension mid-combat is detectable (dangling combat row, Â§3.5) |

### 1.4 Multiplayer â€” what is genuinely readable

`RunState._players` is a **`List<Player>`** (`models.ts:262-269`), each `Player` carries
`NetId` (`models.ts:117-121`) and `Character`, and `findLocalPlayer` already walks the
list comparing against `LocalContext.NetId` (`models.ts:713-721`, `742-751`). The filter
exists *because* multiple players can be present â€” the plumbing for a player count is
already ported; it is simply never surfaced.

**New micro-reader (WP1, ~15 lines):** add to `RawNGameState`:
`playerCount: number | null` (count of non-null `_players`) and
`otherCharacterIds: string[]` (remote players' character ids). Same objects the reader
already walks; no new memory frontier.

**Honest caveats, stated once and designed around:**
- Whether `_players` actually enumerates *remote* players during a live MP session is
  decomp-implied, not runtime-verified (open question Q3). Until verified live,
  `playerCount` may read 1 in MP; the run file stores it as observed, nullable.
- We cannot see lobby identity, host/guest role, or whether remote players resumed.
  None of that is needed for matching (Â§2.6) â€” only for display and analysis cohort
  labeling.

### 1.5 Gaps that shape this design (ruthless list)

1. **No run seed / save-slot id is readable.** Nothing like `RunState._seed` is ported,
   and its existence in StS2's `RunState` is unconfirmed (Q2). If it exists, session
   identity becomes exact and Â§2 collapses to a lookup. The design below does not
   depend on it, but WP1 includes a decomp check because the payoff is total.
2. **Quit vs crash of the game: indistinguishable** (both `processGone`). Design: both
   are just "suspend"; the *game's own save* is what defines whether the run still
   exists, and we re-derive that from content at next sight (Â§2).
3. **Game-quit-to-menu vs loading screen: indistinguishable instantaneously** (both
   `nGame: null` with process alive). Design: 10 s debounce before treating null as
   "left the run" (Â§3.2).
4. **No observed beginning for mid-run attach** â€” rooms before attach are invisible;
   room counts are *ours*, not the game's. Run files carry `observedFrom` and per-gap
   markers so counts stay honest.
5. **No floor number, no rooms-remaining, no in-game timestamp** â€” wall-clock and our
   own room counter are the only progress clocks (journal-plan Â§2.1).
6. **The game saves and progresses while our app is closed.** The largest identity
   problem is not quit/resume â€” it is *our absence during play* (Â§2.4 case R3).

---

## 2. Session identity & matching â€” the core section

### 2.1 The question, answered up front

> Can we confidently identify sessions without asking the user?

**Yes â€” asking can be eliminated entirely**, with one stated policy, because of a
compounding of three facts:

1. **Content is identity.** The owned deck (id + upgradeLevel multiset) is readable on
   the first poll of any run. A StS2 run's deck at resume is *byte-identical* to its
   deck at suspension when we observed the suspension (the game restores its save; a
   restarted combat does not mutate the owned deck). So exact `deckHash` + character +
   act match is not a heuristic â€” it is an identity proof for every observed-suspend â†’
   observed-resume pair, regardless of elapsed days.
2. **The game itself enforces at most one resumable run per character** (StS1 behavior;
   assumed for StS2, verification task Q1). Starting a new run with a character
   abandons that character's suspended save *in the game*. Therefore among our
   suspended files for a character, only the newest can possibly still be live â€” every
   older one is already dead in-game, and silently marking it `abandoned (superseded)`
   is not a guess, it is bookkeeping.
3. **The only genuinely ambiguous window is informationally empty.** Ambiguity requires
   two same-character runs whose deck multisets are indistinguishable â€” which, given
   upgrades count and removals count, means *neither run has yet made a distinguishing
   choice* (first ~2-3 rooms, before the first pickup/upgrade/removal). A wrong merge
   inside that window misattributes at most a handful of `room_enter` breadcrumbs
   between two near-empty stubs. The cost of the worst-case wrong answer is below the
   threshold of user-visible meaning â€” strictly cheaper than interrupting a game with
   a dialog.

**Recommended policy (adopt): never ask.** Most-recent-wins + content matching + silent
supersession + honest gap markers, with a later Archive affordance ("split into two
runs" / "merge") as the escape hatch for the theoretical residue. If the Q1 assumption
is falsified, the decision table below still resolves every case without asking â€” the
residual mis-merge risk stays confined to the same empty window.

### 2.2 Session vocabulary

- **Run** â€” one game run; one file `userData/runs/<id>.json`; one catalog row.
- **Session (observation segment)** â€” one contiguous span during which the recorder
  observed that run (attach â†’ detach). A run has â‰¥ 1 sessions; gaps between sessions
  are either *observed-idle* (game closed) or *unobserved-play* (game ran without us).
- **Suspension** â€” run leaves observation: quit-to-menu (debounced `nGame: null`),
  `processGone`, character switch, or app shutdown mid-run.
- **Sighting** â€” a run becomes observable: stable `characterId` + non-empty owned deck
  after idle/menu/attach/character-change.

### 2.3 The match fingerprint

Computed at every sighting from the first stable polls (require the same values for 3
consecutive polls, mirroring `OFFER_STABLE_POLLS` â€” memory flickers mid-transition):

```
F = {
  character:  RawNGameState.characterId,
  act:        RawNGameState.currentActIndex,
  deck:       sorted multiset of "<ID>#<upgradeLevel>" from RawPileState.deck,
  deckHash:   sha1(deck),          // same construction as journal-plan Â§2.4
  deckSize:   |deck|,
  playerCount (nullable, WP1)
}
```

Candidates: catalog entries with the same `character` in state `suspended` (which
includes crash-orphaned `recording` files demoted on startup, Â§3.6). Wall-clock recency
orders candidates but **never disqualifies them** â€” a two-week-old suspension with an
exact deck match is the same run, proven by content, and resumes.

Match predicates against a candidate `C` (whose file stores its last-seen fingerprint):

- **EXACT**: `deckHash == C.deckHash && act == C.act`. Identity proof.
- **EVOLVED** (play happened while we weren't looking): `act >= C.act`, and the deck
  multiset moved the way a run moves â€” `removed = C.deck âˆ– F.deck` (cards lost) small
  (`|removed| â‰¤ max(2, ceil(0.15Â·|C.deck|))` â€” removals/transforms are rare, a few per
  run) while retention is high (`|C.deck âˆ© F.deck| / |C.deck| â‰¥ 0.75`). Upgrades count
  as remove+add, which the tolerance absorbs. Deck shrink below `|C.deck| âˆ’ removed`
  tolerance fails this predicate.
- **STARTER-SHAPED**: `F.deckSize â‰¤ 12 && act == 0` and â‰¥ 80 % of `F.deck` are the
  character's basic ids â€” i.e. "this could be a brand-new run".
- **DIVERGED**: neither EXACT nor EVOLVED.

### 2.4 Decision table (observation â†’ confidence â†’ action)

`Cnew` = newest suspended same-character candidate after supersession sweep (older
same-character suspended files are marked `abandoned(superseded)` the moment a sighting
occurs â€” per assumption Q1 they are already dead in-game; if Q1 falls, this line alone
becomes "most-recent-wins policy" instead of "fact", with identical behavior).

| # | Sighting observation | Confidence | Action |
|---|---|---|---|
| D1 | No suspended candidate for this character | certain | **New file.** `observedFrom: act==0 && starter-shaped ? 'start' : 'mid-run'`; if mid-run, `startedAt: null`, `firstSeenAt: now`, room counter starts at 0 with `countsArePartial: true` |
| D2 | EXACT vs `Cnew` | certain (identity proof) | **Resume `Cnew`.** New session segment appended. Covers quit-and-resume same day, days later, game crash mid-combat, app restart mid-run â€” all the same case |
| D3 | EVOLVED vs `Cnew` | high | **Resume `Cnew` with gap.** Append session + `gap` event (`{type:'gap', reason:'unobserved-play', actFrom, actTo, deckDelta}`); pace and room counts exclude the gap; Archive row shows "partially observed" |
| D4 | STARTER-SHAPED, and `Cnew` is also early (`deckSize â‰¤ 12`) and EXACT fails | ambiguous â€” **but provably harmless** (see Â§2.5) | Policy: if `F.deck âŠ‡ C.deck` â†’ resume as D3; else **new file + `Cnew` â†’ abandoned(superseded)**. Either wrong answer costs â‰ˆ 0 |
| D5 | STARTER-SHAPED, `Cnew` is deep (`deckSize > 12`) | certain | **New run** (a 20-card run cannot regress to a starter deck). `Cnew` â†’ `abandoned(superseded)`. This is "abandon then start new run same character" |
| D6 | DIVERGED, not starter-shaped | high | **New file**, `observedFrom:'mid-run'`; `Cnew` â†’ `abandoned(superseded)`. (Reachable only when we missed both the abandonment and the new run's start) |
| D7 | EXACT deck but `act < C.act` | impossible for one run | **New file** + telemetry issue (`journal_match_anomaly`) â€” signals a wrong assumption, which we want reported, not papered over |
| D8 | Multiple candidates survive supersession (only if Q1 false) | n/a | Apply D2â€“D6 against best-scoring candidate (EXACT â‰« EVOLVED retention â‰« recency); never ask |
| D9 | `isGameOver` observed | certain | Close active run (`'ended'`, â†’ death/victory when the variant reader lands). A game-over run never re-enters matching |
| D10 | Character change mid-observation (`provider.ts:307` trigger) | certain | Suspend current run (it may be resumed later â€” switching characters does NOT kill a run), then run this table for the new character's sighting |

**"Ask user" does not appear in the table.** By construction the only case where the
matcher can be wrong (D4) is the case where being wrong doesn't matter.

### 2.5 The genuinely ambiguous case, quantified

Two abandoned early runs, identical starter decks, same character. When can D4 pick
wrong? Both runs must be pre-divergence: no card taken, no upgrade, no removal â€” since
any of those changes the multiset (upgrades change `ID#upg`; even same-card picks in
different order converge to the same multiset only if the *sets of choices* were
identical). Empirically that is rooms 1â€“3: the first card reward (~R1â€“R3) has 3 choices
from a large pool; the probability two runs remain multiset-identical past the first
reward decision is the probability of identical pick-or-skip from identical offers â€”
and offers themselves are randomized. Compounded with act and deck size agreement,
collisions past ~room 3 are practically impossible; past act 0 they require an
essentially impossible sequence of identical drafts and upgrades.

**Residual ambiguity window: from run start until the first deck-mutating decision
(â‰ˆ 2â€“3 rooms, â‰ˆ 2â€“3 minutes of play).** Inside it, the two candidate answers ("resume
stub A" vs "new stub B") differ by: a few `room_enter` events, `startedAt`, and one
catalog row. No picks, no combats of consequence, no analysis. That is the entire
worst case, and it is why the never-ask policy is safe rather than merely optimistic.

### 2.6 Multiplayer

- **Matching is unchanged.** All identity material is the *local* player's deck +
  character; host/guest quit/resume looks exactly like solo quit/resume from our seat.
  A guest rejoining a host's lobby resumes their own deck â†’ EXACT/EVOLVED as usual.
- **Detection**: `playerCount` from the WP1 reader, sampled per session segment and
  stored per session (`sessions[i].playerCount`) â€” it could legitimately differ across
  resumes if verification (Q3) reveals drop-in behavior. Run-level
  `playerCount = max(sessions)` for the catalog, `null` when never readable.
- **Cohort effect**: runs with `playerCount > 1` are tagged `MP` in Archive rows and
  the run header, are **excluded from "your archive average" pace/deck-shape
  comparisons** (their pacing and drafting are structurally different), and the
  Journey Review renders its community-stats proxy with an extra caveat chip (the
  spire-codex aggregates are not MP-sliced). `playerCount: null` runs are treated as
  solo but keep the null in the file â€” honest, re-classifiable later.

---

## 3. Recorder architecture

### 3.1 Placement & data flow

`RunRecorder` is a main-process service in `src/main/journal/`, wired in `index.ts`
beside the provider. It taps the **already-central** snapshot funnel: `emitSnapshot()`
(`src/main/index.ts:173-206`) calls `recorder.observe(snap)` before `broadcast`, and
`wireScry`'s `onProcess` callback (`index.ts:210-237`) calls
`recorder.onProcess(state)`. No provider surgery: everything Â§1 lists already flows
through those two chokepoints (`handleProcessGone` emits idle snapshots +
`onProcess({detected:false})`, so both suspension signals arrive). The recorder is
inert in stub mode (`usingScry === false`) except when `SPECTRA_STUB` +
`SPECTRA_JOURNAL_STUB` are set for UI development.

```
ReaderHost â”€ snapshots â”€â–¶ Sts2ScryProvider â”€ emitSnapshot â”€â–¶ RunRecorder â”€â–¶ RunStore â”€â–¶ userData/runs/
                                                   â”‚                â”‚
                                                   â–¼                â”œâ”€â–¶ journal.currentRun (keyed snapshot, live)
                                              renderer IPC          â””â”€â–¶ journal:push (catalog/analysis changes)
```

Components:
- **`SessionMatcher.ts`** â€” pure functions: fingerprint from raw state, predicates,
  decision table Â§2.4. No I/O; unit-testable against scripted snapshot sequences.
- **`RunRecorder.ts`** â€” the state machine + event derivation (journal-plan Â§2.2's
  event list, unchanged) + snapshot maintenance.
- **`RunStore.ts`** â€” files, catalog, atomic writes, scan/repair. No game knowledge.
- **`AnalysisRunner.ts`** â€” journal-plan Â§3.4, triggered on close; out of scope here
  beyond the `analysisStatus` field it maintains.

### 3.2 State machine

```
            sighting â†’ match (D1â€“D8)
   idle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¶ recording â”€â”€ isGameOver (D9) â”€â”€â–¶ closing â”€â”€â–¶ closed{ended|death|victory}
    â–²                                        â”‚  â–²
    â”‚            nGame null â‰¥10s (menu)      â”‚  â”‚  sighting matches this run (D2/D3)
    â”‚            OR processGone              â–¼  â”‚
    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ suspended â”€â”€ superseded (D4/D5/D6) â”€â”€â–¶ abandoned
                                             â”‚
                                             â””â”€â”€ (never by timeout â€” display only, Â§5.1)
```

- **idle â†’ recording**: sighting = stable `characterId` + non-empty `deck` for 3
  consecutive polls. Runs the matcher; opens or resumes a file; appends a `session`
  entry `{ attachedAt, playerCount, gameVersion }`.
- **recording â†’ suspended**: (a) `nGame === null` (idle nGameState â€” `localPlayer`
  null) persisting **10 s** while the process is detected â€” the quit-to-menu debounce
  (Â§1.5 gap 3; loading screens between rooms/acts stay under it); (b) `processGone` /
  `detected:false` â€” immediate; (c) app quitting (`will-quit`, flush synchronously);
  (d) character change (D10). Session entry gets `{ detachedAt, reason:
  'menu'|'process-gone'|'app-quit'|'character-switch' }`.
- **recording â†’ closing**: `isGameOver` true. Write `game_over`, finalize after the
  game-over screen persists 2 polls (guards a flickered read), state â†’ `closed`,
  outcome `'ended'` (variant reader later), kick analysis.
- **suspended â†’ recording**: matcher D2/D3 on a later sighting â€” same process or a
  process restarted days later; identical code path.
- **suspended â†’ abandoned**: supersession only (D4/D5/D6 sweep). Never by clock.
- Combat mid-suspension: the open combat row is marked `aborted: true` on suspension;
  on resume the game restarts the combat from its start, so the aborted row is
  **excluded from play/draw aggregates** (prevents double counting; Q9 verifies the
  restart assumption â€” if StS2 instead resumes mid-combat, drop the exclusion).

### 3.3 Event log + snapshots (the user's explicit ask)

The run file is **event-sourced with an embedded snapshot** â€” events are the truth for
the timeline/analysis; the snapshot exists so nothing ever replays a full event log to
answer "where was this run" (catalog, matcher, resume, Current Run header all read the
snapshot alone).

```jsonc
// userData/runs/<id>.json â€” extends journal-plan Â§2.3; new/changed fields only
{
  "schema": 1,
  "state": "recording | suspended | closed | abandoned",
  "outcome": null,                    // 'ended'|'death'|'victory'|'superseded' when terminal
  "observedFrom": "start | mid-run",
  "startedAt": 1786662011000,         // null when observedFrom = mid-run
  "firstSeenAt": 1786662011000,
  "lastSeenAt": 1786665104000,
  "countsArePartial": false,          // true when mid-run attach or any gap event exists

  "sessions": [                       // observation segments, append-only
    { "attachedAt": 0, "detachedAt": 0, "reason": "menu",
      "activeMs": 1712000,            // monotonic-clock duration (Â§5.3)
      "playerCount": 1, "gameVersion": "1.3.0.123" }
  ],

  "snapshot": {                       // derived state â€” current as of every flush
    "at": 1786665104000,
    "act": 2, "roomIndex": 23, "roomType": "combat",
    "deck": ["STRIKE#0","STRIKE#0", "BASH#1", "..."],   // the matcher fingerprint
    "deckHash": "c1f4â€¦",
    "eventCount": 143,                // events folded into this snapshot
    "combatAgg": { "plays": {"STRIKE": 41}, "drawn": {"STRIKE": 52} },
    "openCombat": null,               // in-progress combat row or null
    "openOffer": null,                // offer awaiting pick-inference or null
    "paceActiveMs": 1712000
  },

  "events": [ /* journal-plan Â§2.2, plus: */
    { "t": 0, "type": "session_attach", "sid": 1 },
    { "t": 0, "type": "session_detach", "sid": 1, "reason": "process-gone" },
    { "t": 0, "type": "gap", "reason": "unobserved-play",
      "actFrom": 1, "actTo": 2, "deckAdded": ["CARNAGE#0"], "deckRemoved": [] }
  ],
  "combats": [ /* journal-plan Â§3.1; aborted rows carry "aborted": true */ ],
  "analysis": null
}
```

- **Snapshot cadence**: refreshed in memory on every event; persisted with every flush
  (the file is rewritten whole, so a fresh snapshot costs nothing extra). The
  *semantic* snapshot points are `room_enter`, `combat_end`, `session_attach/detach`,
  and a 60 s heartbeat during long combats â€” these force a flush even if the debounce
  hasn't elapsed. Snapshot contains **derived state**; events contain **history**. A
  reader that trusts only the snapshot is never wrong about the present; a reader that
  folds `events[eventCount:]` over it reconstructs exact state (the recovery path).
- **Flush policy**: debounced 2 s batches (journal-plan's crash budget), immediate on
  every lifecycle transition and on `will-quit` (synchronous write, matching how
  `SettingsStore` writes sync â€” `SettingsStore.ts:37-45`).
- **Crash-safe write pattern**: `write <file>.tmp` â†’ `rename` over the target (atomic
  on the same NTFS volume; `fs.rename` replaces on Windows). This is deliberately
  *stronger* than `CompendiumService.saveDisk`'s plain `writeFile`
  (`CompendiumService.ts:358-373`) â€” a torn compendium cache refetches; a torn run
  file loses a run. On load: parse target, else parse `.tmp` (a crash between write
  and rename), else quarantine to `<id>.json.corrupt` and drop from catalog with a
  telemetry issue.
- **Resume-from-snapshot on app restart**: startup scan (Â§3.6) loads each
  `recording`-state file, folds trailing events over the snapshot, closes dangling
  combat/offer as aborted, demotes state to `suspended`. Cost: one file parse per
  crashed run â€” no full-log replays.
- **Schema versioning**: `schema: 1` at top level. Readers of unknown *higher* schema
  render an "update Reliquary to view this run" row rather than guessing (files are
  user data; never destructively migrate). Additive changes (new nullable fields, new
  event types) do not bump the version â€” consumers must ignore unknown event types.
  Bump only on incompatible shape changes, with an explicit migrate-on-load function
  per step (`migrations/1to2.ts` pattern, run at scan time, written back atomically).

### 3.4 Catalog â€” `userData/runs/catalog.json`

The Archive's index; **a cache, never the truth** (run files are). Same atomic write
pattern, debounced with the same flusher.

```jsonc
{
  "schema": 1,
  "rebuiltAt": 1786665104000,
  "entries": [{
    "id": "2026-08-12T23-40-11Z-ironclad-a41f3c",
    "character": "IRONCLAD",
    "startedAt": 1786662011000,       // null â†’ Archive shows firstSeenAt + "joined mid-run"
    "firstSeenAt": 1786662011000,
    "lastSeenAt": 1786665104000,
    "state": "closed",
    "outcome": "ended",
    "actReached": 2,
    "roomsEntered": 45,               // observed rooms; countsArePartial mirrors the file
    "countsArePartial": false,
    "deckSize": 26,
    "deckHash": "c1f4â€¦",
    "core": ["DEMON_FORM", "INFLAME"],
    "playerCount": 1,
    "activeMs": 3093000,
    "analysisStatus": "none | pending | partial | done | failed",
    "file": "2026-08-12T23-40-11Z-ironclad-a41f3c.json",
    "fileBytes": 88412
  }]
}
```

**Rebuild-by-scan repair**: on startup, and whenever a catalog/file inconsistency is
detected (entry without file, file without entry, hash mismatch on load), the store
scans `userData/runs/*.json`, rebuilds every entry from each file's header + snapshot,
and rewrites the catalog. Scan is also the crash-recovery walk (Â§3.3). A missing or
corrupt catalog is therefore always a warm restart away from correct, and the matcher
reads candidates from the rebuilt catalog (deckHash + state are in it â€” matching never
opens run files except the single chosen candidate).

### 3.5 What the recorder derives (delta to journal-plan Â§2.2)

The event list and pick-inference rules are journal-plan Â§2.2 verbatim. Session-layer
additions only: `session_attach` / `session_detach` / `gap` events; per-combat
`aborted` flag; `run_start` is only written when `observedFrom === 'start'`
(mid-run attach gets `session_attach` with no `run_start` â€” the Archive renders the
distinction); `run_end` is replaced by the state machine's transitions (suspension is
not an end; only `closed`/`abandoned` are terminal).

### 3.6 Startup sequence

1. `RunStore.open()`: load catalog; scan-repair if inconsistent/missing.
2. Demote orphaned `recording` files â†’ `suspended` (fold trailing events, close
   dangling combat/offer rows as aborted). These are full resume candidates.
3. No abandonment sweeps at startup (supersession happens only at sighting time â€”
   Â§2.4; timeouts are display-only â€” Â§5.1).
4. Recorder starts `idle`; first sighting drives the decision table.

### 3.7 IPC surface + preload

Follows the codex spine exactly: invoke channels resolve `{data}`/`{error}` and never
reject (guarded via the existing `handle()` wrapper, `index.ts:265-273`); pushes ride a
dedicated channel like `IPC.CodexPush` (`index.ts:123`, `preload/index.ts:97-101`);
live state rides the existing keyed-snapshot channel.

| Surface | Kind | Payload |
|---|---|---|
| `journal.currentRun` | keyed snapshot (existing `IPC.Data` path, replayed on `RequestState` like every key â€” `index.ts:297-309`) | `null` when idle, else `{ runId, state, character, act, roomIndex, deckSize, paceActiveMs, elapsedActiveMs, recentRoute: last 6 route rows, playerCount }` â€” the Current Run header + mini-route. Deck/pile contents come from the existing `sts2.pileState`/`sts2.cardData` keys; no duplication. |
| `journal:list` | invoke | `{ data: CatalogEntry[] }` (newest first; renderer groups/filters) |
| `journal:get` | invoke | `{ data: RunFile }` by id (full file â€” report + review render from it) |
| `journal:delete` | invoke | user-initiated delete from Archive (file + catalog entry) |
| `journal:reanalyze` | invoke | re-kick analysis for a closed run |
| `journal:export` | invoke | resolve the file's absolute path copy for "Export JSON" (mockup header button) |
| `journal:push` | push | `{ kind: 'catalog', entries }` on any catalog change; `{ kind: 'analysis', id, status }` on pipeline progress â€” Archive and open reports live-update |

Preload adds the mirror methods to `SpectraApi` (`journalList/journalGet/â€¦/onJournalPush`)
next to the codex block (`preload/index.ts:85-101`).

---

## 4. UI wiring â€” mockup surfaces â†’ routes/components

The blend mockup is one page with three stacked states plus the sub-nav
(`Journal Â· Archive Â· Current Run` visible in `shot-blend.png`; states spec'd in
`journal-blend-spec.md` Â§2, Â§6). Real app: a **Journal tab** beside Codex in the shell
(`TitleBar.tsx` tab row; `Shell.tsx` renders the outlet with per-tab error boundaries),
built as a route-tree factory exactly like `codexRouteTree`
(`src/renderer/src/codex/routes.tsx:52`) so `App.tsx` stays the only owner of app shape.

```
/journal                       JournalLayout (sub-nav: Journal Â· Archive Â· Current Run; run picker + Export JSON)
â”œâ”€ ''                          â†’ newest closed run's report, else â†’ /journal/archive
â”œâ”€ run/$id                     RunReport   â€” mockup "STATE â€” RUN REPORT" (+ VICTORY header variant)
â”œâ”€ archive                     ArchiveView â€” catalog list (grouped by deck signature, journal-plan Â§2.4)
â””â”€ current                     CurrentRun  â€” mockup "STATE â€” LIVE Â· CURRENT RUN"
```

Per-view data (mockup section names from `journal-blend-spec.md`):

- **RunReport** (`journal:get` once + `journal:push {kind:'analysis'}` for live analysis
  arrival): *Run header plaque + manifest whisper* â† file header/sessions/snapshot
  (result banner from `state`/`outcome`; the VICTORY variant is the same component with
  outcome styling); *honesty whisper* â† static strict-v1 line; *Route Ledger* + census
  strip â† `events` (room_enter/offer/deck deltas folded into rows; act dividers from
  `act_change`; `gap` events render as a dim divider row â€” "unobserved play Â· act 1â†’2 Â·
  +1 card", new since mockup but same row grammar); *Deck Ledger* â† `finalDeck` +
  `combatAgg` (aborted combats excluded); *Relics & Potions honest strip* â† shop-stock
  sightings from `offer_shown` events; *Journey Review findings* â† `analysis` field
  (pending â†’ the strip renders "analysis pending Â· N req" from `analysisStatus`).
- **ArchiveView** (`journal:list` + `journal:push {kind:'catalog'}`): rows straight from
  catalog entries â€” character tint, outcome/state chip (Â§5.2 vocabulary), act, rooms
  (`â‰ˆ` when partial), deck size, signature group header via `core`/`deckHash`, MP tag,
  analysis chip, relative `lastSeenAt`. Row click â†’ `run/$id`. Delete + export actions.
- **CurrentRun** (subscribes `journal.currentRun` + existing `sts2.pileState`,
  `sts2.nGameState`, `sts2.cardData` via the same `useIpc` snapshot hook the overlay
  and dashboard already use): *header plaque LIVE variant* â† `journal.currentRun`;
  *Combat piles panel* â† `sts2.pileState` counts; *Route-so-far panel* â† `recentRoute`
  (same row component as the Route Ledger â€” build it shared from day one). Idle state:
  "no run in progress" plate with the last run's link. Updates at snapshot cadence â€”
  no polling, it's the push the overlay already lives on.

Reuse from codex: name/art resolution (`codex/data.ts` hooks + `sts2.cardData` name
map + CDN sprite components with the mandatory onerror plates, `ArtPreview.tsx`),
chip/section/whisper primitives (`codex/parts.tsx`, tokens in `overlay.css`), tier
palette (`tiers.ts`) for verdict/severity chips. Do not fork these; the mockup was
built from their tokens (`journal-blend-spec.md` Â§8).

---

## 5. Lifecycle policies

### 5.1 Abandonment & supersession

- **Supersession is the only automatic terminal transition** for an unfinished run
  (D4/D5/D6): the game itself invalidated the save. Recorded as
  `state:'abandoned', outcome:'superseded'`, with a terminal event naming the
  superseding run id (navigable in Archive).
- **Timeouts never change state.** A suspended run older than **48 h** *displays* as
  "abandoned?" in the Archive (dim state chip); older than **14 d** it displays plainly
  as "abandoned" â€” but the file stays `suspended` and remains a full resume candidate
  forever, because content match is proof (Â§2.1) and a false abandon that later
  resumes would be a lie we'd have to unwind. Display-only staleness costs nothing.
- **App uninstall/reinstall**: files are userData; catalog rebuild-by-scan restores the
  Archive; suspended runs resume across reinstalls.

### 5.2 What the user sees per state (Archive vocabulary)

| File state | Archive chip | Notes shown |
|---|---|---|
| `recording` | `LIVE` (aqua outline) | row links to Current Run |
| `suspended` < 48 h | `SUSPENDED` (dim outline) | "resumes automatically when you continue" |
| `suspended` 48 hâ€“14 d | `ABANDONED?` (dim) | same row affordances |
| `suspended` > 14 d | `ABANDONED` (dim) | |
| `abandoned` (superseded) | `ABANDONED` (orange outline) | "superseded by <run>" |
| `closed / ended` | `ENDED` (gold) | until variant reader: honest label, not a guessed death |
| `closed / death` | `DEFEATED` (red solid) | mockup banner vocabulary |
| `closed / victory` | `VICTORIOUS` (green solid) | |
| partial observation | `â‰ˆ` prefix on rooms + "joined mid-run" / "gaps" whisper | from `countsArePartial` |

### 5.3 Clocks & skew

- All persisted timestamps are wall-clock epoch ms (display, matching recency order).
- All **durations** (pace, elapsed, session `activeMs`) accumulate from the monotonic
  clock (`process.hrtime.bigint()` deltas per session segment) â€” a laptop sleeping,
  DST, or NTP jump mid-session cannot produce negative or inflated pace. `lastSeenAt`
  is clamped monotonically non-decreasing per file; a backwards wall-clock jump > 5 min
  is recorded as a telemetry crumb, and recency ordering falls back to file mtime if
  two entries' wall-clocks interleave impossibly.
- Wall-clock plays **no role in identity** (Â§2.3) â€” skew cannot corrupt matching.

### 5.4 Storage bounds

- Expected file size: tens of KB (a 50-room run â‰ˆ 300â€“600 events + aggregates); even
  hundreds of runs â‰ˆ single-digit MB. Recommendation: **no automatic pruning in v1**;
  per-run Delete in the Archive; telemetry on `runs/` total bytes; add a cap/prune
  policy only if telemetry shows a real tail (Q5). Hard safety valve only: if a single
  run's `events` exceeds 20 000 (a runaway loop, not a run), the recorder coalesces
  room-level events into the snapshot and flags the file `truncatedEvents: true`.

---

## 6. Open questions

Each with the recommended default the plan proceeds on. These drive the audit + user
Q&A; nothing else in the plan is knowingly uncertain.

1. **Does StS2 enforce at most one resumable save per character** (StS1 behavior)?
   Load-bearing for treating supersession as fact (Â§2.4). *Default: assume yes; add a
   5-minute in-game verification to WP3's acceptance; if false, behavior is unchanged
   (most-recent-wins policy) and only the D4 mis-merge risk commentary changes.*
2. **Is a run seed / save-slot id readable from `RunState`?** Would make identity
   exact and collapse Â§2 to a lookup. *Default: proceed without; WP1 includes a
   30-minute decomp check of `RunState` fields (seed, save id, floor, gold, hp are all
   plausibly adjacent â€” same trip as journal-plan Phase-2 scouting).*
3. **Does `RunState._players` enumerate remote players in live MP, and is
   `playerCount` stable mid-session?** (Â§1.4). *Default: ship the reader nullable;
   verify in one MP session; until verified, MP runs may read as solo â€” files keep
   `playerCount` as-observed and are re-classifiable.*
4. **MP resume semantics** â€” can a guest resume without the host; does `playerCount`
   change across resumes of one run? Affects per-session vs per-run storage only
   (already per-session, Â§2.6). *Default: per-session storage; no matching impact.*
5. **Storage policy** â€” keep-all vs cap. *Default: keep all, Delete affordance,
   telemetry on directory size (Â§5.4).*
6. **Display staleness thresholds** â€” 48 h "abandoned?" / 14 d "abandoned" (Â§5.1).
   *Default: as stated; pure presentation, trivially tunable.*
7. **Quit-to-menu debounce** â€” 10 s of `nGame: null` with process alive (Â§3.2). Too
   short misreads a long act-transition load as suspension (harmless: instant D2
   resume, one extra session row); too long delays Current Run going idle. *Default:
   10 s; tune with telemetry on false-suspend frequency.*
8. **Combat restart on resume** â€” does StS2 restart an interrupted combat from its
   start (StS1 behavior)? Decides whether aborted combat rows are excluded from
   aggregates (Â§3.2). *Default: assume restart â†’ exclude; verify once in-game during
   WP3; if StS2 resumes mid-combat, keep the row and drop the flag.*
9. **`isGameOver` flicker risk** â€” is the overlay-stack scan (`readers.ts:189-195`)
   ever transiently true outside a real game over? A false close is our worst wrong
   answer (a closed run never re-enters matching â€” the resumed game would open a
   duplicate mid-run file). *Default: require 2 consecutive polls + `roomType`
   consistency before closing; add telemetry on close events immediately followed by
   a same-character EXACT sighting (the signature of a false close), so the guard can
   be tightened from the field.*
10. **Archive merge/split affordance** â€” the escape hatch for Â§2.5's residue. *Default:
    not in v1 (the policy makes it near-unnecessary); catalog/file format requires no
    changes to add it later (splitting = partitioning `events` at a `session_attach`
    boundary into two files).*

---

## 7. Implementation phasing

Work packages sized for one Opus implementation agent each, in dependency order, on
the codex-tab-v2 data spine. Every WP leaves the app shippable.

**WP1 â€” Reader additions: player count (+ decomp scouting)**
Files: `src/main/scry/models.ts` (expose `RunState._players` count helper),
`src/main/scry/readers.ts` (`RawNGameState.playerCount`, `otherCharacterIds`),
`src/shared/types.ts` (`Sts2NGameState` passthrough), `src/main/scry/provider.ts`
(map through in `pollNGame`).
Acceptance: live solo run shows `playerCount: 1` in the Debug JSON view; nulls (not
throws) when `_state` absent; SPECTRA_DEBUG log line on count change. Timeboxed
decomp check for Q2 (run seed/id) documented as a note in this plan's Q2.

**WP2 â€” RunStore: files, catalog, atomic writes, scan/repair**
Files: `src/main/journal/RunStore.ts`, `src/shared/types.ts` (RunFile, CatalogEntry,
event types), `src/main/journal/__tests__/RunStore.test.ts`.
Acceptance: temp+rename write survives a mid-write process kill (test: write a large
file, SIGKILL a child doing it, reload â€” either old or new version parses, never
torn); catalog deleted â†’ rebuilt from scan byte-equivalent; corrupt run file â†’
quarantined `.corrupt` + telemetry, others unaffected; unknown-higher-schema file â†’
listed as unreadable, not crashed on.

**WP3 â€” SessionMatcher + RunRecorder state machine**
Files: `src/main/journal/SessionMatcher.ts`, `src/main/journal/RunRecorder.ts`,
wiring in `src/main/index.ts` (`emitSnapshot` tap + `onProcess`), tests
`__tests__/SessionMatcher.test.ts` with scripted snapshot sequences for **every row
D1â€“D10** plus: quit-resume same day; resume after 3 days; abandon â†’ new same-char run;
mid-run attach; processGone mid-combat then resume; two starter-deck stubs (D4 both
branches); character switch mid-observation.
Acceptance: all decision-table tests green; live smoke â€” start run, quit to menu,
resume â†’ one file, two sessions; kill game mid-combat, relaunch, continue â†’ same file,
aborted combat row excluded from aggregates; in-game checks for Q1/Q8 performed and
their answers recorded in Â§6.

**WP4 â€” IPC + preload + live key**
Files: `src/main/index.ts` (invoke handlers via existing `handle()` wrapper; recorder
push â†’ `journal:push`; `journal.currentRun` through `emitSnapshot` so `RequestState`
replay covers it), `src/preload/index.ts`, `src/shared/types.ts` (channel consts +
`SpectraApi` additions).
Acceptance: `journal:list/get` resolve `{data|error}` and never reject; a
freshly-opened dashboard receives `journal.currentRun` via RequestState replay;
catalog change while Archive is open arrives as a push without refocus.

**WP5 â€” Journal tab UI (three surfaces)**
Files: `src/renderer/src/journal/{routes.tsx, JournalLayout.tsx, RunReport.tsx,
ArchiveView.tsx, CurrentRun.tsx, rows.tsx (shared route-row/census/chips), data.ts
(journal IPC hooks)}`, graft in `App.tsx`, tab in `dashboard/TitleBar.tsx`.
Mockup fidelity: `journal-blend.html` sections per Â§4 mapping â€” tokens, chip
vocabulary, whispers, onerror art plates all reused from codex primitives; no
redesign, the only new row type is the `gap` divider.
Acceptance: with `SPECTRA_STUB` + a fixture run file dropped into a temp userData,
all three views render the blend mockup's content (report matches `shot-blend-full.png`
structurally); Current Run renders live against the stub scenario switcher; tab crash
isolation intact (Shell boundary). Kill + relaunch Electron dev app to verify main-
process changes (no hot reload â€” per project memory).

**WP6 â€” Analysis pipeline hookup**
Files: `src/main/journal/AnalysisRunner.ts` (journal-plan Â§3.4 budget/resume rules),
recorder close-hook, `analysisStatus` in catalog + `journal:push` progress,
`journal:reanalyze`.
Acceptance: closed run reaches `analysisStatus: done` within budget (â‰¤12 requests,
verified against `codexHttp` cooldowns); app killed mid-analysis resumes the remainder
next launch; RunReport findings populate live via push.

**WP7 â€” Packaged verification + polish**
Package a win `--dir` build (`signAndEditExecutable=false`, per project memory:
asar.unpacked forked bundles need `.mjs` â€” the recorder is main-process so no new fork,
but verify the runs dir resolves under the packaged userData). Acceptance: full
quit/resume/abandon cycle on a packaged build writes/reads `userData/runs/` correctly;
catalog survives an app update (schema untouched).

---

# Audit findings

Adversarial review of everything above against the live sources
(`src/main/scry/{readers,models,provider,connection,ReaderHost,readerProcess,readerProtocol,scryObject}.ts`,
`src/main/index.ts`, `src/main/codex/CompendiumService.ts`, `src/main/settings/SettingsStore.ts`,
`src/shared/types.ts`) and the fixed UI (`docs/mockups/journal-blend-spec.md`).
Verdict at the end. **The policy layer (Â§2, Â§5) survives; the wiring premise in Â§3.1 does not.**

## A. Citation table

| # | Plan claim | Cited | Status |
|---|---|---|---|
| 1 | Reader polls at **~150 ms**, cited to `provider.ts:41-43` | â€” | **REFUTED (both).** Poll interval is `POLL_MS = 250` (`readerProcess.ts:31`); detect loop is 2 s (`:30`). `provider.ts:41-43` is the `OFFER_STABLE_POLLS` comment, which itself still says "~450ms at 150ms" â€” a stale comment the plan inherited. Consequence: "3 consecutive polls" = 750 ms, 10 s debounce = 40 polls. |
| 2 | `readNGameState` non-null only when scene is `NRun` | `readers.ts:173-176` | **VERIFIED** (`:176`). **Incomplete**: it also returns null when `GlobalUi` is absent (`:178-179`), which per `models.ts:636-640` happens *inside* a live run while it loads/tears down. So `nGame: null` has three causes, not two. |
| 3 | Main menu is a recognised scene reading as `nGame: null` | `models.ts:252`, `NGame.getCurrentScene` 674-681 | **VERIFIED** (`NMainMenuClassName` at `:252`; `getCurrentScene` 674-681 maps it to a plain `ScryObject`, so `readNGameState` bails at `:176`). |
| 4 | Character id via `findLocalPlayer` â†’ `getCharacterId()`; "reports transient `''`"; provider ignores empties and resets on real change | `readers.ts:215`, `models.ts:126-129`, `provider.ts:302-309`, `307`, `642-654` | **VERIFIED with a correction.** `readers.ts:215` yields `null` (not `''`) when there is no local player; `''` only exists in the provider's coalescing (`provider.ts:305`). Reset-on-change (`:307`) and `resetRunState` (`:642-654`) verified. Also: `findLocalPlayer` returns null whenever `LocalContext.NetId` is null (`models.ts:745-749`) â€” a null NetId silently disables character **and** deck, i.e. the whole recorder. |
| 5 | Act index from `run._state._currentActIndex`, "monotonically non-decreasing, 0-based" | `readers.ts:214` | **PARTLY REFUTED.** Field verified (`models.ts:262-265`), but the read is `safe(() => run._state?._currentActIndex ?? 0, 0)` â€” **it falls back to 0 on an absent `_state` or a throw**, and `idleNGameState()` also emits `currentActIndex: 0` (`provider.ts:782`). Act is therefore *not* monotonic across transitions, and "act 0" is indistinguishable from "unknown". See defect A4. |
| 6 | Room type only `combat/merchant/event/other` | `readers.ts:183-187` | **VERIFIED.** |
| 7 | `isGameOver` = overlay-stack scan, boolean only, no death/victory variant | `readers.ts:189-195`, `models.ts:253-254` | **VERIFIED.** Scans the whole stack (not just the top) with `safe(...,false)` per entry, so a freed entry reads false. Flicker risk is low by construction (exact class-name equality); the realistic failure is a **missed** game-over, not a false one. |
| 8 | **`Player.Deck` readable any time in a run, unconditionally in `readPileState`** | `readers.ts:89-107`, `models.ts:142-146` | **VERIFIED as a reader-level claim** (read before the combat-room branch, `readers.ts:89-103`; model comment `:134-141`). **Two caveats the plan misses**: (a) the read is wrapped in try/catch and *falls back to `[]`* (`:99-103`) â€” a failed read is indistinguishable from "no deck"; (b) `List.map` walks `0..length-1` where `length` is `_size` captured at construction and `at()` reads a `_version`-keyed array (`scryObject.ts:212-250`), and `readPileState` **drops undefined slots** (`readers.ts:84`) â€” so a mid-mutation read yields a **short but non-empty** deck. See defect A3. Its runtime availability *during combat* is asserted by a code comment, never verified â€” see Q11. |
| 9 | `RunState._players` is a `List<Player>`; `Player` carries `NetId`; `findLocalPlayer` walks it against `LocalContext.NetId` | `models.ts:262-269`, `117-121`, `713-721`, `742-751` | **VERIFIED, all four** (`_players` 266-268; `NetId` 118-121; `LocalContext.NetId` 713-721; `findLocalPlayer` 742-750). The "plumbing already ported" claim is correct; `playerCount` is ~10 lines using `List.length`. Whether remote players actually populate `_players` remains decomp-implied, exactly as the plan states. |
| 10 | `processGone` â†’ `handleProcessGone()` resets and emits idle | `readerProtocol.ts:43`, `provider.ts:271-282` | **VERIFIED.** **Additional fact the plan does not know**: the reader **synthesises** `processGone` after 40 consecutive failed polls with the game still running (`readerProcess.ts:180-183`), and sends none at all when the *child* dies and respawns (`processGone()` is only reachable via `detect()` while connected, `:70`). So `processGone` â‰  "game gone", and "game gone" does not always produce `processGone`. |
| 11 | Window detection / `process` message shape | `connection.ts:35-54`, `19-20`; `readerProtocol.ts:36-41`, `42` | **VERIFIED, all.** |
| 12 | Reader restarts with backoff; last snapshot cached | `ReaderHost.ts:24-26`, `39` | **VERIFIED.** |
| 13 | Game build version | `readers.ts:411-419` | **VERIFIED.** |
| 14 | **`emitSnapshot()` + `onProcess` are chokepoints through which "everything Â§1 lists already flows"; no provider surgery** | `index.ts:173-206`, `210-237` | **REFUTED â€” the central defect.** The functions exist at those exact lines and are called unconditionally (dashboard open or not), but they carry the *derived, deduplicated* renderer contract, which omits nearly every signal the recorder needs. See defect A1 for the itemised proof. |
| 15 | `handle()` invoke wrapper resolves `{data}`/`{error}`, never rejects | `index.ts:265-273` | **VERIFIED** (`telemetry.guardAsync` + fallback). |
| 16 | Push channel pattern / `RequestState` replays every key | `index.ts:123`, `297-309`, `preload/index.ts:85-101` | **VERIFIED.** A new `journal.currentRun` key must be added to `Sts2StateMap` (`types.ts:213-222`) for `lastState` typing â€” already in WP4's file list. |
| 17 | `CompendiumService.saveDisk` is a plain `writeFile` (weaker than temp+rename) | `CompendiumService.ts:358-373` | **VERIFIED, exactly those lines.** |
| 18 | `SettingsStore` writes synchronously | `SettingsStore.ts:37-45` | **VERIFIED, exactly those lines.** |
| 19 | `fs.rename` replaces an existing file on Windows | Â§3.3 | **VERIFIED** (Node maps to `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`; no unlink-first needed). The real Win32 gaps are different â€” see A9. |
| 20 | Schema version present in both run files and catalog | Â§3.3, Â§3.4 | **VERIFIED** (`"schema": 1` in both). |
| 21 | Codex route-tree factory precedent | `renderer/src/codex/routes.tsx:52` | **VERIFIED** (factory exists; `App.tsx` owns app shape). |

## B. Confirmed defects

### A1 â€” CRITICAL â€” The recorder cannot be built on `emitSnapshot`; Â§3.1 must tap the raw stream

`emitSnapshot` is the *renderer* contract. Itemised, at that chokepoint the recorder would receive:

- **No owned deck.** `Sts2PileState` is `{draw, hand, discard}` (`types.ts:80-84`); `toPileState`
  consumes `raw.deck` internally for advice (`provider.ts:588`, `602-636`) and never emits it.
  **The entire identity backbone of Â§2 is not present at the chokepoint.**
- **No exhaust pile** (same type) â€” needed by journal-plan Â§3.1's play detection *and* rendered by
  the LIVE mockup's "Combat piles" panel.
- **No per-instance identity.** `Sts2Card` has no `baseAddress` (`types.ts:47-61`); `RawCard` does
  (`readers.ts:36`). Without it, drawn/played tracking (journal-plan Â§3.1, the Deck Ledger's two
  numeric columns) is impossible.
- **No offered ids, costs, or kinds.** `Sts2StatPanel` carries only geometry, a *display name*, and
  stat rows (`types.ts:127-168`). Pick inference needs `offered[]` **ids** and shop **prices**
  (`RawItem.id/cost`, `readers.ts:225-237`), which are dropped in `toLayoutState`.
- **No numeric advice.** `applyDeckAdvice` reduces `score` to a letter grade (`provider.ts:747-754`);
  `offer_shown.advice {score, base, reasons}` (journal-plan Â§2.2) cannot be reconstructed.
- **Deduplicated, so "polls" are not observable.** Every `poll*` emits only on JSON change
  (`provider.ts:341-345, 352-356, 378-382, 389-408`). "Require the same values for 3 consecutive
  polls" (Â§2.3, Â§3.2) is **unimplementable** on a stream that collapses identical polls into one
  event, and "10 s of `nGame: null`" degenerates to a single edge plus a timer.
- **No error context.** `readFailed` / `errorStreak` never reach `emitSnapshot`.

**Fix (fold into WP3, and edit Â§3.1):** add a third callback to `ScryProviderCallbacks`
(`provider.ts:52-55`) â€” `onRaw(raw: RawSnapshot, ctx: { detected: boolean; errorStreak: number; gameVersion: string | null })` â€”
invoked in the `'snapshot'` case (`provider.ts:215-221`) *before* the four `poll*` calls, plus
pass-throughs for `processGone`, `readFailed` and `gameVersion`. `RunRecorder.observe(raw, ctx)`
consumes `RawSnapshot` (`readerProtocol.ts:22-27`). `emitSnapshot` keeps exactly one job:
publishing the derived `journal.currentRun` key. This is what journal-plan Â§2.2 originally
specified ("provider exposes a tap, or the recorder is called from `onReaderMessage`"); Â§3.1
regressed it. WP3's file list must add `src/main/scry/provider.ts` and `readerProtocol.ts`.

### A2 â€” HIGH â€” The EVOLVED tolerance rejects normal unobserved play (upgrades are not absorbed)

Â§2.3 defines `removed = C.deck âˆ– F.deck` over `"<ID>#<upgradeLevel>"` strings with
`|removed| â‰¤ max(2, ceil(0.15Â·|C.deck|))` and retention `â‰¥ 0.75`, and asserts "upgrades count as
remove+add, which the tolerance absorbs". Arithmetic: a suspension observed at the starter deck
(`|C.deck| = 12`) gives a budget of **2**. Three campfire upgrades during unobserved play produce
`|removed| = 3` â†’ EVOLVED fails â†’ **D6: new file, and the real run is marked
`abandoned(superseded)`**. This is precisely the case Â§1.5 gap 6 calls "the largest identity
problem". Retention fails too (9/12 = 0.75 is borderline; five upgrades gives 0.58).

**Fix (WP3, Â§2.3):** evaluate the predicate on the **base-id multiset** (strip `#upg`):
`removedIds = C.ids âˆ– F.ids` with the stated tolerance, retention `â‰¥ 0.75` over ids, **plus** an
upgrade-monotonicity check (for every surviving id, `sum(upgradeLevels)` in F â‰¥ that in C).
Upgrades then cost nothing, genuine removals still count, and a deck that *loses* upgrade levels
is correctly refused.

### A3 â€” HIGH â€” A partial deck read is non-empty and will be treated as identity

`readPileState` drops null slots (`readers.ts:80-85`) and swallows read failures into `deck = []`
(`:99-103`); `List` fixes `length` from `_size` at construction and re-materialises `_items` on a
`_version` change (`scryObject.ts:212-235`). A read racing a game-side mutation therefore yields a
**short deck of real cards** â€” which passes Â§3.2's "non-empty deck" sighting gate, produces a wrong
`deckHash`, and can look like DIVERGED (D6 â†’ wrongly supersede a live run) or like a regression.

**Fix (WP1 + WP3):** have the reader report `deckSize` (the `_size` value) alongside the
materialised array, and have the recorder **discard any poll where `deck.length !== deckSize`**;
require the size *and* hash to be stable across 3 consecutive polls before a fingerprint is minted.
Never mint a fingerprint from a poll whose `nGame` is null or whose `pile` is null.

### A4 â€” HIGH â€” `act` conflates "act 1" with "unknown", breaking D3/D7

`currentActIndex` falls back to `0` on an absent `_state` or any throw (`readers.ts:214`), and the
idle state also reports `0` (`provider.ts:782`). During a load, an act-2 run can report act 0 for a
poll or more. D7 ("EXACT deck but `act < C.act`" â†’ new file + anomaly telemetry) then fires on a
perfectly normal resume, and D3's `act >= C.act` gate fails.

**Fix (WP1):** make it `currentActIndex: number | null` (null when `_state` is absent) through
`RawNGameState` â†’ `Sts2NGameState`; the matcher refuses to build a fingerprint from a null act, and
D7 only fires on two non-null acts. The renderer already renders "act ?" gracefully as a dash.

### A5 â€” MEDIUM-HIGH â€” Supersession is eager and destructive; and save-scumming has no rule

Â§2.4 marks older same-character suspended runs `abandoned(superseded)` **the moment a sighting
occurs**. Combined with A3/A4 (or a torn read that pairs a new `characterId` with a stale deck â€”
`nGame` and `pile` are separate scene walks in one poll, `readerProcess.ts:156-161`), a *transient*
observation can permanently retire a live run. Separately, save restoration (deck **regresses** to a
subset) is unnamed: a small scum lands in EVOLVED by accident and is mislabelled
`unobserved-play`; a large one (`act < C.act`) falls through D2â€“D6 to **D6 â†’ new file + supersede
the real run**. D7 only covers the EXACT-deck case.

**Fix (WP3, Â§2.4/Â§5.1):** (a) make supersession **deferred and idempotent** â€” a sighting selects a
match immediately, but a *competing* run is only demoted once the new run is confirmed (first deck
mutation, or first `room_enter` after the sighting, or 60 s of continuous recording); (b) add a
**REGRESSED** predicate before DIVERGED: `F.deck âŠ† C.deck` (multiset) and `|C.deck âˆ– F.deck| â‰¥ 1`
with no additions â†’ **resume `C` with `gap.reason:'save-restore'`, regardless of act**, and never
supersede on a subset match. Both rules only ever *avoid* destructive transitions, so neither can
make a wrong answer worse.

### A6 â€” MEDIUM â€” The catalog cannot answer the questions the matcher asks it

Â§3.4 asserts "matching never opens run files except the single chosen candidate", but EVOLVED,
D4's `F.deck âŠ‡ C.deck`, and REGRESSED all need the candidate's **deck multiset**, and the entry
carries only `deckHash`, `deckSize`, `core`.

**Fix (WP2):** add `deck: string[]` (the `"<ID>#<upg>"` multiset, ~26 short strings) to
`CatalogEntry`, at minimum for non-terminal states. Cost is ~1 KB/run; it keeps the stated
"candidates from the catalog alone" invariant true.

### A7 â€” MEDIUM â€” Room counting undercounts consecutive same-type rooms

Room counting is specified off `roomType` changes (journal-plan Â§2.2, inherited here). Two
consecutive `combat` rooms produce **no** `roomType` edge; the only reliable boundary in the read
set is the map/travel cycle (`isMapOpen`, `isTraveling` â€” `readers.ts:207-208`). Rooms feed pace,
`R##` labels and the header's "â‰ˆ floor", so a silent undercount corrupts three visible numbers.

**Fix (WP3):** treat the **falling edge of `isTraveling`** (with `roomType` sampled after it
stabilises) as the room boundary; keep the `roomType` edge as a secondary trigger for the first
room after a sighting. Add telemetry comparing the two counters so the rule can be corrected from
the field.

### A8 â€” MEDIUM â€” No cross-process write guard (the capture-run exemption is real)

`index.ts:435` exempts `SPECTRA_CAPTURE` runs from the single-instance lock, and WP5's own
acceptance runs the app with `SPECTRA_STUB` + a fixture. Two processes sharing one `userData`
means two `RunStore`s: per-file temp+rename gives no mutual exclusion, and `catalog.json`
last-writer-wins can clobber a live run's row (or a rebuild-by-scan can race a live flush).

**Fix (WP2):** `RunStore` refuses all writes unless the instance owns the single-instance lock
(thread the `hasLock` value from `index.ts:435-439` into its constructor); `SPECTRA_JOURNAL_STUB`
and any capture run write to `userData/runs-stub/` instead. Reads stay allowed everywhere.

### A9 â€” MEDIUM â€” Atomic-write details on Win32

`fs.rename`-over-target is correct (see A-table 19), but three things are missing: (a) **no fsync**
of the temp file before rename â€” power loss can leave a zero-length or partial target, which is the
one failure temp+rename is supposed to prevent (WP2's SIGKILL test does *not* exercise this, since
the page cache survives a process kill); (b) **no retry** on `EPERM`/`EBUSY`/`EACCES`, which
Defender/Search/backup agents produce on `AppData` regularly; (c) a **fixed `.tmp` name** collides
between the run flusher and the catalog flusher on a shared debounce. Also `will-quit` fires
**twice** (`index.ts:566-584` preventDefaults, then re-quits), so any synchronous flush hook must
be idempotent.

**Fix (WP2):** `write(<file>.<pid>.<n>.tmp)` â†’ `fsync(fd)` â†’ `close` â†’ `rename` with a 3Ã— retry at
50/150/400 ms on EPERM/EBUSY/EACCES â†’ best-effort dir fsync; idempotent `will-quit` flush; extend
the WP2 acceptance to include a torn-tmp fixture (truncated JSON) as well as the kill test.

### A10 â€” MEDIUM â€” Startup scan cost is unbounded and on the critical path

"Rebuild every entry from each file's header + snapshot" requires `JSON.parse` of the **whole**
file (events included). 300 runs Ã— 100â€“600 KB is 30â€“180 MB of synchronous parse on the main
process at launch, before the first sighting can be matched.

**Fix (WP2):** keep `{mtimeMs, size}` per entry in the catalog and full-parse only files whose stat
differs (or that are missing/inconsistent); run the scan **after** `did-finish-load` of the
dashboard, async, with the recorder holding sightings until it completes (the game cannot start a
run faster than that, and a held sighting is lossless). Telemetry the scan duration and file count.

### A11 â€” MEDIUM â€” Read failure is indistinguishable from "left the run"

`read()` in the poll returns `null` for a *throw* (`readerProcess.ts:146-161`), and
`readNGameState`/`readPileState` return `null` when there is no run â€” the same wire value
(`readerProtocol.ts:22-27`). A dead-pointer streak inside a live run therefore looks exactly like
quit-to-menu, and after 40 such polls the reader **fabricates** `processGone`
(`readerProcess.ts:180-183`), which Â§3.2 treats as an *immediate* suspension.

**Fix (WP3):** the 10 s menu debounce **pauses** while `ctx.errorStreak > 0` (available once A1's
raw tap forwards `readFailed`), and a `processGone` that is not corroborated by
`onProcess({detected:false})` within one detect cycle (2 s) is treated as a reader hiccup, not a
suspension. Consequence of getting this wrong is only an extra session row (instant D2 resume), so
this is a polish fix, not a blocker.

### A12 â€” LOW-MEDIUM â€” Mockup surfaces with no planned data source

Everything else in `journal-blend-spec.md` maps cleanly (header plaque, honesty whisper, route
ledger + act dividers + census chip row, deck ledger with play-rate bars, relics/potions sighting
strip, four finding cards + two footnotes, Archive rows, LIVE and VICTORY bands, Export JSON).
Unsourced today:

1. **`exhaust 1` in the LIVE "Combat piles" panel** (spec Â§6) â€” not in `Sts2PileState`. Fixed by A1
   (raw tap) plus adding `exhaust` to the emitted pile state or to `journal.currentRun`.
2. **`IN COMBAT Â· 2 enemies Â· your turn`** in the LIVE banner (spec Â§6) â€” needs
   `sts2.enemiesState` (`enemies.length`, `currentSide`), which Â§4's CurrentRun subscription list
   omits. Add it (it is an existing key; zero cost).
3. **`analysis 11 req / budget 12`** in the manifest whisper and footer (spec Â§5.1, Â§2.5) â€” the
   `analysis` object records `apiVersion` and which offers were replayed, but **no request count**.
   Add `analysis.requests: number` + `budget: number` (WP6) and mirror into the catalog next to
   `analysisStatus`.
4. **`archive average 1m 46s`** (spec Â§5.5 footnote) â€” derivable from catalog
   `activeMs`/`roomsEntered`, but no component owns it. Assign to WP5 (compute in the renderer from
   `journal:list`, excluding `playerCount > 1` per Â§2.6).
5. **Character-id casing** â€” the stub emits `'ironclad'` (`stub/sts2Stub.ts:136`) while the mockup
   and catalog example use `IRONCLAD`. Normalise once at the recorder boundary; matching and
   grouping must not be case-sensitive.

### A13 â€” LOW â€” Doc corrections to fold in

Â§1 header "~150 ms" â†’ 250 ms, cited to `readerProcess.ts:31`; Â§1.2 "`nGame` null = menu or loading"
â†’ add "or `GlobalUi` absent mid-run"; Â§1.2 characterId "reports transient `''`" â†’ "reports `null`;
`''` is the provider's coalescing"; Â§1.1 note that `processGone` is also synthesised after 40 failed
polls; Â§3.2 "3 consecutive polls (~450 ms)" â†’ 750 ms. WP5's acceptance ("Current Run renders live
against the stub scenario switcher") is **not achievable as written** â€” the stub emits no owned deck
and no per-instance ids; restate it as "renders against a scripted `SPECTRA_JOURNAL_STUB` recorder
feed + fixture run file".

## C. Open questions, reclassified

| Q | Class | Disposition |
|---|---|---|
| Q1 one resumable save per character | **(b) runtime** | Keep, WP3 acceptance (5 min in-game). **Downgraded to informational** by defect A5's deferred supersession: with lazy demotion, a false Q1 costs nothing in either direction. Not a user question. |
| Q2 seed / save-slot id in `RunState` | **(b) dev task** | Keep as WP1's timeboxed decomp check. Confirmed *not* present in the vendored port: `RunState` exposes exactly `_currentActIndex` and `_players` (`models.ts:262-269`), so the plan's "not readable today" is verified; only the upstream decomp can say whether it exists at all. Record the answer here. |
| Q3 `_players` enumerates remote players; `playerCount` stability | **(b) runtime** | Keep, WP1/WP3. **Extend the same session to answer**: does `isGameOver` fire when a *teammate* dies (it scans the whole overlay stack, `readers.ts:190-195`)? A false D9 close is the plan's own worst-case wrong answer, and MP is the only plausible way to produce one. |
| Q4 MP resume semantics | **(a) resolved** | No behavioural dependency: storage is already per-session (Â§2.6) and matching is local-deck-only. **Closed â€” delete the question.** |
| Q5 storage policy | **(a) resolved** | Keep-all + per-run Delete + directory-size telemetry. Sizes are bounded (single-digit MB at hundreds of runs); the real cost was scan time, now fixed by A10. **Closed.** |
| Q6 display staleness thresholds (48 h / 14 d) | **(a) resolved** | Pure presentation, no state change, trivially tunable. Ship as stated. **Closed.** |
| Q7 quit-to-menu debounce 10 s | **(a) resolved** | Ship 10 s = 40 polls at `POLL_MS = 250`, **plus** A11's guard (pause while `errorStreak > 0`; require `detected:false` corroboration for `processGone`). Worst case remains one spurious session row. **Closed.** |
| Q8 combat restart on resume | **(b) runtime** | Keep, WP3 acceptance. Cheap and already scripted in WP3's smoke test. |
| Q9 `isGameOver` flicker | **(a) resolved** | Inspection says false positives are structurally unlikely (exact class-name equality, per-entry `safe(...,false)`, `readers.ts:190-195`); the realistic risk is a **missed** close, which degrades to `abandoned(superseded)` â€” acceptable. Ship the 2-poll guard + the "close followed by same-character EXACT sighting" telemetry as written. **Closed.** |
| Q10 Archive merge/split affordance | **(a) resolved** | Out of v1; formats need no change to add it later. **Closed.** |
| **Q11 (new)** Is `Player.Deck` fully populated *during* combat? | **(b) runtime** | The "readable anywhere in a run" claim is a code comment (`models.ts:134-141`), never verified mid-combat â€” and Â§2's identity rests on it. Cheap check, no new code: the existing `deck_read` telemetry already reports `owned_deck` vs `combat_piles` on every shape change (`provider.ts:616-624`); query for events with `owned_deck = 0 && combat_piles > 0`. Assign to WP1. If the deck *is* hollowed mid-combat, sightings must be deferred until `isCombatInProgress === false`. |

**Final user-facing question list: EMPTY.** No remaining question has a default whose wrong answer
costs the user anything irreversible. Two defaults were chosen on the user's behalf and are cheap to
veto, listed here only for visibility: (1) **never ask, ever** â€” Â§2.1's policy is adopted whole,
with A5 making every automatic transition non-destructive; (2) **keep all runs forever**, with a
per-run Delete and no pruning.

## D. Verdict â€” **SHIP WITH FIXES**

The identity argument (Â§2) is sound and, with A2/A3/A4 fixed, actually stronger than the plan
claims: content matching survives every hostile scenario tested (crash mid-write, quit-to-menu,
days-long absence, unobserved play across acts, save restoration, character switch, mid-run attach,
MP). The state machine, the event-sourced file with an embedded snapshot, the catalog-as-cache, the
display-only staleness rule and the never-ask policy all hold up. The UI mapping covers the fixed
mockup with five nameable holes, all small.

What must change before WP3 starts:

1. **A1** â€” retap the recorder onto `RawSnapshot` via a new provider callback (blocking; Â§3.1 as
   written cannot see the deck, exhaust, card instance ids, offered ids/costs, numeric advice, or
   individual polls).
2. **A2** â€” base-id EVOLVED predicate + upgrade monotonicity.
3. **A3** â€” `deckSize` from `_size`, reject truncated polls, stable size+hash for 3 polls.
4. **A4** â€” nullable act.
5. **A5** â€” deferred supersession + REGRESSED predicate.
6. **A6** â€” candidate deck multiset in the catalog.
7. **A7** â€” travel-edge room boundary.
8. **A8/A9/A10** â€” lock-gated writes, fsync+retry+unique tmp, stat-cached async scan.
9. **A11/A12/A13** â€” error-streak-aware debounce; five mockup sources; doc corrections (including
   WP5's unachievable stub acceptance).

No replan: every fix is local to a WP that already exists, and none of them touches Â§2's policy or
the mockup. Phasing stands as written, with WP1 growing the `deckSize` + nullable-act reads and WP3
growing `provider.ts` in its file list.

# User decisions (final, 2026-08-14)

These override any conflicting defaults in the plan body or audit:

1. **Session matching: ASK in the ambiguous window.** When two candidate runs are
   genuinely indistinguishable (same character, both inside the pre-first-pick
   window, act/deck identical), the recorder does NOT silently pick. It records
   into a NEW provisional file (so no data is ever lost) and raises a
   non-blocking resolution prompt in the Journal UI - a banner on Current Run /
   the Archive: "Fresh run, or resuming <candidate>?" Resolving as "resuming"
   merges the provisional into the candidate; ignoring it forever leaves the
   provisional standing as its own run. The prompt must never block the game or
   pop a dialog over it. Outside the provably-ambiguous window the decision
   table's automatic rules stand unchanged.
2. **Retention: keep everything**, per-run Delete in the Archive, size telemetry.
3. **Merge/split affordance: deferred** past v1 (the ambiguity banner in (1) is
   the only manual resolution surface v1 ships).
4. **Multiplayer: tag + SPLIT the averages** (user refinement). MP runs are
   recorded and badged 2P/3P/4P. Archive averages and pace/win comparisons are
   computed PER PLAYER-COUNT COHORT: a solo run compares against your solo
   archive, a 2P run against your 2P archive, and so on - never pooled and
   never excluded. A cohort with too few runs says so ("first 2P run - no
   archive average yet") instead of borrowing another cohort's baseline.
   Community cohorts matched per player count where the API supports it
   (2p/3p/4p brackets exist).
