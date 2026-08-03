/**
 * Pure readers that walk the live StS2 scene tree and return plain snapshots.
 *
 * Ported from the original companion's scry readers (decomp/scry:
 * ScrySts2PileState@9802, ScrySts2NGame@9088, toCardData@9862). Each function
 * throws if the tree isn't in the expected shape; the polling loop in
 * provider.ts catches and backs off. Stateful bits (card cycling) live in the
 * provider, not here.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { GodotContext } from './godot'
import {
  CombatManager,
  NCombatRoom,
  NEventRoom,
  NGame,
  NGridCardHolder,
  NMerchantRoom,
  NRun,
  ReleaseInfoManager,
  findLocalPlayer,
  type CardModel
} from './models'

/** A card as read from memory, plus its base address for cycle de-duplication. */
export interface RawCard {
  id: string
  upgradeLevel: number
  enchantment: string | null
  costsX: boolean
  cost: number | null
  defaultCost: number | null
  isPermanent: boolean
  baseAddress: any
}

export function toCardData(card: CardModel): RawCard {
  const energyCost = card._energyCost
  return {
    id: card.Id.Entry,
    upgradeLevel: card._currentUpgradeLevel,
    enchantment: card.Enchantment?.Id.Entry ?? null,
    costsX: energyCost?.CostsX ?? false,
    cost: energyCost?.getCurrentCost() ?? null,
    defaultCost: energyCost?.Canonical ?? null,
    isPermanent: card._deckVersion !== null,
    baseAddress: card.baseAddress
  }
}

export interface RawPileState {
  draw: RawCard[]
  discard: RawCard[]
  hand: RawCard[]
  /** Exhaust pile — not drawable this combat, but part of the owned deck. */
  exhaust: RawCard[]
}

/** Returns null when the player is not currently in a combat room. */
export function readPileState(context: GodotContext): RawPileState | null {
  const nGame = NGame.getInstance(context)
  const scene = nGame.getCurrentScene()
  if (!scene || (scene as any).className !== NRun.ClassName) return null
  const run = scene as NRun
  const currentRoom = run.getCurrentRoom()
  if (!currentRoom || (currentRoom as any).className !== NCombatRoom.ClassName) return null

  const combatRoom = currentRoom as NCombatRoom
  const piles = combatRoom.Ui._combatPilesContainer
  const draw = piles._drawPile._pile?._cards
  const discard = piles._discardPile._pile?._cards
  const exhaust = piles._exhaustPile._pile?._cards
  const hand = findLocalPlayer(context, run)?.PlayerCombatState?.Hand._cards

  return {
    draw: draw ? draw.map((c) => toCardData(c as CardModel)) : [],
    discard: discard ? discard.map((c) => toCardData(c as CardModel)) : [],
    hand: hand ? hand.map((c) => toCardData(c as CardModel)) : [],
    exhaust: exhaust ? exhaust.map((c) => toCardData(c as CardModel)) : []
  }
}

export interface RawEnemiesState {
  enemies: Array<{ intents: Array<{ type: string; valueLabel: string }> }>
  isCombatInProgress: boolean
  currentSide: number
}

/** Returns null when not in a combat room. */
export function readEnemiesState(context: GodotContext): RawEnemiesState | null {
  const nGame = NGame.getInstance(context)
  const scene = nGame.getCurrentScene()
  if (!scene || (scene as any).className !== NRun.ClassName) return null
  const run = scene as NRun
  const currentRoom = run.getCurrentRoom()
  if (!currentRoom || (currentRoom as any).className !== NCombatRoom.ClassName) return null

  const room = currentRoom as NCombatRoom
  const combatManager = CombatManager.getInstance(context)
  const enemies: RawEnemiesState['enemies'] = []
  for (const enemy of room.getEnemyNCreatures()) {
    if (enemy.Entity._currentHp <= 0) continue
    const intents: Array<{ type: string; valueLabel: string }> = []
    for (const intent of enemy.getIntents()) {
      intents.push({ type: intent._intent.className, valueLabel: intent.getIntentLabelText() })
    }
    enemies.push({ intents })
  }
  return {
    enemies,
    isCombatInProgress: combatManager?.isInProgress() ?? false,
    currentSide: room._visuals.CombatState.CurrentSide
  }
}

export interface RawNGameState {
  roomType: string | null
  isMapOpen: boolean
  isTraveling: boolean
  isSubMenuOpen: boolean
  isGameOver: boolean
  capstoneScreen: boolean
  isInspectCardScreenOpen: boolean
  isInspectRelicScreenOpen: boolean
  currentActIndex: number
  characterId: string | null
}

