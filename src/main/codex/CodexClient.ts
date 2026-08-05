/* eslint-disable @typescript-eslint/no-explicit-any */

import { request as httpsRequest } from 'https'
import { telemetry } from '../telemetry/Telemetry'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { CodexStatus } from '@shared/types'
import type { RawItem } from '../scry/readers'

/**
 * Spire Codex advisor client (spire-codex.com).
 *
 * Two jobs, split by the API's 15-req/min-per-endpoint limit:
 *   1. PRIME — fetch whole-table artifacts (scores/metrics/cards, scores/relics,
 *      the card/relic vocabularies) once per API snapshot version and cache them
 *      to a flat JSON file in userData. These power synchronous "context stats"
 *      lookups with zero per-pick network cost.
 *   2. ADVISE — deck-conditioned scoring via POST /api/draft-advice, called only
 *      when a *new* offer set is stable (see provider's ScoreCache), never per
 *      poll.
 *
 * Every id is validated against the primed vocabulary before use: the API
 * prettifies unknown ids into plausible card names and returns zeros, so an
 * unvalidated miss would render a fabricated card. Unknown ⇒ "no data".
 */

const BASE = 'https://spire-codex.com'
const HTTP_TIMEOUT = 15000

// ── primed snapshot shape ────────────────────────────────────────────────────

interface ScoreRow {
  score: number
  elo: number
  win_rate: number
  picks: number
}

interface MetricRow {
  tier: string
  score: number
  elo: number
  win_rate: number
  pick_rate: number
  picks: number
}

interface Snapshot {
  apiVersion: number
  builtAt: number
  baselineWinRate: number
  cardIds: string[]
  relicIds: string[]
  names: Record<string, string>
  scoresCards: Record<string, ScoreRow>
  metricsCards: Record<string, MetricRow>
  scoresRelics: Record<string, ScoreRow>
  /** population mean/std of card elo & score, for the TRAP z-scores (phase 3). */
  eloMean: number
  eloStd: number
  scoreMean: number
  scoreStd: number
}

/** One offered card's deck-conditioned advice from POST /api/draft-advice. */
export interface DeckAdvice {
  score: number
  base: number
  reasons: string[]
}

export class CodexClient {
  private snap: Snapshot | null = null
  private state: CodexStatus['state'] = 'idle'
  private error: string | null = null
  private priming = false
  private idsSeen = new Set<string>()
  private idsResolved = new Set<string>()

