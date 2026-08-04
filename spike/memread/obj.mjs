// Reusable managed-object explorer: resolve a root type by name, score-pick its
// live instance, then walk field paths. This is the read primitive the shadow
// provider is built on.
import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import koffi from 'koffi'

const here = (f) => new URL('./' + f, import.meta.url)
export const mts = JSON.parse(readFileSync(here('mts.json')))
export const fieldsMeta = JSON.parse(readFileSync(here('fields.json')))

const HEAP_LO = 0x10000000000n
const HEAP_HI = 0x7f0000000000n
export const OK = (v) => v != null && v > 0x10000n && v < 0x7fffffffffffn
export const ELEM = {
  1: 'void', 2: 'bool', 3: 'char', 4: 'i1', 5: 'u1', 6: 'i2', 7: 'u2', 8: 'i4', 9: 'u4',
  10: 'i8', 11: 'u8', 12: 'f32', 13: 'f64', 14: 'string', 15: 'ptr', 16: 'byref',
  17: 'struct', 18: 'class', 19: 'var', 20: 'array', 22: 'generic', 24: 'nint',
  25: 'nuint', 28: 'object', 29: 'array'
}
const REF_TYPES = [14, 18, 28, 29, 22]

export class Heap {
  constructor(pid = findGamePid()) {
    this.r = new ProcessReader(pid)
    const k32 = koffi.load('kernel32.dll')
    this.VQE = k32.func('size_t VirtualQueryEx(void *h, void *addr, _Out_ uint8 *mbi, size_t len)')
    this.nameOfMT = new Map()
    this.mtOfName = new Map()
    for (const [n, l] of Object.entries(mts.types)) {
      this.mtOfName.set(n, l.map((x) => BigInt(x.addr)))
      for (const m of l) this.nameOfMT.set(BigInt(m.addr).toString(), n)
    }
    this._ee = new Map()
    this._f = new Map()
    this._regs = null
  }

  close() {
    this.r.close()
  }

  regions() {
    if (this._regs) return this._regs
    const out = []
    let addr = 0n
    const mbi = Buffer.alloc(48)
    while (addr < 0x7ffffffe0000n && out.length < 40000) {
      if (!this.VQE(this.r.handle, koffi.as(addr, 'void *'), mbi, 48)) break
      const base = mbi.readBigUInt64LE(0)
      const size = mbi.readBigUInt64LE(24)
      if (size === 0n) break
      const state = mbi.readUInt32LE(32)
      const prot = mbi.readUInt32LE(36)
      if (state === 0x1000 && prot & (0x02 | 0x04 | 0x20 | 0x40) && !(prot & 0x100)) {
        out.push({ base, size })
      }
      addr = base + size
    }
    this._regs = out.filter((x) => x.base > HEAP_LO && x.base < HEAP_HI && x.size < 0x8000000n)
    return this._regs
  }

  eeClass(mt) {
    const k = mt.toString()
    if (this._ee.has(k)) return this._ee.get(k)
    let v = this.r.readU64(mt + 0x28n)
    if (v != null && v & 1n) v = this.r.readU64((v & ~1n) + 0x28n)
    const res = v == null ? null : v & ~3n
    this._ee.set(k, res)
    return res
  }

  /** Full field list including inherited, base-first. Only MTs we can name are trusted. */
  fields(mt) {
    const k = mt.toString()
    if (this._f.has(k)) return this._f.get(k)
    const chain = []
    let cur = mt
    while (OK(cur) && chain.length < 16) {
      chain.push(cur)
      cur = this.r.readU64(cur + 0x10n)
    }
    const out = []
    for (let ci = chain.length - 1; ci >= 0; ci--) {
      const m = chain[ci]
      const owner = this.nameOfMT.get(m.toString())
      if (!owner) continue // unnameable MT -> its FieldDescList is not trustworthy
      const ee = this.eeClass(m)
      if (!ee) continue
      const list = this.r.readU64(ee + 0x18n)
      if (!OK(list)) continue
      const nInst = this.r.readU16(ee + 0x42n) ?? 0
      const nStat = this.r.readU16(ee + 0x46n) ?? 0
      const par = this.r.readU64(m + 0x10n)
      let pInst = 0
      if (OK(par)) {
        const pee = this.eeClass(par)
        if (pee) pInst = this.r.readU16(pee + 0x42n) ?? 0
      }
      const count = Math.min(Math.max(0, nInst - pInst) + nStat, 400)
      for (let i = 0; i < count; i++) {
        const fd = list + BigInt(i * 0x10)
        const d1 = this.r.readU32(fd + 8n)
        const d2 = this.r.readU32(fd + 0xcn)
        if (d1 == null || d2 == null) break
        const meta = fieldsMeta[String(d1 & 0xffffff)]
        if (!meta || meta.t !== owner) continue // token must agree with the declaring type
        out.push({
          owner,
          name: meta.n,
          sig: meta.s,
          isStatic: !!meta.st,
          offset: d2 & 0x07ffffff,
          type: d2 >>> 27
        })
      }
    }
    this._f.set(k, out)
    return out
  }

