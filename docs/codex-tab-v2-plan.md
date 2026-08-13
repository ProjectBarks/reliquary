# Codex Tab v2 — Meta merge + toolbar redesign

Follow-up to docs/codex-tab-plan.md, from user review of the built tab. Two themes:
**(1) Meta stops being a place and becomes two more ways to view a kind**, and
**(2) the browse toolbar collapses to one aligned row of icon controls with popovers.**
Plus a set of point fixes. Branch: `feature/codex-tab-v2` (off `feature/codex-tab`).

---

## 1. Meta merge: modes, not tabs

Today: sub-nav `Cards · Relics · Potions │ Meta`, and Meta has its own kind
switcher + `tiers`/`table` child routes. That doubles the "which kind am I looking
at" control and splits one mental model across two places.

Target: sub-nav is just `Cards · Relics · Potions`. Each kind has **four view
modes**: **Grid, List, Tier, Table** — a single icon-only segmented control.

### Routing
- `mode: 'grid' | 'list' | 'tier' | 'table'` becomes a validated search param on
  `browse/$kind` (default from `prefs`, replacing the old `view` pref; migrate the
  stored `'grid'|'list'` value into the new key so nobody's default resets).
- The `meta` route subtree and `MetaLayout` are **deleted**. Compat redirects (old
  URLs may live in recents/muscle memory):
  - `/codex/meta` and `/codex/meta/tiers` → `/codex/browse/$kind?mode=tier`
  - `/codex/meta/table` → `/codex/browse/$kind?mode=table`
  - `kind` from the old meta search param (default cards); carry `bracket`,
    `character`, `highlight`, and table sort params through.
- `highlight` (tier-list scroll target) moves onto the browse route's search.
- Detail's "View in tier list →" navigates to `?mode=tier&highlight={id}` for its
  kind. CodexMock's `tiers`/`table` views point at the new URLs.

### Nothing from Meta may be lost (user: "it's really polished")
Carry over into the modes, scoped to the route's kind:
- **Tier mode** (TierListView): S–F bands with thresholds/labels, full-art card
  entries / sprite chips, score-desc order within band, low-sample dots,
  "Unrated" band, highlight-and-scroll, hover ArtPreview, click → detail.
- **Table mode** (MetricsTableView): summary line (`{bracket} · {runs} runs ·
  baseline {pct}% · {n} shown`), sticky sortable headers (descFirst numerics,
  ▾/▴, sorted header in `--brand`), tabular-nums, tier chips,
  Base|Upgraded|Both pill (cards), character-tinted names, `·` for nulls, row
  hover ArtPreview, row click → detail, footnote definitions block.
- The bracket + character selects stay in the CodexLayout header — they already
  govern every mode.
- The table's **color pill row is retired**; its job moves to the filter popover
  (§2), which applies to ALL modes — filtering the table by colour must still
  work exactly as the pills did.

## 2. Toolbar redesign: one row, icons, popovers

The misalignment bug: search + Grid/List have no label above them while
SORT/RARITY/POOL selects carry small uppercase labels, so controls sit on
different baselines (user screenshot). Rather than aligning labels, the labels
go away:

```
[ 🔍 Search {kind}…  (/)          ] [▦│☰│▤│⊞]  [↕]  [⛉]
   flex search input                view modes  sort  filter
```

One `Toolbar` row, every control the same 34px height (`dashboard/ui.tsx`
Button height), vertically centered, consistent across Cards/Relics/Potions and
across all four modes.

- **View segmented, icon-only**: grid ▦, list ☰, tier (podium/trophy), table
  (rows). Inline SVGs drawn in the app's 1.4px-stroke icon style (see TitleBar's
  window-control SVGs) — not emoji. Each button: `aria-label`, `title`, 34×34px,
  active state = `--brand` fill like the current segmented.
- **Sort button** (icon ↕): opens a **popover** listing the mode's sort options
  as a radio group (grid/list: Name A–Z/Z–A, Score, Elo (cards), Win rate,
  Compendium order). Hidden in tier mode (fixed order) and table mode (column
  headers sort). Badge dot when non-default.
