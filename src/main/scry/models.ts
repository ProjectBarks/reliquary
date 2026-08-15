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
  Dictionary,
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

/** One map point (node) the run has entered, with the rooms it contained. */
export class MapPointHistoryEntry extends ScryObject {
  get Rooms(): List<MapPointRoomHistoryEntry> {
    return new List(this.object('Rooms'), MapPointRoomHistoryEntry)
  }
}

/** `_mapPointHistory` is a List of Lists — one inner list per act. */
export class MapPointHistoryList extends List<MapPointHistoryEntry> {
  constructor(obj: any) {
    super(obj, MapPointHistoryEntry)
  }
}

export class RunState extends ScryObject {
  get _currentActIndex(): number {
    return this.number('_currentActIndex') as number
  }
  get _players(): List<Player> {
    return new List(this.object('_players'), Player)
  }
  /** One inner list of entered map points per act. */
  get _mapPointHistory(): List<MapPointHistoryList> {
    return new List(this.object('_mapPointHistory'), MapPointHistoryList)
  }
  /**
   * Cumulative map points entered across all acts — the game's own floor
   * number. Mirrors the computed `RunState.TotalFloor` (a getter, so it cannot
   * be read directly) and the `floor_reached` metric: the sum of each act's
   * map-point count.
   *
   * This is a real progress clock, and a monotonic one: the journal plan
   * assumed none existed and derived room counts from `roomType`/`isTraveling`
   * edges instead, which silently undercount consecutive same-type rooms.
   */
  getTotalFloor(): number {
    const outer = this._mapPointHistory
    let total = 0
    for (let i = 0; i < outer.length; i++) total += outer.at(i)?.length ?? 0
    return total
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

// ── the game's own hover tips ────────────────────────────────────────────────

/**
 * The game's tip stack: a `VFlowContainer` whose children are the individual
 * keyword/relic/"what does this do" tips, laid out top to bottom.
 *
 * The children are plain Godot controls, not .NET nodes, so they are taken as
 * raw controls (position + size) rather than wrapped — there is nothing else on
 * them worth reading.
 */
export class VFlowContainer extends ScryGodotObject {
  getHoverTips(): any[] {
    return this.getNode().getChildren().map((node: any) => node.castControl())
  }
}

/** The big card preview the game draws beside a hovered card. */
export class NHoverTipCardContainer extends ScryGodotObject {}

/**
 * One live hover-tip set — the popups the GAME itself puts on screen when the
 * player hovers a card, relic, potion or keyword.
 *
 * This is the piece that lets our own stat tip get out of the way instead of
 * landing on top of the game's explanation of the same item. The sets are
 * registered in a static dictionary keyed by their owner, so they are reachable
 * without knowing which screen or room raised them — which matters, because
 * every surface we anchor panels to (card reward, merchant, grid, ancient
 * event) raises them from a different parent.
 *
 * Verified present in the shipping build this was written against (StS2
 * v0.107.1): `NHoverTipSet`, `_activeHoverTips`, `_textHoverTipContainer` and
 * `_cardHoverTipContainer` all appear in `sts2.dll`'s metadata, alongside
 * `res://src/Core/Nodes/HoverTips/NHoverTipSet.cs`.
 */
export class NHoverTipSet extends ScryGodotObject {
  static ClassName = 'MegaCrit.Sts2.Core.Nodes.HoverTips.NHoverTipSet'
  /**
   * The static registry of live tip sets, or null when the class has no such
   * field (a build that renamed it) — never a throw, because "the game is not
   * showing tips" and "we cannot see the tips" must both degrade to the same
   * harmless thing: our panel placing itself the way it always did.
   */
  static getActive(context: GodotContext): Dictionary<NHoverTipSet> | null {
    const dict = getValidOrNull(context.getClass(NHoverTipSet.ClassName), '_activeHoverTips')
    if (!dict) return null
    try {
      return new Dictionary(dict, NHoverTipSet)
    } catch {
      return null
    }
  }
  get _cardHoverTipContainer(): NHoverTipCardContainer | null {
    const value = this.object('_cardHoverTipContainer', true)
    return value ? new NHoverTipCardContainer(value) : null
  }
  get _textHoverTipContainer(): VFlowContainer | null {
    const value = this.object('_textHoverTipContainer', true)
    return value ? new VFlowContainer(value) : null
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

/**
 * The run manager singleton. Only `_startTime` is ported, and it is worth more
 * than its size suggests: it is the single value in memory that identifies
 * *which* run this is.
 *
 * StS2 exposes no run seed and no save-slot id to a memory reader (verified
 * against the full scry decomp: `RunState` carries `_currentActIndex`,
 * `_players` and `_mapPointHistory`, and nothing else). `_startTime` is the
 * substitute the original companion used for exactly this purpose — it keyed
 * its per-run combat history and its "already uploaded" bookkeeping by it, and
 * it equals the `start_time` field the game writes into
 * `saves/current_run.save` and into the completed-run `history/*.run` log. That
 * it lives in the save file is what makes it survive a quit-and-resume, which
 * is the property session matching actually needs.
 *
 * Unverified at runtime (WP3): whether a resumed run reports the *original*
 * start time rather than the time of the resume. Treat it as a strong identity
 * hint that corroborates a deck match, not yet as proof on its own.
 *
 * A real seed does exist, just not here. The game writes it, alongside
 * `start_time`, `ascension`, `build_id`, `game_mode`, `win`, `run_time`, the
 * per-player `{id, character}` list and the full `map_point_history`, into
 * plain JSON under its own user data:
 *
 *     …/SlayTheSpire2/steam/<steamUserId>[/modded]/profile<N>/saves/
 *         current_run.save      ← the live singleplayer run (carries start_time)
 *         current_run_mp.save   ← the live multiplayer run
 *         history/*.run         ← one file per completed run (carries seed, win)
 *
 * Reading those files would make run identity exact and the outcome (win vs
 * loss) unambiguous, which memory alone cannot give us. It is a different
 * mechanism from this reader — a file watcher, plus resolving the Steam user id
 * and active profile — so it is deliberately not attempted here; the note lives
 * where the identity question is asked. Two facts from that layout are worth
 * carrying into the session design regardless: the live save is a *single*
 * file per mode (so the game keeps at most one resumable singleplayer run and
 * one multiplayer run — not one per character), and a run's identity survives
 * quit-and-resume precisely because `start_time` is written into it.
 */
export class RunManager extends ScryObject {
  static getInstance(context: GodotContext): RunManager | null {
    const instance = getValidOrNull(
      context.getClass('MegaCrit.Sts2.Core.Runs.RunManager'),
      'Instance'
    )
    return instance ? new RunManager(instance) : null
  }
  /** Run start timestamp in unix SECONDS (not ms). Equals RunHistory.start_time. */
  get _startTime(): number {
    return this.number('_startTime') as number
  }
  /** The active run's state — the same object `NRun._state` exposes. */
  get State(): RunState | null {
    const value = this.object('State', true)
    return value ? new RunState(value) : null
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

/** Everything one walk of `RunState._players` can answer. */
export interface RunPlayers {
  /**
   * The list's own `_size` — how many players this run has. 1 in singleplayer.
   * Authoritative even when an individual slot fails to read, which is why it
   * is taken from the list rather than from the ids collected below.
   */
  count: number
  /** The player whose `NetId` matches `LocalContext`, or null if unidentifiable. */
  local: Player | null
  /** Character ids of the non-local players, in list order. Empty in singleplayer. */
  otherCharacterIds: string[]
}

/**
 * Walk `RunState._players` once for the local player, the player count and the
 * remote players' characters. `findLocalPlayer` already walked this list for
 * the local seat; the count and the remote ids were simply never surfaced.
 *
 * Returns null when the run has no `_state` (loading or tearing down) so
 * callers can report "unknown" rather than inventing a count of 0 or 1.
 *
 * Deliberately *not* wrapped: the `_players` read and the `NetId` comparison
 * throw here exactly where they threw inside `findLocalPlayer`, so a failed
 * walk keeps costing the whole poll (and incrementing the reader's error
 * streak) instead of quietly degrading into "no local player" — which is
 * indistinguishable from sitting on the main menu. Only the remote character
 * ids, which are new reads, are individually guarded.
 *
 * Caveat (open question Q3): whether `_players` enumerates remote players
 * during a live multiplayer session is implied by the decomp — the local-player
 * filter exists precisely because the list can hold more than one — but has
 * never been verified against a running MP game. Until it is, a genuine MP run
 * may report `count: 1`; consumers must store the count as observed rather than
 * treat 1 as proof of solo.
 */
export function readPlayers(context: GodotContext, run: NRun): RunPlayers | null {
  const state = run._state
  if (!state) return null
  const players = state._players
  const localNetId = LocalContext.NetId(context)
  // A null local NetId (the game is between sessions, or the field moved) means
  // we cannot tell our seat from anyone else's. Report the count — which is
  // still true — and claim nothing about who is who, rather than listing the
  // local player as a stranger.
  if (localNetId === null) return { count: players.length, local: null, otherCharacterIds: [] }

  let local: Player | null = null
  const otherCharacterIds: string[] = []
  for (const player of players) {
    if (!player) continue
    if (!local && player.NetId === localNetId) {
      local = player
      continue
    }
    const id = safeRead(() => player.getCharacterId(), null)
    if (id) otherCharacterIds.push(id)
  }
  return { count: players.length, local, otherCharacterIds }
}

function safeRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
