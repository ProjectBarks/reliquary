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
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 0 0 10px;
  padding: 0 2px;

  /* A rule running out from the head, fading like the game's parchment
     dividers — it ties title and note into one line and gives each section
     a beginning without adding chrome. */
  &::after {
    content: '';
    flex: 1 1 24px;
    align-self: center;
    height: 1px;
    margin-left: 4px;
    background: linear-gradient(to right, var(--line-strong), transparent);
  }
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

/**
 * Label + description on the left, control on the right.
 *
 * Below ~480px the two columns stop fitting and the description starts
 * crowding the control. Rather than shrinking the switch — the primary
 * affordance, and the one that has to stay easy to hit — the row stacks and the
 * control moves under its own label.
 */
export const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 13px 16px;
  min-height: 52px;
  & + & {
    border-top: 1px solid var(--line);
  }

  @media (max-width: 480px) {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 14px;
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

  @media (max-width: 480px) {
    justify-content: flex-start;
  }
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

const pipTone = (t: 'ok' | 'warn' | 'bad' | 'idle'): string =>
  t === 'ok' ? 'var(--gem-ok)' : t === 'warn' ? 'var(--gem-wait)' : t === 'bad' ? 'var(--gem-bad)' : 'var(--gem-off)'

/**
 * A state gem plus label, for inline health readouts. The mark is a small
 * faceted relic gem — the same stones that orbit the spire on Home, held
 * still — so health reads in one vocabulary everywhere in the app.
 */
export const Pip = styled.span<{ $tone: 'ok' | 'warn' | 'bad' | 'idle' }>`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
  &::before {
    content: '';
    width: 10px;
    height: 13px;
    flex: 0 0 auto;
    /* Elongated hexagonal cut, lit from the upper left like the scene gems. */
    clip-path: polygon(50% 0%, 92% 27%, 76% 78%, 50% 100%, 24% 78%, 8% 27%);
    background:
      linear-gradient(155deg, oklch(1 0 0 / 85%) 0%, transparent 34%),
      linear-gradient(335deg, oklch(0 0 0 / 45%) 8%, transparent 46%),
      ${(p) => pipTone(p.$tone)};
    filter: ${(p) =>
      p.$tone === 'idle' ? 'none' : `drop-shadow(0 0 5px ${pipTone(p.$tone)})`};
    opacity: ${(p) => (p.$tone === 'idle' ? 0.6 : 1)};
  }
`

// ── controls ──────────────────────────────────────────────────────────────

export const Button = styled.button<{ $primary?: boolean }>`
  cursor: pointer;
  height: 34px;
  padding: 0 13px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  color: ${(p) => (p.$primary ? '#1a1613' : 'var(--ink)')};
  background: ${(p) => (p.$primary ? 'var(--brand)' : 'var(--fill)')};
  border: 1px solid ${(p) => (p.$primary ? 'var(--brand)' : 'var(--line-strong)')};
  display: inline-flex;
  align-items: center;
  gap: 7px;
  transition:
    background 0.14s ease,
    border-color 0.14s ease,
    transform 0.1s cubic-bezier(0.16, 1, 0.3, 1);

  &:active:not(:disabled) {
    transform: translateY(1px);
  }
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
 * Native select dressed as the shared Button — same 34px height, padding,
 * border, radius and type — so a picker can sit inline beside action buttons
 * and read as one row of controls. The option list is explicitly dark so the
 * UA dropdown stays legible against the app's night surfaces.
 */
export const Select = styled.select`
  cursor: pointer;
  height: 34px;
  padding: 0 30px 0 13px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  color: var(--ink);
  background-color: var(--fill);
  border: 1px solid var(--line-strong);
  appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23fff6e2' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 11px center;
  transition:
    background-color 0.14s ease,
    border-color 0.14s ease;

  &:hover:not(:disabled) {
    background-color: var(--fill-hover);
    border-color: oklch(1 0 0 / 24%);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  &:disabled {
    opacity: 0.45;
    cursor: default;
  }

  option {
    font-weight: 400;
    color: var(--ink);
    background: #1d1a2e;
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

// ── waiting ───────────────────────────────────────────────────────────────

const orbit = keyframes`
  to { transform: rotate(360deg); }
`
const counter = keyframes`
  to { transform: rotate(-360deg); }
`
const charge = keyframes`
  0%, 100% { opacity: 0.35; }
  50%      { opacity: 1; }
`

/**
 * The app's waiting state, drawn as its own mark rather than a borrowed ring.
 *
 * Reliquary is a relic orb; when it is fetching something it spins up — outer
 * facet one way, inner the other, core pulsing — and settles when it isn't.
 * Using the identity as the indicator means one motion idea covers every
 * network wait in the app instead of a spinner that could belong to anything.
 *
 * Rotation only, so it composites on one layer and costs nothing to loop.
 */
export function Spinner({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <SpinnerSvg viewBox="0 0 24 24" $size={size} role="presentation" aria-hidden>
      <g className="outer">
        <path d="M12 2.5 L20 7 L20 17 L12 21.5 L4 17 L4 7 Z" />
      </g>
      <g className="inner">
        <path d="M12 7 L16.2 9.6 L16.2 14.4 L12 17 L7.8 14.4 L7.8 9.6 Z" />
      </g>
      <circle className="core" cx="12" cy="12" r="2.4" />
    </SpinnerSvg>
  )
}

const SpinnerSvg = styled.svg<{ $size: number }>`
  width: ${(p) => p.$size}px;
  height: ${(p) => p.$size}px;
  flex: 0 0 auto;
  overflow: visible;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;

  g {
    transform-origin: 50% 50%;
  }
  .outer {
    animation: ${orbit} 2.4s linear infinite;
  }
  .inner {
    opacity: 0.55;
    stroke-width: 1.2;
    animation: ${counter} 1.6s linear infinite;
  }
  .core {
    fill: currentColor;
    stroke: none;
    animation: ${charge} 1.4s ease-in-out infinite;
  }

  /* A loop is the one thing that must stop when motion is unwelcome; the shape
     alone still reads as "busy" beside its label. */
  @media (prefers-reduced-motion: reduce) {
    .outer,
    .inner,
    .core {
      animation: none;
    }
  }
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
