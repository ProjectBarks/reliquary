// Generic explorer CLI:  node x.mjs <TypeOrRoot>[.field.field...] [--items] [--max N]
//   node x.mjs NRun._roomContainer
//   node x.mjs NGame.GlobalUi.MapScreen
//   node x.mjs NRun._state._players --items
import { Heap } from './obj.mjs'

const ROOTS = {
  NRun: 'MegaCrit.Sts2.Core.Nodes.NRun',
  NGame: 'MegaCrit.Sts2.Core.Nodes.NGame'
}

const argv = process.argv.slice(2)
const spec = argv.find((a) => !a.startsWith('--')) ?? 'NRun'
const wantItems = argv.includes('--items')
const max = Number(argv[argv.indexOf('--max') + 1]) || 200

const h = new Heap()
const parts = spec.split('.')
const rootName = ROOTS[parts[0]] ?? parts[0]
let obj = h.root(rootName)
if (!obj) {
  console.log(`could not resolve root ${rootName}`)
  process.exit(1)
}
let label = parts[0]
for (const p of parts.slice(1)) {
  // `field[i]` indexes into a List<T>/T[] as part of the path
  const m = /^([^[]+)\[(\d+)]$/.exec(p)
  const next = m ? h.items(h.get(obj, m[1]))[Number(m[2])] : h.get(obj, p)
  if (next == null) {
    console.log(`${label}.${p} -> null`)
    process.exit(0)
  }
  obj = next
  label += '.' + p
}

console.log(`${label} -> ${h.typeOf(obj)} @0x${obj.toString(16)}`)
if (wantItems) {
  const el = h.items(obj)
  console.log(`count=${el.length}`)
  el.slice(0, max).forEach((e, i) => console.log(`  [${i}] ${h.typeOf(e)} @0x${e?.toString(16)}`))
  if (el[0]) h.dump(el[0], { label: `${label}[0]`, max })
} else {
  h.dump(obj, { label, max })
}
h.close()