  private get file(): string {
    const dir = join(app.getPath('userData'), 'codex')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'snapshot.json')
  }

  status(): CodexStatus {
    return {
      state: this.state,
      apiVersion: this.snap?.apiVersion ?? null,
      cardVocab: this.snap?.cardIds.length ?? 0,
      relicVocab: this.snap?.relicIds.length ?? 0,
      idsSeen: this.idsSeen.size,
      idsResolved: this.idsResolved.size,
      error: this.error
    }
  }

  /** Prime the snapshot, gated on the API's aggregate version. Idempotent. */
  async prime(): Promise<void> {
    if (this.priming) return
    this.priming = true
    try {
      const ss = await this.get('/api/runs/snapshot-status')
      const wantVersion: number = ss?.version ?? 0
      const building: boolean = !!ss?.building

      if (!this.snap) this.snap = this.loadCache()
      if (this.snap && this.snap.apiVersion === wantVersion) {
        this.state = building ? 'stale' : 'ready'
        this.error = null
        this.log(`prime skip: cache fresh (v${wantVersion}, ${this.snap.cardIds.length} cards)`)
        return
      }
      if (building) {
        // Mid-rebuild: keep serving the old cache rather than priming into a churn.
        this.state = this.snap ? 'stale' : 'priming'
        this.log(`prime deferred: API rebuilding (want v${wantVersion})`)
        return
      }

      this.log(`prime: fetching aggregates for v${wantVersion}…`)
      this.state = 'priming'
      const [cards, relics, scoresCards, metricsCards, scoresRelics] = await Promise.all([
        this.get('/api/cards'),
        this.get('/api/relics'),
        this.get('/api/runs/scores/cards'),
        this.get('/api/runs/metrics/cards?bracket=all'),
        this.get('/api/runs/scores/relics')
      ])

      const names: Record<string, string> = {}
      const cardIds: string[] = []
      for (const c of asArray(cards)) {
        if (!c?.id) continue
        cardIds.push(c.id)
        if (c.name) names[c.id] = c.name
      }
      const relicIds: string[] = []
      for (const r of asArray(relics)) {
        if (!r?.id) continue
        relicIds.push(r.id)
        if (r.name) names[r.id] = r.name
      }

      const sc: Record<string, ScoreRow> = {}
      for (const e of scoreEntries(scoresCards)) sc[e.id] = e
      const sr: Record<string, ScoreRow> = {}
      for (const e of scoreEntries(scoresRelics)) sr[e.id] = e

      const mc: Record<string, MetricRow> = {}
      const elos: number[] = []
      const scores: number[] = []
      for (const row of metricsCards?.rows ?? []) {
        if (!row?.id || row.upgraded) continue // non-upgraded baseline only
        mc[row.id] = {
          tier: row.tier,
          score: row.score,
          elo: row.elo,
          win_rate: row.win_rate,
          pick_rate: row.pick_rate,
          picks: row.picks
        }
        if (Number.isFinite(row.elo)) elos.push(row.elo)
        if (Number.isFinite(row.score)) scores.push(row.score)
      }

      const eloM = moments(elos)
      const scoreM = moments(scores)
      const snap: Snapshot = {
        apiVersion: wantVersion,
        builtAt: ss?.built_at ?? 0,
        baselineWinRate: metricsCards?.baseline_win_rate ?? 0,
        cardIds,
        relicIds,
        names,
        scoresCards: sc,
        metricsCards: mc,
        scoresRelics: sr,
        eloMean: eloM.mean,
        eloStd: eloM.std,
        scoreMean: scoreM.mean,
        scoreStd: scoreM.std
      }
      this.snap = snap
      this.saveCache(snap)
      this.state = 'ready'
      this.error = null
      this.log(
        `prime OK v${wantVersion}: ${cardIds.length} cards, ${relicIds.length} relics, ` +
          `${Object.keys(mc).length} metric rows, baselineWR=${snap.baselineWinRate}`
      )
    } catch (e: any) {
      this.error = e?.message ?? String(e)
      this.state = this.snap ? 'stale' : 'error'
      this.log(`prime FAILED: ${this.error}`)
    } finally {
      this.priming = false
    }
  }

  isReady(): boolean {
    return !!this.snap
  }

  isKnownCard(id: string): boolean {
    return !!this.snap && id in this.snap.metricsCards
  }

  displayName(id: string): string | null {
    return this.snap?.names[id] ?? null
  }

  /**
   * Synchronous global context stats for one offered item (phase 1). Returns the
   * stat rows plus tier/score/confidence, or a known:false marker when the id is
   * not in the vocabulary. No network — reads the primed snapshot only.
   */
  contextStats(item: RawItem): {
    rows: Array<[string, string]>
    tier: string | null
    score: number | null
    confidence: 'high' | 'med' | 'low'
    known: boolean
    trap: number | null
  } | null {
    if (!this.snap || !item.id) return null
    const id = item.id
    const firstSee = item.kind === 'card' && !this.idsSeen.has(id)
    if (item.kind === 'card') this.idsSeen.add(id)

    if (item.kind === 'relic') {
      const s = this.snap.scoresRelics[id]
      const rows: Array<[string, string]> = []
      if (item.cost != null) rows.push(['Cost', `${item.cost}g`])
      if (!s) return { rows, tier: null, score: null, confidence: 'low', known: false, trap: null }
      rows.push(['Score', String(s.score)], ['Win rate', `${s.win_rate.toFixed(0)}%`], ['Sample', fmtCount(s.picks)])
      return { rows, tier: null, score: s.score, confidence: confidenceFor(s.picks), known: true, trap: null }
    }

    if (item.kind === 'card') {
      const m = this.snap.metricsCards[id]
      if (!m) {
        if (firstSee) {
          const upper = id.toUpperCase()
          const hint = upper !== id && upper in this.snap.metricsCards ? ` (uppercase "${upper}" WOULD match — case mismatch!)` : ''
          this.log(`UNRESOLVED card id "${id}" — not in ${this.snap.cardIds.length}-card vocab${hint}`)
        }
        return { rows: [], tier: null, score: null, confidence: 'low', known: false, trap: null }
      }
      if (firstSee) this.log(`resolved card "${id}" → tier ${m.tier}, score ${m.score}`)
      this.idsResolved.add(id)
      const rows: Array<[string, string]> = []
      if (item.cost != null) rows.push(['Cost', `${item.cost}g`])
      rows.push(
        ['Tier', m.tier],
        ['Score', String(m.score)],
        ['Win rate', `${m.win_rate.toFixed(0)}%`],
        ['Pick rate', `${m.pick_rate.toFixed(0)}%`],
        ['Sample', fmtCount(m.picks)]
      )
      return {
        rows,
        tier: m.tier,
        score: m.score,
        confidence: confidenceFor(m.picks),
        known: true,
        trap: this.trapIndex(m)
      }
    }

    // potions / event choices: name-only (endpoints unverified). No fabricated stats.
    const rows: Array<[string, string]> = []
    if (item.cost != null) rows.push(['Cost', `${item.cost}g`])
    return { rows, tier: null, score: null, confidence: 'low', known: false, trap: null }
  }

  /**
   * Deck-conditioned advice for an offer set (phase 2). One POST to
   * /api/draft-advice; the model is deck-aware and not subject to the pairings
   * top-12 cap. Returns a per-offered-id map, or null on failure.
   *
   * NOTE on shapes (verified live): `score`/`base` are 0..1 probabilities (the
   * deck-conditioned vs standalone value), and `reasons` are objects
   * `{ from:"cards:ID", lift, winrate }`, not strings — we flatten them to
   * "Name 80%" here so the renderer never sees a raw object.
   */
  async advise(deck: string[], offer: string[]): Promise<Record<string, DeckAdvice> | null> {
    if (!offer.length) return null
    const body = { deck: deck.map((id) => `cards:${id}`), offered: offer }
    this.log(`advise → deck=${deck.length} offer=[${offer.join(', ')}]`)
    try {
      const res = await this.post('/api/draft-advice', body)
      const ranked: any[] = Array.isArray(res?.ranked) ? res.ranked : []
      const out: Record<string, DeckAdvice> = {}
      for (const r of ranked) {
        if (!r?.id) continue
        out[r.id] = {
          score: typeof r.score === 'number' ? r.score : 0,
          base: typeof r.base === 'number' ? r.base : 0,
          reasons: this.formatReasons(r.reasons)
        }
      }
      this.log(
        `advise ← ${ranked.length} ranked: ` +
          ranked
            .map((r) => `${r.id} score=${num(r.score)} base=${num(r.base)} Δ=${num((r.score ?? 0) - (r.base ?? 0))}`)
            .join(' | ')
      )
      return out
    } catch (e: any) {
      this.log(`advise FAILED: ${e?.message ?? e}`)
      return null
    }
  }

  /** Flatten draft-advice reason objects to readable "Name 80%" strings. */
  private formatReasons(raw: any): string[] {
    if (!Array.isArray(raw)) return []
    const out: string[] = []
    for (const r of raw) {
      if (typeof r === 'string') {
        out.push(r)
        continue
      }
      if (r && typeof r === 'object' && r.from) {
        const id = String(r.from).replace(/^cards:/, '')
        const name = this.displayName(id) ?? prettify(id)
        const wr = typeof r.winrate === 'number' ? ` ${(r.winrate * 100).toFixed(0)}%` : ''
        out.push(`${name}${wr}`)
      }
    }
    return out
  }

  private log(msg: string): void {
    if (process.env['SPECTRA_DEBUG']) console.log(`[codex] ${msg}`)
  }

  // ── TRAP: revealed-preference (elo) vs outcome (score) divergence ──
  private trapIndex(m: MetricRow): number | null {
    if (!this.snap || this.snap.eloStd <= 0 || this.snap.scoreStd <= 0) return null
    const zElo = (m.elo - this.snap.eloMean) / this.snap.eloStd
    const zScore = (m.score - this.snap.scoreMean) / this.snap.scoreStd
    return Number((zElo - zScore).toFixed(2))
  }

  // ── persistence ──
  private loadCache(): Snapshot | null {
    try {
      if (!existsSync(this.file)) return null
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && Array.isArray(raw.cardIds) && raw.metricsCards) return raw as Snapshot
      return null
    } catch {
      return null
    }
  }

  private saveCache(snap: Snapshot): void {
    try {
      writeFileSync(this.file, JSON.stringify(snap))
    } catch {
      // non-fatal: we just re-prime next launch
    }
  }

  // ── HTTP ──
  private get(path: string): Promise<any> {
    return this.json('GET', path)
  }
  private post(path: string, body: unknown): Promise<any> {
    return this.json('POST', path, body)
  }
  // endpoint (path without query) -> earliest epoch ms to call it again, set from
  // a 429/503 so we honor the documented per-endpoint rate limit instead of
  // hammering. Class field initialised inline below.
  private cooldownUntil = new Map<string, number>()

  private json(method: string, path: string, body?: unknown): Promise<any> {
    const endpoint = path.split('?')[0]
    const until = this.cooldownUntil.get(endpoint)
    if (until && Date.now() < until) {
      return Promise.reject(new Error(`rate-limited ${endpoint} (cooling down)`))
    }
    const payload = body != null ? JSON.stringify(body) : null
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        `${BASE}${path}`,
        {
          method,
          timeout: HTTP_TIMEOUT,
          headers: {
            accept: 'application/json',
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {})
          }
        },
        (res) => {
          if (res.statusCode == null || res.statusCode < 200 || res.statusCode >= 300) {
            // Honor rate limiting: back this endpoint off until Retry-After (or 30s).
            let cooldownMs: number | null = null
            if (res.statusCode === 429 || res.statusCode === 503) {
              const ra = Number(res.headers['retry-after'])
              cooldownMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000
              this.cooldownUntil.set(endpoint, Date.now() + cooldownMs)
            }
            // Codex outages/rate limits are the difference between "no numbers"
            // and "wrong numbers"; both look identical to the user.
            telemetry.issue('codex_http_error', res.statusCode === 429 ? 'warn' : 'error', {
              endpoint,
              status: res.statusCode,
              cooldown_ms: cooldownMs
            })
            res.resume()
            reject(new Error(`HTTP ${res.statusCode} ${path}`))
            return
          }
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (buf += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(buf))
            } catch (err) {
              telemetry.issue('codex_bad_json', 'error', { endpoint, bytes: buf.length }, err)
              reject(err)
            }
          })
        }
      )
      req.on('timeout', () => {
        telemetry.issue('codex_timeout', 'warn', { endpoint, timeout_ms: HTTP_TIMEOUT })
        req.destroy(new Error(`timeout ${path}`))
      })
      req.on('error', (err) => {
        telemetry.issue('codex_request_error', 'error', { endpoint }, err)
        reject(err)
      })
      if (payload) req.write(payload)
      req.end()
    })
  }
}

// ── helpers ──

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') return v.cards ?? v.relics ?? v.data ?? []
  return []
}

/** scores/{type} may be an array of rows or an id-keyed object. Normalise. */
function scoreEntries(v: any): Array<{ id: string } & ScoreRow> {
  if (Array.isArray(v)) return v.filter((e) => e?.id)
  if (v && typeof v === 'object') {
    return Object.entries(v).map(([id, r]: [string, any]) => ({ id, ...r }))
  }
  return []
}

/** Compact fixed-3 for log lines; tolerant of undefined/NaN. */
function num(n: any): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(3) : '—'
}

/** "SOME_CARD_ID" -> "Some Card Id" fallback when a display name is missing. */
function prettify(id: string): string {
  return id
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function confidenceFor(picks: number): 'high' | 'med' | 'low' {
  if (picks >= 2000) return 'high'
  if (picks >= 300) return 'med'
  return 'low'
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

function moments(xs: number[]): { mean: number; std: number } {
  const n = xs.length
  if (!n) return { mean: 0, std: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n
  return { mean, std: Math.sqrt(variance) }
}
