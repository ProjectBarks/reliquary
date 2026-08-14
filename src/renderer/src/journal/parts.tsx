import { useState, type ReactNode } from 'react'
import styled, { css, keyframes } from 'styled-components'
import type { ResolvedEntity } from './art'

/**
 * The Journal's primitives — the shapes the blend mockup invented that the
 * Codex never needed.
 *
 * What is *not* here matters as much as what is. Sections, panels, buttons,
 * selects, the spinner, the three states (loading, empty, broken), the
 * scrollbar rule, popovers and the sub-nav anchor all come from
 * `dashboard/ui.tsx` and `codex/parts.tsx` unchanged — the Journal is a sibling
 * tab, and a second visual dialect inside one window is exactly the failure the
 * mockup's "volume down" rule was written against.
 *
 * What is here is a ledger's vocabulary: dense table shells, hairline stat
 * grids, a character-tinted run plaque, a result plate, outline chips whose
 * colour is *data* rather than emphasis, and art cells that survive a CDN miss
 * without changing size. Every one of them is lifted from `journal-blend.html`
 * with its geometry intact, translated from scoped CSS into styled-components.
 */

// ── text ────────────────────────────────────────────────────────────────────

/** The mono aside that carries every honesty note in the tab. */
export const Whisper = styled.div`
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  letter-spacing: 0.2px;
  color: var(--ink-faint);
  b {
    color: var(--ink-dim);
    font-weight: 400;
  }
`

export const Num = styled.span`
  font-variant-numeric: tabular-nums;
`

// ── chips ───────────────────────────────────────────────────────────────────

/**
 * The outline chip: a 1px border, caps, and the *data's* colour rather than an
 * accent. Room types, cohort badges and evidence all use it, which is why it
 * takes a tone instead of owning one.
 */
export const OutlineChip = styled.span<{ $tone?: string | null }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
  border-radius: 6px;
  white-space: nowrap;
  font-family: var(--font-body);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  line-height: 1.7;
  color: ${(p) => p.$tone ?? 'var(--ink-dim)'};
  border: 1px solid
    ${(p) =>
      p.$tone ? `color-mix(in oklab, ${p.$tone} 42%, transparent)` : 'var(--line-strong)'};
`

/**
 * The solid plate, reserved for verdicts: grades, severities, outcomes. Dark
 * text on a filled colour, the way the game stamps a letter on a result screen
 * — an outline says "a fact about this row", a plate says "a judgement".
 */
export const Plate = styled.span<{ $bg: string }>`
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 6px;
  white-space: nowrap;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  line-height: 1;
  color: #17140f;
  background: ${(p) => p.$bg};
  border: 1px solid oklch(0 0 0 / 22%);
`

/** A finding reference. Red outline, red text, never filled. */
export const Flag = styled.span`
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 6px;
  white-space: nowrap;
  border: 1px solid color-mix(in oklab, var(--sts-color-red) 55%, transparent);
  color: var(--sts-color-red);
  background: transparent;
  font-family: var(--font-body);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.7px;
  line-height: 1.8;
`

// ── art ─────────────────────────────────────────────────────────────────────

/**
 * Art with its own fallback.
 *
 * Every image in this tab points at a CDN the app does not control, for an id
 * that may be modded, renamed, or simply too new — so a miss is a normal event,
 * not an exception. The plate that replaces a failed image occupies the *exact*
 * same box, which is the whole point: a ledger whose rows change height when
 * three of nineteen renders 404 is a ledger nobody can read.
 *
 * React's `onError` rather than an inline `onerror` attribute, because the
 * fallback is a rendered state and not a DOM mutation — but the guarantee the
 * mockup's `onerror=` gave is identical, and it is honoured on every img in
 * the tab.
 */
export function Art({
  entity,
  variant,
  alt,
  edge = null
}: {
  entity: ResolvedEntity
  /** `sprite` = 18px row art, `render` = deck cell, `big` = a finding's slot. */
  variant: 'sprite' | 'render' | 'big'
  alt?: string
  /**
   * A finding slot's treatment: `passed` gets the green edge of the card that
   * was not taken; `stock` is the dimmed, dashed card that stayed on the shelf.
   */
  edge?: 'passed' | 'stock' | null
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  const src = variant === 'sprite' ? entity.sprite : entity.render
  const missing = failed || !src

  if (variant === 'sprite') {
    return (
      <SpriteBox $missing={missing} aria-hidden={!alt}>
        {missing ? (
          <PlateText>{entity.initials}</PlateText>
        ) : (
          <img src={src} alt={alt ?? ''} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        )}
      </SpriteBox>
    )
  }
  if (variant === 'render') {
    return (
      <RenderBox $missing={missing} aria-hidden={!alt}>
        {missing ? (
          <PlateText>{entity.initials}</PlateText>
        ) : (
          <img src={src} alt={alt ?? ''} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        )}
      </RenderBox>
    )
  }
  return (
    <BigBox $missing={missing} $edge={edge}>
      {missing ? (
        <BigPlateText>{entity.name}</BigPlateText>
      ) : (
        <img
          src={src}
          alt={alt ?? entity.name}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </BigBox>
  )
}

const artImg = css`
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    -webkit-user-drag: none;
  }
