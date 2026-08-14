# Run Journal Tab — Plan

A new top-level **Journal** tab in Reliquary: a live **Current Run** view while the game is
up, an **archive** of every finished run (one file per run), and a post-run
**Journey Review** — what you played, what you never played, what the community does with
this deck shape, and which offered cards would have synergized with what you were holding.

Derived from inspecting (all in this worktree):
- `src/main/scry/{provider,readers,models}.ts` + `src/shared/types.ts` — what live state we can read today
- `src/main/codex/{CodexClient,CompendiumService}.ts` — what API data is already cached and how the 15 req/min budget is enforced
- `docs/codex-tab-plan.md` / `codex-tab-v2-plan.md` — the Codex data spine and design language
- `src/renderer/src/codex/` + `src/renderer/src/overlay.css` + `dashboard/ui.tsx` — tokens and primitives

---

## 1. Goal & shape

Three surfaces, one data spine:

1. **Current Run (live)** — renders while a run is in progress, fed by the same keyed
   snapshots the overlay already consumes. Header (character, act, deck size, pace…),
   collapsible Deck / Relics / Potions sections, and a growing pickup timeline with
   per-floor tags — the Spire Codex live-tracker layout, restyled in Reliquary's language.
2. **Archive** — every run is written to `userData/runs/<id>.json` the moment it starts
   and finalized when it ends (death, victory, or abandonment). The archive lists runs
   newest-first, grouped by **deck signature** so "you've played this shape 4 times,
   1 win" is a first-class row.
3. **Journey Review (post-run analysis)** — opens from any archived run. Four questions,
   each answered by a specific data source (§3): card use, cards never used, deck
   popularity (honest proxy), and skipped synergies.

The main process owns capture (a new `RunRecorder` sitting beside `Sts2ScryProvider`,
consuming the same reader snapshots) and the post-run analysis pipeline (reusing
`codexHttp` so the whole process still shares one 15 req/min budget per endpoint).
The renderer only ever reads: live state over the existing IPC push, archived runs over
two new invoke channels (`journal:list`, `journal:get`).

---

## 2. Run capture design

### 2.1 What exists today vs what needs new readers

**Ships from existing data (verified in `readers.ts` / `provider.ts`):**

| Signal | Source | Notes |
|---|---|---|
| Character id | `RawNGameState.characterId` | `IRONCLAD` etc.; run-change detection already exists in provider (`resetRunState`) |
| Act index | `RawNGameState.currentActIndex` | 0-based |
| Room type | `RawNGameState.roomType` | **only** `combat` / `merchant` / `event` / `other` — rest, treasure, boss are all `other` |
| Owned deck incl. upgrades | `RawPileState.deck` (`Player.Deck`) | readable anywhere in a run; ids + `upgradeLevel` + enchantment. **Deck deltas are directly observable** — this is the backbone |
| Combat piles (draw/hand/discard/exhaust) | `RawPileState` | polled ~150 ms; per-instance `baseAddress` identity within a combat |
| Combat start/end, whose turn | `RawEnemiesState.isCombatInProgress`, `currentSide` | provider already logs transitions |
| Enemy count + intents | `RawEnemiesState.enemies` | no enemy **names/ids** — encounter identity is a gap |
| Offers shown | `RawVisibleItems` → layoutState | card rewards, choose-a-card, shop stock (cards+relics+potions with prices), ancient choices — with ids |
| Deck-conditioned advice per offer | provider `adviceCache` (draft-advice) | already fetched live for stable additive offers |
| Game over | `RawNGameState.isGameOver` | game-over screen detection |
| Game version | `readGameVersion` | goes in the run file |
| Wall-clock timing | recorder's own timestamps | pace needs no reader at all |

**Gaps — need new memory readers (flag in UI as "—" until they land):**

