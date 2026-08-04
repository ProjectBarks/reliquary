import { ProcessReader, findGamePid } from './reader.mjs'
import { exports_ } from './pe.mjs'

const r = new ProcessReader(findGamePid())
const clr = r.module('coreclr.dll')
const dac = exports_(r, clr.base).get('g_dacTable')
const lo = clr.base, hi = clr.base + BigInt(clr.size)
const inClr = (v) => v >= lo && v < hi
const plausible = (v) => v > 0x10000n && v < 0x7fffffffffffn

// DacGlobals entries are ADDRESSES OF runtime globals. Deref each to get the
// global's value; a value outside coreclr.dll is a heap object (SystemDomain,
// ThreadStore, etc.) — those are the roots we want.
console.log('idx  &global              *global             kind')
const N = 48
const tbl = r.read(dac, 8 * N)
const heapRoots = []
for (let i = 0; i < N; i++) {
  const addrOf = tbl.readBigUInt64LE(i * 8)
  if (!plausible(addrOf)) continue
  const val = r.readU64(addrOf)
  if (val == null) continue
  let kind = ''
  if (val === 0n) kind = 'null'
  else if (inClr(val)) kind = 'in-coreclr (static/vtable)'
  else if (plausible(val)) { kind = 'HEAP OBJECT  <-- root candidate'; heapRoots.push({ i, addrOf, val }) }
  if (kind) console.log(
    `${String(i).padStart(3)}  0x${addrOf.toString(16).padEnd(16)}  0x${val.toString(16).padEnd(16)}  ${kind}`)
}
console.log(`\nroot candidates: ${heapRoots.length}`)
r.close()