`

const SpriteBox = styled.span<{ $missing: boolean }>`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  overflow: hidden;
  border-radius: 4px;
  vertical-align: middle;
  background: var(--fill);
  border: 1px solid var(--line);
  ${artImg}
`

/**
 * The deck ledger's card cell: a bare 34×44 full render (the 400:520 aspect of
 * the real art) with no container of its own — the card carries its own frame,
 * and a second one around it turned the table into a gallery. The fixed box
 * means the miss state holds an identical footprint.
 */
const RenderBox = styled.span<{ $missing: boolean }>`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 34px;
  height: 44px;
  overflow: hidden;
  vertical-align: middle;
  background: ${(p) => (p.$missing ? 'var(--fill)' : 'transparent')};
  border: ${(p) => (p.$missing ? '1px solid var(--line)' : '0')};
  border-radius: ${(p) => (p.$missing ? '4px' : '0')};
  ${artImg}
`

const BigBox = styled.span<{ $missing: boolean; $edge: 'passed' | 'stock' | null }>`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 110px;
  height: 152px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--fill);
  border: 1px solid
    ${(p) =>
      p.$edge === 'passed'
        ? 'oklch(0.87 0.25 128 / 45%)'
        : p.$edge === 'stock'
          ? 'var(--line-strong)'
          : 'var(--line)'};
  border-style: ${(p) => (p.$edge === 'stock' ? 'dashed' : 'solid')};
  ${artImg}

  ${(p) =>
    p.$edge === 'stock'
      ? `
    img { opacity: 0.26; filter: grayscale(0.6); }
    /* A darkening layer so the plate over it reads cleanly. */
    &::after {
      content: '';
      position: absolute;
      inset: 0;
      background: oklch(0 0 0 / 45%);
    }
  `
      : ''}
`

const PlateText = styled.span`
  font-family: var(--font-display);
  font-size: 10.5px;
  letter-spacing: 0.3px;
  line-height: 1;
  color: var(--ink-dim);
`

const BigPlateText = styled.span`
  padding: 0 8px;
  text-align: center;
  line-height: 1.25;
  font-family: var(--font-display);
  font-size: 12px;
  letter-spacing: 0.4px;
  color: var(--ink-dim);
`

// ── tables ──────────────────────────────────────────────────────────────────

/** The rounded, hairlined box every ledger sits in. */
export const TBox = styled.div`
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(38, 35, 33, 0.55);
  overflow: hidden;
`

export const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;

  thead th {
    padding: 8px 12px;
    text-align: left;
    font-family: var(--font-body);
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 0.9px;
    text-transform: uppercase;
    color: var(--ink-dim);
    background: #221f1d;
    border-bottom: 1px solid var(--line-strong);
    white-space: nowrap;
  }
  thead th.r {
    text-align: right;
  }
  tbody td {
    padding: 6px 12px;
    border-top: 1px solid var(--line);
    color: var(--ink);
    vertical-align: middle;
  }
  tbody td.r {
    text-align: right;
  }
  tbody td.dim {
    color: var(--ink-faint);
  }
  tbody tr:hover td {
    background: var(--fill-hover);
  }
  tfoot td {
    padding: 8px 12px;
    border-top: 1px solid var(--line-strong);
    background: #1d1a18;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-dim);
    white-space: nowrap;
  }
  tfoot td.r {
    text-align: right;
  }
  tfoot td.total {
    color: var(--ink);
  }
`

