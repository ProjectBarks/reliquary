import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import styled from 'styled-components'
import { codexImageUrl, type CodexCard, type CodexKind, type CodexRelic } from '@shared/codex'
import { rarityColors } from '../overlays/sts2/theme'
import { Button, Spinner } from '../dashboard/ui'
import { prefetchArt, trapIndex, trapVerdict, useLibraryEntries, type LibraryEntry } from './data'
import {
  DASH,
  confidenceFor,
  confidenceLabel,
  fmtCount,
  fmtElo,
  fmtInt,
  fmtPct,
  fmtScore
} from './format'
import { TierBadge, tierLabel } from './tiers'
import { useCodexScope, useMetaSearch } from './params'
import {
  Art,
  ArtPlate,
  Chip,
  CloseButton,
  Empty,
  ErrorState,
  Modal,
  QuietLink,
  ScrollArea,
  Segmented,
  Skeleton
} from './parts'
import { RichText } from './RichText'
import { Compare } from './Compare'
import { isPinned, pushRecent, togglePin, usePins } from './prefs'
import { reportEvent } from '../telemetry'

/**
 * One entity, in full — the same component whether it is a pane beside a list
 * or a modal over a grid.
 *
 * Writing it twice was the alternative, and it would have produced two slightly
 * different detail views within one tab: the pane would have grown the feature
 * the modal lacked, and vice versa, until neither was the real one. `mode` only
 * decides the header's shape and the width of the art.
 *
 * The metrics block is the part that has to be most careful. `elo` and
 * `pick_rate` are null for every relic, every potion, and every
 * character-filtered card in the current snapshot; a `·` in those slots is the
 * true answer, and inventing a number — or hiding the row and letting the
 * reader assume it was never measured — would both be worse.
 */

export function DetailModal({
  kind,
  id,
  onClose
}: {
  kind: CodexKind
  id: string
  onClose: () => void
}): JSX.Element {
  return (
    <Modal onClose={onClose} label="Compendium entry" width={720}>
      <Detail kind={kind} id={id} mode="modal" onClose={onClose} />
    </Modal>
  )
}

