import { useCallback, useEffect, useRef } from 'react'
import { Outlet, createLink, useNavigate, useRouterState } from '@tanstack/react-router'
import styled from 'styled-components'
import { CODEX_BRACKETS, bracketLabel, isCodexBracket, type CodexKind } from '@shared/codex'
import { Select, Spinner } from '../dashboard/ui'
import { useCharacters, useMetrics } from './data'
import { fmtInt, fmtPct, relativeTime } from './format'
import {
  CODEX_KINDS,
  isCodexKind,
  kindLabel,
  useActiveKind,
  useBrowseSearch,
  useCodexScope,
  useCodexSearch,
  useMetaSearch,
  useTableSearch,
  type CodexSearch
} from './params'
import { NavAnchor, Whisper, scrollbar } from './parts'
import { setBracketPref, setCharacterPref } from './prefs'
import { PinnedRail } from './PinnedRail'
import { reportEvent } from '../telemetry'

/**
 * The Codex's frame: a spine down the left of the sub-nav, the cohort controls
 * on the right, the current view in the middle, and the pinned rail along the
 * bottom.
 *
 * The sub-nav is deliberately *not* styled like the top-level tabs. Those are
 * filled violet pills; these are Kreon words with a 2px rule under the active
 * one. Two levels of navigation that look the same read as one confusing level,
 * and the reader needs to be able to tell "which part of the app" from "which
 * part of the Codex" without thinking about it.
 *
 * The bracket and character selects live up here rather than inside each view
 * because they are not a view's setting — they decide which population every
 * number in the tab is describing. Moving them into the library and the tier
 * list separately would let the two disagree, and there is no honest way to
 * render a screen where the same card has two different win rates.
 */

const NavLink = createLink(NavAnchor)

export function CodexLayout(): JSX.Element {
  const scope = useCodexScope()
  const codexSearch = useCodexSearch()
  const activeKind = useActiveKind()
  const setScope = useScopeNavigate()
  const characters = useCharacters()

  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const segments = pathname.split('/').filter(Boolean)
  const inBrowse = segments[1] === 'browse'
  const inMeta = segments[1] === 'meta'
  const browseKind: CodexKind = inBrowse && isCodexKind(segments[2]) ? segments[2] : 'cards'
  useCodexViewed(inBrowse ? 'browse' : segments[2] === 'table' ? 'table' : 'tiers')

  return (
    <Frame>
      <Head>
        <HeadInner>
          <Nav aria-label="Codex sections">
            {CODEX_KINDS.map((kind) => (
              <NavLink
                key={kind}
                to="/codex/browse/$kind"
                params={{ kind }}
                search={codexSearch}
                $active={inBrowse && browseKind === kind}
              >
                {kindLabel(kind)}
              </NavLink>
            ))}
            <NavDivider aria-hidden />
            <NavLink
              to="/codex/meta/tiers"
              search={{ ...codexSearch, kind: activeKind }}
              $active={inMeta}
            >
              Meta
            </NavLink>
          </Nav>

          <Controls>
            <FreshnessWhisper kind={activeKind} />
            <Select
              aria-label="Run cohort"
              title="Which runs every score on this page is computed from"
              value={scope.bracket}
              onChange={(e) => {
                const next = e.target.value
                if (!isCodexBracket(next)) return
                setBracketPref(next)
                setScope({ bracket: next })
              }}
            >
              {CODEX_BRACKETS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
            <CharacterSelect
              aria-label="Character"
              title="Restrict the numbers to runs of one character"
              value={scope.character ?? 'all'}
              onChange={(e) => {
                const next = e.target.value === 'all' ? null : e.target.value
                setCharacterPref(next)
                setScope({ character: next ?? undefined })
              }}
            >
              <option value="all">All characters</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </CharacterSelect>
          </Controls>
        </HeadInner>
      </Head>

      <Body>
        <BodyInner>
          <Outlet />
        </BodyInner>
      </Body>

      <PinnedRail />
    </Frame>
  )
}

/**
 * `codex_view`, once per arrival at one of the tab's three screens.
 *
 * Shaped after `Shell`'s `tab_viewed` and guarded the same way — a ref, so
 * StrictMode's double effect and every unrelated re-render of the layout (a
 * cohort change, a metrics push landing) count as nothing. The one difference
 * is that the *first* view is reported: the shell's opening tab is where the
 * window happened to start, but this layout only ever mounts because somebody
 * navigated into the Codex, so the arrival is real.
 */
function useCodexViewed(view: 'browse' | 'tiers' | 'table'): void {
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (seen.current === view) return
    seen.current = view
    reportEvent('codex_view', { view })
  }, [view])
}

