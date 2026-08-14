import { useCallback, useMemo, useState } from 'react'
import type { RunFile } from '@shared/types'
import { runCohort } from '@shared/types'
import { Section, SectionHead, SectionTitle } from '../dashboard/ui'
import { ErrorState, Loading } from '../codex/parts'
import { DASH } from '../codex/format'
import { flagsByRoom, readAnalysis } from './analysis'
import { cohortPace, type CohortAverage } from './cohort'
import { useJournalCatalog, reanalyzeRun, useRunFile } from './data'
import { deriveDeck, deriveRoute, isPartial } from './derive'
import { DeckLedger } from './DeckLedger'
import { Findings } from './Findings'
import { CensusStrip, RouteLedger } from './RouteLedger'
import { NotReadableChip, RelicsStrip } from './RelicsStrip'
import {
  HONESTY_LINE,
  characterName,
  characterTint,
  fmtDuration,
  fmtPace,
  outcomeBanner
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
  RunTitle
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
 * It carries no *manifest* either any more. The mono identity line (stamp,
 * handle, game build) and the analysis-state chip beside it were the file's
 * metadata printed at the top of the file's own report — the picker above
 * already names the run, and analysis state is legible where it matters: the
 * review section's own pending / never-reviewed / failed states, and the
 * Archive's chips. What is left in the header is the run: its name, its result,
 * and six numbers.
 *
 * **Section heads carry their title and nothing else.** Every head here used to
 * trail a note — "rooms in order entered", "25 cards · 20 rows", "4 findings" —
 * and each one either restated the section below it or duplicated a number that
 * section prints in full. `SectionHead` still exists for the odd chip that is
 * genuinely a status (the relic strip's "not readable"), not for description.
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

  return (
    <>
      {/* The partial-run whisper that used to sit under this header is gone:
          "counts are under-counts" is what the `≈` in front of the room count
          already says, in one character, in the cell the count lives in. The
          long form is on that cell's tooltip. */}
      <Section>
        <RunHeader
          run={run}
          banner={banner}
          lastRoom={last?.roomIndex ?? run.roomsEntered}
          cohort={cohort}
        />
      </Section>

      <Section>
        <SectionHead>
          <SectionTitle>Route Ledger</SectionTitle>
        </SectionHead>
        <CensusStrip census={route.census} />
        <RouteLedger route={route} outcomeWord={banner.word} flags={flags} />
      </Section>

      {/* No final deck means the run has not ended: the deck-so-far is on the
          Current Run view, alive, and an empty ledger explaining that here
          would be a section-sized signpost. */}
      {deck.empty ? null : (
        <Section>
          <SectionHead>
            <SectionTitle>Deck Ledger</SectionTitle>
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
        </SectionHead>
        <Findings
          status={run.analysisStatus}
          analysis={analysis.value}
          malformed={analysis.malformed}
          deck={deck}
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
 * had to leave out (HP, gold, ascension) are *absent* rather than dashed. A
 * grid of `·` reads as a broken screen; an absence reads as a report that only
 * prints what it saw. The line that used to name those absences is the plaque's
 * own tooltip: the reader who wonders where gold went can hover the row of
 * numbers, and the reader who never wondered is not charged a line for it.
 *
 * Three facts that used to be printed sentences now ride the cells they are
 * about, because a tooltip on the number is where a reader looks for the
 * number's caveat:
 *
 *   - the `≈` on Rooms carries "we joined late, so this is a floor";
 *   - Pace carries the cohort average it used to state in a footnote chip;
 *   - the plaque as a whole carries what v1 cannot read at all.
 *
 * Nothing was deleted from the *file* — the manifest's schema and request
 * budget, and every footnote sentence, go out whole in the exported JSON.
 */
function RunHeader({
  run,
  banner,
  lastRoom,
  cohort
}: {
  run: RunFile
  banner: { word: string; tone: 'red' | 'green' | 'gold' | 'aqua' }
  lastRoom: number
  /** This run's cohort baseline, for the Pace cell's tooltip. */
  cohort: CohortAverage
}): JSX.Element {
  const tint = characterTint(run.character)
  const act = run.actReached
  const deckSize = run.finalDeck
    ? run.finalDeck.reduce((n, row) => n + row.count, 0)
    : run.snapshot.deckSize
  const rows = run.finalDeck
    ? new Set(run.finalDeck.map((row) => row.id)).size
    : null
  // A thin cohort gets no tooltip at all rather than a sentence explaining that
  // it is thin: the comparison is simply absent, and absences do not need prose.
  const paceTitle = cohort.thin
    ? undefined
    : `${cohort.label.toLowerCase()} archive average ${fmtPace(cohort.perRoomAvgMs)} across ${cohort.runs} runs`
  const roomsTitle = isPartial(run)
    ? run.observedFrom === 'mid-run'
      ? 'we joined this run in progress · every count here is a floor, not a total'
      : 'part of this run was played without us · counts are floors, not totals'
    : undefined

  return (
    <RunHead $frame={tint.frame} $edge={tint.edge}>
      <RunHeadTop>
        <RunTitle>
          <h1>
            <em style={{ color: tint.edge }}>{characterName(run.character)}</em> · RUN REPORT
          </h1>
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

      <Plaque $frame={tint.frame} title={HONESTY_LINE}>
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
        <PCell title={roomsTitle}>
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
        <PCell title={paceTitle}>
          <div className="k">Pace</div>
          <div className="v">{fmtPace(run.pace.perRoomAvgMs)}</div>
          <div className="w">per room</div>
        </PCell>
        <PCell title="Observed play time, not wall clock">
          <div className="k">Elapsed</div>
          <div className="v">{fmtDuration(run.pace.elapsedMs)}</div>
          <div className="w">observed time</div>
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
