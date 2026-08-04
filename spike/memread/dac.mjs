import { ProcessReader, findGamePid } from './reader.mjs'
import { exports_ } from './pe.mjs'

const pid = findGamePid()
if (!pid) { console.error('StS2 not running'); process.exit(1) }
const r = new ProcessReader(pid)

const clr = r.module('coreclr.dll')
console.log(`coreclr.dll base = 0x${clr.base.toString(16)}`)

const exp = exports_(r, clr.base)
if (!exp) { console.error('failed to parse export table'); process.exit(1) }
console.log(`exports parsed: ${exp.size}`)

// The bootstrap symbol the proprietary reader uses.
const dac = exp.get('g_dacTable')
console.log(`g_dacTable      = ${dac ? '0x' + dac.toString(16) : 'NOT FOUND'}`)

// Show a few other useful runtime globals for orientation.
for (const n of [...exp.keys()].filter(n => /^g_/.test(n)).slice(0, 12)) {
  console.log(`  ${n.padEnd(28)} 0x${exp.get(n).toString(16)}`)
}

if (dac) {
  // DacGlobals is a table of target pointers. Dump the first entries; non-zero
  // canonical user-mode addresses (0x0000_7fff_.. or heap) indicate a live table.
  const buf = r.read(dac, 8 * 16)
  console.log('\nDacGlobals[0..15]:')
  for (let i = 0; i < 16; i++) {
    const v = buf.readBigUInt64LE(i * 8)
    console.log(`  [${String(i).padStart(2)}] 0x${v.toString(16)}`)
  }
}
r.close()
