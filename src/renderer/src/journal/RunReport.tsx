import { useCallback, useMemo, useState } from 'react'
import type { RunFile } from '@shared/types'
import { runCohort } from '@shared/types'
import { Section, SectionHead, SectionNote, SectionTitle } from '../dashboard/ui'
import { ErrorState, Loading } from '../codex/parts'
import { DASH } from '../codex/format'
import { budgetLine, flagsByRoom, readAnalysis } from './analysis'
import { cohortPace } from './cohort'
import { useJournalCatalog, reanalyzeRun, useRunFile } from './data'
import { deriveDeck, deriveRoute, isPartial } from './derive'
import { DeckLedger } from './DeckLedger'
import { Findings } from './Findings'
import { CensusStrip, RouteLedger, RoutePartialNote } from './RouteLedger'
import { NotReadableChip, RelicsStrip } from './RelicsStrip'
import {
  ANALYSIS_WORD,
  HONESTY_LINE,
  characterName,
  characterTint,
  fmtDuration,
  fmtPace,
  outcomeBanner,
  runStamp
} from './format'
import {
  Banner,
  CharValue,
  EmptyPlate,
  Num,
  PCell,
  Plaque,
  RunHead,
  RunHeadTop,
  RunTitle,
  Whisper
} from './parts'

/**
 * One finished run, read end to end.
 *
 * The section order is the mockup's and is not arbitrary: the plaque answers
 * "what was this run", the Route Ledger answers "what happened", the Deck
 * Ledger answers "what did I actually play", and the Review answers "what
 * should I have done differently". Each one is readable without the next, which
 * is what lets the Review be absent — pending, failed, or never queued — without
 * the page becoming a stub.
 *
 * The honesty whisper under the header is one line shorter than the mockup's,
 * and that is a real improvement rather than an edit: WP1 found the game's own
 * cumulative floor counter, so the report prints exact floors and no longer has
 * to apologise for counting rooms in their place.
 */

export function RunReport({ id }: { id: string }): JSX.Element {
  const run = useRunFile(id)
  const [busy, setBusy] = useState(false)

  const onReanalyze = useCallback(() => {
    setBusy(true)
    void reanalyzeRun(id).finally(() => setBusy(false))
  }, [id])

  if (run.loading && !run.data) return <Loading label="Opening the run file…" />
  if (!run.data) {
    return (
      <ErrorState
        title="That run could not be opened"
        message={run.error ?? 'The file is not in the archive any more.'}
        onRetry={run.refresh}
      />
    )
  }
  return <Report run={run.data} busy={busy} onReanalyze={onReanalyze} />
}

function Report({
  run,
  busy,
  onReanalyze
}: {
  run: RunFile
  busy: boolean
  onReanalyze: () => void
}): JSX.Element {
  const catalog = useJournalCatalog()
  const route = useMemo(() => deriveRoute(run), [run])
  const deck = useMemo(() => deriveDeck(run), [run])
  const analysis = useMemo(() => readAnalysis(run), [run])
  const flags = useMemo(() => flagsByRoom(analysis.value), [analysis.value])
  const cohort = useMemo(
    () => cohortPace(catalog.data, runCohort(run.playerCount), run.id),
    [catalog.data, run.playerCount, run.id]
  )

  const banner = outcomeBanner(run.state, run.outcome)
  const last = route.rooms[route.rooms.length - 1]
  const shopsWithNoCard = route.rooms.filter(
    (room) => room.room === 'shop' && room.notes.some((n) => n.t === 'no-purchase')
  ).length

  return (
    <>
      <Section>
        <SectionHead>
          <SectionTitle>Run Report</SectionTitle>
          <SectionNote>
            post-mortem · {ANALYSIS_WORD[run.analysisStatus]}
          </SectionNote>
        </SectionHead>

        <RunHeader
          run={run}
          banner={banner}
          lastRoom={last?.roomIndex ?? run.roomsEntered}
          budget={budgetLine(analysis.value)}
        />

        <Whisper style={{ margin: '10px 2px 0' }}>{HONESTY_LINE}</Whisper>
        {isPartial(run) ? (
          <Whisper style={{ margin: '4px 2px 0' }}>
            {run.observedFrom === 'mid-run'
              ? 'joined mid-run — every count below is a floor, not a total'
              : 'this run was played for a while without us — counts are under-counts'}
          </Whisper>
        ) : null}
      </Section>

      <Section>
        <SectionHead>
          <SectionTitle>Route Ledger</SectionTitle>
          <SectionNote>rooms in order entered</SectionNote>
        </SectionHead>
        <CensusStrip census={route.census} />
        <RouteLedger route={route} outcomeWord={banner.word} flags={flags} />
        {isPartial(run) ? <RoutePartialNote /> : null}
      </Section>

      <Section>
        <SectionHead>
          <SectionTitle>Deck Ledger</SectionTitle>
          <SectionNote>
            {deck.cards} cards in {deck.rows.length} rows · sorted by played, descending ·
            never-played last
          </SectionNote>
        </SectionHead>
        <DeckLedger deck={deck} halfDead={analysis.value?.halfDead} />
      </Section>

      <Section>
        <SectionHead>
          <SectionTitle>Relics &amp; Potions</SectionTitle>
          <NotReadableChip />
        </SectionHead>
        <RelicsStrip sightings={route.sightings} />
      </Section>

      <Section>
        <SectionHead>
          <SectionTitle>Journey Review</SectionTitle>
          <SectionNote>
            {analysis.value
              ? `${analysis.value.findings.length} finding${analysis.value.findings.length === 1 ? '' : 's'}`
              : ANALYSIS_WORD[run.analysisStatus]}
          </SectionNote>
        </SectionHead>
        <Findings
          status={run.analysisStatus}
          analysis={analysis.value}
          malformed={analysis.malformed}
          deck={deck}
          perRoomAvgMs={run.pace.perRoomAvgMs}
          cohort={cohort}
          shopsWithNoCard={shopsWithNoCard}
          onReanalyze={onReanalyze}
          busy={busy}
        />
      </Section>
    </>
  )
}

