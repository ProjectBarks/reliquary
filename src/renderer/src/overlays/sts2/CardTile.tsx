import styled from 'styled-components'
import type { Sts2Card, Sts2CardInfo } from '@shared/types'
import { OutlinedText } from './OutlinedText'
import {
  costColor,
  costStroke,
  frameColor,
  getCardArtUrl,
  getEnchantIconUrl,
  getEnergyIcon,
  MISSING_ENCHANT_ICON,
  rarityColors,
  resolveCost,
  STAR_STROKE,
  type RarityColor
} from './theme'

/**
 * A single deck-tracker row: cost pill, card art bleed, name, optional
 * enchantment icon, and a count/total badge. Ported 1:1 from the original.
 *
 * Height and type scale are driven by the layout engine's density step, so the
 * tile must render exactly `rowH` pixels tall — the engine's arithmetic
 * depends on it.
 */
export function CardTile({
  card,
  jsonCard,
  rowH = 24,
  fontSize = 13,
  countSize = 12
}: {
  card: Sts2Card
  jsonCard?: Sts2CardInfo
  rowH?: number
  fontSize?: number
  countSize?: number
}): JSX.Element {
  const isUpgraded = card.upgradeLevel > 0
  const iconSize = Math.min(20, rowH - 4)
  return (
    <Row
      $color={frameColor(jsonCard?.color)}
      $rarityColor={rarityColors(jsonCard?.rarity)}
      $type={jsonCard?.type?.toLowerCase() ?? ''}
      style={{
        height: rowH,
        ...(card.count === 0 ? { filter: 'brightness(0.45)' } : undefined)
      }}
    >
      {jsonCard ? (
        <RowArt style={{ backgroundImage: `url(${getCardArtUrl(jsonCard.color, card.id)})` }} />
      ) : null}
      <Cost $icon={getEnergyIcon(jsonCard?.color ?? 'colorless')} style={{ width: iconSize, height: iconSize }}>
        <OutlinedText
          text={resolveCost(card, jsonCard) ?? '?'}
          fill={costColor(card.cost, card.defaultCost)}
          stroke={costStroke(jsonCard?.color ?? 'colorless')}
          fontSize={fontSize}
        />
      </Cost>
      {jsonCard?.starCost ? (
        <Cost $icon={getEnergyIcon('star')} style={{ marginLeft: -4, width: iconSize, height: iconSize }}>
          <OutlinedText
            text={jsonCard.starCost}
            fill="var(--sts-color-cream)"
            stroke={STAR_STROKE}
            fontSize={fontSize}
          />
        </Cost>
      ) : null}
      <Name>
        <OutlinedText
          text={jsonCard?.name ?? card.id + (isUpgraded ? '+' : '')}
          fill={isUpgraded ? 'var(--sts-color-green)' : 'var(--sts-color-cream)'}
          stroke={isUpgraded ? '#1c5f2e' : '#4f4547'}
          fontSize={fontSize}
          fontWeight={400}
        />
        {card.enchantment ? (
          <EnchantIcon
            src={getEnchantIconUrl(card.enchantment)}
            onError={(e) => {
              if (e.currentTarget.src !== MISSING_ENCHANT_ICON) {
                e.currentTarget.src = MISSING_ENCHANT_ICON
              }
            }}
          />
        ) : null}
      </Name>
      {(card.total ?? 0) > 1 ? (
        <Count
          $color={frameColor(jsonCard?.color)}
          style={{ height: rowH, width: rowH >= 22 ? 30 : 26 }}
        >
          <OutlinedText
            text={`${card.count}/${card.total}`}
            fill="var(--sts-color-cream)"
            stroke="#4f4547"
            fontSize={countSize}
          />
        </Count>
      ) : null}
    </Row>
  )
}

const Row = styled.div<{ $color: string; $rarityColor: RarityColor; $type: string }>`
  position: relative;
  display: flex;
  align-items: center;
  height: 24px;
  gap: 2px;
  padding-left: 2px;
  overflow: hidden;
  border-radius: 5px;

  border-width: 1px;
  border-style: solid;
  border-color: var(--sts-${(p) => p.$color}-frame-edge);
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--sts-${(p) => p.$color}-frame);
  box-shadow: inset 0 0 2px 2px oklch(0 0 0 / 30%);
  background: oklch(from var(--sts-${(p) => p.$color}-frame) calc(l * 0.8) calc(c * 0.5) h);

  ${(p) =>
    (p.$type === 'status' || p.$type === 'quest' || p.$type === 'curse') &&
    `
      border-color: ${p.$rarityColor.light};
      outline-color: ${p.$rarityColor.dark};
      background: oklch(from ${p.$rarityColor.dark} calc(l * 0.8) calc(c * 0.5) h);
    `}
`

const RowArt = styled.div`
  position: absolute;
  inset: 0;
  z-index: 0;
  background-size: 80%;
  background-position: 180% 26%;
  background-repeat: no-repeat;
  opacity: 1;
  mask-image: linear-gradient(115deg, transparent 0%, transparent 40%, black 65%, black 100%);
  pointer-events: none;
  box-shadow: inset 0 0 2px 2px oklch(0 0 0 / 30%);
`

const Cost = styled.div<{ $icon: string }>`
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-image: url(${(p) => p.$icon});
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
`

const Name = styled.div`
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
`

const EnchantIcon = styled.img`
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  object-fit: contain;
  filter: drop-shadow(1px 1px 0 oklch(0 0 0 / 40%));
`

const Count = styled.div<{ $color: string }>`
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  width: 30px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: oklch(0 0 0 / 40%);
`
