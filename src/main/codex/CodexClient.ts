/* eslint-disable @typescript-eslint/no-explicit-any */

import { codexHttp } from './http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { CodexStatus } from '@shared/types'
import type { RawItem } from '../scry/readers'

/**
 * Spire Codex advisor client (spire-codex.com).
 *
 * Two jobs, split by the API's 15-req/min-per-endpoint limit:
 *   1. PRIME — fetch whole-table artifacts (the metrics table and vocabulary for
 *      each of cards, relics and potions) once per API snapshot version and cache
 *      them to a flat JSON file in userData. These power synchronous "context
 *      stats" lookups with zero per-pick network cost.
 *   2. ADVISE — deck-conditioned scoring via POST /api/draft-advice, called only
 *      when a *new* offer set is stable (see provider's ScoreCache), never per
 *      poll.
 *
 * Every id is validated against the primed vocabulary before use: the API
 * prettifies unknown ids into plausible card names and returns zeros, so an
 * unvalidated miss would render a fabricated card. Unknown ⇒ "no data".
 */

// ── primed snapshot shape ────────────────────────────────────────────────────

/**
 * Cache format version, independent of the API's data version.
 *
 * The prime path short-circuits when the cached `apiVersion` still matches the
 * API — which is exactly right for data, and exactly wrong after a shape change:
 * a v1 cache holding cards only would keep satisfying that check and the new
 * relic/potion tables would never be fetched. Bump this whenever `Snapshot`
 * changes so old caches are discarded rather than trusted.
 */
const SNAPSHOT_SCHEMA = 2

/** The three entity families the runs API scores. Also the URL segment. */
type MetricKind = 'cards' | 'relics' | 'potions'

const METRIC_KINDS: MetricKind[] = ['cards', 'relics', 'potions']

/**
 * One row of /api/runs/metrics/{kind}.
 *
 * `elo` and `pick_rate` are nullable and, in practice, populated for cards only —
 * relics and potions come back with both null across every row, because neither
 * is drafted from a ranked offer set the way cards are. Rendering must omit them
 * rather than print a zero that reads as "rated 0".
 */
interface MetricRow {
  tier: string
  score: number
  elo: number | null
  win_rate: number
  pick_rate: number | null
  picks: number
}

interface Snapshot {
  schema: number
  apiVersion: number
  builtAt: number
  baselineWinRate: number
  /** Vocabulary per kind — the ids the API will actually answer for. */
  ids: Record<MetricKind, string[]>
  names: Record<string, string>
  /** Non-upgraded metric rows, keyed by kind then id. */
  metrics: Record<MetricKind, Record<string, MetricRow>>
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
      cardVocab: this.snap?.ids.cards.length ?? 0,
      relicVocab: this.snap?.ids.relics.length ?? 0,
      potionVocab: this.snap?.ids.potions.length ?? 0,
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
        this.log(`prime skip: cache fresh (v${wantVersion}, ${this.snap.ids.cards.length} cards)`)
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
      // Six requests, two per kind: the catalog for display names and the metrics
      // table for tier/score/win-rate. The metrics table is a strict superset of
      // /api/runs/scores/{kind} (verified: every scored id appears in metrics, and
      // metrics additionally carries `tier`), so the scores endpoints are not
      // fetched at all — they were costing a request per prime and being written
      // to the cache without ever being read back.
      const [catalogs, tables] = await Promise.all([
        Promise.all(METRIC_KINDS.map((k) => this.get(`/api/${k}`))),
        Promise.all(METRIC_KINDS.map((k) => this.get(`/api/runs/metrics/${k}?bracket=all`)))
      ])

      const names: Record<string, string> = {}
      const ids = {} as Record<MetricKind, string[]>
      METRIC_KINDS.forEach((kind, i) => {
        const list: string[] = []
        for (const e of asArray(catalogs[i])) {
          if (!e?.id) continue
          list.push(e.id)
          if (e.name) names[e.id] = e.name
        }
        ids[kind] = list
      })

      const metrics = {} as Record<MetricKind, Record<string, MetricRow>>
      const elos: number[] = []
      const scores: number[] = []
      METRIC_KINDS.forEach((kind, i) => {
        const table: Record<string, MetricRow> = {}
        for (const row of tables[i]?.rows ?? []) {
          if (!row?.id || row.upgraded) continue // non-upgraded baseline only
          table[row.id] = {
            tier: row.tier,
            score: row.score,
            elo: numOrNull(row.elo),
            win_rate: row.win_rate,
            pick_rate: numOrNull(row.pick_rate),
            picks: row.picks
          }
          // The TRAP z-scores compare an item against the population it was
          // drafted from, so only cards contribute to the moments.
          if (kind !== 'cards') continue
          if (Number.isFinite(row.elo)) elos.push(row.elo)
          if (Number.isFinite(row.score)) scores.push(row.score)
        }
        metrics[kind] = table
      })

      const eloM = moments(elos)
      const scoreM = moments(scores)
      const snap: Snapshot = {
        schema: SNAPSHOT_SCHEMA,
        apiVersion: wantVersion,
        builtAt: ss?.built_at ?? 0,
        baselineWinRate: tables[0]?.baseline_win_rate ?? 0,
        ids,
        names,
        metrics,
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
        `prime OK v${wantVersion}: ` +
          METRIC_KINDS.map(
            (k) => `${ids[k].length} ${k} (${Object.keys(metrics[k]).length} rated)`
          ).join(', ') +
          `, baselineWR=${snap.baselineWinRate}`
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
    return !!this.snap && id in this.snap.metrics.cards
  }

