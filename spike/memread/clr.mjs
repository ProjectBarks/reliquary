// Minimal external CoreCLR object reader.
//   name -> TypeDef rid -> MethodTable -> instances -> EEClass -> FieldDesc -> field values
import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import { exports_ } from './pe.mjs'

const OK = v => v > 0x10000n && v < 0x7fffffffffffn
// Hardcoded from CoreCLR v9.0.7 source (cDAC does not publish these until .NET 11)
const EECLASS_FIELDDESCLIST = 0x18
const EECLASS_NUM_INSTANCE_FIELDS = 0x42
const EECLASS_NUM_STATIC_FIELDS = 0x46
const FIELDDESC_SIZE = 0x10
const FIELD_OFFSET_MAX = (1 << 27) - 7

export class ClrReader {
  constructor(pid = findGamePid()) {
    this.r = new ProcessReader(pid)
    this.clr = this.r.module('coreclr.dll')
    this.tokens = JSON.parse(readFileSync(new URL('./tokens.json', import.meta.url)))
    // name -> rid (invert the token map)
    this.ridByName = new Map()
    for (const [rid, name] of Object.entries(this.tokens)) this.ridByName.set(name, Number(rid))
    this.cdac = this._readCdac()
    this._mtCache = null
  }

  /** cDAC contract descriptor → authoritative offsets for THIS build. */
  _readCdac() {
    const cd = exports_(this.r, this.clr.base).get('DotNetRuntimeContractDescriptor')
    if (!cd) return null
    const size = this.r.readU32(cd + 12n)
    const json = this.r.read(this.r.readU64(cd + 16n), size).toString('utf8')
    return JSON.parse(json)
  }

  /** Harvest MethodTables by scanning managed heap object headers. */
  _methodTables() {
    if (this._mtCache) return this._mtCache
    const unmask = BigInt(parseInt(this.cdac?.globals?.ObjectToMethodTableUnmask?.[0] ?? '0x7', 16))
    const regs = this.r.regions().filter(x => x.base > 0x10000000000n)
    const freq = new Map()
    for (const reg of regs) {
      for (let off = 0n; off < reg.size && off < 0x4000000n; off += 0x1000n) {
        const p = this.r.read(reg.base + off, 0x1000)
        if (!p) continue
        for (let o = 0; o + 8 <= 0x1000; o += 8) {
          const v = p.readBigUInt64LE(o) & ~unmask
          if (OK(v) && v > 0x7fff00000000n) freq.set(v.toString(), (freq.get(v.toString()) || 0) + 1)
        }
      }
    }
    const out = new Map() // rid -> mt
    for (const [k, n] of freq) {
      if (n < 2) continue
      const mt = BigInt(k), b = this.r.read(mt, 0x20)
      if (!b) continue
      const bs = b.readUInt32LE(4)
      if (bs < 0x18 || bs > 0x100000 || (bs & 7)) continue
      const rid = b.readUInt32LE(8) >>> 8     // ← .NET 9: token lives in m_dwFlags2 >> 8
      if (rid && this.tokens[String(rid)]) out.set(rid, mt)
    }
    this._mtCache = out
    return out
  }

  /** MethodTable for a fully-qualified type name. */
  methodTableFor(name) {
    const rid = this.ridByName.get(name)
    return rid ? this._methodTables().get(rid) ?? null : null
  }

  /** MethodTable -> EEClass (bit0 of the +0x28 union: 1 = canonical MT, re-read its +0x28). */
  eeClass(mt) {
    let v = this.r.readU64(mt + 0x28n)
    if (v == null) return null
    if (v & 1n) { const canon = v & ~1n; v = this.r.readU64(canon + 0x28n); if (v == null) return null }
    return v & ~1n
  }

  /** Enumerate a type's FieldDescs → [{name?, offset, isStatic, type}] */
  fields(mt) {
    const ee = this.eeClass(mt); if (!ee) return []
    const list = this.r.readU64(ee + BigInt(EECLASS_FIELDDESCLIST)); if (!OK(list)) return []
    const nInst = this.r.readU16(ee + BigInt(EECLASS_NUM_INSTANCE_FIELDS)) ?? 0
    const nStat = this.r.readU16(ee + BigInt(EECLASS_NUM_STATIC_FIELDS)) ?? 0
    // introduced instance fields = ours - parent's
    const parent = this.r.readU64(mt + 0x10n)
    let pInst = 0
    if (OK(parent)) { const pee = this.eeClass(parent); if (pee) pInst = this.r.readU16(pee + BigInt(EECLASS_NUM_INSTANCE_FIELDS)) ?? 0 }
    const count = Math.max(0, nInst - pInst) + nStat
    const out = []
    for (let i = 0; i < Math.min(count, 512); i++) {
      const fd = list + BigInt(i * FIELDDESC_SIZE)
      const d1 = this.r.readU32(fd + 8n), d2 = this.r.readU32(fd + 0xcn)
      if (d1 == null || d2 == null) break
      const offset = d2 & 0x07ffffff
      if (offset >= FIELD_OFFSET_MAX) continue
      out.push({ fd, mb: d1 & 0xffffff, isStatic: !!((d1 >>> 24) & 1), offset, type: d2 >>> 27 })
    }
    return out
  }

  /** Find live instances of a MethodTable by scanning heap object headers. */
  instances(mt, limit = 8) {
    const unmask = BigInt(parseInt(this.cdac?.globals?.ObjectToMethodTableUnmask?.[0] ?? '0x7', 16))
    const found = []
    for (const reg of this.r.regions().filter(x => x.base > 0x10000000000n)) {
      for (let off = 0n; off < reg.size && off < 0x4000000n; off += 0x1000n) {
        const p = this.r.read(reg.base + off, 0x1000); if (!p) continue
        for (let o = 0; o + 8 <= 0x1000; o += 8) {
          if ((p.readBigUInt64LE(o) & ~unmask) === mt) {
            found.push(reg.base + off + BigInt(o))
            if (found.length >= limit) return found
          }
        }
      }
    }
    return found
  }

  readPtrField(obj, f) { return this.r.readU64(obj + 8n + BigInt(f.offset)) }
  readI32Field(obj, f) { return this.r.readI32(obj + 8n + BigInt(f.offset)) }

  /** .NET System.String at addr → JS string. */
  readString(addr) {
    if (!OK(addr)) return null
    const len = this.r.readI32(addr + 8n)
    if (len == null || len < 0 || len > 512) return null
    return this.r.readUtf16(addr + 12n, len)
  }

  close() { this.r.close() }
}
