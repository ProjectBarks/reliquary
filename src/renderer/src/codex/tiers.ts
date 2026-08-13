import styled from 'styled-components'

/**
 * The letter-grade scale, in one place.
 *
 * These colours were already in the codebase — the overlay's stat tips have
 * graded cards A–F since the first release — and the Codex has to grade the
 * same cards with the same palette, or the tab and the in-game tip would
 * disagree about what a "B" looks like. `StatPanels.tsx` imports from here now;
 * this module is the single source.
 *
 * The thresholds are the Spire Codex ones, kept verbatim so a tier list here
 * groups a card exactly where the community site groups it.
 */

/** Letter-grade palette: A best (green) → F worst (red). Handles "A", "A+", "S". */
export const TIER_COLORS: Record<string, string> = {
  S: '#7fff00',
  A: '#7fff00',
  B: '#2aebbe',
  C: '#efc851',
  D: '#ffa518',
  E: '#ff5555',
  F: '#ff5555'
}

/** Colour for a grade string, tolerant of "A+", " b ", and unknown values. */
export function tierColor(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return TIER_COLORS[value.trim().charAt(0).toUpperCase()]
}

export interface TierDef {
  /** The letter shown on the badge. */
  key: string
  /** Inclusive lower bound on the Codex Score. */
  min: number
  /** The plain-English gloss under the letter — a grade nobody can read is décor. */
  label: string
}

/**
 * S..F, best first. `F` has no floor: everything that scored at all lands
 * somewhere, and anything that didn't score is deliberately left out rather
 * than swept into the bottom tier, which would read as a judgement we haven't
 * got the data to make.
 */
export const TIER_DEFS: TierDef[] = [
  { key: 'S', min: 90, label: 'Top tier' },
  { key: 'A', min: 78, label: 'Strong' },
  { key: 'B', min: 65, label: 'Solid' },
  { key: 'C', min: 50, label: 'Average' },
  { key: 'D', min: 35, label: 'Weak' },
  { key: 'F', min: Number.NEGATIVE_INFINITY, label: 'Avoid' }
]

/** Which grade a score earns, or null when there is no score to grade. */
export function tierForScore(score: number | null | undefined): string | null {
  if (score == null || !Number.isFinite(score)) return null
  return (TIER_DEFS.find((t) => score >= t.min) ?? TIER_DEFS[TIER_DEFS.length - 1]).key
}

export function tierDef(key: string | null | undefined): TierDef | undefined {
  if (!key) return undefined
  const letter = key.trim().charAt(0).toUpperCase()
  return TIER_DEFS.find((t) => t.key === letter)
}

/** The gloss for a grade ("Solid"), or an empty string for an unknown one. */
export function tierLabel(key: string | null | undefined): string {
  return tierDef(key)?.label ?? ''
}

/**
 * A grade, as a solid chip with dark text — the way the game itself stamps a
 * letter on a result screen. Solid rather than tinted-outline because these sit
 * on top of card art, where an outline would be swallowed by whatever is behind
 * it, and because a grade is a verdict: it should look decided.
 *
 * Ungraded chips fall back to the quiet fill, so a `·` badge still occupies its
 * slot and a grid doesn't reflow when metrics land.
 */
export const TierBadge = styled.span<{ $tier?: string | null; $size?: 'sm' | 'md' | 'lg' }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-family: var(--font-display);
  font-weight: 600;
  line-height: 1;
  border-radius: 6px;
  min-width: ${(p) => (p.$size === 'lg' ? '34px' : p.$size === 'md' ? '26px' : '22px')};
  height: ${(p) => (p.$size === 'lg' ? '34px' : p.$size === 'md' ? '26px' : '20px')};
  padding: 0 ${(p) => (p.$size === 'lg' ? '9px' : '6px')};
  font-size: ${(p) => (p.$size === 'lg' ? '20px' : p.$size === 'md' ? '15px' : '12px')};
  letter-spacing: 0.4px;
  background: ${(p) => tierColor(p.$tier) ?? 'var(--fill)'};
  color: ${(p) => (tierColor(p.$tier) ? '#17140f' : 'var(--ink-faint)')};
  border: 1px solid ${(p) => (tierColor(p.$tier) ? 'oklch(0 0 0 / 22%)' : 'var(--line)')};
  text-shadow: none;
`