// ── hairline stat grids ─────────────────────────────────────────────────────

/**
 * The construction behind the census strip, the combat piles and the review
 * summary: cells on a 1px `--line` background so the gaps *are* the rules. One
 * idea, three uses, no three-different-borders drift.
 */
export const CellGrid = styled.div<{ $min?: string }>`
  display: grid;
  grid-template-columns: ${(p) => `repeat(auto-fit, minmax(${p.$min ?? '130px'}, 1fr))`};
  gap: 1px;
  background: var(--line);
  border-radius: 11px;
  overflow: hidden;
`

export const GridCell = styled.div`
  background: #1e1b18;
  padding: 11px 14px 12px;
  min-width: 0;
`

export const CellKey = styled.div`
  font-size: 9px;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  color: var(--ink-faint);
`

export const CellValue = styled.div<{ $tone?: string | null }>`
  font-family: var(--font-display);
  font-size: 21px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: ${(p) => p.$tone ?? 'var(--ink)'};
`

/** The census cell's bar. The deck ledger's rate bar is the only other one. */
export const CensusBar = styled.span<{ $pct: number; $tone: string }>`
  display: block;
  height: 5px;
  margin-top: 7px;
  border-radius: 3px;
  background: var(--fill);
  overflow: hidden;
  &::after {
    content: '';
    display: block;
    height: 100%;
    width: ${(p) => Math.max(0, Math.min(100, p.$pct))}%;
    border-radius: 3px;
    background: ${(p) => p.$tone};
  }
`

// ── the run plaque ──────────────────────────────────────────────────────────

/**
 * The run header: a panel with a character-tinted edge down its left side, the
 * title and manifest on the left, the result plate on the right, and a row of
 * stat cells beneath.
 *
 * The tint is the run's character, taken from `overlay.css`'s frame palette, so
 * an Ironclad report and a Silent report are distinguishable at a glance and in
 * the same vocabulary the in-game overlays already speak.
 */
export const RunHead = styled.div<{ $frame: string; $edge: string }>`
  position: relative;
  padding: 16px 18px 17px 20px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(38, 35, 33, 0.66);

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: linear-gradient(
      to bottom,
      ${(p) => p.$edge},
      ${(p) => p.$frame} 70%,
      transparent
    );
  }
`

export const RunHeadTop = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 18px;
  flex-wrap: wrap;
`

export const RunTitle = styled.div`
  flex: 1 1 360px;
  min-width: 0;

  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 500;
    font-size: 24px;
    letter-spacing: 0.7px;
    line-height: 1.1;
    color: var(--ink);
  }
  h1 em {
    font-style: normal;
  }
  ${Whisper} {
    margin-top: 6px;
    word-break: break-word;
  }
`

const BANNER_TONE = {
  red: { bg: 'oklch(0.62 0.21 22 / 16%)', line: 'oklch(0.62 0.21 22 / 38%)', ink: 'var(--sts-color-red)' },
  green: { bg: 'oklch(0.86 0.24 130 / 8%)', line: 'oklch(0.86 0.24 130 / 34%)', ink: 'var(--sts-color-green)' },
  gold: { bg: 'oklch(0.85 0.16 86 / 8%)', line: 'oklch(0.85 0.16 86 / 32%)', ink: 'var(--sts-color-gold)' },
  aqua: { bg: 'oklch(0.79 0.14 180 / 8%)', line: 'oklch(0.79 0.14 180 / 34%)', ink: 'var(--sts-color-aqua)' }
} as const

export type BannerTone = keyof typeof BANNER_TONE

/** The result plate: DEFEATED / VICTORIOUS / ENDED / IN COMBAT. */
export const Banner = styled.div<{ $tone: BannerTone }>`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 9px 15px;
  border-radius: 10px;
  background: ${(p) => BANNER_TONE[p.$tone].bg};
  border: 1px solid ${(p) => BANNER_TONE[p.$tone].line};
  box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);

  .word {
    font-family: var(--font-display);
    font-size: ${(p) => (p.$tone === 'aqua' ? '17px' : '24px')};
    letter-spacing: ${(p) => (p.$tone === 'aqua' ? '1.2px' : '1.8px')};
    line-height: 1;
    color: ${(p) => BANNER_TONE[p.$tone].ink};
    text-shadow: 2px 2px 0 oklch(0 0 0 / 45%);
  }
  .sub {
    font-size: 11px;
    line-height: 1.45;
    color: var(--ink-dim);
  }
  .sub b {
    color: var(--ink);
    font-weight: 600;
  }
