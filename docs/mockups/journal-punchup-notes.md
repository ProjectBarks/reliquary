# Journal Blend — punch-up spec (pop & spunk pass)

Brief: "more pop and spunk … bring more of journal-ledger.html in … liked the colors
and the pazaaza, nothing stands out in the new one and we lost some cool numbers."

Target: `docs/mockups/journal-blend.html` edited IN PLACE. Every hue below is an
existing token (`--gold --red --orange --aqua --green --brand-soft --ironclad-*`).
No new colors, fonts, or primitives. Strict-v1 fixture is untouchable — every number
below is recomputed from the blend's own data, not copied from Ledger.

Two spec amendments (deliberate, director-approved):
- A. Bars are now allowed in TWO places: deck rate column AND the route census strip
  (Ledger DNA the user explicitly asked back).
- B. Room-type chips carry hue. Type hue is DATA, not accent — it does not count
  against the one-accent-per-row law.

## Edit list

### Builder 1 — main `<style>` block + header + route + secondary states

1. **Room-type chip hues.** Add modifier classes to `.chip-outline` (define next to
   the tier-chip rules, same pattern: `color:var(--x);border-color:color-mix(in
   oklab,var(--x) 42%,transparent)`):
   - `.rt-fight` → `--ink-dim` (neutral; fights are the baseline, they stay quiet)
   - `.rt-event` → `--brand-soft`
   - `.rt-shop`  → `--gold`
   - `.rt-other` → `--aqua`
   Apply to EVERY type chip: 45 route rows, the live-state mini route (R19–R23),
   and the census strip (below). Ledger precedent: `.rm.event/shop/rest` hues.

2. **Census strip (route section).** Replace the four gray chips in the Route Ledger
   section-head with a slim census band between the section-head and the table:
   4 hairline cells (grid, `1px` gaps on `--line`, cells `#1e1b18`, radius 10 — same
   construction as `.piles`): each cell = hued type chip + Kreon 20px count + 3px bar
   (track `--fill`, fill = the type hue, width = share of 45 rooms: FIGHT 26 → 58%,
   EVENT 6 → 13%, SHOP 4 → 9%, OTHER 9 → 20%). Keep "rooms in order entered" whisper
   in the section head.

3. **Header: Ironclad tint + verdict plate.**
   - `.runhead::before` edge → Ledger's gradient: `linear-gradient(to bottom,
     var(--ironclad-edge),var(--ironclad-frame) 70%,transparent)`.
   - `.plaque` gets the Ironclad wash: cells stop being transparent-on-black; give
     the plaque `background:color-mix(in oklab,var(--ironclad-frame) 14%,
     oklch(0 0 0 / 24%))`. Check `.pcell .k` (`--ink-faint`) still reads ≥4.5:1 —
     if not, bump those keys to `--ink-dim`.
   - `.banner` becomes a real plate: bg alpha 10%→16%, `.word` 21px→24px,
     letter-spacing 1.6→1.8px, hard offset text-shadow `2px 2px 0 oklch(0 0 0/45%)`
     (Ledger's), and `box-shadow:var(--float-shadow)` (the app's committed hard
     shadow). Same geometry inherits to `.win` and `.live` (live `.word` stays 17px).

### Builder 2 — `<style id="parts">` block + deck ledger + findings

4. **Findings summary strip — THE COOL NUMBERS.** New band inside the Journey Review
   section, between the section-head and `.cards`. Ledger's `.audit` anatomy: flex
   wrap, `1px` gaps on `--line`, cells `#1e1b18` flex `1 1 150px`, radius 10,
   overflow hidden; each cell = 9px uppercase `--ink-faint` key + Kreon 20–22px value.
   Cells and hues (RECOMPUTED — blend fixture):
   `FINDINGS 4` (ink) · `SEVERE 1` (red) · `DRAFT ERRORS 3` (orange) ·
   `DEAD CARDS 3` (red) · `DEAD DRAWS 71` (orange) · `REMOVALS PASSED 2` (ink) ·
   `GRADE OF BEST PASS A · 47` (green — Limit Break, F-03).
   All styles scoped under `.findings`.

5. **Deck ledger: Dead draws column.** New column between Played and Rate, header
   `DEAD`, right-aligned, `--ink-faint` numerals (it is a shame column, not a hero
   column). Values per row (drawn − played, verified sums to 71):
   01 Defend 8 · 02 Strike 11 · 03 Pommel+ 2 · 04 Bash+ 2 · 05 Shrug 1 ·
   06 Shrug+ 2 · 07 BattleTrance+ 0 · 08 Inflame+ 1 · 09 Bloodletting 1 ·
   10 Uppercut 2 · 11 Anger 3 · 12 Carnage 6 · 13 Disarm 1 · 14 Whirlwind 4 ·
   15 Offering 1 · 16 DemonForm 5 · 17 Impervious 2 · 18 TwinStrike 11 ·
   19 BodySlam 8. Tfoot: `71` in the new column (drop the "71 dead draws" text from
   the verdict foot cell — it moves home). Adjust `<colgroup>` widths so nothing
   wraps at 1440.

6. **Never-played rows: the tinted wash + red numerals.** Ledger's treatment,
   1px max: `tr.is-dead td{background:oklch(0.62 0.21 22 / 8%)}`, hover 13%,
   `tr.is-dead td:first-child{box-shadow:inset 1px 0 0 var(--red)}`, and idx +
   drawn + dead numerals go `--red` (played/rate already are). `tr.is-half` gets the
   orange wash at 6% (hover 11%) — chip stays outline, numerals stay ink (row's
   accent is the chip).

7. **Severity chips: full plate.** `.findings` severity chips get Ledger's plate
   geometry: height 20px, font-weight 600, `border:1px solid oklch(0 0 0 / 22%)`.
   (They are already solid red/orange/gold with dark text — keep.)

### Edit 8 (added mid-pass, user requirement) — deck rows use the actual card model

"Make the deck ledger use the actual card model like the other screens." Deck Ledger
rows lead with the framed FULL render — `cards-full/stable/{id}.webp`, aspect 400:520,
the same asset family the findings use — replacing the 34×26 sprite crops. Upgraded
rows (+) use `{id}_upg.webp`. Thumb ≈ 42×55px, 1px `--ironclad-frame` border,
radius 4; row height rises to a CONSISTENT ~64px, art vertically centered, name
column and all numerals unchanged; never-played wash/red numerals still apply.
CDN reality (HEAD-checked): `defend`, `strike`, `carnage`, `disarm` have NO full
render (404) — the onerror name-plate fallback must occupy the exact same 42×55
footprint so rows stay uniform. All five `_upg` ids for this fixture return 200.

## What does NOT change
Route row accents (gold pickup names, flag law), findings card anatomy, text budgets,
all fixture numbers, secondary-state content, no glows, no gradient text, no new bars
beyond amendments A. The page keeps ONE peak: the header verdict plate; everything
else added here is systemic (info-bearing) color.