  displayName(id: string): string | null {
    return this.snap?.names[id] ?? null
  }

  /**
   * Synchronous global context stats for one offered item (phase 1). Returns the
   * stat rows plus tier/score/confidence, or a known:false marker when the id is
   * not in the vocabulary. No network — reads the primed snapshot only.
   *
   * known:false is reserved for a genuinely unknown *id*, never a whole kind:
   * cards, relics and potions are all primed with metrics, and event/ancient
   * choices resolve through whichever table owns their id.
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
    const kind = METRIC_KIND_OF[item.kind]

    const snap = this.snap
    const rows: Array<[string, string]> = []
    if (item.cost != null) rows.push(['Cost', `${item.cost}g`])
    const unknown = { rows, tier: null, score: null, confidence: 'low', known: false, trap: null } as const

    const firstSee = !this.idsSeen.has(id)
    this.idsSeen.add(id)

    // Which tables may answer for this item. A card/relic/potion has exactly one.
    // An event or ancient choice has no kind of its own — but its id very often
    // IS an entity id: the ancient options hand out a specific relic or potion,
    // and the option's TextKey ends in that entity's id (PRECISE_SCISSORS is a
    // relic, not a bespoke choice token). Short-circuiting on `!kind` used to
    // print "No Codex data" under a header the very same snapshot had already
    // named, so choices probe all three tables instead. That is unambiguous:
    // cards, relics and potions share no ids (verified across the live
    // snapshot — zero collisions in any pair). Genuinely non-entity options
    // (REMOVE_CARD, GAIN_GOLD…) match nothing and still degrade honestly.
    const probe: MetricKind[] = kind ? [kind] : METRIC_KINDS

    let m: MetricRow | undefined
    let hitKind: MetricKind | undefined
    for (const k of probe) {
      const row = snap.metrics[k][id]
      if (row) {
        m = row
        hitKind = k
        break
      }
    }

    if (!m || !hitKind) {
      if (firstSee) {
        const upper = id.toUpperCase()
        const hint =
          upper !== id && probe.some((k) => upper in snap.metrics[k])
            ? ` (uppercase "${upper}" WOULD match — case mismatch!)`
            : ''
        this.log(
          `UNRESOLVED ${item.kind} id "${id}" — not in ${probe
            .map((k) => `${snap.ids[k].length}-${k}`)
            .join('/')} vocab${hint}`
        )
      }
      return { ...unknown, rows }
    }
    if (firstSee) {
      this.log(
        `resolved ${item.kind} "${id}"${item.kind === 'choice' ? ` as ${hitKind}` : ''} → ` +
          `tier ${m.tier}, score ${m.score}`
      )
    }
    this.idsResolved.add(id)

    // Every rated row carries tier/score/win-rate/picks. Elo and pick rate are
    // card-only in the data, so they are conditional rather than assumed — a
    // relic showing "Elo 0" would be a fabricated rating, not a missing one.
    rows.push(['Tier', m.tier], ['Score', String(m.score)])
    if (m.elo != null) rows.push(['Elo', m.elo.toFixed(0)])
    rows.push(['Win rate', `${m.win_rate.toFixed(0)}%`])
    if (m.pick_rate != null) rows.push(['Pick rate', `${m.pick_rate.toFixed(0)}%`])
    rows.push(['Sample', fmtCount(m.picks)])

    return {
      rows,
      tier: m.tier,
      score: m.score,
      confidence: confidenceFor(m.picks),
      known: true,
      trap: this.trapIndex(m)
    }
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
    // Needs elo, so it is a card-only signal — the moments are card-only too.
    if (m.elo == null) return null
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
      // Schema first: a cache written by an older build can carry a current
      // apiVersion, which would satisfy the freshness check and pin the app to
      // a shape that no longer has the tables it now reads.
      if (raw?.schema !== SNAPSHOT_SCHEMA) return null
      if (Array.isArray(raw.ids?.cards) && raw.metrics?.cards) return raw as Snapshot
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
  // Rate-limit handling, timeouts and the codex_* telemetry all live in
  // `http.ts` now, on an instance shared with the compendium service so the
  // 15-req/min-per-endpoint budget is counted once for the whole process.
  private get(path: string): Promise<any> {
    return codexHttp.get(path)
  }
  private post(path: string, body: unknown): Promise<any> {
    return codexHttp.post(path, body)
  }
}

// ── helpers ──

/**
 * Which metrics table answers for an item. `null` means "not known from the kind
 * alone" — not "unrateable": a choice's id is looked up across all three tables
 * (see contextStats), because ancient options are usually a relic or potion by
 * another name.
 */
const METRIC_KIND_OF: Record<RawItem['kind'], MetricKind | null> = {
  card: 'cards',
  relic: 'relics',
  potion: 'potions',
  choice: null
}

function asArray(v: any): any[] {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') return v.cards ?? v.relics ?? v.potions ?? v.data ?? []
  return []
}

/** Keep real numbers, turn the API's nulls (and any NaN) into an explicit null. */
function numOrNull(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
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
