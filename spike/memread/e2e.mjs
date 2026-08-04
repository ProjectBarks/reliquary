// Cold-start to steady-state, exactly as the provider would run it.
import { writeFileSync } from 'node:fs'
import { bootstrap } from './bootstrap.mjs'
import { findGamePid } from './reader.mjs'

const T = Date.now()
const pid = findGamePid()
let t = Date.now()
const map = bootstrap(pid)
console.log(`bootstrap        ${String(Date.now()-t).padStart(5)}ms  ${Object.keys(map.types).length} types, agreement ${(map.agreement*100).toFixed(0)}%`)
writeFileSync(new URL('./mts.json', import.meta.url), JSON.stringify(map))

const { Heap } = await import('./obj.mjs?' + Date.now())
const { snapshot } = await import('./snapshot.mjs?' + Date.now())
t = Date.now(); const h = new Heap(pid); console.log(`attach           ${String(Date.now()-t).padStart(5)}ms`)
t = Date.now(); h.gcRegions(); console.log(`gc region narrow ${String(Date.now()-t).padStart(5)}ms  ${h.gcRegions().length} regions / ${h.gcRegions().reduce((a,b)=>a+b.size,0n)/1048576n}MB`)
t = Date.now(); const first = snapshot(h); console.log(`first snapshot   ${String(Date.now()-t).padStart(5)}ms  ok=${first.ok}`)
const times = []
for (let i=0;i<20;i++){ const s=Date.now(); snapshot(h); times.push(Date.now()-s) }
times.sort((a,b)=>a-b)
console.log(`steady snapshot  min=${times[0]}ms p50=${times[10]}ms max=${times[19]}ms`)
console.log(`TOTAL COLD START ${Date.now()-T}ms`)
if (first.ok) {
  const p = first.player
  console.log(`\nstate: act=${first.run.act} floor=${first.run.floor} asc=${first.run.ascension} map=${first.run.mapType}`)
  console.log(`       ${p.character} ${p.hp}/${p.maxHp} block=${p.block} gold=${p.gold} energy=${p.maxEnergy}`)
  console.log(`       deck=${p.deck.length} relics=[${p.relics.join(', ')}] potions=[${p.potions.filter(Boolean).join(', ')}]`)
  console.log(`       piles=${JSON.stringify(Object.fromEntries(Object.entries(first.piles).map(([k,v])=>[k,v.length])))}`)
}
h.close()
