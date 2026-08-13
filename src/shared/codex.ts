/**
 * The spire-codex.com compendium domain model, shared by main, preload and
 * renderer.
 *
 * Two naming conventions live side by side here on purpose:
 *   - Anything that comes straight off the API keeps the API's `snake_case`
 *     spelling. Renaming 40 fields on the way through would buy nothing but a
 *     translation layer to keep in sync, and it would make the shapes here
 *     un-greppable against a live response.
 *   - Anything Reliquary invents (the payload envelope, cache keys) uses the
 *     codebase's `camelCase`.
 *
 * Nullability is modelled from a live capture (2026-08-13, snapshot v22), not
 * from the docs: the API is genuinely null-heavy. `elo` and `pick_rate` are
 * null for *every* row in the relics/potions tables and in every
 * character-filtered card table; half of a card's own fields are null for any
 * given card. Typing those as `number` would be a lie the UI pays for.
 */

// ── kinds ────────────────────────────────────────────────────────────────────

/** The three entity families that have both a catalog AND a metrics table. */
export type CodexKind = 'cards' | 'relics' | 'potions'

/** Everything fetchable as a flat list. Characters/keywords have no metrics. */
export type CodexCatalogKind = CodexKind | 'characters' | 'keywords'

// ── cohorts ──────────────────────────────────────────────────────────────────

/**
 * The run cohorts the metrics tables can be sliced by. Ids are what the API
 * expects in `?bracket=`; labels are what the Overwolf app shows. Unknown ids
 * silently fall back to `all` server-side, so a stale persisted preference
 * degrades to "all runs" rather than an error.
 */
export const CODEX_BRACKETS = [
  { id: 'all', label: 'All runs' },
  { id: 'solo', label: 'Solo' },
  { id: '2p', label: '2P' },
  { id: '3p', label: '3P' },
  { id: '4p', label: '4P' },
  { id: 'a10', label: 'A10' },
  { id: 'wr30', label: 'A10 >30% WR' },
  { id: 'wr50', label: 'A10 >50% WR' },
  { id: 'wr75', label: 'A10 >75% WR' },
  { id: 'daily', label: 'Daily' }
] as const

export type CodexBracket = (typeof CODEX_BRACKETS)[number]['id']

export const DEFAULT_BRACKET: CodexBracket = 'all'

/** Label for a bracket id, falling back to the id itself for unknown values. */
export function bracketLabel(id: string): string {
  return CODEX_BRACKETS.find((b) => b.id === id)?.label ?? id
}

/** Narrowing guard for values arriving from a URL search param or localStorage. */
export function isCodexBracket(v: unknown): v is CodexBracket {
  return typeof v === 'string' && CODEX_BRACKETS.some((b) => b.id === v)
}

// ── catalogs ─────────────────────────────────────────────────────────────────

/** One entry of a card's `powers_applied` array. */
export interface CodexPowerApplied {
  power: string | null
  power_key: string | null
  amount: number | null
}

/**
 * A card as `/api/cards` returns it (577 rows).
 *
 * `description` is pre-substituted BBCode-ish markup (`[gold]Thorns[/gold]`)
 * while `description_raw` keeps the `{ThornsPower:diff()}` placeholders — the
 * UI wants the former; the latter is kept because it is the only place the
 * variable *names* survive, which is what makes the upgrade delta explicable.
 */
export interface CodexCard {
  id: string
  name: string
  description: string | null
  description_raw: string | null
  cost: number | null
  is_x_cost: boolean | null
  is_x_star_cost: boolean | null
  star_cost: number | null
  /** Display form, e.g. "Power". */
  type: string | null
  /** Stable form for filtering; equal to `type` today but not contractually. */
  type_key: string | null
  rarity: string | null
  rarity_key: string | null
  /** "Self" | "Enemy" | "AllEnemies" | … */
  target: string | null
  /** Character colour: ironclad | silent | defect | regent | necrobinder | colorless. */
  color: string | null
  damage: number | null
  block: number | null
  hit_count: number | null
  powers_applied: CodexPowerApplied[] | null
  cards_draw: number | null
  energy_gain: number | null
  hp_loss: number | null
  keywords: string[] | null
  keywords_key: string[] | null
  tags: string[] | null
  spawns_cards: string[] | null
  /** Substitution table behind `description_raw`; values are numbers today. */
  vars: Record<string, number> | null
  /**
   * Upgrade deltas keyed by lower-cased var name, e.g. `{thornspower: "+2"}`.
   * Flag-ish deltas arrive as bare numbers (`{remove_ethereal: 1}`,
   * `{description_changed: 1}`), so values are string | number.
   */
  upgrade: Record<string, string | number> | null
  upgrade_description: string | null
  /** Sprite; site-relative (`/static/images/…`) — run it through `codexImageUrl`. */
  image_url: string | null
  beta_image_url: string | null
  type_variants: unknown
  can_be_generated_in_combat: boolean | null
  multiplayer_only: boolean | null
  compendium_order: number | null
  sources: unknown
  /** Full card render (absolute CDN URL), and its upgraded twin. */
  image_url_card: string | null
  image_url_card_upg: string | null
}

