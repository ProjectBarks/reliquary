import {
  cohortLabel,
  runCohort,
  type AnalysisStatus,
  type CatalogEntry,
  type DeckGroupRow,
  type JournalJson,
  type RunCohort,
  type RunEvent,
  type RunFile
} from '@shared/journal'
import { aggregateCombats, cardBaseId, groupDeck } from './RunRecorder'
import type { JournalIssueSink, RunStore } from './RunStore'

/**
 * The post-run analysis pipeline (journal-plan §3): a closed run file in, the
 * `analysis` blob the Journey Review renders out.
 *
 * Four analyses, deliberately ordered by what they cost:
 *
 *   1. **Card use / never-used / dead draws** — pure local arithmetic over the
 *      per-combat tallies the recorder already wrote. Zero requests, and the
 *      most useful numbers on the page, which is why they are computed and
 *      persisted *first*: a review that never reaches the network still says
 *      something true.
 *   2. **Skipped synergies** — for every offer whose recorded pick was not the
 *      best-graded option. Advice captured live during play (`offer_shown.advice`)
 *      is used as-is; only the offers that never got any are replayed through
 *      `POST /api/draft-advice`, each sending the deck *as it was at that floor*.
 *   3. **Popularity proxy** — one character-sliced metrics GET, usually a
 *      `CompendiumService` cache hit, giving tier/score context for the final
 *      deck and the cohort counts behind the labelled proxy. Never presented as
 *      an exact deck-match count, because the API cannot answer that question.
 *   4. **The summary strip numbers** — findings by severity, dead cards and
 *      draws, removals passed, and the grade of the best card passed.
 *
 * Three properties it is careful about:
 *
 *   - **The budget is hard and honest.** ≤12 requests per analysis, ≤10 of them
 *      draft-advice replays spaced ≥4.5 s apart, and every request that actually
 *      left the process is counted into `analysis.requests` — which is what the
 *      report's "analysis 11 req / budget 12" line reads. A metrics answer that
 *      came from the cache costs nothing and is counted as nothing.
 *   - **It is resumable.** The analysis object records which offers it has
 *      already replayed and how much budget it has spent, and is persisted after
 *      every network step. An app killed mid-analysis finishes the remainder on
 *      the next launch instead of starting over (and re-spending the budget).
 *   - **Offline is `partial`, never `failed`.** No network means the local
 *      findings still land, the file says so in a footnote, and the next
 *      re-analysis upgrades it. `failed` is reserved for the pipeline itself
 *      going wrong, and carries the reason as a string.
 *
 * Everything is injected — store, advisor, metrics source, clocks, sleep,
 * telemetry sinks — so the whole pipeline runs under plain node in
 * `scripts/journal-analysis-selfcheck.mjs`.
 */

// ── budget & thresholds ──────────────────────────────────────────────────────

/** Version of the analysis blob's own shape. Independent of `JOURNAL_SCHEMA`. */
export const ANALYSIS_SCHEMA = 1

/** journal-plan §3.4: the whole post-run analysis costs at most this. */
const DEFAULT_BUDGET = 12

/** Of that budget, at most this many are draft-advice replays. */
const DEFAULT_MAX_REPLAYS = 10

/** ≥4.5 s apart is ≤13/min, under the 15/min limit with headroom for live play. */
const DEFAULT_REPLAY_SPACING_MS = 4500

/** More findings than this is a wall of text nobody reads. */
const DEFAULT_MAX_FINDINGS = 6

/**
 * Grades are 0–100 (the draft-advice probability, ×100). A pick that trails the
 * best option by less than this is inside the model's own noise and is not a
 * mistake worth naming.
 */
const MIN_GAP = 3
const GAP_SEVERE = 15
const GAP_MAJOR = 8

/**
 * A card that was *passed entirely* is judged on its own grade rather than on a
 * gap: skipping a mediocre reward is correct play, and only a genuinely strong
 * card left behind is a finding.
 */
const PASS_FLOOR = 45
const PASS_SEVERE = 60
const PASS_MAJOR = 50

/** How many synergy reasons a finding shows before it stops being evidence. */
const MAX_EVIDENCE = 3

/** How many dead cards the local finding lists individually. */
const MAX_MINIS = 3

// ── injected collaborators ───────────────────────────────────────────────────

/** One offered card's deck-conditioned advice — `CodexClient.DeckAdvice`. */
export interface DraftAdvice {
  /** 0–1, deck-conditioned. */
  score: number
  /** 0–1, standalone. */
  base: number
  /** Already flattened to "Bloodletting 68%" by the client. */
  reasons: string[]
}

/**
 * The draft-advice half of the network. Injected as an interface rather than as
 * `CodexClient` so the pipeline never opens its own socket: in the app this is
 * backed by the provider's client, which shares the process-wide `codexHttp`
 * cooldown map, so a replay can never outrun the live overlay's own budget.
 */
export interface AnalysisAdvisor {
  /**
   * False when a replay is not worth attempting — no client, or the endpoint is
   * cooling down after a 429. Checked before every replay so a backed-off
   * endpoint costs a skipped offer rather than a wasted request.
   */
  ready(): boolean
  /** Null on any failure; the pipeline counts that as a draft error, never a throw. */
  advise(deck: string[], offered: string[]): Promise<Record<string, DraftAdvice> | null>
}

/** One row of a metrics table, as much of it as this pipeline reads. */
export interface MetricsCardRow {
  id: string
  upgraded?: boolean | null
  score?: number | null
  tier?: string | null
  win_rate?: number | null
  pick_rate?: number | null
  picks?: number | null
  offered?: number | null
  picked?: number | null
}

/** A metrics answer plus the freshness that decides whether it cost a request. */
export interface MetricsAnswer {
  bracket: string | null
  character: string | null
  totalRuns: number | null
  characterRuns: number | null
  rows: MetricsCardRow[]
  apiVersion: number | null
  /**
   * Epoch ms the copy was fetched. Older than the analysis's own start means it
   * came from the compendium's cache and cost nothing — which is what makes the
   * request count on the report honest rather than notional.
   */
  fetchedAt: number
}

