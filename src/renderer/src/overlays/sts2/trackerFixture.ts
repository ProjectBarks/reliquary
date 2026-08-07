import type { Sts2Card, Sts2CardData, Sts2PileState } from '@shared/types'

/**
 * Fixture piles for the tracker design harness (dev only).
 *
 * The pool is a realistic Ironclad card mix — uneven group sizes so packing
 * has something real to do. `buildPile` cycles it; each full pass raises the
 * upgrade level, so every added card is a DISTINCT row (the tracker groups
 * identical cards) and the row count genuinely grows with the requested size.
 */

const card = (
  id: string,
  cost: number | null,
  upgradeLevel = 0,
  extra: Partial<Sts2Card> = {}
): Sts2Card => ({
  id,
  upgradeLevel,
  enchantment: null,
  isPermanent: true,
  hasBeenCycled: false,
  cost,
  defaultCost: cost,
  costsX: false,
  ...extra
})

const info = (name: string, type: string, rarity: string, cost: string): [string, unknown] => [
  name.replace(/[^A-Za-z]/g, ''),
  { name, type, color: 'ironclad', rarity, cost }
]

const DEFS: Array<[string, string, string, string]> = [
  ['Strike', 'attack', 'basic', '1'],
  ['Defend', 'skill', 'basic', '1'],
  ['Bash', 'attack', 'basic', '2'],
  ['Twin Strike', 'attack', 'common', '1'],
  ['Pommel Strike', 'attack', 'common', '1'],
  ['Cleave', 'attack', 'common', '1'],
  ['Clothesline', 'attack', 'common', '2'],
  ['Heavy Blade', 'attack', 'common', '2'],
  ['Iron Wave', 'attack', 'common', '1'],
  ['Shrug It Off', 'skill', 'common', '1'],
  ['True Grit', 'skill', 'common', '1'],
  ['Armaments', 'skill', 'common', '1'],
  ['Battle Trance', 'skill', 'uncommon', '0'],
  ['Second Wind', 'skill', 'uncommon', '1'],
  ['Disarm', 'skill', 'uncommon', '1'],
  ['Inflame', 'power', 'uncommon', '1'],
  ['Metallicize', 'power', 'uncommon', '1'],
  ['Demon Form', 'power', 'rare', '3'],
  ['Feel No Pain', 'power', 'uncommon', '1'],
  ['Burn', 'status', 'status', '—'],
  ['Wound', 'status', 'status', '—'],
  ['Regret', 'curse', 'curse', '—']
]

export const FIXTURE_CARD_DATA: Sts2CardData = Object.fromEntries(
  DEFS.map(([name, type, rarity, cost]) => info(name, type, rarity, cost))
) as Sts2CardData

const id = (name: string): string => name.replace(/[^A-Za-z]/g, '')

/** A draw pile of arbitrary size, deterministic for a given `size`. */
export function buildPile(size: number): Sts2PileState {
  const draw: Sts2Card[] = []
  for (let i = 0; i < size; i++) {
    const [name, , , costStr] = DEFS[i % DEFS.length]
    const isStatus = costStr === '—'
    draw.push(
      card(
        id(name),
        isStatus ? null : Number(costStr),
        Math.floor(i / DEFS.length),
        isStatus ? { isPermanent: false } : {}
      )
    )
  }
  // A few cards already seen, for count/total badges and dimmed drawn rows.
  const discard = draw.filter((_, i) => i % 6 === 4).map((c) => ({ ...c }))
  const hand = draw.slice(0, 2).map((c) => ({ ...c }))
  return { draw, discard, hand }
}