/** Gold cost band a merchant will ask for a relic. */
export interface CodexMerchantPrice {
  base: number | null
  min: number | null
  max: number | null
}

/** A relic as `/api/relics` returns it (296 rows). */
export interface CodexRelic {
  id: string
  name: string
  description: string | null
  description_raw: string | null
  /** In-world flavour line; also BBCode-ish. */
  flavor: string | null
  /** Display form, e.g. "Uncommon Relic". */
  rarity: string | null
  /** Bare form, e.g. "Uncommon" — filter on this, not `rarity`. */
  rarity_key: string | null
  /** "shared" or a character id. */
  pool: string | null
  merchant_price: CodexMerchantPrice | null
  image_url: string | null
  image_variants: unknown
  name_variants: unknown
  notes: string | null
  compendium_order: number | null
}

/** A potion as `/api/potions` returns it (63 rows). */
export interface CodexPotion {
  id: string
  name: string
  description: string | null
  description_raw: string | null
  rarity: string | null
  rarity_key: string | null
  pool: string | null
  image_url: string | null
  compendium_order: number | null
}

/**
 * A playable character as `/api/characters` returns it (5 rows).
 *
 * The response also carries `quotes` and `dialogues` (several KB of ancient
 * banter per character). They are typed loosely rather than dropped: we cache
 * the response verbatim, and pretending fields we don't read don't exist is how
 * a cache file and its type quietly diverge.
 */
export interface CodexCharacter {
  id: string
  name: string
  description: string | null
  starting_hp: number | null
  starting_gold: number | null
  max_energy: number | null
  orb_slots: number | null
  /** Card ids, with duplicates — it is a deck list, not a set. */
  starting_deck: string[] | null
  starting_relics: string[] | null
  unlocks_after: string | null
  gender: string | null
  color: string | null
  /** Hex without the leading `#`. */
  dialogue_color: string | null
  quotes: Record<string, string> | null
  dialogues: unknown
  image_url: string | null
  animation_url: string | null
}

/** A keyword definition from `/api/keywords`, for the dotted-underline tooltips. */
export interface CodexKeyword {
  id: string
  name: string
  description: string | null
}

/** Which row type each catalog endpoint yields. */
export interface CodexCatalogMap {
  cards: CodexCard[]
  relics: CodexRelic[]
  potions: CodexPotion[]
  characters: CodexCharacter[]
  keywords: CodexKeyword[]
}

// ── metrics ──────────────────────────────────────────────────────────────────

/**
 * One row of a metrics table. Cards appear twice (base + upgraded); relics and
 * potions only ever as `upgraded: false`.
 *
 * `elo` is the revealed-preference number derived from card-reward picks, so it
 * only exists where pick events do: it is null for every relic/potion row and
 * for every row of a character-filtered card table. `pick_rate` is likewise
 * null throughout the current snapshot, and `pick_rate_by_act` is a fixed
 * three-slot array whose entries are individually nullable.
 */
export interface MetricsRow {
  id: string
  upgraded: boolean
  /** Codex Score, 0–100 (Bayesian-shrunk win rate). */
  score: number | null
  /** Letter grade S–F. */
  tier: string | null
  elo: number | null
  /** Percentage, already ×100 (e.g. 41.6). */
  win_rate: number | null
  pick_rate: number | null
  picks: number | null
  wins: number | null
  losses: number | null
  offered: number | null
  picked: number | null
  /** [act1, act2, act3]; the array is present even when every entry is null. */
  pick_rate_by_act: Array<number | null> | null
}

