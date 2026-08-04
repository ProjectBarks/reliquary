// Named snapshot. Instances are validated by scoring: a real object's reference
// fields point at other objects whose MT is one we know. Table-of-typehandles
// false positives score ~0 because their "fields" are raw MethodTables.
import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import koffi from 'koffi'
const mts = JSON.parse(readFileSync(new URL('./mts.json', import.meta.url)))
const fieldsMeta = JSON.parse(readFileSync(new URL('./fields.json', import.meta.url)))
const r = new ProcessReader(findGamePid())
const OK = v => v != null && v > 0x10000n && v < 0x7fffffffffffn

const k32 = koffi.load('kernel32.dll')
const VQE = k32.func('size_t VirtualQueryEx(void *h, void *addr, _Out_ uint8 *mbi, size_t len)')
function allRegions() {
  const out = []; let addr = 0n; const mbi = Buffer.alloc(48)
  while (addr < 0x7ffffffe0000n && out.length < 40000) {
    if (!VQE(r.handle, koffi.as(addr, 'void *'), mbi, 48)) break
    const base = mbi.readBigUInt64LE(0), size = mbi.readBigUInt64LE(24)
    if (size === 0n) break
    const st = mbi.readUInt32LE(32), pr = mbi.readUInt32LE(36)
    if (st === 0x1000 && (pr & (0x02|0x04|0x20|0x40)) && !(pr & 0x100)) out.push({ base, size })
    addr = base + size
  }
  return out
}
// Managed heap only: below the loader-heap band, above the low PE mappings.
const regs = allRegions().filter(x => x.base > 0x10000000000n && x.base < 0x7f0000000000n && x.size < 0x8000000n)

const knownMT = new Set()
for (const l of Object.values(mts.types)) for (const m of l) knownMT.add(BigInt(m.addr).toString())
const nameOfMT = new Map()
for (const [n, l] of Object.entries(mts.types)) for (const m of l) nameOfMT.set(BigInt(m.addr).toString(), n)

const eeCache = new Map()
function eeClass(mt) {
  const k = mt.toString(); if (eeCache.has(k)) return eeCache.get(k)
  let v = r.readU64(mt + 0x28n)
  if (v != null && (v & 1n)) v = r.readU64((v & ~1n) + 0x28n)
  const res = v == null ? null : (v & ~3n)
  eeCache.set(k, res); return res
}
const fCache = new Map()
function fields(mt) {
  const k = mt.toString(); if (fCache.has(k)) return fCache.get(k)
  const out = []
  let cur = mt
  const chain = []
  while (OK(cur) && chain.length < 12) { chain.push(cur); cur = r.readU64(cur + 0x10n) }
  // walk base->derived so offsets read naturally
  for (let ci = chain.length - 1; ci >= 0; ci--) {
    const m = chain[ci], ee = eeClass(m); if (!ee) continue
    const list = r.readU64(ee + 0x18n); if (!OK(list)) continue
    const nInst = r.readU16(ee + 0x42n) ?? 0, nStat = r.readU16(ee + 0x46n) ?? 0
    const par = r.readU64(m + 0x10n)
    let pInst = 0
    if (OK(par)) { const pee = eeClass(par); if (pee) pInst = r.readU16(pee + 0x42n) ?? 0 }
    const count = Math.max(0, nInst - pInst) + nStat
    for (let i = 0; i < Math.min(count, 400); i++) {
      const fd = list + BigInt(i * 0x10)
      const d1 = r.readU32(fd + 8n), d2 = r.readU32(fd + 0xcn)
      if (d1 == null || d2 == null) break
      const rid = d1 & 0xffffff
      const meta = fieldsMeta[String(rid)]
      out.push({ owner: nameOfMT.get(m.toString()) ?? '0x'+m.toString(16),
                 name: meta?.n ?? `#${rid}`, sig: meta?.s ?? '?',
                 isStatic: !!((d1 >>> 24) & 1) || !!meta?.st,
                 offset: d2 & 0x07ffffff, type: d2 >>> 27 })
    }
  }
  fCache.set(k, out); return out
}
const isRef = t => t === 14 || t === 18 || t === 28 || t === 29 || t === 22 || t === 17
function score(obj, fs_) {
  let good = 0, tot = 0
  for (const f of fs_) {
    if (f.isStatic || !isRef(f.type) || f.type === 17) continue
    tot++
    const pv = r.readU64(obj + 8n + BigInt(f.offset))
    if (pv === 0n) { good += 0.25; continue }
    if (!OK(pv)) continue
    if (pv > 0x7f0000000000n) continue          // points into loader heap = not an object ref
    const m = r.readU64(pv); if (!OK(m)) continue
    if ((m & ~7n) > 0x7f0000000000n) good++      // target has an MT-shaped header
  }
  return tot ? good / tot : 0
}
function instancesOf(mt) {
  const fs_ = fields(mt); const found = []
  for (const reg of regs) {
    for (let off = 0n; off < reg.size; off += 0x10000n) {
      const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
      const p = r.read(reg.base + off, n); if (!p) continue
      for (let o = 0; o + 8 <= n; o += 8) {
        if ((p.readBigUInt64LE(o) & ~7n) !== mt) continue
        const a = reg.base + off + BigInt(o)
        found.push({ addr: a, score: score(a, fs_) })
      }
    }
  }
  return found.sort((x, y) => y.score - x.score)
}
function str(a) { const s = r.readU64(a); if (!OK(s)) return null
  const len = r.readI32(s + 8n); if (len == null || len < 0 || len > 512) return null
  return r.readUtf16(s + 12n, len) }

for (const name of ['MegaCrit.Sts2.Core.Nodes.NRun', 'MegaCrit.Sts2.Core.Nodes.NGame']) {
  const mt = BigInt(mts.types[name][0].addr)
  const fs_ = fields(mt)
  const inst = instancesOf(mt)
  console.log(`\n=== ${name}  fields=${fs_.length}  candidates=${inst.length} ===`)
  console.log(`  top: ${inst.slice(0,5).map(x=>`0x${x.addr.toString(16)}(${x.score.toFixed(2)})`).join(' ')}`)
  const obj = inst[0]?.addr
  if (!obj) continue
  for (const f of fs_) {
    if (f.isStatic) continue
    const a = obj + 8n + BigInt(f.offset)
    let v
    if (f.type === 8 || f.type === 9) v = r.readI32(a)
    else if (f.type === 2) v = !!r.readU8(a)
    else if (f.type === 10 || f.type === 11) v = String(r.readU64(a))
    else if (f.type === 12) v = r.read(a,4)?.readFloatLE(0)
    else if (f.type === 13) v = r.read(a,8)?.readDoubleLE(0)
    else if (f.type === 14) v = JSON.stringify(str(a))
    else { const pv = r.readU64(a); v = OK(pv) ? (nameOfMT.get((r.readU64(pv)??0n & ~7n).toString()) ? '→'+nameOfMT.get(((r.readU64(pv)??0n) & ~7n).toString()) : '0x'+pv.toString(16)) : 'null' }
    console.log(`  ${f.owner.split('.').pop().padEnd(22)} ${f.name.padEnd(26)} @0x${f.offset.toString(16).padStart(3,'0')} ${f.sig.padEnd(28).slice(0,28)} = ${v}`)
  }
}
r.close()
