# Journal Blend — synthesis spec (mockup 4 of 4)

The blend: **Ledger's skeleton, Chronicle's readability, War Room's ideas — with the
volume turned all the way down and every unknowable number deleted.**

One file: `docs/mockups/journal-blend.html`. Single column, 1440 px target (max-width
1240 content), no layout break at 1200. Dark only. Self-contained, inline CSS, no
external JS (tiny inline JS not needed — states are stacked sections, no toggle).

---

## 1. Why one file, three stacked states

One file with the **death Run Report primary**, then two clearly-labeled secondary
bands: **LIVE (Current Run)** and **VICTORY (header variant)**. Justification: the real
tab is one component with states; stacking them in one scroll makes the shared design
system self-evident and lets the user compare states without tab-switching a mockup.
Each secondary state opens with a full-width state divider (see §6) so there is zero
ambiguity about where the death report ends.

## 2. Section order (exact)

1. App chrome mock (top bar: Reliquary · Home/Codex/Journal/Settings, Journal active) —
   copy Ledger's, minus the run-picker dropdowns (keep one dropdown + "Export JSON").
2. **STATE — RUN REPORT** (death, primary)
   a. Run header: Kreon title plaque (Chronicle's readable stat row, Ledger's mono
      manifest whisper underneath), result banner right-aligned.
   b. Honesty whisper (one mono line, see §5).
   c. **Route Ledger** — 45-row table (Ledger structure, Chronicle row height).
   d. **Deck Ledger** — 19-row table with framed art thumbs.
   e. **Relics & Potions** — honest strip: "not readable in v1" + shop sightings.
   f. **Journey Review** — 4 compact finding cards + 2 footnote lines.
3. **STATE — LIVE · CURRENT RUN** (secondary band)
4. **STATE — VICTORY variant** (secondary band, header only)
5. Footer mono whisper: `analysis 11 req / budget 12 · api v41 · schema 1`.

## 3. Parentage map (what comes from which mockup)

| Element | Parent | Change |
|---|---|---|
| Report/table skeleton, F-0x findings numbering, flags column, mono manifests, tabular-nums | Ledger | keep |
| Stat plaque header, bigger route type (13px not 11px), act dividers, result banner type, one-column flow | Chronicle | strip narrative prose, no full-bleed card art in route |
| Dead-cards summary card, live-state concept, play-rate bars | War Room | bars only in deck table; no side pane; no pickup-timeline strip; no cross-linking |
| Census sidebar (Ledger) | — | DROPPED — becomes one inline chip row in the route section head |
| Chronicle's per-floor card renders in timeline | — | DROPPED — 18px sprites only in route |

## 4. Visual-noise rules (the War Room lesson — binding)

1. ONE column. No fixed panes, no sidebars.
2. ONE accent per row, max. Route row: pickup name is gold OR flag chip is red — a
   flagged row's pickup name goes `--ink`, not gold.
3. Solid color chips ONLY for grades/severity (tier palette, dark `#17140f` text,
   radius 6, Kreon). Room-type chips are OUTLINE only: 1px `--line-strong`, `--ink-dim`
   text, 10px Montserrat 600 caps. Flag refs (F-01) are 1px red-outline, red text.
4. No glows, no box-shadows except the token float shadow on finding cards, no
   gradients except the page background token.
5. Bars: ONLY the deck table play-rate column (3px tall, `--brand`, track `--fill`).
   No bars/sparklines anywhere else.
6. Art: route = 18px sprites (`cdn.spire-codex.com/cards/{id}.webp`); deck = framed
   thumb 34×26 (`cards/` sprite, 1px `--ironclad-frame` border, radius 4); findings =
   full renders (`cards-full/stable/{id}.webp`) at ~110px wide, exactly 2 per card.
   EVERY img has onerror → hide img, show styled name plate (Kreon, `--fill` bg).
7. Row height ≥ 30px in route, ≥ 36px in deck. Section gap 56px. Max 3 type sizes per
   section. `tabular-nums` on every numeric cell.
