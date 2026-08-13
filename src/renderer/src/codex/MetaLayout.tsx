import { useCallback, useMemo } from 'react'
import { Outlet, createLink, useNavigate, useRouterState } from '@tanstack/react-router'
import styled from 'styled-components'
import { bracketLabel, type CodexKind } from '@shared/codex'
import { useMetrics } from './data'
import { fmtInt, fmtPct } from './format'
import { CODEX_KINDS, kindLabel, useCodexScope, useMetaSearch, useTableSearch } from './params'
import { NavAnchor, Segmented } from './parts'

/**
 * The meta half of the tab: the same three catalogs, read as a population
 * rather than as a set of objects.
 *
 * Tier list and table are two renderings of one dataset, not two features —
 * the tier list answers "what should I take" at a glance and the table answers
 * "why" — so they share a kind switcher, a cohort, and the summary line that
 * says what population is being described. The summary is not decoration: a
 * win rate means nothing until you know the baseline it is being compared
 * against, and a tier list of 30,000 runs is a different document from a tier
 * list of 3 million.
 */

const MetaTab = createLink(NavAnchor)

export function MetaLayout(): JSX.Element {
  const search = useMetaSearch()
  const kind: CodexKind = search.kind ?? 'cards'
  const scope = useCodexScope()
  const metrics = useMetrics(kind, scope.bracket, scope.character)
  const setKind = useKindNavigate()

  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const onTable = pathname.endsWith('/table')

  const rated = useMemo(
    () => (metrics.data?.rows ?? []).filter((r) => !r.upgraded && r.score != null).length,
    [metrics.data]
  )

  const table = metrics.data
  const summary = [
    bracketLabel(scope.bracket),
    ...(scope.character ? [scope.character] : []),
    table?.total_runs != null ? `${fmtInt(table.total_runs)} runs` : null,
    table?.baseline_win_rate != null ? `baseline win rate ${fmtPct(table.baseline_win_rate)}` : null,
    rated ? `${fmtInt(rated)} rated` : null
  ].filter(Boolean) as string[]

  return (
    <>
      <Bar>
        <Segmented
          label="Compendium"
          value={kind}
          onChange={setKind}
          options={CODEX_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
        />
        <Tabs>
          <MetaTab to="/codex/meta/tiers" search={search} $active={!onTable}>
            Tier list
          </MetaTab>
          <MetaTab to="/codex/meta/table" search={search} $active={onTable}>
            Table
          </MetaTab>
        </Tabs>
      </Bar>

      <Summary>{summary.join(' · ')}</Summary>

      <Outlet />
    </>
  )
}

/** Switch which catalog the meta views describe, staying on the same view. */
function useKindNavigate(): (kind: CodexKind) => void {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const meta = useMetaSearch()
  const table = useTableSearch()

  return useCallback(
    (kind: CodexKind) => {
      if (pathname.endsWith('/table')) {
        // A colour filter is a card concept; carrying it onto relics would
        // silently empty the table.
        navigate({ to: '/codex/meta/table', search: { ...table, kind, color: undefined }, replace: true })
        return
      }
      navigate({ to: '/codex/meta/tiers', search: { ...meta, kind }, replace: true })
    },
    [meta, navigate, pathname, table]
  )
}

const Bar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 20px;
  padding: 4px 2px 10px;
`

const Tabs = styled.nav`
  display: flex;
  align-items: center;
  gap: 16px;
`

const Summary = styled.p`
  margin: 0 2px 14px;
  font-size: 12px;
  color: var(--ink-faint);
`