  field(mt, name) {
    return this.fields(mt).find((f) => f.name === name || f.name === `<${name}>k__BackingField`)
  }

  mtOf(obj) {
    const m = this.r.readU64(obj)
    return OK(m) ? m & ~7n : null
  }

  typeOf(obj) {
    const m = this.mtOf(obj)
    return m ? this.nameOfMT.get(m.toString()) ?? '0x' + m.toString(16) : null
  }

  str(addr) {
    if (!OK(addr)) return null
    const len = this.r.readI32(addr + 8n)
    if (len == null || len < 0 || len > 4096) return null
    return this.r.readUtf16(addr + 12n, len)
  }

  /** Read one field off an object, decoded by its element type. */
  read(obj, f) {
    const a = obj + 8n + BigInt(f.offset)
    switch (f.type) {
      case 2: return !!this.r.readU8(a)
      case 4: return this.r.read(a, 1)?.readInt8(0)
      case 5: return this.r.readU8(a)
      case 6: return this.r.read(a, 2)?.readInt16LE(0)
      case 3:
      case 7: return this.r.readU16(a)
      case 8: return this.r.readI32(a)
      case 9: return this.r.readU32(a)
      case 10:
      case 11:
      case 24:
      case 25: return this.r.readU64(a)
      case 12: return this.r.read(a, 4)?.readFloatLE(0)
      case 13: return this.r.read(a, 8)?.readDoubleLE(0)
      case 14: return this.str(this.r.readU64(a))
      case 17: return a // struct: address of the inline value
      default: {
        const p = this.r.readU64(a)
        return OK(p) ? p : null
      }
    }
  }

  get(obj, name) {
    const mt = this.mtOf(obj)
    if (!mt) return null
    const f = this.field(mt, name)
    return f ? this.read(obj, f) : undefined
  }

  // ── collections ─────────────────────────────────────────────────────────
  // SZARRAY: [0]=MT, [8]=length(nuint), [0x10]=elem0
  // List<T>: [0]=MT, [8]=_items(T[]), [0x10]=_size(i4)

  arrayLength(arr) {
    if (!OK(arr)) return 0
    const n = this.r.readU64(arr + 8n)
    return n != null && n < 1_000_000n ? Number(n) : 0
  }

  /** Elements of a reference-typed T[] (8 bytes each). */
  arrayRefs(arr, max = 4096) {
    const n = Math.min(this.arrayLength(arr), max)
    if (!n) return []
    const buf = this.r.read(arr + 0x10n, n * 8)
    if (!buf) return []
    const out = []
    for (let i = 0; i < n; i++) {
      const v = buf.readBigUInt64LE(i * 8)
      out.push(OK(v) ? v : null)
    }
    return out
  }

  /** Elements of a List<T> where T is a reference type. */
  listRefs(list, max = 4096) {
    if (!OK(list)) return []
    const items = this.r.readU64(list + 8n)
    const size = this.r.readI32(list + 0x10n)
    if (!OK(items) || size == null || size < 0 || size > 1_000_000) return []
    return this.arrayRefs(items, Math.min(size, max)).slice(0, size)
  }

  /** Reference elements of either a List<T> or a T[], whichever this is. */
  items(obj, max = 4096) {
    if (!OK(obj)) return []
    const t = this.typeOf(obj) ?? ''
    if (t.startsWith('System.Collections.Generic.List')) return this.listRefs(obj, max)
    // an SZARRAY's "length" slot is sane and its element slots are pointers
    const asList = this.listRefs(obj, max)
    if (asList.length) return asList
    return this.arrayRefs(obj, max)
  }