8. Warm grays only; tokens verbatim from the plan §4.2. No new hues.

## 5. Strict-v1 honesty (recomputed fixture — render EXACTLY this)

**Dropped vs parents** (unknowable today, verified against `readers.ts`): HP (all reads,
incl. "62/82 entering boss", per-floor HP notes), gold total ("143 unspent"), ascension,
floor numbers (→ room count `R01…R45`, header says `≈ floor`), rest/treasure/boss room
types (→ `OTHER`; boss inferred only from act change), enemy/boss names ("Act 3 Boss" →
"final combat · act 3"), ALL owned relics (starter Burning Blood, Amethyst Aubergine,
Akabeko, Art of War, Alchemical Coffer, Bread), ALL potion ownership/use (Ashwater held,
Attack Potion at F36), relic/potion purchases (Bread), "gold above 140" pace note.

**Kept** (observable): deck + upgrades, per-card played/drawn (labeled approx.), card
offers with prices, pick/skip inference, card purchases (deck gain matching stock:
Whirlwind 156g), removals (Strike at R09), upgrades (deck diff), event adds, act
changes, enemy counts, room-type combat/merchant/event/other, pace, game version,
game over. Findings survive: F-01 unchanged; **F-02 reframed** — Barricade is a CARD
in shop stock (187g) and the deck never gained it = confirmed skip; the Bread half is
cut. F-03 unchanged.

**Honesty whisper** (under header, mono 11px `--ink-faint`):
`not readable in v1: hp · gold · ascension · owned relics · potions · enemy names · exact floors — rooms counted as ≈floors`

### 5.1 Header fields (plaque)
CHARACTER **IRONCLAD** (ironclad-tinted) · ACT **3** of 3 · DECK **26** (19 stacks) ·
ROOMS **45** entered (≈ floor 45) · PACE **1m 09s** / room · ELAPSED **51m 33s**.
Result banner: **DEFEATED** — final combat · act 3 · ≈R45. NO hp/gold/asc/relic/potion
cells — absence, not dashes; the whisper line carries the why.
Manifest whisper: `run 2026-08-12T23-40-11Z · ironclad-a41f3c · game 1.3.0.123 · schema 1 · analysis 11 req / budget 12`

### 5.2 Route Ledger (45 rows)
Columns: `R#` (mono) · type chip · entry (≤6 words) · pickup (18px sprite + name) · flag.
Section head chip row: `26 combat · 6 event · 4 shop · 9 other`. Act dividers after R15
and R30: thin rule + `ACT 2 — act index changed after this combat (boss inferred)`
(mono). Data (entry "—" renders as dim em-dash; `pickup:` = gold name + sprite;
`skip:` = strikethrough dim):

```
R01 FIGHT —              R02 FIGHT —                R03 FIGHT pickup:ANGER
R04 EVENT —              R05 FIGHT pickup:SHRUG_IT_OFF
R06 OTHER —              R07 FIGHT pickup:POMMEL_STRIKE
R08 FIGHT entry:"2 enemies"
R09 SHOP  entry:"removed Strike · bought Whirlwind 156g"  pickup:WHIRLWIND
R10 FIGHT entry:"reward skipped"  skip:IRON_WAVE
R11 OTHER entry:"upgraded Bash+"
R12 FIGHT entry:"skipped Feel No Pain"  pickup:TWIN_STRIKE  flag:F-01
R13 EVENT entry:"event add"  pickup:BLOODLETTING
R14 OTHER entry:"upgraded Inflame+"
R15 FIGHT pickup:DEMON_FORM   ← ACT 2 divider after
R16 FIGHT —              R17 FIGHT pickup:UPPERCUT   R18 EVENT —
R19 FIGHT pickup:CARNAGE R20 OTHER —                 R21 FIGHT pickup:DISARM
R22 OTHER entry:"upgraded Shrug It Off+"
R23 FIGHT entry:"2 enemies"
R24 FIGHT pickup:BATTLE_TRANCE
R25 EVENT entry:"event add"  pickup:BODY_SLAM
R26 FIGHT —
R27 SHOP  entry:"no card gained"
R28 SHOP  entry:"left Barricade 187g"  flag:F-02
R29 OTHER entry:"upgraded Pommel Strike+"
R30 FIGHT pickup:OFFERING   ← ACT 3 divider after
R31 FIGHT pickup:ANGER   R32 FIGHT —
R33 EVENT entry:"skipped Limit Break"  pickup:IMPERVIOUS  flag:F-03
R34 FIGHT pickup:CARNAGE R35 OTHER entry:"upgraded Battle Trance+"
R36 FIGHT entry:"3 enemies"
R37 FIGHT —  R38 OTHER —  R39 FIGHT —  R40 EVENT —  R41 FIGHT —
R42 SHOP  entry:"no card gained"
R43 FIGHT —  R44 OTHER —
R45 FIGHT entry:"DEFEATED — game over"  (red row accent, the ONLY tinted row)
```
Footer row: `45 rooms · 16 cards taken · 2 skipped · 5 upgrades · 1 removal`.

