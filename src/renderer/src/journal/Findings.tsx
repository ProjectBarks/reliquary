import styled from 'styled-components'
import type { AnalysisStatus } from '@shared/types'
import { Button } from '../dashboard/ui'
import { ErrorState, Loading } from '../codex/parts'
import { TierBadge } from '../codex/tiers'
import { DASH, fmtInt } from '../codex/format'
import { useEntities } from './art'
import type { AnalysisFinding, ParsedAnalysis } from './analysis'
import type { CohortAverage } from './cohort'
import { thinCohortLine } from './cohort'
import type { DeckLedger } from './derive'
import { fmtPace } from './format'
import {
  Art,
  CellGrid,
  CellKey,
  CellValue,
  Flag,
  GridCell,
  Note,
  Num,
  OutlineChip,
  Plate,
  Whisper
} from './parts'

/**
 * Journey Review — the summary strip, the finding cards, and the two footnotes.
 *
 * The pipeline that produces findings is WP6; what is built here is every
 * *state* around it, which is the part that outlives any one analysis schema:
 *
 *   - **done** — cards render from the parsed analysis.
 *   - **pending / partial** — the summary strip still renders, because half of
 *     its cells are computed right here from the deck ledger and owe the
 *     pipeline nothing. Dead cards and dead draws are the most useful numbers on
 *     the page and they are local; withholding them while a network review is
 *     queued would be theatre.
 *   - **failed / malformed** — said plainly, with the one useful button beside
 *     it. A blank review section reads as "nothing to say about this run",
 *     which is a different and untrue claim.
 *   - **none** — the run was never queued; offer to queue it.
 *
 * The PACE footnote is computed locally too, against the archive average *for
 * this run's player-count cohort* — a solo run against your solo runs, a 2P run
 * against your 2P runs (the user's decision). A cohort too thin to average says
 * so in its own words instead of borrowing another cohort's baseline.
 */

const SEVERITY_BG = {
  severe: 'var(--sts-color-red)',
  major: 'var(--sts-color-orange)',
  noted: 'var(--sts-color-gold)'
} as const

export function Findings({
  status,
  analysis,
  malformed,
  deck,
  perRoomAvgMs,
  cohort,
  shopsWithNoCard,
  onReanalyze,
  busy
}: {
  status: AnalysisStatus
  analysis: ParsedAnalysis | null
  malformed: boolean
  deck: DeckLedger
  /** This run's own pace. */
  perRoomAvgMs: number | null
  /** The archive average for this run's cohort — possibly thin. */
  cohort: CohortAverage
  shopsWithNoCard: number
  onReanalyze: () => void
  busy: boolean
}): JSX.Element {
  const findings = analysis?.findings ?? []

  return (
    <>
      <Summary analysis={analysis} deck={deck} />

      {status === 'pending' ? (
        <Loading label="Analysis queued — findings arrive when it lands." />
      ) : null}

      {status === 'failed' ? (
        <ErrorState
          title="The analysis for this run failed"
          message="Nothing was lost — the run file is complete and the review can be run again."
          onRetry={onReanalyze}
        />
      ) : null}

      {status !== 'pending' && status !== 'failed' && malformed ? (
        <ErrorState
          title="This run's analysis could not be read"
          message="The file carries a review written in a shape this version does not understand. Re-running it will rewrite it in the current one."
          onRetry={onReanalyze}
        />
      ) : null}

      {status === 'none' && !malformed ? (
        <NoneRow>
          <Note>This run has never been reviewed.</Note>
          <Button type="button" onClick={onReanalyze} disabled={busy}>
            Review this run
          </Button>
        </NoneRow>
      ) : null}

      {findings.length > 0 ? (
        <Cards>
          {findings.map((finding) => (
            <FindingCard key={finding.ref} finding={finding} />
          ))}
        </Cards>
      ) : status === 'done' && !malformed ? (
        <Note>No findings — the pipeline reviewed this run and had nothing to flag.</Note>
      ) : null}

      {status === 'partial' ? (
        <Whisper style={{ margin: '12px 2px 0' }}>
          analysis partial — more findings may still arrive
        </Whisper>
      ) : null}

      <Footnotes>
        <Footnote>
          <OutlineChip>pace</OutlineChip>
          <FootnoteText>
            {fmtPace(perRoomAvgMs)} / room —{' '}
            {cohort.thin
              ? thinCohortLine(cohort)
              : `${cohort.label.toLowerCase()} archive average ${fmtPace(cohort.perRoomAvgMs)} across ${cohort.runs} runs`}
            {shopsWithNoCard > 0
              ? ` · ${shopsWithNoCard} shop${shopsWithNoCard === 1 ? '' : 's'} left with no card gained`
              : ''}
          </FootnoteText>
        </Footnote>
        {(analysis?.footnotes ?? []).map((note) => (
          <Footnote key={note.chip}>
            <OutlineChip>{note.chip}</OutlineChip>
            <FootnoteText>{note.text}</FootnoteText>
          </Footnote>
        ))}
      </Footnotes>
    </>
  )
}

