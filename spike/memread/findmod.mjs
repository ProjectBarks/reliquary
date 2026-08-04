import { ProcessReader, findGamePid } from './reader.mjs'
import { exports_ } from './pe.mjs'

const r = new ProcessReader(findGamePid())
const clr = r.module('coreclr.dll')
const sts2 = r.module('sts2.dll')
const dac = exports_(r, clr.base).get('g_dacTable')
const target = sts2.base
console.log(`looking for sts2.dll base 0x${target.toString(16)} inside runtime structures`)

const lo = clr.base, hi = clr.base + BigInt(clr.size)
const plausible = (v) => v > 0x10000n && v < 0x7fffffffffffn

// Breadth-first walk from the DacGlobals roots, following pointers, looking for
// a structure that stores sts2.dll's load address — that's its Module object
// (Module::m_pPEAssembly->m_base). Bounded so it terminates fast.
const tbl = r.read(dac, 8 * 64)
const seen = new Set()
const queue = []
for (let i = 0; i < 64; i++) {
  const a = tbl.readBigUInt64LE(i * 8)
  if (!plausible(a)) continue
  const v = r.readU64(a)
  if (v != null && plausible(v) && !(v >= lo && v < hi)) queue.push({ p: v, d: 0, path: `dac[${i}]` })
}

let found = null, visited = 0
while (queue.length && visited < 60000 && !found) {
  const { p, d, path } = queue.shift()
  const key = p.toString()
  if (seen.has(key) || d > 4) continue
  seen.add(key); visited++
  const buf = r.read(p, 512)
  if (!buf) continue
  for (let off = 0; off + 8 <= buf.length; off += 8) {
    const v = buf.readBigUInt64LE(off)
    if (v === target) { found = { p, off, d, path }; break }
    if (d < 4 && plausible(v) && !seen.has(v.toString())) queue.push({ p: v, d: d + 1, path: `${path}+0x${off.toString(16)}` })
  }
}

console.log(`visited ${visited} structures`)
if (found) {
  console.log(`\nFOUND sts2.dll base stored at:`)
  console.log(`  struct 0x${found.p.toString(16)} + 0x${found.off.toString(16)}  depth=${found.d}`)
  console.log(`  path: ${found.path}`)
  console.log(`  → this is sts2's PEAssembly/Module region; MethodTables reachable from here`)
} else {
  console.log('not found within bounds (increase depth/visited)')
}
r.close()
