import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import { exports_ } from './pe.mjs'
const tokens = JSON.parse(readFileSync('./tokens.json','utf8'))
const r = new ProcessReader(findGamePid())
const clr = r.module('coreclr.dll')

// 1. cDAC contract descriptor — authoritative offsets for THIS build.
const exp = exports_(r, clr.base)
const cd = exp.get('DotNetRuntimeContractDescriptor')
console.log(`DotNetRuntimeContractDescriptor = ${cd ? '0x'+cd.toString(16) : 'NOT EXPORTED'}`)
if (cd) {
  const magic = r.read(cd, 8)
  console.log(`  magic  : ${JSON.stringify(magic.toString('latin1'))} ${magic.toString('latin1').startsWith('DNCCDAC')?'OK':'FAIL'}`)
  const flags = r.readU32(cd + 8n), size = r.readU32(cd + 12n)
  const jsonPtr = r.readU64(cd + 16n)
  console.log(`  flags=0x${flags.toString(16)} descriptor_size=${size} json@0x${jsonPtr.toString(16)}`)
  const json = r.read(jsonPtr, size)?.toString('utf8')
  if (json) {
    const m = json.match(/"MethodTable"\s*:\s*\{[^}]*\}/)
    console.log(`  MethodTable contract: ${m ? m[0].slice(0,220) : '(not found)'}`)
  }
}

// 2. THE TOKEN FIX: rid = ReadU32(mt+0x08) >> 8
console.log('\n=== token test on real MethodTables (rid = u32[mt+8] >> 8) ===')
const ok = v => v > 0x10000n && v < 0x7fffffffffffn
const gc = r.regions().filter(x => x.base > 0x23900000000n && x.base < 0x23b00000000n)
const freq = new Map()
for (const reg of gc) for (let off=0n; off<reg.size && off<0x1800000n; off+=0x1000n) {
  const p = r.read(reg.base+off, 0x1000); if(!p) continue
  for (let o=0;o+8<=0x1000;o+=8){ const v=p.readBigUInt64LE(o)
    if (ok(v)&&!(v&7n)&&v>0x7fff00000000n) freq.set(v.toString(),(freq.get(v.toString())||0)+1) }
}
let hit=0, tot=0
const names=new Set()
for (const [k,n] of freq) {
  if (n < 4) continue
  const mt = BigInt(k), b = r.read(mt, 0x20); if(!b) continue
  const bs = b.readUInt32LE(4); if (bs<0x18||bs>0x10000||(bs&7)) continue
  tot++
  const rid = b.readUInt32LE(8) >>> 8
  const nm = tokens[String(rid)]
  if (nm) { hit++; names.add(nm) }
}
console.log(`  ${hit}/${tot} MethodTables resolved to REAL sts2 type names (${names.size} distinct)`)
for (const n of [...names].slice(0,12)) console.log(`     ${n}`)
r.close()
