// The Path offset / map offset assumption failed. Search empirically instead:
// around each pointer-to-"sts2.dll"-path, look for ANY qword that points at a
// table whose [rid] entry round-trips (MTFlags2>>8 == rid) for several rids.
import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
const tokens = JSON.parse(readFileSync(new URL('./tokens.json', import.meta.url)))
const r = new ProcessReader(findGamePid())
const OK = v => v != null && v > 0x10000n && v < 0x7fffffffffffn
const regs = r.regions({ minSize: 0x1000 })
const needle = Buffer.from('sts2.dll', 'utf16le')

const strs = new Set()
for (const reg of regs) { if (reg.size > 0x8000000n) continue
  for (let off = 0n; off < reg.size; off += 0x10000n) {
    const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
    const p = r.read(reg.base + off, n); if (!p) continue
    let i = 0
    while ((i = p.indexOf(needle, i)) !== -1) {
      let s = i; while (s >= 2 && p[s-1] === 0 && p[s-2] >= 0x20 && p[s-2] < 0x7f) s -= 2
      strs.add((reg.base + off + BigInt(s)).toString()); i += 2 } } }

const ptrs = []
for (const reg of regs) { if (reg.size > 0x8000000n) continue
  for (let off = 0n; off < reg.size; off += 0x10000n) {
    const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
    const p = r.read(reg.base + off, n); if (!p) continue
    for (let o = 0; o + 8 <= n; o += 8)
      if (strs.has(p.readBigUInt64LE(o).toString())) ptrs.push(reg.base + off + BigInt(o)) } }
console.log(`strings=${strs.size} pointers=${ptrs.length}`)

const RIDS = [358, 360, 3, 100, 500, 1000]
const score = (table) => {
  let g = 0, seen = new Set()
  for (const rid of RIDS) {
    const raw = r.readU64(table + BigInt(rid * 8)); if (!OK(raw)) continue
    const mt = raw & ~1n
    const bs = r.readU32(mt + 4n); if (bs == null || bs < 0x18 || bs > 0x100000) continue
    if (((r.readU32(mt + 8n) ?? 0) >>> 8) === rid) { g++; seen.add(mt.toString()) }
  }
  return seen.size >= 2 ? g : 0
}

const found = []
for (const P of ptrs) {
  const blk = r.read(P - 0x400n, 0x900); if (!blk) continue
  for (let d = 0; d + 8 <= 0x900; d += 8) {
    const v = blk.readBigUInt64LE(d); if (!OK(v)) continue
    const s = score(v)
    if (s >= 3) found.push({ ptr: P, delta: d - 0x400, table: v, score: s })
  }
}
console.log(`\nmatches: ${found.length}`)
for (const f of found.slice(0, 6)) {
  console.log(`  pathPtr=0x${f.ptr.toString(16)} tableAt delta ${f.delta} (0x${(f.delta<0?'-':'')+Math.abs(f.delta).toString(16)}) table=0x${f.table.toString(16)} score=${f.score}/${RIDS.length}`)
  for (const rid of [358, 360]) {
    const mt = (r.readU64(f.table + BigInt(rid*8)) ?? 0n) & ~1n
    console.log(`      ${tokens[String(rid)]} -> 0x${mt.toString(16)} baseSize=${r.readU32(mt+4n)}`)
  }
}
r.close()
