# Font-size audit — dashboard surfaces (Home, Codex, Settings)

Audit date: 2026-08-13, branch `feature/codex-tab-v2` (uncommitted WIP present — line
numbers below may drift; every fix row carries a code anchor for relocation).

Scope: `src/renderer/src/dashboard/` and `src/renderer/src/codex/` (93 font-size
declarations). The game overlay (`src/renderer/src/overlays/`, DeckTracker,
`overlay.css` overlay rules) is **out of scope** — it scales with game zoom and has its
own layout table (`trackerLayout.ts`).

Fonts in play (defined once in `src/renderer/src/overlay.css` `:root`):

- `--font-body` = Montserrat (workhorse UI face)
- `--font-display` = Kreon, serif (titles, tier badges, nav tabs, disclosure heads)
- `--font-mono` = Cascadia Code (logs, JSON, kbd, code, entity ids)

There is **no global body font-size**; the dashboard inherits the browser default 16px.
No unsized text currently leaks (buttons like `Tile`, `ListRow`, `EntryButton` wrap all
text in sized spans), but this is a standing hazard — see Tokenization.

---

## 1. Proposed type scale

Derived from what the app actually needs: this is a compact desktop companion whose
dominant body size is 13px, with a Kreon display ramp above it and a dense
caption/overline ramp below. Nine steps; everything in the audit maps onto one.

| Step | px | Line-height | Face | Usage rule |
|---|---|---|---|---|
| `2xs` | 10px | 1.2 (or 1 in badges) | body / mono | Uppercase-tracked overlines and micro-labels (`StatLabel`, `GroupName`, `RecentHead`, tier badge labels), tabular badge counts, decorative glyphs (sort arrows). **Never** running text; never the only label of an interactive control unless it is a glyph inside an adequate hit area. |
| `xs` | 11px | 1.5 | body / mono | Captions, metadata, footnotes, static tag chips, `kbd`/inline `code`, entity ids, settings sub-heads (uppercase overline style). Accessibility floor for informational text. |
| `sm` | 12px | 1.5 | body / mono | Secondary body: descriptions, row meta, notes, tooltip bodies, log/mono blocks, interactive filter chips, compare table lines. |
| `base` | 13px | 1.55 (1.6 in prose; 1 in one-line controls) | body | Default body and control size: buttons, selects, search inputs, list-row names, hints, empty/loading states, RichText prose. |
| `md` | 15px | 1.35 (1 for glyphs) | display or body | Minor titles and emphasized text: nav tabs (`NavAnchor`, `TabAnchor`), subsection titles (`MetricsTitle`), compare column names, disclosure headers, scene caption names, close-glyphs, stat values. |
| `lg` | 17px | 1.3 | display | Section titles (`SectionTitle`), pane headers (`Compare` `HeadTitle`), Home scene state line. |
| `xl` | 19px | 1.25 | display | Card/page titles (`CardTitle`), title-bar brand, tier badge `lg`. |
| `2xl` | 22px | 1.15 | display | Entity name in the Codex detail panel (`Name`). One per view, max. |
| `display` | clamp(58px, 8.5vw, 96px) | 1.02 | display | The Home scene wordmark (`Word`) only. |

Rules of thumb:

- Hierarchy within a panel: `2xl`/`xl` title → `lg`/`md` section head → `base` body →
  `sm` secondary → `xs` caption → `2xs` overline. Never skip *down* (a section head
  must not be smaller than its body — weight/caps do not excuse a size inversion,
  except the established uppercase-overline pattern at `xs`/`2xs`).
- Interactive text floor: 11px (`xs`). Glyph-only controls may render the glyph at
  `2xs` if the hit target is ≥ 24px. Nothing at 9px, ever.
- 12.5px, 14px, 16px, 18px, 20px are **not steps** — every current occurrence is
  mapped in §3.

---

## 2. Findings

### Histogram (93 declarations across the two directories)

