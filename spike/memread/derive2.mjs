import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'

const tokens = JSON.parse(readFileSync('./tokens.json','utf8'))
const r = new ProcessReader(findGamePid())
const regs = r.regions()
const total = regs.reduce((a,b)=>a+b.size, 0n)
console.log(`committed private regions: ${regs.length}, total ${(Number(total)/1048576).toFixed(0)} MB`)
console.log(regs.slice(0,6).map(x=>`0x${x.base.toString(16)}(${(Number(x.size)/1048576).toFixed(1)}MB)`).join(' '))

const ok = v => v > 0x10000n && v < 0x7fffffffffffn
// Sample pages across regions; count how often each address appears at obj[0].
const freq = new Map()
let sampled = 0
for (const reg of regs) {
  const step = reg.size > 0x100000n ? 0x1000n : 0x1000n
  for (let off = 0n; off < reg.size && off < 0x800000n; off += step) {
    const page = r.read(reg.base + off, 0x1000)
    if (!page) continue
    sampled++
    for (let o = 0; o + 8 <= 0x1000; o += 8) {
      const v = page.readBigUInt64LE(o)
      if (!ok(v) || (v & 7n)) continue
      const k = v.toString()
      freq.set(k, (freq.get(k)||0)+1)
    }
  }
  if (sampled > 3000) break
}
const cands = [...freq.entries()].filter(([,n])=>n>=8).map(([k])=>BigInt(k))
console.log(`sampled ${sampled} pages; MT candidates (>=8 refs): ${cands.length}`)

const score = new Map()
for (const c of cands.slice(0, 6000)) {
  const b = r.read(c, 0x40); if (!b) continue
  for (let o = 0; o + 2 <= 0x40; o += 2) {
    const t = b.readUInt16LE(o)
    if (t && tokens[String(t)]) score.set(o, (score.get(o)||0)+1)
  }
}
console.log('\ntoken-offset scores:')
for (const [o,n] of [...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6))
  console.log(`  +0x${o.toString(16).padStart(2,'0')}  ${n}/${Math.min(cands.length,6000)}`)
r.close()