export interface AnalysisMetricsSource {
  /** Null when the table could not be had at all (offline, cold cache). */
  cards(query: { character: string; bracket: string }): Promise<MetricsAnswer | null>
}

export interface AnalysisRunnerOptions {
  store: RunStore
  /** Null in stub mode and whenever the codex client is unavailable. */
  advisor?: AnalysisAdvisor | null
  metrics?: AnalysisMetricsSource | null
  now?: () => number
  /** Injectable so the self-check does not wait out the real 4.5 s spacing. */
  sleep?: (ms: number) => Promise<void>
  onIssue?: JournalIssueSink
  onEvent?: (name: string, props: Record<string, unknown>) => void
  /** `journal:push {kind:'analysis'}` — an open report live-updates from this. */
  onStatus?: (id: string, status: AnalysisStatus) => void
  /** `journal:push {kind:'catalog'}` — the Archive's review chip. */
  onCatalog?: (entries: CatalogEntry[]) => void
  budget?: number
  maxReplays?: number
  replaySpacingMs?: number
  maxFindings?: number
}

// ── the analysis blob (the shape `renderer/journal/analysis.ts` parses) ──────

export type FindingSeverity = 'severe' | 'major' | 'noted'

export type AnalysisCardRef = {
  id: string
  /** Codex-style 0–100 grade, or null when nothing graded it. */
  score: number | null
  tier: string | null
}

export type AnalysisEvidence = { label: string; value: string | null }

export type AnalysisMini = { id: string; label: string | null; tally: string }

export type AnalysisFinding = {
  ref: string
  severity: FindingSeverity
  title: string
  at: string | null
  roomIndex: number | null
  passed: AnalysisCardRef | null
  taken: AnalysisCardRef | null
  outcome: 'taken' | 'left-in-stock' | null
  cost: number | null
  evidence: AnalysisEvidence[]
  verdict: string | null
  mono: string | null
  minis: AnalysisMini[]
}

export type AnalysisFootnote = { chip: string; text: string }

export type AnalysisDeckContextRow = {
  id: string
  tier: string | null
  score: number | null
  winRate: number | null
  pickRate: number | null
}

export type AnalysisPopularity = {
  cohortRuns: number | null
  characterRuns: number | null
  corePickRates: Record<string, number>
  bracket: string
  note: string
}

/**
 * What the pipeline writes to `RunFile.analysis`. The store types that field as
 * opaque JSON on purpose (it has no business knowing this schema) and the
 * renderer parses it defensively, so this type is the contract's one written
 * form — every field nullable rather than optional, because "absent" and "not
 * known" must not be the same value on disk.
 */
export type RunAnalysis = {
  schema: number
  /** Mirrors `RunFile.analysisStatus`, so an exported file explains itself. */
  status: AnalysisStatus
  startedAt: number
  builtAt: number
  apiVersion: number | null
  /** Requests that actually left the process. Cache hits are not requests. */
  requests: number
  budget: number
  /** Replays that came back empty — the report's "draft errors" cell. */
  draftErrors: number
  removalsPassed: number
  shopsVisited: number
  deadCards: number
  deadDraws: number | null
  bestPass: AnalysisCardRef | null
  halfDead: string[]
  neverUsed: Array<{ id: string; drawn: number; copies: number }>
  neverDrawn: string[]
  deckContext: AnalysisDeckContextRow[]
  popularity: AnalysisPopularity | null
  findings: AnalysisFinding[]
  footnotes: AnalysisFootnote[]
  /** Offer event ids whose advice this pipeline has already fetched. */
  replayed: number[]
  /** Offer event ids still owing a replay — why the status is `partial`. */
  pending: number[]
  offline: boolean
  cohort: RunCohort
  /** Honest error string when the pipeline itself failed; null otherwise. */
  error: string | null
}

/**
 * The one place the concrete shape crosses into the store's opaque JSON type.
 * A structural conversion rather than a cast would only re-state the shape.
 */
function asJson(analysis: RunAnalysis): JournalJson {
  return analysis as unknown as JournalJson
}

// ── the runner ───────────────────────────────────────────────────────────────

export class AnalysisRunner {
  private readonly store: RunStore
  private readonly advisor: AnalysisAdvisor | null
  private readonly metrics: AnalysisMetricsSource | null
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onIssue: JournalIssueSink
  private readonly onEvent: (name: string, props: Record<string, unknown>) => void
  private readonly onStatusCb: ((id: string, status: AnalysisStatus) => void) | null
  private readonly onCatalogCb: ((entries: CatalogEntry[]) => void) | null
  private readonly budget: number
  private readonly maxReplays: number
  private readonly spacingMs: number
  private readonly maxFindings: number

  private queue: string[] = []
  private current: string | null = null
  private pumping: Promise<void> | null = null
  private disposed = false

