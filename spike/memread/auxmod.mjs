import { ProcessReader, findGamePid } from './reader.mjs'
const r = new ProcessReader(findGamePid())
const ok = v => v > 0x10000n && v < 0x7fffffffffffn
const STR_MT = 0x7fff0497bf40n

// MethodTables live in the loader heap near System.String's MT. Harvest MTs by
// scanning GC-heap object headers (obj[0] == MT) and keeping those with a sane
// m_BaseSize at the CONFIRMED offset +0x04.
const gc = r.regions().filter(x => x.base > 0x23900000000n && x.base < 0x23b00000000n)
const freq = new Map()
for (const reg of gc) {
  for (let off=0n; off<reg.size && off<0x3000000n; off+=0x1000n) {
    const p = r.read(reg.base+off, 0x1000); if(!p) continue
    for (let o=0;o+8<=0x1000;o+=8){
      const v=p.readBigUInt64LE(o)
      if (ok(v) && !(v&7n) && v > 0x7fff00000000n) freq.set(v.toString(),(freq.get(v.toString())||0)+1)
    }
  }
}
const mts = []
for (const [k,n] of freq) {
  if (n < 3) continue
  const a = BigInt(k), b = r.read(a, 0x40); if(!b) continue
  const bs = b.readUInt32LE(4)
  if (bs < 0x18 || bs > 0x10000 || (bs & 7)) continue
  if (!ok(b.readBigUInt64LE(0x10))) continue     // parent MT must be plausible
  mts.push({ a, b, n })
}
console.log(`MT candidates: ${mts.length} (String MT present: ${mts.some(m=>m.a===STR_MT)})`)

// For each 8-byte slot in the MT, and each slot in what it points to, count how
// often a COMMON address recurs. The loader Module is shared by every type in an
// assembly, so the true (mtOffset, auxOffset) pair produces a huge cluster.
const votes = new Map()   // "mtOff:auxOff" -> Map(addr -> count)
for (const m of mts.slice(0, 1500)) {
  for (let mo = 0x10; mo <= 0x38; mo += 8) {
    const p = m.b.readBigUInt64LE(mo)
    if (!ok(p)) continue
    // direct: the MT slot itself may BE the module pointer
    key(`mt+0x${mo.toString(16)}`, p)
    const ab = r.read(p, 0x40); if (!ab) continue
    for (let ao = 0; ao <= 0x38; ao += 8) {
      const q = ab.readBigUInt64LE(ao)
      if (ok(q)) key(`mt+0x${mo.toString(16)}->+0x${ao.toString(16)}`, q)
    }
  }
}
function key(k, addr){ if(!votes.has(k)) votes.set(k,new Map()); const m=votes.get(k); m.set(addr.toString(),(m.get(addr.toString())||0)+1) }

const ranked = []
for (const [path, m] of votes) {
  const [addr, cnt] = [...m.entries()].sort((a,b)=>b[1]-a[1])[0]
  ranked.push({ path, addr, cnt })
}
ranked.sort((a,b)=>b.cnt-a.cnt)
console.log('\nmost-shared pointer (candidate loader Module):')
for (const x of ranked.slice(0, 8))
  console.log(`  ${x.path.padEnd(24)} -> 0x${BigInt(x.addr).toString(16)}  shared by ${x.cnt}/${Math.min(mts.length,1500)} MTs`)
r.close()
