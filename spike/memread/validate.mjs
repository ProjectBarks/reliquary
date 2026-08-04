import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import { exports_ } from './pe.mjs'

const tokens = JSON.parse(readFileSync('./tokens.json', 'utf8'))
const r = new ProcessReader(findGamePid())
const clr = r.module('coreclr.dll'), sts2 = r.module('sts2.dll')
const dac = exports_(r, clr.base).get('g_dacTable')
const plausible = (v) => v > 0x10000n && v < 0x7fffffffffffn

// Re-find module anchor
const tbl = r.read(dac, 8*64); let hit=null; const seen=new Set(); const q=[]
for (let i=0;i<64;i++){const a=tbl.readBigUInt64LE(i*8);if(!plausible(a))continue
  const v=r.readU64(a);if(v!=null&&plausible(v))q.push({p:v,d:0})}
while(q.length&&!hit){const{p,d}=q.shift();const k=p.toString()
  if(seen.has(k)||d>4)continue;seen.add(k)
  const b=r.read(p,512);if(!b)continue
  for(let o=0;o+8<=b.length;o+=8){const v=b.readBigUInt64LE(o)
    if(v===sts2.base){hit={p,o};break}
    if(d<4&&plausible(v)&&!seen.has(v.toString()))q.push({p:v,d:d+1})}}

// CoreCLR MethodTable (x64): +0x00 flags, +0x04 baseSize, +0x0A TypeDef token(low16),
// +0x10 parent, +0x18 module. Validate a candidate by resolving its token to a NAME.
function identify(addr) {
  const b = r.read(addr, 0x20); if (!b) return null
  const baseSize = b.readUInt32LE(4)
  // Real managed types are small and 8-aligned. 0x7FF8-style values are the
  // tell-tale of uninitialised/padding memory, not a MethodTable.
  if (baseSize < 0x18 || baseSize > 0x2000 || (baseSize & 7)) return null
  const tokLow = b.readUInt16LE(0x0a)
  const name = tokens[String(tokLow)]
  if (!name) return null
  return { name, baseSize, token: tokLow }
}

// Sweep pointer arrays around the anchor; score each by how many entries resolve
// to REAL sts2 type names. A correct type table scores near 100%.
let best = null
for (let delta = -0x800n; delta <= 0x4000n; delta += 8n) {
  const arr = r.readU64(hit.p + delta)
  if (arr == null || !plausible(arr)) continue
  const buf = r.read(arr, 8*64); if (!buf) continue
  const names = []
  let nonNull = 0
  for (let i=0;i<64;i++){
    let e = buf.readBigUInt64LE(i*8)
    if (!plausible(e)) continue
    nonNull++
    const id = identify(e & ~1n)
    if (id) names.push(id)
  }
  // A genuine type table has MOSTLY-DISTINCT tokens. Repeated tokens mean we're
  // reading padding that merely satisfies the shape checks.
  const uniq = new Set(names.map((n) => n.token)).size
  if (nonNull >= 8 && names.length / nonNull > 0.8 && uniq >= Math.max(4, names.length * 0.6) &&
      (!best || names.length > best.names.length))
    best = { arr, at: hit.p + delta, names, nonNull, uniq }
}

if (best) {
  console.log(`TYPE TABLE VALIDATED @0x${best.arr.toString(16)}  (anchor+0x${(best.at-hit.p).toString(16)})`)
  console.log(`  ${best.names.length}/${best.nonNull} entries resolve to REAL sts2 type names\n`)
  for (const n of best.names.slice(0, 14)) console.log(`   tok=0x${n.token.toString(16).padStart(4,'0')} size=${String(n.baseSize).padStart(5)}  ${n.name}`)
} else {
  console.log('no validated type table found')
}
r.close()
