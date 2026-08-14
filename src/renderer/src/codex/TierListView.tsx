import { useEffect, useMemo, useRef } from 'react'
import styled from 'styled-components'
import type { CodexKind } from '@shared/codex'
import { rarityColors } from '../overlays/sts2/theme'
// `useArtPreview`'s bindings prefetch the art they are about to show, so a tier
// entry needs no hover-prefetch of its own.
import { type LibraryEntry } from './data'
import { LOW_SAMPLE, fmtCount, fmtScore } from './format'
import { Art, ArtPlate, Skeleton } from './parts'
import { TIER_DEFS, TierBadge, tierForScore } from './tiers'
import { useArtPreview } from './ArtPreview'

/**
 * S through F, by Codex Score.
 *
 * The thresholds are the community site's, not ours — 90 / 78 / 65 / 50 / 35 —
 * because a tier list whose letters mean something different from the letters
 * everyone else quotes is a tier list that starts arguments instead of ending
 * them. Each band carries its plain-English gloss ("Solid", "Avoid") so the
 * grade is readable by someone who has never seen a tier list before.
 *
 * Two decisions worth stating:
 *   - Thin samples are marked, not hidden. A card with 40 recorded picks gets a
 *     dot that says so; dropping it would quietly rewrite the compendium, and
 *     placing it silently would let 40 runs argue with 40,000.
 *   - Entries with no score at all are gathered at the bottom under "Unrated"
 *     rather than swept into F. "We have no data" and "the data says avoid it"
 *     are opposite claims.
 *
 * It takes its entries rather than fetching them: this is one of four modes on
 * `browse/$kind` now, and the search box and filter popover above it apply here
 * exactly as they do to the grid. Fetching its own copy would have meant a tier
 * list that quietly ignored the filters the reader had just set.
 */

export function TierListView({
  kind,
  entries,
  highlight,
  onOpen
}: {
  kind: CodexKind
  entries: LibraryEntry[]
  highlight?: string
  onOpen: (id: string) => void
}): JSX.Element {
  const preview = useArtPreview()
  const groups = useMemo(() => groupByTier(entries), [entries])

  // Arriving from a detail's "View in tier list →": put the entry on screen and
  // ring it, then leave the ring alone — it fades on its own via CSS, so there
  // is no timer to clean up and no state that outlives the visit.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!highlight || !entries.length) return
    const node = scroller.current?.querySelector(`[data-entry="${CSS.escape(highlight)}"]`)
    // Smooth is the point of the gesture — you see where you were sent from —
    // but a long animated scroll is precisely what reduced-motion asks not to
    // be given, so that reader gets taken straight there instead.
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node?.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' })
  }, [highlight, entries.length])

  return (
    <div ref={scroller}>
      {TIER_DEFS.map((tier) => {
        const members = groups.get(tier.key) ?? []
        if (!members.length) return null
        return (
          <TierRow key={tier.key}>
            <Badge>
              <TierBadge $tier={tier.key} $size="lg">
                {tier.key}
              </TierBadge>
              <BadgeLabel>{tier.label}</BadgeLabel>
              <BadgeCount>{members.length}</BadgeCount>
            </Badge>
            <Members $cards={kind === 'cards'}>
              {members.map((entry) => (
                <Entry
                  key={entry.id}
                  entry={entry}
                  cards={kind === 'cards'}
                  ringed={entry.id === highlight}
                  onOpen={onOpen}
                  bind={preview.bind}
                />
              ))}
            </Members>
          </TierRow>
        )
      })}

      {groups.get(UNRATED)?.length ? (
        <TierRow>
          <Badge>
            <TierBadge>–</TierBadge>
            <BadgeLabel>Unrated</BadgeLabel>
            <BadgeCount>{groups.get(UNRATED)!.length}</BadgeCount>
          </Badge>
          <Members $cards={kind === 'cards'}>
            {groups.get(UNRATED)!.map((entry) => (
              <Entry
                key={entry.id}
                entry={entry}
                cards={kind === 'cards'}
                ringed={entry.id === highlight}
                onOpen={onOpen}
                bind={preview.bind}
              />
            ))}
          </Members>
        </TierRow>
      ) : null}

      <Note>
        No score recorded in this cohort means the runs simply have not been seen — not that the
        entry is weak. A ◦ marks fewer than {LOW_SAMPLE} samples.
      </Note>

      {preview.preview}
    </div>
  )
}

