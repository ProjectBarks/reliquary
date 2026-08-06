/**
 * StS2 scene-tree model classes, ported from the original companion's scry
 * bundle (decomp/scry). Each class wraps a live .NET/Godot object and exposes
 * the fields the readers walk. Only the subset needed to drive the implemented
 * overlays (deck tracker + attack summary + overlay gating) is ported here.
 *
 * Class/field names must match the game exactly — they are read out of process
 * memory by the native module, so these strings are the real contract.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  List,
  ScryObject,
  ScryGodotObject,
  Stack,
  getValid,
  getValidOrNull
} from './scryObject'
import type { GodotContext } from './godot'

// ── card models ────────────────────────────────────────────────────────────

export class ModelId extends ScryObject {
  get Entry(): string {
    return this.string('Entry') as string
  }
}

export class AbstractModel extends ScryObject {
  get Id(): ModelId {
    return new ModelId(this.object('Id'))
  }
}

const LOCAL_COST_ABSOLUTE = 1

export class LocalCostModifier extends ScryObject {
  get Amount(): number {
    return this.number('Amount') as number
  }
  get Type(): number {
    return this.number('Type') as number
  }
  get IsReduceOnly(): boolean {
    return this.boolean('IsReduceOnly') as boolean
  }
  modify(cost: number): number {
    const amount = this.Amount
    if (this.Type === LOCAL_COST_ABSOLUTE) {
      return this.IsReduceOnly ? Math.min(cost, amount) : amount
    }
    return this.IsReduceOnly ? Math.min(cost, cost + amount) : cost + amount
  }
}

export class CardEnergyCost extends ScryObject {
  get _base(): number {
    return this.number('_base') as number
  }
  get Canonical(): number {
    return this.number('Canonical') as number
  }
  get CostsX(): boolean {
    return this.boolean('CostsX') as boolean
  }
  get _localModifiers(): List<LocalCostModifier> {
    return new List(this.object('_localModifiers'), LocalCostModifier)
  }
  getCurrentCost(): number {
    let cost = this._base
    for (const modifier of this._localModifiers) {
      if (modifier) cost = modifier.modify(cost)
    }
    return Math.max(0, cost)
  }
}

export class CardModel extends AbstractModel {
  get _currentUpgradeLevel(): number {
    return this.number('_currentUpgradeLevel') as number
  }
  get _energyCost(): CardEnergyCost | null {
    const value = this.object('_energyCost', true)
    return value ? new CardEnergyCost(value) : null
  }
  get Enchantment(): AbstractModel | null {
    const value = this.object('Enchantment', true)
    return value ? new AbstractModel(value) : null
  }
  get Affliction(): AbstractModel | null {
    const value = this.object('Affliction', true)
    return value ? new AbstractModel(value) : null
  }
  get _deckVersion(): AbstractModel | null {
    const value = this.object('_deckVersion', true)
    return value ? new AbstractModel(value) : null
  }
}

// ── combat piles / creatures ─────────────────────────────────────────────────

export class CardPile extends ScryObject {
  get _cards(): List<CardModel> {
    return new List(this.object('_cards'), CardModel)
  }
}

export class PlayerCombatState extends ScryObject {
  get Hand(): CardPile {
    return new CardPile(this.object('Hand'))
  }
}

export class Player extends ScryObject {
  private _netId: number | null = null
  get NetId(): number {
    if (this._netId === null) this._netId = this.number('NetId') as number
    return this._netId
  }
  get Character(): AbstractModel {
    return new AbstractModel(this.object('Character'))
  }
  private _characterId: string | null = null
  getCharacterId(): string {
    if (this._characterId === null) this._characterId = this.Character.Id.Entry
    return this._characterId
  }
  get PlayerCombatState(): PlayerCombatState | null {
    const value = this.object('PlayerCombatState', true)
    return value ? new PlayerCombatState(value) : null
  }
  /**
   * The owned deck, independent of combat.
   *
   * Deck-conditioned advice previously reconstructed this from the combat piles,
   * which only exist inside a fight — so on a reward screen straight after
   * launch there was no deck at all and advice fell back to global stats. This
   * is the real thing and is readable anywhere in a run.
   */
  get Deck(): CardPile | null {
    const value = this.object('Deck', true)
    return value ? new CardPile(value) : null
  }
}

