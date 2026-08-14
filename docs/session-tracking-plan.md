# Run Journal — Session Tracking & Recorder Architecture Plan

Extends `docs/journal-plan.md` (capture schema, pick inference, analysis pipeline,
strict-v1 data limits — none of that is restated here). This plan answers the questions
that plan deferred: **when does a run file open, close, resume, or die — and how do we
know two observations belong to the same run**, given abandonment, multiplayer, quit &
resume, crashes, and an app that can be launched mid-run or closed for days.

UI reference (fixed, do not redesign): `docs/mockups/journal-blend.html` +
`docs/mockups/shot-blend.png` / `shot-blend-full.png`, spec'd in
`docs/mockups/journal-blend-spec.md`.

Everything below is grounded in the current readers; every claimed signal carries a
file/line citation, and every gap is named as a gap.

---

## 1. Signal inventory — what lifecycle detection can actually see

The reader child polls the game at ~150 ms (`src/main/scry/provider.ts:41-43`) and the
provider re-emits change-driven keyed snapshots. The recorder consumes exactly the same
stream. Signals, grouped by lifecycle question:

### 1.1 Process & attach

| Signal | Source | Notes |
|---|---|---|
| Game window present / pid / bounds / focus | `connection.ts:35-54` (`findGameProcess`, window class `Engine` / name `Slay the Spire 2`, lines 19-20), surfaced as `process` messages (`readerProtocol.ts:36-41`) | Window-based; a hung-but-windowed game still "exists" |
| Attach success/failure | `connect` message (`readerProtocol.ts:42`), handled `provider.ts:196-209` | |
| Process gone | `processGone` (`readerProtocol.ts:43`) → `provider.ts:271-282` `handleProcessGone()` — resets run state and emits idle snapshots | **Game quit-from-menu, game killed via task manager, and game crash are indistinguishable here.** All three are `processGone`. Design must not care. |
| Reader child crash (our side) | `ReaderHost` restarts with backoff (`ReaderHost.ts:24-26`), last snapshot cached (`ReaderHost.ts:39`) | Costs ≤ a few seconds of observation, not app state |
| Game build version | `readGameVersion` (`readers.ts:411-419`) | Goes in run file; a version change across a resume is worth recording |

### 1.2 In-run vs not

| Signal | Source | Notes |
|---|---|---|
| Scene is a run | `readNGameState` returns non-null only when the current scene is `NRun` (`readers.ts:173-176`); main menu is a recognized scene (`models.ts:252`, `NGame.getCurrentScene` 674-681) but reads as `nGame: null` | So: **process alive + `nGame` null = menu or loading screen**. We cannot distinguish "quit to menu" from "loading between scenes" instantaneously — only by persistence (debounce, §3.2). |
| Character id | `readers.ts:215` via `findLocalPlayer` → `Player.getCharacterId()` (`models.ts:126-129`) | Reports transient `''` on menus/transitions; the provider already ignores empties (`provider.ts:302-309`) and **fires `resetRunState()` on a real character change** (`provider.ts:307`, definition 642-654). The recorder mirrors this trigger but must NOT treat character change as "old run dead" — see §2. |
| Act index | `readers.ts:214` (`run._state._currentActIndex`) | Monotonically non-decreasing within one run. 0-based. |
| Room type | `readers.ts:183-187` | Only `combat` / `merchant` / `event` / `other`. Room transitions = our room counter. |
| Game over | `readers.ts:189-195` — overlay stack scan for `NGameOverScreen` (`models.ts:253-254`) | Boolean only. **No death-vs-victory variant** (journal-plan Phase-2 gap); recorder writes `'ended'` until the micro-reader lands. |

### 1.3 Run content (identity material)

| Signal | Source | Notes |
|---|---|---|
| Owned deck, anywhere in a run | `RawPileState.deck` — `Player.Deck` (`models.ts:142-146`), read unconditionally in `readPileState` (`readers.ts:89-107`) | id + `upgradeLevel` + enchantment per card. **This is the identity backbone**: readable at attach time, on the very first poll of a resumed run. |
| Combat piles | `readers.ts:105-123` | Per-combat aggregation (journal-plan §3.1); not identity material |
| Offers / shop stock | `readVisibleItems` (`readers.ts:280-408`) | Event material only |
| Combat in progress / whose turn | `readEnemiesState` (`readers.ts:133-157`) | Suspension mid-combat is detectable (dangling combat row, §3.5) |

### 1.4 Multiplayer — what is genuinely readable

`RunState._players` is a **`List<Player>`** (`models.ts:262-269`), each `Player` carries
`NetId` (`models.ts:117-121`) and `Character`, and `findLocalPlayer` already walks the
list comparing against `LocalContext.NetId` (`models.ts:713-721`, `742-751`). The filter
exists *because* multiple players can be present — the plumbing for a player count is
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
  None of that is needed for matching (§2.6) — only for display and analysis cohort
  labeling.

### 1.5 Gaps that shape this design (ruthless list)

