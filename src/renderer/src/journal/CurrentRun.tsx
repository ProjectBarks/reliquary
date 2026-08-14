import { useMemo } from 'react'
import { createLink } from '@tanstack/react-router'
import styled from 'styled-components'
import type { JournalCurrentRun } from '@shared/types'
import { cohortLabel } from '@shared/types'
import { Section, SectionHead, SectionNote, SectionTitle } from '../dashboard/ui'
import { DASH } from '../codex/format'
import { AmbiguityBanner } from './AmbiguityBanner'
import { useCurrentRun, useJournalCatalog, useLiveEnemies, useLivePiles } from './data'
import type { RouteRoom } from './derive'
import { RouteLedger } from './RouteLedger'
import {
  characterName,
  characterTint,
  fmtDuration,
  fmtPace,
  paceFrom,
  roomKind,
  runStamp
} from './format'
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
 * It is the mockup's LIVE band, opened out into a whole view, and it is fed
 * entirely by pushes: `journal.currentRun` for the run's own state and
 * `sts2.pileState` / `sts2.enemiesState` for what the combat looks like — the
 * same keyed snapshots the overlay has always lived on. Nothing here polls,
 * and nothing here asks main a question.
 *
 * The idle state is the one that had to be designed rather than defaulted.
 * "No run in progress" is the *normal* condition of this screen — most of the
 * time the game is not running at all — so it says what it is waiting for and
 * points at the last finished run instead of showing an empty plaque with
 * dashes where the numbers go. Three lines, one of them a link.
 *
 * Neither state prints a section title. The sub-nav is already showing Current
 * Run in brand, and a heading under it saying "Current Run — nothing is being
 * recorded" spent a whole line restating the tab the reader just clicked. The
 * plaque (or the idle plate) is the first thing on the page now, and the live
 * view's honest caveats — joined mid-run, counts are partial — ride the
 * manifest whisper where the run's other identity facts already are.
 */

export function CurrentRun(): JSX.Element {
  const run = useCurrentRun()
  const catalog = useJournalCatalog()

  const latest = useMemo(() => {
    const rows = (catalog.data ?? []).filter((e) => e.state === 'closed' && !e.unreadable)
    return rows.length ? rows.reduce((a, b) => (a.lastSeenAt >= b.lastSeenAt ? a : b)) : null
  }, [catalog.data])

  return (
    <>
      <AmbiguityBanner />
      {run ? <Live run={run} /> : <Idle latestId={latest?.id ?? null} />}
    </>
  )
}

function Idle({ latestId }: { latestId: string | null }): JSX.Element {
  return (
    <Section>
      <EmptyPlate>
        <strong>No run in progress.</strong>
        <span>Start a run with Slay the Spire 2 open and this fills in as you play.</span>
        {latestId ? (
          <LastRunLink to="/journal/run/$id" params={{ id: latestId }}>
            Read the last finished run →
          </LastRunLink>
        ) : null}
      </EmptyPlate>
    </Section>
  )
}

function Live({ run }: { run: JournalCurrentRun }): JSX.Element {
  const piles = useLivePiles()
  const enemies = useLiveEnemies()
  const tint = characterTint(run.character)
  const stamp = runStamp({ id: run.runId, firstSeenAt: run.lastSeenAt, startedAt: run.startedAt })
  const pace = paceFrom(run.paceActiveMs, run.roomIndex)

  const inCombat = run.inCombat || (enemies?.isCombatInProgress ?? false)
  const enemyCount = enemies?.enemies.length ?? null
  const yourTurn = enemies?.currentSide === 1

  // The live route panel reuses the report's row component — same grammar, same
  // chips — with the fields the snapshot carries and the ones it does not
  // (pickups, deck deltas) simply absent rather than faked.
  const lines = useMemo<RouteRoom[]>(
    () =>
      run.recentRoute.map((row) => ({
        kind: 'room' as const,
        key: `live-${row.roomIndex}-${row.t}`,
        roomIndex: row.roomIndex,
        floor: row.floor,
        act: row.act,
        room: roomKind(row.roomType),
        notes: [],
        pickup: null,
        passed: [],
        end: false,
        flag: null
      })),
    [run.recentRoute]
  )
  const firstShown = lines.length ? lines[0].roomIndex : 0

  return (
    <>
      <Section>
        <RunHead $frame={tint.frame} $edge={tint.edge}>
          <RunHeadTop>
            <RunTitle>
              <h1>
                <em style={{ color: tint.edge }}>{characterName(run.character)}</em> — CURRENT RUN
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
                  ? `${cohortLabel(run.cohort)} · ${run.playerCount} players`
                  : 'solo'}
              </div>
            </PCell>
            <PCell>
              <div className="k">Act</div>
              <div className="v">
                <Num>{run.act === null ? DASH : run.act + 1}</Num> <small>of 3</small>
              </div>
              <div className="w">as read</div>
            </PCell>
            <PCell>
              <div className="k">Deck</div>
              <div className="v">
                <Num>{run.deckSize}</Num>
              </div>
              <div className="w">owned now</div>
            </PCell>
            <PCell>
              <div className="k">Rooms</div>
              <div className="v">
                <Num>{run.roomIndex}</Num>
              </div>
              <div className="w">
                {run.floor === null ? 'entered' : `entered · floor ${run.floor}`}
              </div>
            </PCell>
            <PCell>
              <div className="k">Pace</div>
              <div className="v" style={{ fontSize: 18 }}>
                {fmtPace(pace)}
              </div>
              <div className="w">per room</div>
            </PCell>
            <PCell>
              <div className="k">Elapsed</div>
              <div className="v" style={{ fontSize: 18 }}>
                {fmtDuration(run.elapsedActiveMs)}
              </div>
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
              <SectionNote>observable live</SectionNote>
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
              title="The same readers the overlay runs on, updating every ~250 ms — the exhaust pile is not in the emitted pile state yet"
            >
              exhaust not readable{piles ? '' : ' · no combat on screen'}
            </Whisper>
          </div>

          <div>
            <SectionHead>
              <SectionTitle as="h3">Route so far</SectionTitle>
              <SectionNote>last {lines.length || 0} rooms</SectionNote>
            </SectionHead>
            {lines.length ? (
              <RouteLedger
                route={{
                  lines,
                  totals: { rooms: run.roomIndex, taken: 0, skipped: 0, upgrades: 0, removals: 0 },
                  empty: false
                }}
                outcomeWord="ENDED"
                compact
                collapsedBefore={firstShown > 1 ? firstShown - 1 : null}
              />
            ) : (
              <Note>No rooms entered yet this run.</Note>
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

/** A quiet way back to the last run that *did* finish. */
const LastRunAnchor = styled.a`
  align-self: flex-start;
  margin-top: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--brand-soft);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  &:hover {
    border-bottom-color: currentColor;
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: 3px;
  }
`

const LastRunLink = createLink(LastRunAnchor)