/**
 * The plaque.
 *
 * Every cell here is something a reader can act on, and the cells the mockup
 * had to leave out — HP, gold, ascension — are *absent* rather than dashed. A
 * grid of `·` reads as a broken screen; an absence with one honest line under
 * it reads as a limit somebody knows about.
 */
function RunHeader({
  run,
  banner,
  lastRoom,
  budget
}: {
  run: RunFile
  banner: { word: string; tone: 'red' | 'green' | 'gold' | 'aqua' }
  lastRoom: number
  /** "analysis 11 req / budget 12", when the pipeline reported one. */
  budget: string | null
}): JSX.Element {
  const tint = characterTint(run.character)
  const stamp = runStamp(run)
  const act = run.actReached
  const deckSize = run.finalDeck
    ? run.finalDeck.reduce((n, row) => n + row.count, 0)
    : run.snapshot.deckSize
  const rows = run.finalDeck
    ? new Set(run.finalDeck.map((row) => row.id)).size
    : null

  return (
    <RunHead $frame={tint.frame} $edge={tint.edge}>
      <RunHeadTop>
        <RunTitle>
          <h1>
            <em style={{ color: tint.edge }}>{characterName(run.character)}</em> — RUN REPORT
          </h1>
          <Whisper>
            run {stamp.stamp} · {stamp.tail} · game {run.gameVersion ?? 'unknown'} · schema{' '}
            {run.schema}
            {budget ? ` · ${budget}` : ` · ${ANALYSIS_WORD[run.analysisStatus]}`}
          </Whisper>
        </RunTitle>
        <Banner $tone={banner.tone}>
          <span className="word">{banner.word}</span>
          <span className="sub">
            {run.outcome === 'superseded'
              ? 'a later run replaced this save'
              : `last room · act ${act === null ? DASH : act + 1}`}{' '}
            · <b>R{lastRoom}</b>
          </span>
        </Banner>
      </RunHeadTop>

      <Plaque $frame={tint.frame}>
        <PCell>
          <div className="k">Character</div>
          <CharValue $edge={tint.edge}>{characterName(run.character)}</CharValue>
          <div className="w">{run.playerCount && run.playerCount > 1 ? `${run.playerCount} players` : 'solo'}</div>
        </PCell>
        <PCell>
          <div className="k">Act</div>
          <div className="v">
            <Num>{act === null ? DASH : act + 1}</Num> <small>of 3</small>
          </div>
          <div className="w">as read</div>
        </PCell>
        <PCell>
          <div className="k">Deck</div>
          <div className="v">
            <Num>{deckSize}</Num>
          </div>
          <div className="w">{rows === null ? 'in progress' : `${rows} rows`}</div>
        </PCell>
        <PCell>
          <div className="k">Rooms</div>
          <div className="v">
            <Num>
              {isPartial(run) ? '≈' : ''}
              {run.roomsEntered}
            </Num>
          </div>
          <div className="w">
            {run.floorReached === null ? 'entered' : `entered · floor ${run.floorReached}`}
          </div>
        </PCell>
        <PCell>
          <div className="k">Pace</div>
          <div className="v" style={{ fontSize: 18 }}>
            {fmtPace(run.pace.perRoomAvgMs)}
          </div>
          <div className="w">per room</div>
        </PCell>
        <PCell>
          <div className="k">Elapsed</div>
          <div className="v" style={{ fontSize: 18 }}>
            {fmtDuration(run.pace.elapsedMs)}
          </div>
          <div className="w" title="Observed play time, not wall clock">
            observed time
          </div>
        </PCell>
      </Plaque>
    </RunHead>
  )
}

/** The Journal tab's index when the archive holds nothing finished yet. */
export function NoRunsYet(): JSX.Element {
  return (
    <Section>
      <SectionHead>
        <SectionTitle>Run Report</SectionTitle>
        <SectionNote>nothing to read yet</SectionNote>
      </SectionHead>
      <EmptyPlate>
        <strong>No finished run on file.</strong>
        <span>
          Play a run with Reliquary open and its report writes itself here — the route you took,
          the deck you ended with, and what the draft would have done differently. A run in
          progress shows up under Current Run first.
        </span>
      </EmptyPlate>
    </Section>
  )
}
