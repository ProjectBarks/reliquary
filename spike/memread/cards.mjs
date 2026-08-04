import { Heap } from './obj.mjs'

const h = new Heap()
const nrun = h.instances('MegaCrit.Sts2.Core.Nodes.NRun', { limit: 1 })[0]
const st = h.get(nrun.addr, '_state')
const player = h.items(h.get(st, '_players'))[0]

const deckPile = h.get(player, 'Deck')
console.log(`Deck -> ${h.typeOf(deckPile)} @0x${deckPile?.toString(16)}`)
h.dump(deckPile, { label: 'CardPile', max: 30 })

const cards = h.items(h.get(st, '_allCards'))
console.log(`\n_allCards count=${cards.length}  first type=${h.typeOf(cards[0])}`)
h.dump(cards[0], { label: 'Card[0]', max: 60 })

h.close()