  constructor(opts: AnalysisRunnerOptions) {
    this.store = opts.store
    this.advisor = opts.advisor ?? null
    this.metrics = opts.metrics ?? null
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? defaultSleep
    this.onIssue = opts.onIssue ?? ((): void => {})
    this.onEvent = opts.onEvent ?? ((): void => {})
    this.onStatusCb = opts.onStatus ?? null
    this.onCatalogCb = opts.onCatalog ?? null
    this.budget = opts.budget ?? DEFAULT_BUDGET
    this.maxReplays = opts.maxReplays ?? DEFAULT_MAX_REPLAYS
    this.spacingMs = opts.replaySpacingMs ?? DEFAULT_REPLAY_SPACING_MS
    this.maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Pick up the work a previous launch did not finish: runs queued but never
   * analysed, and partial ones that still have budget to spend. A partial run
   * with no budget left is deliberately *not* re-queued — re-running it would
   * produce the same answer and spend nothing but time; the user's "review
   * again" button is the way to give it a fresh budget.
   */
  async start(): Promise<void> {
    for (const entry of this.store.list()) {
      if (entry.unreadable) continue
      if (entry.analysisStatus === 'pending') this.enqueue(entry.id)
    }
    // Resolves when everything is *queued*, not when the queue has drained: a
    // review takes minutes and nothing at startup should wait for it.
    await this.resumePartials()
  }

  private async resumePartials(): Promise<void> {
    const partials = this.store.list().filter((e) => !e.unreadable && e.analysisStatus === 'partial')
    for (const entry of partials) {
      if (this.disposed) return
      const run = await this.store.getRun(entry.id)
      if (!run) continue
      const prior = readPriorAnalysis(run)
      if (!prior) continue
      const spent = prior.requests
      const unfinished = prior.pending.length > 0 || prior.offline || prior.popularity === null
      if (unfinished && spent < this.budget) this.enqueue(entry.id)
    }
  }

  /** Queue a run for analysis. Idempotent; the queue is drained one at a time. */
  enqueue(id: string): void {
    if (this.disposed) return
    if (this.current === id || this.queue.includes(id)) return
    this.queue.push(id)
    void this.pump()
  }

  /**
   * The user's "review this run again". Clears the prior analysis outright —
   * including its spent budget, because a deliberate re-run is exactly when a
   * fresh budget is warranted — marks the run pending, and queues it.
   */
  async reanalyze(id: string): Promise<AnalysisStatus> {
    const run = await this.store.getRun(id)
    if (!run) throw new Error(`run ${id} not found`)
    run.analysis = null
    run.analysisStatus = 'pending'
    // Advice replayed into the log stays: it is an observation about that offer,
    // not part of the review, and re-fetching it would spend budget to learn
    // something the file already knows.
    this.store.save(run, { immediate: true })
    this.publish(id, 'pending')
    this.enqueue(id)
    return 'pending'
  }

  dispose(): void {
    this.disposed = true
    this.queue = []
  }

  /** True while a run is being analysed — diagnostics and the self-check only. */
  get busy(): boolean {
    return this.current !== null
  }

  /** Resolves when the queue is empty. The self-check's join point. */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping
  }

  // ── the serialized queue ───────────────────────────────────────────────────

  private pump(): Promise<void> {
    if (this.pumping) return this.pumping
    const run = this.drain().finally(() => {
      this.pumping = null
    })
    this.pumping = run
    return run
  }

  private async drain(): Promise<void> {
    while (!this.disposed) {
      const id = this.queue.shift()
      if (id === undefined) return
      this.current = id
      try {
        await this.analyze(id)
      } catch (err) {
        // `analyze` handles its own failures; reaching here means the failure
        // handler itself failed, which must still not stall the queue.
        this.onIssue('journal_analysis_crashed', 'error', { id }, err)
      } finally {
        this.current = null
      }
    }
  }

  // ── one run ────────────────────────────────────────────────────────────────

  private async analyze(id: string): Promise<void> {
    const run = await this.store.getRun(id)
    if (!run) {
      this.onIssue('journal_analysis_run_missing', 'warn', { id })
      return
    }
    const startedAt = this.now()
    const prior = readPriorAnalysis(run)
    const cohort = runCohort(run.playerCount)
    const bracket = bracketFor(run.playerCount)

    // ── 1. everything that needs no network ──
    const use = analyzeCardUse(run)
    const shops = countShops(run)
    const offers = collectOffers(run)

    const state: RunAnalysis = {
      schema: ANALYSIS_SCHEMA,
      status: 'partial',
      startedAt,
      builtAt: startedAt,
      apiVersion: prior?.apiVersion ?? null,
      // Budget already spent by an interrupted attempt carries over: the cap is
      // per analysis, not per attempt, or a crash loop would spend it forever.
      requests: prior?.requests ?? 0,
      budget: this.budget,
      draftErrors: prior?.draftErrors ?? 0,
      removalsPassed: shops.removalsPassed,
      shopsVisited: shops.shops,
      deadCards: use.deadCards,
      deadDraws: use.deadDraws,
      bestPass: null,
      halfDead: use.halfDead,
      neverUsed: use.neverUsed.map((r) => ({ id: r.id, drawn: r.drawn, copies: r.copies })),
      neverDrawn: use.neverDrawn.map((r) => r.id),
      deckContext: [],
      popularity: null,
      findings: [],
      footnotes: [],
      replayed: prior?.replayed ?? [],
      pending: [],
      offline: false,
      cohort,
      error: null
    }

    this.onEvent('journal_analysis_started', {
      id,
      cohort,
      offers: offers.length,
      dead_cards: use.deadCards,
      resumed: prior !== null,
      spent: state.requests
    })

    try {
      // Findings that owe nothing to the network are written before the first
      // request, so a process killed one second later still leaves a report.
      state.findings = rank(localFindings(use, this.maxFindings), this.maxFindings)
      this.persist(run, state, 'partial')

      // ── 2. the popularity proxy + tier context (one GET, usually cached) ──
      const metricsAnswer = await this.fetchMetrics(run.character, bracket, startedAt, state)
      const index = metricsIndex(metricsAnswer)
      if (metricsAnswer) {
        state.apiVersion = metricsAnswer.apiVersion
        state.deckContext = deckContextOf(finalDeckOf(run), index)
        state.popularity = popularityOf(run, metricsAnswer, index, bracket)
      }

      // ── 3. skipped synergies: live advice first, replays for the rest ──
      await this.replayOffers(run, offers, state)

      // ── 4. the findings and the strip ──
      const offerFindings = buildOfferFindings(offers, use, index, this.maxFindings)
      state.findings = rank([...offerFindings, ...localFindings(use, this.maxFindings)], this.maxFindings)
      state.bestPass = bestPassOf(state.findings)
      state.footnotes = footnotesFor(state, metricsAnswer !== null, cohort)

      const status: AnalysisStatus =
        metricsAnswer !== null && state.pending.length === 0 ? 'done' : 'partial'
      state.builtAt = this.now()
      state.status = status
      this.persist(run, state, status)
      this.onEvent('journal_analysis_done', {
        id,
        status,
        requests: state.requests,
        budget: state.budget,
        draft_errors: state.draftErrors,
        findings: state.findings.length,
        severe: state.findings.filter((f) => f.severity === 'severe').length,
        pending: state.pending.length,
        offline: state.offline,
        cohort,
        ms: state.builtAt - startedAt
      })
    } catch (err) {
      // A pipeline failure is honest and local: the numbers computed before it
      // stay, the file says what went wrong, and the run can be reviewed again.
      const message = err instanceof Error ? err.message : String(err)
      state.status = 'failed'
      state.error = message
      state.builtAt = this.now()
      this.persist(run, state, 'failed')
      this.onIssue('journal_analysis_failed', 'error', { id, requests: state.requests }, err)
    }
  }

