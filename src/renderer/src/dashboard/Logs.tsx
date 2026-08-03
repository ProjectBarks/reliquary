import { useEffect, useMemo, useRef, useState } from 'react'
import styled from 'styled-components'
import type { LogLine } from '@shared/types'
import { useLogs } from '../hooks/useIpc'

/**
 * Logs tab: a live view of captured main-process console output. Streams from
 * the IPC log bus (history replayed on mount), with level filtering, a clear
 * (view-only) cutoff, and sticky auto-scroll that releases when you scroll up.
 */

type Filter = 'all' | 'log' | 'warn' | 'error'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'log', label: 'Info' },
  { id: 'warn', label: 'Warn' },
  { id: 'error', label: 'Error' }
]

export function Logs(): JSX.Element {
  const all = useLogs()
  const [filter, setFilter] = useState<Filter>('all')
  const [clearedAt, setClearedAt] = useState(0)
  const [stick, setStick] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(
    () =>
      all.filter((l) => l.t >= clearedAt && (filter === 'all' || l.level === filter)),
    [all, clearedAt, filter]
  )

  // Keep pinned to the bottom while sticky.
  useEffect(() => {
    if (stick && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [lines, stick])

  // Release/re-arm auto-scroll based on whether the user is near the bottom.
  const onScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setStick(atBottom)
  }

  const counts = useMemo(() => {
    let warn = 0
    let error = 0
    for (const l of all) {
      if (l.t < clearedAt) continue
      if (l.level === 'warn') warn++
      else if (l.level === 'error') error++
    }
    return { warn, error }
  }, [all, clearedAt])

  return (
    <Wrap>
      <Toolbar>
        <Filters>
          {FILTERS.map((f) => (
            <FilterBtn key={f.id} $active={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </FilterBtn>
          ))}
        </Filters>
        <Spacer />
        <Meta>
          {lines.length} lines
          {counts.warn ? <b className="warn"> · {counts.warn} warn</b> : null}
          {counts.error ? <b className="err"> · {counts.error} err</b> : null}
        </Meta>
        <Toggle $on={stick} onClick={() => setStick((s) => !s)} title="Auto-scroll to newest">
          Auto-scroll
        </Toggle>
        <ClearBtn
          onClick={() => setClearedAt(all.length ? all[all.length - 1].t + 1 : Date.now())}
          title="Clear the view (does not affect the file log)"
        >
          Clear
        </ClearBtn>
      </Toolbar>

      <Body ref={bodyRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <Empty>No log lines yet.</Empty>
        ) : (
          lines.map((l, i) => <Line key={i} line={l} />)
        )}
      </Body>
    </Wrap>
  )
}

function Line({ line }: { line: LogLine }): JSX.Element {
  return (
    <Row $level={line.level}>
      <Time>{fmtTime(line.t)}</Time>
      <Lvl $level={line.level}>{line.level === 'log' ? 'INF' : line.level.toUpperCase()}</Lvl>
      <Text>{line.text}</Text>
    </Row>
  )
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

const Wrap = styled.div`
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
  gap: 12px;
`

const Toolbar = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
`

const Filters = styled.div`
  display: flex;
  gap: 4px;
`

const FilterBtn = styled.button<{ $active: boolean }>`
  cursor: pointer;
  padding: 6px 14px;
  border-radius: 7px;
  font-size: 13px;
  color: ${(p) => (p.$active ? '#1a1613' : 'var(--sts-color-cream)')};
  background: ${(p) => (p.$active ? 'var(--brand)' : 'oklch(1 0 0 / 5%)')};
  border: 1px solid ${(p) => (p.$active ? 'var(--brand)' : 'oklch(1 0 0 / 12%)')};
  &:hover {
    background: ${(p) => (p.$active ? 'var(--brand)' : 'oklch(1 0 0 / 10%)')};
  }
`

const Spacer = styled.div`
  flex: 1;
`

const Meta = styled.div`
  font-size: 12px;
  color: #9c9384;
  b {
    font-weight: 600;
  }
  b.warn {
    color: var(--sts-color-orange);
  }
  b.err {
    color: var(--sts-color-red);
  }
`

const Toggle = styled.button<{ $on: boolean }>`
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 7px;
  font-size: 13px;
  color: ${(p) => (p.$on ? 'var(--sts-color-aqua)' : '#9c9384')};
  background: oklch(1 0 0 / 5%);
  border: 1px solid ${(p) => (p.$on ? 'oklch(0.82 0.13 190 / 45%)' : 'oklch(1 0 0 / 12%)')};
  &:hover {
    background: oklch(1 0 0 / 10%);
  }
`

const ClearBtn = styled.button`
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--sts-color-cream);
  background: oklch(1 0 0 / 5%);
  border: 1px solid oklch(1 0 0 / 12%);
  &:hover {
    background: oklch(1 0 0 / 10%);
  }
`

const Body = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid oklch(1 0 0 / 8%);
  padding: 8px 4px;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  &::-webkit-scrollbar {
    width: 8px;
  }
  &::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 18%);
    border-radius: 4px;
  }
`

const Row = styled.div<{ $level: LogLine['level'] }>`
  display: flex;
  gap: 10px;
  padding: 1px 10px;
  white-space: pre-wrap;
  word-break: break-word;
  background: ${(p) =>
    p.$level === 'error'
      ? 'oklch(0.6 0.2 25 / 10%)'
      : p.$level === 'warn'
        ? 'oklch(0.78 0.15 70 / 8%)'
        : 'transparent'};
`

const Time = styled.span`
  flex: 0 0 auto;
  color: #6f685c;
`

const Lvl = styled.span<{ $level: LogLine['level'] }>`
  flex: 0 0 34px;
  font-weight: 600;
  color: ${(p) =>
    p.$level === 'error'
      ? 'var(--sts-color-red)'
      : p.$level === 'warn'
        ? 'var(--sts-color-orange)'
        : 'var(--sts-color-aqua)'};
`

const Text = styled.span`
  flex: 1;
  color: #cdc3b1;
`

const Empty = styled.div`
  padding: 24px;
  text-align: center;
  color: #6f685c;
  font-family: 'Montserrat', sans-serif;
`
