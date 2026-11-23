/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Sts2CardData, Sts2CardInfo } from '@shared/types'
// Type-only on purpose. This module is main-process code; the forked reader
// must not import any value from it, or the bundler hoists the shared code into
// a chunk inside app.asar that the unpacked reader cannot load (the build's
// `reader-self-contained` check enforces this).
import type { RawCardMeta } from './readers'

export type { RawCardMeta }

/**
 * Static card metadata (name, type, colour, rarity, printed cost) from the
 * sources we can reach, merged into the one `Sts2CardData` map the renderer
 * draws from.
 *
 * There used to be exactly one source: Untapped's sts2json CDN, keyed by the
 * running build, with `public/latest` behind it. Untapped stopped publishing
 * new builds after v0.107.1 and took `latest` down, so on any newer build both
 * URLs 404 and every card renders as a raw id with a "?" cost. Three sources
 * now, in the order that best matches the build actually running:
 *
 *   1. Untapped, exact build: authoritative when it exists.
 *   2. Spire Codex's card catalog: tracks the current game, so on a build
 *      Untapped never published it is the closer match (it carries the newer
 *      cards and the later rarity/star-cost changes that v0.107.1 predates).
 *   3. Untapped, newest build it still serves: fills ids Codex lacks.
 *
 * Whatever none of them know (a character newer than every catalog) is
 * synthesized from the game's own memory by `synthesizeCardInfo`.
 */

/** Untapped builds still served, newest first. Probed 2026-11-22. */
export const UNTAPPED_FALLBACK_BUILDS = ['v0.107.1']

export const untappedUrl = (path: string): string =>
  `https://sts2json.untapped.gg/data/${path}/sts_data.json`

export interface UntappedPayload {
  cards: Sts2CardInfo[]
  relics?: Array<{ id?: string; name?: string }>
  potions?: Array<{ id?: string; name?: string }>
}

export function isUntappedPayload(data: unknown): data is UntappedPayload {
  return !!data && Array.isArray((data as any).cards)
}

/** Untapped's cards, keyed by id. Its entries already have our shape. */
export function cardsFromUntapped(data: UntappedPayload): Sts2CardData {
  const map: Sts2CardData = {}
  for (const card of data.cards) {
    const id = (card as any)?.id
    if (typeof id === 'string' && id) map[id] = card
  }
  return map
}

/** Relic and potion display names from an Untapped payload. */
export function namesFromUntapped(data: UntappedPayload): Record<string, string> {
  const names: Record<string, string> = {}
  for (const list of [data.relics, data.potions]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) if (entry?.id && entry.name) names[entry.id] = entry.name
  }
  return names
}

/**
 * One Codex catalog row in Untapped's shape.
 *
 * Codex encodes costs as numbers with sentinels where Untapped uses strings:
 * `is_x_cost` for "X", and a negative cost for unplayable cards (curses,
 * statuses), which Untapped writes as "". `upgrade` holds only what changes,
 * so an upgrade that leaves the cost alone has no `cost` key; Untapped repeats
 * the base cost there, and `resolveCost` reads `upgrade.cost` for any upgraded
 * card, so the base cost is carried over rather than left blank.
 */
export function codexCardToInfo(row: any): Sts2CardInfo | null {
  if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string') return null
  const cost = row.is_x_cost
    ? 'X'
    : typeof row.cost === 'number' && row.cost >= 0
      ? String(row.cost)
      : ''
  const upgradeCost =
    typeof row.upgrade?.cost === 'number' && row.upgrade.cost >= 0 ? String(row.upgrade.cost) : cost
  const info: Sts2CardInfo = {
    name: row.name,
    type: typeof row.type === 'string' ? row.type : '',
    color: typeof row.color === 'string' ? row.color : 'colorless',
    rarity: typeof row.rarity === 'string' ? row.rarity : '',
    cost,
    upgrade: { cost: upgradeCost }
  }
  if (row.is_x_star_cost) info.starCost = 'X'
  else if (typeof row.star_cost === 'number' && row.star_cost > 0) info.starCost = String(row.star_cost)
  return info
}

export function cardsFromCodex(rows: unknown): Sts2CardData {
  const map: Sts2CardData = {}
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    const info = codexCardToInfo(row)
    if (info) map[(row as any).id] = info
  }
  return map
}

/** `primary` wins; `secondary` only fills ids `primary` lacks. */
export function mergeCardData(primary: Sts2CardData, ...rest: Sts2CardData[]): Sts2CardData {
  const out: Sts2CardData = { ...primary }
  for (const map of rest) {
    for (const [id, info] of Object.entries(map)) if (!(id in out)) out[id] = info
  }
  return out
}

// ── synthesized from memory ─────────────────────────────────────────────────

// Verified against sts2.dll v0.113.1 metadata (CardType / CardRarity enums).
const CARD_TYPES = ['', 'Attack', 'Skill', 'Power', 'Status', 'Curse', 'Quest']
const CARD_RARITIES = [
  '',
  'Basic',
  'Common',
  'Uncommon',
  'Rare',
  'Ancient',
  'Event',
  'Token',
  'Status',
  'Curse',
  'Quest'
]

/** "FOOLISH_SHOT" -> "Foolish Shot". The honest fallback when no catalog names a card. */
export function prettifyCardId(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * A card no catalog knows, described from memory alone. The name is the
 * prettified id: memory has no display name to offer, and inventing one would
 * be worse than showing plainly that this card is new. The colour is the card's
 * own pool, which is what the art CDN's folders are named after; an unknown
 * colour still renders, on the colourless frame and energy icon. A negative
 * cost is an X/unplayable sentinel, which memory cannot tell apart, so it is
 * left blank rather than guessed.
 */
export function synthesizeCardInfo(
  id: string,
  meta: RawCardMeta,
  /** From the player's own game pack (see gamePack.ts), when it could be read. */
  fromGame: { title?: string | null; energyIcon?: string | null } = {}
): Sts2CardInfo {
  const cost = meta.canonicalCost >= 0 ? String(meta.canonicalCost) : ''
  const info: Sts2CardInfo = {
    name: fromGame.title || prettifyCardId(id),
    type: CARD_TYPES[meta.type] ?? '',
    color: meta.color ?? 'colorless',
    rarity: CARD_RARITIES[meta.rarity] ?? '',
    cost,
    upgrade: { cost }
  }
  if (fromGame.energyIcon) info.energyIcon = fromGame.energyIcon
  return info
}
