import { Heap } from './obj.mjs'

const h = new Heap()
const nrun = h.instances('MegaCrit.Sts2.Core.Nodes.NRun', { limit: 1 })[0]
const st = h.get(nrun.addr, '_state')
const player = h.items(h.get(st, '_players'))[0]

const shortName = (o) => (h.typeOf(o) ?? '?').split('.').pop()

// A card's canonical id is its model type name; ModelId carries the string form.
const modelId = (o) => {
  const id = h.get(o, 'Id')
  if (!id) return null
  for (const f of h.fields(h.mtOf(id))) {
    if (f.type === 14) {
      const s = h.read(id, f)
      if (s) return s
    }
  }
  return null
}
const cardLabel = (c) => {
  const up = h.get(c, '_currentUpgradeLevel') ?? 0
  return shortName(c) + (up > 0 ? `+${up}` : '')
}

const idObj = h.get(h.items(h.get(st, '_allCards'))[0], 'Id')
h.dump(idObj, { label: 'ModelId', max: 20 })

const deck = h.items(h.get(h.get(player, 'Deck'), '_cards'))
const counts = new Map()
for (const c of deck) if (c) counts.set(cardLabel(c), (counts.get(cardLabel(c)) || 0) + 1)
console.log(`\nDECK — ${deck.length} cards, ${counts.size} distinct`)
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`   ${String(n).padStart(2)}x ${k}`)
}
console.log(`\nsample ModelId string: ${modelId(deck[0])}`)

const relics = h.items(h.get(player, '_relics'))
console.log(`\nRELICS — ${relics.length}`)
for (const r of relics) if (r) console.log(`   ${shortName(r)}  (${modelId(r) ?? '-'})`)

const potions = h.items(h.get(player, '_potionSlots'))
console.log(`\nPOTION SLOTS — ${potions.length}`)
for (const p of potions) console.log(`   ${p ? shortName(p) : 'empty'}`)

console.log(`\ngold=${h.get(player, '_gold')}  maxEnergy=${h.get(player, 'MaxEnergy')}  char=${shortName(h.get(player, 'Character'))}`)
const cre = h.get(player, 'Creature')
if (cre) h.dump(cre, { label: 'Creature', max: 40 })
h.close()
