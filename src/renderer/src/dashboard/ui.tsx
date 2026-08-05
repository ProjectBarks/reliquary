import styled, { keyframes } from 'styled-components'

/**
 * Shared dashboard primitives, in the StS2 companion aesthetic: Kreon headers,
 * cream text, violet brand accent, dark panels with the game's hard offset
 * shadow (deliberate — Slay the Spire's own UI stacks flat offset shadows, and
 * this app is a companion to it).
 *
 * Settings are built from Section/Row rather than a grid of cards. A card grid
 * makes every item look equally important and forces the eye to re-scan each box
 * for its label; a labelled list with one control per row is how settings are
 * actually read, and it absorbs one more setting without a layout decision.
 */

// ── containers ────────────────────────────────────────────────────────────

export const Card = styled.div`
  background: rgba(38, 35, 33, 0.66);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);
`

export const CardTitle = styled.h2`
  font-family: var(--font-display);
  font-size: 19px;
  letter-spacing: 0.5px;
  color: var(--brand);
  margin: 0 0 12px;
  text-shadow: 2px 2px 0 oklch(0 0 0 / 45%);
`

/**
 * A titled group of rows. More space above the heading than below it, so a
 * heading reads as belonging to what follows rather than floating between.
 */
export const Section = styled.section`
  & + & {
    margin-top: 34px;
  }
`

export const SectionHead = styled.div`
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 10px;
  padding: 0 2px;
`

export const SectionTitle = styled.h2`
  font-family: var(--font-display);
  font-size: 17px;
  letter-spacing: 0.6px;
  color: var(--ink);
  margin: 0;
`

export const SectionNote = styled.span`
  font-size: 12px;
  color: var(--ink-faint);
`

/** The panel a section's rows sit in. Rows divide themselves; no nested cards. */
export const Panel = styled.div`
  background: rgba(38, 35, 33, 0.55);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
`

/** Label + description on the left, control on the right. */
export const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 13px 16px;
  min-height: 52px;
  & + & {
    border-top: 1px solid var(--line);
  }
`

export const RowMain = styled.div`
  flex: 1;
  min-width: 0;
`

export const RowLabel = styled.div`
  font-size: 14px;
  color: var(--ink);
  line-height: 1.35;
`

export const RowDesc = styled.div`
  font-size: 12px;
  color: var(--ink-faint);
  line-height: 1.45;
  margin-top: 2px;
`

export const RowAside = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
`

// ── text ──────────────────────────────────────────────────────────────────

export const Hint = styled.p`
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--ink-dim);
`

export const Status = styled.div<{ ok?: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  margin: 4px 0;
  &::before {
    content: '';
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: 0 0 auto;
    background: ${(p) => (p.ok ? 'var(--sts-color-green)' : 'var(--sts-color-red)')};
    box-shadow: 0 0 8px ${(p) => (p.ok ? 'var(--sts-color-green)' : 'transparent')};
  }
`

export const Mono = styled.div`
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink-dim);
  margin: 2px 0;
  &.err {
    color: var(--sts-color-red);
    word-break: break-word;
  }
`

/** A state dot plus label, for inline health readouts. */
export const Pip = styled.span<{ $tone: 'ok' | 'warn' | 'bad' | 'idle' }>`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
  &::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
    background: ${(p) =>
      p.$tone === 'ok'
        ? 'var(--sts-color-green)'
        : p.$tone === 'warn'
          ? 'var(--sts-color-orange)'
          : p.$tone === 'bad'
            ? 'var(--sts-color-red)'
            : 'var(--ink-faint)'};
    box-shadow: ${(p) =>
      p.$tone === 'ok'
        ? '0 0 8px var(--sts-color-green)'
        : p.$tone === 'warn'
          ? '0 0 8px var(--sts-color-orange)'
          : 'none'};
  }
`

// ── controls ──────────────────────────────────────────────────────────────

export const Button = styled.button<{ $primary?: boolean }>`
  cursor: pointer;
  padding: 7px 13px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  color: ${(p) => (p.$primary ? '#1a1613' : 'var(--ink)')};
  background: ${(p) => (p.$primary ? 'var(--brand)' : 'var(--fill)')};
  border: 1px solid ${(p) => (p.$primary ? 'var(--brand)' : 'var(--line-strong)')};
  transition:
    background 0.14s ease,
    border-color 0.14s ease;

  &:hover:not(:disabled) {
    background: ${(p) => (p.$primary ? 'var(--brand-soft)' : 'var(--fill-hover)')};
    border-color: ${(p) => (p.$primary ? 'var(--brand-soft)' : 'oklch(1 0 0 / 24%)')};
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
`

/**
 * A real switch rather than a checkbox: it reads as on/off at a glance and from
 * a distance, which is how these actually get used — mid-run, at arm's length.
 */
export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}): JSX.Element {
  return (
    <SwitchTrack
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      $on={checked}
      onClick={() => onChange(!checked)}
    >
      <SwitchThumb $on={checked} />
    </SwitchTrack>
  )
}

const SwitchTrack = styled.button<{ $on: boolean }>`
  position: relative;
  cursor: pointer;
  width: 42px;
  height: 24px;
  flex: 0 0 auto;
  padding: 0;
  border-radius: 12px;
  background: ${(p) => (p.$on ? 'var(--brand)' : 'oklch(1 0 0 / 10%)')};
  border: 1px solid ${(p) => (p.$on ? 'var(--brand)' : 'var(--line-strong)')};
  transition:
    background 0.18s ease,
    border-color 0.18s ease;
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

const SwitchThumb = styled.span<{ $on: boolean }>`
  position: absolute;
  top: 50%;
  left: ${(p) => (p.$on ? '20px' : '2px')};
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: ${(p) => (p.$on ? '#1a1613' : 'var(--ink-dim)')};
  /* Exponential ease-out from an already-visible default. */
  transition: left 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  transform: translateY(-50%);
`

// ── disclosure ────────────────────────────────────────────────────────────

const reveal = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: none; }
`

export const DisclosureBody = styled.div`
  animation: ${reveal} 0.26s cubic-bezier(0.16, 1, 0.3, 1);
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

export const DisclosureButton = styled.button<{ $open: boolean }>`
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  cursor: pointer;
  padding: 12px 16px;
  border: 0;
  background: none;
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.4px;
  color: ${(p) => (p.$open ? 'var(--ink)' : 'var(--ink-dim)')};
  text-align: left;
  transition: color 0.14s ease;
  &:hover {
    color: var(--ink);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }
  svg {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
    stroke: currentColor;
    stroke-width: 2.2;
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
    transform: rotate(${(p) => (p.$open ? '90deg' : '0deg')});
    transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  }
`

/** The one chevron every disclosure uses, so the icon language stays single. */
export function Chevron(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M6 3.5 L10.5 8 L6 12.5" />
    </svg>
  )
}
