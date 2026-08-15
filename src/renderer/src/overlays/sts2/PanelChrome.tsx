import styled from 'styled-components'

/**
 * The shared vocabulary of a free-placed overlay panel: the mark that says
 * "grab here".
 *
 * This started inside FreeDeckTracker. It lives here because a second panel
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

