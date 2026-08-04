// Minimal PE export-table parser that reads out of a REMOTE process.
//
// This is the bootstrap the proprietary reader uses: its only CoreCLR-related
// string is `g_dacTable`, which coreclr.dll exports. That symbol points at the
// DacGlobals structure — the runtime's table of pointers to SystemDomain,
// ThreadStore, MethodTable descriptors, etc. Resolving it by name from the
// export directory (rather than signature scanning) is why the reader survives
// game patches.

/**
 * Parse a loaded module's export directory and return { name -> absoluteAddr }.
 * @param {import('./reader.mjs').ProcessReader} r
 * @param {bigint} base module base address in the target process
 */
export function exports_(r, base) {
  const e_lfanew = r.readU32(base + 0x3cn)
  if (e_lfanew == null) return null
  const pe = base + BigInt(e_lfanew)
  if (r.readU32(pe) !== 0x4550) return null // "PE\0\0"

  // OptionalHeader magic: 0x20b = PE32+ (x64)
  const optHdr = pe + 0x18n
  const magic = r.readU16(optHdr)
  if (magic !== 0x20b) return null

  // DataDirectory[0] = export table (at optHdr + 0x70 for PE32+)
  const dirRva = r.readU32(optHdr + 0x70n)
  const dirSize = r.readU32(optHdr + 0x74n)
  if (!dirRva || !dirSize) return null

  const dir = base + BigInt(dirRva)
  const numNames = r.readU32(dir + 0x18n)
  const addrRva = r.readU32(dir + 0x1cn) // AddressOfFunctions
  const namesRva = r.readU32(dir + 0x20n) // AddressOfNames
  const ordsRva = r.readU32(dir + 0x24n) // AddressOfNameOrdinals
  if (!numNames || !addrRva || !namesRva || !ordsRva) return null

  // Bulk-read the three parallel arrays — far fewer round trips than per-entry.
  const names = r.read(base + BigInt(namesRva), numNames * 4)
  const ords = r.read(base + BigInt(ordsRva), numNames * 2)
  if (!names || !ords) return null

  const out = new Map()
  for (let i = 0; i < numNames; i++) {
    const nameRva = names.readUInt32LE(i * 4)
    const nameAddr = base + BigInt(nameRva)
    const raw = r.read(nameAddr, 128)
    if (!raw) continue
    const z = raw.indexOf(0)
    const name = raw.toString('latin1', 0, z < 0 ? 128 : z)
    if (!name) continue
    const ord = ords.readUInt16LE(i * 2)
    const fnRva = r.readU32(base + BigInt(addrRva) + BigInt(ord * 4))
    if (fnRva == null) continue
    out.set(name, base + BigInt(fnRva))
  }
  return out
}

/** Resolve a single export by name (cheaper than building the whole map twice). */
export function exportAddr(r, base, wanted) {
  const map = exports_(r, base)
  return map?.get(wanted) ?? null
}