| Signal | Why it's a gap | Likely path |
|---|---|---|
| Player HP / max HP | never ported | enemies already read `Creature._currentHp`; the local player's entity should expose the same — new accessor on `Player` |
| Gold | never ported | field on `Player` or `RunState`; needs decomp confirmation |
| Floor number / map position | only act index is read | `RunState` should carry it; `MapPointRoomHistoryEntry` (already stubbed in `models.ts`, unused) suggests a readable **room history** — would also fix room-type granularity (rest/treasure/boss) retroactively |
| Owned relics | only shop *offers* are read | a relics list on `Player` — needed for relic pickup events + relic-set signature |
| Owned potions | same | same |
| Ascension level | never ported | `RunState` |
| Enemy/boss identity | intents only, no names | encounter id on `NCombatRoom` or combat manager |

**v1 fallback where readers are missing:** floor number is approximated by counting room
transitions (each `room_enter` = +1 floor; act changes recorded as markers). This is close
but not exact (StS2 map quirks); the run file stores both `roomIndex` (what we counted)
and `floor` (null until the reader lands) so old files stay honest.

### 2.2 Events recorded (RunRecorder, main process)

The recorder subscribes to the same `ReaderToHost` snapshot stream the provider consumes
(cleanest: provider exposes a tap, or the recorder is called from `onReaderMessage`).
Everything is **change-driven**, mirroring the provider's own transition logging:

- `run_start` — first non-empty characterId after idle / character change. Allocates the
  file, records `gameVersion`, `startedAt`.
- `room_enter { roomType, roomIndex, actIndex }` — on `lastRoomType` change (the provider
  already tracks this; recorder keeps its own copy). Timestamps drive pace.
- `act_change { from, to }` — on `currentActIndex` change.
- `combat_start` / `combat_end { durationMs, enemiesAtStart }` — on `isCombatInProgress`
  edges. Between the edges, the per-combat play tracker runs (§3.1).
- `offer_shown { source, offered[], costs?, deckBefore[], advice? }` — when a **stable**
  additive layoutState appears (reuse the provider's `OFFER_STABLE_POLLS` debounce and
  its offer key). `deckBefore` is the current owned-deck id list; `advice` is copied from
  the provider's `adviceCache` **when/if it lands** (the recorder patches the event
  retroactively — advice arrives async).
- `offer_resolved { picked: id | null }` — **picks are NOT directly observable**
  (`StatPanels`/layoutState only mark hover, never selection). Inference rule:
  when the offer's panels disappear from layoutState, watch the owned deck for the next
  **10 s / until the next room_enter**: if the deck gains a card whose id is in
  `offered[]`, that id is the pick; if the deck is unchanged by the deadline, `picked:
  null` (a skip). Shops: same rule per stock item (a deck gain matching shop stock =
  purchase; relic/potion purchases stay invisible until the owned-relic/potion readers
  exist). Ambiguity (two copies of the same id offered, or an unrelated simultaneous
  gain) resolves to the offered id when unique, else `picked: 'ambiguous:<id>'` — never
  silently wrong.
- `deck_add / deck_remove / deck_upgrade { id, upgradeLevel }` — diff of the sorted owned
  deck multiset between polls (outside combat only, to avoid temporaries; the owned deck
  read is already filtered to real cards). Adds that match an open offer are tagged with
  the offer's event id; untagged adds are events/relic effects.
- `game_over { result }` — on `isGameOver` true. `result: 'death' | 'victory'` needs the
  game-over screen variant (new micro-reader on `NGameOverScreen`); until then `'ended'`.
- `run_end` — on process gone / main menu / new character. Finalizes `endedAt`, computes
  pace, kicks the post-run analysis (§3.4).

Crash-safety: the file is appended/rewritten on every event batch (debounced ~2 s), so a
game crash or app crash loses at most 2 s of events, and a run with no `run_end` is
finalized as `'abandoned'` on next launch.

### 2.3 Per-run file — `userData/runs/<id>.json`

`id = <startedAt ISO, filesystem-safe>-<character>-<6 hex random>`.