export class Creature extends ScryObject {
  get _currentHp(): number {
    return this.number('_currentHp') as number
  }
}

export class CombatState extends ScryObject {
  get CurrentSide(): number {
    return this.number('CurrentSide') as number
  }
}

export class CombatRoom extends ScryObject {
  get CombatState(): CombatState {
    return new CombatState(this.object('CombatState'))
  }
}

export class NIntent extends ScryGodotObject {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Combat.NIntent'
  get _valueLabel(): ScryGodotObject {
    return new ScryGodotObject(this.object('_valueLabel'))
  }
  get _intent(): ScryGodotObject {
    return new ScryGodotObject(this.object('_intent'))
  }
  getIntentLabelText(): string {
    return this._valueLabel.getRichLabelText()
  }
}

export class NCreature extends ScryGodotObject {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Combat.NCreature'
  get IntentContainer(): ScryGodotObject {
    return new ScryGodotObject(this.object('IntentContainer'))
  }
  get Entity(): Creature {
    return new Creature(this.object('Entity'))
  }
  getIntents(): NIntent[] {
    const intents: NIntent[] = []
    const children = this.IntentContainer.getNode().getChildren()
    for (const child of children) {
      const obj = child.getDotNetCoreObject()
      if (obj?.getClassName() === NIntent.ClassName) intents.push(new NIntent(obj))
    }
    return intents
  }
}

export class NCombatCardPile extends ScryObject {
  get _pile(): CardPile | null {
    const value = this.object('_pile', true)
    return value ? new CardPile(value) : null
  }
}

export class NCombatPilesContainer extends ScryObject {
  get _drawPile(): NCombatCardPile {
    return new NCombatCardPile(this.object('_drawPile'))
  }
  get _exhaustPile(): NCombatCardPile {
    return new NCombatCardPile(this.object('_exhaustPile'))
  }
  get _discardPile(): NCombatCardPile {
    return new NCombatCardPile(this.object('_discardPile'))
  }
}

export class NCombatUi extends ScryObject {
  get _combatPilesContainer(): NCombatPilesContainer {
    return new NCombatPilesContainer(this.object('_combatPilesContainer'))
  }
}

export class NCombatRoom extends ScryObject {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Rooms.NCombatRoom'
  get className(): string {
    return NCombatRoom.ClassName
  }
  get _enemyContainer(): ScryGodotObject {
    return new ScryGodotObject(this.object('_enemyContainer'))
  }
  get _visuals(): CombatRoom {
    return new CombatRoom(this.object('_visuals'))
  }
  get Ui(): NCombatUi {
    return new NCombatUi(this.object('Ui'))
  }
  getEnemyNCreatures(): NCreature[] {
    const enemies: NCreature[] = []
    const children = this._enemyContainer.getNode().getChildren()
    for (const child of children) {
      const obj = child.getDotNetCoreObject()
      if (obj?.getClassName() === NCreature.ClassName) enemies.push(new NCreature(obj))
    }
    return enemies
  }
}

// ── run / global UI ──────────────────────────────────────────────────────────

export const NMerchantRoomClassName = 'MegaCrit.Sts2.Core.Nodes.Rooms.NMerchantRoom'
export const NEventRoomClassName = 'MegaCrit.Sts2.Core.Nodes.Rooms.NEventRoom'
export const NMainMenuClassName = 'MegaCrit.Sts2.Core.Nodes.NMainMenu'
export const NGameOverScreenClassName =
  'MegaCrit.Sts2.Core.Nodes.Screens.GameOverScreen.NGameOverScreen'

export class MapPointRoomHistoryEntry extends ScryObject {
  get RoomType(): number {
    return this.number('RoomType') as number
  }
}

export class RunState extends ScryObject {
  get _currentActIndex(): number {
    return this.number('_currentActIndex') as number
  }
  get _players(): List<Player> {
    return new List(this.object('_players'), Player)
  }
}

