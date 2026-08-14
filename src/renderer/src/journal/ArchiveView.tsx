import { useCallback, useMemo, useState, type MouseEvent } from 'react'
import { createLink, useNavigate } from '@tanstack/react-router'
import styled from 'styled-components'
import type { CatalogEntry } from '@shared/types'
import { cohortLabel, runCohort } from '@shared/types'
import { Button, Section, SectionHead, SectionNote, SectionTitle } from '../dashboard/ui'
import { ErrorState, Loading } from '../codex/parts'
import { DASH, relativeTime } from '../codex/format'
import { AmbiguityBanner } from './AmbiguityBanner'
import { cohortCounts } from './cohort'
import { deleteRun, exportRun, useJournalCatalog } from './data'
import {
  ANALYSIS_SHORT,
  ANALYSIS_WORD,
  characterName,
  characterTint,
  isProvisional,
  runDay,
  shortAgo,
  stateWord
} from './format'
import { EmptyPlate, Num, OutlineChip, Plate, TBox, Whisper } from './parts'

/**
 * The Archive: every run on file, newest first — as a ledger.
 *
 * It is built in the same language as the Route Ledger and the Deck Ledger
 * above it, and deliberately not in the language a list of records usually gets
 * built in. No cards, no avatars, no chevrons, no summary tiles: columns do the
 * work, hairlines divide the rows, numerals are tabular, and the section's
 * totals live in the table's own footer where the other two ledgers keep
 * theirs. A reader who has just read a run report should recognise this table
 * as the same hand.
 *
 * Three rules carried over from those ledgers, verbatim:
 *
 *   - **The character is a tinted edge, not coloured text.** The run header
 *     paints a 3px frame-colour edge down its left side; a row does the same
 *     with an inset shadow on its first cell. That keeps identity structural and
 *     leaves the row's one accent for the outcome.
 *   - **One accent per row.** The outcome is the accent — a solid plate for a
 *     verdict (DEFEATED, VICTORIOUS), a quiet outline for a status (SUSPENDED,
 *     ABANDONED?). Nothing else in the row is coloured unless it is a warning
 *     about the row itself.
 *   - **Mono is for ids and timestamps.** The second line of the run cell is a
 *     date and a file handle, so it is mono. "4d ago" is prose, so it is not.
 *
 * Two row states need more than a chip, and both say their piece on that mono
 * line rather than in a second row or a modal: a **provisional** run points at
 * the banner that can answer it, and an **unreadable** one names the schema it
 * was written with. An unreadable row shows no act, no rooms and no outcome —
 * every one of those would be a guess about a file this build cannot parse.
 */

export function ArchiveView(): JSX.Element {
  const catalog = useJournalCatalog()
  const entries = catalog.data
  const counts = useMemo(() => cohortCounts(entries), [entries])

  if (catalog.loading && !entries) return <Loading label="Reading the archive…" />
  if (!entries) {
    return (
      <ErrorState
        title="The archive could not be read"
        message={catalog.error ?? 'No answer from the journal store.'}
        onRetry={catalog.refresh}
      />
    )
  }

  const reviewed = entries.filter((e) => e.analysisStatus === 'done').length
  const cohorts = (['2p', '3p', '4p'] as const)
    .filter((c) => counts[c] > 0)
    .map((c) => `${counts[c]} ${cohortLabel(c)}`)

  return (
    <>
      <AmbiguityBanner />
      <Section>
        <SectionHead>
          <SectionTitle>Archive</SectionTitle>
          <SectionNote>every run on file, newest first</SectionNote>
        </SectionHead>

        {entries.length === 0 ? (
          <EmptyPlate>
            <strong>Nothing recorded yet.</strong>
            <span>
              The archive writes itself the first time you play with Reliquary open — one file
              per run, kept on this machine until you delete it. Runs appear here the moment
              they start, finished or not.
            </span>
          </EmptyPlate>
        ) : (
          <Ledger>
            <HeadRow aria-hidden>
              <Cell>Run</Cell>
              <Cell>Outcome</Cell>
              <Cell $right>Act</Cell>
              <Cell $right>Rooms</Cell>
              <Cell $right>Deck</Cell>
              <Cell $right>Seen</Cell>
              <Cell />
            </HeadRow>
            {entries.map((entry) => (
              <ArchiveRow key={entry.id} entry={entry} />
            ))}
            <FootRow>
              {entries.length} run{entries.length === 1 ? '' : 's'} · {counts.solo} solo
              {cohorts.length ? ` · ${cohorts.join(' · ')}` : ''} · {reviewed} reviewed
            </FootRow>
          </Ledger>
        )}

        {catalog.error ? (
          <Whisper style={{ margin: '10px 2px 0', color: 'var(--sts-color-red)' }}>
            the list may be out of date — {catalog.error}
          </Whisper>
        ) : null}
      </Section>
    </>
  )
}

