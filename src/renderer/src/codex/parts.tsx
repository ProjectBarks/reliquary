import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import styled, { css, keyframes } from 'styled-components'
import { Button, Panel, Spinner } from '../dashboard/ui'

/**
 * The Codex's own small set of primitives, built on top of the dashboard's.
 *
 * Nothing here invents a look. `Section / Panel / Row`, `Button`, `Select` and
 * `Spinner` still come from `dashboard/ui.tsx`; these are the shapes a database
 * screen needs that a settings screen never did — a toolbar, a segmented
 * control, art tiles, a modal, and the three states (waiting, empty, broken)
 * that every one of these views has to be able to be in.
 *
 * The states are the point. A compendium spends real time loading, is regularly
 * empty because someone filtered everything out, and talks to a community API
 * that will one day be down. Designing those three moments is not polish here;
 * it is most of the screen's life.
 */

// ── scrollbars ──────────────────────────────────────────────────────────────

/**
 * The app's scrollbar, for every box in the Codex that scrolls.
 *
 * The tab has five of them — the page body, the list column, the reading pane,
 * the metrics table, the pinned rail — and they were drifting apart by a pixel
 * each. One rule, matching `Shell`'s: 9px, an oklch thumb at 16%, 4px radius.
 * Two visibly different scrollbars on one screen is the kind of detail nobody
 * reports and everybody feels.
 */
export const scrollbar = css`
  &::-webkit-scrollbar {
    width: 9px;
    height: 9px;
  }
  &::-webkit-scrollbar-thumb {
    background: oklch(1 0 0 / 16%);
    border-radius: 4px;
  }
`

// ── toolbar ─────────────────────────────────────────────────────────────────

export const Toolbar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 10px 2px 12px;
`

export const ToolbarGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

export const Spacer = styled.div`
  flex: 1 1 auto;
`

/**
 * The search field, with its keyboard shortcut printed on it. A shortcut that
 * only exists in documentation is a shortcut nobody uses; the `/` key cap sits
 * in the field until you focus it, then gets out of the way.
 */
export const SearchWrap = styled.div`
  position: relative;
  flex: 1 1 200px;
  min-width: 160px;
  max-width: 340px;
  display: flex;
  align-items: center;
`

export const SearchInput = styled.input`
  width: 100%;
  height: 34px;
  padding: 0 34px 0 32px;
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  color: var(--ink);
  background: var(--fill);
  border: 1px solid var(--line-strong);
  transition:
    background 0.14s ease,
    border-color 0.14s ease;

  &::placeholder {
    color: var(--ink-faint);
  }
  &:hover {
    background: var(--fill-hover);
  }
  &:focus-visible,
  &:focus {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    background: var(--fill-hover);
  }
`

export const SearchIcon = styled.svg`
  position: absolute;
  left: 10px;
  width: 14px;
  height: 14px;
  pointer-events: none;
  fill: none;
  stroke: var(--ink-faint);
  stroke-width: 1.7;
  stroke-linecap: round;
`

/** The `/` key cap, and the ✕ that replaces it once there is something to clear. */
export const SearchAffordance = styled.button`
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  cursor: pointer;
  border-radius: 5px;
  border: 1px solid var(--line-strong);
  background: var(--fill);
  color: var(--ink-faint);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  &:hover {
    color: var(--ink);
    background: var(--fill-hover);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }
  &:disabled {
    cursor: default;
    opacity: 0.75;
  }
`

// ── segmented control ───────────────────────────────────────────────────────

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
}

/**
 * Two to four mutually exclusive choices, shown all at once.
 *
 * A `Select` hides its alternatives behind a click, which is right for ten
 * cohorts and wrong for "grid or list" — when the options are few and the
 * switch is frequent, showing them costs one row and saves every interaction.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
  label: string
}): JSX.Element {
  return (
    <SegmentedGroup role="group" aria-label={label}>
      {options.map((o) => (
        <SegmentButton
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={o.value === value}
          $on={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </SegmentButton>
      ))}
    </SegmentedGroup>
  )
}

const SegmentedGroup = styled.div`
  display: inline-flex;
  flex: 0 0 auto;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--fill);
  overflow: hidden;
