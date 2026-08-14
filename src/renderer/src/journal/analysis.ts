import type { JournalJson, RunFile } from '@shared/types'

/**
 * The post-run analysis blob, read defensively.
 *
 * `RunFile.analysis` is typed `JournalJson` — arbitrary JSON — on purpose: the
 * pipeline that writes it is WP6, the store has no business typing its output,
 * and a run file written by a *newer* pipeline than this renderer must still
 * open. So this module is the renderer's half of that contract, and it is
 * written as a parser rather than a cast: every field is checked, every absence
 * is a state rather than a crash, and a blob shaped like nothing recognisable
 * reports `malformed` so the review section can say "this run's analysis could
 * not be read" instead of rendering an empty page that looks like "no findings".
 *
 * **The shape below is the contract WP6 must emit.** It is written down here,
 * in the only place that reads it, because the alternative — putting it in
 * `shared/journal.ts` — would freeze the pipeline's schema into the IPC surface
 * before the pipeline exists. When WP6 lands, either it emits this shape or it
 * updates this file; nothing else in the tab knows about it.
 *
 * ```jsonc
 * {
 *   "apiVersion": 41,
 *   "requests": 11,
 *   "budget": 12,
 *   "draftErrors": 3,
 *   "removalsPassed": 2,
 *   "bestPass": { "score": 47, "tier": "A" },
 *   "halfDead": ["CARNAGE"],          // deck rows whose extra copies never landed
 *   "findings": [
 *     {
 *       "ref": "F-01",
 *       "severity": "severe",         // severe | major | noted
 *       "title": "Took Twin Strike over Feel No Pain",
 *       "at": "R12",
 *       "roomIndex": 12,              // attaches the flag to a route row
 *       "passed": { "id": "FEEL_NO_PAIN", "score": 44, "tier": "A" },
 *       "taken":  { "id": "TWIN_STRIKE", "score": 12, "tier": "D" },
 *       "outcome": "taken",           // taken | left-in-stock
 *       "cost": 187,                  // gold, for a left-in-stock outcome
 *       "evidence": [{ "label": "Bloodletting", "value": "68%" }],
 *       "verdict": "One sentence, ≤22 words.",
 *       "mono": "cardReward · act 1 · deck 18 · advice captured live",
 *       "minis": [{ "id": "TWIN_STRIKE", "label": "taken R12", "tally": "0 / 11 drawn" }]
 *     }
 *   ],
 *   "footnotes": [{ "chip": "PROXY", "text": "…" }]
 * }
 * ```
 */

// ── the shape ───────────────────────────────────────────────────────────────

export type FindingSeverity = 'severe' | 'major' | 'noted'

export interface AnalysisCard {
  id: string
  /** Codex Score, when the pipeline graded it. */
  score: number | null
  /** Letter grade, when it graded it. */
  tier: string | null
}

export interface AnalysisMini {
  id: string
  /** "taken R12" — where it came from. */
  label: string | null
  /** "0 / 11 drawn" — the tally, pre-formatted by the pipeline. */
  tally: string
}

export interface AnalysisEvidence {
  label: string
  value: string | null
}

export interface AnalysisFinding {
  ref: string
  severity: FindingSeverity
  title: string
  /** Where it happened, as a label ("R12", "deck rows 12 · 18 · 19"). */
  at: string | null
  /** Which route row carries the flag chip, when the pipeline named one. */
  roomIndex: number | null
  passed: AnalysisCard | null
  taken: AnalysisCard | null
  /** `left-in-stock` renders the passed card dimmed under a plate. */
  outcome: 'taken' | 'left-in-stock' | null
  cost: number | null
  evidence: AnalysisEvidence[]
  verdict: string | null
  mono: string | null
  minis: AnalysisMini[]
}

export interface AnalysisFootnote {
  chip: string
  text: string
}

export interface ParsedAnalysis {
  findings: AnalysisFinding[]
  footnotes: AnalysisFootnote[]
  /** Deck rows the pipeline judged to be carrying a dead extra copy. */
  halfDead: string[]
  requests: number | null
  budget: number | null
  apiVersion: number | null
  draftErrors: number | null
  removalsPassed: number | null
  bestPass: AnalysisCard | null
}

export interface AnalysisRead {
  /** Null when there is no analysis on the file, or none we could read. */
  value: ParsedAnalysis | null
  /**
   * True when the file *has* an analysis blob that this build could not make
   * sense of. The review section says so rather than showing "no findings",
   * which would be a different and untrue statement.
   */
  malformed: boolean
}

// ── the parser ──────────────────────────────────────────────────────────────

