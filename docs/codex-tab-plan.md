# Codex Tab — Implementation Plan

A new top-level **Codex** tab in the Reliquary dashboard: a full cards / relics / potions
compendium **merged with the meta layer** (tier list + sortable metrics table), at feature
parity with the Overwolf "Spire Codex" app's database + meta experience, restyled in
Reliquary's own design language. Nested views are built on **TanStack React Router**.

Everything in this document was derived from inspecting:
- Reliquary source (`src/renderer/src/dashboard/*`, `src/main/codex/CodexClient.ts`, `src/shared/types.ts`)
- The live spire-codex.com API (verified 2026-08-13)
- The decompiled Spire Codex Overwolf bundle (feature/CSS/state inventory)

---

## 1. Data: what the API provides (all verified live)

Base: `https://spire-codex.com` — JSON, no auth, **15 req/min per endpoint** (already
honored by `CodexClient`'s cooldown map; reuse that pattern).

### Catalogs
| Endpoint | Count | Notable fields |
|---|---|---|
| `GET /api/cards` | 577 | `id, name, description, description_raw, cost, is_x_cost, star_cost, type, rarity, target, color, damage, block, hit_count, powers_applied[], keywords[], vars{}, upgrade{}, upgrade_description, compendium_order, image_url` (sprite), `image_url_card` + `image_url_card_upg` (**full card renders**, `https://cdn.spire-codex.com/cards-full/stable/{id}.webp`) |
| `GET /api/relics` | 296 | `id, name, description, flavor, rarity ("Common Relic"), rarity_key, pool, merchant_price{base,min,max}, image_url, compendium_order` |
| `GET /api/potions` | 63 | `id, name, description, rarity, rarity_key, pool, image_url, compendium_order` |
| `GET /api/characters` | 5 | `id, name, description, starting_hp/gold, max_energy, orb_slots, starting_deck[], starting_relics[], color, image_url` |
| `GET /api/keywords` | — | keyword definitions (for dotted-underline tooltips) |

Catalog endpoints accept `search`, and cards accept `type`, `rarity`, `keyword` server-side.
We fetch **full lists once and filter client-side** (577 rows is nothing), which also powers
instant search.

`image_url` values starting `/static/images/` must be rewritten to
`https://cdn.spire-codex.com/` + path without the `/static/images/` prefix (this is what the
Overwolf app does). Absolute URLs pass through.

### Metrics (the "meta" layer)
| Endpoint | Notes |
|---|---|
| `GET /api/runs/metrics/cards?bracket=&character=` | `{baseline_win_rate, bracket, character, character_runs, character_wins, entity_type, rows[], total_runs}`; rows: `{id, upgraded, score, tier, elo, win_rate, pick_rate, picks, wins, losses, offered, picked, pick_rate_by_act[3]}`. 1040 rows (base + upgraded variants). `character=silent` verified working. |
| `GET /api/runs/metrics/relics?...` | same shape |
| `GET /api/runs/metrics/potions?...` | same shape |
| `GET /api/runs/scores/{cards|relics|potions}?cohort=` | lighter `{id: {score, elo, win_rate, picks}}` map — the tier-list endpoint in the Overwolf app |
| `GET /api/runs/snapshot-status` | `{version, building, built_at}` — cache invalidation gate (already used by `CodexClient.prime()`) |

Cohort/bracket ids used by the Overwolf app: `all, solo, 2p, 3p, 4p, a10, wr30, wr50, wr75, daily`
with labels `All runs, Solo, 2P, 3P, 4P, A10, A10 >30% WR, A10 >50% WR, A10 >75% WR, Daily`.
(`cohort` param is omitted when `all`.) Note: the Overwolf app passes `cohort=` to scores and
metrics; unknown values silently fall back to all — harmless.

### Caching strategy (mirror the Overwolf app; it's good)
- **Disk (userData/codex/compendium/)**: one JSON file per catalog + one per metrics
  (kind × bracket × character). Catalogs valid 7 days AND while `snapshot-status.version`
  is unchanged; metrics valid 30 min (they update with the aggregate snapshot).
- **Memory**: 300 s TTL map in the main process.
- **Stale-while-revalidate**: serve cached immediately, refetch in background, push update
  over IPC when fresh data lands.

---

## 2. Architecture

### 2.1 Main process — `src/main/codex/CompendiumService.ts` (new)
Reuses the HTTP/cooldown/telemetry pattern from `CodexClient` (extract the `json()` helper
into `src/main/codex/http.ts` shared by both, or keep a private copy — extractor's choice,
but do not regress CodexClient's rate-limit handling).

API (all `ipcMain.handle`, i.e. invoke/response, a new pattern in this codebase — wrap with
`telemetry.guard` like the existing `on()` helper in `main/index.ts`):

```ts
// IPC channel constants added to shared/types.ts IPC object:
CodexCatalog:   'spectra:codex-catalog'    // (kind: 'cards'|'relics'|'potions'|'characters'|'keywords') => CatalogPayload
CodexMetrics:   'spectra:codex-metrics'    // ({kind, bracket, character}) => MetricsPayload
CodexRefresh:   'spectra:codex-refresh'    // (kind) => void — force revalidate
CodexPush:      'spectra:codex-push'       // main -> renderer: {key, value} revalidation push
```

Payloads carry `{data, fetchedAt, stale: boolean, apiVersion}` so the UI can show a quiet
"updating…" state. Errors return `{error: string}` — never throw across IPC.

### 2.2 Preload — extend `SpectraApi`
```ts
codexCatalog(kind): Promise<CatalogPayload>
codexMetrics(q: {kind, bracket, character}): Promise<MetricsPayload>
codexRefresh(kind): Promise<void>
onCodexPush(cb): () => void
```

### 2.3 Shared types — `src/shared/codex.ts` (new, re-exported from types.ts)
`CodexCard`, `CodexRelic`, `CodexPotion`, `CodexCharacter`, `CodexKeyword`,
`MetricsRow`, `MetricsPayload`, `CatalogPayload`, `CodexBracket` (union of cohort ids),
`CodexKind = 'cards' | 'relics' | 'potions'`.
Model optional/nullable fields honestly (much of the API is `null`-heavy).

### 2.4 Routing — TanStack Router (replaces react-router-dom)
Add `@tanstack/react-router` (React 18 compatible). Use **hash history**
(`createHashHistory`) — prod loads `file://`, and the existing app already routes by hash.
Code-based route tree (no file-based codegen; electron-vite setup stays untouched).

```
rootRoute
├─ shellRoute  path '/'            → Shell (TitleBar + <Outlet/>)
│   ├─ indexRoute ''               → Home
│   ├─ '/settings'                 → Settings
│   └─ codexRoute '/codex'         → CodexLayout (sub-nav + pinned rail + <Outlet/>)
│       ├─ '' → redirect to '/codex/browse/cards'
│       ├─ '/browse/$kind'         → LibraryView   (kind validated: cards|relics|potions)
│       │    search: { q?, view: 'grid'|'list', sort?, type?, rarity?, keyword?, character?, pool? }
│       ├─ '/browse/$kind/$id'     → LibraryView with detail open (list: side pane; grid: modal)
│       ├─ '/meta'                 → MetaLayout (kind switcher + bracket/character pills + <Outlet/>)
│       │    search: { kind: CodexKind, bracket, character? }
│       │    ├─ '' → redirect '/codex/meta/tiers'
│       │    ├─ '/tiers'           → TierListView
│       │    └─ '/table'           → MetricsTableView
│       │         search adds: { sort?, dir?, color? }
├─ '/overlay/sts2'                 → Sts2Overlay
├─ '/mock/tracker'   (DEV only)    → TrackerMock
├─ '/mock/home/$variant' (DEV)     → HomeMock
└─ '/mock/codex/$view' (DEV, new)  → CodexMock — fixture-driven codex screens for screenshots
```

- `TitleBar` tabs become router `<Link>`s (Home `/`, Codex `/codex`, Settings `/settings`)
  with active state from the router (`useMatchRoute` / Link activeProps). Keep the
  `tab_viewed` telemetry on navigation.
- Shell keeps its per-tab `ErrorBoundary` (wrap the Outlet, keyed by pathname's first segment).
- **All state that defines "what you're looking at" lives in the URL** (validated search
  params) — this is what makes views-within-views shareable/back-button friendly. Ephemeral
  prefs (grid/list default, pins, recents, bracket default) persist to localStorage under
  `reliquary.codex.*` keys.

### 2.5 Renderer data hooks — `src/renderer/src/codex/data.ts`
- Module-level cache (same style as `useIpc.ts` store) keyed by catalog/metrics query.
- `useCatalog(kind)`, `useMetrics(kind, bracket, character)`, `useKeywords()` — each returns
  `{data, loading, error, stale, refresh}` via `useSyncExternalStore`; wire `onCodexPush`.
- Derived joins in selectors: `useLibraryEntries(kind, search)` merges catalog + metrics
  (score/elo/tier per id, non-upgraded row) so grid badges and sort-by-score are one lookup.
  **Gotcha from the Overwolf app worth keeping**: library sort-by-score reads the metrics
  for the *currently selected global bracket*, so changing bracket reorders the library.

---

## 3. UI specification

### 3.0 Visual language — "gray settings styling, but gorgeous"
- Surfaces: the existing quiet warm-gray system — `Section / SectionHead / Panel / Row`
  from `dashboard/ui.tsx`, tokens from `overlay.css` (`--ink`, `--ink-dim`, `--ink-faint`,
  `--line`, `--line-strong`, `--fill`, `--fill-hover`, `--brand` violet, Kreon display).
  NO new color system, NO #16181d port — Spire Codex's *feature set* comes over, its
  skin does not.
- Where the compendium needs richness beyond settings-gray: full-bleed card art grids,
  tier badges, rarity-tinted text, character-tinted pills — use the palettes that already
  exist in the codebase:
  - Tier colors: `TIER_COLORS` in `StatPanels.tsx` (S/A `#7fff00`, B `#2aebbe`,
    C `#efc851`, D `#ffa518`, E/F `#ff5555`) — extract to `src/renderer/src/codex/tiers.ts`
    as the single source, imported by both StatPanels and codex views. Tier badges are
    solid chips with dark text (like the game's grades), `border-radius: 6px`, Kreon.
  - Rarity colors: `rarityColors()` in `overlays/sts2/theme.ts`.
  - Character colors: the `--sts-{char}-primary` custom properties.
- Hard offset shadows (`box-shadow: 5px 5px 0 oklch(0 0 0 / 25%)`) on floating elements
  (modals, hover previews) to match the app's Card primitive.
- Every interactive element: visible `:focus-visible` outline in `--brand`, hover fills
  from `--fill-hover`, `prefers-reduced-motion` respected on all animation.
- Empty/loading/error states are designed, not defaulted: the Reliquary `Spinner` gem for
  loading, an italic `--ink-faint` line for empty ("No matches."), and a Panel row with the
  error + a Retry `Button` for failures.

### 3.1 CodexLayout (`/codex`)
- A slim sub-nav bar under the TitleBar (this is the "views within views" spine):
  `Cards · Relics · Potions │ Meta` — Kreon, active item underlined with a 2px `--brand`
  rule (not the filled-pill style of the top tabs, so hierarchy reads).
- Right side of the sub-nav: global **bracket select** (the Overwolf app's cohort pills as
  a compact `Select` — `All runs, Solo, 2P, 3P, 4P, A10, A10 >30% WR, >50%, >75%, Daily`)
  and **character filter select** (All + the 5 characters). These are codex-wide (search
  params on `/codex`, defaulted from localStorage) — one authority for every score shown.
- Bottom: **pinned rail** — persistent chips (max 24) of pinned cards/relics/potions,
  52–72px art thumbs, click → detail, right-click or ✕ → unpin. Hidden when empty.
- Status whisper (right-aligned, `--ink-faint`, 11px): `"community data · {total_runs}
  runs · updated {relative}"` from the metrics payload; shows the Spinner gem while stale.

### 3.2 LibraryView (`/codex/browse/$kind`)
Toolbar (single row, wraps):
- **Search input**: placeholder `Search {kind}…  ( / )`; `/` focuses from anywhere in the
  codex tab; Escape clears then blurs; 150–200 ms debounce into the `q` search param.
  Matches name + id + description (case-insensitive substring; rank prefix > word-boundary
  > substring > description-only, same as the quick-peek ranking).
- **View toggle**: Grid ⧉ / List ☰ segmented control → `view` param + localStorage default.
- **Sort select**: `Name A–Z, Name Z–A, Score ↓, Score ↑, Elo ↓, Elo ↑, Win rate ↓,
  Compendium order` (score/elo/win-rate available for all three kinds — we have metrics
  for relics and potions too, which the Overwolf app only wired for cards. Parity-plus.)
  Nulls always sink; name tiebreak.
- **Filters** (kind-specific, all in URL):
  - cards: Type `Attack|Skill|Power|Status|Curse`, Rarity `Basic|Common|Uncommon|Rare|
    Ancient|Token`, Keyword `Exhaust|Innate|Ethereal|Retain|Unplayable|Sly|Eternal`,
    Character (6 colors incl. colorless).
  - relics: Rarity (from `rarity_key`), Pool (shared + per-character).
  - potions: Rarity, Pool.
- Result count line: `"{n} of {total} {kind}"` in `--ink-faint`.

**Grid mode**:
- cards: full card renders (`image_url_card`), `repeat(auto-fill, minmax(200px, 1fr))`,
  `aspect-ratio: 400/520`, `content-visibility: auto` (+ `contain-intrinsic-size`) for
  scroll perf, hover `transform: scale(1.03)` + drop-shadow, small tier badge chip
  top-right overlay when metrics exist. `loading="lazy"` + async decode on all art.
- relics/potions: sprite tiles `minmax(120px, 1fr)`, art centered on a `--fill` rounded
  square, name under, rarity-tinted, tier chip corner.
- Click → navigate to `/browse/$kind/$id` (modal detail over the grid).
- Hover → prefetch the full-size art (`new Image()`, module-level dedupe Set).

**List mode**: two columns `minmax(220px, 280px) 1fr`; left = virtual-friendly list rows
(name + tiny meta line: cards `type · rarity · color`, relics/potions `rarity · pool`,
tier chip right-aligned); right = detail pane (`/browse/$kind/$id` renders here in list
mode). ↓/↑ move selection (scrollIntoView nearest), Enter opens, list keeps URL in sync.

### 3.3 Detail (pane in list mode, modal over grid — one component)
- Header: name (Kreon, 22px, `--brand`), id whisper in mono, Pin button (`☆ Pin ⇄ ★ Pinned`),
  Compare button (cards + relics), `✕`/Escape for modal.
- Art: cards show **Base | Upgraded** toggle rendering `image_url_card` /
  `image_url_card_upg` (preload the other variant on toggle-hover); relics/potions show
  the sprite large on a `--fill` plate.
- **Rich description renderer** (`codex/RichText.tsx`): parse the API's BBCode-ish markup —
  `[gold]`, `[blue]`, `[red]`, `[green]`, `[purple]`, `[orange]`, `[pink]`, `[aqua]`
  (map to the existing `--sts-color-*` tokens), newlines to `<br/>`. Keyword terms
  (matched against `/api/keywords`) get dotted underline + hover/focus tooltip (fixed-pos,
  280px, panel-styled, flips below when clipped). Escape/blur dismisses. Strip unknown tags
  rather than rendering them.
- Upgrade description shown under the base description with the delta values in
  `--sts-color-green` (the "green parens" convention).
- **Metrics block** (`codex-metrics` equivalent): tier badge + labeled values —
  Score, Elo (cards), Win rate, Pick rate, Sample (abbreviated ≥1000 → `1.2k` — reuse
  `fmtCount` logic), confidence whisper (`high/med/low` from picks, reuse
  `confidenceFor` thresholds 2000/300), and **TRAP index** when |z| divergence exists
  (`overdrafted` / `sleeper` chip — Reliquary's own concept, surfaced from
  `CodexClient.trapIndex` math re-computed renderer-side from the metrics distribution).
  Per-act pick rates as three mini bars labeled A1 A2 A3.
- Kind extras: cards — cost/energy, target, damage/block/hit_count and `powers_applied`
  chips; relics — flavor text (italic, `--ink-dim`) + merchant price range; potions — pool.
- Footer cross-links: `View in tier list →` (navigates `/codex/meta/tiers?kind=…` and
  scroll-highlights the entry), `View on spire-codex.com ↗` via `openExternal`
  (add `https://spire-codex.com` to the main-process allow-list).

### 3.4 Compare modal (cards + relics)
- `⇄ Compare` opens a modal (max-width 680px, Panel-styled, offset shadow): search field
  over the **local catalog cache only**, candidate grid `minmax(150px, 1fr)`, pick →
  2-col compare grid: art, metrics rows side by side, description under. Cards get a
  Base/Upgraded toggle applying to both sides. Empty state: `"No matches in cache yet."`

### 3.5 MetaLayout (`/codex/meta`) — the merged meta home
- Kind switcher: `Cards · Relics · Potions` segmented (search param `kind`).
- Sub-tabs: **Tier list** | **Table** (routes).
- Inherits the codex-wide bracket + character selection; shows the summary line:
  `"{bracket label} · {total_runs} runs · baseline win rate {baseline}% · {n} shown"`.

### 3.6 TierListView (`/codex/meta/tiers`)
- Thresholds (from the Overwolf app): S ≥90 `Top tier`, A ≥78 `Strong`, B ≥65 `Solid`,
  C ≥50 `Average`, D ≥35 `Weak`, F <35 `Avoid`. Score source: metrics `score`
  (non-upgraded rows).
- Each tier: 56px badge column (tier chip, big Kreon letter, label under in 10px) + a
  wrapped entry grid. Cards render as mini card art (140px, full render); relics/potions
  as 64px sprite chips with name. Entries sorted by score desc within tier; click →
  detail route; hover → floating full-art preview (170×230, flips at viewport edge).
- Entries under a sample threshold (picks < 300) get a low-confidence dot + tooltip
  rather than being hidden.

### 3.7 MetricsTableView (`/codex/meta/table`)
- Sticky-header table, `tabular-nums`, right-aligned numeric columns, row hover fill,
  sorted column tinted `--brand`, sort arrows ▾/▴, `descFirst` on numerics.
- Columns (cards): `#`, Card (name, character-tinted), Tier (chip), Score, Elo, Win%,
  Pick%, Seen, Runs, A1, A2, A3, W-L. Relics/potions drop Elo + acts (keep Win%/Pick%/
  Seen/Runs/W-L). Tooltips on every header (`title=`) with the exact definitions:
  Score = "Codex Score (0–100, Bayesian-shrunk win rate)", Elo = "revealed preference
  from card-reward picks", etc.
- **Upgraded toggle**: `Base | Upgraded | Both` pill — the rows include upgraded variants
  (`upgraded: true`, rendered as `Name+`).
- Color filter pills (cards): 6 character colors + Curse, tinting and filtering rows.
- Nulls render `·`; percentages `toFixed(1)%`; counts `toLocaleString()`.
- Hover on a name: floating art preview (shared component with tier list).
- Click row → detail route for that entity.
- Below-fold footnote block: the Score/Elo definitions written out (mirrors the Overwolf
  About text) so numbers are never unexplained.

### 3.8 Home touchpoint (small, optional if time allows)
One `Card` on Home: "Codex" teaser — 3 top-tier cards of the week (top score, bracket
default) as mini art + a `Browse the Codex →` link. Keeps the new tab discoverable.

---

## 4. What we are NOT porting (explicit non-goals)
- Monsters / events / powers / encounters / glossary / mechanics / unlocks views
  (user scoped: cards, relics, potions).
- Run history upload, Steam auth, presence/live, leaderboards, news/guides, ads,
  Discord RPC, beta channel, i18n, guided tour.
- Quick-peek window (separate window; a future follow-up — the search ranking logic in
  LibraryView is written as a pure function so it can be reused for it later).

---

## 5. Implementation phases (agent work packages)

### Phase A — data spine (main + preload + shared)
Files: `src/shared/codex.ts` (new), `src/shared/types.ts` (IPC additions + SpectraApi),
`src/main/codex/CompendiumService.ts` (new), `src/main/codex/http.ts` (extracted),
`src/main/index.ts` (wire service + handle()s + allow-list spire-codex.com),
`src/preload/index.ts`.
Acceptance: `npm run typecheck` clean; `SPECTRA_DEBUG=1` dev run logs a successful
catalog fetch + disk cache files appear in userData; second launch serves from disk.

### Phase B — router migration
Files: `package.json` (+`@tanstack/react-router`, react-router-dom stays installed until
this phase removes its imports, then drop the dep), `src/renderer/src/main.tsx`,
`App.tsx` → route tree, `dashboard/Shell.tsx`, `dashboard/TitleBar.tsx` (tabs → Links,
add Codex tab), keep `/mock/*` dev routes working.
Acceptance: typecheck clean; dev app boots; Home/Settings navigation works; overlay
window still renders `#/overlay/sts2`; mock harnesses reachable in dev.

### Phase C — codex feature UI (depends on A + B)
Files (all new under `src/renderer/src/codex/`): `CodexLayout.tsx`, `LibraryView.tsx`,
`Detail.tsx`, `RichText.tsx`, `KeywordTooltip.tsx`, `Compare.tsx`, `MetaLayout.tsx`,
`TierListView.tsx`, `MetricsTableView.tsx`, `ArtPreview.tsx`, `PinnedRail.tsx`,
`tiers.ts`, `data.ts`, `prefs.ts` (localStorage), `search.ts` (ranking), `routes.tsx`
(codex subtree, imported by App).
Plus: `StatPanels.tsx` imports TIER_COLORS from `codex/tiers.ts`.
Acceptance: typecheck clean; every route renders with live data; keyboard nav, pins,
compare, tooltips functional.

### Phase D — mock harness + polish (depends on C)
`/mock/codex/$view` fixture-driven screens (canned catalog + metrics JSON in
`src/renderer/src/codex/fixtures.ts`, ~12 cards / 6 relics / 4 potions with real CDN
URLs) covering: browse-grid, browse-list+detail, meta-tiers, meta-table, compare.
Telemetry: `tab_viewed {tab:'codex'}`, `codex_view {view}`, `codex_detail {kind}`.
Empty/error/loading passes, reduced-motion pass, focus-visible pass.

### Verification (main session, not agents)
`npm run typecheck` → kill any running dev instance → `npm run dev` (SPECTRA_STUB
irrelevant; codex needs network only) → offscreen `capturePage` screenshots of the real
dashboard on each codex route + the mock routes → visual parity review against the
Spire Codex feature checklist → iterate. **Relaunch the app after every main-process
fix** (main doesn't hot-reload).

## 6. Parity checklist (from the Spire Codex bundle inventory)
- [ ] Search with `/` focus shortcut, Escape clear, debounce
- [ ] Grid/List toggle, persisted
- [ ] Sort: name both ways + score/elo (nulls sink)
- [ ] Cards: type/rarity/keyword/character filters
- [ ] Relics/potions: rarity/pool filters
- [ ] Full card renders incl. upgraded variant, CDN-sourced, lazy, hover-prefetch
- [ ] Detail: rich text with color markup + keyword tooltips
- [ ] Detail: metrics badges (score/elo/win/pick/sample + confidence)
- [ ] Per-act pick-rate bars
- [ ] TRAP (overdrafted/sleeper) chip — Reliquary exclusive
- [ ] Relic flavor + merchant price — parity-plus (Overwolf app shows flavor only)
- [ ] Tier list S–F with exact thresholds + labels, art entries, hover preview
- [ ] Metrics table: all columns incl. A1–A3 + W-L, sticky header, sortable, tooltips
- [ ] Upgraded-variant rows (Base/Upgraded/Both) — parity-plus over the table's default
- [ ] Bracket cohorts (10) + character filter, one global authority
- [ ] Summary line (runs · baseline · shown)
- [ ] Pin rail (24 max) + recents (10 max)
- [ ] Compare modal with base/upgraded toggle
- [ ] Keyboard: /, ↓↑, Enter, Escape everywhere
- [ ] Empty/loading/error states designed
- [ ] SWR caching: instant paint from disk, background revalidate
