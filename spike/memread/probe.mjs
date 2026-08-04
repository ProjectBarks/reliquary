import { ProcessReader, findGamePid } from './reader.mjs'

const pid = findGamePid()
if (!pid) { console.error('StS2 not running'); process.exit(1) }
console.log(`attached target pid=${pid}`)

const r = new ProcessReader(pid)
const mods = r.modules()
console.log(`modules: ${mods.length}`)

for (const n of ['sts2.dll', 'coreclr.dll', 'SlayTheSpire2.exe', 'GodotSharp.dll']) {
  const m = r.module(n)
  console.log(`  ${n.padEnd(20)} base=0x${m ? m.base.toString(16) : '?'} size=${m ? (m.size/1024/1024).toFixed(1)+'MB' : '?'}`)
}

// Ground-truth validation: every PE image starts with "MZ" and has a PE\0\0 header.
const sts2 = r.module('sts2.dll')
if (sts2) {
  const mz = r.read(sts2.base, 2)
  const e_lfanew = r.readU32(sts2.base + 0x3cn)
  const sig = r.read(sts2.base + BigInt(e_lfanew), 4)
  console.log(`\nPE validation @sts2.dll:`)
  console.log(`  MZ magic : ${mz?.toString('latin1')}  ${mz?.toString('latin1') === 'MZ' ? 'OK' : 'FAIL'}`)
  console.log(`  PE sig   : ${JSON.stringify(sig?.toString('latin1'))}  ${sig?.readUInt32LE(0) === 0x4550 ? 'OK' : 'FAIL'}`)
}
r.close()