`

const SegmentButton = styled.button<{ $on: boolean }>`
  cursor: pointer;
  height: 32px;
  padding: 0 11px;
  border: 0;
  border-right: 1px solid var(--line);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: ${(p) => (p.$on ? '#1a1613' : 'var(--ink-dim)')};
  background: ${(p) => (p.$on ? 'var(--brand)' : 'transparent')};
  transition:
    background 0.13s ease,
    color 0.13s ease;
  &:last-child {
    border-right: 0;
  }
  &:hover {
    background: ${(p) => (p.$on ? 'var(--brand)' : 'var(--fill-hover)')};
    color: ${(p) => (p.$on ? '#1a1613' : 'var(--ink)')};
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }
`

// ── icon controls ───────────────────────────────────────────────────────────

/**
 * The toolbar's icons, drawn rather than typed.
 *
 * An emoji or a box-drawing glyph would have been two characters of code, and
 * would have rendered at whatever size, weight and vertical offset the font
 * happened to choose — different on every machine, never quite aligned with the
 * 34px controls beside it. These are the same 1.4px-stroke line drawings as the
 * titlebar's window controls, so the tab has one icon language.
 */
const Icon = styled.svg`
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
`

/** Four tiles: the art grid. */
export function GridIcon(): JSX.Element {
  return (
    <Icon viewBox="0 0 16 16" aria-hidden>
      <rect x="2.2" y="2.2" width="5.2" height="5.2" rx="1.1" />
      <rect x="8.6" y="2.2" width="5.2" height="5.2" rx="1.1" />
      <rect x="2.2" y="8.6" width="5.2" height="5.2" rx="1.1" />
      <rect x="8.6" y="8.6" width="5.2" height="5.2" rx="1.1" />
    </Icon>
  )
}

/** Thumb-and-line rows: the list with its reading pane. */
export function ListIcon(): JSX.Element {
  return (
    <Icon viewBox="0 0 16 16" aria-hidden>
      <rect x="2.2" y="3" width="3.4" height="3.4" rx="0.9" />
      <rect x="2.2" y="9.6" width="3.4" height="3.4" rx="0.9" />
      <path d="M7.4 4.7h6.4M7.4 11.3h6.4" />
    </Icon>
  )
}

/** A podium, tallest in the middle: the tier list. */
export function TierIcon(): JSX.Element {
  return (
    <Icon viewBox="0 0 16 16" aria-hidden>
      <rect x="1.8" y="7.4" width="3.6" height="5.8" rx="0.9" />
      <rect x="6.2" y="3.4" width="3.6" height="9.8" rx="0.9" />
      <rect x="10.6" y="9.2" width="3.6" height="4" rx="0.9" />
    </Icon>
  )
}

/** Ruled rows and a column: the metrics table. */
export function TableIcon(): JSX.Element {
  return (
    <Icon viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="2.6" width="12" height="10.8" rx="1.4" />
      <path d="M2 6.2h12M2 9.8h12M6.6 6.2v7.2" />
    </Icon>
  )
}

/** Two arrows pointing apart: choose an order. */
export function SortIcon(): JSX.Element {
  return (
    <Icon viewBox="0 0 16 16" aria-hidden>
      <path d="M4.6 13.2V2.9M2.3 5.2 4.6 2.9l2.3 2.3" />
      <path d="M11.4 2.8v10.3M9.1 10.8l2.3 2.3 2.3-2.3" />
    </Icon>
  )
}

/** A funnel: narrow what is shown. */
export function FilterIcon(): JSX.Element {
  return (
    <Icon viewBox="0 0 16 16" aria-hidden>
      <path d="M2.4 3.1h11.2L9.3 8.3v4.4l-2.6 1.3V8.3z" />
    </Icon>
  )
}

export interface IconSegmentedOption<T extends string> {
  value: T
  icon: ReactNode
  /** Both the accessible name and the tooltip — an icon has no text of its own. */
  label: string
}

/**
 * The segmented control, icon-only.
 *
 * Same group and same brand-filled active state as the labelled one; the
 * difference is that each segment is a square and its name is spoken rather
 * than printed. Four modes with words on them would have been half the toolbar.
 */
export function IconSegmented<T extends string>({
  options,
  value,
  onChange,
  label
}: {
  options: readonly IconSegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
  label: string
}): JSX.Element {
  return (
    <SegmentedGroup role="group" aria-label={label}>
      {options.map((o) => (
        <IconSegment
          key={o.value}
          type="button"
          aria-label={o.label}
          title={o.label}
          aria-pressed={o.value === value}
          $on={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
        </IconSegment>
      ))}
    </SegmentedGroup>
  )
}

/**
 * A square button carrying one icon, exactly as tall as `Button` and `Select`.
 *
 * That number — 34px — is the whole reason this exists. The toolbar's misery
 * was controls of three different heights on three different baselines; every
 * control in it now resolves to the same 34, so the row is aligned by
 * construction rather than by nudging.
 */
export const IconButton = styled.button<{ $on?: boolean }>`
  position: relative;
  cursor: pointer;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 8px;
  border: 1px solid ${(p) => (p.$on ? 'var(--brand)' : 'var(--line-strong)')};
  background: ${(p) => (p.$on ? 'var(--fill-hover)' : 'var(--fill)')};
  color: ${(p) => (p.$on ? 'var(--ink)' : 'var(--ink-dim)')};
  transition:
    background 0.14s ease,
    border-color 0.14s ease,
    color 0.14s ease;
  &:hover {
    background: var(--fill-hover);
    color: var(--ink);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

const IconSegment = styled(SegmentButton)`
  width: 34px;
  padding: 0;
  justify-content: center;
`

/**
 * The mark on a control whose popover is holding something: a count when there
 * is one to give, a dot when "not the default" is the whole message.
 *
 * It sits on the button's corner rather than beside it so the row's geometry
 * does not change when a filter is applied — the alternative moves every
 * control to its right by 18px the moment somebody picks a rarity.
 */
const TriggerBadge = styled.span<{ $dot: boolean }>`
  position: absolute;
  top: ${(p) => (p.$dot ? '-3px' : '-5px')};
  right: ${(p) => (p.$dot ? '-3px' : '-5px')};
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: ${(p) => (p.$dot ? '8px' : '15px')};
  height: ${(p) => (p.$dot ? '8px' : '15px')};
  padding: ${(p) => (p.$dot ? '0' : '0 4px')};
  border-radius: 999px;
  background: var(--brand);
  border: 1px solid #201d1b;
  color: #1a1613;
  font-size: 9px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  pointer-events: none;
`

// ── popover ─────────────────────────────────────────────────────────────────

/**
 * A panel hung under an icon button.
 *
 * It exists because the toolbar's controls stopped being labelled: a sort with
 * six options and a filter with four groups do not fit in a 34px square, and
 * putting them back on the bar as labelled selects is exactly the misalignment
 * this redesign removes. So the button carries the icon and the panel carries
 * the choices — one row of controls, and everything they can express one click
 * away.
 *
 * Everything a floating surface has to get right is here rather than at each
 * call site: it flips at the viewport edges, it closes on Escape (through the
 * layer stack, so a popover opened over a modal closes only the popover), on an
 * outside click, and when focus tabs out of it, and Escape and selection hand
 * focus back to the button that opened it. An outside click does not — the
 * reader has already said where they want to be.
 */
export function Popover({
  label,
  title,
  icon,
  badge,
  width = 268,
  children
}: {
  /** The trigger's accessible name, and the panel's. */
  label: string
  title?: string
  icon: ReactNode
  /** A count, or `true` for a bare dot. Anything falsy shows nothing. */
  badge?: number | boolean
  width?: number
  /** Rendered with a `close` the content can call after a single-select pick. */
  children: (close: () => void) => ReactNode
}): JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) trigger.current?.focus()
  }, [])

  const dot = badge === true
  const count = typeof badge === 'number' && badge > 0 ? badge : null

  return (
    <>
      <IconButton
        ref={trigger}
        type="button"
        // The written-out title is the better spoken name: "Filter — 2 applied"
        // says what the badge is showing, which the badge itself cannot.
        aria-label={title ?? label}
        title={title ?? label}
        aria-haspopup="dialog"
        aria-expanded={open}
        $on={open}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {dot || count != null ? (
          <TriggerBadge $dot={dot} aria-hidden>
            {count}
          </TriggerBadge>
        ) : null}
      </IconButton>
      {open ? (
        <PopoverPanel anchor={trigger} label={label} width={width} onClose={close}>
          {children(() => close(true))}
        </PopoverPanel>
      ) : null}
    </>
  )
}

