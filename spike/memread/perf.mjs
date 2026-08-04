import { Heap } from './obj.mjs'
const h = new Heap()
let t = Date.now(); const all = h.regions()
console.log(`regions ${all.length} / ${all.reduce((a,b)=>a+b.size,0n)/1048576n}MB  (${Date.now()-t}ms)`)
t = Date.now(); const gc = h.gcRegions()
console.log(`gcRegions ${gc.length} / ${gc.reduce((a,b)=>a+b.size,0n)/1048576n}MB  (${Date.now()-t}ms)`)
for (const n of ['MegaCrit.Sts2.Core.Nodes.NRun','MegaCrit.Sts2.Core.Nodes.NGame']) {
  t = Date.now(); const c = h.instances(n, { limit: 4 })
  console.log(`\n${n}  ${Date.now()-t}ms  cands=${c.length}`)
  for (const x of c) console.log(`   0x${x.addr.toString(16)} ${x.score.toFixed(3)}`)
}
t = Date.now(); const r1 = h.root('MegaCrit.Sts2.Core.Nodes.NRun')
console.log(`\nroot cold ${Date.now()-t}ms -> 0x${r1?.toString(16)}`)
for (let i=0;i<3;i++){ t=Date.now(); const r=h.root('MegaCrit.Sts2.Core.Nodes.NRun'); console.log(`root warm ${Date.now()-t}ms -> 0x${r?.toString(16)}`) }
h.close()
