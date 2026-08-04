// External memory reader — the same architecture as untapped-scry.node, but ours.
//
// The proprietary binary imports exactly: OpenProcess, ReadProcessMemory,
// VirtualQueryEx, EnumProcessModules. We bind the same four via koffi, so no
// C++ toolchain / node-gyp is needed and the result is portable JS.
import koffi from 'koffi'
import { execSync } from 'node:child_process'

const k32 = koffi.load('kernel32.dll')
const psapi = koffi.load('psapi.dll')

// HANDLE/pointers are 64-bit; use BigInt-capable types throughout.
koffi.alias('HANDLE', 'void *')

const OpenProcess = k32.func('HANDLE OpenProcess(uint32 access, bool inherit, uint32 pid)')
const CloseHandle = k32.func('bool CloseHandle(HANDLE h)')
const ReadProcessMemory = k32.func(
  'bool ReadProcessMemory(HANDLE h, void *addr, _Out_ void *buf, size_t size, _Out_ size_t *read)'
)
const EnumProcessModulesEx = psapi.func(
  'bool EnumProcessModulesEx(HANDLE h, _Out_ void **mods, uint32 cb, _Out_ uint32 *needed, uint32 filter)'
)
const GetModuleFileNameExW = psapi.func(
  'uint32 GetModuleFileNameExW(HANDLE h, void *mod, _Out_ uint16 *name, uint32 size)'
)
const GetModuleInformation = psapi.func(
  'bool GetModuleInformation(HANDLE h, void *mod, _Out_ uint8 *info, uint32 cb)'
)

const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_VM_READ = 0x0010
const LIST_MODULES_ALL = 0x03

export class ProcessReader {
  /** @param {number} pid */
  constructor(pid) {
    this.pid = pid
    this.handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
    if (!this.handle) throw new Error(`OpenProcess failed for pid ${pid} (need same-or-higher integrity)`)
  }

  close() {
    if (this.handle) CloseHandle(this.handle)
    this.handle = null
  }

  /** Raw read. Returns null when the region isn't readable (freed/unmapped). */
  read(addr, size) {
    const buf = Buffer.alloc(size)
    const read = [0n]
    const ok = ReadProcessMemory(this.handle, koffi.as(addr, 'void *'), buf, size, read)
    if (!ok) return null
    return buf
  }

  readU8(addr) { return this.read(addr, 1)?.readUInt8(0) ?? null }
  readU16(addr) { return this.read(addr, 2)?.readUInt16LE(0) ?? null }
  readU32(addr) { return this.read(addr, 4)?.readUInt32LE(0) ?? null }
  readI32(addr) { return this.read(addr, 4)?.readInt32LE(0) ?? null }
  readU64(addr) { return this.read(addr, 8)?.readBigUInt64LE(0) ?? null }
  /** A pointer field: 8 bytes little-endian, 0n meaning null. */
  readPtr(addr) { return this.readU64(addr) }

  /** UTF-16LE string (how .NET stores System.String chars). */
  readUtf16(addr, charCount) {
    const b = this.read(addr, charCount * 2)
    return b ? b.toString('utf16le') : null
  }

  /** Enumerate loaded modules → [{ name, base, size }]. */
  modules() {
    const MAX = 1024
    const arr = Buffer.alloc(MAX * 8)
    const needed = [0]
    if (!EnumProcessModulesEx(this.handle, arr, arr.length, needed, LIST_MODULES_ALL)) return []
    const count = Math.min(MAX, Math.floor(needed[0] / 8))
    const out = []
    for (let i = 0; i < count; i++) {
      const base = arr.readBigUInt64LE(i * 8)
      const nameBuf = Buffer.alloc(520)
      const modPtr = koffi.as(base, 'void *')
      const len = GetModuleFileNameExW(this.handle, modPtr, nameBuf, 260)
      if (!len) continue
      const full = nameBuf.toString('utf16le', 0, len * 2)
      // MODULEINFO { lpBaseOfDll, SizeOfImage, EntryPoint } — 24 bytes on x64.
      const info = Buffer.alloc(24)
      let size = 0
      if (GetModuleInformation(this.handle, modPtr, info, 24)) size = info.readUInt32LE(8)
      out.push({ name: full.split('\\').pop(), path: full, base, size })
    }
    return out
  }

  module(name) {
    const want = name.toLowerCase()
    return this.modules().find((m) => m.name.toLowerCase() === want) ?? null
  }
}

/** Find the running Slay the Spire 2 process id. */
export function findGamePid() {
  const out = execSync(
    'powershell -NoProfile -Command "(Get-Process -Name SlayTheSpire2 -ErrorAction SilentlyContinue).Id"',
    { encoding: 'utf8' }
  ).trim()
  const pid = parseInt(out.split(/\s+/)[0], 10)
  return Number.isFinite(pid) ? pid : null
}

// ── VirtualQueryEx: enumerate committed regions (the 4th import their binary uses) ──
const VirtualQueryEx = k32.func(
  'size_t VirtualQueryEx(HANDLE h, void *addr, _Out_ uint8 *mbi, size_t len)'
)

/** MEMORY_BASIC_INFORMATION (x64, 48 bytes). Returns committed private regions. */
ProcessReader.prototype.regions = function (opts = {}) {
  const { minSize = 0x10000, maxTotal = 4n * 1024n * 1024n * 1024n } = opts
  const out = []
  let addr = 0n
  const mbi = Buffer.alloc(48)
  while (addr < 0x7ffffffe0000n && out.length < 20000) {
    const n = VirtualQueryEx(this.handle, koffi.as(addr, 'void *'), mbi, 48)
    if (!n) break
    const baseAddress = mbi.readBigUInt64LE(0)
    const regionSize = mbi.readBigUInt64LE(24)
    const state = mbi.readUInt32LE(32)   // MEM_COMMIT = 0x1000
    const protect = mbi.readUInt32LE(36)
    const type = mbi.readUInt32LE(40)    // MEM_PRIVATE = 0x20000
    if (regionSize === 0n) break
    // Committed, readable, private, not guard/noaccess → GC heap / loader heaps live here.
    const READABLE = 0x02 | 0x04 | 0x20 | 0x40 // R, RW, RX, RWX
    if (state === 0x1000 && (protect & READABLE) && !(protect & 0x100) &&
        type === 0x20000 && regionSize >= BigInt(minSize)) {
      out.push({ base: baseAddress, size: regionSize })
    }
    addr = baseAddress + regionSize
  }
  return out
}
