import { useMemo } from 'react'
import styled from 'styled-components'
import type { JournalCurrentRun, RunFile } from '@shared/types'
import { cohortLabel, runCohort } from '@shared/types'
import { Section, SectionHead, SectionTitle } from '../dashboard/ui'
import { DASH } from '../codex/format'
import { ErrorState, Loading } from '../codex/parts'
import { AmbiguityBanner } from './AmbiguityBanner'
import {
  useCurrentRun,
  useLiveEnemies,
  useLivePiles,
  useRunFile,
  type RunResource
} from './data'
import { deriveRoute, isPartial, recentRoute } from './derive'
import { RouteLedger } from './RouteLedger'
import { characterName, characterTint, fmtDuration, fmtPace, paceFrom, runStamp } from './format'
import {
  Banner,
  CellGrid,
  CellKey,
  CellValue,
  CharValue,
  Duo,
  EmptyPlate,
  LiveChip,
  Note,
  Num,
  PCell,
  Plaque,
  RunHead,
  RunHeadTop,
  RunTitle,
  Whisper
} from './parts'

/**
 * The run happening right now.
 *
 * It is the mockup's LIVE band, opened out into a whole view, and it reads from
 * exactly two places:
 *
 *   - **The run file**, by the id on `journal.currentRun`, folded by the same
 *     `deriveRoute` the Run Report uses. Every room, pickup, skip, upgrade and
 *     removal on this screen is that one derivation over that one file.
 *   - **The live keys** — `journal.currentRun` for liveness, `sts2.pileState`
 *     and `sts2.enemiesState` for what the combat looks like — the same keyed
 *     snapshots the overlay has always lived on.
 *
 * That split is the whole design of this file, and it is a repair. The snapshot
 * used to carry its own `recentRoute` of bare room rows, and this view mapped
 * them into ledger rows with `pickup: null` and `notes: []` written in by hand,
 * because the wire shape had nowhere to put a card. So a live run showed a
 * route with an empty Pickup column while the report of that same run — folded
 * from the same events, one click away — listed every card taken. Two
 * derivations, one of them a stub. There is one now, and it is `derive.ts`.
 *
 * The file is authoritative and it does not go stale: main flushes it on every
 * room, offer and deck change and publishes a catalog row on those same
 * boundaries, which is what makes `data.ts` refetch the copy this view holds.
 *
 * Nothing here polls, and the only question it asks main is "give me that run".
 *
 * The idle state is the one that had to be designed rather than defaulted.
 * "No run in progress" is the *normal* condition of this screen — most of the
 * time the game is not running at all — so it says what it is waiting for
 * instead of showing an empty plaque with dashes where the numbers go. Two
 * lines, and nothing else.
 *
 * Neither state prints a section title. The sub-nav is already showing Current
 * Run in brand, and a heading under it saying "Current Run, nothing is being
 * recorded" spent a whole line restating the tab the reader just clicked. The
 * plaque (or the idle plate) is the first thing on the page now, and the live
 * view's honest caveats (joined mid-run, counts are partial) ride the manifest
 * whisper where the run's other identity facts already are.
 *
 * The two inner heads below it carry their titles and nothing else. "observable
 * live" under Combat piles and "last 12 rooms" under Route so far were both
 * captions for a thing the reader was already looking at: the piles update in
 * front of them, and the ledger's own rows are numbered.
 */

export function CurrentRun(): JSX.Element {
  const live = useCurrentRun()
  // Hooks are unconditional: `useRunFile(null)` is the "nothing asked for"
  // resource, so the idle state costs no request and no rule-of-hooks dance.
  const file = useRunFile(live?.runId ?? null)

  return (
    <>
      <AmbiguityBanner />
      {live ? <Live live={live} file={file} /> : <Idle />}
    </>
  )
}

function Idle(): JSX.Element {
  return (
    <Section>
      <EmptyPlate>
        <strong>No run in progress.</strong>
        <span>Start a run with Slay the Spire 2 open and this fills in as you play.</span>
      </EmptyPlate>
    </Section>
  )
}

/**
 * The live run, waiting on its own file.
 *
 * The snapshot names the run; the file *is* the run. Until it lands there is
 * genuinely nothing truthful to print — the alternative is a plaque of dashes
 * that resolves into numbers a frame later — so this is the report's own
 * "opening the run file…" for one round trip, and the store keeps the last good
 * copy on every refresh after that, so it is shown exactly once per run.
 */
function Live({ live, file }: { live: JournalCurrentRun; file: RunResource }): JSX.Element {
  if (!file.data) {
    if (file.error) {
      return (
        <ErrorState
          title="The live run's file could not be read"
          message={file.error}
          onRetry={file.refresh}
        />
      )
    }
    return <Loading label="Opening the run file…" />
  }
  return <LiveRun live={live} run={file.data} />
}

