import styled from 'styled-components'
import { useEntities } from './art'
import type { Sighting } from './derive'
import { Art, Num, OutlineChip } from './parts'

/**
 * Relics & Potions — the honest strip.
 *
 * There is no relic reader and no potion reader yet, so ownership, pickups and
 * use are all unreadable. What *is* observable is shop stock: a merchant offer
 * carries priced ids, and the ones that are not cards are the relics and
 * potions that were on the shelf. That is a genuinely small thing to know, and
 * the section is sized accordingly — one row of chips and one chip admitting
 * the limit. One visible line, nothing under it.
 *
 * When there is no stock to show, the section does not appear at all. The
 * earlier version rendered a heading, a badge and two sentences to say that a
 * run which met no merchant had no merchandise — four lines of screen spent
 * apologising for a section that had nothing to be. The admission itself is not
 * lost: it is the `title` on the badge, on the runs that do show stock, which is
 * exactly where a reader would go looking for it.
 */

/** What the badge admits to when a reader asks it. */
const LIMIT =
  'only shop stock is observable today — ownership, pickups and use land with the relic/potion readers'

export function RelicsStrip({ sightings }: { sightings: readonly Sighting[] }): JSX.Element | null {
  const entities = useEntities()
  if (sightings.length === 0) return null

  return (
    <Strip>
      {sightings.map((sight) => {
        const entity = entities.item(sight.id)
        return (
          <Sight key={`${sight.id}-${sight.roomIndex}`}>
            <Art entity={entity} variant="sprite" />
            <b>{entity.name}</b>
            {sight.cost === null ? null : <Gold>{sight.cost}g</Gold>}
            <Src>shop · R{sight.roomIndex < 10 ? `0${sight.roomIndex}` : sight.roomIndex}</Src>
          </Sight>
        )
      })}
    </Strip>
  )
}

/** The section head's badge, exported so the report can place it inline. */
export function NotReadableChip(): JSX.Element {
  return <OutlineChip title={LIMIT}>not readable in v1</OutlineChip>
}

const Strip = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 11px 14px;
  background: rgba(38, 35, 33, 0.55);
  border: 1px solid var(--line);
  border-radius: 12px;
`

const Sight = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 9px;
  height: 32px;
  padding: 0 11px 0 7px;
  border-radius: 8px;
  background: var(--fill);
  border: 1px solid var(--line);

  b {
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 0.2px;
    color: var(--ink);
  }
`

const Gold = styled(Num)`
  font-family: var(--font-display);
  font-size: 12.5px;
  letter-spacing: 0.3px;
  color: var(--sts-color-gold);
`

const Src = styled.span`
  padding-left: 9px;
  border-left: 1px solid var(--line);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.3px;
  color: var(--ink-faint);
`
