import { ProcessReader, findGamePid } from './reader.mjs'
const r = new ProcessReader(findGamePid())
const m = r.module('sts2.dll')
console.log(`sts2.dll @0x${m.base.toString(16)}`)

// PE -> OptionalHeader -> DataDirectory[14] = CLI header -> metadata root ("BSJB")
const e_lfanew = r.readU32(m.base + 0x3cn)
const pe = m.base + BigInt(e_lfanew)
const opt = pe + 0x18n
const cliRva = r.readU32(opt + 0x70n + 14n*8n)
console.log(`CLI header RVA = 0x${cliRva.toString(16)}`)
const cli = m.base + BigInt(cliRva)
const metaRva = r.readU32(cli + 8n)          // Metadata RVA
const metaSize = r.readU32(cli + 12n)
console.log(`Metadata RVA = 0x${metaRva.toString(16)} size=0x${metaSize.toString(16)}`)

const meta = m.base + BigInt(metaRva)
const sig = r.read(meta, 4)
console.log(`signature @0x${meta.toString(16)}: ${JSON.stringify(sig?.toString('latin1'))} ${sig?.toString('latin1')==='BSJB'?'OK — metadata IS readable from target memory':'FAIL'}`)

if (sig?.toString('latin1') === 'BSJB') {
  const verLen = r.readU32(meta + 12n)
  const ver = r.read(meta + 16n, verLen)?.toString('latin1').replace(/\0+$/,'')
  console.log(`runtime version string: "${ver}"`)
  const afterVer = meta + 16n + BigInt((verLen + 3) & ~3)
  const nStreams = r.readU16(afterVer + 2n)
  console.log(`streams: ${nStreams}`)
  let p = afterVer + 4n
  for (let i = 0; i < nStreams; i++) {
    const off = r.readU32(p), size = r.readU32(p + 4n)
    const nameBuf = r.read(p + 8n, 32)
    const z = nameBuf.indexOf(0)
    const name = nameBuf.toString('latin1', 0, z)
    console.log(`  ${name.padEnd(10)} off=0x${off.toString(16)} size=0x${size.toString(16)}`)
    p = p + 8n + BigInt((name.length + 1 + 3) & ~3)
  }
}
r.close()
