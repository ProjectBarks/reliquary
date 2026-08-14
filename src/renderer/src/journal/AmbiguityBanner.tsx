import { useCallback, useState } from 'react'
import styled from 'styled-components'
import type { AmbiguityResolution, CatalogEntry } from '@shared/types'
import { Button } from '../dashboard/ui'
import { CloseButton } from '../codex/parts'
import { relativeTime } from '../codex/format'
import { resolveAmbiguity, useJournalCatalog } from './data'
import { characterName, runDay } from './format'
import { Whisper } from './parts'

/**
 * "Fresh run, or resuming that one?"
 *
 * When two candidate runs are genuinely indistinguishable — same character,
 * both inside the pre-first-pick window, identical act and deck — the recorder
 * does not guess. It opens a *new provisional* file so no data can be lost, and
 * asks. This is the asking.
 *
 * Four properties are requirements rather than choices, and all four come from
 * the user's decision on the matter:
 *
 *   - **Non-blocking.** It is a band at the top of a view, never a dialog, and
 *     never anything that could appear over the game.
 *   - **Dismissible.** Someone mid-run should be able to make it go away with
 *     one click and get on with the run.
 *   - **It comes back.** Dismissal is per visit, not permanent: the question is
 *     still open, and the honest default (leave the provisional standing as its
 *     own run) is what happens if it is never answered — so the banner has to
 *     keep being available to answer.
 *   - **Both answers are safe.** "Fresh run" clears the flag; "Resuming" merges
 *     the provisional into its candidate. Neither deletes anything the user
 *     recorded — a merge moves every event, session and combat across.
 */

export function AmbiguityBanner(): JSX.Element | null {
  const catalog = useJournalCatalog()
  const [dismissed, setDismissed] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const entries = catalog.data ?? []
  const pending = entries.filter(
    (e) => e.ambiguity !== null && e.ambiguity.resolution === null && !dismissed.includes(e.id)
  )

  const answer = useCallback((id: string, resolution: AmbiguityResolution) => {
    setBusy(id)
    setFailed(null)
    void resolveAmbiguity(id, resolution)
      .then((result) => {
        if ('error' in result) setFailed(result.error)
      })
      .finally(() => setBusy(null))
  }, [])

  if (pending.length === 0) return null

  return (
    <>
      {pending.map((entry) => (
        <Band key={entry.id} role="status">
          <Body>
            <Title>Is this a fresh run, or the same one resumed?</Title>
            <Whisper>
              {describe(entry)} started while {describeCandidate(entries, entry)} was still
              resumable, and the two were identical at the time. Nothing is lost either way — this
              run is recorded in full.
            </Whisper>
            {failed ? <Failure>{failed}</Failure> : null}
          </Body>
          <Actions>
            <Button
              type="button"
              disabled={busy === entry.id}
              onClick={() => answer(entry.id, 'fresh')}
            >
              Fresh run
            </Button>
            <Button
              type="button"
              $primary
              disabled={busy === entry.id}
              onClick={() => answer(entry.id, 'resumed')}
            >
              Resuming {shortCandidate(entries, entry)}
            </Button>
            {/* The app's own close affordance, imported rather than restyled:
                this is the same ✕ the Codex's panes and dialogs use, and a
                dismiss button that looked like nothing else in the app would be
                the one control here nobody recognises. */}
            <CloseButton
              type="button"
              aria-label="Dismiss for now"
              title="Dismiss for now — it will ask again"
              onClick={() => setDismissed((d) => [...d, entry.id])}
            >
              ✕
            </CloseButton>
          </Actions>
        </Band>
      ))}
    </>
  )
}

function describe(entry: CatalogEntry): string {
  return `${characterName(entry.character)} · ${runDay(entry.startedAt ?? entry.firstSeenAt)}`
}

function candidateOf(entries: readonly CatalogEntry[], entry: CatalogEntry): CatalogEntry | null {
  const id = entry.ambiguity?.candidateId
  if (!id) return null
  return entries.find((e) => e.id === id) ?? null
}

function describeCandidate(entries: readonly CatalogEntry[], entry: CatalogEntry): string {
  const candidate = candidateOf(entries, entry)
  if (!candidate) return 'an earlier run'
  return `${describe(candidate)} (${candidate.roomsEntered} rooms, ${relativeTime(candidate.lastSeenAt)})`
}

function shortCandidate(entries: readonly CatalogEntry[], entry: CatalogEntry): string {
  const candidate = candidateOf(entries, entry)
  if (!candidate) return 'the earlier run'
  return `${characterName(candidate.character)} · ${candidate.roomsEntered} rooms`
}

const Band = styled.div`
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  margin: 0 0 16px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in oklab, var(--sts-color-orange) 38%, transparent);
  background: oklch(0.75 0.16 62 / 8%);
`

const Body = styled.div`
  flex: 1 1 320px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const Title = styled.div`
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.4px;
  color: var(--ink);
`

const Failure = styled.div`
  font-size: 12px;
  color: var(--sts-color-red);
  word-break: break-word;
`

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
`