/** Three bands' worth of nothing, held open while the metrics land. */
export function TierSkeleton(): JSX.Element {
  return (
    <div aria-hidden>
      {TIER_DEFS.slice(0, 3).map((t) => (
        <Skeleton key={t.key} style={{ height: 120, marginBottom: 12 }} />
      ))}
    </div>
  )
}

const UNRATED = 'unrated'

function groupByTier(entries: LibraryEntry[]): Map<string, LibraryEntry[]> {
  const groups = new Map<string, LibraryEntry[]>()
  for (const entry of entries) {
    const key = tierForScore(entry.score) ?? UNRATED
    const bucket = groups.get(key)
    if (bucket) bucket.push(entry)
    else groups.set(key, [entry])
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.name.localeCompare(b.name))
  }
  return groups
}

function Entry({
  entry,
  cards,
  ringed,
  onOpen,
  bind
}: {
  entry: LibraryEntry
  cards: boolean
  ringed: boolean
  onOpen: (id: string) => void
  bind: ReturnType<typeof useArtPreview>['bind']
}): JSX.Element {
  const thin = entry.picks != null && entry.picks < LOW_SAMPLE
  const tone = entry.kind === 'cards' ? undefined : rarityColors(entry.item.rarity_key ?? undefined).light
  return (
    <EntryButton
      type="button"
      data-entry={entry.id}
      $cards={cards}
      $ringed={ringed}
      title={`${entry.name} — score ${fmtScore(entry.score)}, ${fmtCount(entry.picks)} samples${
        thin ? ' · thin sample, treat with caution' : ''
      }`}
      onClick={() => onOpen(entry.id)}
      {...bind(entry.art, entry.name)}
    >
      {cards ? (
        <CardArt>{entry.art ? <Art src={entry.art} alt={entry.name} /> : null}</CardArt>
      ) : (
        <>
          <SpriteArt>{entry.art ? <Art src={entry.art} alt="" /> : null}</SpriteArt>
          <EntryName style={tone ? { color: tone } : undefined}>{entry.name}</EntryName>
        </>
      )}
      {/* The marker is a footnote to the button's own title, which already
          reads the sample out; announcing a bare "◦" after it would only be
          noise on a screen reader. */}
      {thin ? <Thin aria-hidden>◦</Thin> : null}
      {cards ? <SrOnly>{entry.name}</SrOnly> : null}
    </EntryButton>
  )
}

// ── styling ─────────────────────────────────────────────────────────────────

const TierRow = styled.section`
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 12px;
  padding: 12px 0;
  & + & {
    border-top: 1px solid var(--line);
  }
`

const Badge = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  position: sticky;
  top: 4px;
  align-self: start;
`

const BadgeLabel = styled.span`
  font-size: 10px;
  line-height: 1.2;
  text-align: center;
  color: var(--ink-dim);
`

const BadgeCount = styled.span`
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
`

const Members = styled.div<{ $cards: boolean }>`
  display: flex;
  flex-wrap: wrap;
  gap: ${(p) => (p.$cards ? '8px' : '6px')};
  align-content: flex-start;
  min-width: 0;
`

const EntryButton = styled.button<{ $cards: boolean; $ringed?: boolean }>`
  position: relative;
  /* The ring a "View in tier list →" link leaves on its target, so the entry
     you were sent to find is findable once the scroll stops. */
  box-shadow: ${(p) => (p.$ringed ? '0 0 0 2px var(--brand)' : 'none')};
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: ${(p) => (p.$cards ? '116px' : '78px')};
  padding: ${(p) => (p.$cards ? '0' : '5px 4px 6px')};
  cursor: pointer;
  border: 0;
  border-radius: 8px;
  background: none;
  font-family: inherit;
  color: var(--ink-dim);
  transition: transform 0.14s cubic-bezier(0.16, 1, 0.3, 1);

  &:hover {
    transform: translateY(-2px);
    color: var(--ink);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
    &:hover {
      transform: none;
    }
  }
`

const CardArt = styled.span`
  width: 100%;
  aspect-ratio: 400 / 520;
  display: flex;
  align-items: center;
  justify-content: center;
`

const SpriteArt = styled(ArtPlate)`
  width: 100%;
  aspect-ratio: 1;
  padding: 8px;
`

const EntryName = styled.span`
  font-size: var(--fs-xs);
  line-height: 1.25;
  text-align: center;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
`

const Thin = styled.span`
  position: absolute;
  top: 2px;
  left: 3px;
  font-size: 13px;
  line-height: 1;
  color: var(--sts-color-gold);
  text-shadow: 0 0 3px oklch(0 0 0 / 70%);
`

const SrOnly = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

const Note = styled.p`
  margin: 18px 2px 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--ink-faint);
`
