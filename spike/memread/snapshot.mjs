// Produce a run snapshot from live memory, in the shape the scry provider emits.
// This is the candidate side of the shadow comparison.
import { Heap } from './obj.mjs'

const NRUN = 'MegaCrit.Sts2.Core.Nodes.NRun'
const NGAME = 'MegaCrit.Sts2.Core.Nodes.NGame'

const short = (h, o) => (h.typeOf(o) ?? '').split('.').pop() || null

/** A card's identity: model type name plus its upgrade level. */
function card(h, c) {
  if (!c) return null
  const id = short(h, c)
  if (!id) return null
  const up = h.get(c, '_currentUpgradeLevel') ?? 0
  return {
    id,
    upgrades: up,
    name: up > 0 ? `${id}+${up}` : id,
    cost: h.get(c, 'CanonicalEnergyCost') ?? null,
    rarity: h.get(c, 'Rarity') ?? null,
    type: h.get(c, 'Type') ?? null
  }
}

export function snapshot(h) {
  const nrun = h.root(NRUN)
  if (!nrun) return { ok: false, reason: 'NRun not resolved' }
  const st = h.get(nrun, '_state')
  if (!st) return { ok: false, reason: 'RunState not resolved' }

  const players = h.items(h.get(st, '_players')).filter(Boolean)
  const p = players[0]
  const creature = p ? h.get(p, 'Creature') : null

  const pile = (owner, name) => h.items(h.get(h.get(owner, name), '_cards')).map((c) => card(h, c)).filter(Boolean)

  const combat = p ? h.get(p, 'PlayerCombatState') : null
  const piles = {}
  if (combat) {
    for (const n of ['DrawPile', 'Hand', 'DiscardPile', 'ExhaustPile']) {
      const cp = h.get(combat, n)
      if (cp) piles[n[0].toLowerCase() + n.slice(1)] = h.items(h.get(cp, '_cards')).map((c) => card(h, c)).filter(Boolean)
    }
  }

  return {
    ok: true,
    run: {
      act: h.get(st, '_currentActIndex'),
      floor: h.get(st, 'ActFloor'),
      ascension: h.get(st, 'AscensionLevel'),
      gameMode: h.get(st, 'GameMode'),
      nextRoomId: h.get(st, 'NextRoomId'),
      mapType: short(h, h.get(st, 'Map'))
    },
    player: p && {
      character: short(h, h.get(p, 'Character')),
      gold: h.get(p, '_gold'),
      maxEnergy: h.get(p, 'MaxEnergy'),
      hp: creature ? h.get(creature, '_currentHp') : null,
      maxHp: creature ? h.get(creature, '_maxHp') : null,
      block: creature ? h.get(creature, '_block') : null,
      relics: h.items(h.get(p, '_relics')).map((r) => short(h, r)).filter(Boolean),
      potions: h.items(h.get(p, '_potionSlots')).map((x) => short(h, x)),
      deck: pile(p, 'Deck')
    },
    piles,
    playerCount: players.length
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('snapshot.mjs')) {
  const h = new Heap()
  const t0 = Date.now()
  h.gcRegions()
  console.log(`warmup ${Date.now() - t0}ms`)
  for (let i = 0; i < 6; i++) {
    const t = Date.now()
    const s = snapshot(h)
    const ms = Date.now() - t
    if (!s.ok) {
      console.log(`tick ${i + 1} ${ms}ms  FAILED: ${s.reason}`)
      continue
    }
    const p = s.player
    console.log(
      `tick ${i + 1} ${String(ms).padStart(4)}ms  act=${s.run.act} floor=${s.run.floor} asc=${s.run.ascension}` +
        `  ${p.character} ${p.hp}/${p.maxHp} gold=${p.gold}` +
        `  deck=${p.deck.length} relics=${p.relics.length} potions=${p.potions.filter(Boolean).length}` +
        `  piles={${Object.entries(s.piles).map(([k, v]) => k + ':' + v.length).join(' ')}}`
    )
  }
  h.close()
}