export class NMapScreen extends ScryObject {
  get IsOpen(): boolean {
    return this.boolean('IsOpen') as boolean
  }
  get IsTraveling(): boolean {
    return this.boolean('IsTraveling') as boolean
  }
}

export class NRunSubMenuStack extends ScryObject {
  get _submenus(): Stack {
    return new Stack(this.object('_submenus'))
  }
}

export class NCapstoneSubmenuStack extends ScryObject {
  get Stack(): NRunSubMenuStack {
    return new NRunSubMenuStack(this.object('Stack'))
  }
}

export class NCapstoneContainer extends ScryObject {
  get CurrentCapstoneScreen(): ScryGodotObject | null {
    const value = this.object('CurrentCapstoneScreen', true)
    return value ? new ScryGodotObject(value) : null
  }
}

/**
 * A grid-based card select used for ADDITIVE choices — event rewards, discovery
 * effects, "pick a card to gain". It carries a `_grid` like removal/transform
 * screens do, so shape alone cannot tell them apart and it has to be named.
 * Confirmed against a live 5-card add-a-card screen that was being reported as
 * a plain grid and therefore denied deck-conditioned advice.
 */
export const NSimpleCardSelectScreenClassName =
  'MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NSimpleCardSelectScreen'

export class IOverlayScreen extends ScryGodotObject {
  isNSimpleCardSelectScreen(): boolean {
    return this.className === NSimpleCardSelectScreenClassName
  }
  isNGameOverScreen(): boolean {
    return this.className === NGameOverScreenClassName
  }
  isNCardRewardSelectionScreen(): boolean {
    return this.className === NCardRewardSelectionScreen.ClassName
  }
  asNCardRewardSelectionScreen(): NCardRewardSelectionScreen {
    return this.cast(NCardRewardSelectionScreen)
  }
  isNChooseACardSelectionScreen(): boolean {
    return this.className === NChooseACardSelectionScreen.ClassName
  }
  asNChooseACardSelectionScreen(): NChooseACardSelectionScreen {
    return this.cast(NChooseACardSelectionScreen)
  }
  private _isGrid: boolean | null = null
  /**
   * Grid screens are identified by having a `_grid` field rather than by class,
   * because several screens share the grid implementation.
   *
   * The nullable read is load-bearing and was previously self-defeating: passing
   * `true` makes a missing field return null instead of throwing, so the catch
   * this relied on never fired and EVERY non-reward overlay was reported as a
   * grid. Grid is excluded from deck advice, so that silently suppressed
   * "For your deck" on screens that should have had it.
   */
  isNCardGridSelectionScreen(): boolean {
    if (this._isGrid === null) {
      try {
        this._isGrid = this.object('_grid', true) !== null
      } catch {
        this._isGrid = false
      }
    }
    return this._isGrid
  }
  asNCardGridSelectionScreen(): NCardGridSelectionScreen {
    return this.cast(NCardGridSelectionScreen)
  }
}

// ── card-selection overlays (card reward / choose-a-card / grid) ──────────────

export class NGridCardHolder extends ScryGodotObject {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Cards.Holders.NGridCardHolder'
  get _isHovered(): boolean {
    return this.boolean('_isHovered') as boolean
  }
  get _baseCard(): CardModel {
    return new CardModel(this.object('_baseCard'))
  }
  get _hitbox(): ScryGodotObject {
    return new ScryGodotObject(this.object('_hitbox'))
  }
}

/** Walks a container node's children, keeping only NGridCardHolder instances. */
function collectCardHolders(container: ScryGodotObject): NGridCardHolder[] {
  const holders: NGridCardHolder[] = []
  for (const child of container.getNode().getChildren()) {
    const obj = child.getDotNetCoreObject()
    if (obj?.getClassName() === NGridCardHolder.ClassName) holders.push(new NGridCardHolder(obj))
  }
  return holders
}

export class CardRowControl extends ScryGodotObject {
  getCardHolders(): NGridCardHolder[] {
    return collectCardHolders(this)
  }
}