  path(obj, dotted) {
    let o = obj
    for (const part of dotted.split('.')) {
      if (o == null) return null
      o = this.get(o, part)
    }
    return o
  }

  /** Name chain of a MethodTable and its bases — used for assignability checks. */
  ancestry(mt) {
    const out = []
    let cur = mt
    for (let i = 0; OK(cur) && i < 16; i++) {
      const n = this.nameOfMT.get(cur.toString())
      if (n) out.push(n)
      cur = this.r.readU64(cur + 0x10n)
    }
    return out
  }

  /**
   * Semantic validity: for every reference field, does the pointee's ACTUAL type
   * match the field's DECLARED type? A misidentified address (a type-handle
   * table, a stale free block) fails this immediately, where a shape-only
   * heuristic happily accepts it.
   */
  score(obj, fs = null) {
    const mt = this.mtOf(obj)
    if (!mt) return 0
    const list = fs ?? this.fields(mt)
    let good = 0
    let tot = 0
    for (const x of list) {
      if (x.isStatic) continue
      if (x.type === 14) {
        // string: must be null or a well-formed System.String
        tot++
        const p = this.r.readU64(obj + 8n + BigInt(x.offset))
        if (p === 0n) { good += 0.5; continue }
        if (this.str(p) != null) good++
        continue
      }
      if (x.type !== 18 || !x.sig || x.sig.includes('.')===false) continue
      tot++
      const p = this.r.readU64(obj + 8n + BigInt(x.offset))
      if (p === 0n) { good += 0.5; continue }
      if (!OK(p) || p > HEAP_HI) continue
      const tm = this.mtOf(p)
      if (!tm) continue
      const chain = this.ancestry(tm)
      if (!chain.length) { good += 0.5; continue } // framework type we can't name — neutral
      if (chain.includes(x.sig)) good++
    }
    return tot ? good / tot : 0
  }

  /** All live instances of a named type, best-scoring first. */
  instances(typeName, { limit = 0 } = {}) {
    const list = this.mtOfName.get(typeName)
    if (!list) return []
    const want = new Set(list.map((x) => x.toString()))
    const found = []
    for (const reg of this.regions()) {
      for (let off = 0n; off < reg.size; off += 0x10000n) {
        const n = Number(reg.size - off > 0x10000n ? 0x10000n : reg.size - off)
        const p = this.r.read(reg.base + off, n)
        if (!p) continue
        for (let o = 0; o + 8 <= n; o += 8) {
          if (want.has((p.readBigUInt64LE(o) & ~7n).toString())) found.push(reg.base + off + BigInt(o))
        }
      }
    }
    const scored = found.map((a) => ({ addr: a, score: this.score(a) })).sort((x, y) => y.score - x.score)
    return limit ? scored.slice(0, limit) : scored
  }

  singleton(typeName) {
    return this.instances(typeName)[0]?.addr ?? null
  }

  dump(obj, { max = 200, label = '' } = {}) {
    const mt = obj == null ? null : this.mtOf(obj)
    if (!mt) return console.log(`\n--- ${label || '?'} @${obj == null ? 'null' : '0x' + obj.toString(16)} — not a managed object ---`)
    console.log(`\n--- ${label || this.typeOf(obj)} @0x${obj.toString(16)} ---`)
    for (const f of this.fields(mt).slice(0, max)) {
      if (f.isStatic) continue
      let v = this.read(obj, f)
      if (typeof v === 'bigint' && [18, 28, 29, 22, 15].includes(f.type)) {
        const t = this.typeOf(v)
        v = t && !t.startsWith('0x') ? `${t} @0x${v.toString(16)}` : `0x${v.toString(16)}`
      } else if (typeof v === 'string') v = JSON.stringify(v)
      const nm = f.name.replace(/^<(.*)>k__BackingField$/, '$1')
      console.log(`  ${nm.padEnd(30)} ${(ELEM[f.type] || f.type).padEnd(8)} @0x${f.offset.toString(16).padStart(3, '0')} = ${v}`)
    }
  }
}
