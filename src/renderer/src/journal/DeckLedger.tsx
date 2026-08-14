import styled from 'styled-components'
import { DASH, fmtInt } from '../codex/format'
import { useEntities, type ResolvedEntity } from './art'
import type { DeckLedger as DeckLedgerData, DeckLedgerRow } from './derive'
import { Art, Note, Num, TBox, Table, Whisper } from './parts'

/**
 * The Deck Ledger: what the deck ended as, and what each card actually did.
 *
 * Three treatments carry the whole table, and each is a verdict the data can
 * genuinely support:
 *
 *   - **CORE** — the card is in the run's own `signature.core`, which is the
 *     recorder's list of the non-basic cards that defined the deck. It is not a
 *     judgement about quality; it is "this is what the run was".
 *   - **NEVER PLAYED** — drawn at least once, played zero times. A tinted row,
 *     red numerals, a red inset edge, and the row sinks to the bottom of the
 *     sort. It is the single most useful thing this table says, and the mockup
 *     was right to make it the loudest.
 *   - **2ND COPY DEAD** — the analysis said so. It cannot be derived: plays are
 *     tallied per card id, so nothing measures which *copy* of a pair was the
 *     one that sat in hand. The chip appears when the pipeline names the row and
 *     stays absent otherwise, rather than being guessed from a low play rate.
 *
 * `played` is approximate by construction — it is inferred from 250 ms pile
 * sampling — and the whisper under the table says so rather than letting a
 * decimal imply a precision the sampler cannot give.
 */