`

const breathe = keyframes`
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
`

/** The LIVE marker. It is the only thing in the tab that moves on its own. */
export const LiveChip = styled.span`
  padding: 1px 8px;
  border-radius: 6px;
  border: 1px solid color-mix(in oklab, var(--sts-color-aqua) 55%, transparent);
  color: var(--sts-color-aqua);
  font-family: var(--font-body);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.9px;
  animation: ${breathe} 2.6s ease-in-out infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

/**
 * Six cells, one row.
 *
 * `auto-fit` was the obvious choice and the wrong one: the cells' content sets
 * their intrinsic minimum, so at the dashboard's real width the sixth cell
 * wrapped onto a line of its own and left a hole where a plaque should be. Six
 * fixed `minmax(0, 1fr)` columns cannot do that — the `0` lets a cell shrink
 * below its content, and the whisper line ellipses instead of pushing.
 */
export const Plaque = styled.div<{ $frame: string }>`
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  overflow: hidden;
  background: ${(p) => `color-mix(in oklab, ${p.$frame} 14%, oklch(0 0 0 / 24%))`};

  @media (max-width: 780px) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
`

export const PCell = styled.div`
  padding: 10px 14px 11px;
  border-right: 1px solid var(--line);
  min-width: 0;
  &:last-child {
    border-right: 0;
  }

  .k {
    font-size: 9.5px;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .v {
    margin-top: 1px;
    font-family: var(--font-display);
    font-size: 22px;
    line-height: 1.18;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .v small {
    font-size: 12px;
    color: var(--ink-dim);
  }
  .w {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`

/** The character cell's value takes the run's tint; every other cell is ink. */
export const CharValue = styled.div<{ $edge: string }>`
  margin-top: 1px;
  font-family: var(--font-display);
  font-size: 19px;
  line-height: 1.18;
  letter-spacing: 0.8px;
  color: ${(p) => p.$edge};
  white-space: nowrap;
`

// ── misc ────────────────────────────────────────────────────────────────────

/** Two panels side by side, stacking when the window gets narrow. */
export const Duo = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
  @media (max-width: 1060px) {
    grid-template-columns: minmax(0, 1fr);
  }
`

/** A quiet inline note, for the one-line states a section shows instead of data. */
export const Note = styled.p`
  margin: 14px 2px;
  font-size: 13px;
  font-style: italic;
  color: var(--ink-faint);
`

/**
 * The empty state for a whole view, as opposed to `Note`'s empty state for one
 * section of one.
 *
 * The distinction is worth a component. "No rooms entered yet this run" is an
 * aside inside a screen that is otherwise full, and an italic line is the right
 * weight for it. "You have never finished a run" is the *entire* screen, and an
 * italic line there reads as a page that failed to load — the reader cannot tell
 * an empty archive from a broken one.
 *
 * So this states three things in a deliberate frame: what is not there, what
 * will put it there, and — where one exists — somewhere to go instead. The
 * dashed border is doing the load-bearing work: it reads as a space reserved for
 * content rather than as a container that came up short.
 */
export const EmptyPlate = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 22px 20px;
  border-radius: 12px;
  border: 1px dashed var(--line-strong);
  background: oklch(1 0 0 / 2%);

  strong {
    font-family: var(--font-display);
    font-weight: 500;
    font-size: 17px;
    letter-spacing: 0.5px;
    color: var(--ink);
  }
  span {
    font-size: 13px;
    line-height: 1.55;
    color: var(--ink-faint);
    max-width: 62ch;
  }
`

export function SectionAside({ children }: { children: ReactNode }): JSX.Element {
  return <Whisper as="span">{children}</Whisper>
}