export function Detail({
  kind,
  id,
  mode,
  onClose
}: {
  kind: CodexKind
  id: string
  mode: 'modal' | 'pane'
  onClose?: () => void
}): JSX.Element {
  const scope = useCodexScope()
  const { entries, index, loading, error, retry } = useLibraryEntries(kind, scope.bracket, scope.character)
  const entry = useMemo(() => entries.find((e) => e.id === id) ?? null, [entries, id])
  const pins = usePins()
  const [comparing, setComparing] = useState(false)
  const navigate = useNavigate()
  const metaSearch = useMetaSearch()

  // Remember what was looked at, not what was rendered: this fires when the
  // entity resolves, so a mistyped id never lands in the recents list.
  useEffect(() => {
    if (!entry) return
    pushRecent({ kind, id: entry.id, name: entry.name, art: entry.thumb })
  }, [entry, kind])

  useDetailViewed(kind, id, Boolean(entry))

  if (error && !entry) {
    return (
      <Body $mode={mode}>
        <ErrorState message={error} onRetry={retry} />
      </Body>
    )
  }
  if (!entry) {
    return (
      <Body $mode={mode}>
        {loading ? <DetailSkeleton /> : <Empty>Nothing in the compendium with the id “{id}”.</Empty>}
      </Body>
    )
  }

  const pinned = isPinned(pins, kind, entry.id)
  const row = entry.metrics
  const trap = trapIndex(row, index)
  const verdict = trapVerdict(trap)
  const confidence = confidenceFor(entry.picks)

  return (
    <>
      <Header>
        <HeaderMain>
          <Name>{entry.name}</Name>
          <Id>{entry.id}</Id>
        </HeaderMain>
        <HeaderActions>
          <Button
            type="button"
            onClick={() => togglePin({ kind, id: entry.id, name: entry.name, art: entry.thumb })}
            aria-pressed={pinned}
            title={pinned ? 'Remove from the pinned rail' : 'Keep this on the pinned rail'}
          >
            {pinned ? '★ Pinned' : '☆ Pin'}
          </Button>
          {kind !== 'potions' ? (
            <Button type="button" onClick={() => setComparing(true)} title="Compare with another entry">
              ⇄ Compare
            </Button>
          ) : null}
          {onClose ? (
            <CloseButton type="button" onClick={onClose} aria-label="Close" title="Close (Esc)">
              ✕
            </CloseButton>
          ) : null}
        </HeaderActions>
      </Header>

      <ScrollArea>
        <Body $mode={mode}>
          <Top $mode={mode}>
            <ArtColumn $mode={mode}>
              <EntryArt entry={entry} />
            </ArtColumn>

            <Facts>
              <ChipRow>
                <KindChips entry={entry} />
              </ChipRow>
              {entry.description ? <RichText text={entry.description} /> : <NoText>No description.</NoText>}
              {entry.kind === 'cards' ? <UpgradeBlock card={entry.item} /> : null}
              {entry.kind === 'relics' ? <RelicExtras relic={entry.item} /> : null}
            </Facts>
          </Top>

          <MetricsBlock>
            <MetricsHead>
              <TierBadge $tier={entry.tier} $size="lg" title={tierLabel(entry.tier)}>
                {entry.tier ?? DASH}
              </TierBadge>
              <div>
                <MetricsTitle>{entry.tier ? tierLabel(entry.tier) : 'Not graded in this cohort'}</MetricsTitle>
                <MetricsNote>
                  {confidence ? (
                    <>
                      {fmtCount(entry.picks)} samples · {confidenceLabel(confidence)}
                    </>
                  ) : (
                    'No sample recorded for this cohort.'
                  )}
                </MetricsNote>
              </div>
              {verdict ? (
                <TrapChip
                  $tone={verdict === 'overdrafted' ? 'var(--sts-color-orange)' : 'var(--sts-color-green)'}
                  title={`TRAP ${trap! > 0 ? '+' : ''}${trap} — how far the pick rate runs ahead of the results, in standard deviations`}
                >
                  {verdict === 'overdrafted' ? 'Overdrafted' : 'Sleeper'}
                </TrapChip>
              ) : null}
            </MetricsHead>

            <Stats>
              <Stat label="Score" value={fmtScore(entry.score)} hint="Codex Score (0–100, Bayesian-shrunk win rate)" />
              <Stat label="Elo" value={fmtElo(entry.elo)} hint="Revealed preference, from card-reward picks" />
              <Stat label="Win rate" value={fmtPct(entry.winRate)} hint="Runs won that included this, as a percentage" />
              <Stat label="Pick rate" value={fmtPct(entry.pickRate)} hint="Times taken when offered" />
              <Stat label="Sample" value={fmtCount(entry.picks)} hint="How many runs are behind these numbers" />
              <Stat
                label="W–L"
                value={row?.wins != null || row?.losses != null ? `${fmtInt(row?.wins)}–${fmtInt(row?.losses)}` : DASH}
                hint="Wins and losses among runs that included this"
              />
            </Stats>

            <ActBars row={entry} />
          </MetricsBlock>

          <Footer>
            <QuietLink
              type="button"
              onClick={() =>
                navigate({
                  to: '/codex/meta/tiers',
                  search: { ...metaSearch, kind, highlight: entry.id }
                })
              }
            >
              View in tier list →
            </QuietLink>
            <QuietLink
              type="button"
              title="Opens this entity's page on spire-codex.com, the source of every number here"
              onClick={() =>
                window.spectra?.openExternal(
                  `https://spire-codex.com/${kind}/${entry.id.toLowerCase()}`
                )
              }
            >
              View on spire-codex.com ↗
            </QuietLink>
          </Footer>
        </Body>
      </ScrollArea>

      {comparing ? (
        <Compare kind={kind} baseId={entry.id} onClose={() => setComparing(false)} />
      ) : null}
    </>
  )
}

/**
 * `codex_detail`, once per entity actually read.
 *
 * Two things it deliberately does not count. A re-render — the entry object is
 * rebuilt every time metrics land, so the guard is the `kind:id` pair rather
 * than the object — and an id that resolved to nothing, because a stale link
 * to a card that no longer exists is a 404, not a reading. In the list's
 * reading pane one mounted `Detail` walks through a whole column of entries
 * under ↓, and each of those is a genuine open.
 */