function PopoverPanel({
  anchor,
  label,
  width,
  onClose,
  children
}: {
  anchor: RefObject<HTMLButtonElement>
  label: string
  width: number
  onClose: (returnFocus: boolean) => void
  children: ReactNode
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useTransientLayer(() => onClose(true))

  // Measured and placed before the browser paints, so the panel is never seen
  // in the corner it was rendered into. `offsetHeight` is the reason it has to
  // be measured at all: the content is chips that wrap, and how many rows they
  // wrap into decides whether there is room below the button.
  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect()
    const node = panel.current
    if (!rect || !node) return
    setPos(placePopover(rect, node.offsetWidth, node.offsetHeight))
    node.focus()
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      if (panel.current?.contains(target)) return
      // The trigger toggles itself on click; closing here as well would close
      // and immediately reopen.
      if (anchor.current?.contains(target)) return
      onClose(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [anchor, onClose])

  return createPortal(
    <PopoverSurface
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      $width={width}
      $ready={pos !== null}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null
        // Focus leaving for nothing at all is a window blur, not a dismissal.
        if (!next) return
        if (panel.current?.contains(next) || anchor.current?.contains(next)) return
        onClose(false)
      }}
    >
      {children}
    </PopoverSurface>,
    document.body
  )
}

/**
 * Under the button, left edges aligned; right-aligned instead when that would
 * hang off the window, and above when there is no room below. Clamped to the
 * viewport either way, because a panel that opens half off screen is a panel
 * with options nobody can reach.
 */
