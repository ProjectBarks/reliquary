import { readFileSync } from 'node:fs'
import { ProcessReader, findGamePid } from './reader.mjs'
const tokens = JSON.parse(readFileSync('./tokens.json','utf8'))
const r = new ProcessReader(findGamePid())
const ok = v => v > 0x10000n && v < 0x7fffffffffffn

const gc = r.regions().filter(x => x.base > 0x23900000000n && x.base < 0x23b00000000n)
const freq = new Map()
for (const reg of gc) for (let off=0n; off<reg.size && off<0x3000000n; off+=0x1000n) {
  const p = r.read(reg.base+off, 0x1000); if(!p) continue
  for (let o=0;o+8<=0x1000;o+=8){ const v=p.readBigUInt64LE(o)
    if (ok(v)&&!(v&7n)&&v>0x7fff00000000n) freq.set(v.toString(),(freq.get(v.toString())||0)+1) }
}
const mts=[]
for (const [k,n] of freq){ if(n<3)continue
  const a=BigInt(k), b=r.read(a,0x40); if(!b)continue
  const bs=b.readUInt32LE(4); if(bs<0x18||bs>0x10000||(bs&7))continue
  if(!ok(b.readBigUInt64LE(0x10)))continue
  mts.push({a,b,mod:b.readBigUInt64LE(0x18)}) }

// Group by module (MT+0x18, now confirmed).
const byMod = new Map()
for (const m of mts){ const k=m.mod.toString(); if(!byMod.has(k))byMod.set(k,[]); byMod.get(k).push(m) }
const groups=[...byMod.entries()].sort((a,b)=>b[1].length-a[1].length).slice(0,4)
console.log('modules by type count:')
for (const [mod,list] of groups) console.log(`  0x${BigInt(mod).toString(16)}  ${list.length} types`)

// For EACH module group, find the offset whose uint16 resolves to sts2 type names
// most often. Only sts2's OWN module should score far above the ~14% chance rate.
console.log('\nper-module token-offset hit rates (chance ≈ 14%):')
for (const [mod,list] of groups) {
  const best=[]
  for (let o=0;o+2<=0x10;o+=2){
    let hit=0; const names=new Set()
    for (const m of list){ const t=m.b.readUInt16LE(o); if(t&&tokens[String(t)]){hit++;names.add(tokens[String(t)])} }
    best.push({o,rate:hit/list.length,uniq:names.size,sample:[...names].slice(0,2)})
  }
  // also probe aux data
  for (let ao=0;ao<=0x30;ao+=2){
    let hit=0; const names=new Set()
    for (const m of list.slice(0,400)){ const aux=m.b.readBigUInt64LE(0x20); if(!ok(aux))continue
      const t=r.readU16(aux+BigInt(ao)); if(t&&tokens[String(t)]){hit++;names.add(tokens[String(t)])} }
    best.push({o:`aux+0x${ao.toString(16)}`,rate:hit/Math.min(list.length,400),uniq:names.size,sample:[...names].slice(0,2)})
  }
  best.sort((a,b)=>b.rate-a.rate)
  const top=best[0]
  console.log(`  module 0x${BigInt(mod).toString(16)} (${list.length}): best ${typeof top.o==='number'?'+0x'+top.o.toString(16):top.o} rate=${(top.rate*100).toFixed(0)}% uniq=${top.uniq} e.g. ${top.sample.join(', ')}`)
}
r.close()
