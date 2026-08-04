import { ProcessReader, findGamePid } from './reader.mjs'
const r = new ProcessReader(findGamePid())
const sts2 = r.module('sts2.dll')
const OK = v => v > 0x10000n && v < 0x7fffffffffffn
const regs = r.regions({ minSize: 0x1000 })
console.log(`regions=${regs.length} total=${(regs.reduce((a,b)=>a+b.size,0n)/1048576n)}MB  sts2base=0x${sts2.base.toString(16)}`)
let hits = []
for (const reg of regs) {
  if (reg.size > 0x8000000n) continue
  for (let off = 0n; off < reg.size; off += 0x10000n) {
    const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
    const p = r.read(reg.base + off, n); if (!p) continue
    for (let o = 0; o + 8 <= n; o += 8)
      if (p.readBigUInt64LE(o) === sts2.base) hits.push(reg.base + off + BigInt(o))
  }
}
console.log(`qwords == sts2.base : ${hits.length}`)
// For each hit, look for a nearby pointer to a wide string ending in sts2.dll
for (const h of hits.slice(0, 40)) {
  for (let d = -0x200n; d <= 0x200n; d += 8n) {
    const pv = r.readU64(h + d); if (!OK(pv)) continue
    const s = r.read(pv, 600)?.toString('utf16le').split('\0')[0]
    if (s && /sts2\.dll$/i.test(s) && s.length > 8) {
      console.log(`  hit 0x${h.toString(16)}  path@delta ${d}  ${s}`)
      break
    }
  }
}
r.close()
