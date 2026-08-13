import { Fragment, useMemo, type ReactNode } from 'react'
import styled from 'styled-components'
import type { CodexKeyword } from '@shared/codex'
import { useKeywords } from './data'
import { KeywordTerm } from './KeywordTooltip'

/**
 * The compendium's card text, rendered the way the game writes it.
 *
 * The API hands back a BBCode-ish markup — `Deal [gold]12[/gold] damage.\nApply
 * [blue]2[/blue] Weak.` — where the colours are not decoration: gold is a
 * number the card actually has, blue is a status it applies. Rendering the raw
 * string would show the reader the tags; rendering it colourless would throw
 * away the only typographic structure card text has.
 *
 * Two rules keep this safe and boring:
 *   - It never touches `dangerouslySetInnerHTML`. Everything becomes React
 *     elements, so a malformed (or hostile) description is text, not markup.
 *   - Unknown tags are dropped, not printed. A new colour appearing in the
 *     data upstream should read as plain text here, never as `[cyan]`.
 */

/**
 * The markup's colour names, mapped onto tokens the app already owns. These are
 * the game's own accent colours, ported into `overlay.css` with the rest of the
 * StS palette — the compendium and the in-game overlay tint the same words the
 * same way because they read from the same variables.
 */
const COLORS: Record<string, string> = {
  gold: 'var(--sts-color-gold)',
  blue: 'var(--sts-color-blue)',
  darkblue: 'var(--sts-color-darkblue)',
  red: 'var(--sts-color-red)',
  green: 'var(--sts-color-green)',
  purple: 'var(--sts-color-purple)',
  orange: 'var(--sts-color-orange)',
  pink: 'var(--sts-color-pink)',
  aqua: 'var(--sts-color-aqua)',
  cream: 'var(--sts-color-cream)'
}

interface Run {
  text: string
  color: string | null
}

const TAG = /\[(\/?)([a-z]+)\]/gi

/**
 * Flatten the markup into coloured runs.
 *
 * A stack rather than a pair of indices, because the data does nest
 * (`[gold]12 [red]Vulnerable[/red][/gold]`), and closing an unopened tag or
 * leaving one open must not corrupt everything after it — a description with
 * broken markup should lose its colour, not its text.
 */
export function parseRuns(source: string): Run[] {
  const runs: Run[] = []
  const stack: string[] = []
  let last = 0
  TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG.exec(source)) !== null) {
    if (match.index > last) {
      runs.push({ text: source.slice(last, match.index), color: COLORS[stack[stack.length - 1]] ?? null })
    }
    last = TAG.lastIndex
    const tag = match[2].toLowerCase()
    if (match[1] === '/') {
      const at = stack.lastIndexOf(tag)
      if (at >= 0) stack.splice(at, 1)
    } else if (tag in COLORS) {
      stack.push(tag)
    }
    // Anything else — an unknown colour, a stray `[x]` — is simply consumed.
  }
  if (last < source.length) {
    runs.push({ text: source.slice(last), color: COLORS[stack[stack.length - 1]] ?? null })
  }
  return runs.filter((r) => r.text.length > 0)
}

/** Regex chars are rare in keyword names but "Block+" would ruin the day. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface KeywordMatcher {
  pattern: RegExp | null
  byName: Map<string, string>
}

/**
 * One alternation over every known keyword, longest first so "Exhaust Pile"
 * wins over "Exhaust". Built once per keyword list, not once per description:
 * a detail view renders this against ~40 terms and the tier list would rebuild
 * it hundreds of times a scroll otherwise.
 */
function buildMatcher(keywords: readonly CodexKeyword[]): KeywordMatcher {
  const byName = new Map<string, string>()
  for (const k of keywords) {
    if (!k.name || !k.description) continue
    byName.set(k.name.toLowerCase(), k.description)
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length)
  if (!names.length) return { pattern: null, byName }
  return { pattern: new RegExp(`\\b(${names.map(escapeRe).join('|')})\\b`, 'gi'), byName }
}

/** Split one plain chunk into text and keyword terms. */
function withKeywords(text: string, matcher: KeywordMatcher, keyPrefix: string): ReactNode[] {
  if (!matcher.pattern) return [text]
  const out: ReactNode[] = []
  let last = 0
  matcher.pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = matcher.pattern.exec(text)) !== null) {
    const description = matcher.byName.get(match[0].toLowerCase())
    if (!description) continue
    if (match.index > last) out.push(text.slice(last, match.index))
    out.push(
      <KeywordTerm key={`${keyPrefix}-k${match.index}`} term={match[0]} description={description} />
    )
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Render one description.
 *
 * `keywords` defaults to the shared catalog, so a caller only passes it to turn
 * the tooltips *off* — which is what the compare grid and the library's meta
 * lines do, where a tooltip inside an already-floating surface would be a
 * dialog inside a dialog.
 */
export function RichText({
  text,
  keywords = true,
  className
}: {
  text: string | null | undefined
  keywords?: boolean
  className?: string
}): JSX.Element | null {
  const definitions = useKeywords()
  const matcher = useMemo(
    () => (keywords ? buildMatcher(definitions) : { pattern: null, byName: new Map<string, string>() }),
    [definitions, keywords]
  )
  const runs = useMemo(() => (text ? parseRuns(text) : []), [text])

  if (!text || !runs.length) return null

  return (
    <Body className={className}>
      {runs.map((run, i) => (
        <Colored key={i} style={run.color ? { color: run.color } : undefined}>
          {run.text.split('\n').map((line, j, all) => (
            <Fragment key={j}>
              {withKeywords(line, matcher, `${i}-${j}`)}
              {j < all.length - 1 ? <br /> : null}
            </Fragment>
          ))}
        </Colored>
      ))}
    </Body>
  )
}

const Body = styled.div`
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`

const Colored = styled.span`
  color: inherit;
`
