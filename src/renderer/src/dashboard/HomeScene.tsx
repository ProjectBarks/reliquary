import { useEffect, useRef, useState, type ReactNode } from 'react'
import styled, { keyframes } from 'styled-components'

/**
 * The "Living Spire" scene — the painted, animated title screen where the
 * status indicators ARE the scene: four faceted relic gems (Game / Overlay /
 * Advisor / Live data) orbit the spire's crown in 3D. Healthy gems burn green,
 * waiting gems amber, broken gems pulse red, disabled gems go dim. When
 * everything is healthy the crown erupts in a gentle aurora; when something
 * breaks the sky darkens.
 *
 * This component is presentation only: callers hand it a scene mood, the one
 * state line, and per-gem status + hover detail. The real Home derives those
 * from live diagnostics; the design mock feeds it canned states.
 *
 * Rendering: one 2D canvas. Static layers (sky, ridges, spire, fog, clouds,
 * grain, vignette) are pre-rendered to offscreen sprites on resize; the rAF
 * loop only composites sprites and draws cheap particles/gems, so it holds
 * 60fps without layout work. prefers-reduced-motion renders a single static
 * frame with all gems visible on the front arc.
 *
 * A `?hover=<gem>` hash query pins a gem caption open for screenshots.
 */

export type GemKey = 'game' | 'overlay' | 'advisor' | 'live'
export type GemStatus = 'ok' | 'wait' | 'bad' | 'off'
export type SceneState = 'connected' | 'waiting' | 'demo' | 'broken'

export interface GemInfo {
  status: GemStatus
  detail: string
}

export type SceneGems = Record<GemKey, GemInfo>

export const GEM_ORDER: GemKey[] = ['game', 'overlay', 'advisor', 'live']
export const GEM_NAMES: Record<GemKey, string> = {
  game: 'Game',
  overlay: 'Overlay',
  advisor: 'Advisor',
  live: 'Live data'
}

function parseForcedHover(): GemKey | null {
  const m = /[?&]hover=([a-z]+)/.exec(window.location.hash)
  const k = m?.[1]
  return k === 'game' || k === 'overlay' || k === 'advisor' || k === 'live' ? k : null
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export interface HomeSceneProps {
  scene: SceneState
  /** The one line that names what is happening, under the title. */
  line: string
  /** Optional second line: what to do next, when there is something. */
  sub?: string | null
  gems: SceneGems
  /** Extra chrome rendered over the scene (update strip, keycaps, toolbars). */
  children?: ReactNode
}

export function HomeScene({ scene, line, sub, gems, children }: HomeSceneProps): JSX.Element {
  const [hover, setHover] = useState<GemKey | null>(() => parseForcedHover())

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const captionRef = useRef<HTMLDivElement>(null)

  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const gemsRef = useRef(gems)
  gemsRef.current = gems
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  const forcedHoverRef = useRef<GemKey | null>(parseForcedHover())

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    return startEngine({
      wrap,
      canvas,
      getScene: () => sceneRef.current,
      getGems: () => gemsRef.current,
      getHover: () => hoverRef.current,
      getForcedHover: () => forcedHoverRef.current,
      setHover: (k) => {
        if (hoverRef.current !== k) setHover(k)
      },
      getCaptionEl: () => captionRef.current
    })
  }, [])

  const hovered = hover ? gems[hover] : null

  return (
    <Stage ref={wrapRef} data-scene={scene}>
      <Canvas ref={canvasRef} />
      <TitleBlock>
        <Word>Reliquary</Word>
        <Flourish aria-hidden>
          <i />
          <b />
          <i />
        </Flourish>
        <StateLine $tone={scene}>{line}</StateLine>
        {sub ? <SubLine>{sub}</SubLine> : null}
      </TitleBlock>
      {hover && hovered ? (
        <Caption ref={captionRef}>
          <CaptionInner $status={hovered.status}>
            <CaptionName>{GEM_NAMES[hover]}</CaptionName>
            <CaptionDetail>{hovered.detail}</CaptionDetail>
          </CaptionInner>
        </Caption>
      ) : null}
      {children}
    </Stage>
  )
}

/* ------------------------------------------------------------------ */
/* Canvas engine                                                       */
/* ------------------------------------------------------------------ */

interface EngineOpts {
  wrap: HTMLDivElement
  canvas: HTMLCanvasElement
  getScene: () => SceneState
  getGems: () => SceneGems
  getHover: () => GemKey | null
  getForcedHover: () => GemKey | null
  setHover: (k: GemKey | null) => void
  getCaptionEl: () => HTMLDivElement | null
}

interface Star {
  x: number
  y: number
  r: number
  a: number
  phase: number
  speed: number
  tint: string
  glint: boolean
}

interface Particle {
  kind: 'ember' | 'mote'
  x: number
  y: number
  vx: number
  vy: number
  r: number
  age: number
  life: number
  seed: number
}

interface WindowLight {
  x: number
  y: number
  w: number
  h: number
  phase: number
  speed: number
}

interface GemScreen {
  key: GemKey
  x: number
  y: number
  r: number
  z: number
}

/** Fallbacks mirror the shared tokens in overlay.css :root. */
const PALETTE_FALLBACK = {
  green: '#7fff00',
  gold: '#efc851',
  red: '#ff5555',
  aqua: '#2aebbe',
  orange: '#ffa518',
  cream: '#fff6e2',
  gemOff: '#8b8b9a',
  skyNight: '#07071a',
  skyIndigo: '#131233',
  skyViolet: '#2a1c44',
  skyDusk: '#553052',
  skyRose: '#94484a',
  skyEmber: '#d97a4a',
  ground: '#120a1a'
}

