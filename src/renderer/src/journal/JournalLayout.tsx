import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, createLink, useNavigate, useRouterState } from '@tanstack/react-router'
import styled from 'styled-components'
import type { CatalogEntry } from '@shared/types'
import { Button, Select } from '../dashboard/ui'
import { NavAnchor, scrollbar } from '../codex/parts'
import { reportEvent } from '../telemetry'
import { exportRun, useJournalCatalog, useLatestFinishedRun } from './data'
import { characterName, runDay } from './format'
import { Whisper } from './parts'

/**
 * The Journal's frame: three sub-nav words on the left, the run picker and
 * Export JSON on the right, the view in the middle.
 *
 * It is built to the same measurements as `CodexLayout` — same 1180px measure,
 * same 44px head, same Kreon-word sub-nav with a 2px brand rule under the
 * active one — because the two tabs are siblings and a reader should not have
 * to re-learn where things are when they move between them. The blend mockup
 * drew this bar at 1240px wide; matching the app it lives in beat matching the
 * mockup's canvas by 60px.
 *
 * The picker and the export button act on *the run you are reading*, which is
 * the run in the URL on `/journal/run/$id`, and the newest finished run on
 * `/journal`. On Archive and Current Run there is nothing being read, so both
 * controls stand down rather than acting on a run the reader cannot see.
 */

const NavLink = createLink(NavAnchor)

type JournalView = 'journal' | 'archive' | 'current'

function viewForPath(pathname: string): JournalView {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[1] === 'archive') return 'archive'
  if (segments[1] === 'current') return 'current'
  return 'journal'
}

/** The run the header's controls act on, or null when the view names none. */
function runIdForPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[1] !== 'run' || !segments[2]) return null
  try {
    return decodeURIComponent(segments[2])
  } catch {
    return segments[2]
  }
}

export function JournalLayout(): JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const view = viewForPath(pathname)
  const routeId = runIdForPath(pathname)
  const navigate = useNavigate()
  const catalog = useJournalCatalog()
  const latest = useLatestFinishedRun()
  const [exported, setExported] = useState<{ text: string; bad: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useJournalViewed(view)

  // On the index the picker names the run the index is actually showing.
  const activeId = view === 'journal' ? (routeId ?? latest?.id ?? null) : null

  const options = useMemo(() => pickerOptions(catalog.data), [catalog.data])

  const onPick = useCallback(
    (id: string) => {
      if (!id) return
      navigate({ to: '/journal/run/$id', params: { id } })
    },
    [navigate]
  )

  const onExport = useCallback(() => {
    if (!activeId) return
    setBusy(true)
    setExported(null)
    void exportRun(activeId)
      .then((result) =>
        setExported(
          'error' in result
            ? { text: result.error, bad: true }
            : { text: `saved to ${result.data.path}`, bad: false }
        )
      )
      .finally(() => setBusy(false))
  }, [activeId])

  // A new run in the picker is a new export target; the old path would be a
  // stale claim about a file the reader is no longer looking at.
  useEffect(() => setExported(null), [activeId])

  return (
    <Frame>
      <Head>
        <HeadInner>
          <Nav aria-label="Journal sections">
            <NavLink to="/journal" $active={view === 'journal'}>
              Journal
            </NavLink>
            <NavLink to="/journal/archive" $active={view === 'archive'}>
              Archive
            </NavLink>
            <NavLink to="/journal/current" $active={view === 'current'}>
              Current Run
            </NavLink>
          </Nav>

          <Controls>
            <RunSelect
              aria-label="Which run to read"
              title={
                activeId
                  ? 'Which run this report is about'
                  : 'Open the Journal view to read a run'
              }
              value={activeId ?? ''}
              disabled={options.length === 0}
              onChange={(e) => onPick(e.target.value)}
            >
              {activeId ? null : <option value="">Pick a run…</option>}
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </RunSelect>
            <Button type="button" onClick={onExport} disabled={!activeId || busy}>
              Export JSON
            </Button>
          </Controls>
        </HeadInner>
        {exported ? (
          <ExportLine>
            <Whisper style={{ color: exported.bad ? 'var(--sts-color-red)' : undefined }}>
              {exported.text}
            </Whisper>
          </ExportLine>
        ) : null}
      </Head>

      <Body>
        <BodyInner>
          <Outlet />
        </BodyInner>
      </Body>
    </Frame>
  )
}

/** "2026-08-12 · Ironclad · a41f3c" — the picker's row, as the mockup writes it. */
function pickerOptions(entries: CatalogEntry[] | null): { id: string; label: string }[] {
  return (entries ?? [])
    .filter((entry) => !entry.unreadable)
    .map((entry) => ({
      id: entry.id,
      label: `${runDay(entry.startedAt ?? entry.firstSeenAt)} · ${title(entry.character)} · ${shortId(entry.id)}`
    }))
}

function title(character: string): string {
  const name = characterName(character)
  return name.charAt(0) + name.slice(1).toLowerCase()
}

/** Run ids end in a short content hash; that tail is the human-sized handle. */
function shortId(id: string): string {
  const tail = id.split('-').pop() ?? id
  return tail.slice(0, 6)
}

/**
 * `journal_view`, once per arrival at one of the tab's three views.
 *
 * Shaped after the Codex's and guarded the same way — a ref, so StrictMode's
 * double effect and every unrelated re-render (a push landing, an export
 * resolving) count as nothing. The first view *is* reported: this layout only
 * mounts because somebody navigated into the Journal, so the arrival is real.
 * The `tab_viewed {tab:'journal'}` event above it is the shell's, unchanged.
 */
function useJournalViewed(view: JournalView): void {
  const seen = useRef<JournalView | null>(null)
  useEffect(() => {
    if (seen.current === view) return
    seen.current = view
    reportEvent('journal_view', { view })
  }, [view])
}

// ── chrome ──────────────────────────────────────────────────────────────────

const Frame = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`

const Head = styled.div`
  flex: 0 0 auto;
  border-bottom: 1px solid var(--line);
  background: oklch(0 0 0 / 12%);
`

/** One measure for the whole tab, shared with the Codex so the tabs line up. */
const Measure = styled.div`
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 22px;
  @media (max-width: 560px) {
    padding: 0 12px;
  }
`

const HeadInner = styled(Measure)`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 16px;
  min-height: 44px;
  padding-top: 4px;
  padding-bottom: 4px;
`

const ExportLine = styled(Measure)`
  padding-bottom: 6px;
  word-break: break-all;
`

const Nav = styled.nav`
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 0 0 auto;
`

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  justify-content: flex-end;
  min-width: 0;
`

/**
 * Run labels are long and a `<select>` is as wide as its widest option; the cap
 * keeps one very long id from pushing Export JSON off the row.
 */
const RunSelect = styled(Select)`
  max-width: 320px;
  min-width: 150px;
`

const Body = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  ${scrollbar}
`

const BodyInner = styled(Measure)`
  padding-top: 14px;
  padding-bottom: 34px;
`
