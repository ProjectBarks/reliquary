import type { Sts2Card, Sts2CardData, Sts2PileState } from '@shared/types'

/**
 * A realistic mid-run Ironclad draw pile, for designing the tracker layout
 * without needing the game running.
 *
 * Sized deliberately: enough distinct cards that a wide panel has to wrap into
 * three or four columns, and uneven group sizes so column balancing has
 * something real to do. A fixture with four tidy cards would make any layout
 * look fine.
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

/** Draw pile: what is still to come. */
const DRAW: Sts2Card[] = [
  card(id('Strike'), 1),
  card(id('Strike'), 1),
  card(id('Strike'), 1),
  card(id('Strike'), 1, 1),
  card(id('Defend'), 1),
  card(id('Defend'), 1),
  card(id('Defend'), 1),
  card(id('Bash'), 2, 1),
  card(id('Twin Strike'), 1),
  card(id('Pommel Strike'), 1, 1),
  card(id('Cleave'), 1),
  card(id('Clothesline'), 2),
  card(id('Heavy Blade'), 2),
  card(id('Iron Wave'), 1),
  card(id('Shrug It Off'), 1),
  card(id('True Grit'), 1, 1),
  card(id('Armaments'), 1),
  card(id('Battle Trance'), 0),
  card(id('Second Wind'), 1),
  card(id('Disarm'), 1),
  card(id('Inflame'), 1),
  card(id('Metallicize'), 1),
  card(id('Demon Form'), 3),
  card(id('Feel No Pain'), 1, 1),
  card(id('Burn'), null, 0, { isPermanent: false }),
  card(id('Wound'), null, 0, { isPermanent: false }),
  card(id('Regret'), null)
]

/** Already drawn or discarded — shown as count 0 of a non-zero total. */
const DISCARD: Sts2Card[] = [
  card(id('Strike'), 1),
  card(id('Defend'), 1),
  card(id('Cleave'), 1),
  card(id('Shrug It Off'), 1)
]

const HAND: Sts2Card[] = [card(id('Strike'), 1), card(id('Inflame'), 1)]

export const FIXTURE_PILE: Sts2PileState = { draw: DRAW, discard: DISCARD, hand: HAND }

/** A near-empty pile, for checking the layout does not look broken late in a fight. */
export const FIXTURE_PILE_SMALL: Sts2PileState = {
  draw: [card(id('Strike'), 1), card(id('Defend'), 1), card(id('Bash'), 2)],
  discard: [card(id('Cleave'), 1)],
  hand: []
}
