import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import { exports_ } from './pe.mjs'

const tokens = JSON.parse(readFileSync('./tokens.json','utf8'))
const r = new ProcessReader(findGamePid())
const clr = r.module('coreclr.dll')
const dac = exports_(r, clr.base).get('g_dacTable')
const ok = v => v > 0x10000n && v < 0x7fffffffffffn

// DacGlobals held big region pointers (GC heap segments). Harvest candidate
// MethodTables the reliable way: every managed object's FIRST 8 BYTES are its
// MethodTable pointer, so addresses that appear many times in that slot are MTs.
const tbl = r.read(dac, 8*64)
const regions = []
for (let i=0;i<64;i++){
  const a = tbl.readBigUInt64LE(i*8); if(!ok(a)) continue
  const v = r.readU64(a)
  if (v!=null && ok(v) && (v & 0xffffffn) === 0n) regions.push(v)  // segment-aligned
}
console.log(`candidate heap regions: ${regions.map(x=>'0x'+x.toString(16)).join(' ')}`)

const freq = new Map()
for (const base of regions) {
  for (let off = 0n; off < 0x400000n; off += 0x1000n) {   // sample 4MB per region
    const page = r.read(base + off, 0x1000)
    if (!page) continue
    for (let o = 0; o + 8 <= 0x1000; o += 8) {
      const v = page.readBigUInt64LE(o)
      if (!ok(v)) continue
      const k = v.toString()
      freq.set(k, (freq.get(k)||0)+1)
    }
  }
}
const cands = [...freq.entries()].filter(([,n])=>n>=6).map(([k])=>BigInt(k))
console.log(`addresses appearing >=6x as a candidate MT pointer: ${cands.length}`)

// Empirically locate the token: find the 2-byte offset in 0x00..0x40 where the
// value resolves to a REAL sts2 TypeDef name for the most candidates.
const score = new Map()
for (const c of cands.slice(0, 4000)) {
  const b = r.read(c, 0x40); if (!b) continue
  for (let o = 0; o + 2 <= 0x40; o += 2) {
    const t = b.readUInt16LE(o)
    if (tokens[String(t)]) score.set(o, (score.get(o)||0)+1)
  }
}
const ranked = [...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)
console.log('\ntoken-offset scores (offset -> #candidates resolving to a real type name):')
for (const [o,n] of ranked) console.log(`  +0x${o.toString(16).padStart(2,'0')}  ${n}`)
r.close()