  /** Write the blob and the status, and tell the renderer both. */
  private persist(run: RunFile, state: RunAnalysis, status: AnalysisStatus): void {
    state.status = status
    run.analysis = asJson(state)
    run.analysisStatus = status
    this.store.save(run, { immediate: true })
    this.publish(run.id, status)
  }

  private publish(id: string, status: AnalysisStatus): void {
    this.onStatusCb?.(id, status)
    this.onCatalogCb?.(this.store.list())
  }

  // ── network steps ──────────────────────────────────────────────────────────

  /**
   * The character-sliced metrics table. A copy fetched before this analysis
   * started came from the compendium's cache and is not counted against the
   * budget — the request count on the report is what actually left the process.
   */
  private async fetchMetrics(
    character: string,
    bracket: string,
    startedAt: number,
    state: RunAnalysis
  ): Promise<MetricsAnswer | null> {
    if (!this.metrics) {
      state.offline = true
      return null
    }
    if (state.requests >= state.budget) return null
    let answer: MetricsAnswer | null = null
    try {
      answer = await this.metrics.cards({ character, bracket })
    } catch (err) {
      this.onIssue('journal_analysis_metrics_failed', 'warn', { bracket }, err)
      answer = null
    }
    if (!answer) {
      state.offline = true
      state.requests++
      return null
    }
    if (answer.fetchedAt >= startedAt) state.requests++
    return answer
  }