type Bag = Record<string, JournalJson>

function bag(v: JournalJson): Bag | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : null
}

function text(v: JournalJson): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function number(v: JournalJson): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function list(v: JournalJson): JournalJson[] {
  return Array.isArray(v) ? v : []
}

function severity(v: JournalJson): FindingSeverity {
  const s = text(v)?.toLowerCase()
  return s === 'severe' ? 'severe' : s === 'noted' ? 'noted' : 'major'
}

function card(v: JournalJson): AnalysisCard | null {
  const row = bag(v)
  const id = row ? text(row['id']) : null
  if (!id) return null
  return { id, score: number(row!['score']), tier: text(row!['tier']) }
}

function evidence(v: JournalJson): AnalysisEvidence[] {
  return list(v)
    .map((raw) => {
      const row = bag(raw)
      if (!row) {
        const flat = text(raw)
        return flat ? { label: flat, value: null } : null
      }
      const label = text(row['label'])
      return label ? { label, value: text(row['value']) } : null
    })
    .filter((e): e is AnalysisEvidence => e !== null)
}

function minis(v: JournalJson): AnalysisMini[] {
  return list(v)
    .map((raw) => {
      const row = bag(raw)
      const id = row ? text(row['id']) : null
      if (!id) return null
      return { id, label: text(row!['label']), tally: text(row!['tally']) ?? '' }
    })
    .filter((m): m is AnalysisMini => m !== null)
}

function finding(raw: JournalJson, index: number): AnalysisFinding | null {
  const row = bag(raw)
  if (!row) return null
  const title = text(row['title'])
  if (!title) return null
  const outcomeText = text(row['outcome'])
  return {
    ref: text(row['ref']) ?? `F-${String(index + 1).padStart(2, '0')}`,
    severity: severity(row['severity']),
    title,
    at: text(row['at']),
    roomIndex: number(row['roomIndex']),
    passed: card(row['passed']),
    taken: card(row['taken']),
    outcome:
      outcomeText === 'left-in-stock' ? 'left-in-stock' : outcomeText === 'taken' ? 'taken' : null,
    cost: number(row['cost']),
    evidence: evidence(row['evidence']),
    verdict: text(row['verdict']),
    mono: text(row['mono']),
    minis: minis(row['minis'])
  }
}

/**
 * Read a run's analysis. Never throws, never returns a half-built object: a
 * blob that yields no findings *and* no counters is treated as unreadable
 * rather than as an empty review, because those are different answers.
 */
export function readAnalysis(run: Pick<RunFile, 'analysis'>): AnalysisRead {
  const root = bag(run.analysis)
  if (!root) return { value: null, malformed: run.analysis != null }

  const findings = list(root['findings'])
    .map((raw, i) => finding(raw, i))
    .filter((f): f is AnalysisFinding => f !== null)

  const footnotes = list(root['footnotes'])
    .map((raw) => {
      const row = bag(raw)
      const chipText = row ? text(row['chip']) : null
      const body = row ? text(row['text']) : null
      return chipText && body ? { chip: chipText, text: body } : null
    })
    .filter((f): f is AnalysisFootnote => f !== null)

  const value: ParsedAnalysis = {
    findings,
    footnotes,
    halfDead: list(root['halfDead'])
      .map((v) => text(v))
      .filter((v): v is string => v !== null),
    requests: number(root['requests']),
    budget: number(root['budget']),
    apiVersion: number(root['apiVersion']),
    draftErrors: number(root['draftErrors']),
    removalsPassed: number(root['removalsPassed']),
    bestPass: card(root['bestPass'])
  }

  const empty =
    findings.length === 0 &&
    footnotes.length === 0 &&
    value.requests === null &&
    value.draftErrors === null &&
    value.bestPass === null
  if (empty) return { value: null, malformed: true }
  return { value, malformed: false }
}

/** `F-01` by route row, so the ledger can print the flag beside the room. */
export function flagsByRoom(parsed: ParsedAnalysis | null): Map<number, string> {
  const map = new Map<number, string>()
  for (const f of parsed?.findings ?? []) {
    if (f.roomIndex === null) continue
    if (!map.has(f.roomIndex)) map.set(f.roomIndex, f.ref)
  }
  return map
}

/** The manifest whisper's budget clause, or null when the pipeline said nothing. */
export function budgetLine(parsed: ParsedAnalysis | null): string | null {
  if (!parsed) return null
  if (parsed.requests === null) return null
  return parsed.budget === null
    ? `analysis ${parsed.requests} req`
    : `analysis ${parsed.requests} req / budget ${parsed.budget}`
}