function placePopover(
  rect: DOMRect,
  width: number,
  height: number
): { left: number; top: number } {
  const GAP = 6
  const MARGIN = 8
  const vw = window.innerWidth
  const vh = window.innerHeight

  let left = rect.left
  if (left + width > vw - MARGIN) left = rect.right - width
  left = Math.max(MARGIN, Math.min(left, Math.max(MARGIN, vw - width - MARGIN)))

  let top = rect.bottom + GAP
  if (top + height > vh - MARGIN) {
    const above = rect.top - GAP - height
    top = above >= MARGIN ? above : Math.max(MARGIN, vh - height - MARGIN)
  }
  return { left, top }
}

const popIn = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: none; }
`

const PopoverSurface = styled.div<{ $width: number; $ready: boolean }>`
  position: fixed;
  z-index: 65;
  width: ${(p) => p.$width}px;
  max-width: calc(100vw - 16px);
  max-height: min(420px, calc(100vh - 16px));
  overflow-y: auto;
  visibility: ${(p) => (p.$ready ? 'visible' : 'hidden')};
  padding: 10px 12px 12px;
  border-radius: 12px;
  border: 1px solid var(--line-strong);
  background: #201d1b;
  box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);
  animation: ${popIn} 0.14s cubic-bezier(0.16, 1, 0.3, 1);
  ${scrollbar}
  &:focus {
    outline: none;
  }
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

/** A named group of options inside a popover. */
export function PopoverGroup({
  name,
  children
}: {
  name: string
  children: ReactNode
}): JSX.Element {
  return (
    <GroupWrap role="group" aria-label={name}>
      <GroupName>{name}</GroupName>
      <OptionRow>{children}</OptionRow>
    </GroupWrap>
  )
}

const GroupWrap = styled.div`
  & + & {
    margin-top: 12px;
    padding-top: 11px;
    border-top: 1px solid var(--line);
  }
`

const GroupName = styled.div`
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 7px;
`

const OptionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
`

/**
 * One choice in a group: a chip that is either on or off.
 *
 * `role="radio"` rather than a pressed button, because these are single-select
 * within their group and a screen reader should say "2 of 5" rather than
 * announcing five independent toggles that happen to be mutually exclusive.
 */
export function OptionChip({
  on,
  onSelect,
  tone,
  title,
  caps,
  children
}: {
  on: boolean
  onSelect: () => void
  tone?: string
  title?: string
  /** For raw data values ("common", "red"); off for written labels ("Win rate"). */
  caps?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <ChipButton
      type="button"
      role="radio"
      aria-checked={on}
      $on={on}
      $tone={tone}
      $caps={Boolean(caps)}
      title={title}
      onClick={onSelect}
    >
      {children}
    </ChipButton>
  )
}

const ChipButton = styled.button<{ $on: boolean; $tone?: string; $caps: boolean }>`
  cursor: pointer;
  padding: 4px 10px;
  border-radius: 999px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.45;
  text-transform: ${(p) => (p.$caps ? 'capitalize' : 'none')};
  color: ${(p) => (p.$on ? '#1a1613' : (p.$tone ?? 'var(--ink-dim)'))};
  background: ${(p) => (p.$on ? (p.$tone ?? 'var(--brand)') : 'var(--fill)')};
  border: 1px solid ${(p) => (p.$on ? 'transparent' : 'var(--line)')};
  transition:
    background 0.12s ease,
    color 0.12s ease;
  &:hover {
    background: ${(p) => (p.$on ? (p.$tone ?? 'var(--brand)') : 'var(--fill-hover)')};
    color: ${(p) => (p.$on ? '#1a1613' : 'var(--ink)')};
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

/** The line a popover shows when it has nothing to offer yet. */
export const PopoverNote = styled.p`
  margin: 2px 0;
  font-size: 12px;
  font-style: italic;
  color: var(--ink-faint);
`

// ── chips and whispers ──────────────────────────────────────────────────────

export const Chip = styled.span<{ $tone?: string }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  color: ${(p) => p.$tone ?? 'var(--ink-dim)'};
  background: var(--fill);
  border: 1px solid ${(p) => (p.$tone ? 'currentColor' : 'var(--line)')};
`

export const ResultCount = styled.div`
  font-size: 12px;
  color: var(--ink-faint);
  padding: 0 2px 8px;
`

// ── the three states ────────────────────────────────────────────────────────

/** "No matches." — one italic line, no illustration, no apology. */
export const Empty = styled.p`
  margin: 26px 2px;
  font-size: 13px;
  font-style: italic;
  color: var(--ink-faint);
`

export function Loading({ label }: { label: string }): JSX.Element {
  return (
    <LoadingLine role="status">
      <Spinner size={14} />
      <span>{label}</span>
    </LoadingLine>
  )
}

const LoadingLine = styled.div`
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 22px 2px;
  font-size: 13px;
  color: var(--ink-dim);
`

/**
 * A failure, stated plainly, with the only useful button next to it.
 *
 * The compendium is community data over the open internet: it will be
 * unreachable sometimes, and the honest response is to say so and offer to try
 * again — never to render an empty grid that implies the game has no cards.
 */
export function ErrorState({
  message,
  onRetry,
  title = 'Could not reach the compendium'
}: {
  message: string
  onRetry?: () => void
  title?: string
}): JSX.Element {
  return (
    <ErrorPanel role="alert">
      <div>
        <ErrorTitle>{title}</ErrorTitle>
        <ErrorBody>{message}</ErrorBody>
      </div>
      {onRetry ? (
        <Button type="button" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </ErrorPanel>
  )
}

/** The dashboard's `Panel`, laid out as a message with its button beside it. */
const ErrorPanel = styled(Panel)`
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 18px 0;
  padding: 14px 16px;

  @media (max-width: 480px) {
    flex-direction: column;
    align-items: stretch;
  }
`

const ErrorTitle = styled.div`
  font-size: 14px;
  color: var(--ink);
`

const ErrorBody = styled.div`
  font-size: 12px;
  color: var(--ink-faint);
  margin-top: 3px;
  word-break: break-word;
`

// ── skeletons ───────────────────────────────────────────────────────────────

const pulse = keyframes`
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 0.85; }
`

/**
 * A placeholder that occupies exactly the space its content will.
 *
 * Reserving the aspect ratio is the whole job: art arriving into a
 * correctly-sized hole is invisible, and art arriving into a collapsed one
 * throws the page down under the reader's cursor.
 */
export const Skeleton = styled.div<{ $radius?: string }>`
  background: var(--fill);
  border: 1px solid var(--line);
  border-radius: ${(p) => p.$radius ?? '10px'};
  animation: ${pulse} 1.6s ease-in-out infinite;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

// ── art ─────────────────────────────────────────────────────────────────────

/**
 * A plate for sprite art (relics, potions), so a 64px icon on a transparent
 * background still reads as an object sitting on a surface rather than
 * floating in the page.
 */
export const ArtPlate = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--fill);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
`

/** Every image in the tab: lazy, async-decoded, and never dragged out of place. */
export const Art = styled.img.attrs({ loading: 'lazy', decoding: 'async', draggable: false })`
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  -webkit-user-drag: none;
`

// ── transient layers ────────────────────────────────────────────────────────

/**
 * Every transient surface currently on screen, innermost last.
 *
 * Escape has to belong to exactly one of them. Without a stack, a keyword
 * tooltip opened inside a compare modal opened inside a detail modal would see
 * all three listeners fire on one keypress and close the lot — and because
 * capture-phase listeners run in registration order, the *outermost* one would
 * go first, which is precisely backwards.
 */
const layers: symbol[] = []

export function useTransientLayer(onEscape: () => void): void {
  // The callback is read through a ref so a caller passing an inline arrow —
  // which is all of them — doesn't push and pop the stack on every render.
  const latest = useRef(onEscape)
  latest.current = onEscape

  useEffect(() => {
    const token = Symbol('layer')
    layers.push(token)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (layers[layers.length - 1] !== token) return
      e.stopPropagation()
      e.preventDefault()
      latest.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const at = layers.indexOf(token)
      if (at >= 0) layers.splice(at, 1)
    }
  }, [])
}

// ── modal ───────────────────────────────────────────────────────────────────

const scrimIn = keyframes`
  from { opacity: 0; }
  to   { opacity: 1; }