export class NCardGrid extends ScryGodotObject {
  get _scrollContainer(): ScryGodotObject {
    return new ScryGodotObject(this.object('_scrollContainer'))
  }
  getCardHolders(): NGridCardHolder[] {
    return collectCardHolders(this._scrollContainer)
  }
}

export class NCardRewardSelectionScreen extends IOverlayScreen {
  static ClassName =
    'MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NCardRewardSelectionScreen'
  get _cardRow(): CardRowControl {
    return new CardRowControl(this.object('_cardRow'))
  }
}

export class NChooseACardSelectionScreen extends IOverlayScreen {
  static ClassName =
    'MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NChooseACardSelectionScreen'
  get _cardRow(): CardRowControl {
    return new CardRowControl(this.object('_cardRow'))
  }
}

export class NCardGridSelectionScreen extends IOverlayScreen {
  get _grid(): NCardGrid {
    return new NCardGrid(this.object('_grid'))
  }
}

export class NOverlayStack extends ScryObject {
  get _overlays(): List<IOverlayScreen> {
    return new List(this.object('_overlays'), IOverlayScreen)
  }
}

export class NGlobalUi extends ScryGodotObject {
  get Overlays(): NOverlayStack {
    return new NOverlayStack(this.object('Overlays'))
  }
  get MapScreen(): NMapScreen {
    return new NMapScreen(this.object('MapScreen'))
  }
  get SubmenuStack(): NCapstoneSubmenuStack {
    return new NCapstoneSubmenuStack(this.object('SubmenuStack'))
  }
  get CapstoneContainer(): NCapstoneContainer {
    return new NCapstoneContainer(this.object('CapstoneContainer'))
  }
}

export class NSceneContainer extends ScryObject {
  get _currentScene(): any {
    return this.object('_currentScene', true)
  }
}

// ── merchant room ────────────────────────────────────────────────────────────

export class CardCreationResult extends ScryObject {
  get originalCard(): AbstractModel {
    return new AbstractModel(this.object('originalCard'))
  }
}

export class NMerchantSlot extends ScryGodotObject {
  get _isHovered(): boolean {
    return this.boolean('_isHovered') as boolean
  }
  get _hitbox(): ScryGodotObject {
    return new ScryGodotObject(this.object('_hitbox'))
  }
  get _costLabel(): ScryGodotObject {
    return new ScryGodotObject(this.object('_costLabel'))
  }
  /** Final displayed price (after discounts), or undefined if the label isn't a number. */
  getCost(): number | undefined {
    const parsed = parseInt(this._costLabel.getLabelText(), 10)
    return Number.isNaN(parsed) ? undefined : parsed
  }
}

export class NMerchantCard extends NMerchantSlot {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantCard'
  /** The offered card's id, or null if the slot is sold out / empty. */
  getCardId(): string | null {
    const entry = this.object('_cardEntry', true)
    if (!entry) return null
    const creation = new ScryObject(entry).object('CreationResult', true)
    if (!creation) return null
    return new CardCreationResult(creation).originalCard.Id.Entry
  }
}

export class NMerchantPotion extends NMerchantSlot {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantPotion'
  getPotionId(): string | null {
    const entry = this.object('_potionEntry', true)
    if (!entry) return null
    const model = new ScryObject(entry).object('Model', true)
    if (!model) return null
    return new AbstractModel(model).Id.Entry
  }
}

export class NMerchantRelic extends NMerchantSlot {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantRelic'
  getRelicId(): string | null {
    const entry = this.object('_relicEntry', true)
    if (!entry) return null
    const model = new ScryObject(entry).object('Model', true)
    if (!model) return null
    return new AbstractModel(model).Id.Entry
  }
}

/** Walks a merchant container's children, keeping only slots of the given class. */
function collectMerchantSlots<T extends NMerchantSlot>(
  container: ScryGodotObject,
  ctor: { new (obj: any): T; ClassName: string }
): T[] {
  const slots: T[] = []
  for (const child of container.getNode().getChildren()) {
    const obj = child.getDotNetCoreObject()
    if (obj?.getClassName() === ctor.ClassName) slots.push(new ctor(obj))
  }
  return slots
}