| Size | Count | Verdict |
|---|---|---|
| 9px | 3 | Off-scale, below floor (`TriggerBadge`, sort `Arrow`, `Unpin`) |
| 10px | 8 | `2xs` — 7 legitimate overlines/badges, 1 misuse (`EntryName`), 1 dev-only (`ToolButton`) |
| 11px | 18 | `xs` — coherent |
| 12px | 19 | `sm` — coherent |
| 12.5px | 2 | Off-scale one-off (Home buttons) |
| 13px | 21 | `base` — the app's true body size |
| 14px | 5 | Off-scale straddler — splits between `base` and `md` |
| 15px | 7 | `md` — coherent |
| 16px | 1 | Off-scale (`StatValue`) |
| 17px | 3 | `lg` — coherent |
| 18px | 1 | Off-scale one-off (`Brand`) |
| 19px | 1 | `xl` (`CardTitle`) |
| 20px | 1 | Off-scale (tier badge `lg` variant) |
| 22px | 1 | `2xl` (`Detail` `Name`) |
| clamp(58–96px) | 1 | `display` (Home wordmark) |
| dynamic (20/15/12) | 1 | `TierBadge` size prop (lg off-scale) |
| `font: inherit` | 1 | `ThButton` reset — correct, keep |

15 distinct pixel values where 9 steps suffice. The suspicion of accretion is
confirmed, but mildly: 11/12/13/15 are internally consistent ramps; the rot is
concentrated in 9, 12.5, 14, 16, 18, 20.

### (a) Off-scale one-offs

- 12.5px: `QuietButton`, `RestartButton` (Home.tsx) — nothing else uses half-pixels.
- 14px: `RowLabel`, `Status` (ui.tsx), `Crashed strong` (Shell.tsx), `ErrorTitle`
  (codex parts.tsx), `BubbleTerm` (KeywordTooltip.tsx).
- 16px: `StatValue` (Detail.tsx).
- 18px: `Brand` (TitleBar.tsx).
- 20px: `TierBadge` `$size='lg'` (tiers.ts).
- 9px: `TriggerBadge` (parts.tsx), `Arrow` (MetricsTableView.tsx), `Unpin`
  (PinnedRail.tsx).

### (b) Hierarchy inversions / sibling-view drift

- **Entity name across the three Codex browse views**: grid `TileName` 11px, list
  `RowName` 13px, tier `EntryName` 10px. Three sizes for one semantic role. The
  grid/list split (11 vs 13) is defensible — the grid packs ~500 tiles and the list
  row is roomier — but the tier board's 10px drops an entity name below the
  informational floor. Fix: `EntryName` → `xs` 11 to match the grid; accept the
  list at `base` 13 as a documented density exception.
- **Section heads inside the Codex detail panel**: `UpgradeHead` 13px vs
  `MetricsTitle` 15px — same tier of Kreon section head, two sizes in one panel.
- **Error titles**: codex `ErrorTitle` 14px vs Shell `Crashed strong` 14px vs the
  rest of the title ramp — 14 exists only here and in tooltips/row labels; both map
  to `md` 15.
- Settings `SubHead` (h3, 11px uppercase) sits below its 13px body — this is the
  deliberate overline pattern (caps + 0.1em tracking + faint ink), not an inversion.
  Keep at `xs`.

### (c) Same role, different sizes across surfaces

- **kbd chips**: Home `Keys kbd` 12px vs Settings `Kbd` 11px vs codex
  `SearchAffordance` 11px. Unify at `xs` 11.
- **Mono data bodies**: `JsonView Root` 11px vs `Logs Body` 12px vs ui.tsx `Mono`
  12px. Unify at `sm` 12.
- **Toolbar controls**: dashboard `Button`/`Select` and Logs buttons 13px vs codex
  `SegmentButton` 12px — both are 34px-tall toolbar controls. Unify at `base` 13.
