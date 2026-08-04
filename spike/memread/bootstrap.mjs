// Build the MethodTable map at runtime, across every assembly we have metadata
// for.
//
// meta/*.json is static metadata extracted from the game's managed assemblies
// and ships with the app, but MethodTable ADDRESSES are per-process and have to
// be rediscovered every launch. This is the only expensive step in the reader's
// lifetime; everything after it is pointer chasing.
//
// It works entirely inside the loader-heap address band, never touching the GC
// heap, because that is where MethodTables live and it is ~1% of the process.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
import koffi from 'koffi'

const here = (f) => new URL('./' + f, import.meta.url)
const OK = (v) => v != null && v > 0x10000n && v < 0x7fffffffffffn
const LOADER_LO = 0x7f0000000000n

export function loadMeta() {
  const dir = here('meta/')
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue
    const m = JSON.parse(readFileSync(new URL(f, dir)))
    out.push({ asm: m.asm, types: m.types, fields: m.fields })
  }
  return out
}

export function bootstrap(pid = findGamePid(), { verbose = false } = {}) {
  const metas = loadMeta()
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
  //    TypeDef rids are unique only within an assembly, so a name alone proves
  //    nothing — the Module pointer is what separates the assemblies.
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
        if (!rid) continue
        const mod = p.readBigUInt64LE(o + 0x18)
        if (!OK(mod)) continue
        const k = mod.toString()
        let g = byModule.get(k)
        if (!g) byModule.set(k, (g = []))
        g.push({ addr: reg.base + off + BigInt(o), rid, baseSize })
      }
    }
  }
  lap(`candidate MTs (${byModule.size} modules)`, t0)

  // 3. pair each Module with the assembly whose metadata actually explains it.
  //    For a correctly identified type, walking MT -> EEClass -> FieldDescList
  //    and resolving the first FieldDesc's token must yield a field whose
  //    DECLARING TYPE is that same type. Coincidental rid matches fail this.
  t0 = Date.now()
  const eeOf = (mt) => {
    let v = r.readU64(mt + 0x28n)
    if (v != null && v & 1n) v = r.readU64((v & ~1n) + 0x28n)
    return v == null ? null : v & ~3n
  }
  const agreement = (list, meta) => {
    let ok = 0
    let tried = 0
    const step = Math.max(1, Math.floor(list.length / 80))
    for (let i = 0; i < list.length && tried < 80; i += step) {
      const { addr, rid } = list[i]
      const name = meta.types[String(rid)]
      if (!name) continue
      const ee = eeOf(addr)
      if (!ee) continue
      const fdl = r.readU64(ee + 0x18n)
      if (!OK(fdl)) continue
      const d1 = r.readU32(fdl + 8n)
      if (d1 == null) continue
      tried++
      if (meta.fields[String(d1 & 0xffffff)]?.t === name) ok++
    }
    return tried >= 8 ? ok / tried : 0
  }

  const assigned = []
  for (const [mod, list] of byModule) {
    if (list.length < 100) continue
    let best = null
    for (const meta of metas) {
      const a = agreement(list, meta)
      if (!best || a > best.a) best = { a, meta }
    }
    if (best && best.a >= 0.6) {
      assigned.push({ mod, list, ...best })
      log(`    0x${BigInt(mod).toString(16).padEnd(12)} ${String(list.length).padStart(6)} MTs -> ${best.meta.asm} (${(best.a * 100).toFixed(0)}%)`)
    }
  }
  lap(`module identification (${assigned.length} assemblies)`, t0)
  if (!assigned.some((x) => x.meta.asm === 'sts2.dll')) {
    r.close()
    throw new Error('sts2 Module not identified — is the game past the main menu?')
  }

  // 4. emit the name map, keyed BY ASSEMBLY.
  //    FieldDef rids collide across assemblies exactly like TypeDef rids do, so
  //    a merged field map silently loses whichever assembly is written first.
  //    Every MethodTable carries the assembly it came from, and field lookups
  //    go through that assembly's own table.
  const types = {}
  const fields = {}
  const modules = {}
  for (const { mod, list, meta, a } of assigned) {
    modules[meta.asm] = { addr: '0x' + BigInt(mod).toString(16), mts: list.length, agreement: a }
    fields[meta.asm] = meta.fields
    for (const m of list) {
      const name = meta.types[String(m.rid)]
      if (!name) continue
      ;(types[name] ??= []).push({ addr: '0x' + m.addr.toString(16), baseSize: m.baseSize, asm: meta.asm })
    }
  }
  r.close()
  return { modules, types, fields }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('bootstrap.mjs')) {
  const t0 = Date.now()
  const out = bootstrap(findGamePid(), { verbose: true })
  console.log(`bootstrap total ${Date.now() - t0}ms — ${Object.keys(out.types).length} types`)
  for (const n of [
    'MegaCrit.Sts2.Core.Nodes.NRun',
    'MegaCrit.Sts2.Core.Nodes.NGame',
    'MegaCrit.Sts2.Core.Nodes.CommonUi.NGridCardHolder',
    'Godot.Control',
    'Godot.Node',
    'Godot.GodotObject'
  ]) {
    console.log(`  ${n.padEnd(52)} ${out.types[n]?.length ?? 0} MT(s)`)
  }
  if (process.argv.includes('--write')) {
    writeFileSync(here('mts.json'), JSON.stringify(out))
    console.log('wrote mts.json')
  }
}