function readPalette(): typeof PALETTE_FALLBACK {
  const css = getComputedStyle(document.documentElement)
  const get = (name: string, fb: string): string => css.getPropertyValue(name).trim() || fb
  return {
    green: get('--gem-ok', PALETTE_FALLBACK.green),
    gold: get('--gem-wait', PALETTE_FALLBACK.gold),
    red: get('--gem-bad', PALETTE_FALLBACK.red),
    aqua: get('--sts-color-aqua', PALETTE_FALLBACK.aqua),
    orange: get('--sts-color-orange', PALETTE_FALLBACK.orange),
    cream: get('--sts-color-cream', PALETTE_FALLBACK.cream),
    gemOff: get('--gem-off', PALETTE_FALLBACK.gemOff),
    skyNight: get('--scene-night', PALETTE_FALLBACK.skyNight),
    skyIndigo: get('--scene-indigo', PALETTE_FALLBACK.skyIndigo),
    skyViolet: get('--scene-violet', PALETTE_FALLBACK.skyViolet),
    skyDusk: get('--scene-dusk', PALETTE_FALLBACK.skyDusk),
    skyRose: get('--scene-rose', PALETTE_FALLBACK.skyRose),
    skyEmber: get('--scene-ember', PALETTE_FALLBACK.skyEmber),
    ground: get('--scene-ground', PALETTE_FALLBACK.ground)
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [255, 255, 255]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${a})`
}

/** Deterministic pseudo-random so the painting is stable across resizes. */
function mulberry(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function startEngine(opts: EngineOpts): () => void {
  const { wrap, canvas } = opts
  const maybeCtx = canvas.getContext('2d')
  if (!maybeCtx) return () => undefined
  const ctx: CanvasRenderingContext2D = maybeCtx

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const pal = readPalette()

  let w = 0
  let h = 0
  let dpr = 1

  /* Pre-rendered sprites */
  let skySprite: HTMLCanvasElement | null = null
  let spireSprite: HTMLCanvasElement | null = null
  let vignetteSprite: HTMLCanvasElement | null = null
  let cloudSprites: { img: HTMLCanvasElement; y: number; speed: number; alpha: number }[] = []
  let fogSprites: { img: HTMLCanvasElement; y: number; speed: number; alpha: number }[] = []
  let grainPattern: CanvasPattern | null = null

  let stars: Star[] = []
  let particles: Particle[] = []
  let windows: WindowLight[] = []

  /* Anchors (recomputed on resize) */
  let crownX = 0
  let crownY = 0
  let orbitRx = 0
  let orbitRy = 0
  const orbitTilt = -0.1

  /* Pointer parallax */
  const par = { x: 0, y: 0 }
  const parTarget = { x: 0, y: 0 }

  /* Broken-sky darkening eases toward its target */
  let darken = 0

  const gemScreens: GemScreen[] = []

  function statusColor(s: GemStatus): string {
    if (s === 'ok') return pal.green
    if (s === 'wait') return pal.gold
    if (s === 'bad') return pal.red
    return pal.gemOff
  }

  function crownColor(scene: SceneState): string {
    if (scene === 'connected') return pal.green
    if (scene === 'waiting') return pal.gold
    if (scene === 'demo') return pal.aqua
    return pal.red
  }

  /* ---------------------------------------------------------------- */
  /* Sprite builders                                                   */
  /* ---------------------------------------------------------------- */

  function makeLayer(lw: number, lh: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(lw))
    c.height = Math.max(1, Math.round(lh))
    const g = c.getContext('2d')
    if (!g) throw new Error('2d context unavailable')
    return [c, g]
  }

  function buildSky(): HTMLCanvasElement {
    const [c, g] = makeLayer(w, h)
    const horizon = h * 0.78

    /* Night burning down into sunset — the shared --scene-* ramp */
    const sky = g.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, pal.skyNight)
    sky.addColorStop(0.3, pal.skyIndigo)
    sky.addColorStop(0.52, pal.skyViolet)
    sky.addColorStop(0.66, pal.skyDusk)
    sky.addColorStop(0.76, pal.skyRose)
    sky.addColorStop(0.84, pal.skyEmber)
    sky.addColorStop(1, '#3a2038')
    g.fillStyle = sky
    g.fillRect(0, 0, w, h)

    /* Sun glow behind the spire base */
    g.globalCompositeOperation = 'lighter'
    const sun = g.createRadialGradient(w * 0.5, horizon, 0, w * 0.5, horizon, w * 0.46)
    sun.addColorStop(0, 'rgba(255,190,120,0.55)')
    sun.addColorStop(0.4, 'rgba(240,140,80,0.22)')
    sun.addColorStop(1, 'rgba(240,140,80,0)')
    g.fillStyle = sun
    g.fillRect(0, 0, w, h)

    /* Secondary warm pools left/right for painterly variation */
    const pool = g.createRadialGradient(w * 0.16, horizon + 8, 0, w * 0.16, horizon + 8, w * 0.3)
    pool.addColorStop(0, 'rgba(255,150,90,0.20)')
    pool.addColorStop(1, 'rgba(255,150,90,0)')
    g.fillStyle = pool
    g.fillRect(0, 0, w, h)
    g.globalCompositeOperation = 'source-over'

    /* Pale moon high left with a soft breathing halo */
    const mx = w * 0.17
    const my = h * 0.14
    const halo = g.createRadialGradient(mx, my, 0, mx, my, 110)
    halo.addColorStop(0, 'rgba(235,238,255,0.26)')
    halo.addColorStop(0.3, 'rgba(205,212,255,0.09)')
    halo.addColorStop(1, 'rgba(205,212,255,0)')
    g.fillStyle = halo
    g.fillRect(mx - 120, my - 120, 240, 240)
    g.fillStyle = 'rgba(242,244,254,0.95)'
    g.beginPath()
    g.arc(mx, my, 11, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = 'rgba(160,160,200,0.3)'
    g.beginPath()
    g.arc(mx - 3.4, my - 2.6, 2.8, 0, Math.PI * 2)
    g.arc(mx + 3.6, my + 3.4, 2, 0, Math.PI * 2)
    g.fill()

    /* Distant sibling spires: needle-thin, drowned in atmosphere */
    const distant: [number, number, number][] = [
      [0.235, 0.33, 34],
      [0.775, 0.26, 28]
    ]
    for (const [fx, fh, half] of distant) {
      const bx = w * fx
      const top = horizon - h * fh
      g.fillStyle = 'rgba(50,34,82,0.5)'
      g.beginPath()
      g.moveTo(bx - half, horizon + 4)
      g.lineTo(bx - half * 0.2, top + 22)
      g.lineTo(bx, top)
      g.lineTo(bx + half * 0.24, top + 26)
      g.lineTo(bx + half, horizon + 4)
      g.closePath()
      g.fill()
    }

    /* Mountain ridges: far (hazy) then near (dark) */
    const ridge = (baseY: number, amp: number, color: string, seed: number): void => {
      const rr = mulberry(seed)
      g.fillStyle = color
      g.beginPath()
      g.moveTo(-10, h)
      g.lineTo(-10, baseY)
      /* Irregular peaks: walk across in random-width strides so no two summits
         repeat, with the occasional dominant peak. */
      let x = -10
      while (x < w + 10) {
        const stride = w * (0.03 + rr() * 0.09)
        const major = rr() < 0.22
        const peak = baseY - amp * (major ? 1.4 + rr() * 0.9 : 0.35 + rr() * 0.75)
        g.lineTo(x + stride * (0.35 + rr() * 0.3), peak)
        g.lineTo(x + stride, baseY - amp * rr() * 0.3)
        x += stride
      }
      g.lineTo(w + 10, h)
      g.closePath()
      g.fill()
    }
    ridge(horizon - 4, h * 0.05, 'rgba(58,38,84,0.55)', 11)
    ridge(horizon + 14, h * 0.045, 'rgba(34,21,52,0.85)', 23)

    /* Haze band sitting on the horizon */
    const haze = g.createLinearGradient(0, horizon - h * 0.1, 0, horizon + h * 0.08)
    haze.addColorStop(0, 'rgba(240,150,90,0)')
    haze.addColorStop(0.6, 'rgba(240,150,90,0.16)')
    haze.addColorStop(1, 'rgba(240,150,90,0)')
    g.fillStyle = haze
    g.fillRect(0, horizon - h * 0.1, w, h * 0.2)

    /* Crepuscular rays fanning up from behind the great spire */
    g.save()
    g.globalCompositeOperation = 'lighter'
    g.translate(w * 0.5, horizon + 20)
    for (const ang of [-0.42, -0.24, -0.08, 0.1, 0.3, 0.46]) {
      g.save()
      g.rotate(ang)
      const ray = g.createLinearGradient(0, 0, 0, -h * 0.75)
      ray.addColorStop(0, 'rgba(255,170,110,0.05)')
      ray.addColorStop(0.5, 'rgba(255,170,110,0.02)')
      ray.addColorStop(1, 'rgba(255,170,110,0)')
      g.fillStyle = ray
      g.beginPath()
      g.moveTo(-14, 0)
      g.lineTo(14, 0)
      g.lineTo(90, -h * 0.75)
      g.lineTo(-90, -h * 0.75)
      g.closePath()
      g.fill()
      g.restore()
    }
    g.restore()

    /* Dark foreground ground */
    const ground = g.createLinearGradient(0, horizon + 10, 0, h)
    ground.addColorStop(0, 'rgba(24,13,30,0.0)')
    ground.addColorStop(0.35, 'rgba(20,11,26,0.85)')
    ground.addColorStop(1, '#120a1a')
    g.fillStyle = ground
    g.fillRect(0, horizon, w, h - horizon)

    /* Warm pool of light where the embers rise around the base */
    const basePool = g.createRadialGradient(w * 0.5, h * 0.96, 0, w * 0.5, h * 0.96, w * 0.24)
    basePool.addColorStop(0, 'rgba(255,140,70,0.12)')
    basePool.addColorStop(1, 'rgba(255,140,70,0)')
    g.fillStyle = basePool
    g.fillRect(0, h * 0.7, w, h * 0.3)
    return c
  }

  function buildCloud(seed: number, warm: boolean, cw: number, ch: number): HTMLCanvasElement {
    const [c, g] = makeLayer(cw, ch)
    const rand = mulberry(seed)
    /* Long, low streaks rather than round blobs: each "cloud" is a chain of
       wide, squashed gradients so the layer reads as painted haze. */
    const chains = 5
    g.globalCompositeOperation = 'lighter'
    for (let n = 0; n < chains; n++) {
      const cxr = cw * rand()
      const cyr = ch * (0.35 + rand() * 0.35)
      const len = cw * (0.2 + rand() * 0.3)
      const puffs = 9
      for (let i = 0; i < puffs; i++) {
        const bx = (cxr + (i / puffs - 0.5) * len + cw) % cw
        const by = cyr + Math.sin(i * 1.7 + seed) * ch * 0.06
        const br = ch * (0.16 + rand() * 0.2)
        const grad = g.createRadialGradient(bx, by, 0, bx, by, br)
        if (warm) {
          grad.addColorStop(0, 'rgba(236,140,96,0.065)')
          grad.addColorStop(0.6, 'rgba(190,95,95,0.03)')
        } else {
          grad.addColorStop(0, 'rgba(125,105,185,0.05)')
          grad.addColorStop(0.6, 'rgba(85,75,150,0.025)')
        }
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        g.fillStyle = grad
        g.save()
        g.translate(bx, by)
        g.scale(1.9, 0.65)
        g.beginPath()
        g.arc(0, 0, br, 0, Math.PI * 2)
        g.fill()
        g.restore()
      }
    }
    return c
  }

  /** Half-width profile of the great spire, tip (t=0) to base (t=1). */
  const SPIRE_PROFILE: [number, number][] = [
    [0, 0.028],
    [0.05, 0.1],
    [0.06, 0.075],
    [0.16, 0.14],
    [0.17, 0.105],
    [0.32, 0.185],
    [0.33, 0.15],
    [0.52, 0.25],
    [0.53, 0.205],
    [0.72, 0.33],
    [0.73, 0.285],
    [0.88, 0.44],
    [0.94, 0.62],
    [1, 1]
  ]

  function spireHalfWidthMax(): number {
    return Math.min(w * 0.115, 165)
  }

  function buildSpire(): HTMLCanvasElement {
    const [c, g] = makeLayer(w, h)
    const cx = w * 0.5
    const tipY = h * 0.19
    const baseY = h + 2
    const span = baseY - tipY
    const maxHalf = spireHalfWidthMax()
    const rand = mulberry(41)

    const edge = (side: -1 | 1): [number, number][] =>
      SPIRE_PROFILE.map(([t, f]) => {
        const jag = t > 0 && t < 1 ? (rand() - 0.5) * maxHalf * 0.05 : 0
        const asym = side === 1 ? 1 : 0.94
        return [cx + side * (f * maxHalf * asym + jag), tipY + t * span]
      })

    const right = edge(1)
    const left = edge(-1)

    const body = new Path2D()
    body.moveTo(cx, tipY)
    for (const [x, y] of right) body.lineTo(x, y)
    for (let i = left.length - 1; i >= 0; i--) body.lineTo(left[i][0], left[i][1])
    body.closePath()

    /* Atmospheric back-halo so the spire separates from the sky */
    g.save()
    g.filter = 'blur(20px)'
    g.fillStyle = 'rgba(110,72,130,0.22)'
    g.fill(body)
    g.restore()

    /* Body: near-silhouette, warm underlight at the base */
    const fill = g.createLinearGradient(0, tipY, 0, baseY)
    fill.addColorStop(0, '#0a0916')
    fill.addColorStop(0.5, '#151129')
    fill.addColorStop(0.82, '#241733')
    fill.addColorStop(1, '#3a2136')
    g.fillStyle = fill
    g.fill(body)

    /* Inner cool sheen on the left flank */
    g.save()
    g.clip(body)
    const sheen = g.createLinearGradient(cx - maxHalf, 0, cx + maxHalf * 0.4, 0)
    sheen.addColorStop(0, 'rgba(70,110,140,0.13)')
    sheen.addColorStop(0.55, 'rgba(70,110,140,0)')
    g.fillStyle = sheen
    g.fillRect(cx - maxHalf, tipY, maxHalf * 2, span)
    g.restore()

    /* Faint carved flutes catching the horizon light */
    g.save()
    g.clip(body)
    for (const f of [-0.55, -0.2, 0.3, 0.62]) {
      g.strokeStyle = f > 0 ? 'rgba(255,170,110,0.05)' : 'rgba(120,150,190,0.045)'
      g.lineWidth = 7
      g.beginPath()
      let first = true
      for (const [pt, pf] of SPIRE_PROFILE) {
        const x = cx + pf * maxHalf * f
        const y = tipY + pt * span
        if (first) {
          g.moveTo(x, y)
          first = false
        } else g.lineTo(x, y)
      }
      g.stroke()
    }
    g.restore()

    /* Warm rim light down the right edge (the sunset kissing the stone) */
    g.save()
    const rim = g.createLinearGradient(0, tipY, 0, baseY)
    rim.addColorStop(0, 'rgba(255,190,130,0.10)')
    rim.addColorStop(0.55, 'rgba(255,170,110,0.5)')
    rim.addColorStop(0.9, 'rgba(255,150,95,0.9)')
    rim.addColorStop(1, 'rgba(255,150,95,0.25)')
    g.strokeStyle = rim
    g.lineWidth = 2.2
    g.shadowColor = 'rgba(255,160,100,0.8)'
    g.shadowBlur = 9
    g.beginPath()
    g.moveTo(cx, tipY)
    for (const [x, y] of right) g.lineTo(x, y)
    g.stroke()
    g.restore()

    /* Faint aqua rim on the left edge (night side) */
    g.save()
    g.strokeStyle = rgba(pal.aqua, 0.16)
    g.lineWidth = 1.4
    g.shadowColor = rgba(pal.aqua, 0.4)
    g.shadowBlur = 6
    g.beginPath()
    g.moveTo(cx, tipY)
    for (const [x, y] of left) g.lineTo(x, y)
    g.stroke()
    g.restore()

    /* Rocky foothills hugging the base */
    g.fillStyle = '#170e22'
    for (const [fx, fw, fh] of [
      [0.36, 0.16, 0.1],
      [0.6, 0.2, 0.13],
      [0.47, 0.3, 0.07]
    ] as const) {
      g.beginPath()
      g.moveTo(w * (fx - fw), h + 2)
      g.lineTo(w * fx, h - h * fh)
      g.lineTo(w * (fx + fw), h + 2)
      g.closePath()
      g.fill()
    }

    /* Generate flickering window slits along the body for the live layer */
    windows = []
    const wrand = mulberry(97)
    for (let i = 0; i < 13; i++) {
      const t = 0.3 + wrand() * 0.62
      const half = maxHalf * profileAt(t) * 0.7
      windows.push({
        x: cx + (wrand() * 2 - 1) * half,
        y: tipY + t * span,
        w: 1.6 + wrand() * 1.2,
        h: 2.6 + wrand() * 2.6,
        phase: wrand() * Math.PI * 2,
        speed: 0.4 + wrand() * 0.9
      })
    }
    return c
  }

  function profileAt(t: number): number {
    for (let i = 1; i < SPIRE_PROFILE.length; i++) {
      const [t1, f1] = SPIRE_PROFILE[i]
      const [t0, f0] = SPIRE_PROFILE[i - 1]
      if (t <= t1) {
        const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0)
        return f0 + (f1 - f0) * u
      }
    }
    return 1
  }

  function buildFog(seed: number, fw: number, fh: number): HTMLCanvasElement {
    const [c, g] = makeLayer(fw, fh)
    const rand = mulberry(seed)
    for (let i = 0; i < 26; i++) {
      const bx = fw * rand()
      const by = fh * (0.35 + rand() * 0.4)
      const br = fh * (0.28 + rand() * 0.4)
      const grad = g.createRadialGradient(bx, by, 0, bx, by, br)
      grad.addColorStop(0, 'rgba(185,120,140,0.13)')
      grad.addColorStop(1, 'rgba(185,120,140,0)')
      g.fillStyle = grad
      g.beginPath()
      g.arc(bx, by, br, 0, Math.PI * 2)
      g.fill()
    }
    return c
  }

  function buildVignette(): HTMLCanvasElement {
    const [c, g] = makeLayer(w, h)
    const v = g.createRadialGradient(w / 2, h * 0.52, h * 0.3, w / 2, h * 0.52, h * 0.95)
    v.addColorStop(0, 'rgba(6,5,14,0)')
    v.addColorStop(0.75, 'rgba(6,5,14,0.18)')
    v.addColorStop(1, 'rgba(6,5,14,0.52)')
    g.fillStyle = v
    g.fillRect(0, 0, w, h)
    return c
  }

  function buildGrain(): CanvasPattern | null {
    const [c, g] = makeLayer(140, 140)
    const img = g.createImageData(140, 140)
    const rand = mulberry(5)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 118 + Math.floor(rand() * 20)
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    g.putImageData(img, 0, 0)
    return ctx ? ctx.createPattern(c, 'repeat') : null
  }

  function buildStars(): void {
    const rand = mulberry(13)
    stars = []
    const n = 190
    for (let i = 0; i < n; i++) {
      const tintRoll = rand()
      stars.push({
        x: rand() * w,
        y: rand() * h * 0.62,
        r: 0.5 + rand() * 1.25,
        a: 0.25 + rand() * 0.6,
        phase: rand() * Math.PI * 2,
        speed: 0.4 + rand() * 1.6,
        tint:
          tintRoll < 0.78
            ? '#fff6e2'
            : tintRoll < 0.9
              ? '#bfeaff'
              : '#ffd9a0',
        glint: rand() < 0.05
      })
    }
  }

  function seedParticles(): void {
    const rand = mulberry(29)
    particles = []
    for (let i = 0; i < 48; i++) particles.push(spawnParticle('ember', rand, true))
    for (let i = 0; i < 26; i++) particles.push(spawnParticle('mote', rand, true))
  }

  function spawnParticle(kind: 'ember' | 'mote', rand: () => number, anywhere: boolean): Particle {
    if (kind === 'ember') {
      return {
        kind,
        x: rand() * w,
        y: anywhere ? h * (0.62 + rand() * 0.38) : h * (0.88 + rand() * 0.12),
        vx: (rand() - 0.5) * 6,
        vy: -(12 + rand() * 26),
        r: 0.9 + rand() * 1.6,
        age: anywhere ? rand() * 6 : 0,
        life: 7 + rand() * 8,
        seed: rand() * Math.PI * 2
      }
    }
    return {
      kind,
      x: rand() * w,
      y: h * (0.15 + rand() * 0.6),
      vx: (rand() - 0.5) * 4,
      vy: (rand() - 0.5) * 2.5,
      r: 0.7 + rand() * 1.1,
      age: anywhere ? rand() * 10 : 0,
      life: 12 + rand() * 10,
      seed: rand() * Math.PI * 2
    }
  }

  /* ---------------------------------------------------------------- */
  /* Resize                                                            */
  /* ---------------------------------------------------------------- */

  function resize(): void {
    const rect = wrap.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) return
    w = rect.width
    h = rect.height
    dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    crownX = w * 0.5
    crownY = h * 0.165
    orbitRx = Math.min(w * 0.24, 330)
    orbitRy = orbitRx * 0.36

    skySprite = buildSky()
    spireSprite = buildSpire()
    vignetteSprite = buildVignette()
    grainPattern = buildGrain()
    cloudSprites = [
      { img: buildCloud(51, false, w * 0.8, h * 0.3), y: h * 0.06, speed: 2.4, alpha: 0.9 },
      { img: buildCloud(52, false, w * 0.9, h * 0.34), y: h * 0.3, speed: 4.2, alpha: 0.8 },
      { img: buildCloud(53, true, w, h * 0.32), y: h * 0.5, speed: 6.5, alpha: 1 }
    ]
    fogSprites = [
      { img: buildFog(61, w * 1.1, h * 0.22), y: h * 0.74, speed: 5, alpha: 0.85 },
      { img: buildFog(62, w * 1.2, h * 0.2), y: h * 0.84, speed: -3.4, alpha: 1 }
    ]
    buildStars()
    seedParticles()
    needsRedraw = true
  }

  /* ---------------------------------------------------------------- */
  /* Drawing helpers                                                   */
  /* ---------------------------------------------------------------- */

  function drawGem(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    color: string,
    alpha: number,
    haloBoost: number,
    sparkle: number
  ): void {
    g.save()
    g.globalAlpha = alpha

    /* Halo */
    if (haloBoost > 0.01) {
      g.save()
      g.globalCompositeOperation = 'lighter'
      const hr = r * (3 + haloBoost * 2.2)
      const halo = g.createRadialGradient(x, y, 0, x, y, hr)
      halo.addColorStop(0, rgba(color, 0.5 * haloBoost))
      halo.addColorStop(0.45, rgba(color, 0.16 * haloBoost))
      halo.addColorStop(1, rgba(color, 0))
      g.fillStyle = halo
      g.beginPath()
      g.arc(x, y, hr, 0, Math.PI * 2)
      g.fill()
      g.restore()
    }

    /* Crystal body: elongated hexagonal cut */
    const top = { x, y: y - r * 1.45 }
    const ul = { x: x - r * 0.92, y: y - r * 0.34 }
    const ur = { x: x + r * 0.92, y: y - r * 0.34 }
    const ll = { x: x - r * 0.56, y: y + r * 0.7 }
    const lr = { x: x + r * 0.56, y: y + r * 0.7 }
    const bot = { x, y: y + r * 1.35 }

    const body = new Path2D()
    body.moveTo(top.x, top.y)
    body.lineTo(ur.x, ur.y)
    body.lineTo(lr.x, lr.y)
    body.lineTo(bot.x, bot.y)
    body.lineTo(ll.x, ll.y)
    body.lineTo(ul.x, ul.y)
    body.closePath()

    const grad = g.createLinearGradient(x, top.y, x, bot.y)
    grad.addColorStop(0, rgba('#ffffff', 0.9))
    grad.addColorStop(0.22, color)
    grad.addColorStop(1, rgba('#000000', 0.55))
    g.fillStyle = grad
    g.fill(body)

    /* Facet lines */
    g.strokeStyle = 'rgba(255,255,255,0.4)'
    g.lineWidth = Math.max(0.6, r * 0.06)
    g.beginPath()
    g.moveTo(ul.x, ul.y)
    g.lineTo(ur.x, ur.y)
    g.moveTo(top.x, top.y)
    g.lineTo(x, y - r * 0.34)
    g.lineTo(bot.x, bot.y)
    g.moveTo(x, y - r * 0.34)
    g.lineTo(ll.x, ll.y)
    g.moveTo(x, y - r * 0.34)
    g.lineTo(lr.x, lr.y)
    g.stroke()

    /* Dark facet shading on the right-lower cut */
    const shade = new Path2D()
    shade.moveTo(x, y - r * 0.34)
    shade.lineTo(ur.x, ur.y)
    shade.lineTo(lr.x, lr.y)
    shade.lineTo(bot.x, bot.y)
    shade.closePath()
    g.fillStyle = 'rgba(0,0,0,0.22)'
    g.fill(shade)

    /* Rim + specular glint */
    g.strokeStyle = rgba(color, 0.85)
    g.lineWidth = Math.max(0.8, r * 0.09)
    g.stroke(body)
    g.fillStyle = `rgba(255,255,255,${0.55 + sparkle * 0.45})`
    g.beginPath()
    g.arc(x - r * 0.32, y - r * 0.62, r * 0.16 * (1 + sparkle * 0.6), 0, Math.PI * 2)
    g.fill()
    g.restore()
  }

  function drawGlintStar(g: CanvasRenderingContext2D, x: number, y: number, r: number, a: number): void {
    g.save()
    g.globalAlpha = a
    g.strokeStyle = '#fff6e2'
    g.lineWidth = 0.8
    g.beginPath()
    g.moveTo(x - r * 3, y)
    g.lineTo(x + r * 3, y)
    g.moveTo(x, y - r * 3)
    g.lineTo(x, y + r * 3)
    g.stroke()
    g.restore()
  }

  /**
   * Aurora curtains above the crown. Drawn as dozens of thin vertical gradient
   * streaks along a gentle arc, into a quarter-resolution layer that is then
   * scaled up — the upscale plus a small blur gives the soft, gauzy read for
   * almost nothing.
   */
  let auroraLayer: HTMLCanvasElement | null = null
  function drawAurora(g: CanvasRenderingContext2D, t: number, strength: number): void {
    if (strength <= 0.01) return
    const s = 0.28
    const lw = Math.ceil(w * s)
    const lh = Math.ceil(h * 0.42 * s)
    if (!auroraLayer || auroraLayer.width !== lw || auroraLayer.height !== lh) {
      auroraLayer = document.createElement('canvas')
      auroraLayer.width = lw
      auroraLayer.height = lh
    }
    const a = auroraLayer.getContext('2d')
    if (!a) return
    a.setTransform(1, 0, 0, 1, 0, 0)
    a.clearRect(0, 0, lw, lh)
    a.setTransform(s, 0, 0, s, 0, 0)
    a.globalCompositeOperation = 'lighter'
    a.filter = 'blur(3px)'
    a.lineCap = 'round'
    /* The crown erupts: a fan of soft rays swaying above the beacon like a
       slow solar flare, green at the heart cooling to aqua then violet at the
       edges. Each ray's length breathes on its own cycle. */
    const originX = crownX
    const originY = h * 0.185
    const rays = 30
    const rnoise = mulberry(311)
    for (let i = 0; i < rays; i++) {
      const u = i / (rays - 1)
      const jit = rnoise()
      /* -1..1, a wide half-dome: edge rays lean far out, center rays stand tall */
      const spreadU = (u - 0.5) * 2
      const ang =
        -Math.PI / 2 +
        spreadU * 1.45 +
        Math.sin(t * 0.4 + jit * 6.3) * 0.07 +
        Math.sin(t * 0.17 + i) * 0.03
      const breatheR = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.6 + jit * 9.4))
      const envR = 0.4 + 0.6 * Math.pow(Math.cos(spreadU * Math.PI * 0.38), 0.8)
      const len = (70 + 200 * breatheR) * envR
      if (len < 12) continue
      const col = Math.abs(spreadU) < 0.34 ? pal.green : Math.abs(spreadU) < 0.72 ? pal.aqua : '#9a7bff'
      /* Bases sit on a loose ring, jittered so they never pile up in one spot */
      const base = 40 + jit * 26
      const x0 = originX + Math.cos(ang) * base
      const y0 = originY + Math.sin(ang) * base
      const x1 = originX + Math.cos(ang) * (base + len)
      const y1 = originY + Math.sin(ang) * (base + len)
      const grad = a.createLinearGradient(x0, y0, x1, y1)
      grad.addColorStop(0, rgba(col, 0.16 * strength * envR))
      grad.addColorStop(0.35, rgba(col, 0.11 * strength * envR))
      grad.addColorStop(1, rgba(col, 0))
      a.strokeStyle = grad
      a.lineWidth = 12 - 5 * Math.abs(spreadU)
      a.beginPath()
      a.moveTo(x0, y0)
      /* Slight curve so rays feel like fabric, not spokes */
      a.quadraticCurveTo(
        (x0 + x1) / 2 + Math.sin(t * 0.5 + jit * 7) * 12,
        (y0 + y1) / 2,
        x1,
        y1
      )
      a.stroke()
    }
    a.filter = 'none'
    g.save()
    g.globalCompositeOperation = 'lighter'
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    g.drawImage(auroraLayer, 0, 0, lw, lh, 0, 0, w, h * 0.42)
    g.restore()
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  let auroraStrength = 0
  let needsRedraw = true
  let lastTime = -1

  function frame(t: number, dt: number): void {
    if (!skySprite || !spireSprite || !vignetteSprite) return
    const scene = opts.getScene()
    const gems = opts.getGems()
    const anyBad = GEM_ORDER.some((k) => gems[k].status === 'bad')
    const allOk = GEM_ORDER.every((k) => gems[k].status === 'ok')

    /* Eased scene moods */
    const dk = anyBad ? 0.26 : 0
    darken += (dk - darken) * Math.min(1, dt * 2)
    auroraStrength += ((allOk ? 1 : 0) - auroraStrength) * Math.min(1, dt * 1.4)
    par.x += (parTarget.x - par.x) * Math.min(1, dt * 3)
    par.y += (parTarget.y - par.y) * Math.min(1, dt * 3)

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    /* 1 — painted sky (slight counter-parallax for depth) */
    ctx.drawImage(skySprite, par.x * -3, par.y * -2)

    /* 2 — twinkling stars */
    for (const s of stars) {
      const tw = 0.72 + 0.28 * Math.sin(t * s.speed + s.phase)
      ctx.globalAlpha = s.a * tw
      ctx.fillStyle = s.tint
      ctx.beginPath()
      ctx.arc(s.x + par.x * -4, s.y + par.y * -3, s.r, 0, Math.PI * 2)
      ctx.fill()
      if (s.glint) drawGlintStar(ctx, s.x + par.x * -4, s.y + par.y * -3, s.r, s.a * tw * 0.5)
    }
    ctx.globalAlpha = 1

    /* 3 — drifting cloud layers */
    for (const cl of cloudSprites) {
      const cw = cl.img.width
      const off = (((t * cl.speed) % cw) + cw) % cw
      ctx.globalAlpha = cl.alpha
      ctx.drawImage(cl.img, -off + par.x * -6, cl.y)
      ctx.drawImage(cl.img, -off + cw + par.x * -6, cl.y)
      if (-off + cw < w) ctx.drawImage(cl.img, -off + cw * 2 + par.x * -6, cl.y)
      ctx.globalAlpha = 1
    }

    /* 4 — gems on the far side of the orbit (behind the spire) */
    const crownCol = crownColor(scene)
    gemScreens.length = 0
    const cosT = Math.cos(orbitTilt)
    const sinT = Math.sin(orbitTilt)
    const orbitPoint = (a: number, bobSeed: number): { x: number; y: number; z: number } => {
      const ox = Math.cos(a) * orbitRx
      const oy = Math.sin(a) * orbitRy
      return {
        x: crownX + ox * cosT - oy * sinT + par.x * -9,
        y: crownY + ox * sinT + oy * cosT + Math.sin(t * 0.9 + bobSeed) * 3 + par.y * -6,
        z: Math.sin(a)
      }
    }
    GEM_ORDER.forEach((key, i) => {
      const a = reduced ? [0.35, 1.2, 1.94, 2.79][i] : t * 0.14 + (i * Math.PI) / 2
      const p = orbitPoint(a, i * 1.9)
      const scale = 0.62 + 0.5 * ((p.z + 1) / 2)
      gemScreens.push({ key, x: p.x, y: p.y, r: 13.5 * scale, z: p.z })

      /* A comet-tail of fading sparks along the path just travelled */
      if (!reduced) {
        const gd = gems[key]
        if (gd.status !== 'off') {
          const col = statusColor(gd.status)
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          for (let j = 1; j <= 6; j++) {
            const tp = orbitPoint(a - j * 0.055, i * 1.9)
            const ts = 0.62 + 0.5 * ((tp.z + 1) / 2)
            ctx.globalAlpha = 0.16 * (1 - j / 7)
            ctx.fillStyle = col
            ctx.beginPath()
            ctx.arc(tp.x, tp.y, 2.6 * ts * (1 - j / 9), 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.restore()
        }
      }
    })

    /* Faint orbit ring, a whisper of gold */
    ctx.save()
    ctx.translate(crownX + par.x * -9, crownY + par.y * -6)
    ctx.rotate(orbitTilt)
    ctx.strokeStyle = rgba(pal.gold, 0.045)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.ellipse(0, 0, orbitRx, orbitRy, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()

    const hoverKey = opts.getForcedHover() ?? opts.getHover()
    const renderGem = (gs: GemScreen): void => {
      const gd = gems[gs.key]
      const col = statusColor(gd.status)
      const behind = gs.z < 0
      let pulse = 0.16 + 0.1 * Math.sin(t * 1.3 + gs.x * 0.01)
      if (gd.status === 'wait') pulse = 0.3 + 0.25 * Math.sin(t * 2.2)
      if (gd.status === 'bad') pulse = 0.55 + 0.45 * Math.sin(t * 4.5)
      const halo = gd.status === 'off' ? 0 : 0.55 + pulse
      const alpha = (behind ? 0.55 : 1) * (gd.status === 'off' ? 0.75 : 1)
      const hoverBoost = hoverKey === gs.key ? 0.5 : 0
      drawGem(ctx, gs.x, gs.y, gs.r * (1 + hoverBoost * 0.14), col, alpha, halo + hoverBoost, pulse)
    }
    for (const gs of gemScreens.filter((s) => s.z < 0).sort((p, q) => p.z - q.z)) renderGem(gs)

    /* 5 — the great spire */
    ctx.drawImage(spireSprite, par.x * -8, par.y * -5)

    /* Windows flicker warm inside the stone */
    for (const win of windows) {
      const fl = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(t * win.speed + win.phase))
      ctx.globalAlpha = fl
      ctx.fillStyle = '#ffb35e'
      ctx.fillRect(win.x + par.x * -8, win.y + par.y * -5, win.w, win.h)
    }
    ctx.globalAlpha = 1

    /* 6 — crown beacon breathing above the tip */
    const bx = crownX + par.x * -8
    const by = h * 0.182 + par.y * -5
    const breathe = 0.82 + 0.18 * Math.sin(t * 1.1)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const beaconR = 56 * breathe
    const beacon = ctx.createRadialGradient(bx, by, 0, bx, by, beaconR)
    beacon.addColorStop(0, rgba(crownCol, 0.55))
    beacon.addColorStop(0.35, rgba(crownCol, 0.18))
    beacon.addColorStop(1, rgba(crownCol, 0))
    ctx.fillStyle = beacon
    ctx.beginPath()
    ctx.arc(bx, by, beaconR, 0, Math.PI * 2)
    ctx.fill()
    /* Soft upward exhalation: an elliptical glow with no hard edges */
    ctx.save()
    ctx.translate(bx, by - 24)
    ctx.scale(1, 2.1)
    const exhale = ctx.createRadialGradient(0, 0, 0, 0, 0, 34)
    exhale.addColorStop(0, rgba(crownCol, 0.10 * breathe))
    exhale.addColorStop(1, rgba(crownCol, 0))
    ctx.fillStyle = exhale
    ctx.beginPath()
    ctx.arc(0, 0, 34, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.restore()
    ctx.fillStyle = rgba('#ffffff', 0.85)
    ctx.beginPath()
    ctx.arc(bx, by, 3.4 * breathe, 0, Math.PI * 2)
    ctx.fill()

    /* 7 — aurora when everything is healthy */
    drawAurora(ctx, t, auroraStrength)

    /* 8 — gems on the near side of the orbit */
    for (const gs of gemScreens.filter((s) => s.z >= 0).sort((p, q) => p.z - q.z)) renderGem(gs)

    /* 9 — embers and drifting motes */
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const p of particles) {
      if (!reduced) {
        p.age += dt
        p.x += (p.vx + Math.sin(t * 0.7 + p.seed) * (p.kind === 'ember' ? 6 : 3)) * dt
        p.y += p.vy * dt
        const ceiling = p.kind === 'ember' ? h * 0.34 : -20
        if (p.age > p.life || p.y < ceiling || p.x < -20 || p.x > w + 20) {
          const rand = mulberry(Math.floor(p.seed * 1e6) + Math.floor(t * 997))
          Object.assign(p, spawnParticle(p.kind, rand, false))
        }
      }
      const fade = Math.sin(Math.min(1, p.age / p.life) * Math.PI)
      if (p.kind === 'ember') {
        const flick = 0.6 + 0.4 * Math.sin(t * 6 + p.seed * 9)
        ctx.globalAlpha = 0.16 * fade * flick
        ctx.fillStyle = '#ff8a3c'
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r * 1.9, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 0.7 * fade * flick
        ctx.fillStyle = '#ffc07a'
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.globalAlpha = 0.14 * fade
        ctx.fillStyle = '#fff6e2'
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()

    /* 10 — ground fog drifting */
    for (const f of fogSprites) {
      const fw = f.img.width
      const off = (((t * f.speed) % fw) + fw) % fw
      ctx.globalAlpha = f.alpha
      ctx.drawImage(f.img, -off + par.x * -14, f.y)
      ctx.drawImage(f.img, -off + (f.speed >= 0 ? fw : -fw) + par.x * -14, f.y)
      ctx.globalAlpha = 1
    }

    /* 11 — film grain for the painted feel */
    if (grainPattern) {
      ctx.save()
      ctx.globalAlpha = 0.05
      ctx.globalCompositeOperation = 'overlay'
      ctx.fillStyle = grainPattern
      ctx.fillRect(0, 0, w, h)
      ctx.restore()
    }

    /* 12 — vignette + broken-world gloom */
    ctx.drawImage(vignetteSprite, 0, 0)
    if (darken > 0.005) {
      ctx.fillStyle = `rgba(8,4,16,${darken})`
      ctx.fillRect(0, 0, w, h)
    }

    /* Caption follows its gem */
    const capEl = opts.getCaptionEl()
    if (capEl && hoverKey) {
      const gs = gemScreens.find((s) => s.key === hoverKey)
      if (gs) {
        /* Keep the caption on-stage: flip below the gem near the top edge,
           clamp horizontally near the sides. */
        const below = gs.y - gs.r * 2.1 < 76
        const cx = Math.min(w - 120, Math.max(120, gs.x))
        const cy = below ? gs.y + gs.r * 2.1 : gs.y - gs.r * 2.1
        capEl.dataset.pos = below ? 'below' : 'above'
        capEl.style.transform = `translate(${cx}px, ${cy}px)`
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Loop + events                                                     */
  /* ---------------------------------------------------------------- */

  let raf = 0
  let lastScene: SceneState | null = null
  let lastGems: SceneGems | null = null
  let lastHover: GemKey | null | 'unset' = 'unset'

  const loop = (ms: number): void => {
    raf = requestAnimationFrame(loop)
    const t = ms / 1000
    const dt = lastTime < 0 ? 1 / 60 : Math.min(0.05, t - lastTime)
    lastTime = t
    const scene = opts.getScene()
    const gems = opts.getGems()
    const hov = opts.getForcedHover() ?? opts.getHover()
    if (reduced) {
      if (!needsRedraw && scene === lastScene && gems === lastGems && hov === lastHover) return
      lastScene = scene
      lastGems = gems
      lastHover = hov
      needsRedraw = false
      /* Fixed, composed moment: darken/aurora snap to their targets. */
      darken = GEM_ORDER.some((k) => gems[k].status === 'bad') ? 0.26 : 0
      auroraStrength = GEM_ORDER.every((k) => gems[k].status === 'ok') ? 1 : 0
      frame(4.2, 0)
      return
    }
    frame(t, dt)
  }

  const onPointerMove = (e: PointerEvent): void => {
    const rect = wrap.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    parTarget.x = (mx / Math.max(1, w) - 0.5) * 2
    parTarget.y = (my / Math.max(1, h) - 0.5) * 2
    if (opts.getForcedHover()) return
    let best: GemKey | null = null
    let bestD = 42
    for (const gs of gemScreens) {
      const d = Math.hypot(gs.x - mx, gs.y - my)
      if (d < bestD) {
        bestD = d
        best = gs.key
      }
    }
    opts.setHover(best)
    needsRedraw = true
  }

  const onPointerLeave = (): void => {
    parTarget.x = 0
    parTarget.y = 0
    if (!opts.getForcedHover()) opts.setHover(null)
    needsRedraw = true
  }

  const observer = new ResizeObserver(resize)
  observer.observe(wrap)
  resize()
  wrap.addEventListener('pointermove', onPointerMove)
  wrap.addEventListener('pointerleave', onPointerLeave)
  raf = requestAnimationFrame(loop)

  return () => {
    cancelAnimationFrame(raf)
    observer.disconnect()
    wrap.removeEventListener('pointermove', onPointerMove)
    wrap.removeEventListener('pointerleave', onPointerLeave)
  }
}

/* ------------------------------------------------------------------ */
/* Styled DOM layers                                                   */
/* ------------------------------------------------------------------ */

const titleDrift = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-7px); }
`

const Stage = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #0b0a1c;
  user-select: none;
`

const Canvas = styled.canvas`
  position: absolute;
  inset: 0;
  display: block;
`

const TitleBlock = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  top: 44%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  text-align: center;
  pointer-events: none;
  animation: ${titleDrift} 9s ease-in-out infinite;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

const Word = styled.h1`
  margin: 0;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(58px, 8.5vw, 96px);
  letter-spacing: 0.015em;
  color: var(--sts-color-cream);
  text-shadow:
    0 3px 0 oklch(0 0 0 / 60%),
    0 10px 34px oklch(0 0 0 / 55%),
    0 0 56px oklch(0.78 0.1 85 / 30%),
    0 0 120px oklch(0.7 0.12 300 / 28%);
`

/** Parchment-divider flourish: two fading rules meeting at a gold facet. */
const Flourish = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin: -2px 0 -4px;
  i {
    display: block;
    width: 120px;
    height: 1px;
    background: linear-gradient(to left, color-mix(in oklch, var(--sts-color-gold) 55%, transparent), transparent);
  }
  i:first-child {
    background: linear-gradient(to right, color-mix(in oklch, var(--sts-color-gold) 55%, transparent), transparent);
  }
  b {
    display: block;
    width: 7px;
    height: 7px;
    transform: rotate(45deg);
    background: var(--sts-color-gold);
    box-shadow: 0 0 10px color-mix(in oklch, var(--sts-color-gold) 70%, transparent);
  }
`

const StateLine = styled.p<{ $tone: SceneState }>`
  margin: 0;
  font-family: var(--font-display);
  font-size: 17px;
  letter-spacing: 0.34em;
  text-indent: 0.34em;
  text-transform: uppercase;
  color: ${(p) => (p.$tone === 'broken' ? 'var(--sts-color-red)' : 'var(--sts-color-gold)')};
  text-shadow:
    0 2px 0 oklch(0 0 0 / 65%),
    0 0 26px
      ${(p) =>
        p.$tone === 'broken'
          ? 'color-mix(in oklch, var(--sts-color-red) 55%, transparent)'
          : 'color-mix(in oklch, var(--sts-color-gold) 45%, transparent)'};
`

/**
 * The sentence that turns the title screen into an instruction ("Start the
 * game…"). Held to one quiet line so the scene keeps its stillness.
 */
const SubLine = styled.p`
  margin: -4px 0 0;
  max-width: 52ch;
  padding: 0 16px;
  font-size: 13px;
  line-height: var(--lh-prose);
  color: oklch(1 0 0 / 72%);
  text-shadow:
    0 1px 0 oklch(0 0 0 / 70%),
    0 4px 18px oklch(0 0 0 / 60%);
`

const Caption = styled.div`
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  will-change: transform;

  /* Near the top edge the caption flips underneath its gem. */
  &[data-pos='below'] > div {
    transform: translate(-50%, 14px);
    &::after {
      bottom: auto;
      top: -5px;
      transform: translateX(-50%) rotate(225deg);
    }
  }
`

const CaptionInner = styled.div<{ $status: GemStatus }>`
  transform: translate(-50%, -100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 18px 9px;
  border-radius: 10px;
  background: var(--panel-veil);
  border: 1px solid
    ${(p) =>
      p.$status === 'bad'
        ? 'color-mix(in oklch, var(--sts-color-red) 55%, transparent)'
        : 'var(--trim-gold)'};
  box-shadow:
    0 10px 30px oklch(0 0 0 / 45%),
    inset 0 1px 0 oklch(1 0 0 / 10%);
  &::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -5px;
    width: 9px;
    height: 9px;
    transform: translateX(-50%) rotate(45deg);
    background: var(--panel-veil);
    border-right: 1px solid oklch(1 0 0 / 14%);
    border-bottom: 1px solid oklch(1 0 0 / 14%);
  }
`

const CaptionName = styled.span`
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--sts-color-cream);
`

const CaptionDetail = styled.span`
  font-size: 12px;
  white-space: nowrap;
  color: oklch(1 0 0 / 66%);
`