export class NMerchantInventory extends ScryGodotObject {
  get IsOpen(): boolean {
    return this.boolean('IsOpen') as boolean
  }
  getCharacterCardSlots(): NMerchantCard[] {
    return collectMerchantSlots(
      new ScryGodotObject(this.object('_characterCardContainer')),
      NMerchantCard
    )
  }
  getColorlessCardSlots(): NMerchantCard[] {
    return collectMerchantSlots(
      new ScryGodotObject(this.object('_colorlessCardContainer')),
      NMerchantCard
    )
  }
  getPotionSlots(): NMerchantPotion[] {
    return collectMerchantSlots(
      new ScryGodotObject(this.object('_potionContainer')),
      NMerchantPotion
    )
  }
  getRelicSlots(): NMerchantRelic[] {
    return collectMerchantSlots(
      new ScryGodotObject(this.object('_relicContainer')),
      NMerchantRelic
    )
  }
}

export class NMerchantRoom extends ScryObject {
  static ClassName = NMerchantRoomClassName
  get Inventory(): NMerchantInventory {
    return new NMerchantInventory(this.object('Inventory'))
  }
}

// ── event / ancient room ─────────────────────────────────────────────────────

export class EventOption extends ScryObject {
  get TextKey(): string {
    return this.string('TextKey') as string
  }
  get IsProceed(): boolean {
    return this.boolean('IsProceed') as boolean
  }
  /** Full TextKey is e.g. NEOW.pages.INITIAL.options.PRECISE_SCISSORS -> PRECISE_SCISSORS. */
  getChoiceId(): string {
    const key = this.TextKey
    const idx = key.lastIndexOf('.')
    return idx === -1 ? key : key.slice(idx + 1)
  }
}

export class NEventOptionButton extends ScryGodotObject {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Events.NEventOptionButton'
  get Option(): EventOption {
    return new EventOption(this.object('Option'))
  }
  get _isHovered(): boolean {
    return this.boolean('_isHovered') as boolean
  }
}

export class NEventLayout extends ScryGodotObject {
  get _optionsContainer(): ScryGodotObject {
    return new ScryGodotObject(this.object('_optionsContainer'))
  }
  getOptionButtons(): NEventOptionButton[] {
    const buttons: NEventOptionButton[] = []
    for (const child of this._optionsContainer.getNode().getChildren()) {
      const obj = child.getDotNetCoreObject()
      if (obj?.getClassName() === NEventOptionButton.ClassName) {
        buttons.push(new NEventOptionButton(obj))
      }
    }
    return buttons
  }
}

export class NAncientEventLayout extends NEventLayout {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.Events.NAncientEventLayout'
}

export class NEventRoom extends ScryObject {
  static ClassName = NEventRoomClassName
  get _eventContainer(): NSceneContainer {
    return new NSceneContainer(this.object('_eventContainer'))
  }
  /** The ancient-choice layout when this event is an ancient event, else null. */
  getAncientLayout(): NAncientEventLayout | null {
    const scene = this._eventContainer._currentScene
    if (!scene) return null
    const sceneObj = new ScryObject(scene)
    if (sceneObj.className === NAncientEventLayout.ClassName) {
      return sceneObj.cast(NAncientEventLayout)
    }
    return null
  }
}