/** Top-level UI/room state used to gate which overlays are visible. */
export function readNGameState(context: GodotContext): RawNGameState | null {
  const nGame = NGame.getInstance(context)
  const scene = nGame.getCurrentScene()
  if (!scene || (scene as any).className !== NRun.ClassName) return null
  const run = scene as NRun
  const globalUi = run.GlobalUi
  const currentRoom = run.getCurrentRoom()

  let roomType: string | null = null
  const roomClass = currentRoom ? (currentRoom as any).className : null
  if (roomClass === NCombatRoom.ClassName) roomType = 'combat'
  else if (roomClass && roomClass.endsWith('NMerchantRoom')) roomType = 'merchant'
  else if (roomClass && roomClass.endsWith('NEventRoom')) roomType = 'event'
  else if (currentRoom) roomType = 'other'

  let isGameOver = false
  for (const overlay of globalUi.Overlays._overlays) {
    if (overlay?.isNGameOverScreen()) isGameOver = true
  }

  const inspectCard = safe(() => nGame.InspectCardScreen?.getControl()?.isVisible() ?? false, false)
  const inspectRelic = safe(
    () => nGame.InspectRelicScreen?.getControl()?.isVisible() ?? false,
    false
  )

  const localPlayer = findLocalPlayer(context, run)

  return {
    roomType,
    isMapOpen: safe(() => globalUi.MapScreen.IsOpen, false),
    isTraveling: safe(() => globalUi.MapScreen.IsTraveling, false),
    isSubMenuOpen: safe(() => globalUi.SubmenuStack.Stack._submenus.count > 0, false),
    isGameOver,
    capstoneScreen: safe(() => globalUi.CapstoneContainer.CurrentCapstoneScreen !== null, false),
    isInspectCardScreenOpen: inspectCard,
    isInspectRelicScreenOpen: inspectRelic,
    currentActIndex: safe(() => run._state._currentActIndex, 0),
    characterId: localPlayer ? safe(() => localPlayer.getCharacterId(), null) : null
  }
}

// ── offered items (card reward / merchant / ancient choice) ──────────────────

/** One offered item with a live, screen-fraction anchor computed from memory. */
export interface RawItem {
  kind: 'card' | 'relic' | 'potion' | 'choice'
  id: string | null
  cost?: number
  isHovered: boolean
  /**
   * Anchor as a fraction [0..1] of the game window. This is the item's CENTRE:
   * StS2 item controls are centre-anchored, so getGlobalPosition() returns the
   * centre, not the top-left. Consumers must offset by w/h to place a tip beside
   * the item (mirrors the original's getCanvasItemData + useHoverTipPosition).
   */
  cx: number
  cy: number
  /** Item size as a fraction [0..1] of the game window (hitbox size). */
  w: number
  h: number
}

export interface RawVisibleItems {
  /**
   * cardReward   — genuine add-a-card reward (deck-additive)
   * chooseACard  — choose-a-card selection, e.g. from an event (deck-additive)
   * grid         — grid selection: removal / transform / upgrade / deck view
   *                (NOT additive — must not get "add to your deck" advice)
   * merchant     — shop stock · ancient — ancient event choices
   */
  source: 'cardReward' | 'chooseACard' | 'grid' | 'merchant' | 'ancient'
  items: RawItem[]
}

/**
 * Normalise a control's global position + size to screen fractions. Mirrors the
 * original's getCanvasItemData: cx/cy are the item's global position over screen
 * size, w/h are the hitbox size over screen size.
 */
function itemFraction(
  screenSize: [number, number],
  control: any,
  hitbox: any,
  position?: [number, number]
): { cx: number; cy: number; w: number; h: number } {
  const pos = position ?? control.getGlobalPosition()
  const size = hitbox.getSize()
  return {
    cx: pos[0] / screenSize[0],
    cy: pos[1] / screenSize[1],
    w: size[0] / screenSize[0],
    h: size[1] / screenSize[1]
  }
}

/**
 * Reads whatever selectable items are currently on screen — the offered cards on
 * a reward/selection overlay, the merchant's stock, or an ancient event's
 * choices — each with a live position pulled from the scene tree. Returns null
 * when nothing selectable is showing. Only ids/positions/costs come from memory;
 * win-rate style stats are not available here (they need the stats HTTP API).
 */
