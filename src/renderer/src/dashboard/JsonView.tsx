import { useState } from 'react'
import styled from 'styled-components'

/**
 * A tiny dependency-free JSON viewer for the Debug live-state dumps: syntax
 * highlighted (keys / strings / numbers / booleans / null each get a colour)
 * and explorable — objects and arrays collapse/expand on click, with a
 * count summary when collapsed. Nodes auto-expand for the first couple of
 * levels so the common shapes are readable at a glance without over-nesting.
 */
export function JsonView({ data }: { data: unknown }): JSX.Element {
  return (
    <Root>
      {data === undefined || data === null ? (
        <Line>
          <Caret />
          <Null>—</Null>
        </Line>
      ) : (
        <Node k={null} value={data} depth={0} last />
      )}
    </Root>
  )
}

const AUTO_OPEN_DEPTH = 2

function Node({
  k,
  value,
  depth,
  last
}: {
  k: string | number | null
  value: unknown
  depth: number
  last: boolean
}): JSX.Element {
  const isArray = Array.isArray(value)
  const isObject = !isArray && value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < AUTO_OPEN_DEPTH)

  const indent = { paddingLeft: 6 + depth * 14 }

  if (!isArray && !isObject) {
    return (
      <Line style={indent}>
        <Caret />
        <Label k={k} />
        <Primitive value={value} />
        {!last && <Punc>,</Punc>}
      </Line>
    )
  }

  const entries: [string | number, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>)
  const openBrace = isArray ? '[' : '{'
  const closeBrace = isArray ? ']' : '}'
  const count = entries.length

  return (
    <>
      <Line style={indent} $clickable={count > 0} onClick={count > 0 ? () => setOpen((o) => !o) : undefined}>
        <Caret>{count === 0 ? '' : open ? '▾' : '▸'}</Caret>
        <Label k={k} />
        <Punc>{openBrace}</Punc>
        {!open && count > 0 ? (
          <Summary>
            {' '}
            {count} {isArray ? (count === 1 ? 'item' : 'items') : count === 1 ? 'key' : 'keys'}{' '}
          </Summary>
        ) : null}
        {!open ? <Punc>{closeBrace}</Punc> : null}
        {!open && !last ? <Punc>,</Punc> : null}
      </Line>
      {open
        ? entries.map(([ck, cv], i) => (
            <Node key={ck} k={ck} value={cv} depth={depth + 1} last={i === entries.length - 1} />
          ))
        : null}
      {open ? (
        <Line style={indent}>
          <Caret />
          <Punc>{closeBrace}</Punc>
          {!last ? <Punc>,</Punc> : null}
        </Line>
      ) : null}
    </>
  )
}

function Label({ k }: { k: string | number | null }): JSX.Element | null {
  if (k === null) return null
  return (
    <>
      <Key>{typeof k === 'number' ? k : k}</Key>
      <Punc>: </Punc>
    </>
  )
}

function Primitive({ value }: { value: unknown }): JSX.Element {
  if (typeof value === 'string') return <Str>&quot;{value}&quot;</Str>
  if (typeof value === 'number') return <Num>{value}</Num>
  if (typeof value === 'boolean') return <Bool>{String(value)}</Bool>
  if (value === null) return <Null>null</Null>
  return <span>{String(value)}</span>
}

const Root = styled.div`
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
  color: #cdc3b1;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 6px;
  padding: 8px 4px;
  max-height: 260px;
  overflow: auto;
  &::-webkit-scrollbar {
    width: 8px;
  }
  &::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 16%);
    border-radius: 4px;
  }
`

const Line = styled.div<{ $clickable?: boolean }>`
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 4px;
  cursor: ${(p) => (p.$clickable ? 'pointer' : 'default')};
  &:hover {
    background: ${(p) => (p.$clickable ? 'oklch(1 0 0 / 6%)' : 'transparent')};
  }
`

const Caret = styled.span`
  display: inline-block;
  width: 14px;
  color: #7d7669;
  user-select: none;
`

const Key = styled.span`
  color: var(--sts-color-blue);
`

const Str = styled.span`
  color: var(--sts-color-green);
`

const Num = styled.span`
  color: var(--sts-color-orange);
`

const Bool = styled.span`
  color: var(--sts-color-purple);
`

const Null = styled.span`
  color: #7d7669;
  font-style: italic;
`

const Punc = styled.span`
  color: #8a8377;
`

const Summary = styled.span`
  color: #6f685c;
  font-style: italic;
`