/**
 * The audit strip. Local cells always; pipeline cells when there is a pipeline
 * answer, and a `·` rather than a zero when there is not — "nothing was found"
 * and "nothing has looked yet" must not render the same.
 */
function Summary({
  analysis,
  deck
}: {
  analysis: ParsedAnalysis | null
  deck: DeckLedger
}): JSX.Element {
  const severe = analysis?.findings.filter((f) => f.severity === 'severe').length ?? null
  return (
    <CellGrid $min="128px" style={{ marginBottom: 14 }}>
      <Cell label="Findings" value={analysis ? String(analysis.findings.length) : DASH} />
      <Cell
        label="Severe"
        value={severe === null ? DASH : String(severe)}
        tone={severe ? 'var(--sts-color-red)' : null}
      />
      <Cell
        label="Draft errors"
        value={analysis?.draftErrors == null ? DASH : String(analysis.draftErrors)}
        tone={analysis?.draftErrors ? 'var(--sts-color-orange)' : null}
      />
      <Cell
        label="Dead cards"
        value={deck.countsMissing ? DASH : String(deck.neverPlayed)}
        tone={deck.neverPlayed ? 'var(--sts-color-red)' : null}
      />
      <Cell
        label="Dead draws"
        value={deck.dead === null ? DASH : fmtInt(deck.dead)}
        tone={deck.dead ? 'var(--sts-color-orange)' : null}
      />
      <Cell
        label="Removals passed"
        value={analysis?.removalsPassed == null ? DASH : String(analysis.removalsPassed)}
      />
      <Cell
        label="Grade of best pass"
        value={
          analysis?.bestPass
            ? `${analysis.bestPass.tier ?? '·'} · ${analysis.bestPass.score ?? '·'}`
            : DASH
        }
        tone={analysis?.bestPass ? 'var(--sts-color-green)' : null}
      />
    </CellGrid>
  )
}

function Cell({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: string | null
}): JSX.Element {
  return (
    <GridCell>
      <CellKey>{label}</CellKey>
      <CellValue $tone={tone ?? null}>
        <Num>{value}</Num>
      </CellValue>
    </GridCell>
  )
}

function FindingCard({ finding }: { finding: AnalysisFinding }): JSX.Element {
  const entities = useEntities()
  const hasRenders = Boolean(finding.passed || finding.taken)

  return (
    <Card>
      <CardHead>
        <Flag>{finding.ref}</Flag>
        <Plate $bg={SEVERITY_BG[finding.severity]}>{finding.severity}</Plate>
        <h3>{finding.title}</h3>
        {finding.at ? <At>{finding.at}</At> : null}
      </CardHead>
      <CardBody $split={!hasRenders && finding.minis.length > 0} $wide={!hasRenders}>
        {hasRenders ? (
          <Renders>
            {finding.passed ? (
              <Slot>
                <span className="cap">Passed</span>
                <Art
                  entity={entities.card(finding.passed.id)}
                  variant="big"
                  edge="passed"
                  alt={entities.card(finding.passed.id).name}
                />
                <span className="nm">{entities.card(finding.passed.id).name}</span>
                <Grade $good>
                  <b>
                    <Num>{finding.passed.score ?? DASH}</Num>
                  </b>
                  <TierBadge $tier={finding.passed.tier}>{finding.passed.tier ?? DASH}</TierBadge>
                </Grade>
              </Slot>
            ) : null}
            {finding.taken ? (
              <Slot $stock={finding.outcome === 'left-in-stock'}>
                <span className="cap">
                  {finding.outcome === 'left-in-stock' ? 'Outcome' : 'Taken'}
                </span>
                <StockWrap>
                  <Art
                    entity={entities.card(finding.taken.id)}
                    variant="big"
                    edge={finding.outcome === 'left-in-stock' ? 'stock' : null}
                    alt={entities.card(finding.taken.id).name}
                  />
                  {finding.outcome === 'left-in-stock' ? (
                    <StockPlate>left in stock</StockPlate>
                  ) : null}
                </StockWrap>
                <span className="nm">
                  {finding.outcome === 'left-in-stock'
                    ? 'never entered the deck'
                    : entities.card(finding.taken.id).name}
                </span>
                {finding.outcome === 'left-in-stock' ? (
                  finding.cost === null ? null : (
                    <Cost>
                      <Num>{finding.cost}g</Num>
                    </Cost>
                  )
                ) : (
                  <Grade>
                    <b>
                      <Num>{finding.taken.score ?? DASH}</Num>
                    </b>
                    <TierBadge $tier={finding.taken.tier}>{finding.taken.tier ?? DASH}</TierBadge>
                  </Grade>
                )}
              </Slot>
            ) : null}
          </Renders>
        ) : finding.minis.length > 0 ? (
          <Minis>
            {finding.minis.map((mini) => (
              <Mini key={`${mini.id}-${mini.label ?? ''}`}>
                <Art entity={entities.card(mini.id)} variant="sprite" />
                <span className="who">
                  {entities.card(mini.id).name}
                  {mini.label ? <em>{mini.label}</em> : null}
                </span>
                <Tally>{mini.tally}</Tally>
              </Mini>
            ))}
          </Minis>
        ) : null}

        <CardMain>
          {finding.evidence.length > 0 ? (
            <Evidence>
              {finding.evidence.map((chip) => (
                <EvidenceChip key={chip.label}>
                  {chip.label}
                  {chip.value ? <b>{chip.value}</b> : null}
                </EvidenceChip>
              ))}
            </Evidence>
          ) : null}
          {finding.verdict ? <VerdictLine>{finding.verdict}</VerdictLine> : null}
          {finding.mono ? <Whisper as="p">{finding.mono}</Whisper> : null}
        </CardMain>
      </CardBody>
    </Card>
  )
}