export class NRun extends ScryObject {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.NRun'
  get className(): string {
    return NRun.ClassName
  }
  /**
   * NRun's own children are read on every poll and are legitimately absent while
   * a run loads or tears down. The throwing accessor turned each of those
   * moments into a reported error — "_roomContainer is null" arrived from a real
   * install — when the honest reading is "not yet". Nullable, and callers treat
   * absence as no data for that tick.
   */
  get _state(): RunState | null {
    const value = this.object('_state', true)
    return value ? new RunState(value) : null
  }
  get _roomContainer(): NSceneContainer | null {
    const value = this.object('_roomContainer', true)
    return value ? new NSceneContainer(value) : null
  }
  /** Absent for the same reason, and reported the same way. */
  get GlobalUi(): NGlobalUi | null {
    const value = this.object('GlobalUi', true)
    return value ? new NGlobalUi(value) : null
  }
  getCurrentRoom(): NCombatRoom | ScryObject | null {
    const currentScene = this._roomContainer?._currentScene
    const sceneName = currentScene?.getClassName()
    if (sceneName === NCombatRoom.ClassName) return new NCombatRoom(currentScene)
    if (sceneName === NMerchantRoomClassName) return new NMerchantRoom(currentScene)
    if (sceneName === NEventRoomClassName) return new NEventRoom(currentScene)
    return null
  }
  /** Topmost overlay screen (card reward/selection/game-over), or null. */
  getCurrentOverlay(): IOverlayScreen | null {
    const overlays = this.GlobalUi?.Overlays._overlays
    if (!overlays) return null
    return overlays.length > 0 ? (overlays.last() ?? null) : null
  }
}

export class NInspectScreen extends ScryGodotObject {}

export class NGame extends ScryGodotObject {
  static getInstance(context: GodotContext): NGame {
    return new NGame(getValid(context.getClass('MegaCrit.Sts2.Core.Nodes.NGame'), 'Instance'))
  }
  get RootSceneContainer(): NSceneContainer {
    return new NSceneContainer(this.object('RootSceneContainer'))
  }
  get InspectCardScreen(): NInspectScreen | null {
    const value = this.object('InspectCardScreen', true)
    return value ? new NInspectScreen(value) : null
  }
  get InspectRelicScreen(): NInspectScreen | null {
    const value = this.object('InspectRelicScreen', true)
    return value ? new NInspectScreen(value) : null
  }
  getCurrentScene(): NRun | ScryObject | null {
    const currentScene = this.RootSceneContainer._currentScene
    if (currentScene === null || currentScene === undefined) return null
    const sceneName = currentScene.getClassName()
    if (sceneName === NRun.ClassName) return new NRun(currentScene)
    if (sceneName === NMainMenuClassName) return new ScryObject(currentScene)
    return null
  }
}

// ── managers ─────────────────────────────────────────────────────────────────

export class CombatTurnState extends ScryObject {
  get IsInProgress(): boolean {
    return this.boolean('IsInProgress') as boolean
  }
}

export class CombatManager extends ScryObject {
  static getInstance(context: GodotContext): CombatManager | null {
    const instance = getValidOrNull(
      context.getClass('MegaCrit.Sts2.Core.Combat.CombatManager'),
      'Instance'
    )
    return instance ? new CombatManager(instance) : null
  }
  isInProgress(): boolean {
    try {
      return this._turnState?.IsInProgress ?? false
    } catch {
      return this.boolean('IsInProgress') as boolean
    }
  }
  get _turnState(): CombatTurnState | null {
    const value = this.object('_turnState', true)
    return value ? new CombatTurnState(value) : null
  }
}

export class LocalContext {
  static NetId(context: GodotContext): number | null {
    return getValidOrNull(
      context.getClass('MegaCrit.Sts2.Core.Context.LocalContext'),
      'NetId',
      'number'
    )
  }
}

export class ReleaseInfo extends ScryObject {
  get Version(): string {
    return this.string('Version') as string
  }
}

export class ReleaseInfoManager extends ScryObject {
  static getInstance(context: GodotContext): ReleaseInfoManager | null {
    const instance = getValidOrNull(
      context.getClass('MegaCrit.Sts2.Core.Debug.ReleaseInfoManager'),
      '_instance'
    )
    return instance ? new ReleaseInfoManager(instance) : null
  }
  get ReleaseInfo(): ReleaseInfo {
    return new ReleaseInfo(this.object('ReleaseInfo'))
  }
}

export function findLocalPlayer(context: GodotContext, run: NRun): Player | null {
  const state = run._state
  if (!state) return null
  const localNetId = LocalContext.NetId(context)
  for (const player of state._players) {
    if (player && player.NetId === localNetId) return player
  }
  return null
}