1. **No run seed / save-slot id is readable.** Nothing like `RunState._seed` is ported,
   and its existence in StS2's `RunState` is unconfirmed (Q2). If it exists, session
   identity becomes exact and §2 collapses to a lookup. The design below does not
   depend on it, but WP1 includes a decomp check because the payoff is total.
2. **Quit vs crash of the game: indistinguishable** (both `processGone`). Design: both
   are just "suspend"; the *game's own save* is what defines whether the run still
   exists, and we re-derive that from content at next sight (§2).
3. **Game-quit-to-menu vs loading screen: indistinguishable instantaneously** (both
   `nGame: null` with process alive). Design: 10 s debounce before treating null as
   "left the run" (§3.2).
4. **No observed beginning for mid-run attach** — rooms before attach are invisible;
   room counts are *ours*, not the game's. Run files carry `observedFrom` and per-gap
   markers so counts stay honest.
5. **No floor number, no rooms-remaining, no in-game timestamp** — wall-clock and our
   own room counter are the only progress clocks (journal-plan §2.1).
6. **The game saves and progresses while our app is closed.** The largest identity
   problem is not quit/resume — it is *our absence during play* (§2.4 case R3).

---

## 2. Session identity & matching — the core section

### 2.1 The question, answered up front

> Can we confidently identify sessions without asking the user?

**Yes — asking can be eliminated entirely**, with one stated policy, because of a
compounding of three facts:

1. **Content is identity.** The owned deck (id + upgradeLevel multiset) is readable on
   the first poll of any run. A StS2 run's deck at resume is *byte-identical* to its
   deck at suspension when we observed the suspension (the game restores its save; a
   restarted combat does not mutate the owned deck). So exact `deckHash` + character +
   act match is not a heuristic — it is an identity proof for every observed-suspend →
   observed-resume pair, regardless of elapsed days.
2. **The game itself enforces at most one resumable run per character** (StS1 behavior;
   assumed for StS2, verification task Q1). Starting a new run with a character
   abandons that character's suspended save *in the game*. Therefore among our
   suspended files for a character, only the newest can possibly still be live — every
   older one is already dead in-game, and silently marking it `abandoned (superseded)`
   is not a guess, it is bookkeeping.
3. **The only genuinely ambiguous window is informationally empty.** Ambiguity requires
   two same-character runs whose deck multisets are indistinguishable — which, given
   upgrades count and removals count, means *neither run has yet made a distinguishing
   choice* (first ~2-3 rooms, before the first pickup/upgrade/removal). A wrong merge
   inside that window misattributes at most a handful of `room_enter` breadcrumbs
   between two near-empty stubs. The cost of the worst-case wrong answer is below the
   threshold of user-visible meaning — strictly cheaper than interrupting a game with
   a dialog.

