import styled from 'styled-components'
import { useEntities } from './art'
import type { Sighting } from './derive'
import { Art, Note, Num, OutlineChip, Whisper } from './parts'

/**
 * Relics & Potions — the honest strip.
 *
 * There is no relic reader and no potion reader yet, so ownership, pickups and
 * use are all unreadable. What *is* observable is shop stock: a merchant offer
 * carries priced ids, and the ones that are not cards are the relics and
 * potions that were on the shelf. That is a genuinely small thing to know, and
 * the section is sized accordingly — one row of chips, one chip admitting the
 * limit, one whisper naming what would fix it.
 *
 * The alternative was to leave the section out until the readers land. Leaving
 * it in, clearly labelled, is better: it tells the reader that the absence is a
 * known gap with a plan behind it rather than an oversight, and it gives the
 * relic readers a landing site that already has its copy written.
 */

export function RelicsStrip({ sightings }: { sightings: readonly Sighting[] }): JSX.Element {
  const entities = useEntities()

  return (
    <>
      {sightings.length === 0 ? (
        <Note>No shop stock was seen this run — merchants are the only source today.</Note>
      ) : (
        <Strip>
          {sightings.map((sight) => {
            const entity = entities.item(sight.id)
            return (
              <Sight key={`${sight.id}-${sight.roomIndex}`}>
                <Art entity={entity} variant="sprite" />
                <b>{entity.name}</b>
                {sight.cost === null ? null : <Gold>{sight.cost}g</Gold>}
                <Src>
                  shop · R{sight.roomIndex < 10 ? `0${sight.roomIndex}` : sight.roomIndex}
                </Src>
              </Sight>
            )
          })}
        </Strip>
      )}
      <Whisper style={{ margin: '10px 2px 0' }}>
        only shop stock is observable today — ownership, pickups and use land with the
        relic/potion readers
      </Whisper>
    </>
  )
}

/** The section head's badge, exported so the report can place it inline. */
export function NotReadableChip(): JSX.Element {
  return <OutlineChip>not readable in v1</OutlineChip>
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
