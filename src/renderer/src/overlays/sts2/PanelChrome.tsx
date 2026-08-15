import styled, { css } from 'styled-components'

/**
 * The shared vocabulary of a free-placed overlay panel: the mark that says
 * "grab here" and the guide that says "it will land there".
 *
 * These started inside FreeDeckTracker. They live here because a second panel
 * (the attack forecast) is placed the same way, and two panels that move
 * identically must not learn to *look* like they move differently — a grip
 * drawn twice drifts apart at the first tweak.
 */

/**
 * The standard "this is a drag handle" mark, drawn rather than typed as a
 * braille glyph — a font's dot spacing is not ours to choose.
 *
 * Three spans in a two-wide grid, each casting a copy of itself 6px down, draw
 * a 2-wide by 3-tall dot field. The box is 9px square; the mark reads 15px
 * tall, because the bottom row is shadow. Anything centring it must allow for
 * that.
 */
export const PanelGrip = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 3px);
  gap: 3px;
  flex: 0 0 auto;
  span {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: oklch(1 0 0 / 45%);
    box-shadow: 0 6px 0 oklch(1 0 0 / 45%);
  }
`

/** The three spans PanelGrip expects, so callers cannot half-draw the mark. */
export function GripDots(): JSX.Element {
  return (
    <PanelGrip aria-hidden>
      <span />
      <span />
      <span />
    </PanelGrip>
  )
}

/**
 * Where the panel will land, drawn BEHIND it while dragging — the point is to
 * show the target region, which you cannot see if the panel covers it.
 */
export const SnapGuide = styled.div<{ $ax: string; $ay: string }>`
  position: absolute;
  pointer-events: none;
  border-radius: 12px;
  border: 1px dashed color-mix(in oklch, var(--brand) 70%, transparent);
  background: color-mix(in oklch, var(--brand) 8%, transparent);
  inset: 6px;
  ${(p) =>
    p.$ax === 'left'
      ? css`
          right: 60%;
        `
      : p.$ax === 'right'
        ? css`
            left: 60%;
          `
        : css`
            left: 28%;
            right: 28%;
          `}
  ${(p) =>
    p.$ay === 'top'
      ? css`
          bottom: 60%;
        `
      : p.$ay === 'bottom'
        ? css`
            top: 60%;
          `
        : css`
            top: 28%;
            bottom: 28%;
          `}
`