```jsonc
{
  "schema": 1,
  "id": "2026-08-12T23-40-11Z-ironclad-a41f3c",
  "gameVersion": "1.3.0.123",
  "startedAt": 1786662011000,
  "endedAt": 1786665104000,
  "result": "death",                  // death | victory | abandoned | ended
  "character": "IRONCLAD",
  "ascension": null,                  // null until reader exists
  "actReached": 2,                    // 0-based, as read
  "roomsEntered": 45,
  "floorReached": null,               // null until floor reader exists

  "signature": {                      // §2.4
    "deckHash": "c1f4…",              // sha1 over sorted "ID#upg" multiset
    "relicHash": null,                // sha1 over sorted relic ids; null until readable
    "core": ["DEMON_FORM", "INFLAME", "LIMIT_BREAK_LIKE…"]  // top-N non-basic ids by rarity weight, for display
  },

  "finalDeck": [                      // grouped multiset at run end
    { "id": "STRIKE", "upgradeLevel": 0, "count": 4 },
    { "id": "BASH",   "upgradeLevel": 1, "count": 1 }
  ],
  "relics":  [],                      // [{id, pickedUpAtEvent?}] once readable
  "potions": [],

  "events": [                        // append-only, each { "t": epochMs, "type": …, … }
    { "t": 0, "type": "run_start" },
    { "t": 0, "type": "room_enter", "roomType": "combat", "roomIndex": 1, "actIndex": 0 },
    { "t": 0, "type": "offer_shown", "eid": 17, "source": "cardReward",
      "offered": ["FEEL_NO_PAIN", "TWIN_STRIKE", "CLOTHESLINE"],
      "deckBefore": ["STRIKE","STRIKE","…"],
      "advice": { "FEEL_NO_PAIN": { "score": 0.44, "base": 0.31,
                    "reasons": ["Bloodletting 68%", "Offering 71%"] } } },
    { "t": 0, "type": "offer_resolved", "eid": 17, "picked": "TWIN_STRIKE" }
  ],

  "combats": [                        // one row per combat (see §3.1 for fields)
    { "startT": 0, "endT": 0, "roomIndex": 1, "enemies": 2,
      "plays":  [{ "id": "STRIKE", "count": 3 }],
      "drawn":  [{ "id": "STRIKE", "count": 4 }] }
  ],

  "pace": { "elapsedMs": 3093000, "roomsEntered": 45, "perRoomAvgMs": 68733 },

  "analysis": null                    // written by the post-run pipeline (§3.4); null = pending
}
```

### 2.4 Deck signature & matching

- **`deckHash`** = SHA-1 of the sorted multiset of `"<CARD_ID>#<upgradeLevel>"` strings
  (final deck). Stable, order-independent, upgrade-aware.
- **`relicHash`** = SHA-1 of the sorted relic-id set — `null` until the relic reader
  ships; the signature object is versioned by presence, so old files compare on deck only.
- **Local matching** (own archive): exact `deckHash` match is rare and near-meaningless
  late-run; the archive groups by **`character` + core-card overlap** — Jaccard similarity
  over the non-basic card *sets*, threshold ~0.6 for "same deck shape". `core` (stored)
  makes the group label human ("Demon Form ramp").
- **Matching across players — honest limits:** the public API has **no endpoint that
  accepts a deck and returns how many players ran it**. `/api/runs/list`, `/api/runs/stats`,
  `/api/runs/leaderboard` are site-level listings, not deck-signature search. What the API
  *can* tell us: cohort sizes (`total_runs`, `character_runs` from any metrics payload),
  per-card `pick_rate`/`picks`/`offered` (how often each card is drafted when seen), and
  pairwise synergy evidence via draft-advice `reasons`/`lift`. The **nearest honest proxy**
  for "how many players played this deck": *"of N \<character\> runs in this bracket, your
  core cards are picked X–Y% of the time when offered; decks fielding most of your core
  appear in roughly the overlap of those rates"* — surfaced as a labeled **proxy** with the
  cohort count, never as a fabricated exact match count. (If spire-codex.com later grows a
  deck-search endpoint, the signature is ready to send.)

---

## 3. Analysis pipeline

### 3.1 Card use — from combat pile polling (feasible, verified)

