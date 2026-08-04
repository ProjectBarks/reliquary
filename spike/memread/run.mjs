import { Heap } from './obj.mjs'

const h = new Heap()
const t0 = Date.now()
const cands = h.instances('MegaCrit.Sts2.Core.Nodes.NRun', { limit: 6 })
console.log(`NRun candidates (heap scan ${Date.now() - t0}ms):`)
for (const c of cands) console.log(`   0x${c.addr.toString(16)}  score=${c.score.toFixed(3)}`)

const nrun = cands[0]?.addr
if (!nrun) process.exit(1)
const state = h.get(nrun, '_state')
console.log(`\nNRun._state -> ${h.typeOf(state)} @0x${state?.toString(16)}`)
h.dump(state, { label: 'RunState' })
h.close()