/** A whole metrics table plus the cohort context that gives its numbers meaning. */
export interface MetricsTable {
  entity_type: string
  /** Echoed back by the API — may differ from what was asked for. */
  bracket: string | null
  /** Echoed back UPPER-CASED (`silent` → `SILENT`); null when unfiltered. */
  character: string | null
  /** Percentage, ×100. The number every win rate must be read against. */
  baseline_win_rate: number | null
  total_runs: number | null
  character_runs: number | null
  character_wins: number | null
  rows: MetricsRow[]
}

/** What identifies one metrics table: kind × cohort × character. */
export interface MetricsQuery {
  kind: CodexKind
  bracket: CodexBracket
  /** Character id, or null/'all' for every character. */
  character?: string | null
}

// ── payload envelope ─────────────────────────────────────────────────────────

/**
 * Everything the compendium hands back is wrapped in this. `stale` is the
 * honest half of stale-while-revalidate: the data is real and usable, but a
 * refresh is already in flight, so the UI can whisper "updating…" instead of
 * either lying about freshness or blanking the screen.
 */
export interface CodexData<T> {
  data: T
  /** Epoch ms the cached copy was fetched. */
  fetchedAt: number
  stale: boolean
  /** API aggregate snapshot version this copy was built from; null if unknown. */
  apiVersion: number | null
  error?: undefined
}

/**
 * A failure. It is *returned*, never thrown: a rejected `invoke` crosses the
 * bridge as an opaque "Error invoking remote method" string that names the
 * channel instead of the problem, and every caller would have to re-wrap it.
 */
export interface CodexFailure {
  error: string
  data?: undefined
}

export type CodexPayload<T> = CodexData<T> | CodexFailure

export type CatalogPayload<K extends CodexCatalogKind = CodexCatalogKind> = CodexPayload<
  CodexCatalogMap[K]
>

export type MetricsPayload = CodexPayload<MetricsTable>

/** A background revalidation landing, main -> renderer. */
export interface CodexPushMessage {
  /** A cache key from `catalogCacheKey` / `metricsCacheKey`. */
  key: string
  value: CodexPayload<unknown>
}

// ── cache keys ───────────────────────────────────────────────────────────────
//
// Computed by a pure function on both sides of the bridge so a push can be
// matched to the request that wants it without inventing a second identity
// scheme for the renderer's store.

export function catalogCacheKey(kind: CodexCatalogKind): string {
  return `catalog:${kind}`
}

export function metricsCacheKey(q: MetricsQuery): string {
  return `metrics:${q.kind}:${q.bracket}:${normalizeCharacter(q.character) ?? 'all'}`
}

/** Lower-case, or null for "every character". The API echoes it upper-cased. */
export function normalizeCharacter(character: string | null | undefined): string | null {
  if (!character) return null
  const c = character.trim().toLowerCase()
  return c && c !== 'all' ? c : null
}

// ── image URLs ───────────────────────────────────────────────────────────────

const CODEX_ORIGIN = 'https://spire-codex.com'
const CODEX_CDN = 'https://cdn.spire-codex.com'
const STATIC_PREFIX = '/static/images/'

/**
 * Resolve an `image_url` from the API to something a renderer can load.
 *
 * The API serves art paths as `/static/images/cards/abrasive.webp`, but the
 * site itself never fetches them from that origin — they are on a CDN with the
 * `/static/images/` segment stripped. Pointing an `<img>` at the raw value gets
 * you a `file://` miss in production, which is why this lives in `shared/`: the
 * renderer needs it as badly as main does, and it must be the same function.
 *
 * Absolute URLs (the `image_url_card` full renders are already CDN-absolute)
 * pass through untouched.
 */
export function codexImageUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('//')) return trimmed
  if (trimmed.startsWith(STATIC_PREFIX)) {
    return `${CODEX_CDN}/${trimmed.slice(STATIC_PREFIX.length)}`
  }
  // Some other site-relative path. Serve it from the site rather than guessing
  // at a CDN layout we haven't seen.
  return trimmed.startsWith('/') ? `${CODEX_ORIGIN}${trimmed}` : `${CODEX_ORIGIN}/${trimmed}`
}
