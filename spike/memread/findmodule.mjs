// Locate the sts2.dll CoreCLR Module.
// Anchor: Module+0xB0 (cDAC Module.Path) points at the wide module path.
// Validate: TypeDefToMethodTableMap[rid] must round-trip — the MT it yields
// must report the same rid back in MTFlags2>>8. That test is definitive.
import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'

const tokens = JSON.parse(readFileSync(new URL('./tokens.json', import.meta.url)))
const r = new ProcessReader(findGamePid())
const OK = v => v != null && v > 0x10000n && v < 0x7fffffffffffn
const MOD_PATH = 0xb0n, MOD_TYPEDEFMAP = 0x150n, LOOKUPMAP_DATA = 0x08n

// 1. every in-memory copy of the sts2.dll path string
const strs = new Set()
const regs = r.regions({ minSize: 0x1000 })
const needle = Buffer.from('sts2.dll', 'utf16le')
for (const reg of regs) {
  if (reg.size > 0x8000000n) continue
  for (let off = 0n; off < reg.size; off += 0x10000n) {
    const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
    const p = r.read(reg.base + off, n); if (!p) continue
    let i = 0
    while ((i = p.indexOf(needle, i)) !== -1) {
      // walk back to the start of the wide string
      let s = i
      while (s >= 2 && p[s - 1] === 0 && p[s - 2] >= 0x20 && p[s - 2] < 0x7f) s -= 2
      strs.add((reg.base + off + BigInt(s)).toString())
      i += 2
    }
  }
}
console.log(`sts2.dll path strings in memory: ${strs.size}`)

// 2. pointers to any of them → candidate Module+0xB0
const cands = []
for (const reg of regs) {
  if (reg.size > 0x8000000n) continue
  for (let off = 0n; off < reg.size; off += 0x10000n) {
    const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
    const p = r.read(reg.base + off, n); if (!p) continue
    for (let o = 0; o + 8 <= n; o += 8)
      if (strs.has(p.readBigUInt64LE(o).toString())) cands.push(reg.base + off + BigInt(o) - MOD_PATH)
  }
}
console.log(`candidate Modules: ${cands.length}`)

// 3. the round-trip test
const PROBE = [358, 360, 1, 2]
let mod = null
for (const c of cands) {
  const table = r.readU64(c + MOD_TYPEDEFMAP + LOOKUPMAP_DATA)
  if (!OK(table)) continue
  let good = 0
  for (const rid of PROBE) {
    const raw = r.readU64(table + BigInt(rid * 8)); if (!OK(raw)) continue
    const mt = raw & ~1n
    if (((r.readU32(mt + 8n) ?? 0) >>> 8) === rid) good++
  }
  if (good >= 2) { mod = { addr: c, table, good }; break }
}
if (!mod) { console.log('\nNo candidate passed the round-trip test'); r.close(); process.exit(1) }

console.log(`\nMODULE   = 0x${mod.addr.toString(16)}   (${mod.good}/${PROBE.length} probes round-tripped)`)
console.log(`TableData= 0x${mod.table.toString(16)}\n`)
for (const rid of [358, 360]) {
  const mt = (r.readU64(mod.table + BigInt(rid * 8))) & ~1n
  console.log(`  ${tokens[String(rid)]}  rid=${rid}  MT=0x${mt.toString(16)}  baseSize=${r.readU32(mt + 4n)}  ✓`)
}
r.close()
