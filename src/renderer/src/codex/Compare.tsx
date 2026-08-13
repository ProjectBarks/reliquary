import { useMemo, useState } from 'react'
import styled from 'styled-components'
import { codexImageUrl, type CodexKind } from '@shared/codex'
import { Button } from '../dashboard/ui'
import { useLibraryEntries, type LibraryEntry } from './data'
import { DASH, fmtCount, fmtElo, fmtPct, fmtScore } from './format'
import { useCodexScope } from './params'
import { rankItems } from './search'
import { TierBadge } from './tiers'
import {
  Art,
  ArtPlate,
  CloseButton,
  Empty,
  Modal,
  ScrollArea,
  SearchIcon,
  SearchInput,
  SearchWrap,
  Segmented
} from './parts'
import { RichText } from './RichText'

/**
 * Two entries, side by side.
 *
 * Every real decision in this game is a comparison — this card or that one,
 * this relic or the shop's other one — and a detail view answers the wrong
 * question by only ever showing you one of them. The picker searches the
 * **already-loaded** catalog and nothing else: a compare modal is opened
 * mid-thought, and a network round trip to populate a candidate list would be
 * slower than the thought it is interrupting.
 */

export function Compare({
  kind,
  baseId,
  onClose
}: {
  kind: CodexKind
  baseId: string
  onClose: () => void
}): JSX.Element {
  const scope = useCodexScope()
  const { entries } = useLibraryEntries(kind, scope.bracket, scope.character)
  const [query, setQuery] = useState('')
  const [otherId, setOtherId] = useState<string | null>(null)
  const [upgraded, setUpgraded] = useState(false)

  const left = useMemo(() => entries.find((e) => e.id === baseId) ?? null, [entries, baseId])
  const right = useMemo(
    () => (otherId ? (entries.find((e) => e.id === otherId) ?? null) : null),
    [entries, otherId]
  )

  const candidates = useMemo(
    () => rankItems(entries.filter((e) => e.id !== baseId), query).slice(0, 60),
    [entries, baseId, query]
  )

  return (
    <Modal onClose={onClose} label={`Compare ${left?.name ?? kind}`} width={680}>
      <Head>
        <HeadTitle>Compare</HeadTitle>
        {kind === 'cards' && right ? (
          <Segmented
            label="Card version"
            value={upgraded ? 'upgraded' : 'base'}
            onChange={(v) => setUpgraded(v === 'upgraded')}
            options={[
              { value: 'base', label: 'Base' },
              { value: 'upgraded', label: 'Upgraded' }
            ]}
          />
        ) : null}
        {right ? (
          <Button type="button" onClick={() => setOtherId(null)}>
            Change
          </Button>
        ) : null}
        <CloseButton type="button" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ✕
        </CloseButton>
      </Head>

      <ScrollArea>
        {right && left ? (
          <Grid>
            <Side entry={left} upgraded={upgraded} />
            <Side entry={right} upgraded={upgraded} />
          </Grid>
        ) : (
          <Picker>
            <SearchWrap>
              <SearchIcon viewBox="0 0 16 16" aria-hidden>
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5 L14 14" />
              </SearchIcon>
              <SearchInput
                autoFocus
                type="search"
                value={query}
                placeholder={`Search loaded ${kind}…`}
                aria-label={`Search loaded ${kind}`}
                onChange={(e) => setQuery(e.target.value)}
              />
            </SearchWrap>
            {candidates.length ? (
              <Candidates>
                {candidates.map((entry) => (
                  <Candidate key={entry.id} type="button" onClick={() => setOtherId(entry.id)}>
                    <CandidateArt>
                      {entry.thumb ? <Art src={entry.thumb} alt="" /> : null}
                    </CandidateArt>
                    <CandidateName>{entry.name}</CandidateName>
                    <TierBadge $tier={entry.tier}>{entry.tier ?? DASH}</TierBadge>
                  </Candidate>
                ))}
              </Candidates>
            ) : (
              <Empty>No matches in cache yet.</Empty>
            )}
          </Picker>
        )}
      </ScrollArea>
    </Modal>
  )
}

/** One column of the comparison. Same rows on both sides, always, in order. */
function Side({ entry, upgraded }: { entry: LibraryEntry; upgraded: boolean }): JSX.Element {
  const card = entry.kind === 'cards' ? entry.item : null
  const upgradedArt = card ? codexImageUrl(card.image_url_card_upg) : null
  const src = upgraded && upgradedArt ? upgradedArt : entry.art
  const description = upgraded && card?.upgrade_description ? card.upgrade_description : entry.description

  return (
    <Column>
      {entry.kind === 'cards' ? (
        <CardArt>{src ? <Art src={src} alt={entry.name} /> : null}</CardArt>
      ) : (
        <SpriteArt>{src ? <Art src={src} alt={entry.name} /> : null}</SpriteArt>
      )}
      <ColumnName>{entry.name}</ColumnName>
      <Rows>
        <RowLine>
          <span>Tier</span>
          <TierBadge $tier={entry.tier}>{entry.tier ?? DASH}</TierBadge>
        </RowLine>
        <RowLine>
          <span>Score</span>
          <b>{fmtScore(entry.score)}</b>
        </RowLine>
        <RowLine>
          <span>Elo</span>
          <b>{fmtElo(entry.elo)}</b>
        </RowLine>
        <RowLine>
          <span>Win rate</span>
          <b>{fmtPct(entry.winRate)}</b>
        </RowLine>
        <RowLine>
          <span>Sample</span>
          <b>{fmtCount(entry.picks)}</b>
        </RowLine>
      </Rows>
      <Description>
        <RichText text={description} keywords={false} />
      </Description>
    </Column>
  )
}

const Head = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
`

const HeadTitle = styled.h2`
  flex: 1;
  margin: 0;
  font-family: var(--font-display);
  font-size: 17px;
  letter-spacing: 0.5px;
  color: var(--ink);
`

const Picker = styled.div`
  padding: 14px;
`

const Candidates = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  margin-top: 12px;
`

const Candidate = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--fill);
  color: var(--ink);
  font-family: inherit;
  font-size: 12px;
  &:hover {
    background: var(--fill-hover);
    border-color: var(--line-strong);
  }
  &:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
`

const CandidateArt = styled.span`
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
`

const CandidateName = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Grid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  padding: 14px;

  @media (max-width: 520px) {
    grid-template-columns: 1fr;
  }
`

const Column = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
`

const CardArt = styled.div`
  width: 100%;
  aspect-ratio: 400 / 520;
  display: flex;
  align-items: center;
  justify-content: center;
`

const SpriteArt = styled(ArtPlate)`
  width: 100%;
  aspect-ratio: 1;
  padding: 16px;
`

const ColumnName = styled.div`
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.3px;
  color: var(--ink);
`

const Rows = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--fill);
`

const RowLine = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--ink-faint);
  min-height: 22px;
  b {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
`

const Description = styled.div`
  font-size: 12px;
  div {
    font-size: 12px;
  }
`