export function readVisibleItems(context: GodotContext): RawVisibleItems | null {
  const nGame = NGame.getInstance(context)
  const scene = nGame.getCurrentScene()
  if (!scene || (scene as any).className !== NRun.ClassName) return null
  const run = scene as NRun
  const screenSize = run.GlobalUi.getSize()
  if (!screenSize || !screenSize[0] || !screenSize[1]) return null

  // 1) Card-selection overlay on top. These are DISTINCT screens: only the reward
  // and choose-a-card screens are deck-additive; grid screens (removal / transform
  // / upgrade / deck view) are not and must not be scored as "add to your deck".
  const overlay = run.getCurrentOverlay()
  if (overlay) {
    let holders: NGridCardHolder[] | null = null
    let source: RawVisibleItems['source'] = 'cardReward'
    let isGrid = false
    if (overlay.isNCardRewardSelectionScreen()) {
      holders = overlay.asNCardRewardSelectionScreen()._cardRow.getCardHolders()
      source = 'cardReward'
    } else if (overlay.isNChooseACardSelectionScreen()) {
      holders = overlay.asNChooseACardSelectionScreen()._cardRow.getCardHolders()
      source = 'chooseACard'
    } else if (overlay.isNCardGridSelectionScreen()) {
      holders = overlay.asNCardGridSelectionScreen()._grid.getCardHolders()
      source = 'grid'
      isGrid = true
    }
    if (holders) {
      const items: RawItem[] = []
      for (const holder of holders) {
        const control = holder.getControl()
        if (!control.isVisible()) continue
        // Grid screens carry not-yet-laid-out holders at local [0,0]; skip them so
        // their tips don't stack in the top-left corner (mirrors the original).
        if (isGrid) {
          const local = safe(() => control.getPosition() as [number, number], [0, 0])
          if (local[0] === 0 && local[1] === 0) continue
        }
        const { cx, cy, w, h } = itemFraction(screenSize, control, holder._hitbox.getControl())
        items.push({
          kind: 'card',
          id: safe(() => holder._baseCard.Id.Entry, null),
          isHovered: safe(() => holder._isHovered, false),
          cx,
          cy,
          w,
          h
        })
      }
      return { source, items }
    }
  }

  // 2) Merchant room stock.
  const room = run.getCurrentRoom()
  const roomClass = room ? (room as any).className : null
  if (roomClass === NMerchantRoom.ClassName) {
    const inv = (room as NMerchantRoom).Inventory
    if (!inv.IsOpen) return { source: 'merchant', items: [] }
    const items: RawItem[] = []
    for (const slot of [...inv.getCharacterCardSlots(), ...inv.getColorlessCardSlots()]) {
      const id = safe(() => slot.getCardId(), null)
      if (!id) continue
      const control = slot.getControl()
      if (!control.isVisible()) continue
      const { cx, cy, w, h } = itemFraction(screenSize, control, slot._hitbox.getControl())
      items.push({ kind: 'card', id, cost: safe(() => slot.getCost(), undefined), isHovered: safe(() => slot._isHovered, false), cx, cy, w, h })
    }
    for (const slot of inv.getRelicSlots()) {
      const id = safe(() => slot.getRelicId(), null)
      if (!id) continue
      const control = slot.getControl()
      if (!control.isVisible()) continue
      const pos = slot.computeGlobalPosition(screenSize)
      const { cx, cy, w, h } = itemFraction(screenSize, control, slot._hitbox.getControl(), pos)
      items.push({ kind: 'relic', id, cost: safe(() => slot.getCost(), undefined), isHovered: safe(() => slot._isHovered, false), cx, cy, w, h })
    }
    for (const slot of inv.getPotionSlots()) {
      const id = safe(() => slot.getPotionId(), null)
      if (!id) continue
      const control = slot.getControl()
      if (!control.isVisible()) continue
      const pos = slot.computeGlobalPosition(screenSize)
      const { cx, cy, w, h } = itemFraction(screenSize, control, slot._hitbox.getControl(), pos)
      items.push({ kind: 'potion', id, cost: safe(() => slot.getCost(), undefined), isHovered: safe(() => slot._isHovered, false), cx, cy, w, h })
    }
    return { source: 'merchant', items }
  }

  // 3) Ancient event choices.
  if (roomClass === NEventRoom.ClassName) {
    const ancient = (room as NEventRoom).getAncientLayout()
    if (ancient) {
      const containerPos = ancient._optionsContainer.computeGlobalPosition(screenSize)
      const items: RawItem[] = []
      for (const button of ancient.getOptionButtons()) {
        const control = button.getControl()
        if (!control.isVisible()) continue
        if (safe(() => button.Option.IsProceed, false)) continue
        const local = control.getPosition()
        const pos: [number, number] = [containerPos[0] + local[0], containerPos[1] + local[1]]
        const { cx, cy, w, h } = itemFraction(screenSize, control, control, pos)
        items.push({
          kind: 'choice',
          id: safe(() => button.Option.getChoiceId(), null),
          isHovered: safe(() => button._isHovered, false),
          cx,
          cy,
          w,
          h
        })
      }
      return { source: 'ancient', items }
    }
  }

  return null
}

/** The running game's build version, used to fetch matching card metadata. */
export function readGameVersion(context: GodotContext): string | null {
  const mgr = ReleaseInfoManager.getInstance(context)
  if (!mgr) return null
  try {
    return mgr.ReleaseInfo.Version
  } catch {
    return null
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
