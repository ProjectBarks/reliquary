import { ProcessReader, findGamePid } from './reader.mjs'
import { exports_ } from './pe.mjs'

const r = new ProcessReader(findGamePid())
const clr = r.module('coreclr.dll')
const sts2 = r.module('sts2.dll')
const dac = exports_(r, clr.base).get('g_dacTable')
const plausible = (v) => v > 0x10000n && v < 0x7fffffffffffn

// Re-locate the struct holding sts2's PE base (from findmod.mjs).
const tbl = r.read(dac, 8 * 64)
let hit = null
const seen = new Set(); const q = []
for (let i = 0; i < 64; i++) {
  const a = tbl.readBigUInt64LE(i*8); if (!plausible(a)) continue
  const v = r.readU64(a); if (v != null && plausible(v)) q.push({p:v,d:0})
}
while (q.length && !hit) {
  const {p,d} = q.shift(); const k=p.toString()
  if (seen.has(k)||d>4) continue; seen.add(k)
  const b = r.read(p,512); if(!b) continue
  for (let o=0;o+8<=b.length;o+=8){
    const v=b.readBigUInt64LE(o)
    if(v===sts2.base){hit={p,o};break}
    if(d<4&&plausible(v)&&!seen.has(v.toString()))q.push({p:v,d:d+1})
  }
}
if (!hit) { console.error('module anchor not found'); process.exit(1) }
console.log(`anchor struct 0x${hit.p.toString(16)} (+0x${hit.o.toString(16)} = sts2 base)`)

// A CoreCLR MethodTable stores its loader Module pointer at a small fixed offset.
// So: scan candidate pointer arrays near the anchor; a real type table is one
// whose entries point at structs that reference a common Module address.
// First, find the Module: walk outward from the anchor looking for structs that
// many MethodTable-shaped objects point back to.
function looksLikeMT(addr) {
  const b = r.read(addr, 0x40); if (!b) return null
  const flags = b.readUInt32LE(0)
  const baseSize = b.readUInt32LE(4)
  // Heuristics: sane base size, and offsets 0x10/0x18 hold plausible pointers.
  if (baseSize < 0x10 || baseSize > 0x100000) return null
  const parent = b.readBigUInt64LE(0x10)
  const mod = b.readBigUInt64LE(0x18)
  if (!plausible(mod)) return null
  return { flags, baseSize, parent, mod }
}

// Sweep the region around the anchor for arrays of MethodTable pointers.
const counts = new Map()
for (let delta = -0x400n; delta <= 0x2000n; delta += 8n) {
  const cand = r.readU64(hit.p + delta)
  if (cand == null || !plausible(cand)) continue
  const arr = r.read(cand, 8 * 32); if (!arr) continue
  let mts = 0; const mods = new Map()
  for (let i = 0; i < 32; i++) {
    let e = arr.readBigUInt64LE(i*8)
    if (!plausible(e)) continue
    e = e & ~1n  // low bit is a LookupMap tag
    const mt = looksLikeMT(e)
    if (mt) { mts++; mods.set(mt.mod.toString(), (mods.get(mt.mod.toString())||0)+1) }
  }
  if (mts >= 8) {
    const [modAddr, n] = [...mods.entries()].sort((a,b)=>b[1]-a[1])[0]
    counts.set(cand.toString(), { mts, modAddr, n, at: hit.p + delta })
  }
}
const best = [...counts.values()].sort((a,b)=>b.mts-a.mts)[0]
if (best) {
  console.log(`\nTYPE TABLE FOUND`)
  console.log(`  array   0x${BigInt(Object.keys(Object.fromEntries(counts))[0]).toString(16)}`)
  console.log(`  MethodTable-shaped entries in first 32: ${best.mts}`)
  console.log(`  common loader Module: 0x${BigInt(best.modAddr).toString(16)} (${best.n}/32 agree)`)
  console.log(`  → MethodTables reachable; next: MT -> EEClass -> FieldDescs`)
} else {
  console.log('\nno type table found in swept range')
}
r.close()