### 5.3 Deck Ledger (19 rows, 26 cards)
Columns: `#` · card (framed 34×26 thumb + colored name + `×N` + `+` for upgraded) ·
copies · drawn · played · rate (number + 3px bar) · verdict chip. Sort: played desc,
never-played last. Data = plan §4.1 final-deck JSON verbatim. Verdict chips: `CORE`
(brand outline) on Inflame, Uppercut, Whirlwind, Demon Form; solid red `NEVER PLAYED`
on Twin Strike + Body Slam; orange outline `2ND COPY DEAD` on Carnage. Table footer:
`354 drawn · 283 played · 79.9% · 71 dead draws`. Whisper: `played is approximate —
150 ms pile sampling; end-of-turn discards excluded`.

### 5.4 Relics & Potions (honest strip)
Head: `Relics & Potions` + outline chip `NOT READABLE IN V1`. One row of sighting
chips (sprite 18px + name + price + mono source): `ASHWATER 48g · shop R27`,
`BREAD 203g · shop R28`. Whisper: `only shop stock is observable today — ownership,
pickups and use land with the relic/potion readers`. Nothing else. ~90px tall total.

### 5.5 Journey Review — 4 finding cards + 2 footnotes
Card anatomy (all four identical): flag chip `F-0x` + severity chip + title (≤8 words)
· two full card renders side by side (PASSED left with green-edge grade chip, TAKEN
right) · grade chips `44 A` / `12 D` · 2–3 evidence chips (outline, `--ink-dim`) · ONE
verdict sentence (≤22 words, `--ink`, 13px). NO remedy row, NO prose block.

- **F-01 SEVERE — Took Twin Strike over Feel No Pain** (R12). FEEL_NO_PAIN 44 A vs
  TWIN_STRIKE 12 D. Chips: `Bloodletting 68%` `Offering 71%` `exhaust package in deck`.
  Verdict: "Twin Strike then proved the grade right by never being played once across
  eleven draws."  Mono: `cardReward · act 1 · deck 18 · advice captured live`
