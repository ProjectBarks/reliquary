import styled from 'styled-components'
import type { AnalysisStatus } from '@shared/types'
import { Button } from '../dashboard/ui'
import { ErrorState, Loading } from '../codex/parts'
import { TierBadge } from '../codex/tiers'
import { DASH, fmtInt } from '../codex/format'
import { useEntities } from './art'
import type { AnalysisFinding, ParsedAnalysis } from './analysis'
import type { DeckLedger } from './derive'
import {
  Art,
  CellGrid,
  CellKey,
  CellValue,
  Flag,
  GridCell,
  Note,
  Num,
  Plate,
  Whisper
} from './parts'

/**
 * Journey Review — the summary strip and the finding cards.
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
 * **There is no footnote block, and no "still arriving" line.** Both were
 * removed on the user's call and neither was a small loss dressed up as a win:
 * a row of chips reading PACE / PROXY / LOCAL / BUDGET under a page of findings
 * was a second, quieter report about the *reviewer* rather than about the run,
 * and "analysis partial, more findings may still arrive" was a status the
 * reader can neither act on nor wait for on this screen. Every one of those
 * sentences is still in the run file and goes out whole in the exported JSON —
 * this file simply stopped printing them. Pace survives where it was already
 * being read: the header's own stat cell, whose tooltip now carries the cohort
 * average the PACE chip used to state.
 *
 * The finding card is **two columns**: the verdict in words on the left, the
 * cards and grades it is about on the right. See `CardGrid`.
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
  onReanalyze,
  busy
}: {
  status: AnalysisStatus
  analysis: ParsedAnalysis | null
  malformed: boolean
  deck: DeckLedger
  onReanalyze: () => void
  busy: boolean
}): JSX.Element {
  const findings = analysis?.findings ?? []

  return (
    <>
      <Summary analysis={analysis} deck={deck} />

      {status === 'pending' ? (
        <Loading label="Analysis queued. Findings arrive when it lands." />
      ) : null}

      {status === 'failed' ? (
        <ErrorState
          title="The analysis for this run failed"
          message="Nothing was lost. The run file is complete and the review can be run again."
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
        <Note>Nothing to flag.</Note>
      ) : null}
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

/**
 * One finding, in two columns: what we think, and what it is about.
 *
 * Column one is the whole verdict as language — the flag and severity, the
 * headline, the sentence, its evidence chips, and the provenance whisper that
 * says where the judgement came from. A reader can read that column alone and
 * have the finding.
 *
 * Column two is the material: the card that should have been taken above the
 * card that was, stacked, with the `vs` between them. Stacked rather than side
 * by side because the pair is not a comparison of two options in a row of
 * options — it is one *substitution*, read top to bottom, and side-by-side art
 * spent the card's full width saying so while pushing the sentence into a
 * narrow gutter. When a finding has no cards but a list of offenders (dead
 * cards, repeat draws), that list is what column two holds instead.
 *
 * With neither, there is no second column at all and the verdict runs the full
 * width — an empty half card is worse than a wide paragraph.
 */