**Recommended policy (adopt): never ask.** Most-recent-wins + content matching + silent
supersession + honest gap markers, with a later Archive affordance ("split into two
runs" / "merge") as the escape hatch for the theoretical residue. If the Q1 assumption
is falsified, the decision table below still resolves every case without asking — the
residual mis-merge risk stays confined to the same empty window.

### 2.2 Session vocabulary

- **Run** — one game run; one file `userData/runs/<id>.json`; one catalog row.
- **Session (observation segment)** — one contiguous span during which the recorder
  observed that run (attach → detach). A run has ≥ 1 sessions; gaps between sessions
  are either *observed-idle* (game closed) or *unobserved-play* (game ran without us).
- **Suspension** — run leaves observation: quit-to-menu (debounced `nGame: null`),
  `processGone`, character switch, or app shutdown mid-run.
- **Sighting** — a run becomes observable: stable `characterId` + non-empty owned deck
  after idle/menu/attach/character-change.

### 2.3 The match fingerprint

Computed at every sighting from the first stable polls (require the same values for 3
consecutive polls, mirroring `OFFER_STABLE_POLLS` — memory flickers mid-transition):

```
F = {
  character:  RawNGameState.characterId,
  act:        RawNGameState.currentActIndex,
  deck:       sorted multiset of "<ID>#<upgradeLevel>" from RawPileState.deck,
  deckHash:   sha1(deck),          // same construction as journal-plan §2.4
  deckSize:   |deck|,
  playerCount (nullable, WP1)
}
```

Candidates: catalog entries with the same `character` in state `suspended` (which
includes crash-orphaned `recording` files demoted on startup, §3.6). Wall-clock recency
orders candidates but **never disqualifies them** — a two-week-old suspension with an
exact deck match is the same run, proven by content, and resumes.

Match predicates against a candidate `C` (whose file stores its last-seen fingerprint):

- **EXACT**: `deckHash == C.deckHash && act == C.act`. Identity proof.
- **EVOLVED** (play happened while we weren't looking): `act >= C.act`, and the deck
  multiset moved the way a run moves — `removed = C.deck ∖ F.deck` (cards lost) small
  (`|removed| ≤ max(2, ceil(0.15·|C.deck|))` — removals/transforms are rare, a few per
  run) while retention is high (`|C.deck ∩ F.deck| / |C.deck| ≥ 0.75`). Upgrades count
  as remove+add, which the tolerance absorbs. Deck shrink below `|C.deck| − removed`
  tolerance fails this predicate.
- **STARTER-SHAPED**: `F.deckSize ≤ 12 && act == 0` and ≥ 80 % of `F.deck` are the
  character's basic ids — i.e. "this could be a brand-new run".
- **DIVERGED**: neither EXACT nor EVOLVED.

### 2.4 Decision table (observation → confidence → action)

`Cnew` = newest suspended same-character candidate after supersession sweep (older
same-character suspended files are marked `abandoned(superseded)` the moment a sighting
occurs — per assumption Q1 they are already dead in-game; if Q1 falls, this line alone
becomes "most-recent-wins policy" instead of "fact", with identical behavior).

| # | Sighting observation | Confidence | Action |
|---|---|---|---|
| D1 | No suspended candidate for this character | certain | **New file.** `observedFrom: act==0 && starter-shaped ? 'start' : 'mid-run'`; if mid-run, `startedAt: null`, `firstSeenAt: now`, room counter starts at 0 with `countsArePartial: true` |
| D2 | EXACT vs `Cnew` | certain (identity proof) | **Resume `Cnew`.** New session segment appended. Covers quit-and-resume same day, days later, game crash mid-combat, app restart mid-run — all the same case |
| D3 | EVOLVED vs `Cnew` | high | **Resume `Cnew` with gap.** Append session + `gap` event (`{type:'gap', reason:'unobserved-play', actFrom, actTo, deckDelta}`); pace and room counts exclude the gap; Archive row shows "partially observed" |
| D4 | STARTER-SHAPED, and `Cnew` is also early (`deckSize ≤ 12`) and EXACT fails | ambiguous — **but provably harmless** (see §2.5) | Policy: if `F.deck ⊇ C.deck` → resume as D3; else **new file + `Cnew` → abandoned(superseded)**. Either wrong answer costs ≈ 0 |
| D5 | STARTER-SHAPED, `Cnew` is deep (`deckSize > 12`) | certain | **New run** (a 20-card run cannot regress to a starter deck). `Cnew` → `abandoned(superseded)`. This is "abandon then start new run same character" |
| D6 | DIVERGED, not starter-shaped | high | **New file**, `observedFrom:'mid-run'`; `Cnew` → `abandoned(superseded)`. (Reachable only when we missed both the abandonment and the new run's start) |
| D7 | EXACT deck but `act < C.act` | impossible for one run | **New file** + telemetry issue (`journal_match_anomaly`) — signals a wrong assumption, which we want reported, not papered over |
| D8 | Multiple candidates survive supersession (only if Q1 false) | n/a | Apply D2–D6 against best-scoring candidate (EXACT ≫ EVOLVED retention ≫ recency); never ask |
| D9 | `isGameOver` observed | certain | Close active run (`'ended'`, → death/victory when the variant reader lands). A game-over run never re-enters matching |
| D10 | Character change mid-observation (`provider.ts:307` trigger) | certain | Suspend current run (it may be resumed later — switching characters does NOT kill a run), then run this table for the new character's sighting |

**"Ask user" does not appear in the table.** By construction the only case where the
matcher can be wrong (D4) is the case where being wrong doesn't matter.

### 2.5 The genuinely ambiguous case, quantified

Two abandoned early runs, identical starter decks, same character. When can D4 pick
wrong? Both runs must be pre-divergence: no card taken, no upgrade, no removal — since
any of those changes the multiset (upgrades change `ID#upg`; even same-card picks in
different order converge to the same multiset only if the *sets of choices* were
identical). Empirically that is rooms 1–3: the first card reward (~R1–R3) has 3 choices
from a large pool; the probability two runs remain multiset-identical past the first
reward decision is the probability of identical pick-or-skip from identical offers —
and offers themselves are randomized. Compounded with act and deck size agreement,
collisions past ~room 3 are practically impossible; past act 0 they require an
essentially impossible sequence of identical drafts and upgrades.

**Residual ambiguity window: from run start until the first deck-mutating decision
(≈ 2–3 rooms, ≈ 2–3 minutes of play).** Inside it, the two candidate answers ("resume
stub A" vs "new stub B") differ by: a few `room_enter` events, `startedAt`, and one
catalog row. No picks, no combats of consequence, no analysis. That is the entire
worst case, and it is why the never-ask policy is safe rather than merely optimistic.

### 2.6 Multiplayer

- **Matching is unchanged.** All identity material is the *local* player's deck +
  character; host/guest quit/resume looks exactly like solo quit/resume from our seat.
  A guest rejoining a host's lobby resumes their own deck → EXACT/EVOLVED as usual.
- **Detection**: `playerCount` from the WP1 reader, sampled per session segment and
  stored per session (`sessions[i].playerCount`) — it could legitimately differ across
  resumes if verification (Q3) reveals drop-in behavior. Run-level
  `playerCount = max(sessions)` for the catalog, `null` when never readable.
- **Cohort effect**: runs with `playerCount > 1` are tagged `MP` in Archive rows and
  the run header, are **excluded from "your archive average" pace/deck-shape
  comparisons** (their pacing and drafting are structurally different), and the
  Journey Review renders its community-stats proxy with an extra caveat chip (the
  spire-codex aggregates are not MP-sliced). `playerCount: null` runs are treated as
  solo but keep the null in the file — honest, re-classifiable later.

---

## 3. Recorder architecture

### 3.1 Placement & data flow

`RunRecorder` is a main-process service in `src/main/journal/`, wired in `index.ts`
beside the provider. It taps the **already-central** snapshot funnel: `emitSnapshot()`
(`src/main/index.ts:173-206`) calls `recorder.observe(snap)` before `broadcast`, and
`wireScry`'s `onProcess` callback (`index.ts:210-237`) calls
`recorder.onProcess(state)`. No provider surgery: everything §1 lists already flows
through those two chokepoints (`handleProcessGone` emits idle snapshots +
`onProcess({detected:false})`, so both suspension signals arrive). The recorder is
inert in stub mode (`usingScry === false`) except when `SPECTRA_STUB` +
`SPECTRA_JOURNAL_STUB` are set for UI development.

```
ReaderHost ─ snapshots ─▶ Sts2ScryProvider ─ emitSnapshot ─▶ RunRecorder ─▶ RunStore ─▶ userData/runs/
                                                   │                │
                                                   ▼                ├─▶ journal.currentRun (keyed snapshot, live)
                                              renderer IPC          └─▶ journal:push (catalog/analysis changes)
```

Components:
- **`SessionMatcher.ts`** — pure functions: fingerprint from raw state, predicates,
  decision table §2.4. No I/O; unit-testable against scripted snapshot sequences.
- **`RunRecorder.ts`** — the state machine + event derivation (journal-plan §2.2's
  event list, unchanged) + snapshot maintenance.
- **`RunStore.ts`** — files, catalog, atomic writes, scan/repair. No game knowledge.
- **`AnalysisRunner.ts`** — journal-plan §3.4, triggered on close; out of scope here
  beyond the `analysisStatus` field it maintains.

### 3.2 State machine

```
            sighting → match (D1–D8)
   idle ────────────────────────────────▶ recording ── isGameOver (D9) ──▶ closing ──▶ closed{ended|death|victory}
    ▲                                        │  ▲
    │            nGame null ≥10s (menu)      │  │  sighting matches this run (D2/D3)
    │            OR processGone              ▼  │
    └──────────────────────────────────── suspended ── superseded (D4/D5/D6) ──▶ abandoned
                                             │
                                             └── (never by timeout — display only, §5.1)
```

- **idle → recording**: sighting = stable `characterId` + non-empty `deck` for 3
  consecutive polls. Runs the matcher; opens or resumes a file; appends a `session`
  entry `{ attachedAt, playerCount, gameVersion }`.
- **recording → suspended**: (a) `nGame === null` (idle nGameState — `localPlayer`
  null) persisting **10 s** while the process is detected — the quit-to-menu debounce
  (§1.5 gap 3; loading screens between rooms/acts stay under it); (b) `processGone` /
  `detected:false` — immediate; (c) app quitting (`will-quit`, flush synchronously);
  (d) character change (D10). Session entry gets `{ detachedAt, reason:
  'menu'|'process-gone'|'app-quit'|'character-switch' }`.
- **recording → closing**: `isGameOver` true. Write `game_over`, finalize after the
  game-over screen persists 2 polls (guards a flickered read), state → `closed`,
  outcome `'ended'` (variant reader later), kick analysis.
- **suspended → recording**: matcher D2/D3 on a later sighting — same process or a
  process restarted days later; identical code path.
- **suspended → abandoned**: supersession only (D4/D5/D6 sweep). Never by clock.
- Combat mid-suspension: the open combat row is marked `aborted: true` on suspension;
  on resume the game restarts the combat from its start, so the aborted row is
  **excluded from play/draw aggregates** (prevents double counting; Q9 verifies the
  restart assumption — if StS2 instead resumes mid-combat, drop the exclusion).

### 3.3 Event log + snapshots (the user's explicit ask)

The run file is **event-sourced with an embedded snapshot** — events are the truth for
the timeline/analysis; the snapshot exists so nothing ever replays a full event log to
answer "where was this run" (catalog, matcher, resume, Current Run header all read the
snapshot alone).

```jsonc
// userData/runs/<id>.json — extends journal-plan §2.3; new/changed fields only
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
      "activeMs": 1712000,            // monotonic-clock duration (§5.3)
      "playerCount": 1, "gameVersion": "1.3.0.123" }
  ],

  "snapshot": {                       // derived state — current as of every flush
    "at": 1786665104000,
    "act": 2, "roomIndex": 23, "roomType": "combat",
    "deck": ["STRIKE#0","STRIKE#0", "BASH#1", "..."],   // the matcher fingerprint
    "deckHash": "c1f4…",
    "eventCount": 143,                // events folded into this snapshot
    "combatAgg": { "plays": {"STRIKE": 41}, "drawn": {"STRIKE": 52} },
    "openCombat": null,               // in-progress combat row or null
    "openOffer": null,                // offer awaiting pick-inference or null
    "paceActiveMs": 1712000
  },

  "events": [ /* journal-plan §2.2, plus: */
    { "t": 0, "type": "session_attach", "sid": 1 },
    { "t": 0, "type": "session_detach", "sid": 1, "reason": "process-gone" },
    { "t": 0, "type": "gap", "reason": "unobserved-play",
      "actFrom": 1, "actTo": 2, "deckAdded": ["CARNAGE#0"], "deckRemoved": [] }
  ],
  "combats": [ /* journal-plan §3.1; aborted rows carry "aborted": true */ ],
  "analysis": null
}
```

- **Snapshot cadence**: refreshed in memory on every event; persisted with every flush
  (the file is rewritten whole, so a fresh snapshot costs nothing extra). The
  *semantic* snapshot points are `room_enter`, `combat_end`, `session_attach/detach`,
  and a 60 s heartbeat during long combats — these force a flush even if the debounce
  hasn't elapsed. Snapshot contains **derived state**; events contain **history**. A
  reader that trusts only the snapshot is never wrong about the present; a reader that
  folds `events[eventCount:]` over it reconstructs exact state (the recovery path).
- **Flush policy**: debounced 2 s batches (journal-plan's crash budget), immediate on
  every lifecycle transition and on `will-quit` (synchronous write, matching how
  `SettingsStore` writes sync — `SettingsStore.ts:37-45`).
- **Crash-safe write pattern**: `write <file>.tmp` → `rename` over the target (atomic
  on the same NTFS volume; `fs.rename` replaces on Windows). This is deliberately
  *stronger* than `CompendiumService.saveDisk`'s plain `writeFile`
  (`CompendiumService.ts:358-373`) — a torn compendium cache refetches; a torn run
  file loses a run. On load: parse target, else parse `.tmp` (a crash between write
  and rename), else quarantine to `<id>.json.corrupt` and drop from catalog with a
  telemetry issue.
- **Resume-from-snapshot on app restart**: startup scan (§3.6) loads each
  `recording`-state file, folds trailing events over the snapshot, closes dangling
  combat/offer as aborted, demotes state to `suspended`. Cost: one file parse per
  crashed run — no full-log replays.
- **Schema versioning**: `schema: 1` at top level. Readers of unknown *higher* schema
  render an "update Reliquary to view this run" row rather than guessing (files are
  user data; never destructively migrate). Additive changes (new nullable fields, new
  event types) do not bump the version — consumers must ignore unknown event types.
  Bump only on incompatible shape changes, with an explicit migrate-on-load function
  per step (`migrations/1to2.ts` pattern, run at scan time, written back atomically).

### 3.4 Catalog — `userData/runs/catalog.json`

The Archive's index; **a cache, never the truth** (run files are). Same atomic write
pattern, debounced with the same flusher.

```jsonc
{
  "schema": 1,
  "rebuiltAt": 1786665104000,
  "entries": [{
    "id": "2026-08-12T23-40-11Z-ironclad-a41f3c",
    "character": "IRONCLAD",
    "startedAt": 1786662011000,       // null → Archive shows firstSeenAt + "joined mid-run"
    "firstSeenAt": 1786662011000,
    "lastSeenAt": 1786665104000,
    "state": "closed",
    "outcome": "ended",
    "actReached": 2,
    "roomsEntered": 45,               // observed rooms; countsArePartial mirrors the file
    "countsArePartial": false,
    "deckSize": 26,
    "deckHash": "c1f4…",
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
and rewrites the catalog. Scan is also the crash-recovery walk (§3.3). A missing or
corrupt catalog is therefore always a warm restart away from correct, and the matcher
reads candidates from the rebuilt catalog (deckHash + state are in it — matching never
opens run files except the single chosen candidate).

### 3.5 What the recorder derives (delta to journal-plan §2.2)

The event list and pick-inference rules are journal-plan §2.2 verbatim. Session-layer
additions only: `session_attach` / `session_detach` / `gap` events; per-combat
`aborted` flag; `run_start` is only written when `observedFrom === 'start'`
(mid-run attach gets `session_attach` with no `run_start` — the Archive renders the
distinction); `run_end` is replaced by the state machine's transitions (suspension is
not an end; only `closed`/`abandoned` are terminal).

### 3.6 Startup sequence

1. `RunStore.open()`: load catalog; scan-repair if inconsistent/missing.
2. Demote orphaned `recording` files → `suspended` (fold trailing events, close
   dangling combat/offer rows as aborted). These are full resume candidates.
3. No abandonment sweeps at startup (supersession happens only at sighting time —
   §2.4; timeouts are display-only — §5.1).
4. Recorder starts `idle`; first sighting drives the decision table.

### 3.7 IPC surface + preload

Follows the codex spine exactly: invoke channels resolve `{data}`/`{error}` and never
reject (guarded via the existing `handle()` wrapper, `index.ts:265-273`); pushes ride a
dedicated channel like `IPC.CodexPush` (`index.ts:123`, `preload/index.ts:97-101`);
live state rides the existing keyed-snapshot channel.

| Surface | Kind | Payload |
|---|---|---|
| `journal.currentRun` | keyed snapshot (existing `IPC.Data` path, replayed on `RequestState` like every key — `index.ts:297-309`) | `null` when idle, else `{ runId, state, character, act, roomIndex, deckSize, paceActiveMs, elapsedActiveMs, recentRoute: last 6 route rows, playerCount }` — the Current Run header + mini-route. Deck/pile contents come from the existing `sts2.pileState`/`sts2.cardData` keys; no duplication. |
| `journal:list` | invoke | `{ data: CatalogEntry[] }` (newest first; renderer groups/filters) |
| `journal:get` | invoke | `{ data: RunFile }` by id (full file — report + review render from it) |
| `journal:delete` | invoke | user-initiated delete from Archive (file + catalog entry) |
| `journal:reanalyze` | invoke | re-kick analysis for a closed run |
| `journal:export` | invoke | resolve the file's absolute path copy for "Export JSON" (mockup header button) |
| `journal:push` | push | `{ kind: 'catalog', entries }` on any catalog change; `{ kind: 'analysis', id, status }` on pipeline progress — Archive and open reports live-update |

Preload adds the mirror methods to `SpectraApi` (`journalList/journalGet/…/onJournalPush`)
next to the codex block (`preload/index.ts:85-101`).

---

## 4. UI wiring — mockup surfaces → routes/components

The blend mockup is one page with three stacked states plus the sub-nav
(`Journal · Archive · Current Run` visible in `shot-blend.png`; states spec'd in
`journal-blend-spec.md` §2, §6). Real app: a **Journal tab** beside Codex in the shell
(`TitleBar.tsx` tab row; `Shell.tsx` renders the outlet with per-tab error boundaries),
built as a route-tree factory exactly like `codexRouteTree`
(`src/renderer/src/codex/routes.tsx:52`) so `App.tsx` stays the only owner of app shape.

```
/journal                       JournalLayout (sub-nav: Journal · Archive · Current Run; run picker + Export JSON)
├─ ''                          → newest closed run's report, else → /journal/archive
├─ run/$id                     RunReport   — mockup "STATE — RUN REPORT" (+ VICTORY header variant)
├─ archive                     ArchiveView — catalog list (grouped by deck signature, journal-plan §2.4)
└─ current                     CurrentRun  — mockup "STATE — LIVE · CURRENT RUN"
```

Per-view data (mockup section names from `journal-blend-spec.md`):

- **RunReport** (`journal:get` once + `journal:push {kind:'analysis'}` for live analysis
  arrival): *Run header plaque + manifest whisper* ← file header/sessions/snapshot
  (result banner from `state`/`outcome`; the VICTORY variant is the same component with
  outcome styling); *honesty whisper* ← static strict-v1 line; *Route Ledger* + census
  strip ← `events` (room_enter/offer/deck deltas folded into rows; act dividers from
  `act_change`; `gap` events render as a dim divider row — "unobserved play · act 1→2 ·
  +1 card", new since mockup but same row grammar); *Deck Ledger* ← `finalDeck` +
  `combatAgg` (aborted combats excluded); *Relics & Potions honest strip* ← shop-stock
  sightings from `offer_shown` events; *Journey Review findings* ← `analysis` field
  (pending → the strip renders "analysis pending · N req" from `analysisStatus`).
- **ArchiveView** (`journal:list` + `journal:push {kind:'catalog'}`): rows straight from
  catalog entries — character tint, outcome/state chip (§5.2 vocabulary), act, rooms
  (`≈` when partial), deck size, signature group header via `core`/`deckHash`, MP tag,
  analysis chip, relative `lastSeenAt`. Row click → `run/$id`. Delete + export actions.
- **CurrentRun** (subscribes `journal.currentRun` + existing `sts2.pileState`,
  `sts2.nGameState`, `sts2.cardData` via the same `useIpc` snapshot hook the overlay
  and dashboard already use): *header plaque LIVE variant* ← `journal.currentRun`;
  *Combat piles panel* ← `sts2.pileState` counts; *Route-so-far panel* ← `recentRoute`
  (same row component as the Route Ledger — build it shared from day one). Idle state:
  "no run in progress" plate with the last run's link. Updates at snapshot cadence —
  no polling, it's the push the overlay already lives on.

Reuse from codex: name/art resolution (`codex/data.ts` hooks + `sts2.cardData` name
map + CDN sprite components with the mandatory onerror plates, `ArtPreview.tsx`),
chip/section/whisper primitives (`codex/parts.tsx`, tokens in `overlay.css`), tier
palette (`tiers.ts`) for verdict/severity chips. Do not fork these; the mockup was
built from their tokens (`journal-blend-spec.md` §8).

---

## 5. Lifecycle policies

### 5.1 Abandonment & supersession

- **Supersession is the only automatic terminal transition** for an unfinished run
  (D4/D5/D6): the game itself invalidated the save. Recorded as
  `state:'abandoned', outcome:'superseded'`, with a terminal event naming the
  superseding run id (navigable in Archive).
- **Timeouts never change state.** A suspended run older than **48 h** *displays* as
  "abandoned?" in the Archive (dim state chip); older than **14 d** it displays plainly
  as "abandoned" — but the file stays `suspended` and remains a full resume candidate
  forever, because content match is proof (§2.1) and a false abandon that later
  resumes would be a lie we'd have to unwind. Display-only staleness costs nothing.
- **App uninstall/reinstall**: files are userData; catalog rebuild-by-scan restores the
  Archive; suspended runs resume across reinstalls.

### 5.2 What the user sees per state (Archive vocabulary)

| File state | Archive chip | Notes shown |
|---|---|---|
| `recording` | `LIVE` (aqua outline) | row links to Current Run |
| `suspended` < 48 h | `SUSPENDED` (dim outline) | "resumes automatically when you continue" |
| `suspended` 48 h–14 d | `ABANDONED?` (dim) | same row affordances |
| `suspended` > 14 d | `ABANDONED` (dim) | |
| `abandoned` (superseded) | `ABANDONED` (orange outline) | "superseded by <run>" |
| `closed / ended` | `ENDED` (gold) | until variant reader: honest label, not a guessed death |
| `closed / death` | `DEFEATED` (red solid) | mockup banner vocabulary |
| `closed / victory` | `VICTORIOUS` (green solid) | |
| partial observation | `≈` prefix on rooms + "joined mid-run" / "gaps" whisper | from `countsArePartial` |

### 5.3 Clocks & skew

- All persisted timestamps are wall-clock epoch ms (display, matching recency order).
- All **durations** (pace, elapsed, session `activeMs`) accumulate from the monotonic
  clock (`process.hrtime.bigint()` deltas per session segment) — a laptop sleeping,
  DST, or NTP jump mid-session cannot produce negative or inflated pace. `lastSeenAt`
  is clamped monotonically non-decreasing per file; a backwards wall-clock jump > 5 min
  is recorded as a telemetry crumb, and recency ordering falls back to file mtime if
  two entries' wall-clocks interleave impossibly.
- Wall-clock plays **no role in identity** (§2.3) — skew cannot corrupt matching.

### 5.4 Storage bounds

- Expected file size: tens of KB (a 50-room run ≈ 300–600 events + aggregates); even
  hundreds of runs ≈ single-digit MB. Recommendation: **no automatic pruning in v1**;
  per-run Delete in the Archive; telemetry on `runs/` total bytes; add a cap/prune
  policy only if telemetry shows a real tail (Q5). Hard safety valve only: if a single
  run's `events` exceeds 20 000 (a runaway loop, not a run), the recorder coalesces
  room-level events into the snapshot and flags the file `truncatedEvents: true`.

---

## 6. Open questions

Each with the recommended default the plan proceeds on. These drive the audit + user
Q&A; nothing else in the plan is knowingly uncertain.

1. **Does StS2 enforce at most one resumable save per character** (StS1 behavior)?
   Load-bearing for treating supersession as fact (§2.4). *Default: assume yes; add a
   5-minute in-game verification to WP3's acceptance; if false, behavior is unchanged
   (most-recent-wins policy) and only the D4 mis-merge risk commentary changes.*
2. **Is a run seed / save-slot id readable from `RunState`?** Would make identity
   exact and collapse §2 to a lookup. *Default: proceed without; WP1 includes a
   30-minute decomp check of `RunState` fields (seed, save id, floor, gold, hp are all
   plausibly adjacent — same trip as journal-plan Phase-2 scouting).*
3. **Does `RunState._players` enumerate remote players in live MP, and is
   `playerCount` stable mid-session?** (§1.4). *Default: ship the reader nullable;
   verify in one MP session; until verified, MP runs may read as solo — files keep
   `playerCount` as-observed and are re-classifiable.*
4. **MP resume semantics** — can a guest resume without the host; does `playerCount`
   change across resumes of one run? Affects per-session vs per-run storage only
   (already per-session, §2.6). *Default: per-session storage; no matching impact.*
5. **Storage policy** — keep-all vs cap. *Default: keep all, Delete affordance,
   telemetry on directory size (§5.4).*
6. **Display staleness thresholds** — 48 h "abandoned?" / 14 d "abandoned" (§5.1).
   *Default: as stated; pure presentation, trivially tunable.*
7. **Quit-to-menu debounce** — 10 s of `nGame: null` with process alive (§3.2). Too
   short misreads a long act-transition load as suspension (harmless: instant D2
   resume, one extra session row); too long delays Current Run going idle. *Default:
   10 s; tune with telemetry on false-suspend frequency.*
8. **Combat restart on resume** — does StS2 restart an interrupted combat from its
   start (StS1 behavior)? Decides whether aborted combat rows are excluded from
   aggregates (§3.2). *Default: assume restart → exclude; verify once in-game during
   WP3; if StS2 resumes mid-combat, keep the row and drop the flag.*
9. **`isGameOver` flicker risk** — is the overlay-stack scan (`readers.ts:189-195`)
   ever transiently true outside a real game over? A false close is our worst wrong
   answer (a closed run never re-enters matching — the resumed game would open a
   duplicate mid-run file). *Default: require 2 consecutive polls + `roomType`
   consistency before closing; add telemetry on close events immediately followed by
   a same-character EXACT sighting (the signature of a false close), so the guard can
   be tightened from the field.*
10. **Archive merge/split affordance** — the escape hatch for §2.5's residue. *Default:
    not in v1 (the policy makes it near-unnecessary); catalog/file format requires no
    changes to add it later (splitting = partitioning `events` at a `session_attach`
    boundary into two files).*

---

## 7. Implementation phasing

Work packages sized for one Opus implementation agent each, in dependency order, on
the codex-tab-v2 data spine. Every WP leaves the app shippable.

**WP1 — Reader additions: player count (+ decomp scouting)**
Files: `src/main/scry/models.ts` (expose `RunState._players` count helper),
`src/main/scry/readers.ts` (`RawNGameState.playerCount`, `otherCharacterIds`),
`src/shared/types.ts` (`Sts2NGameState` passthrough), `src/main/scry/provider.ts`
(map through in `pollNGame`).
Acceptance: live solo run shows `playerCount: 1` in the Debug JSON view; nulls (not
throws) when `_state` absent; SPECTRA_DEBUG log line on count change. Timeboxed
decomp check for Q2 (run seed/id) documented as a note in this plan's Q2.

**WP2 — RunStore: files, catalog, atomic writes, scan/repair**
Files: `src/main/journal/RunStore.ts`, `src/shared/types.ts` (RunFile, CatalogEntry,
event types), `src/main/journal/__tests__/RunStore.test.ts`.
Acceptance: temp+rename write survives a mid-write process kill (test: write a large
file, SIGKILL a child doing it, reload — either old or new version parses, never
torn); catalog deleted → rebuilt from scan byte-equivalent; corrupt run file →
quarantined `.corrupt` + telemetry, others unaffected; unknown-higher-schema file →
listed as unreadable, not crashed on.

**WP3 — SessionMatcher + RunRecorder state machine**
Files: `src/main/journal/SessionMatcher.ts`, `src/main/journal/RunRecorder.ts`,
wiring in `src/main/index.ts` (`emitSnapshot` tap + `onProcess`), tests
`__tests__/SessionMatcher.test.ts` with scripted snapshot sequences for **every row
D1–D10** plus: quit-resume same day; resume after 3 days; abandon → new same-char run;
mid-run attach; processGone mid-combat then resume; two starter-deck stubs (D4 both
branches); character switch mid-observation.
Acceptance: all decision-table tests green; live smoke — start run, quit to menu,
resume → one file, two sessions; kill game mid-combat, relaunch, continue → same file,
aborted combat row excluded from aggregates; in-game checks for Q1/Q8 performed and
their answers recorded in §6.

**WP4 — IPC + preload + live key**
Files: `src/main/index.ts` (invoke handlers via existing `handle()` wrapper; recorder
push → `journal:push`; `journal.currentRun` through `emitSnapshot` so `RequestState`
replay covers it), `src/preload/index.ts`, `src/shared/types.ts` (channel consts +
`SpectraApi` additions).
Acceptance: `journal:list/get` resolve `{data|error}` and never reject; a
freshly-opened dashboard receives `journal.currentRun` via RequestState replay;
catalog change while Archive is open arrives as a push without refocus.

**WP5 — Journal tab UI (three surfaces)**
Files: `src/renderer/src/journal/{routes.tsx, JournalLayout.tsx, RunReport.tsx,
ArchiveView.tsx, CurrentRun.tsx, rows.tsx (shared route-row/census/chips), data.ts
(journal IPC hooks)}`, graft in `App.tsx`, tab in `dashboard/TitleBar.tsx`.
Mockup fidelity: `journal-blend.html` sections per §4 mapping — tokens, chip
vocabulary, whispers, onerror art plates all reused from codex primitives; no
redesign, the only new row type is the `gap` divider.
Acceptance: with `SPECTRA_STUB` + a fixture run file dropped into a temp userData,
all three views render the blend mockup's content (report matches `shot-blend-full.png`
structurally); Current Run renders live against the stub scenario switcher; tab crash
isolation intact (Shell boundary). Kill + relaunch Electron dev app to verify main-
process changes (no hot reload — per project memory).

**WP6 — Analysis pipeline hookup**
Files: `src/main/journal/AnalysisRunner.ts` (journal-plan §3.4 budget/resume rules),
recorder close-hook, `analysisStatus` in catalog + `journal:push` progress,
`journal:reanalyze`.
Acceptance: closed run reaches `analysisStatus: done` within budget (≤12 requests,
verified against `codexHttp` cooldowns); app killed mid-analysis resumes the remainder
next launch; RunReport findings populate live via push.

**WP7 — Packaged verification + polish**
Package a win `--dir` build (`signAndEditExecutable=false`, per project memory:
asar.unpacked forked bundles need `.mjs` — the recorder is main-process so no new fork,
but verify the runs dir resolves under the packaged userData). Acceptance: full
quit/resume/abandon cycle on a packaged build writes/reads `userData/runs/` correctly;
catalog survives an app update (schema untouched).