`RawPileState` gives all four piles at ~150 ms with per-instance `baseAddress`. Per combat,
the recorder tracks instance transitions:

- **drawn**: instance first seen in `hand`.
- **played (approx.)**: instance leaves `hand` while `isCombatInProgress` and
  `currentSide === 1` (player turn) and reappears in `discard`/`exhaust` — or, for
  **powers**, vanishes from all piles (powers leave play entirely: a clean signal).
- **end-of-turn discards excluded**: any hand→discard transitions within 2 polls of a
  `currentSide` change are not counted as plays (bulk discard).
- 150 ms resolution can merge two same-id plays in one tick — counts are labeled
  **"times played (approx.)"** in the UI. Manual discards (e.g. via card effects) can
  still miscount as plays; accepted and documented.

Aggregated per run: `plays[id]`, `drawn[id]` across combats → the deck view's per-card
use counts.

### 3.2 Never-used cards — pure local

From `finalDeck` joined against the aggregates: `plays == 0 && drawn > 0` → **"drawn ×N,
never played"** (the damning flag); `drawn == 0` → **"never even drawn"** (neutral — bad
luck, not a bad card). Zero API cost.

### 3.3 Which cached data answers what

| Question | Source | Network cost |
|---|---|---|
| Card use / never-used | run file only | 0 |
| Per-card tier/score/win-rate/pick-rate context on the final deck | `CodexClient` primed snapshot (`metricsCards`, already on disk) + `CompendiumService` metrics cache (`?character=` slice, 30 min TTL) | 0–1 requests |
| Deck popularity proxy | same metrics payload (`total_runs`, `character_runs`, per-card `pick_rate`) | 0 (piggybacks) |
| Skipped synergies | **advice already captured live** in `offer_shown.advice` (provider's `adviceCache` is filled while playing) + post-run draft-advice replays for offers that never got advice | ≤10 POSTs |
| Names/art | `nameMap` (sts2json CDN) + codex catalogs (7-day disk cache) | 0 |

### 3.4 Post-run calls & budget

Triggered by `run_end`/`game_over`, runs in the background through `codexHttp` (shared
cooldowns, 15 req/min **per endpoint** — draft-advice and metrics are different endpoints,
so their budgets don't collide):

1. **1× `GET /api/runs/metrics/cards?bracket=all&character=<char>`** — usually a cache hit
   in `CompendiumService`; gives the character-sliced tier/score context and the cohort
   counts for the popularity proxy.
2. **≤10× `POST /api/draft-advice`** — replay the **key skipped offers**: offers where
   `picked === null` (or the pick scored below the best offer) **and** no advice was
   captured live. Prioritized by lateness (later deck = more synergy signal) and source
   (cardReward > chooseACard > merchant). Spaced ≥4.5 s apart (≤13/min, under the limit
   with headroom for the live overlay if a new run has already started). Each replay sends
   `deckBefore` from the event — the deck *as it was at that floor*, which is what makes
   the review honest ("with what you were holding, X was the pick, because…").
3. **0–1× `GET /api/runs/metrics/relics?…`** — only once relics become readable.

Hard budget: **≤12 requests per run analysis**, one-shot, resumable (analysis object
records which offers were replayed; a killed app finishes the remainder next launch).
Result is written into the run file's `analysis` field:

```jsonc
"analysis": {
  "builtAt": 1786665160000, "apiVersion": 41,
  "deckContext": [ { "id": "DEMON_FORM", "tier": "A", "score": 82, "winRate": 52.1, "pickRate": 61.3 } ],
  "popularity": { "cohortRuns": 18412, "characterRuns": 4210,
                  "corePickRates": { "DEMON_FORM": 61.3, "INFLAME": 58.0 },
                  "note": "proxy" },
  "skippedSynergies": [ { "eid": 17, "floorTag": "F12", "offered": "FEEL_NO_PAIN",
      "tookInstead": "TWIN_STRIKE", "score": 0.44, "base": 0.31,
      "reasons": ["Bloodletting 68%", "Offering 71%"] } ],
  "neverUsed": [ { "id": "TWIN_STRIKE", "drawn": 11 }, { "id": "BODY_SLAM", "drawn": 8 } ],
  "recommendations": [ /* rendered review bullets, precomputed */ ]
}
```

---

## 4. Mockup brief — three static HTML mockups

Three design agents each build **one self-contained static HTML file** (suggested:
`docs/mockups/journal-chronicle.html`, `journal-warroom.html`, `journal-ledger.html`).
Rules for all three:

- **No build step, no external JS.** Inline CSS only. Google Fonts `<link>` for
  **Kreon** (display) + **Montserrat** (body) allowed.
- **Real art allowed**: full card renders `https://cdn.spire-codex.com/cards-full/stable/{id_lowercase}.webp`
  (append `_upg` before `.webp` for upgraded), sprites
  `https://cdn.spire-codex.com/{cards|relics|potions}/{id_lowercase}.webp`.
  **Every `<img>` must carry an `onerror` fallback** that hides the image and shows a
  styled name plate — some StS2 ids may not resolve on the CDN and a broken-image icon is
  an automatic fail.
- All three render **the same fixture run** (§4.1) so they're comparable.
- Desktop-first (the dashboard window), ~1100–1400 px content width, dark only.

### 4.1 Shared fixture run (render exactly this data)

**Run summary** — Ironclad, Ascension 0, **died to the Act 3 boss on floor 45**
(room 45 of 45). Elapsed **51 m 33 s**, pace **1 m 09 s / floor**. Header numbers:
Character **IRONCLAD** · Act **3** · HP **0/82** (final; 62/82 entering the boss) · Gold
**143** · Asc **0** · Deck **26** · Relics **6** · Potions **1** · Pace **1m 09s / 51m 33s**
· Result **DEFEATED — Act 3 Boss**. (Boss identity is a placeholder — encounter names
aren't readable yet; label it "Act 3 Boss".)

**Route** (floor → type, act boundaries after F15 and F30; `note` only where it matters):

```json
[
 {"f":1,"type":"fight"},{"f":2,"type":"fight"},{"f":3,"type":"fight","pickup":"ANGER"},
 {"f":4,"type":"event"},{"f":5,"type":"fight","pickup":"SHRUG_IT_OFF"},
 {"f":6,"type":"treasure","pickup":"AMETHYST_AUBERGINE"},
 {"f":7,"type":"fight","pickup":"POMMEL_STRIKE"},
 {"f":8,"type":"elite","pickup":"AKABEKO","note":"elite: 2 enemies"},
 {"f":9,"type":"shop","note":"removed STRIKE · bought WHIRLWIND (156g)"},
 {"f":10,"type":"fight","pickup":"IRON_WAVE","skipped":true,"note":"reward skipped"},
 {"f":11,"type":"rest","note":"upgraded BASH"},
 {"f":12,"type":"fight","pickup":"TWIN_STRIKE","note":"⚠ skipped FEEL_NO_PAIN"},
 {"f":13,"type":"event","pickup":"BLOODLETTING"},
 {"f":14,"type":"rest","note":"upgraded INFLAME"},
 {"f":15,"type":"boss","pickup":"DEMON_FORM","note":"Act 1 boss down · 74/80 HP"},
 {"f":16,"type":"fight"},{"f":17,"type":"fight","pickup":"UPPERCUT"},
 {"f":18,"type":"event"},{"f":19,"type":"fight","pickup":"CARNAGE"},
 {"f":20,"type":"treasure","pickup":"ART_OF_WAR"},
 {"f":21,"type":"fight","pickup":"DISARM"},
 {"f":22,"type":"rest","note":"upgraded SHRUG_IT_OFF"},
 {"f":23,"type":"elite","pickup":"ALCHEMICAL_COFFER"},
 {"f":24,"type":"fight","pickup":"BATTLE_TRANCE"},
 {"f":25,"type":"event","pickup":"BODY_SLAM","note":"event add"},
 {"f":26,"type":"fight"},{"f":27,"type":"shop","note":"bought ASHWATER (48g)"},
 {"f":28,"type":"shop","note":"⚠ skipped BARRICADE (187g) · bought BREAD (203g)"},
 {"f":29,"type":"rest","note":"upgraded POMMEL_STRIKE"},
 {"f":30,"type":"boss","pickup":"OFFERING","note":"Act 2 boss down · 58/82 HP"},
 {"f":31,"type":"fight","pickup":"ANGER"},
 {"f":32,"type":"fight"},{"f":33,"type":"event","pickup":"IMPERVIOUS","note":"⚠ skipped LIMIT_BREAK"},
 {"f":34,"type":"fight","pickup":"CARNAGE"},
 {"f":35,"type":"rest","note":"upgraded BATTLE_TRANCE"},
 {"f":36,"type":"elite","note":"used ATTACK_POTION"},
 {"f":37,"type":"fight"},{"f":38,"type":"treasure"},
 {"f":39,"type":"fight"},{"f":40,"type":"event"},
 {"f":41,"type":"fight"},{"f":42,"type":"shop","note":"nothing bought"},
 {"f":43,"type":"fight"},{"f":44,"type":"rest","note":"rested · 62/82 HP"},
 {"f":45,"type":"boss","note":"DEFEATED — Act 3 Boss"}
]
```

**Final deck — 26 cards** (grouped `×N` like the reference UI; `plays` = times played
(approx.), `drawn` = times drawn; `never` flags):

```json
[
 {"id":"STRIKE","upg":0,"count":4,"plays":41,"drawn":52},
 {"id":"DEFEND","upg":0,"count":4,"plays":47,"drawn":55},
 {"id":"BASH","upg":1,"count":1,"plays":19,"drawn":21},
 {"id":"ANGER","upg":0,"count":2,"plays":12,"drawn":15},
 {"id":"TWIN_STRIKE","upg":0,"count":1,"plays":0,"drawn":11,"never":"drawn 11× — never played"},
 {"id":"POMMEL_STRIKE","upg":1,"count":1,"plays":22,"drawn":24},
 {"id":"SHRUG_IT_OFF","upg":1,"count":1,"plays":16,"drawn":18},
 {"id":"SHRUG_IT_OFF","upg":0,"count":1,"plays":18,"drawn":19},
 {"id":"WHIRLWIND","upg":0,"count":1,"plays":9,"drawn":13},
 {"id":"INFLAME","upg":1,"count":1,"plays":15,"drawn":16},
 {"id":"DEMON_FORM","upg":0,"count":1,"plays":7,"drawn":12},
 {"id":"CARNAGE","upg":0,"count":2,"plays":11,"drawn":17,"never":"2nd copy never played"},
 {"id":"UPPERCUT","upg":0,"count":1,"plays":13,"drawn":15},
 {"id":"DISARM","upg":0,"count":1,"plays":10,"drawn":11},
 {"id":"BLOODLETTING","upg":0,"count":1,"plays":14,"drawn":15},
 {"id":"BATTLE_TRANCE","upg":1,"count":1,"plays":16,"drawn":16},
 {"id":"IMPERVIOUS","upg":0,"count":1,"plays":5,"drawn":7},
 {"id":"BODY_SLAM","upg":0,"count":1,"plays":0,"drawn":8,"never":"drawn 8× — never played"},
 {"id":"OFFERING","upg":0,"count":1,"plays":8,"drawn":9}
]
```

**Relics (6)**: `BURNING_BLOOD` (starter), `AMETHYST_AUBERGINE` (F6), `AKABEKO` (F8),
`ART_OF_WAR` (F20), `ALCHEMICAL_COFFER` (F23), `BREAD` (F28).
**Potions (1 held)**: `ASHWATER`; used: `ATTACK_POTION` at F36.

**Journey Review content** (all three mockups render these verbatim):

*Skipped synergies* (draft-advice style — score is the deck-conditioned pick value ×100,
graded A≥40 / B≥25 / C≥15 like the overlay; reasons are "held card + pair win rate"):

1. **F12 — took Twin Strike over Feel No Pain.** Feel No Pain: **44 (A)** for your deck
   vs 31 standalone — reasons: *Bloodletting 68%*, *Offering 71%*, *exhaust package
   already in deck*. Twin Strike graded **12 (D)** and was never played all run.
2. **F28 shop — left Barricade (187g) and bought Bread (203g).** Barricade: **41 (A)** —
   reasons: *Body Slam 74%*, *Shrug It Off ×2 62%*. Body Slam sat unplayed for 8 draws
   because block never persisted.
3. **F33 — took Impervious over Limit Break.** Limit Break: **47 (A)** — reasons:
   *Demon Form 77%*, *Inflame 66%*, *Anger ×2 58%*. Impervious graded 28 (B) — fine,
   but the ramp package was one card from going exponential.

*Never-used cards*: Twin Strike (drawn 11, played 0), Body Slam (drawn 8, played 0),
2nd Carnage (played 0). Recommendation line: "three dead cards ≈ one whole redraw per
combat — shop removals were available at F27 and F42."

*Deck popularity (proxy)*: "**4,210 Ironclad runs** in this bracket (18,412 total). Your
core (Demon Form · Inflame · Whirlwind · Uppercut) is picked **58–61%** of the time when
offered; decks fielding most of this core appear in roughly **9–14%** of Ironclad runs.
*Proxy — the community API can't count exact deck matches.*"

*Pace*: "1m 09s per floor — faster than your archive average (1m 46s). Two shops passed
with gold above 140."

### 4.2 Design tokens (copy exactly — from `overlay.css`, `ui.tsx`, `tiers.ts`)

```css
/* background: the dashboard surface (Shell.tsx) */
background: radial-gradient(120% 120% at 50% 0%, #2a2622 0%, #171512 62%, #100e0c 100%);

/* ink ramp */         --ink: #fff6e2;  --ink-dim: #9c9384;  --ink-faint: #918878;
/* hairlines/fills */  --line: oklch(1 0 0 / 9%);  --line-strong: oklch(1 0 0 / 15%);
                       --fill: oklch(1 0 0 / 5%);  --fill-hover: oklch(1 0 0 / 9%);
/* brand */            --brand: #b47bff;  --brand-deep: #6b3fbe;  --brand-soft: #d8c2ff;
/* accents */          --gold: #efc851;  --red: #ff5555;  --green: #7fff00;
                       --aqua: #2aebbe;  --orange: #ffa518;  --cream: #fff6e2;
/* ironclad */         --ironclad-frame: oklch(0.444 0.119 32.7);
                       --ironclad-edge:  oklch(0.574 0.129 33.2);
/* tier colors */      S/A #7fff00 · B #2aebbe · C #efc851 · D #ffa518 · E/F #ff5555
/* panels */           background: rgba(38,35,33,0.55); border: 1px solid var(--line);
                       border-radius: 12px;
/* cards/floats */     background: rgba(38,35,33,0.66); box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);
/* type */             display: 'Kreon', serif (titles, tier letters, big numbers);
                       body: 'Montserrat', system-ui, sans-serif;
                       mono whispers: Consolas/ui-monospace, 11px, --ink-faint;
```

Conventions that must hold: Kreon section titles at 17–19 px with the fading hairline
rule running out to the right (`SectionHead::after`); tier/grade chips are **solid** with
dark text (`#17140f`), radius 6px, Kreon; `tabular-nums` on every numeric column; warm
grays only — no neutral gray, no new hues beyond the tokens above.

### 4.3 Required sections (every mockup, all five)

1. **Run header** — the user's reference fields: character (Ironclad-tinted), act, HP,
   gold, Asc, deck count, relic count, potion count, **Pace (per-floor / total)**, plus
   the result banner (DEFEATED — Act 3 Boss · floor 45 · 51m 33s).
2. **Route / timeline** — all 45 floors with per-floor tags (F1…F45), room-type
   iconography or labels, act boundaries, pickups inline, and the three ⚠ moments visibly
   marked.
3. **Deck** — 26 cards grouped ×N with per-card **use counts** (played/drawn) and
   **never-used flagging** that is impossible to miss.
4. **Relics & potions** — sprites + names + pickup floor tags; used-potion shown as spent.
5. **Journey Review** — the three better-choice recs **with their reasons**, the
   never-used block, the deck-popularity proxy line (with its honesty caveat), and the
   pace note.

### 4.4 Three design directions — one per agent, meaningfully distinct

**Direction A — "The Chronicle" (narrative vertical journal).**
The run is told top-to-bottom as a single illuminated story: a hero header (big Kreon
title, result banner, the stat row as an engraved plaque), then one continuous vertical
timeline where every floor is an entry — pickups render as small card art hung off the
spine, act boundaries as ornamental dividers, the three ⚠ moments as full-width
interruption panels that break the flow the way the mistake broke the run. Deck, relics,
and review follow as chapters with the fading-rule section heads. Generous whitespace,
at most two columns anywhere, art used large and sparingly. The Journey Review reads as
an epilogue — prose-first verdict cards, reasons as quoted marginalia. This direction
optimizes for *reading one run like a story*; scrolling is the interaction model and
length is a feature, not a bug.

**Direction B — "The War Room" (two-pane, route as the spine).**
A fixed two-pane layout: the left pane (~320 px) is the route — a dense, scrollable
floor-by-floor spine with type icons, HP/gold sparkline hints, and ⚠ markers; the right
pane is the dossier — header strip pinned on top, then deck grid, relics/potions rail,
and the Journey Review as stacked intel cards. The two panes are visually cross-linked:
floors with pickups show a connector accent, and the mockup should *fake* the interaction
(a `:hover` highlight on a floor row lights up the matching deck card via CSS where
cheap, or just visual echo via shared accent tags — no JS). Everything visible without
reading order; the user scans, not reads. This is the "companion app" direction — closest
to the Spire Codex live tracker the user referenced, and the natural shape for the live
Current Run view to share.

**Direction C — "The Ledger" (analyst's post-mortem report).**
Information density as the aesthetic: a report header (run metadata as a mono-whisper
manifest), then table-first everything — the route as a compact 45-row ledger table
(floor, type, event, delta columns for HP/gold once readable, pickup), the deck as a
sortable-looking table with played/drawn/efficiency columns and a red NEVER PLAYED flag
column, and the Journey Review as numbered findings (F-01, F-02…) each with a severity
chip (graded with the tier palette), evidence rows, and a one-line remedy. Art is
sprites-only at 20–24 px inline; no full card renders. Rules, `tabular-nums`, sticky
header styling, and 11–13 px type throughout. It should feel like the document an
Ironclad accountant files after an audit of your death — dry, exact, damning.

---

## 5. Pragmatics — what ships when

**Phase 1 (existing data only):** RunRecorder + run files + archive list + Current Run
view showing character/act/deck/pickup-timeline/pace (rooms-entered basis) + Journey
Review with card use (approx.), never-used, skipped synergies (live-captured advice +
≤10 replays), popularity proxy. Relics/Potions sections render "—", HP/Gold/Asc render
"—", room types beyond combat/merchant/event render as generic rooms.

**Phase 2 (new readers, in value order):**
1. floor / map room history (`MapPointRoomHistoryEntry` is already stubbed) — fixes floor
   tags, rest/treasure/boss labels, and route accuracy;
2. player HP + max HP (mirror the existing `Creature._currentHp` path) — enables the
   header HP and per-floor HP deltas;
3. gold — header + shop analysis ("skipped Barricade with 210g in hand");
4. owned relics + potions — completes the header, the sections, and `relicHash`;
5. ascension + game-over variant (death vs victory) + encounter/boss names.

Each reader lands as a pure function in `readers.ts` + model accessors in `models.ts`,
same pattern as everything there; the run-file schema already has the slots (`null` until
filled), so **no schema migration** is needed when readers arrive — old runs simply have
honest nulls.

**Explicit non-goals for v1:** uploading runs anywhere, multiplayer runs (other players'
decks), per-turn combat replay, and any UI that presents the popularity proxy as an exact
count.
