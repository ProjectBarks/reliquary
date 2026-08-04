// First real snapshot: MT -> live instance -> EEClass -> FieldDesc[] -> values.
import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import koffi from 'koffi'
const mts = JSON.parse(readFileSync(new URL('./mts.json', import.meta.url)))
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
    if (mbi.readUInt32LE(32) === 0x1000 && (mbi.readUInt32LE(36) & (0x02|0x04|0x20|0x40)) && !(mbi.readUInt32LE(36) & 0x100))
      out.push({ base, size })
    addr = base + size
  }
  return out
}
const regs = allRegions().filter(x => x.base > 0x10000000000n && x.size < 0x8000000n)

const MT = (n) => BigInt(mts.types[n][0].addr)
function eeClass(mt) {
  let v = r.readU64(mt + 0x28n); if (v == null) return null
  if (v & 1n) { v = r.readU64((v & ~1n) + 0x28n); if (v == null) return null }
  return v & ~3n
}
function instances(mt, limit = 4) {
  const out = []
  for (const reg of regs) {
    for (let off = 0n; off < reg.size; off += 0x10000n) {
      const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
      const p = r.read(reg.base + off, n); if (!p) continue
      for (let o = 0; o + 8 <= n; o += 8)
        if ((p.readBigUInt64LE(o) & ~7n) === mt) { out.push(reg.base + off + BigInt(o)); if (out.length >= limit) return out }
    }
  }
  return out
}
function fields(mt) {
  const ee = eeClass(mt); if (!ee) return []
  const list = r.readU64(ee + 0x18n); if (!OK(list)) return []
  const nInst = r.readU16(ee + 0x42n) ?? 0, nStat = r.readU16(ee + 0x46n) ?? 0
  const parent = r.readU64(mt + 0x10n)
  let pInst = 0
  if (OK(parent)) { const pee = eeClass(parent); if (pee) pInst = r.readU16(pee + 0x42n) ?? 0 }
  const count = Math.max(0, nInst - pInst) + nStat
  const out = []
  for (let i = 0; i < Math.min(count, 400); i++) {
    const fd = list + BigInt(i * 0x10)
    const d1 = r.readU32(fd + 8n), d2 = r.readU32(fd + 0xcn)
    if (d1 == null || d2 == null) break
    out.push({ i, mb: d1 & 0xffffff, isStatic: !!((d1 >>> 24) & 1), offset: d2 & 0x07ffffff, type: d2 >>> 27 })
  }
  return out
}
const ELEM = { 1:'void',2:'bool',3:'char',4:'i1',5:'u1',6:'i2',7:'u2',8:'i4',9:'u4',10:'i8',11:'u8',12:'r4',13:'r8',14:'string',17:'valuetype',18:'class',19:'var',20:'array',22:'genericinst',24:'i',25:'u',28:'object',29:'szarray' }

for (const name of ['MegaCrit.Sts2.Core.Nodes.NRun', 'MegaCrit.Sts2.Core.Nodes.NGame']) {
  const mt = MT(name)
  console.log(`\n=== ${name}  MT=0x${mt.toString(16)} ===`)
  const ee = eeClass(mt)
  console.log(`EEClass=0x${ee?.toString(16)} nInst=${r.readU16(ee+0x42n)} nStat=${r.readU16(ee+0x46n)} numMethods=${r.readU16(ee+0x44n)}`)
  const fs_ = fields(mt)
  console.log(`fields: ${fs_.length}`)
  const inst = instances(mt)
  console.log(`live instances: ${inst.length}${inst.length?' -> '+inst.map(x=>'0x'+x.toString(16)).join(', '):''}`)
  const obj = inst[0]
  for (const f of fs_.slice(0, 30)) {
    let val = ''
    if (obj && !f.isStatic) {
      const a = obj + 8n + BigInt(f.offset)
      if (f.type === 8 || f.type === 9) val = ` = ${r.readI32(a)}`
      else if (f.type === 2) val = ` = ${!!r.readU8(a)}`
      else if (f.type === 14) { const s = r.readU64(a); const len = OK(s) ? r.readI32(s + 8n) : null
        val = OK(s) && len != null && len >= 0 && len < 256 ? ` = ${JSON.stringify(r.readUtf16(s + 12n, len))}` : ' = null' }
      else if (f.type === 18 || f.type === 28 || f.type === 29 || f.type === 22) { const pv = r.readU64(a); val = ` = ${OK(pv) ? '0x'+pv.toString(16) : 'null'}` }
    }
    console.log(`  [${String(f.i).padStart(2)}] mb=0x${f.mb.toString(16).padStart(6,'0')} ${f.isStatic?'static ':'       '} off=0x${f.offset.toString(16).padStart(3,'0')} ${(ELEM[f.type]||f.type).padEnd(11)}${val}`)
  }
}
r.close()
