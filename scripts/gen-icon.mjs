// Generates the Reliquary app icon (faceted purple relic-orb on a dark rounded
// panel) with no image libraries: renders at 1024px, box-downsamples for AA,
// and encodes PNGs + a multi-size ICO by hand (zlib only).
// Usage: node scripts/gen-icon.mjs [buildDir] [resourcesDir]
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] || 'build'
const RES = process.argv[3] || 'resources'
mkdirSync(OUT, { recursive: true })
mkdirSync(RES, { recursive: true })

const S = 1024
const buf = new Uint8ClampedArray(S * S * 4)
const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  buf[i] = r
  buf[i + 1] = g
  buf[i + 2] = b
  buf[i + 3] = a
}
const lerp = (a, b, t) => a + (b - a) * t
const mix = (c0, c1, t) => [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)]
// multi-stop gradient: stops = [[t,[r,g,b]], ...]
const grad = (stops, t) => {
  t = Math.max(0, Math.min(1, t))
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1]
      const b = stops[i]
      return mix(a[1], b[1], (t - a[0]) / (b[0] - a[0] || 1))
    }
  }
  return stops[stops.length - 1][1]
}

// ── palette (Reliquary violet) ──
const BORDER = [70, 64, 58]
const BG_TOP = [44, 40, 36]
const BG_BOT = [20, 17, 15]
const FACET_L = [158, 118, 232] // #9E76E8
const FACET_D = [76, 51, 130] // #4C3382
const TABLE = [46, 30, 78] // #2E1E4E
const OUTLINE = [27, 16, 48] // #1B1030
const HALO = [180, 123, 255] // #B47BFF
const HILITE = [243, 233, 255]
const CORE = [
  [0.0, [235, 217, 255]],
  [0.32, [180, 123, 255]],
  [0.7, [107, 63, 190]],
  [1.0, [42, 27, 71]]
]

// ── rounded-panel background ──
const margin = S * 0.055
const rad = S * 0.2
const border = S * 0.014
const inRR = (x, y, l, t, r, b, rr) => {
  const cx = Math.min(Math.max(x, l + rr), r - rr)
  const cy = Math.min(Math.max(y, t + rr), b - rr)
  return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr
}
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRR(x, y, margin, margin, S - margin, S - margin, rad)) continue
    if (inRR(x, y, margin + border, margin + border, S - margin - border, S - margin - border, rad - border)) {
      const t = (y - margin) / (S - 2 * margin)
      // purple radial glow behind the gem
      const d = Math.hypot((x - S / 2) / S, (y - S * 0.5) / S)
      const glow = Math.max(0, 0.34 - d) * 1.15
      const base = mix(BG_TOP, BG_BOT, t)
      set(
        x,
        y,
        base[0] + glow * (HALO[0] - base[0]),
        base[1] + glow * (HALO[1] - base[1]),
        base[2] + glow * (HALO[2] - base[2])
      )
    } else {
      set(x, y, BORDER[0], BORDER[1], BORDER[2])
    }
  }
}

// ── geometry (256-space × 4) ──
const p = (x, y) => [x * 4, y * 4]
const HEX = [p(128, 32), p(211, 80), p(211, 176), p(128, 224), p(45, 176), p(45, 80)]
const fillTri = (a, b, c, colFn) => {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])))
  const maxX = Math.min(S - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])))
  const maxY = Math.min(S - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
  const area = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
  const A = area(a, b, c)
  if (A === 0) return
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const q = [x + 0.5, y + 0.5]
      if (area(b, c, q) / A >= 0 && area(c, a, q) / A >= 0 && area(a, b, q) / A >= 0) {
        const col = typeof colFn === 'function' ? colFn(x, y) : colFn
        set(x, y, col[0], col[1], col[2])
      }
    }
  }
}
const fillPoly = (pts, col) => {
  for (let i = 1; i < pts.length - 1; i++) fillTri(pts[0], pts[i], pts[i + 1], col)
}
const scaleAbout = (pt, cx, cy, s) => [cx + (pt[0] - cx) * s, cy + (pt[1] - cy) * s]