- **F-02 MAJOR — Left Barricade in the shop** (R28). BARRICADE 41 A, right slot = its
  render dimmed with `LEFT IN STOCK` plate (no "taken" card exists). Chips:
  `Body Slam 74%` `Shrug It Off ×2 62%`. Verdict: "Body Slam sat dead for eight draws
  because block never persisted without it."  Mono: `merchant stock 187g · deck 25 ·
  advice replayed post-run · purchase absence confirmed by deck`
- **F-03 MAJOR — Took Impervious over Limit Break** (R33). LIMIT_BREAK 47 A vs
  IMPERVIOUS 28 B. Chips: `Demon Form 77%` `Inflame+ 66%` `Anger ×2 58%`. Verdict:
  "The ramp package was one card from going exponential; Impervious was merely fine."
  Mono: `event choice · act 3 · deck 25 · advice replayed`
- **F-04 NOTED — Three cards did nothing all run.** No renders — three mini rows
  (sprite + name + `0 / 11 drawn` style). Twin Strike 0/11 · Body Slam 0/8 ·
  Carnage #2 0 plays. Verdict: "Three dead cards is one full redraw per combat, and
  two shops offered the removal."
- Footnote line 1 (PACE): `1m 09s / room — archive average 1m 46s · two shops left
  with no card gained`
- Footnote line 2 (PROXY chip): `4,210 Ironclad runs in bracket (18,412 total) · core
  picked 58–61% when offered · decks with most of this core ≈ 9–14% — proxy, the API
  cannot count exact deck matches`

## 6. Secondary states

State divider: full-width band, 1px top+bottom `--line-strong`, Kreon 15px letterspaced
label, mono sub — e.g. `STATE · LIVE — CURRENT RUN` / `what the tab shows mid-run`.

**LIVE** (~500px tall): header plaque variant — aqua `LIVE` outline chip + `IN COMBAT ·
2 enemies · your turn` where the result banner was; fields: IRONCLAD · ACT 2 of 3 ·
DECK 19 · ROOMS 23 · PACE 1m 03s / room · ELAPSED 24m 18s. Below, two half-width
panels side by side: (1) `Combat piles` — hand 5 · draw 9 · discard 4 · exhaust 1
(mono grid, observable live); (2) `Route so far` — last 5 route rows (R19–R23, same
row component as the ledger) + dim `…R01–R18` collapsed line. Whisper: `same readers
as the overlay — updates ~150 ms`.

**VICTORY** (~180px): header plaque only. Banner: **VICTORIOUS** (green, same geometry
as DEFEATED) — `final combat won · act 3 · ≈R52 · 58m 12s`. Fields: DECK 31 · ROOMS 52
· PACE 1m 07s / room. Whisper: `death vs victory needs the game-over-variant
micro-reader; until it lands the recorder writes "ended"`.

## 7. Text budgets (hard caps)

- Route entry cell: ≤6 words. Pickup cell: sprite + name only.
- Finding title ≤8 words; evidence = 2–3 chips; verdict = ONE sentence ≤22 words.
- No paragraph anywhere. One optional 2-line intro under the H1 max.
- All meta/honesty text = mono 11px `--ink-faint` whispers, one line each.

## 8. Tokens (verbatim — plan §4.2)

Copy the token block exactly: page bg radial gradient, ink ramp, line/fill, brand,
accents, ironclad frame/edge, tier colors S/A `#7fff00` B `#2aebbe` C `#efc851`
D `#ffa518` E/F `#ff5555`, panel bg `rgba(38,35,33,0.55)` + 12px radius, float shadow
`5px 5px 0 oklch(0 0 0 / 25%)`, Kreon display / Montserrat body / Consolas whispers,
SectionHead fading hairline `::after`.

## 9. Build contract (two parallel agents, zero file overlap)

- **Agent A** owns `journal-blend.html`: tokens + ALL base/global styles, chrome,
  header, honesty whisper, Route Ledger, both secondary states, footer. Leaves exactly
  three marker comments where sections 2d/2e/2f go:
  `<!-- INTEGRATE:DECK -->` `<!-- INTEGRATE:RELICS -->` `<!-- INTEGRATE:FINDINGS -->`
  Also defines shared classes Agent B may use: `.section`, `.section-head`, `.whisper`,
  `.chip`, `.chip-solid`, `.chip-outline`, `.flag`, `.tier-S…-F`, `.num`.
- **Agent B** owns `journal-blend-parts.html`: ONE `<style>` block where every rule is
  scoped under `.deck-ledger`, `.rp-strip`, or `.findings`, then the three section
  `<section>` blocks in that order. Must render standalone-viewable but assume Agent
  A's shared classes/tokens exist at merge time (duplicate the token `:root` block at
  the top of the parts file inside a comment-marked `<style id="dev-only">` that the
  director deletes on merge).
- Director merges, screenshots, critiques.