  /**
   * Fill in the advice the log is missing, cheapest offers first.
   *
   * Only offers with no advice at all are replayed — the provider caches advice
   * live while playing and the recorder copies it onto the event, so a run
   * played with the overlay open usually costs nothing here. Priority is
   * journal-plan's: later offers first (a later deck carries more synergy
   * signal), then by source.
   */
  private async replayOffers(
    run: RunFile,
    offers: OfferRecord[],
    state: RunAnalysis
  ): Promise<void> {
    const wanted = offers.filter((o) => o.advice === null && o.offered.length > 0)
    if (!wanted.length) return
    const queue = [...wanted].sort(replayPriority)

    let replays = 0
    let first = true
    for (let i = 0; i < queue.length; i++) {
      const offer = queue[i]
      if (this.disposed) {
        // Shutting down mid-review: everything not yet graded is named as
        // pending, which is what makes the persisted `partial` resumable
        // instead of a `done` that quietly dropped the rest.
        for (let rest = i; rest < queue.length; rest++) state.pending.push(queue[rest].eid)
        return
      }
      const budgetLeft = state.budget - state.requests
      if (replays >= this.maxReplays || budgetLeft <= 0) {
        // Everything past the cap is named rather than silently dropped: the
        // footnote and the `partial` status both come from this list.
        state.pending.push(offer.eid)
        continue
      }
      if (!this.advisor || !this.advisor.ready()) {
        state.offline = true
        state.pending.push(offer.eid)
        continue
      }
      // Spacing applies between requests, never before the first one.
      if (!first) await this.sleep(this.spacingMs)
      first = false
      replays++
      state.requests++

      let advice: Record<string, DraftAdvice> | null = null
      try {
        advice = await this.advisor.advise(
          offer.deckBefore.map(cardBaseId),
          offer.offered
        )
      } catch (err) {
        this.onIssue('journal_analysis_advise_threw', 'warn', { eid: offer.eid }, err)
        advice = null
      }
      if (!advice || Object.keys(advice).length === 0) {
        state.draftErrors++
        state.pending.push(offer.eid)
        continue
      }
      offer.advice = advice
      offer.adviceLive = false
      // Patched onto the event itself, exactly as the plan specifies for live
      // advice: the file becomes self-describing and a later re-analysis never
      // pays for this offer twice.
      patchAdvice(run, offer.eid, advice)
      state.replayed.push(offer.eid)
      // Persisted after every request so a kill costs at most the next one.
      this.persist(run, state, 'partial')
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

// ── reading a run file (pure, exported for the self-check) ───────────────────

type Bag = Record<string, unknown>

function str(event: RunEvent, key: string): string | null {
  const v = (event as unknown as Bag)[key]
  return typeof v === 'string' ? v : null
}

function num(event: RunEvent, key: string): number | null {
  const v = (event as unknown as Bag)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strings(event: RunEvent, key: string): string[] {
  const v = (event as unknown as Bag)[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function numberMap(event: RunEvent, key: string): Record<string, number> {
  const v = (event as unknown as Bag)[key]
  const out: Record<string, number> = {}
  if (!v || typeof v !== 'object') return out
  for (const [id, cost] of Object.entries(v as Bag)) {
    if (typeof cost === 'number' && Number.isFinite(cost)) out[id] = cost
  }
  return out
}

/** Advice as it may already sit on an `offer_shown`, read defensively. */
function adviceOf(event: RunEvent): Record<string, DraftAdvice> | null {
  const v = (event as unknown as Bag)['advice']
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, DraftAdvice> = {}
  for (const [id, row] of Object.entries(v as Bag)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const bag = row as Bag
    const score = bag['score']
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    out[id] = {
      score,
      base: typeof bag['base'] === 'number' ? bag['base'] : 0,
      reasons: Array.isArray(bag['reasons'])
        ? (bag['reasons'] as unknown[]).filter((r): r is string => typeof r === 'string')
        : []
    }
  }
  return Object.keys(out).length ? out : null
}

/** One offer, folded out of the event log with everything a finding needs. */
export interface OfferRecord {
  eid: number
  t: number
  source: string
  offered: string[]
  costs: Record<string, number>
  /** The deck as it was when the offer appeared — what makes a replay honest. */
  deckBefore: string[]
  /** The inferred pick, or null for a skip. Never `'ambiguous:…'` — see `ambiguous`. */
  picked: string | null
  /** True when pick inference could not choose between two identical gains. */
  ambiguous: boolean
  resolved: boolean
  roomIndex: number | null
  act: number | null
  advice: Record<string, DraftAdvice> | null
  /** True when the advice was captured during play rather than replayed after. */
  adviceLive: boolean
}

/**
 * Every offer in the log, in the order it was shown.
 *
 * Offers resolve late — the recorder closes an offer's inference window on the
 * *next* room boundary — so the room an offer belongs to is the room it was
 * shown in, tracked here rather than read off whatever room came last.
 */
export function collectOffers(run: RunFile): OfferRecord[] {
  const out: OfferRecord[] = []
  const byEid = new Map<number, OfferRecord>()
  let roomIndex: number | null = null
  let act: number | null = null

  for (const event of run.events) {
    switch (event.type) {
      case 'room_enter':
        roomIndex = num(event, 'roomIndex') ?? roomIndex
        act = num(event, 'actIndex') ?? act
        break
      case 'act_change':
        act = num(event, 'to') ?? act
        break
      case 'offer_shown': {
        const eid = num(event, 'eid')
        if (eid === null) break
        const record: OfferRecord = {
          eid,
          t: event.t,
          source: str(event, 'source') ?? 'unknown',
          offered: strings(event, 'offered'),
          costs: numberMap(event, 'costs'),
          deckBefore: strings(event, 'deckBefore'),
          picked: null,
          ambiguous: false,
          resolved: false,
          roomIndex,
          act,
          advice: adviceOf(event),
          adviceLive: adviceOf(event) !== null
        }
        byEid.set(eid, record)
        out.push(record)
        break
      }
      case 'offer_resolved': {
        const eid = num(event, 'eid')
        const record = eid === null ? undefined : byEid.get(eid)
        if (!record) break
        const picked = str(event, 'picked')
        record.resolved = true
        if (picked && picked.startsWith('ambiguous:')) {
          record.picked = picked.slice('ambiguous:'.length)
          record.ambiguous = true
        } else {
          record.picked = picked
        }
        break
      }
      default:
        break
    }
  }
  return out
}

/** Write replayed advice back onto the offer's own event. */
function patchAdvice(run: RunFile, eid: number, advice: Record<string, DraftAdvice>): void {
  for (const event of run.events) {
    if (event.type !== 'offer_shown' || num(event, 'eid') !== eid) continue
    const bag = event as unknown as Bag
    bag['advice'] = advice
    bag['adviceSource'] = 'replay'
    return
  }
}

// ── card use (no network) ────────────────────────────────────────────────────

export interface CardUseRow {
  id: string
  copies: number
  drawn: number
  played: number
  dead: number
}

export interface CardUse {
  rows: CardUseRow[]
  /** True when no combat was ever observed: composition without counts. */
  countsMissing: boolean
  /** Draws that produced no play. Null when there are no counts at all. */
  deadDraws: number | null
  /** Deck rows drawn at least once and never played. */
  deadCards: number
  neverUsed: CardUseRow[]
  neverDrawn: CardUseRow[]
  /** Rows with more copies than plays: an extra copy that never landed. */
  halfDead: string[]
  playedById: Record<string, number>
  drawnById: Record<string, number>
}

function finalDeckOf(run: RunFile): DeckGroupRow[] {
  // A run closed by the recorder always has `finalDeck`; a suspended one being
  // reviewed early does not, and its snapshot deck is the same information.
  return run.finalDeck ?? groupDeck(run.snapshot.deck)
}

/**
 * The final deck joined to the per-combat tallies (journal-plan §3.1/§3.2).
 *
 * One row per **base id**, matching the renderer's deck ledger and forced by the
 * same fact: the recorder tallies plays per card id, and an id does not carry
 * its upgrade level. Splitting the rows would invent an attribution nobody
 * measured. Aborted combats are excluded — the game restarts an interrupted
 * fight, so counting both halves would double every card in it.
 */
export function analyzeCardUse(run: RunFile): CardUse {
  const agg = run.combats.length
    ? aggregateCombats(run.combats)
    : (run.snapshot.combatAgg ?? { plays: {}, drawn: {} })
  const plays = agg.plays ?? {}
  const drawn = agg.drawn ?? {}
  const countsMissing = Object.keys(plays).length === 0 && Object.keys(drawn).length === 0

  const byId = new Map<string, CardUseRow>()
  for (const group of finalDeckOf(run)) {
    const row = byId.get(group.id) ?? { id: group.id, copies: 0, drawn: 0, played: 0, dead: 0 }
    row.copies += group.count
    byId.set(group.id, row)
  }
  for (const row of byId.values()) {
    if (countsMissing) continue
    row.drawn = drawn[row.id] ?? 0
    row.played = plays[row.id] ?? 0
    row.dead = Math.max(0, row.drawn - row.played)
  }

  const rows = [...byId.values()].sort((a, b) => b.dead - a.dead || a.id.localeCompare(b.id))
  const neverUsed = countsMissing ? [] : rows.filter((r) => r.drawn > 0 && r.played === 0)
  const neverDrawn = countsMissing ? [] : rows.filter((r) => r.drawn === 0)
  return {
    rows,
    countsMissing,
    deadDraws: countsMissing ? null : rows.reduce((sum, r) => sum + r.dead, 0),
    deadCards: neverUsed.length,
    neverUsed,
    neverDrawn,
    // A second copy that never landed is a different complaint from a card that
    // never landed at all, and the deck ledger marks it differently.
    halfDead: countsMissing
      ? []
      : rows.filter((r) => r.copies >= 2 && r.played > 0 && r.played < r.copies).map((r) => r.id),
    playedById: { ...plays },
    drawnById: { ...drawn }
  }
}

/**
 * Shops visited, and how many of them were left without removing a card.
 *
 * Every shop sells a card removal, so a merchant room the deck did not shrink in
 * is a removal passed. That is the only reading of "removals passed" the strict
 * v1 data supports — the removal service itself is not readable — and it is
 * stated in the report's own footnote rather than presented as a measurement.
 */
export function countShops(run: RunFile): { shops: number; removalsPassed: number } {
  let shops = 0
  let passed = 0
  let inShop = false
  let removedHere = false

  const closeRoom = (): void => {
    if (!inShop) return
    shops++
    if (!removedHere) passed++
  }

  for (const event of run.events) {
    switch (event.type) {
      case 'room_enter':
        closeRoom()
        inShop = str(event, 'roomType') === 'merchant'
        removedHere = false
        break
      case 'offer_shown':
        if (str(event, 'source') === 'merchant') inShop = true
        break
      case 'deck_remove':
        removedHere = true
        break
      default:
        break
    }
  }
  closeRoom()
  return { shops, removalsPassed: passed }
}

// ── grading & severity ───────────────────────────────────────────────────────

/** draft-advice scores are 0–1 probabilities; the report speaks in 0–100. */
export function grade(advice: DraftAdvice | undefined): number | null {
  if (!advice || !Number.isFinite(advice.score)) return null
  return Math.round(advice.score * 100)
}

/**
 * A pick that trailed the best option. Severity is the size of the gap, because
 * that is the only quantity the model actually measured.
 */
export function severityForGap(gap: number): FindingSeverity | null {
  if (gap < MIN_GAP) return null
  if (gap >= GAP_SEVERE) return 'severe'
  if (gap >= GAP_MAJOR) return 'major'
  return 'noted'
}

/**
 * A card passed entirely (a skipped reward, or stock left in a shop). Judged on
 * its own grade: passing a mediocre card is correct play and is never a finding.
 */
export function severityForPass(score: number): FindingSeverity | null {
  if (score < PASS_FLOOR) return null
  if (score >= PASS_SEVERE) return 'severe'
  if (score >= PASS_MAJOR) return 'major'
  return 'noted'
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { severe: 0, major: 1, noted: 2 }

/** One step harsher — a card the run then proved dead earns the escalation. */
function escalate(severity: FindingSeverity): FindingSeverity {
  return severity === 'noted' ? 'major' : 'severe'
}

// ── findings ─────────────────────────────────────────────────────────────────

function metricsIndex(answer: MetricsAnswer | null): Map<string, MetricsCardRow> {
  const index = new Map<string, MetricsCardRow>()
  if (!answer) return index
  for (const row of answer.rows) {
    // Cards appear twice (base + upgraded); the base row is the deck-agnostic
    // grade every other surface in the app quotes.
    if (!row?.id || row.upgraded) continue
    if (!index.has(row.id)) index.set(row.id, row)
  }
  return index
}

function cardRef(
  id: string,
  score: number | null,
  index: Map<string, MetricsCardRow>
): AnalysisCardRef {
  return { id, score, tier: index.get(id)?.tier ?? null }
}

/** "Bloodletting 68%" → `{ label: 'Bloodletting', value: '68%' }`. */
export function evidenceOf(reasons: readonly string[]): AnalysisEvidence[] {
  return reasons.slice(0, MAX_EVIDENCE).map((reason) => {
    const cut = reason.lastIndexOf(' ')
    const tail = cut === -1 ? '' : reason.slice(cut + 1)
    if (cut > 0 && tail.endsWith('%')) return { label: reason.slice(0, cut), value: tail }
    return { label: reason, value: null }
  })
}

/** `TWIN_STRIKE` → `Twin Strike`. The main process has no name table. */
export function prettifyId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

const SOURCE_RANK: Record<string, number> = { cardReward: 0, chooseACard: 1, merchant: 2 }

/** Later offers first (a later deck carries more signal), then by source. */
function replayPriority(a: OfferRecord, b: OfferRecord): number {
  const ar = a.roomIndex ?? 0
  const br = b.roomIndex ?? 0
  if (ar !== br) return br - ar
  if (a.t !== b.t) return b.t - a.t
  return (SOURCE_RANK[a.source] ?? 3) - (SOURCE_RANK[b.source] ?? 3)
}

/**
 * One finding per offer whose recorded pick was not the best-graded option.
 * Offers with no advice produce nothing — an ungraded offer is not evidence of
 * a mistake, and saying otherwise would be the pipeline inventing a verdict.
 */
export function buildOfferFindings(
  offers: readonly OfferRecord[],
  use: CardUse,
  index: Map<string, MetricsCardRow>,
  limit: number
): AnalysisFinding[] {
  const found: Array<{ finding: AnalysisFinding; weight: number }> = []

  for (const offer of offers) {
    if (!offer.advice) continue
    let bestId: string | null = null
    let bestScore = -1
    for (const id of offer.offered) {
      const score = grade(offer.advice[id])
      if (score === null || score <= bestScore) continue
      bestScore = score
      bestId = id
    }
    if (bestId === null) continue
    const takenId = offer.picked && offer.offered.includes(offer.picked) ? offer.picked : null
    if (takenId === bestId) continue

    const takenScore = takenId === null ? null : grade(offer.advice[takenId])
    // A pick the model did not grade cannot be compared to anything. Silence is
    // the honest answer; a finding built on a missing number is not.
    if (takenId !== null && takenScore === null) continue
    const gap = takenScore === null ? bestScore : bestScore - takenScore
    let severity = takenScore === null ? severityForPass(bestScore) : severityForGap(gap)
    if (severity === null) continue
    // The run's own verdict on the card that was taken: a card that never got
    // played proved the grade right, and the finding says so one step louder.
    const takenDead = takenId !== null && use.neverUsed.some((r) => r.id === takenId)
    if (takenDead) severity = escalate(severity)

    const leftInStock = takenId === null && offer.source === 'merchant'
    const passed = cardRef(bestId, bestScore, index)
    const at = offer.roomIndex === null ? null : `R${offer.roomIndex}`
    const cost = offer.costs[bestId] ?? null
    const drawnOf = use.rows.find((r) => r.id === takenId)

    const finding: AnalysisFinding = {
      // Refs are assigned after ranking, so the report reads F-01 downwards.
      ref: '',
      severity,
      title: leftInStock
        ? `Left ${prettifyId(bestId)} in the shop`
        : takenId === null
          ? `Passed ${prettifyId(bestId)}`
          : `Took ${prettifyId(takenId)} over ${prettifyId(bestId)}`,
      at,
      roomIndex: offer.roomIndex,
      passed,
      taken:
        takenId === null
          ? leftInStock
            ? // The shop kept it: the same card, ungraded, rendered under a plate.
              { id: bestId, score: null, tier: null }
            : null
          : cardRef(takenId, takenScore, index),
      outcome: takenId === null ? (leftInStock ? 'left-in-stock' : null) : 'taken',
      cost: leftInStock ? cost : null,
      evidence: evidenceOf(offer.advice[bestId]?.reasons ?? []),
      verdict: verdictFor({
        bestId,
        bestScore,
        takenId,
        takenScore,
        gap,
        leftInStock,
        takenDead,
        drawn: drawnOf?.drawn ?? null
      }),
      mono: monoFor(offer, cost),
      minis: []
    }
    found.push({ finding, weight: gap })
  }

  return found
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
        b.weight - a.weight ||
        (b.finding.roomIndex ?? 0) - (a.finding.roomIndex ?? 0)
    )
    .slice(0, limit)
    .map((f) => f.finding)
}

function verdictFor(input: {
  bestId: string
  bestScore: number
  takenId: string | null
  takenScore: number | null
  gap: number
  leftInStock: boolean
  takenDead: boolean
  drawn: number | null
}): string {
  const best = prettifyId(input.bestId)
  if (input.takenId === null) {
    return input.leftInStock
      ? `${best} graded ${input.bestScore} against this deck and stayed in the shop.`
      : `${best} graded ${input.bestScore} against this deck and was left on the table.`
  }
  const taken = prettifyId(input.takenId)
  const gap = `${input.gap} point${input.gap === 1 ? '' : 's'}`
  if (input.takenDead) {
    const drawn = input.drawn ?? 0
    return `${taken} graded ${gap} below ${best}, then proved it by never being played across ${drawn} draw${drawn === 1 ? '' : 's'}.`
  }
  return `${taken} graded ${gap} below ${best} with the deck you were holding at the time.`
}

function monoFor(offer: OfferRecord, cost: number | null): string {
  const parts = [offer.source]
  if (offer.act !== null) parts.push(`act ${offer.act + 1}`)
  parts.push(`deck ${offer.deckBefore.length}`)
  if (cost !== null) parts.push(`${cost}g`)
  parts.push(offer.adviceLive ? 'advice captured live' : 'advice replayed post-run')
  if (offer.ambiguous) parts.push('pick inference ambiguous')
  if (!offer.resolved) parts.push('offer never resolved')
  return parts.join(' · ')
}

/**
 * The local finding: cards the deck carried and never used. Costs nothing, is
 * usually the most actionable line in the review, and is therefore the one
 * finding that exists even when the network never answered.
 */
export function localFindings(use: CardUse, limit: number): AnalysisFinding[] {
  if (use.countsMissing || use.deadCards === 0 || limit <= 0) return []
  const dead = use.neverUsed.slice(0, MAX_MINIS)
  const halfDead = use.halfDead.slice(0, Math.max(0, MAX_MINIS - dead.length))
  const minis: AnalysisMini[] = [
    ...dead.map((row) => ({
      id: row.id,
      label: row.copies > 1 ? `×${row.copies}` : null,
      tally: `0 / ${row.drawn} drawn`
    })),
    ...halfDead.map((id) => {
      const row = use.rows.find((r) => r.id === id)
      return {
        id,
        label: row && row.copies > 1 ? `×${row.copies}` : null,
        tally: `${row?.played ?? 0} plays · ${row?.copies ?? 0} copies`
      }
    })
  ]
  const evidence: AnalysisEvidence[] = [
    { label: `${use.deadCards} card${use.deadCards === 1 ? '' : 's'} drawn, never played`, value: null }
  ]
  if (use.deadDraws !== null) {
    evidence.push({ label: 'dead draws this run', value: String(use.deadDraws) })
  }
  return [
    {
      ref: '',
      // Dead cards are an observation, not a graded mistake — it takes a deck
      // full of them before this outranks a draft error the model measured.
      severity: use.deadCards >= 5 ? 'major' : 'noted',
      title:
        use.deadCards === 1
          ? 'One card did nothing all run'
          : `${use.deadCards} cards did nothing all run`,
      at: `${use.deadCards} deck row${use.deadCards === 1 ? '' : 's'}`,
      roomIndex: null,
      passed: null,
      taken: null,
      outcome: null,
      cost: null,
      evidence,
      verdict:
        use.deadDraws === null
          ? 'These cards were drawn and never played.'
          : `${use.deadDraws} draws produced no play — every dead card is a card the next removal could have been.`,
      mono: 'local · no network cost · from the per-combat tallies',
      minis
    }
  ]
}

/** Severity first, then the gap they were built with; refs assigned in order. */
function rank(findings: AnalysisFinding[], limit: number): AnalysisFinding[] {
  return [...findings]
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.roomIndex ?? Number.MAX_SAFE_INTEGER) - (b.roomIndex ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, limit)
    .map((finding, i) => ({ ...finding, ref: `F-${String(i + 1).padStart(2, '0')}` }))
}

/** The best-graded card that was offered and never entered the deck. */
function bestPassOf(findings: readonly AnalysisFinding[]): AnalysisCardRef | null {
  let best: AnalysisCardRef | null = null
  for (const finding of findings) {
    const passed = finding.passed
    if (!passed || passed.score === null) continue
    if (!best || best.score === null || passed.score > best.score) best = passed
  }
  return best
}

// ── the popularity proxy ─────────────────────────────────────────────────────

function deckContextOf(
  deck: readonly DeckGroupRow[],
  index: Map<string, MetricsCardRow>
): AnalysisDeckContextRow[] {
  const seen = new Set<string>()
  const rows: AnalysisDeckContextRow[] = []
  for (const group of deck) {
    if (seen.has(group.id)) continue
    seen.add(group.id)
    const row = index.get(group.id)
    if (!row) continue
    rows.push({
      id: group.id,
      tier: row.tier ?? null,
      score: row.score ?? null,
      winRate: row.win_rate ?? null,
      pickRate: pickRateOf(row)
    })
  }
  return rows
}

/**
 * The API's `pick_rate` is null throughout the current snapshot, but the raw
 * `offered`/`picked` counts are not — deriving it is the difference between a
 * proxy with numbers and a proxy with dashes.
 */
function pickRateOf(row: MetricsCardRow): number | null {
  if (typeof row.pick_rate === 'number' && Number.isFinite(row.pick_rate)) return row.pick_rate
  const offered = row.offered
  const picked = row.picked
  if (typeof offered !== 'number' || typeof picked !== 'number' || offered <= 0) return null
  return Number(((picked / offered) * 100).toFixed(1))
}

function popularityOf(
  run: RunFile,
  answer: MetricsAnswer,
  index: Map<string, MetricsCardRow>,
  bracket: string
): AnalysisPopularity {
  const corePickRates: Record<string, number> = {}
  for (const id of run.signature.core) {
    const rate = pickRateOf(index.get(id) ?? { id })
    if (rate !== null) corePickRates[id] = rate
  }
  return {
    cohortRuns: answer.totalRuns ?? null,
    characterRuns: answer.characterRuns ?? null,
    corePickRates,
    bracket,
    // Named on the object as well as in the footnote: anyone reading the file
    // directly must see the word before they see the numbers.
    note: 'proxy'
  }
}

/**
 * Which community cohort a run compares against. A run whose player count was
 * never readable asks for `all` rather than claiming to be solo — the file keeps
 * the null, so it is re-classifiable when the multiplayer reader is verified.
 */
export function bracketFor(playerCount: number | null): string {
  if (playerCount === null || playerCount === undefined) return 'all'
  return runCohort(playerCount)
}

function footnotesFor(
  state: RunAnalysis,
  metricsLanded: boolean,
  cohort: RunCohort
): AnalysisFootnote[] {
  const notes: AnalysisFootnote[] = []

  if (state.popularity) {
    const rates = Object.values(state.popularity.corePickRates)
    const runs = fmtCount(state.popularity.characterRuns)
    const total = fmtCount(state.popularity.cohortRuns)
    const spread =
      rates.length === 0
        ? 'this snapshot exposes no pick rates, so no popularity band can be computed'
        : `core picked ${Math.round(Math.min(...rates))}–${Math.round(Math.max(...rates))}% when offered`
    notes.push({
      chip: 'PROXY',
      text:
        `${runs} runs for this character in the ${state.popularity.bracket} bracket (${total} total) · ` +
        `${spread} — proxy, the API cannot count exact deck matches`
    })
  } else if (metricsLanded) {
    notes.push({
      chip: 'PROXY',
      text: 'the community metrics table carried no cohort counts, so no popularity proxy was computed'
    })
  }

  if (cohort !== 'solo') {
    notes.push({
      chip: 'MP',
      text:
        `${cohortLabel(cohort)} run — pace and deck comparisons use your ${cohortLabel(cohort)} archive only, ` +
        'and the community numbers above are this bracket as the API slices it, not a multiplayer-verified cohort'
    })
  }

  notes.push({
    chip: 'LOCAL',
    text:
      `${state.removalsPassed} of ${state.shopsVisited} shop${state.shopsVisited === 1 ? '' : 's'} left without a card removed · ` +
      'card use is counted from pile transitions at 250 ms, so play counts are approximate and aborted combats are excluded'
  })

  if (state.offline) {
    notes.push({
      chip: 'OFFLINE',
      text:
        'spire-codex.com could not be reached for part of this review — the local findings are complete; ' +
        'reviewing the run again adds the draft-advice replays'
    })
  } else if (state.pending.length > 0) {
    notes.push({
      chip: 'BUDGET',
      text: `${state.pending.length} offer${state.pending.length === 1 ? '' : 's'} went ungraded — this review spent its ${state.budget}-request budget`
    })
  }
  return notes
}

function fmtCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}

// ── resuming an interrupted analysis ─────────────────────────────────────────

/** What a previous attempt got through, read defensively from opaque JSON. */
export interface PriorAnalysis {
  requests: number
  draftErrors: number
  replayed: number[]
  pending: number[]
  apiVersion: number | null
  popularity: unknown
  offline: boolean
}

export function readPriorAnalysis(run: RunFile): PriorAnalysis | null {
  const raw = run.analysis
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bag = raw as Record<string, JournalJson>
  const requests = bag['requests']
  if (typeof requests !== 'number' || !Number.isFinite(requests)) return null
  const numbers = (v: JournalJson): number[] =>
    Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []
  return {
    requests,
    draftErrors: typeof bag['draftErrors'] === 'number' ? bag['draftErrors'] : 0,
    replayed: numbers(bag['replayed'] ?? null),
    pending: numbers(bag['pending'] ?? null),
    apiVersion: typeof bag['apiVersion'] === 'number' ? bag['apiVersion'] : null,
    popularity: bag['popularity'] ?? null,
    offline: bag['offline'] === true
  }
}