// ── surfaces ────────────────────────────────────────────────────────────────

const NoneRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
`

const Cards = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
`

const Card = styled.article`
  background: rgba(38, 35, 33, 0.66);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);
  overflow: hidden;
`

const CardHead = styled.header`
  display: flex;
  align-items: center;
  gap: 11px;
  flex-wrap: wrap;
  padding: 10px 15px;
  border-bottom: 1px solid var(--line);
  background: oklch(0 0 0 / 14%);

  h3 {
    margin: 0;
    flex: 1 1 260px;
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 15.5px;
    letter-spacing: 0.3px;
    color: var(--ink);
  }
`

const At = styled.span`
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.6px;
  color: var(--ink-faint);
  white-space: nowrap;
`

const CardBody = styled.div<{ $split: boolean; $wide: boolean }>`
  display: grid;
  gap: 18px;
  padding: 14px 15px 15px;
  grid-template-columns: ${(p) =>
    p.$split
      ? 'minmax(320px, 420px) minmax(0, 1fr)'
      : p.$wide
        ? 'minmax(0, 1fr)'
        : '236px minmax(0, 1fr)'};
  align-items: start;

  @media (max-width: 1080px) {
    grid-template-columns: minmax(0, 1fr);
  }
`

const Renders = styled.div`
  display: flex;
  gap: 16px;
`

const Slot = styled.figure<{ $stock?: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 110px;
  margin: 0;

  .cap {
    font-family: var(--font-body);
    font-weight: 600;
    font-size: 9px;
    letter-spacing: 1.1px;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .nm {
    font-size: 11.5px;
    font-weight: 600;
    text-align: center;
    line-height: 1.25;
    color: ${(p) => (p.$stock ? 'var(--ink-dim)' : 'var(--ink)')};
  }
`

const StockWrap = styled.span`
  position: relative;
  display: inline-flex;
`

const StockPlate = styled.span`
  position: absolute;
  z-index: 2;
  left: 6px;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  padding: 6px 0;
  text-align: center;
  background: #211e1c;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--ink-dim);
`

const Grade = styled.span<{ $good?: boolean }>`
  display: flex;
  align-items: center;
  gap: 7px;

  b {
    font-family: var(--font-display);
    font-size: 16px;
    line-height: 1;
    /* The passed card's score is the one the reader is meant to regret. */
    color: ${(p) => (p.$good ? 'var(--sts-color-green)' : 'var(--ink)')};
    font-variant-numeric: tabular-nums;
  }
`

const Cost = styled.span`
  font-family: var(--font-display);
  font-size: 13px;
  letter-spacing: 0.3px;
  color: var(--sts-color-gold);
`

const Minis = styled.div`
  display: flex;
  flex-direction: column;
  max-width: 520px;
`

const Mini = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-top: 1px solid var(--line);
  &:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .who {
    flex: 1 1 auto;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ink);
  }
  .who em {
    font-style: normal;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--ink-faint);
    margin-left: 8px;
  }
`

const Tally = styled.span`
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.4px;
  color: var(--sts-color-red);
  font-variant-numeric: tabular-nums;
`

const CardMain = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
`

const Evidence = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const EvidenceChip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 21px;
  padding: 1px 8px;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  color: var(--ink-dim);
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 11px;
  white-space: nowrap;

  b {
    font-weight: 700;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
`

const VerdictLine = styled.p`
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink);
  max-width: 62ch;
`

const Footnotes = styled.div`
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 14px 2px 0;
`

const Footnote = styled.p`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
`

const FootnoteText = styled.span`
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.65;
  letter-spacing: 0.2px;
  color: var(--ink-faint);
`