function useDetailViewed(kind: CodexKind, id: string, resolved: boolean): void {
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (!resolved) return
    const token = `${kind}:${id}`
    if (seen.current === token) return
    seen.current = token
    reportEvent('codex_detail', { kind })
  }, [kind, id, resolved])
}

// ── art ─────────────────────────────────────────────────────────────────────

/**
 * Cards get the full render and a Base | Upgraded toggle; relics and potions
 * get their sprite, large, on a plate. The upgraded art is warmed on hover of
 * the toggle so the swap is instant rather than a flash of nothing.
 */
function EntryArt({ entry }: { entry: LibraryEntry }): JSX.Element {
  const [upgraded, setUpgraded] = useState(false)
  const card = entry.kind === 'cards' ? entry.item : null
  const upgradedArt = card ? codexImageUrl(card.image_url_card_upg) : null
  const src = upgraded && upgradedArt ? upgradedArt : entry.art

  if (entry.kind === 'cards') {
    return (
      <>
        <CardFrame>
          {src ? <Art src={src} alt={entry.name} /> : <Skeleton style={{ width: '100%', height: '100%' }} />}
        </CardFrame>
        {upgradedArt ? (
          <ToggleRow onMouseEnter={() => prefetchArt(upgradedArt)}>
            <Segmented
              label="Card version"
              value={upgraded ? 'upgraded' : 'base'}
              onChange={(v) => setUpgraded(v === 'upgraded')}
              options={[
                { value: 'base', label: 'Base' },
                { value: 'upgraded', label: 'Upgraded' }
              ]}
            />
          </ToggleRow>
        ) : null}
      </>
    )
  }

  // An empty plate rather than a spinner when there is no `image_url`: the
  // plate already reserves the square, and a spinner that can never resolve is
  // a promise the compendium has no way of keeping.
  return <SpritePlate>{entry.art ? <Art src={entry.art} alt={entry.name} /> : null}</SpritePlate>
}

// ── blocks ──────────────────────────────────────────────────────────────────

function KindChips({ entry }: { entry: LibraryEntry }): JSX.Element {
  if (entry.kind === 'cards') {
    const card = entry.item
    const rarity = rarityColors(card.rarity_key ?? card.rarity ?? undefined)
    return (
      <>
        {card.cost != null || card.is_x_cost ? (
          <Chip title="Energy cost">{card.is_x_cost ? 'X' : card.cost} energy</Chip>
        ) : null}
        {card.type ? <Chip>{card.type}</Chip> : null}
        {card.rarity ? <Chip $tone={rarity.light}>{card.rarity}</Chip> : null}
        {card.color ? <Chip $tone={`var(--sts-${card.color}-primary)`}>{card.color}</Chip> : null}
        {card.target ? <Chip title="Who it targets">{card.target}</Chip> : null}
        {card.damage != null ? <Chip title="Base damage">{card.damage} dmg</Chip> : null}
        {card.block != null ? <Chip title="Base block">{card.block} block</Chip> : null}
        {card.hit_count != null && card.hit_count > 1 ? <Chip>×{card.hit_count} hits</Chip> : null}
        {(card.powers_applied ?? [])
          .filter((p) => p.power)
          .map((p, i) => (
            <Chip key={`${p.power}-${i}`} $tone="var(--sts-color-purple)">
              {p.power}
              {p.amount != null ? ` ${p.amount}` : ''}
            </Chip>
          ))}
      </>
    )
  }
  const rarityKey = entry.item.rarity_key ?? undefined
  const rarity = rarityColors(rarityKey)
  return (
    <>
      {entry.item.rarity ? <Chip $tone={rarity.light}>{entry.item.rarity}</Chip> : null}
      {entry.item.pool ? <Chip title="Which pool it drops from">{entry.item.pool}</Chip> : null}
    </>
  )
}

/**
 * The API's upgrade deltas are machine keys, not copy: numeric tweaks arrive as
 * `{damage: "+3"}` but flags arrive as `{remove_ethereal: 1}` and bookkeeping
 * as `{description_changed: 1}`. Rendered raw, a chip reads "remove_ethereal 1"
 * — so each key is translated: flags become verbs, bookkeeping disappears
 * (the upgraded text beside it already IS the changed description), and
 * everything else becomes "Word Word +3".
 */
