import { useCallback, useMemo, useState } from 'react'
import styled from 'styled-components'
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
  OutlineChip,
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
 * **A section with nothing in it is not rendered.** The Deck Ledger of a run
 * that has not ended yet, and the relic strip of a run that never walked into a
 * shop, used to print a sentence explaining their own emptiness. Two paragraphs
 * of apology is a worse answer than a page that is simply one section shorter —
 * the reader who wants the deck of a live run is one click away in Current Run,
 * and nobody has ever needed to be told that a run without merchants saw no
 * merchandise.
 *
 * The header carries no section title of its own either: the sub-nav says
 * Journal, the picker names the run, and the plaque's own h1 says RUN REPORT.
 * What is left is one mono identity line — date, handle, game build — with the
 * bookkeeping a reader never reads (schema, request budget, what v1 cannot see)
 * moved onto tooltips and into the export, which is where audit trails belong.
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
        <RunHeader
          run={run}
          banner={banner}
          lastRoom={last?.roomIndex ?? run.roomsEntered}
          budget={budgetLine(analysis.value)}
        />

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

      {/* No final deck means the run has not ended: the deck-so-far is on the
          Current Run view, alive, and an empty ledger explaining that here
          would be a section-sized signpost. */}
      {deck.empty ? null : (
        <Section>
          <SectionHead>
            <SectionTitle>Deck Ledger</SectionTitle>
            <SectionNote title="Sorted by played, descending — never-played rows last">
              {deck.cards} cards · {deck.rows.length} rows
            </SectionNote>
          </SectionHead>
          <DeckLedger deck={deck} halfDead={analysis.value?.halfDead} />
        </Section>
      )}

      {/* Shop stock is the only relic/potion fact v1 can observe, so a run that
          met no merchant has nothing to put here — and says nothing. */}
      {route.sightings.length === 0 ? null : (
        <Section>
          <SectionHead>
            <SectionTitle>Relics &amp; Potions</SectionTitle>
            <NotReadableChip />
          </SectionHead>
          <RelicsStrip sightings={route.sightings} />
        </Section>
      )}

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
 * grid of `·` reads as a broken screen; an absence reads as a report that only
 * prints what it saw. The line that used to name those absences is a tooltip on
 * the manifest now: the reader who wonders where gold went can hover, and the
 * reader who never wondered is not charged a line for the answer.
 *
 * The manifest itself is identity only — the stamp, the handle, the game build
 * — because that is the part a reader recognises. `schema 1 · analysis 0 req /
 * budget 12` is bookkeeping about the *file*, not about the run; it rides the
 * analysis chip's tooltip and goes out whole in the export.
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
          <Manifest>
            <Whisper title={HONESTY_LINE}>
              run {stamp.stamp} · {stamp.tail} · game {run.gameVersion ?? 'unknown'}
            </Whisper>
            <OutlineChip
              title={`schema ${run.schema}${budget ? ` · ${budget}` : ''} — also in the exported JSON`}
            >
              {ANALYSIS_WORD[run.analysisStatus]}
            </OutlineChip>
          </Manifest>
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

/**
 * The Journal tab's index when the archive holds nothing finished yet.
 *
 * The plate stays — an empty screen needs a frame or it reads as a failed load
 * — but it is down to its two load-bearing sentences: what is missing, and what
 * puts it there. The paragraph listing what a report contains was describing a
 * screen the reader cannot see yet.
 */
export function NoRunsYet(): JSX.Element {
  return (
    <Section>
      <EmptyPlate>
        <strong>No finished run on file.</strong>
        <span>Play a run with Reliquary open and its report writes itself here.</span>
      </EmptyPlate>
    </Section>
  )
}

/** The identity line and the analysis chip, on one baseline. */
const Manifest = styled.div`
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
`
