// Two-phase MethodTable enumeration.
//  A: scan the GC heap for object headers -> distinct MT candidates -> validate
//     each by rid (MTFlags2>>8 must name a real sts2 TypeDef).
//  B: take the regions those MTs live in and full-scan them, so we get every
//     MT in the module, not just the ones with a live instance.
import { readFileSync, writeFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
const tokens = JSON.parse(readFileSync(new URL('./tokens.json', import.meta.url)))
const r = new ProcessReader(findGamePid())
const OK = v => v != null && v > 0x10000n && v < 0x7fffffffffffn

// --- all readable committed memory, not just MEM_PRIVATE ---
import koffi from 'koffi'
const k32 = koffi.load('kernel32.dll')
const VirtualQueryEx = k32.func('size_t VirtualQueryEx(void *h, void *addr, _Out_ uint8 *mbi, size_t len)')
function allRegions() {
  const out = []; let addr = 0n; const mbi = Buffer.alloc(48)
  while (addr < 0x7ffffffe0000n && out.length < 40000) {
    if (!VirtualQueryEx(r.handle, koffi.as(addr, 'void *'), mbi, 48)) break
    const base = mbi.readBigUInt64LE(0), size = mbi.readBigUInt64LE(24)
    const state = mbi.readUInt32LE(32), prot = mbi.readUInt32LE(36)
    if (size === 0n) break
    if (state === 0x1000 && (prot & (0x02|0x04|0x20|0x40)) && !(prot & 0x100)) out.push({ base, size })
    addr = base + size
  }
  return out
}
const regs = allRegions()
console.log(`readable regions: ${regs.length}  ${regs.reduce((a,b)=>a+b.size,0n)/1048576n} MB`)

function validate(mt) {
  const b = r.read(mt, 0x30); if (!b) return null
  const baseSize = b.readUInt32LE(4)
  if (baseSize < 0x18 || baseSize > 0x100000 || (baseSize & 7)) return null
  const rid = b.readUInt32LE(8) >>> 8
  if (!rid || !tokens[String(rid)]) return null
  const mod = b.readBigUInt64LE(0x18); if (!OK(mod)) return null
  return { rid, baseSize, mod, name: tokens[String(rid)] }
}

// Phase A
const cand = new Set()
for (const reg of regs) {
  if (reg.base < 0x10000000000n || reg.size > 0x8000000n) continue
  for (let off = 0n; off < reg.size; off += 0x10000n) {
    const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
    const p = r.read(reg.base + off, n); if (!p) continue
    for (let o = 0; o + 8 <= n; o += 8) {
      const v = p.readBigUInt64LE(o) & ~7n
      if (v > 0x7000000000n && v < 0x7fffffffffffn) cand.add(v.toString())
    }
  }
}
console.log(`distinct MT candidates: ${cand.size}`)
const hits = []
for (const k of cand) { const v = validate(BigInt(k)); if (v) hits.push({ addr: BigInt(k), ...v }) }
console.log(`validated MethodTables (phase A): ${hits.length}`)
if (!hits.length) { console.log('nothing found'); r.close(); process.exit(1) }

const modFreq = new Map()
for (const h of hits) modFreq.set(h.mod.toString(), (modFreq.get(h.mod.toString()) || 0) + 1)
const [modAddr, modN] = [...modFreq.entries()].sort((a, b) => b[1] - a[1])[0]
console.log(`dominant Module: 0x${BigInt(modAddr).toString(16)}  (${modN}/${hits.length} MTs)`)

// Phase B — full-scan the regions containing those MTs
const mtRegions = new Set()
for (const h of hits) { const rg = regs.find(x => h.addr >= x.base && h.addr < x.base + x.size); if (rg) mtRegions.add(rg) }
console.log(`MT-bearing regions: ${mtRegions.size}  ${[...mtRegions].reduce((a,b)=>a+b.size,0n)/1024n} KB`)

const byName = new Map()
for (const reg of mtRegions) {
  for (let off = 0n; off < reg.size; off += 0x10000n) {
    const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
    const p = r.read(reg.base + off, n); if (!p) continue
    for (let o = 0; o + 0x30 <= n; o += 8) {
      const baseSize = p.readUInt32LE(o + 4)
      if (baseSize < 0x18 || baseSize > 0x100000 || (baseSize & 7)) continue
      const rid = p.readUInt32LE(o + 8) >>> 8
      const name = tokens[String(rid)]; if (!name) continue
      if (p.readBigUInt64LE(o + 0x18).toString() !== modAddr) continue
      const addr = reg.base + off + BigInt(o)
      if (!byName.has(name)) byName.set(name, [])
      byName.get(name).push({ addr: '0x' + addr.toString(16), baseSize })
    }
  }
}
console.log(`\ntypes resolved (phase B): ${byName.size}\n`)
for (const n of ['MegaCrit.Sts2.Core.Nodes.NGame', 'MegaCrit.Sts2.Core.Nodes.NRun']) {
  const l = byName.get(n)
  console.log(l ? `  ${n} -> ${l.map(x=>`${x.addr}(size ${x.baseSize})`).join(', ')}` : `  ${n} -> NOT FOUND`)
}
writeFileSync(new URL('./mts.json', import.meta.url),
  JSON.stringify({ module: '0x' + BigInt(modAddr).toString(16), types: Object.fromEntries(byName) }))
console.log(`\nwrote mts.json`)
r.close()