`
const panelIn = keyframes`
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to   { opacity: 1; transform: none; }
`

/**
 * A dialog over the current view, portalled to the body so no ancestor's
 * `overflow: hidden` can clip it.
 *
 * Escape closes it, the scrim closes it, Tab is kept inside it, and focus goes
 * back where it came from on the way out — the four things that separate a
 * dialog from a div that happens to be on top of things.
 */
export function Modal({
  onClose,
  label,
  width = 680,
  children
}: {
  onClose: () => void
  label: string
  width?: number
  children: ReactNode
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const returnTo = useRef<Element | null>(null)
  useTransientLayer(onClose)

  useEffect(() => {
    returnTo.current = document.activeElement
    const node = panel.current
    // Focus the panel itself rather than its first control: reading comes
    // before acting, and a screen reader should hear the dialog's name first.
    node?.focus()
    const onKey = (e: KeyboardEvent): void => {
      // Escape is handled by the layer stack above; this is only the Tab trap.
      // A nested dialog's focus never sits inside this panel, so an outer
      // modal's trap finds neither its first nor its last element and stands
      // down on its own.
      if (e.key !== 'Tab' || !node) return
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus()
    }
  }, [])

  return createPortal(
    <Scrim onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <ModalPanel
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        $width={width}
      >
        {children}
      </ModalPanel>
    </Scrim>,
    document.body
  )
}

const Scrim = styled.div`
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px 20px;
  background: oklch(0.08 0.01 300 / 62%);
  backdrop-filter: blur(2px);
  animation: ${scrimIn} 0.16s ease;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

const ModalPanel = styled.div<{ $width: number }>`
  width: 100%;
  max-width: ${(p) => p.$width}px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #201d1b;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);
  animation: ${panelIn} 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  &:focus {
    outline: none;
  }
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`

/** A round ✕ for dialog and pane headers. */
export const CloseButton = styled.button`
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ink-dim);
  font-size: 15px;
  line-height: 1;
  &:hover {
    background: var(--fill-hover);
    color: var(--ink);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }
`

/** The scroll container inside a modal or a detail pane. */
export const ScrollArea = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  ${scrollbar}
`

// ── link surfaces ───────────────────────────────────────────────────────────
//
// These are plain styled anchors, exported *unlinked*. Each consumer wraps them
// with `createLink()` locally, because a `createLink` result is typed against
// the registered router — exporting one from a module that the route tree
// imports would make the router's type depend on itself.

/** Sub-nav item: a Kreon word that grows a 2px brand rule when it is the one. */
export const NavAnchor = styled.a<{ $active: boolean }>`
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 3px;
  cursor: pointer;
  text-decoration: none;
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.4px;
  color: ${(p) => (p.$active ? 'var(--ink)' : 'var(--ink-dim)')};
  transition: color 0.13s ease;

  &::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    border-radius: 1px;
    background: var(--brand);
    opacity: ${(p) => (p.$active ? 1 : 0)};
    transform: scaleX(${(p) => (p.$active ? 1 : 0.4)});
    transition:
      opacity 0.16s ease,
      transform 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  }
  &:hover {
    color: var(--ink);
  }
  &:hover::after {
    opacity: ${(p) => (p.$active ? 1 : 0.35)};
    transform: scaleX(1);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 3px;
    border-radius: 3px;
  }
  @media (prefers-reduced-motion: reduce) {
    &::after {
      transition: none;
    }
  }
`

/** Pinned-rail chip surface. */
export const ChipAnchor = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 168px;
  padding: 3px 9px 3px 3px;
  cursor: pointer;
  text-decoration: none;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--ink-dim);
  font-size: 12px;
  transition:
    background 0.13s ease,
    color 0.13s ease;
  &:hover {
    background: var(--fill-hover);
    color: var(--ink);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

/** A quiet inline link for footers and cross-references. */
export const QuietLink = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  cursor: pointer;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 12px;
  color: var(--brand-soft);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  &:hover {
    border-bottom-color: currentColor;
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: 3px;
  }
`