// outline: enlarged dark hex behind the facets
const GC = [512, 512]
fillPoly(HEX.map((pt) => scaleAbout(pt, GC[0], GC[1], 1.035)), OUTLINE)

// facets
fillPoly([p(128, 32), p(211, 80), p(173, 102), p(128, 76)], FACET_L)
fillPoly([p(211, 80), p(211, 176), p(173, 154), p(173, 102)], FACET_D)
fillPoly([p(211, 176), p(128, 224), p(128, 180), p(173, 154)], FACET_L)
fillPoly([p(128, 224), p(45, 176), p(83, 154), p(128, 180)], FACET_D)
fillPoly([p(45, 176), p(45, 80), p(83, 102), p(83, 154)], FACET_L)
fillPoly([p(45, 80), p(128, 32), p(128, 76), p(83, 102)], FACET_D)
fillPoly([p(128, 76), p(173, 102), p(173, 154), p(128, 180), p(83, 154), p(83, 102)], TABLE)

// glowing core (radial)
const core = p(128, 124)
const coreR = 34 * 4
for (let y = core[1] - coreR; y <= core[1] + coreR; y++) {
  for (let x = core[0] - coreR; x <= core[0] + coreR; x++) {
    const d = Math.hypot(x - core[0], y - core[1])
    if (d <= coreR) {
      const col = grad(CORE, d / coreR)
      set(Math.round(x), Math.round(y), col[0], col[1], col[2])
    }
  }
}
// specular highlight
const hi = p(119, 113)
for (let y = hi[1] - 40; y <= hi[1] + 40; y++) {
  for (let x = hi[0] - 52; x <= hi[0] + 52; x++) {
    const d = ((x - hi[0]) / 46) ** 2 + ((y - hi[1]) / 30) ** 2
    if (d <= 1) {
      const a = (1 - d) * 0.8
      const i = (y * S + x) * 4
      set(x, y, lerp(buf[i], HILITE[0], a), lerp(buf[i + 1], HILITE[1], a), lerp(buf[i + 2], HILITE[2], a))
    }
  }
}

// ── downsample (box filter) ──
function downsample(src, srcS, dstS) {
  const out = new Uint8ClampedArray(dstS * dstS * 4)
  const f = srcS / dstS
  for (let y = 0; y < dstS; y++) {
    for (let x = 0; x < dstS; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = Math.floor(y * f); sy < (y + 1) * f; sy++) {
        for (let sx = Math.floor(x * f); sx < (x + 1) * f; sx++) {
          const i = (sy * srcS + sx) * 4
          const al = src[i + 3] / 255
          r += src[i] * al
          g += src[i + 1] * al
          b += src[i + 2] * al
          a += src[i + 3]
          n++
        }
      }
      const j = (y * dstS + x) * 4
      const aa = a / n
      const pm = a > 0 ? 255 / a : 0
      out[j] = r * pm
      out[j + 1] = g * pm
      out[j + 2] = b * pm
      out[j + 3] = aa
    }
  }
  return out
}

// ── PNG encoder ──
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (bytes) => {
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = rgba[y * size * 4 + x]
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const sizes = [256, 128, 64, 48, 32, 16]
const pngs = {}
for (const s of sizes) pngs[s] = encodePng(downsample(buf, S, s), s)
writeFileSync(join(OUT, 'icon.png'), encodePng(downsample(buf, S, 512), 512))
writeFileSync(join(RES, 'icon.png'), pngs[256])

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = 6 + sizes.length * 16
const dir = []
const blobs = []
for (const s of sizes) {
  const data = pngs[s]
  const d = Buffer.alloc(16)
  d[0] = s >= 256 ? 0 : s
  d[1] = s >= 256 ? 0 : s
  d.writeUInt16LE(1, 4)
  d.writeUInt16LE(32, 6)
  d.writeUInt32LE(data.length, 8)
  d.writeUInt32LE(offset, 12)
  offset += data.length
  dir.push(d)
  blobs.push(data)
}
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...dir, ...blobs]))
console.log(`Reliquary icon written: ${OUT}/icon.ico (${sizes.join(',')}), icon.png(512); ${RES}/icon.png(256)`)