function FindingCard({ finding }: { finding: AnalysisFinding }): JSX.Element {
  const entities = useEntities()
  const hasRenders = Boolean(finding.passed || finding.taken)
  const hasMinis = !hasRenders && finding.minis.length > 0
  const stock = finding.outcome === 'left-in-stock'

  return (
    <Card>
      <CardGrid $two={hasRenders || hasMinis}>
        <Verdict>
          <VerdictHead>
            <Flag>{finding.ref}</Flag>
            <Plate $bg={SEVERITY_BG[finding.severity]}>{finding.severity}</Plate>
            {finding.at ? <At>{finding.at}</At> : null}
          </VerdictHead>
          <h3>{finding.title}</h3>
          {finding.verdict ? <VerdictLine>{finding.verdict}</VerdictLine> : null}
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
          {finding.mono ? <Whisper as="p">{finding.mono}</Whisper> : null}
        </Verdict>

        {hasRenders ? (
          <Judgement>
            {finding.passed ? (
              <Slot>
                <Art
                  entity={entities.card(finding.passed.id)}
                  variant="big"
                  edge="passed"
                  alt={entities.card(finding.passed.id).name}
                />
                <SlotText>
                  <span className="cap">should have taken</span>
                  <span className="nm">{entities.card(finding.passed.id).name}</span>
                  <Grade $good>
                    <b>
                      <Num>{finding.passed.score ?? DASH}</Num>
                    </b>
                    <TierBadge $tier={finding.passed.tier}>{finding.passed.tier ?? DASH}</TierBadge>
                  </Grade>
                </SlotText>
              </Slot>
            ) : null}

            {finding.passed && finding.taken ? <Vs>vs</Vs> : null}

            {finding.taken ? (
              <Slot $stock={stock}>
                <StockWrap>
                  <Art
                    entity={entities.card(finding.taken.id)}
                    variant="big"
                    edge={stock ? 'stock' : null}
                    alt={entities.card(finding.taken.id).name}
                  />
                  {stock ? <StockPlate>left in stock</StockPlate> : null}
                </StockWrap>
                <SlotText>
                  <span className="cap">{stock ? 'stayed in the shop' : 'you took'}</span>
                  <span className="nm">
                    {stock ? 'never entered the deck' : entities.card(finding.taken.id).name}
                  </span>
                  {stock ? (
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
                </SlotText>
              </Slot>
            ) : null}
          </Judgement>
        ) : hasMinis ? (
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
      </CardGrid>
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

/**
 * The two columns.
 *
 * The text column is fluid and the card column is fixed: art has a true size
 * and stretching it buys nothing, while a verdict sentence wants every pixel it
 * can get. 296px holds a 94px render, a 12px gutter and enough room for the
 * longest card name in the game without hyphenating it; at the dashboard's
 * 1180px content width that leaves the verdict a comfortable ~760px, and its
 * own `62ch` measure keeps the line from outrunning the eye.
 *
 * Below 1080px the two columns become one, verdict first: a 296px sidebar and a
 * paragraph cannot both be readable in what is left of a narrow window, and the
 * sentence is the half that carries the finding.
 */
const CardGrid = styled.div<{ $two: boolean }>`
  display: grid;
  gap: 22px;
  padding: 15px 16px 16px;
  grid-template-columns: ${(p) => (p.$two ? 'minmax(0, 1fr) 296px' : 'minmax(0, 1fr)')};
  align-items: start;

  @media (max-width: 1080px) {
    grid-template-columns: minmax(0, 1fr);
  }
`

/** Column one: flag and severity, headline, sentence, evidence, provenance. */
const Verdict = styled.div`
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;

  /* The column's own gap sets the rhythm; a browser's default paragraph margin
     on the provenance whisper would double the space above it. */
  p {
    margin: 0;
  }

  h3 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 400;
    font-size: var(--fs-md);
    line-height: 1.3;
    letter-spacing: 0.3px;
    color: var(--ink);
  }
`

const VerdictHead = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`

const At = styled.span`
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.6px;
  color: var(--ink-faint);
  white-space: nowrap;
`

/**
 * Column two: the substitution, framed as one object so it reads as a single
 * exhibit rather than as two loose pictures beside a paragraph.
 */
const Judgement = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: oklch(0 0 0 / 16%);
`

const Slot = styled.figure<{ $stock?: boolean }>`
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0;
  min-width: 0;

  .cap {
    font-family: var(--font-body);
    font-weight: 600;
    font-size: var(--fs-2xs);
    line-height: var(--lh-tight);
    letter-spacing: 1.1px;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .nm {
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 1.3;
    color: ${(p) => (p.$stock ? 'var(--ink-dim)' : 'var(--ink)')};
  }
`

const SlotText = styled.figcaption`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
`

/**
 * The relationship between the two slots, and the only thing in the card that
 * is a word about the layout rather than about the run — so it is a hairline
 * with two letters on it, not a label.
 */
const Vs = styled.div`
  display: flex;
  align-items: center;
  gap: 9px;
  font-family: var(--font-display);
  font-size: var(--fs-2xs);
  line-height: 1;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  color: var(--ink-faint);

  &::before,
  &::after {
    content: '';
    flex: 1 1 auto;
    height: 1px;
    background: var(--line-strong);
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
  font-size: var(--fs-2xs);
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
    font-size: var(--fs-md);
    line-height: 1;
    /* The passed card's score is the one the reader is meant to regret. */
    color: ${(p) => (p.$good ? 'var(--sts-color-green)' : 'var(--ink)')};
    font-variant-numeric: tabular-nums;
  }
`

const Cost = styled.span`
  font-family: var(--font-display);
  font-size: var(--fs-base);
  letter-spacing: 0.3px;
  color: var(--sts-color-gold);
`

/** The other thing column two can hold: the run's repeat offenders, listed. */
const Minis = styled.div`
  display: flex;
  flex-direction: column;
  padding: 4px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: oklch(0 0 0 / 16%);
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
    min-width: 0;
    font-size: var(--fs-sm);
    font-weight: 500;
    line-height: 1.35;
    color: var(--ink);
  }
  .who em {
    display: block;
    font-style: normal;
    font-family: var(--font-mono);
    font-size: var(--fs-2xs);
    color: var(--ink-faint);
  }
`

const Tally = styled.span`
  font-family: var(--font-display);
  font-size: var(--fs-md);
  letter-spacing: 0.4px;
  color: var(--sts-color-red);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
  font-size: var(--fs-xs);
  white-space: nowrap;

  b {
    font-weight: 700;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
`

const VerdictLine = styled.p`
  margin: 0;
  font-size: var(--fs-base);
  line-height: var(--lh-body);
  color: var(--ink);
  max-width: 62ch;
`
