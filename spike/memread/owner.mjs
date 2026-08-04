import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
const tokens = JSON.parse(readFileSync('./tokens.json','utf8'))
const r = new ProcessReader(findGamePid())
const ok = v => v > 0x10000n && v < 0x7fffffffffffn
const STR_MT = 0x7fff0497bf40n

// 1. Locate a distinctive game string object.
const regs = r.regions().filter(x => x.base > 0x23900000000n && x.base < 0x23a00000000n)
let target = null, targetText = ''
outer: for (const reg of regs) {
  for (let off=0n; off<reg.size && off<0x4000000n; off+=0x10000n) {
    const c = r.read(reg.base+off, 0x10000); if(!c) continue
    const t = c.toString('utf16le')
    for (const needle of ['DEFECT1_EPOCH','STRIKE_DEFECT','DUALCAST']) {
      const i = t.indexOf(needle)
      if (i > 6 && c.readBigUInt64LE(i*2-12) === STR_MT) {
        target = reg.base + off + BigInt(i*2) - 12n; targetText = needle; break outer
      }
    }
  }
}
if (!target) { console.log('no anchor string found'); process.exit(0) }
console.log(`anchor string "${targetText}" object @0x${target.toString(16)}`)

// 2. Find objects that POINT to it — those are sts2 model objects.
const owners = []
for (const reg of regs) {
  for (let off=0n; off<reg.size && off<0x4000000n; off+=0x1000n) {
    const p = r.read(reg.base+off, 0x1000); if(!p) continue
    for (let o=0;o+8<=0x1000;o+=8)
      if (p.readBigUInt64LE(o) === target) owners.push(reg.base+off+BigInt(o))
  }
  if (owners.length > 40) break
}
console.log(`objects referencing it: ${owners.length}`)

// 3. For each owner, walk back to the object header to get its MethodTable,
//    then see which offset in that MT yields a SENSIBLE sts2 type name.
const seen = new Set()
for (const ownerField of owners.slice(0, 25)) {
  for (let back = 8n; back <= 96n; back += 8n) {
    const objAddr = ownerField - back
    const mt = r.readU64(objAddr)
    if (mt == null || !ok(mt) || (mt & 7n)) continue
    const b = r.read(mt, 0x40); if (!b) continue
    const bs = b.readUInt32LE(4)
    if (bs < 0x18 || bs > 0x4000 || (bs & 7)) continue
    if (seen.has(mt.toString())) continue
    seen.add(mt.toString())
    const hits = []
    for (let o=0;o+2<=0x10;o+=2){ const t=b.readUInt16LE(o); if(t&&tokens[String(t)]) hits.push(`+0x${o.toString(16)}=${tokens[String(t)]}`) }
    // Also probe the auxiliary-data pointer at +0x20 for a token.
    const aux = b.readBigUInt64LE(0x20)
    let auxHits = []
    if (ok(aux)) { const ab = r.read(aux, 0x30)
      if (ab) for (let o=0;o+2<=0x30;o+=2){ const t=ab.readUInt16LE(o); if(t&&tokens[String(t)]) auxHits.push(`aux+0x${o.toString(16)}=${tokens[String(t)]}`) } }
    if (hits.length || auxHits.length)
      console.log(`  MT 0x${mt.toString(16)} base=${bs} | ${hits.slice(0,2).join(' ')} | ${auxHits.slice(0,3).join(' ')}`)
  }
}
r.close()