function LiveRun({ live, run }: { live: JournalCurrentRun; run: RunFile }): JSX.Element {
  const piles = useLivePiles()
  const enemies = useLiveEnemies()
  const tint = characterTint(run.character)
  const stamp = runStamp(run)
  const pace = paceFrom(live.elapsedActiveMs, run.roomsEntered)

  const inCombat = live.inCombat || (enemies?.isCombatInProgress ?? false)
  const enemyCount = enemies?.enemies.length ?? null
  const yourTurn = enemies?.currentSide === 1

  // The one derivation, over the one source of truth — the same call the Run
  // Report makes. `recentRoute` only slices the tail off it; it does not build
  // a row, which is precisely why the pickup column can no longer be empty here
  // and full there.
  const route = useMemo(() => deriveRoute(run), [run])
  const recent = useMemo(() => recentRoute(route), [route])

  return (
    <>
      <Section>
        <RunHead $frame={tint.frame} $edge={tint.edge}>
          <RunHeadTop>
            <RunTitle>
              <h1>
                <em style={{ color: tint.edge }}>{characterName(run.character)}</em> · CURRENT RUN
              </h1>
              {/* Identity, plus the two words that change how every number
                  below should be read. The reasoning is on the tooltip: a live
                  view is watched, not studied. */}
              <Whisper
                title={
                  'The review runs when this run ends' +
                  (run.observedFrom === 'mid-run'
                    ? ' · we joined this run in progress, so every count is a floor rather than a total'
                    : '') +
                  (run.countsArePartial ? ' · part of this run was played without us' : '')
                }
              >
                run {stamp.stamp} · {stamp.tail}
                {run.observedFrom === 'mid-run' ? ' · joined mid-run' : ''}
                {run.countsArePartial ? ' · counts partial' : ''}
              </Whisper>
            </RunTitle>
            <Banner $tone="aqua">
              <LiveChip>live</LiveChip>
              <span className="word">{inCombat ? 'IN COMBAT' : 'EXPLORING'}</span>
              <span className="sub">
                {inCombat && enemyCount !== null ? `${enemyCount} enemies · ` : ''}
                {inCombat ? <b>{yourTurn ? 'your turn' : 'enemy turn'}</b> : <b>between rooms</b>}
              </span>
            </Banner>
          </RunHeadTop>

          <Plaque $frame={tint.frame}>
            <PCell>
              <div className="k">Character</div>
              <CharValue $edge={tint.edge}>{characterName(run.character)}</CharValue>
              <div className="w">
                {run.playerCount && run.playerCount > 1
                  ? `${cohortLabel(runCohort(run.playerCount))} · ${run.playerCount} players`
                  : 'solo'}
              </div>
            </PCell>
            <PCell>
              <div className="k">Act</div>
              <div className="v">
                <Num>{run.actReached === null ? DASH : run.actReached + 1}</Num> <small>of 3</small>
              </div>
              <div className="w">as read</div>
            </PCell>
            <PCell>
              <div className="k">Deck</div>
              <div className="v">
                <Num>{run.snapshot.deckSize}</Num>
              </div>
              <div className="w">owned now</div>
            </PCell>
            {/* The `≈` is the whole caveat; its long form is on the cell, not
                under the plaque as a sentence. */}
            <PCell
              title={
                isPartial(run)
                  ? 'part of this run was not observed · this count is a floor, not a total'
                  : undefined
              }
            >
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
              <div className="v">{fmtPace(pace)}</div>
              <div className="w">per room</div>
            </PCell>
            <PCell>
              <div className="k">Elapsed</div>
              <div className="v">{fmtDuration(live.elapsedActiveMs)}</div>
              <div className="w">observed this run</div>
            </PCell>
          </Plaque>
        </RunHead>
      </Section>

      <Section>
        <Duo>
          <div>
            <SectionHead>
              <SectionTitle as="h3">Combat piles</SectionTitle>
            </SectionHead>
            <CellGrid $min="90px">
              <Pile label="hand" n={piles?.hand.length ?? null} />
              <Pile label="draw" n={piles?.draw.length ?? null} />
              <Pile label="discard" n={piles?.discard.length ?? null} />
            </CellGrid>
            {/* The mockup showed a fourth cell for the exhaust pile. It is not
                in `Sts2PileState` (audit A12.1), and inventing a zero for it
                would be the one lie this whole tab is built to avoid — so the
                omission is named in four words here and explained on hover. */}
            <Whisper
              style={{ margin: '10px 2px 0' }}
              title="The same readers the overlay runs on, updating every ~250 ms · the exhaust pile is not in the emitted pile state yet"
            >
              exhaust not readable{piles ? '' : ' · no combat on screen'}
            </Whisper>
          </div>

          <div>
            <SectionHead>
              <SectionTitle as="h3">Route so far</SectionTitle>
            </SectionHead>
            {recent.empty ? (
              <Note>No rooms entered yet this run.</Note>
            ) : (
              <RouteLedger
                route={recent}
                outcomeWord="ENDED"
                compact
                collapsedBefore={recent.collapsedBefore}
              />
            )}
          </div>
        </Duo>
      </Section>
    </>
  )
}

function Pile({ label, n }: { label: string; n: number | null }): JSX.Element {
  return (
    <PileCell>
      <CellKey>{label}</CellKey>
      <CellValue>
        <Num>{n === null ? DASH : n}</Num>
      </CellValue>
    </PileCell>
  )
}

const PileCell = styled.div`
  background: #1e1b18;
  padding: 12px 14px 13px;

  ${CellKey} {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.6px;
  }
  ${CellValue} {
    font-size: 24px;
  }
`


