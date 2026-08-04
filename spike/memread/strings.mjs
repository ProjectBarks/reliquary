import { ProcessReader, findGamePid } from './reader.mjs'
const r = new ProcessReader(findGamePid())
const ok = v => v > 0x10000n && v < 0x7fffffffffffn

// A .NET string object is: [0]=MethodTable, [8]=int32 length, [12]=UTF-16 chars.
// Find known game strings, then read back 12 bytes to recover the MT pointer.
// EVERY string shares the SAME MethodTable → a 100%-certain anchor.
const NEEDLES = ['STRIKE_DEFECT','DEFEND_DEFECT','ZAP','DUALCAST','Slay the Spire','CARD.','DEFECT']
const mtVotes = new Map()
const samples = []

const regs = r.regions()
let scanned = 0
outer:
for (const reg of regs) {
  for (let off = 0n; off < reg.size; off += 0x10000n) {
    const chunk = r.read(reg.base + off, 0x10000)
    if (!chunk) continue
    scanned++
    const text = chunk.toString('utf16le')
    for (const needle of NEEDLES) {
      let idx = -1
      while ((idx = text.indexOf(needle, idx + 1)) !== -1) {
        const byteOff = idx * 2
        // header is 12 bytes before the chars: MT(8) + length(4)
        if (byteOff < 12) continue
        const len = chunk.readInt32LE(byteOff - 4)
        if (len < 1 || len > 512) continue
        const mt = chunk.readBigUInt64LE(byteOff - 12)
        if (!ok(mt)) continue
        mtVotes.set(mt.toString(), (mtVotes.get(mt.toString()) || 0) + 1)
        if (samples.length < 6) samples.push({ addr: reg.base + off + BigInt(byteOff) - 12n, len,
                                               text: chunk.toString('utf16le', byteOff, byteOff + Math.min(len,40)*2) })
      }
    }
    if (scanned > 12000) break outer
  }
}
const ranked = [...mtVotes.entries()].sort((a,b)=>b[1]-a[1])
console.log(`scanned ${scanned} chunks`)
console.log('\nString MethodTable votes:')
for (const [mt,n] of ranked.slice(0,4)) console.log(`  0x${BigInt(mt).toString(16)}  ${n} strings`)
console.log('\nsample string objects:')
for (const s of samples) console.log(`  @0x${s.addr.toString(16)} len=${s.len} "${s.text}"`)

if (ranked.length) {
  const mt = BigInt(ranked[0][0])
  const b = r.read(mt, 0x40)
  console.log(`\nSystem.String MethodTable @0x${mt.toString(16)} — first 0x40 bytes:`)
  for (let o=0;o<0x40;o+=8)
    console.log(`  +0x${o.toString(16).padStart(2,'0')}  0x${b.readBigUInt64LE(o).toString(16).padStart(16,'0')}`
      + `   (u32: ${b.readUInt32LE(o)}, ${b.readUInt32LE(o+4)})`)
}
r.close()