function ArchiveRow({ entry }: { entry: CatalogEntry }): JSX.Element {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null)

  const tint = characterTint(entry.character)
  const word = stateWord(entry)
  const cohort = runCohort(entry.playerCount)
  const provisional = isProvisional(entry)

  const open = useCallback(() => {
    if (entry.unreadable) return
    navigate({ to: '/journal/run/$id', params: { id: entry.id } })
  }, [entry.id, entry.unreadable, navigate])

  const onExport = useCallback(() => {
    setBusy(true)
    setMessage(null)
    void exportRun(entry.id)
      .then((result) =>
        setMessage(
          'error' in result
            ? { text: result.error, bad: true }
            : { text: `saved to ${result.data.path}`, bad: false }
        )
      )
      .finally(() => setBusy(false))
  }, [entry.id])

  const onDelete = useCallback(() => {
    setBusy(true)
    void deleteRun(entry.id)
      .then((result) => {
        if ('error' in result) setMessage({ text: result.error, bad: true })
      })
      .finally(() => {
        setBusy(false)
        setConfirming(false)
      })
  }, [entry.id])

  // The mono line under the name carries whatever this row most needs to say:
  // the result of an action it just performed, why it cannot be opened, or the
  // date and handle of the file it is.
  const handle = `${runDay(entry.startedAt ?? entry.firstSeenAt)} · ${shortId(entry.id)}`
  const line = message
    ? message.text
    : entry.unreadable
      ? `schema ${entry.schema} · update Reliquary to read it`
      : provisional
        ? `${handle} · provisional — answer the banner above`
        : entry.supersededBy
          ? `${handle} · superseded by a later run`
          : word.note
            ? `${handle} · ${word.note}`
            : handle

  return (
    <Row
      $edge={tint.edge}
      $dim={entry.unreadable}
      $clickable={!entry.unreadable}
      onClick={open}
    >
      <Cell>
        {entry.unreadable ? (
          <RunName as="span">{characterName(entry.character)}</RunName>
        ) : (
          <RunLink
            to="/journal/run/$id"
            params={{ id: entry.id }}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
          >
            {characterName(entry.character)}
          </RunLink>
        )}
        <Handle $bad={message?.bad ?? false} title={line}>
          {line}
        </Handle>
      </Cell>
      <Cell>
        {/* Outcome and mode share a cell: a run's verdict and how many people
            played it are one fact about the run, and a column of "Solo" five
            times over is a column that earns nothing. */}
        <Chips>
          {entry.unreadable ? (
            <OutlineChip $tone="var(--sts-color-orange)">unreadable</OutlineChip>
          ) : word.solid && word.tone ? (
            <Plate $bg={word.tone} title={word.title}>
              {word.label}
            </Plate>
          ) : (
            <OutlineChip $tone={word.tone} title={word.title}>
              {word.label}
            </OutlineChip>
          )}
          {cohort === 'solo' || entry.unreadable ? null : (
            <OutlineChip $tone="var(--brand-soft)" title={`${entry.playerCount} players`}>
              {cohortLabel(cohort)}
            </OutlineChip>
          )}
          {/* The review state joins the chips instead of holding a column of
              its own: four rows in five say the same word, and a column that
              repeats itself is a column that is not being read. */}
          {entry.unreadable || entry.analysisStatus === 'done' ? null : (
            <OutlineChip
              $tone={entry.analysisStatus === 'failed' ? 'var(--sts-color-red)' : null}
              title={ANALYSIS_WORD[entry.analysisStatus]}
            >
              {ANALYSIS_SHORT[entry.analysisStatus]}
            </OutlineChip>
          )}
        </Chips>
      </Cell>
      <Cell $right $dim>
        {entry.unreadable || entry.actReached === null ? DASH : <Num>{entry.actReached + 1}</Num>}
      </Cell>
      <Cell $right>
        {entry.unreadable ? (
          DASH
        ) : (
          <Num>
            {entry.countsArePartial ? '≈' : ''}
            {entry.roomsEntered}
          </Num>
        )}
      </Cell>
      <Cell $right $dim>{entry.unreadable ? DASH : <Num>{entry.deckSize}</Num>}</Cell>
      <Cell $right $dim title={`last seen ${relativeTime(entry.lastSeenAt)}`}>
        {shortAgo(entry.lastSeenAt)}
      </Cell>
      <Cell>
        <Actions onClick={(e) => e.stopPropagation()}>
          {/* Confirmation happens in the row, not in a modal: a dialog for a
              single-row destructive action moves the reader's eye away from the
              thing they are about to destroy. */}
          {confirming ? (
            <>
              <QuietAction type="button" disabled={busy} onClick={() => setConfirming(false)}>
                Keep
              </QuietAction>
              <RowButton type="button" disabled={busy} onClick={onDelete}>
                Yes, delete
              </RowButton>
            </>
          ) : (
            <>
              {entry.unreadable ? null : (
                <QuietAction type="button" disabled={busy} onClick={onExport}>
                  Export
                </QuietAction>
              )}
              <QuietAction type="button" $danger disabled={busy} onClick={() => setConfirming(true)}>
                Delete
              </QuietAction>
            </>
          )}
        </Actions>
      </Cell>
    </Row>
  )
}

