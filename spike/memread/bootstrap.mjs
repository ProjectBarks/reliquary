// Build the MethodTable map at runtime.
//
// tokens.json / fields.json are static metadata extracted from sts2.dll and can
// ship with the app, but MethodTable ADDRESSES are per-process and have to be
// rediscovered every launch. This is the only expensive step in the reader's
// lifetime; everything after it is pointer chasing.
//
// It works entirely inside the loader-heap address band, never touching the GC
// heap, because that is where MethodTables live and it is ~1% of the process.
import { readFileSync, writeFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import koffi from 'koffi'

const here = (f) => new URL('./' + f, import.meta.url)
const OK = (v) => v != null && v > 0x10000n && v < 0x7fffffffffffn
const LOADER_LO = 0x7f0000000000n

export function bootstrap(pid = findGamePid(), { verbose = false } = {}) {
  const tokens = JSON.parse(readFileSync(here('tokens.json')))
  const fieldsMeta = JSON.parse(readFileSync(here('fields.json')))
  const r = new ProcessReader(pid)
  const k32 = koffi.load('kernel32.dll')
  const VQE = k32.func('size_t VirtualQueryEx(void *h, void *addr, _Out_ uint8 *mbi, size_t len)')
  const log = (...a) => verbose && console.log(...a)
  const lap = (label, t0) => log(`  ${label.padEnd(38)} ${Date.now() - t0}ms`)

  // 1. committed readable regions in the loader band
  let t0 = Date.now()
  const regions = []
  {
    let addr = LOADER_LO
    const mbi = Buffer.alloc(48)
    while (addr < 0x7ffffffe0000n && regions.length < 40000) {
      if (!VQE(r.handle, koffi.as(addr, 'void *'), mbi, 48)) break
      const base = mbi.readBigUInt64LE(0)
      const size = mbi.readBigUInt64LE(24)
      if (size === 0n) break
      const st = mbi.readUInt32LE(32)
      const pr = mbi.readUInt32LE(36)
      if (st === 0x1000 && pr & (0x02 | 0x04 | 0x20 | 0x40) && !(pr & 0x100) && size < 0x8000000n) {
        regions.push({ base, size })
      }
      addr = base + size
    }
  }
  lap(`loader regions (${regions.length})`, t0)

  // 2. every MethodTable-shaped struct, grouped by the Module it belongs to.
  //    TypeDef rids collide across assemblies, so a name alone proves nothing —
  //    the Module pointer is what separates sts2's types from the framework's.
  t0 = Date.now()
  const byModule = new Map()
  for (const reg of regions) {
    for (let off = 0n; off < reg.size; off += 0x100000n) {
      const rem = reg.size - off
      const n = Number(rem > 0x100000n ? 0x100000n : rem)
      const p = r.read(reg.base + off, n)
      if (!p) continue
      for (let o = 0; o + 0x30 <= n; o += 8) {
        const baseSize = p.readUInt32LE(o + 4)
        if (baseSize < 0x18 || baseSize > 0x100000 || baseSize & 7) continue
        const rid = p.readUInt32LE(o + 8) >>> 8
        const name = tokens[String(rid)]
        if (!name) continue
        const mod = p.readBigUInt64LE(o + 0x18)
        if (!OK(mod)) continue
        const k = mod.toString()
        let g = byModule.get(k)
        if (!g) byModule.set(k, (g = []))
        g.push({ addr: reg.base + off + BigInt(o), rid, name, baseSize })
      }
    }
  }
  lap(`candidate MTs (${byModule.size} modules)`, t0)

  // 3. pick the real sts2 Module.
  //    For a correctly-identified type, walking MT -> EEClass -> FieldDescList
  //    and resolving the first FieldDesc's token must yield a field whose
  //    DECLARING TYPE is that same type. Coincidental rid matches fail this.
  t0 = Date.now()
  const eeOf = (mt) => {
    let v = r.readU64(mt + 0x28n)
    if (v != null && v & 1n) v = r.readU64((v & ~1n) + 0x28n)
    return v == null ? null : v & ~3n
  }
  const agreement = (list) => {
    let ok = 0
    let tried = 0
    const step = Math.max(1, Math.floor(list.length / 60))
    for (let i = 0; i < list.length && tried < 60; i += step) {
      const { addr, name } = list[i]
      const ee = eeOf(addr)
      if (!ee) continue
      const fdl = r.readU64(ee + 0x18n)
      if (!OK(fdl)) continue
      const d1 = r.readU32(fdl + 8n)
      if (d1 == null) continue
      tried++
      if (fieldsMeta[String(d1 & 0xffffff)]?.t === name) ok++
    }
    return tried >= 10 ? ok / tried : 0
  }
  let best = null
  for (const [mod, list] of byModule) {
    if (list.length < 200) continue
    const a = agreement(list)
    log(`    module 0x${BigInt(mod).toString(16)}  mts=${String(list.length).padStart(6)}  agreement=${(a * 100).toFixed(0)}%`)
    if (!best || a > best.a) best = { mod, list, a }
  }
  lap('module identification', t0)
  if (!best || best.a < 0.5) {
    r.close()
    throw new Error(`sts2 Module not identified (best agreement ${((best?.a ?? 0) * 100).toFixed(0)}%)`)
  }

  const types = {}
  for (const m of best.list) (types[m.name] ??= []).push({ addr: '0x' + m.addr.toString(16), baseSize: m.baseSize })
  r.close()
  return { module: '0x' + BigInt(best.mod).toString(16), agreement: best.a, types }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('bootstrap.mjs')) {
  const t0 = Date.now()
  const out = bootstrap(findGamePid(), { verbose: true })
  console.log(`bootstrap total ${Date.now() - t0}ms — ${Object.keys(out.types).length} types, agreement ${(out.agreement * 100).toFixed(0)}%`)
  for (const n of ['MegaCrit.Sts2.Core.Nodes.NRun', 'MegaCrit.Sts2.Core.Nodes.NGame']) {
    console.log(`  ${n} -> ${out.types[n]?.map((x) => x.addr).join(',') ?? 'MISSING'}`)
  }
  if (process.argv.includes('--write')) {
    writeFileSync(here('mts.json'), JSON.stringify(out))
    console.log('wrote mts.json')
  }
}