- **Filter button** (icon funnel): opens a **popover** containing every filter
  group for the kind — cards: Type, Rarity, Keyword, Colour; relics/potions:
  Rarity, Pool. Groups render as label + wrapped option chips (single-select per
  group + "Any"). The button shows an active-count badge. Applies to all four
  modes (table colour filtering included).
- **Popover primitive** (new, in `parts.tsx`): panel-styled surface (hairline
  border, offset shadow), anchored under its button, flips at viewport edge,
  closes on Escape/outside click/selection where single-select, participates in
  the existing `useTransientLayer` Escape stack, focus returns to the button.
  `aria-expanded`/`aria-haspopup` on the trigger.

### Zero-result filter options are hidden
User: Curse/Event/Quest/Status/Token pills often show nothing. Rule: a filter
option that would produce **zero results given the current catalog + metrics
data** (and, for the table, zero metric rows) is not rendered. Compute counts
from the loaded catalog per option; hide zero-count options entirely (don't
disable — a dead chip is clutter). If the data hasn't loaded yet, render nothing
rather than a flash of soon-to-vanish chips.

## 3. Point fixes

1. **Delete the header whisper** (`community data · N runs · baseline … ·
   updated …`) from CodexLayout. The table mode's summary line already carries
   these numbers where they matter. The stale/Spinner indicator can sit quietly
   on the bracket select's edge if trivial, or go entirely — no text line.
2. **A1/A2/A3 columns**: they are **pick rate by act** (`pick_rate_by_act[3]`,
   verified live: present on base rows at bracket level, ALL null when a
   character filter is active). Fix: headers become `Act 1 / Act 2 / Act 3`
   with title "Pick rate when offered in Act N"; the three columns are
   **omitted entirely** when every visible row is null (character-filtered), so
   the table never shows a wall of `·`. Detail's per-act bars get the same
   labels ("Act 1" not "A1") and hide when all-null.
3. **Delete every "View on spire-codex.com" link** (Detail footer; grep for
   others). The main-process allow-list can stay (harmless, one less thing to
   churn).
4. **List view thumbs**: cards in list rows must render the **full card frame**
   (`image_url_card`, aspect 400/520, ~44px wide) instead of the square art
   crop — grid and tier already use the framed render; list is the odd one out.
   Relics/potions keep their sprite thumbs (they have no framed variant).
5. **List view hover preview**: reuse the shared `ArtPreview` (170×230,
   edge-flipping) on list-row hover, exactly like the metrics table rows — the
   list thumb is too small to read.

## 4. Files touched (all renderer, `src/renderer/src/codex/` unless noted)

| File | Change |
|---|---|
| `routes.tsx` | mode param on browse; delete meta subtree; compat redirects |
| `params.ts` | `mode` validation; `highlight` + table sort params move to browse; drop meta validators |
| `prefs.ts` | `view` pref → `mode` pref (migrate stored value) |
| `CodexLayout.tsx` | drop Meta link + whisper; sub-nav = 3 kinds |
| `LibraryView.tsx` | new toolbar (icons + popovers); render Tier/Table modes; list thumbs + hover preview |
| `MetaLayout.tsx` | **deleted** |
| `TierListView.tsx` / `MetricsTableView.tsx` | read kind/params from browse route; table drops pill row, gains filter integration, act-column rename/auto-hide |
| `Detail.tsx` | remove spire-codex link; "View in tier list" → mode URL; act bar labels |
| `parts.tsx` | `Popover` primitive + icon set |
| `CodexMock.tsx` / `fixtures.ts` | mock views follow the new URLs |

Nothing under `src/main/**`, `src/preload/**`, `src/shared/**` changes.

## 5. Acceptance
- `npm run typecheck` + `npx electron-vite build` clean; no fixture strings in prod bundle.
- Toolbar: single row, all controls 34px, aligned — screenshot-verified on all
  three kinds × four modes (capture rig routes).
- Old `/codex/meta/*` URLs land on the equivalent mode view.
- Every Meta feature demonstrably present in tier/table modes (checklist §1).
- No zero-result filter options anywhere; no A1–A3 walls of `·`; no
  spire-codex.com buttons; framed card thumbs + hover preview in list mode.