- **Interactive filter chips**: codex `ChipButton` 11 / `RecentChip` 11 vs
  `ChipAnchor` 12 / Compare `Candidate` 12. Rule: interactive chips `sm` 12, static
  tag chips (`Chip`, `RecentChip`'s static siblings) `xs` 11.
- Nav tabs already agree: `TabAnchor` (TitleBar) 15 = `NavAnchor` (codex) 15. Good.

### (d) Accessibility floors

- 9px: `TriggerBadge` (informational count), `Unpin` (interactive ✕), `Arrow`
  (decorative sort glyph). All below floor; targets in §3. `Unpin`'s 16px hit area
  is also below the 24px WCAG 2.5.8 target minimum — noted, out of this audit's
  scope.
- 10px `EntryName` is informational text on an interactive tile → raise to 11.
- `HomeMock ToolButton` 10px is interactive but dev-harness-only (mock capture rig).

### Line-height pairing

Declared line-heights are mostly sane (controls at 1, prose at 1.5–1.6) but drift at
the same step: 13px pairs with 1.5 (`Blurb`, `Crashed`), 1.55 (`SubLine`), 1.6
(`RichText Body`); 11px pairs with 1.45 (`ChipButton`), 1.5 (`Chip`), 1.55
(`JsonView`), 1.6 (`Note`). Normalize to the step defaults in §1: body 1.55, prose
1.6, captions 1.5, one-line controls 1. Only the outliers are listed in §3.

---

## 3. Mechanical fix list

One row per change. `Anchor` is a unique snippet near the declaration for relocation
after line drift (another agent is editing codex files concurrently). Rows marked
**[J]** are judgment calls — two steps defensible; the stated target is the
recommendation. Unlisted declarations are already on-scale and need no change.

### src/renderer/src/dashboard/Home.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 301 | `QuietButton` (update-strip dismiss) | `12.5px` → `base` 13px | `const QuietButton = styled.button` → `font-size: 12.5px;` |
| 317 | `RestartButton` (update-strip CTA) | `12.5px` → `base` 13px | `const RestartButton = styled.button` → `font-size: 12.5px;` |
| 342 | `Keys` nested `kbd` (hotkey chip) | `12px` → `xs` 11px | inside `const Keys = styled.div`, the `kbd {` block with `font-family: var(--font-mono)` |

### src/renderer/src/dashboard/HomeMock.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 114 | `ToolButton` (mock-harness control) | `10px` → `xs` 11px — dev-only rig, lowest priority | `const ToolButton = styled.button` → `font-size: 10px;` |

### src/renderer/src/dashboard/HomeScene.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 1413 | `SubLine` (scene sub-caption, 13px) | line-height `1.55` → `1.6` (prose default; size stays `base`) | `const SubLine = styled` → `line-height: 1.55` |

(`Word` clamp = `display`; `StateLine` 17 = `lg`; `CaptionName` 15 = `md`;
`CaptionDetail` 12 = `sm` — all on scale.)

### src/renderer/src/dashboard/Shell.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 85 | `Crashed` nested `strong` (crash-card title) | `14px` → `md` 15px **[J]** (13px defensible; 15 matches codex `ErrorTitle` target — error titles should agree across surfaces) | `const Crashed = styled.div` → `strong {` … `font-size: 14px;` |

### src/renderer/src/dashboard/TitleBar.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 117 | `Brand` (Kreon app wordmark) | `18px` → `xl` 19px **[J]** (17px `lg` also defensible; 19 keeps the brand from ranking below card titles) | `const Brand = styled` → `font-size: 18px;` |

### src/renderer/src/dashboard/ui.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 118 | `RowLabel` (settings row label) | `14px` → `base` 13px **[J]** (15px defensible but overweights every row; weight 600 + ink contrast vs the 12px `RowDesc` carries the hierarchy) | `const RowLabel = styled` → `font-size: 14px;` with `line-height: 1.35` |
| 153 | `Status` (inline status line) | `14px` → `base` 13px | `const Status = styled` → `font-size: 14px;` |

### src/renderer/src/dashboard/JsonView.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 114 | `Root` (JSON dump mono body) | `11px` → `sm` 12px **[J]** (11 defensible for dump density; 12 matches `Logs Body` and ui `Mono` — one mono-body size) and line-height `1.55` → `1.5` | `const Root = styled` → `font-size: 11px;` + `line-height: 1.55` |

### src/renderer/src/dashboard/Settings.tsx

No size changes — `Kbd`/`Code`/`IssueCount`/`SubHead`/`DumpLabel` = `xs`,
`Blurb` = `base`. All on scale.

### src/renderer/src/codex/parts.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 217 | `SegmentButton` (toolbar segmented control) | `12px` → `base` 13px **[J]** (12 defensible for toolbar density; 13 matches dashboard `Button`/`Select`, and the control is the same 34px height) | `const SegmentButton = styled` → `font-size: 12px;` |
| 433 | `TriggerBadge` (filter count badge) | `9px` → `2xs` 10px, keep `line-height: 1` and tabular-nums | `const TriggerBadge = styled.span` → `font-size: 9px;` |
| 723 | `ChipButton` (interactive filter chip) | `11px` → `sm` 12px **[J]** (11 keeps popovers tighter; 12 applies the interactive-chip rule and matches `ChipAnchor`) and line-height `1.45` → `1.5` | `const ChipButton = styled` → `font-size: 11px;` + `line-height: 1.45` |
| 840 | `ErrorTitle` (codex error state title) | `14px` → `md` 15px | `const ErrorTitle = styled` → `font-size: 14px;` |

(`SearchInput` 13, `SearchAffordance` 11, `GroupName` 10 overline, `PopoverNote` 12,
`Chip` 11 static tag, `Empty`/`LoadingLine` 13, `ErrorBody` 12, `CloseButton` 15
glyph, `NavAnchor` 15, `ChipAnchor` 12, `QuietLink` 12 — all on scale.)

### src/renderer/src/codex/MetricsTableView.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 469 | `Arrow` (sort direction glyph) | `9px` → `2xs` 10px | `const Arrow = styled.span` → `font-size: 9px;` near `line-height: 1` |

(`Table` 12 = `sm`, `Th` 11 = `xs`, `ThButton` `font: inherit` reset — keep.)

### src/renderer/src/codex/PinnedRail.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 117 | `Unpin` (✕ button on pinned card) | `9px` → `2xs` 10px glyph floor. Also note: 16px hit area < 24px WCAG 2.5.8 target — flag for a separate pass | `const Unpin = styled.button` (16px circle) → `font-size: 9px;` |

### src/renderer/src/codex/TierListView.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 290 | `EntryName` (entity name on tier board) | `10px` → `xs` 11px — informational text on an interactive tile; matches grid `TileName` | `const EntryName = styled.span` → `font-size: 10px;` with `-webkit-line-clamp: 2` |

(`BadgeLabel`/`BadgeCount` 10 = `2xs`, `Thin` 13 gold marker glyph = `base`,
`Note` 11 = `xs` — on scale.)

### src/renderer/src/codex/tiers.ts

| Line | Element | Change | Anchor |
|---|---|---|---|
| 95 | `TierBadge` `$size='lg'` variant | `20px` → `xl` 19px **[J]** (leaving the component-internal 20 is defensible since it is a single Kreon grade letter; 19 removes the last off-scale value) | `font-size: ${(p) => (p.$size === 'lg' ? '20px'` |

(`md` 15 and `sm` 12 variants already on scale.)

### src/renderer/src/codex/Detail.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 594 | `UpgradeHead` (Kreon "Upgrade" section head) | `13px` → `md` 15px **[J]** (13 defensible if upgrade is subordinate to metrics; 15 makes the two Kreon section heads in the same panel agree with `MetricsTitle`) | `const UpgradeHead = styled` → `font-size: 13px;` with `font-family: var(--font-display)` |
| 669 | `StatValue` (stat number in detail stats) | `16px` → `md` 15px **[J]** (17 `lg` defensible for a hero numeral; 15 + weight + tabular-nums is enough at this panel width) | `const StatValue = styled` → `font-size: 16px;` |

(`Name` 22 = `2xl`, `Id` 11, `NoText` 13, `FlavorWrap` 12, `MetricsTitle` 15,
`MetricsNote` 11, `StatLabel`/`ActLabel` 10 overlines, `ActValue` 11 — on scale.)

### src/renderer/src/codex/KeywordTooltip.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 176 | `BubbleTerm` (Kreon tooltip term) | `14px` → `md` 15px **[J]** (13 defensible to keep tooltips compact; 15 puts it on the minor-title step with the other Kreon heads) | `const BubbleTerm = styled` → `font-size: 14px;` with `font-family: var(--font-display)` |

### src/renderer/src/codex/LibraryView.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 1063 | `RecentChip` (interactive recent-search chip) | `11px` → `sm` 12px **[J]** (interactive-chip rule; 11 defensible if the empty-state pane feels crowded at 12) | `const RecentChip = styled.button` → `font-size: 11px;` |

(`TileName` 11, `RowName` 13, `RowMeta` 11, `PanePrompt` 13, `RecentHead` 10
overline — on scale. The `TileName` 11 vs `RowName` 13 split is the accepted
grid-density exception; document, don't change.)

### src/renderer/src/codex/Compare.tsx

| Line | Element | Change | Anchor |
|---|---|---|---|
| 308–311 | `Description` nested `div { font-size: 12px }` | Redundant — the parent already sets 12px; delete the nested rule (cleanup, no visual change) | `const Description = styled.div` → `div {` … `font-size: 12px;` |

(`HeadTitle` 17 = `lg`, `Candidate` 12, `ColumnName` 15, `RowLine` 12 — on scale.)

### src/renderer/src/codex/RichText.tsx

No change. `Body` 13/1.6 is the prose pairing for `base` — keep.

### src/renderer/src/dashboard/{Logs,UpdateBanner}.tsx

No changes. Logs 13/12 and the UpdateBanner shared `base` css string (11px pill) are
on scale.

**Total: 23 rows** — 21 font-size changes (10 marked [J] with recommendations),
1 line-height-only row (HomeScene `SubLine`; two more rows carry a line-height fix
alongside their size change), 1 cleanup row (Compare nested rule).

---

## 4. Tokenization recommendation

The codebase's established token mechanism is **CSS custom properties declared once
in `src/renderer/src/overlay.css` `:root`** (`--line`, `--fill`, `--ink`,
`--font-body`, `--panel-veil`, …) and consumed inside styled-components as `var(--x)`.
There is no TS design-constants module (`trackerLayout.ts` is overlay-specific layout
math, not a token source), so a TS `fontSizes.ts` would introduce a second convention.

**Recommended: extend the existing `:root` block** with size tokens next to the
`--font-*` family tokens:

```css
/* Type scale. The dashboard body size is --fs-base; the overlay windows keep
   their own zoom-scaled sizes and do not use these. */
--fs-2xs: 10px;
--fs-xs: 11px;
--fs-sm: 12px;
--fs-base: 13px;
--fs-md: 15px;
--fs-lg: 17px;
--fs-xl: 19px;
--fs-2xl: 22px;
/* line-height companions */
--lh-tight: 1.2;
--lh-body: 1.55;
--lh-prose: 1.6;
```

Then each fix-list row becomes `font-size: var(--fs-base);` etc. — regression is
prevented because a grep for `font-size: 1[0-9]` in dashboard/codex should return
zero hits once migrated (easy lint/CI check). The `display` hero clamp stays inline
in `HomeScene.tsx` — it is a one-off scene composition, not a reusable step.

Highest-regression-risk spots that most want tokens first: `ui.tsx` (the shared kit —
12 declarations), `codex/parts.tsx` (16 declarations), and the browse views' entity
names (the three-way drift found in §2b started here).

Optional follow-up (not part of the mechanical list): set
`.dashboard { font-size: var(--fs-base) }` in `overlay.css` so unsized text stops
defaulting to 16px. Audit first — any element currently relying on the inherited
16px would shrink; none were found today, but the WIP branch is moving.
