// Poll live memory and print a line whenever the game state changes.
// Verifies the reader tracks real play: room transitions, combat, shops.
import { writeFileSync, appendFileSync } from 'node:fs'
import { bootstrap } from './bootstrap.mjs'
import { findGamePid } from './reader.mjs'

const SECS = Number(process.argv[2]) || 60
const pid = findGamePid()
if (!pid) {
  console.log('Slay the Spire 2 is not running')
  process.exit(1)
}

const map = bootstrap(pid)
writeFileSync(new URL('./mts.json', import.meta.url), JSON.stringify(map))
const { Heap } = await import('./obj.mjs?v=' + Date.now())
const { snapshot } = await import('./snapshot.mjs?v=' + Date.now())

const h = new Heap(pid)
h.gcRegions()
const logPath = new URL('./watch.jsonl', import.meta.url)
console.log(`watching ${SECS}s — pid ${pid}, ${Object.keys(map.types).length} types\n`)

const brief = (s) => {
  if (!s.ok) return `FAILED: ${s.reason}`
  const p = s.player
  const c = s.combat
  return (
    `${(s.screen.roomType ?? '-').padEnd(16)} a${s.run.act}f${s.run.floor} ` +
    `${p.character} ${p.hp}/${p.maxHp}${p.block ? '+' + p.block : ''} g=${p.gold} deck=${p.deck.length} ` +
    `r=${p.relics.length} ` +
    (c ? `| ${c.encounter} rd${c.round} t${c.turn} e${c.energy} foes=[${c.enemies.map((e) => `${e.id} ${e.hp}/${e.maxHp}`).join(', ')}] ` : '') +
    (Object.keys(s.piles).length ? `| ${Object.entries(s.piles).map(([k, v]) => k[0] + v.length).join(' ')} ` : '') +
    (s.screen.topOverlay ? `| overlay=${s.screen.topOverlay} ` : '') +
    (s.screen.isMapOpen ? '| MAP ' : '')
  )
}

let last = ''
let ticks = 0
let fails = 0
const times = []
const stop = Date.now() + SECS * 1000
const timer = setInterval(() => {
  const t = Date.now()
  let s
  try {
    s = snapshot(h)
  } catch (e) {
    s = { ok: false, reason: e.message }
  }
  times.push(Date.now() - t)
  ticks++
  if (!s.ok) fails++
  const line = brief(s)
  if (line !== last) {
    last = line
    console.log(`[${new Date().toTimeString().slice(0, 8)}] ${line}`)
    try {
      appendFileSync(logPath, JSON.stringify({ t: Date.now(), snap: s }) + '\n')
    } catch {}
  }
  if (Date.now() > stop) {
    clearInterval(timer)
    times.sort((a, b) => a - b)
    console.log(
      `\nticks=${ticks} failures=${fails} (${((1 - fails / ticks) * 100).toFixed(1)}% ok)  ` +
        `snapshot p50=${times[Math.floor(times.length / 2)]}ms p95=${times[Math.floor(times.length * 0.95)]}ms max=${times[times.length - 1]}ms`
    )
    h.close()
  }
}, 250)