function humanizeUpgradeDelta(name: string, delta: string | number): string | null {
  const words = (s: string): string =>
    s
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
  if (name === 'description_changed') return null
  const flag = /^(add|remove)_(.+)$/.exec(name)
  if (flag) return `${flag[1] === 'add' ? 'Gains' : 'Loses'} ${words(flag[2])}`
  const amount = typeof delta === 'number' && delta > 0 ? `+${delta}` : String(delta)
  return `${words(name)} ${amount}`.trim()
}

/**
 * The upgrade, stated twice on purpose: the whole upgraded text (because that
 * is what the card will read) and the raw deltas as green chips (because that
 * is the question — "what does + actually give me").
 */
function UpgradeBlock({ card }: { card: CodexCard }): JSX.Element | null {
  const deltas = Object.entries(card.upgrade ?? {})
    .map(([name, delta]) => humanizeUpgradeDelta(name, delta))
    .filter((label): label is string => label !== null)
  if (!card.upgrade_description && !deltas.length) return null
  return (
    <Upgrade>
      <UpgradeHead>Upgraded</UpgradeHead>
      {card.upgrade_description ? <RichText text={card.upgrade_description} /> : null}
      {deltas.length ? (
        <ChipRow>
          {deltas.map((label) => (
            <Chip key={label} $tone="var(--sts-color-green)">
              {label}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
    </Upgrade>
  )
}

function RelicExtras({ relic }: { relic: CodexRelic }): JSX.Element | null {
  const price = relic.merchant_price
  const hasPrice = price && (price.base != null || price.min != null || price.max != null)
  if (!relic.flavor && !hasPrice) return null
  return (
    <>
      {relic.flavor ? <Flavor text={relic.flavor} /> : null}
      {hasPrice ? (
        <ChipRow>
          <Chip $tone="var(--sts-color-gold)" title="What a merchant will ask for it">
            {price!.min != null && price!.max != null
              ? `${fmtInt(price!.min)}–${fmtInt(price!.max)}g`
              : `${fmtInt(price!.base)}g`}
          </Chip>
        </ChipRow>
      ) : null}
    </>
  )
}

/** Flavour text is in the same markup as everything else, just set in italics. */
function Flavor({ text }: { text: string }): JSX.Element {
  return (
    <FlavorWrap>
      <RichText text={text} keywords={false} />
    </FlavorWrap>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }): JSX.Element {
  return (
    <StatCell title={hint}>
      <StatLabel>{label}</StatLabel>
      <StatValue $missing={value === DASH}>{value}</StatValue>
    </StatCell>
  )
}

/**
 * Per-act pick rates.
 *
 * Every entry of `pick_rate_by_act` is null in the current snapshot, so what
 * this renders today is three empty troughs and three dots. That is
 * deliberate: the shape is right, the space is reserved, and the day the
 * upstream aggregate starts filling the array the bars appear without a single
 * pixel moving. An absent stat drawn as a zero-height bar would read as "never
 * picked in act 1", which is a different and false claim.
 */
function ActBars({ row }: { row: LibraryEntry }): JSX.Element {
  const acts = row.metrics?.pick_rate_by_act ?? [null, null, null]
  return (
    <Acts>
      {[0, 1, 2].map((i) => {
        const value = acts[i] ?? null
        return (
          <ActCell key={i} title={`Act ${i + 1} pick rate`}>
            <ActLabel>A{i + 1}</ActLabel>
            <ActTrack>
              {value != null ? <ActFill style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /> : null}
            </ActTrack>
            <ActValue $missing={value == null}>{fmtPct(value, 0)}</ActValue>
          </ActCell>
        )
      })}
    </Acts>
  )
}

function DetailSkeleton(): JSX.Element {
  return (
    <SkeletonWrap aria-hidden>
      <Skeleton style={{ width: 200, height: 260 }} />
      <SkeletonLines>
        <Skeleton style={{ height: 18, width: '60%' }} $radius="6px" />
        <Skeleton style={{ height: 12, width: '100%' }} $radius="6px" />
        <Skeleton style={{ height: 12, width: '92%' }} $radius="6px" />
        <Skeleton style={{ height: 12, width: '74%' }} $radius="6px" />
        <Skeleton style={{ height: 56, width: '100%' }} />
      </SkeletonLines>
    </SkeletonWrap>
  )
}

// ── styling ─────────────────────────────────────────────────────────────────

const Header = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--line);
`

const HeaderMain = styled.div`
  flex: 1;
  min-width: 0;
`

const Name = styled.h2`
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  letter-spacing: 0.4px;
  line-height: 1.15;
  color: var(--brand);
  text-shadow: 2px 2px 0 oklch(0 0 0 / 40%);
`

const Id = styled.div`
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-faint);
  overflow-wrap: anywhere;
`

const HeaderActions = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
`

const Body = styled.div<{ $mode: 'modal' | 'pane' }>`
  padding: ${(p) => (p.$mode === 'modal' ? '16px' : '14px 4px 20px')};
`

const Top = styled.div<{ $mode: 'modal' | 'pane' }>`
  display: grid;
  grid-template-columns: ${(p) => (p.$mode === 'modal' ? '220px 1fr' : 'minmax(150px, 200px) 1fr')};
  gap: 18px;
  align-items: start;

  @media (max-width: 620px) {
    grid-template-columns: 1fr;
  }
`

const ArtColumn = styled.div<{ $mode: 'modal' | 'pane' }>`
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
`

/** 400×520 is the CDN's own render ratio; reserving it stops the pop-in shove. */
const CardFrame = styled.div`
  width: 100%;
  aspect-ratio: 400 / 520;
  display: flex;
  align-items: center;
  justify-content: center;
`

const SpritePlate = styled(ArtPlate)`
  width: 100%;
  aspect-ratio: 1;
  padding: 18px;
`

const ToggleRow = styled.div`
  display: flex;
  justify-content: center;
`

const Facts = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
`

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const NoText = styled.p`
  margin: 0;
  font-size: 13px;
  font-style: italic;
  color: var(--ink-faint);
`

/* The green lives in the heading and the delta chips, not the frame: the box
   itself stays in the app's hairline-panel language, with only a whisper of
   the upgrade green mixed into its fill to set it apart from plain prose. */
const Upgrade = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: color-mix(in oklch, var(--sts-color-green) 4%, var(--fill));
`

const UpgradeHead = styled.div`
  font-family: var(--font-display);
  font-size: 13px;
  letter-spacing: 0.4px;
  color: var(--sts-color-green);
`

const FlavorWrap = styled.div`
  font-style: italic;
  color: var(--ink-dim);
  div {
    color: inherit;
    font-size: 12px;
  }
`

const MetricsBlock = styled.section`
  margin-top: 18px;
  padding: 14px 14px 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(38, 35, 33, 0.55);
`

const MetricsHead = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
`

const MetricsTitle = styled.div`
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.3px;
  color: var(--ink);
`

const MetricsNote = styled.div`
  font-size: 11px;
  color: var(--ink-faint);
  margin-top: 1px;
`

const TrapChip = styled(Chip)`
  margin-left: auto;
  font-weight: 600;
`

const Stats = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  gap: 10px;
  margin-top: 14px;
`

const StatCell = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`

const StatLabel = styled.div`
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--ink-faint);
`

const StatValue = styled.div<{ $missing?: boolean }>`
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  color: ${(p) => (p.$missing ? 'var(--ink-faint)' : 'var(--ink)')};
`

const Acts = styled.div`
  display: flex;
  gap: 14px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);

  @media (max-width: 480px) {
    flex-direction: column;
    gap: 8px;
  }
`

const ActCell = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
`

const ActLabel = styled.span`
  font-size: 10px;
  letter-spacing: 0.5px;
  color: var(--ink-faint);
`

const ActTrack = styled.span`
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--fill);
  border: 1px solid var(--line);
  overflow: hidden;
`

const ActFill = styled.span`
  display: block;
  height: 100%;
  background: var(--brand);
`

const ActValue = styled.span<{ $missing?: boolean }>`
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: ${(p) => (p.$missing ? 'var(--ink-faint)' : 'var(--ink-dim)')};
  min-width: 32px;
  text-align: right;
`

const Footer = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
`

const SkeletonWrap = styled.div`
  display: flex;
  gap: 18px;
  padding: 6px 0;
`

const SkeletonLines = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
`