/**
 * "community data · 1,284,003 runs · baseline 41.6% · updated 4 min ago".
 *
 * Attribution and freshness in one line, in the quietest type on the page. Every
 * number in this tab belongs to somebody else's dataset; saying so once, always
 * visible, is cheaper than a disclaimer nobody reads and more honest than
 * numbers that appear to be ours.
 */
function FreshnessWhisper({ kind }: { kind: CodexKind }): JSX.Element | null {
  const scope = useCodexScope()
  const metrics = useMetrics(kind, scope.bracket, scope.character)
  const table = metrics.data
  const waiting = metrics.loading || metrics.stale

  if (metrics.error && !table) {
    return (
      <HeadWhisper title={metrics.error}>
        <Dot $bad />
        community data unavailable
      </HeadWhisper>
    )
  }

  const parts = ['community data']
  if (table?.total_runs != null) parts.push(`${fmtInt(table.total_runs)} runs`)
  if (table?.baseline_win_rate != null) parts.push(`baseline ${fmtPct(table.baseline_win_rate)}`)
  if (metrics.fetchedAt) parts.push(`updated ${relativeTime(metrics.fetchedAt)}`)

  return (
    <HeadWhisper title={`${bracketLabel(scope.bracket)} · spire-codex.com`}>
      {waiting ? <Spinner size={12} /> : null}
      <Truncate>{parts.join(' · ')}</Truncate>
    </HeadWhisper>
  )
}

/**
 * Change the cohort without leaving the page you are on.
 *
 * The router's `to` is typed against the real route tree, so this branches over
 * the four shapes a Codex URL can have rather than pasting the current pathname
 * back in. Verbose, but it means a scope change can never navigate somewhere
 * that doesn't exist — and `replace` keeps a session of bracket-fiddling out of
 * the back button.
 */
function useScopeNavigate(): (patch: CodexSearch) => void {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const browse = useBrowseSearch()
  const meta = useMetaSearch()
  const table = useTableSearch()

  return useCallback(
    (patch: CodexSearch) => {
      const segments = pathname.split('/').filter(Boolean)
      if (segments[1] === 'browse') {
        const kind: CodexKind = isCodexKind(segments[2]) ? segments[2] : 'cards'
        const search = { ...browse, ...patch }
        const id = segments[3]
        if (id) navigate({ to: '/codex/browse/$kind/$id', params: { kind, id }, search, replace: true })
        else navigate({ to: '/codex/browse/$kind', params: { kind }, search, replace: true })
        return
      }
      if (segments[1] === 'meta' && segments[2] === 'table') {
        navigate({ to: '/codex/meta/table', search: { ...table, ...patch }, replace: true })
        return
      }
      if (segments[1] === 'meta') {
        navigate({ to: '/codex/meta/tiers', search: { ...meta, ...patch }, replace: true })
        return
      }
      navigate({
        to: '/codex/browse/$kind',
        params: { kind: 'cards' },
        search: { ...browse, ...patch },
        replace: true
      })
    },
    [browse, meta, navigate, pathname, table]
  )
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

/** One measure for the whole tab, so the sub-nav and the grid share a left edge. */
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

const Nav = styled.nav`
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 0 0 auto;
`

const NavDivider = styled.span`
  width: 1px;
  height: 16px;
  background: var(--line-strong);
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
 * The whisper eats all the slack in the head row, so the two selects stay
 * pinned to the right edge instead of sliding left as "1,183,705 runs ·
 * baseline 43.4% · updated just now" arrives a word at a time.
 */
const HeadWhisper = styled(Whisper)`
  flex: 1 1 auto;
  justify-content: flex-end;
`

/**
 * A `<select>` is as wide as its widest option, and this one's options arrive
 * with the characters catalog — without a floor it starts at the width of "All
 * characters" and jumps once five names land.
 */
const CharacterSelect = styled(Select)`
  min-width: 128px;
`

const Truncate = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42ch;
`

const Dot = styled.span<{ $bad?: boolean }>`
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: ${(p) => (p.$bad ? 'var(--gem-bad)' : 'var(--gem-off)')};
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