/** Run ids end in a short content hash; that tail is the human-sized handle. */
function shortId(id: string): string {
  const tail = id.split('-').pop() ?? id
  return tail.slice(0, 6)
}

// ── surfaces ────────────────────────────────────────────────────────────────

/**
 * The ledger, as a grid rather than a `<table>`.
 *
 * It looks exactly like the Route and Deck Ledgers — same box, same hairlines,
 * same header and footer bands — but a table's intrinsic sizing is decided by
 * its content's minimum widths, and in a nine-column row whose cells hold
 * chips, buttons and mono text those minimums are both large and dependent on
 * the font engine: the same markup laid out at 946px in one Chromium and
 * 1035px in another, which pushes the row's actions off the right edge in the
 * app while looking perfect in a browser. A grid's columns are declared, not
 * negotiated. Nothing about the design changed; only who decides the widths.
 */
const Ledger = styled(TBox)``

const COLUMNS = `
  grid-template-columns:
    minmax(0, 1.9fr)
    minmax(0, 1.6fr)
    46px
    72px
    56px
    58px
    minmax(120px, 0.9fr);
`

const rowGrid = `
  display: grid;
  ${COLUMNS}
  align-items: center;
  gap: 0 10px;
  padding: 0 12px;
`

const HeadRow = styled.div`
  ${rowGrid}
  min-height: 36px;
  background: #211e1c;
  border-bottom: 1px solid var(--line-strong);
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 10.5px;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  color: var(--ink-faint);
`

const FootRow = styled.div`
  padding: 9px 14px;
  border-top: 1px solid var(--line-strong);
  background: #1d1a18;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-dim);
`

/**
 * The character's frame colour as a 3px edge — the same mark the run header
 * wears down its left side, and the same construction the Deck Ledger uses to
 * flag a dead row.
 */
const Row = styled.div<{ $edge: string; $dim: boolean; $clickable: boolean }>`
  ${rowGrid}
  position: relative;
  min-height: 52px;
  border-top: 1px solid var(--line);
  cursor: ${(p) => (p.$clickable ? 'pointer' : 'default')};
  opacity: ${(p) => (p.$dim ? 0.62 : 1)};

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: ${(p) => p.$edge};
  }
  &:hover {
    background: ${(p) => (p.$clickable ? 'var(--fill-hover)' : 'transparent')};
  }
`

/** One column of a row. Ellipsis rather than overflow, always. */
const Cell = styled.div<{ $right?: boolean; $dim?: boolean }>`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  text-align: ${(p) => (p.$right ? 'right' : 'left')};
  color: ${(p) => (p.$dim ? 'var(--ink-dim)' : 'inherit')};
`

const RunNameStyles = `
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.6px;
  color: var(--ink);
  text-decoration: none;
`

const RunName = styled.span`
  ${RunNameStyles}
`

const RunAnchor = styled.a`
  ${RunNameStyles}
  cursor: pointer;
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

const RunLink = createLink(RunAnchor)

/** The row's one mono line: a date and a file handle, or what just happened to it. */
const Handle = styled.div<{ $bad: boolean }>`
  /* Capped so a long note cannot set the column's width; the full text is in
     the cell's tooltip. */
  max-width: 150px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.4;
  color: ${(p) => (p.$bad ? 'var(--sts-color-red)' : 'var(--ink-faint)')};
  overflow: hidden;
  text-overflow: ellipsis;
`

/* Wrapping, not clipping: the outcome cell can carry a verdict plus a mode
   badge plus an analysis chip, and at narrow widths a nowrap flex line was
   shearing chips mid-glyph ("NOT REVIE…"). Rows are min-height, so a second
   chip line grows the row instead of losing information. */
const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  padding: 6px 0;
`

const Actions = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
`

/** The shared Button, sized for a table row rather than a settings page. */
const RowButton = styled(Button)`
  height: 28px;
  padding: 0 9px;
  font-size: 11.5px;
  font-weight: 600;
`

/**
 * A row action: a word, not a button.
 *
 * Two bordered buttons per row would turn a five-row ledger into ten boxes and
 * make the destructive one the loudest thing on the page. These read as part of
 * the row until they are hovered; the real button appears only for the
 * confirmation, which is the one moment that should be hard to miss.
 */
const QuietAction = styled.button<{ $danger?: boolean }>`
  height: 28px;
  padding: 0 4px;
  cursor: pointer;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink-dim);
  border-bottom: 1px solid transparent;
  &:hover:not(:disabled) {
    color: ${(p) => (p.$danger ? 'var(--sts-color-red)' : 'var(--ink)')};
    border-bottom-color: currentColor;
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: 3px;
  }
  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
`
