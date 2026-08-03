/**
 * Pure helpers ported from the original StS2 companion (decomp/renderer).
 * Colours, cost resolution, and CDN art URLs — all safe pure functions.
 */
import type { Sts2Card, Sts2CardInfo } from '@shared/types'

/** BaseColors.Background from the original. */
export const BG = '#262321'

export const STS2_CARD_COLORS = [
  'ironclad',
  'silent',
  'regent',
  'necrobinder',
  'defect',
  'colorless'
] as const

const FRAME_COLORS = new Set<string>(STS2_CARD_COLORS)

export function frameColor(color?: string): string {
  if (color && FRAME_COLORS.has(color)) return color
  return 'colorless'
}

export interface RarityColor {
  dark: string
  light: string
}

const RARITY_COLORS: Record<string, RarityColor> = {
  basic: { dark: '#656565', light: '#A3A3A2' },
  common: { dark: '#656565', light: '#A3A3A2' },
  token: { dark: '#656565', light: '#A3A3A2' },
  uncommon: { dark: '#2D9698', light: '#7ADDDD' },
  rare: { dark: '#DB7317', light: '#FFC672' },
  event: { dark: '#398F35', light: '#7ECE78' },
  status: { dark: '#69613D', light: '#A39A79' },
  quest: { dark: '#DB4023', light: '#FF836B' },
  curse: { dark: '#8744E8', light: '#C688FF' },
  ancient: { dark: '#9C6B0F', light: '#EFC851' }
}

export function rarityColors(rarity?: string): RarityColor {
  return RARITY_COLORS[rarity?.toLowerCase() ?? ''] ?? RARITY_COLORS.common
}

export function resolveCost(card: Sts2Card, json?: Sts2CardInfo): string {
  if (card.costsX) return 'X'
  if (card.cost !== null) return String(card.cost)
  if (card.defaultCost !== null) return String(card.defaultCost)
  if (card.upgradeLevel > 0 && json?.upgrade) return json.upgrade.cost
  return json?.cost ?? '?'
}

export function costColor(cost: number | null, defaultCost: number | null): string {
  if (cost === null || defaultCost === null) return 'var(--sts-color-cream)'
  if (cost < defaultCost) return 'var(--sts-color-green)'
  return 'var(--sts-color-cream)'
}

const COST_STROKE: Record<string, string> = {
  ironclad: '#802020',
  silent: '#1a6625',
  defect: '#1d5673',
  necrobinder: '#803367',
  regent: '#803d0e'
}

export function costStroke(color: string): string {
  return COST_STROKE[color] ?? '#5c5440'
}

export const STAR_STROKE = '#0b5d70'

const ART = 'https://sts2json.untapped.gg/art'

export function getCardArtUrl(color: string, id: string): string {
  return `${ART}/card_portraits/${color}/${id.toLowerCase()}.png`
}

export function getEnergyIcon(color: string): string {
  return `${ART}/energy/${color}-text.png`
}

export function getEnchantIconUrl(id: string): string {
  return `${ART}/enchantments/${id.toLowerCase()}.png`
}

export const MISSING_ENCHANT_ICON = getEnchantIconUrl('missing_enchantment')

export function attackIntentAsset(value?: number): string {
  let name = 'intent_attack'
  if (!value || value < 5) name += '_1'
  else if (value < 10) name += '_2'
  else if (value < 20) name += '_3'
  else if (value >= 40) name += '_5'
  else name += '_4'
  return `${ART}/intents/${name}.png`
}