export function DeckLedger({
  deck,
  halfDead
}: {
  deck: DeckLedgerData
  /** Rows the analysis flagged as carrying a dead extra copy. */
  halfDead?: readonly string[]
}): JSX.Element {
  const entities = useEntities()
  const half = new Set((halfDead ?? []).map((id) => id.toUpperCase()))

  if (deck.empty) {
    return (
      <Note>
        No final deck on this run yet — it is written when the run ends.
      </Note>
    )
  }

  return (
    <>
      <TBox>
        <DeckTable>
          <colgroup>
            <col style={{ width: '44px' }} />
            <col />
            <col style={{ width: '70px' }} />
            <col style={{ width: '70px' }} />
            <col style={{ width: '74px' }} />
            <col style={{ width: '64px' }} />
            <col style={{ width: '170px' }} />
            <col style={{ width: '150px' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="r">#</th>
              <th>Card</th>
              <th className="r">Copies</th>
              <th className="r">Drawn</th>
              <th className="r sorted">Played ▾</th>
              <th className="r">Dead</th>
              <th className="r">Rate</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {deck.rows.map((row, i) => (
              <Row
                key={row.id}
                row={row}
                index={i + 1}
                half={half.has(row.id.toUpperCase())}
                name={entities.card(row.id, row.maxUpgrade)}
              />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="r total">
                <Num>{deck.rows.length}</Num>
              </td>
              <td>rows</td>
              <td className="r total">
                <Num>{deck.cards}</Num>
              </td>
              <td className="r total">{deck.drawn === null ? DASH : fmtInt(deck.drawn)}</td>
              <td className="r total">{deck.played === null ? DASH : fmtInt(deck.played)}</td>
              <td className="r total">{deck.dead === null ? DASH : fmtInt(deck.dead)}</td>
              <td className="r total">{deck.rate === null ? DASH : `${deck.rate.toFixed(1)}%`}</td>
              <td>
                {deck.countsMissing
                  ? 'no combat observed'
                  : `${deck.neverPlayed} never played`}
              </td>
            </tr>
          </tfoot>
        </DeckTable>
      </TBox>
      <Whisper style={{ margin: '10px 2px 0' }}>
        {deck.countsMissing
          ? 'draw and play counts need an observed combat — this run has none on file'
          : 'played is approximate — 250 ms pile sampling; end-of-turn discards excluded'}
      </Whisper>
    </>
  )
}

function Row({
  row,
  index,
  half,
  name
}: {
  row: DeckLedgerRow
  index: number
  half: boolean
  name: ResolvedEntity
}): JSX.Element {
  const tone = row.never ? 'dead' : half ? 'half' : row.core ? 'core' : null
  return (
    <DeckRow $tone={tone}>
      <td className="idx">{index < 10 ? `0${index}` : index}</td>
      <td>
        <CardCell>
          <Art entity={name} variant="render" />
          {/* A `+` means *every* copy is upgraded. A row holding one of each —
              Shrug It Off and Shrug It Off+ — says `+1` instead, because a bare
              plus on a ×2 row would claim both copies were upgraded. */}
          <CardName>
            {name.name}
            {row.upgradedCopies === 0 ? null : row.upgradedCopies === row.copies ? (
              <Up>+</Up>
            ) : (
              <Up title={`${row.upgradedCopies} of ${row.copies} upgraded`}>
                +{row.upgradedCopies}
              </Up>
            )}
          </CardName>
          {row.copies > 1 ? <Copies>×{row.copies}</Copies> : null}
        </CardCell>
      </td>
      <td className="r">
        <Num>{row.copies}</Num>
      </td>
      <td className="r dimnum">{row.drawn === null ? DASH : <Num>{row.drawn}</Num>}</td>
      <td className="r played">{row.played === null ? DASH : <Num>{row.played}</Num>}</td>
      <td className="r dimnum">{row.dead === null ? DASH : <Num>{row.dead}</Num>}</td>
      <td className="r">
        <RateWrap>
          <RateNum>{row.rate === null ? DASH : `${row.rate.toFixed(1)}%`}</RateNum>
          <RateBar $pct={row.rate ?? 0} aria-hidden />
        </RateWrap>
      </td>
      <td>
        {row.never ? (
          <Verdict $kind="dead">NEVER PLAYED</Verdict>
        ) : half ? (
          <Verdict $kind="half">2ND COPY DEAD</Verdict>
        ) : row.core ? (
          <Verdict $kind="core">CORE</Verdict>
        ) : null}
      </td>
    </DeckRow>
  )
}

// ── surfaces ────────────────────────────────────────────────────────────────

const DeckTable = styled(Table)`
  table-layout: fixed;
  font-size: 12.5px;

  thead th {
    padding: 9px 12px;
    font-size: 10.5px;
    letter-spacing: 0.7px;
    color: var(--ink-faint);
    background: #211e1c;
  }
  thead th.sorted {
    color: var(--ink-dim);
  }
  tbody td {
    height: 51px;
    padding: 3px 12px;
    white-space: nowrap;
  }
  tbody tr:first-child td {
    border-top: 0;
  }
  tbody tr:nth-child(even) td {
    background: oklch(1 0 0 / 2%);
  }
  tbody td.idx {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-faint);
    text-align: right;
  }
  tbody td.dimnum {
    color: var(--ink-dim);
  }
`

/**
 * One accent per row: the verdict's hue also colours the name, so a row never
 * mixes two colours. The `:nth-child(even)` companions exist only to out-specify
 * the zebra rule above.
 */
const DeckRow = styled.tr<{ $tone: 'core' | 'dead' | 'half' | null }>`
  ${(p) =>
    p.$tone === 'core'
      ? `td .deck-name { color: var(--brand-soft); }`
      : p.$tone === 'dead'
        ? `
    td, &:nth-child(even) td { background: oklch(0.62 0.21 22 / 8%); }
    &:hover td { background: oklch(0.62 0.21 22 / 13%); }
    td:first-child { box-shadow: inset 1px 0 0 var(--sts-color-red); }
    td.idx, td.dimnum { color: var(--sts-color-red); }
    td.played { color: var(--sts-color-red); }
    td .deck-name { color: var(--sts-color-red); }
  `
        : p.$tone === 'half'
          ? `
    td, &:nth-child(even) td { background: oklch(0.75 0.16 62 / 6%); }
    &:hover td { background: oklch(0.75 0.16 62 / 11%); }
    td .deck-name { color: var(--sts-color-orange); }
  `
          : ''}
`

const CardCell = styled.span`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
`

const CardName = styled.span.attrs({ className: 'deck-name' })`
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 12.5px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
`

const Up = styled.span`
  font-weight: 700;
  margin-left: 1px;
`

const Copies = styled(Num)`
  font-size: 11px;
  color: var(--ink-faint);
`

const RateWrap = styled.span`
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
`

const RateNum = styled(Num)`
  width: 52px;
  text-align: right;
  color: inherit;
`

/** The only bar in the report besides the census strip's four. */
const RateBar = styled.span<{ $pct: number }>`
  position: relative;
  display: block;
  width: 72px;
  height: 3px;
  flex: 0 0 auto;
  border-radius: 2px;
  background: var(--fill);
  overflow: hidden;
  &::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: ${(p) => Math.max(0, Math.min(100, p.$pct))}%;
    border-radius: 2px;
    background: var(--brand);
  }
`

const Verdict = styled.span<{ $kind: 'core' | 'dead' | 'half' }>`
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 8px;
  border-radius: 6px;
  white-space: nowrap;
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: 0.6px;
  line-height: 1;
  ${(p) =>
    p.$kind === 'core'
      ? `background: var(--fill); border: 1px solid var(--brand-deep); color: var(--brand-soft);`
      : p.$kind === 'dead'
        ? `background: var(--sts-color-red); border: 1px solid oklch(0 0 0 / 22%); color: #17140f; font-weight: 600;`
        : `background: transparent; border: 1px solid var(--sts-color-orange); color: var(--sts-color-orange);`}
`
