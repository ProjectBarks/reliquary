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
  NHoverTipSet,
  NMerchantRoom,
  NRun,
  ReleaseInfoManager,
  RunManager,
  findLocalPlayer,
  readPlayers,
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

/**
 * A pile slot can be empty while the game is mutating the list, so this accepts
 * absence rather than trusting a cast. The old call sites wrote
 * `toCardData(c as CardModel)` over a `T | undefined`, which asserted away the
 * one case that actually happens and threw on it — losing the whole poll tick.
 */
export function toCardData(card: CardModel | null | undefined): RawCard | null {
  if (!card) return null
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
  /**
   * The owned deck, read from the player rather than assembled from combat
   * piles. Present outside combat too, which is exactly when card offers appear.
   *
   * May be SHORT — see `deckSize`/`deckPartial` before treating it as the deck.
   */
  deck: RawCard[]
  /**
   * The owned deck list's own `_size`, captured before the cards were
   * materialised, or null when the deck could not be reached at all this poll
   * (no local player, no `Deck` object, or the read threw).
   *
   * `deck.length` alone cannot be trusted as the deck size: `List.map` walks
   * `0..length-1` over a `_version`-keyed `_items` array and the mapper above
   * drops slots that read back empty, so a read racing a game-side mutation
   * returns a short list of *real* cards. Carrying the size lets a consumer
   * tell a 9-card read of a 12-card deck from a genuine 9-card deck.
   */
  deckSize: number | null
  /**
   * True when this deck read is known to be incomplete — either nothing was
   * readable (`deckSize === null`, where the empty array is an absence rather
   * than an empty deck) or fewer cards materialised than `_size` promised.
   *
   * Anything deriving run identity from the deck must discard such a poll
   * outright: a truncated deck hashes to a plausible-looking wrong value, and a
   * failed read that fell back to `[]` looks like a deck that was emptied.
   * A genuinely empty deck reads as `deckSize: 0, deckPartial: false`.
   */
  deckPartial: boolean
}

/** Returns null only when there is no run at all. Piles are empty outside combat. */
export function readPileState(context: GodotContext): RawPileState | null {
  const nGame = NGame.getInstance(context)
  const scene = nGame.getCurrentScene()
  if (!scene || (scene as any).className !== NRun.ClassName) return null
  const run = scene as NRun

  const cards = (list: { map: <R>(fn: (c: CardModel | undefined) => R) => R[] } | undefined | null): RawCard[] =>
    list
      ? list
          .map((c: CardModel | undefined) => toCardData(c))
          .filter((c: RawCard | null): c is RawCard => c !== null)
      : []

  // Read the owned deck first and unconditionally: it is the thing advice needs,
  // and card offers happen outside combat where the piles below do not exist.
  let deck: RawCard[] = []
  let deckSize: number | null = null
  try {
    const player = findLocalPlayer(context, run)
    const pile = player?.Deck
    // Take the list's `_size` BEFORE materialising, so a mutation that lands
    // between the two shows up as a mismatch instead of passing silently.
    const list = pile?._cards ?? null
    if (list) {
      deckSize = list.length
      deck = cards(list)
    }
    if (process.env['SPECTRA_DEBUG']) {
      console.log(
        `[reader] deck read: player=${player ? 'yes' : 'NO'} pile=${pile ? 'yes' : 'NO'} ` +
          `cards=${deck.length} size=${deckSize ?? '?'}`
      )
    }
  } catch (err) {
    // The fallback stays `[]` so existing consumers (which ignore empty deck
    // reads) are unaffected; `deckSize: null` is what tells the new consumers
    // that this emptiness is a failure rather than an answer.
    if (process.env['SPECTRA_DEBUG']) {
      console.log(`[reader] deck read failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const deckPartial = deckSize === null || deck.length !== deckSize

  const currentRoom = run.getCurrentRoom()
  if (!currentRoom || (currentRoom as any).className !== NCombatRoom.ClassName) {
    return { draw: [], discard: [], hand: [], exhaust: [], deck, deckSize, deckPartial }
  }

  const combatRoom = currentRoom as NCombatRoom
  const piles = combatRoom.Ui._combatPilesContainer
  const draw = piles._drawPile._pile?._cards
  const discard = piles._discardPile._pile?._cards
  const exhaust = piles._exhaustPile._pile?._cards
  const hand = findLocalPlayer(context, run)?.PlayerCombatState?.Hand._cards

  return {
    draw: cards(draw),
    discard: cards(discard),
    hand: cards(hand),
    exhaust: cards(exhaust),
    deck,
    deckSize,
    deckPartial
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
  /**
   * 0-based act index, or null when the run has no `_state` yet (loading, or
   * tearing down) or the read failed.
   *
   * Nullable on purpose: this used to fall back to 0, which made "act 1" and
   * "we don't know" the same value. Anything that compares acts across time —
   * "has this run progressed?", "is this the same run?" — reads a load-time 0
   * as a run that went backwards. Null cannot be mistaken for progress.
   */
  currentActIndex: number | null
  characterId: string | null
  /**
   * How many players this run has, from `RunState._players`, or null when the
   * run state was unreadable. 1 in singleplayer.
   *
   * Nullable rather than defaulted to 1 because "we could not read the list"
   * and "this is a solo run" have to stay distinguishable: a run recorded as
   * solo on a bad poll would be compared against the wrong cohort forever.
   * See `readPlayers` for the standing caveat about MP enumeration (Q3).
   */
  playerCount: number | null
  /** Character ids of the other players in the run; empty in singleplayer. */
  otherCharacterIds: string[]
  /**
   * The run's start timestamp in unix SECONDS, from `RunManager.Instance`, or
   * null when it could not be read. The nearest thing to a run id that exists
   * in memory — see `RunManager` in models.ts for what it is, what it is worth,
   * and what still has to be verified before it can be trusted as identity.
   */
  runStartTime: number | null
  /**
   * The game's own cumulative floor number (map points entered across all
   * acts), or null when unreadable. Monotonic within a run, and unlike a
   * counter of our own it does not depend on us having watched the run from
   * its first room.
   */
  totalFloor: number | null
}

/** Top-level UI/room state used to gate which overlays are visible. */
export function readNGameState(context: GodotContext): RawNGameState | null {
  const nGame = NGame.getInstance(context)
  const scene = nGame.getCurrentScene()
  if (!scene || (scene as any).className !== NRun.ClassName) return null
  const run = scene as NRun
  const globalUi = run.GlobalUi
  if (!globalUi) return null
  const currentRoom = run.getCurrentRoom()

  let roomType: string | null = null
  const roomClass = currentRoom ? (currentRoom as any).className : null
  if (roomClass === NCombatRoom.ClassName) roomType = 'combat'
  else if (roomClass && roomClass.endsWith('NMerchantRoom')) roomType = 'merchant'
  else if (roomClass && roomClass.endsWith('NEventRoom')) roomType = 'event'
  else if (currentRoom) roomType = 'other'

  let isGameOver = false
  for (const overlay of globalUi.Overlays._overlays) {
    // The overlay stack can hold an entry the game has already freed, and
    // reading its class dereferences null. Unknown class simply means "not the
    // game-over screen", which is the only thing being asked here.
    if (safe(() => overlay?.isNGameOverScreen() ?? false, false)) isGameOver = true
  }

  const inspectCard = safe(() => nGame.InspectCardScreen?.getControl()?.isVisible() ?? false, false)
  const inspectRelic = safe(
    () => nGame.InspectRelicScreen?.getControl()?.isVisible() ?? false,
    false
  )

  // One walk of the player list answers three questions at once: who we are,
  // how many of us there are, and who the others are. Unguarded, exactly as the
  // bare findLocalPlayer call it replaces — a throw here must keep costing the
  // whole nGame read (and raising the reader's error streak) rather than
  // degrading into a state that looks identical to standing on the main menu.
  const players = readPlayers(context, run)
  const localPlayer = players?.local ?? null

  return {
    roomType,
    isMapOpen: safe(() => globalUi.MapScreen.IsOpen, false),
    isTraveling: safe(() => globalUi.MapScreen.IsTraveling, false),
    isSubMenuOpen: safe(() => globalUi.SubmenuStack.Stack._submenus.count > 0, false),
    isGameOver,
    capstoneScreen: safe(() => globalUi.CapstoneContainer.CurrentCapstoneScreen !== null, false),
    isInspectCardScreenOpen: inspectCard,
    isInspectRelicScreenOpen: inspectRelic,
    currentActIndex: safe(() => run._state?._currentActIndex ?? null, null),
    characterId: localPlayer ? safe(() => localPlayer.getCharacterId(), null) : null,
    playerCount: players?.count ?? null,
    otherCharacterIds: players?.otherCharacterIds ?? [],
    runStartTime: safe(() => RunManager.getInstance(context)?._startTime ?? null, null),
    totalFloor: safe(() => run._state?.getTotalFloor() ?? null, null)
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
  const screenSize = run.GlobalUi?.getSize()
  if (!screenSize || !screenSize[0] || !screenSize[1]) return null

  // 1) Card-selection overlay on top. These are DISTINCT screens: only the reward
  // and choose-a-card screens are deck-additive; grid screens (removal / transform
  // / upgrade / deck view) are not and must not be scored as "add to your deck".
  const overlay = run.getCurrentOverlay()
  if (overlay) {
    let holders: NGridCardHolder[] | null = null
    let source: RawVisibleItems['source'] = 'cardReward'
    let isGrid = false
    if (process.env['SPECTRA_DEBUG']) {
      // The overlay's own class, so a wrong `source` can be traced to the game
      // rather than guessed at from the symptom.
      console.log(`[reader] overlay class: ${safe(() => overlay.className, '?')}`)
    }
    if (overlay.isNCardRewardSelectionScreen()) {
      holders = overlay.asNCardRewardSelectionScreen()._cardRow.getCardHolders()
      source = 'cardReward'
    } else if (overlay.isNChooseACardSelectionScreen()) {
      holders = overlay.asNChooseACardSelectionScreen()._cardRow.getCardHolders()
      source = 'chooseACard'
    } else if (overlay.isNSimpleCardSelectScreen()) {
      // Must precede the grid branch: this screen has a `_grid` and would
      // otherwise be swallowed by it and treated as non-additive.
      holders = overlay.asNCardGridSelectionScreen()._grid.getCardHolders()
      source = 'chooseACard'
      isGrid = true
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

// ── the game's own hover tips ────────────────────────────────────────────────

/**
 * A rectangle over the game window in screen fractions [0..1]. Unlike `RawItem`,
 * whose cx/cy is a CENTRE, x/y here is the TOP-LEFT corner — that is what the
 * tip controls report and what an overlap test wants.
 */
export interface RawRect {
  x: number
  y: number
  w: number
  h: number
}

/** Where the GAME is currently drawing its own popups. */
export interface RawHoverTips {
  /**
   * The tip dictionary's `_version`. Only useful as a cheap "did the set of
   * live tips change" signal; null when it could not be read.
   */
  version: number | null
  /** Keyword / relic / effect tips, stacked vertically beside the hovered thing. */
  text: RawRect[]
  /** The enlarged card preview the game shows beside a hovered card. */
  card: RawRect[]
  /**
   * True when this read is known to be INCOMPLETE rather than empty: the game
   * was mutating the tip dictionary as we walked it, so no rectangles came back
   * and none of them can be trusted to mean "there is nothing there".
   *
   * The same distinction `RawPileState.deckPartial` draws, for the same reason.
   * A torn walk and a quiet screen both produce zero rectangles, and treating
   * the first as the second would have the panel confidently place itself where
   * a tooltip it failed to see is sitting. Consumers hold their last known-good
   * placement through a partial poll instead of acting on it.
   */
  partial: boolean
  /**
   * Null when the read worked — including when it worked and the game simply
   * had no tips up. Otherwise the step that failed and what it saw.
   *
   * This exists because empty and broken were indistinguishable from outside:
   * both produced no rectangles, so a log line saying "no tips" was true of a
   * working reader on a quiet screen AND of a reader that could not find the
   * game's dictionary at all. Carrying the reason over the wire — rather than
   * only logging it in the child — means the one line the provider prints is
   * the whole answer.
   */
  diag: string | null
}

/**
 * Read the rectangles the game's own hover tips occupy.
 *
 * Ported from the original companion's `ScrySts2HoverTips` (decomp/scry:10122-
 * 10210), which existed for exactly the reason we need it: its stat tip had to
 * be placed somewhere that did not cover the game's explanation of the item
 * being hovered. The margin fudges below are its numbers, kept because they
 * describe the game's art, not our layout — the tip frames carry a few pixels
 * of transparent border that would otherwise read as occupied space.
 *
 * Never throws and never returns null: a failure reports itself in `diag` and
 * yields no rectangles, and the renderer treats "no rectangles" as "place the
 * panel the way you always did". A build that renames these fields costs us
 * the improvement and nothing else — but it says so.
 */
/**
 * Consecutive polls whose dictionary walk came back torn, and the running total.
 *
 * The only state in this file, and deliberately so: "has this been failing the
 * whole time or did it just blink?" cannot be answered from a single poll, and
 * that question is the entire difference between a mismatch worth reporting and
 * a race worth ignoring.
 */
let tornStreak = 0
let tornWalks = 0

/**
 * How many consecutive torn walks before it stops being a race and starts being
 * a mismatch. Four polls is a full second at the reader's cadence — orders of
 * magnitude longer than a dictionary rehash, and short enough that a genuine
 * layout break still names itself within a second of the first hover.
 */
const TORN_TOLERANCE = 4

/** True at 1, 10, 100, … — for logging a rate without logging every instance. */
function isMilestone(n: number): boolean {
  return n > 0 && Math.log10(n) % 1 === 0
}

export function readHoverTips(context: GodotContext): RawHoverTips {
  const tips: RawHoverTips = { version: null, text: [], card: [], partial: false, diag: null }
  const fail = (step: string, detail: string): RawHoverTips => {
    tips.diag = `${step}: ${detail}`
    hoverDbg(tips.diag)
    return tips
  }

  let failure: string | null = null
  const dict = NHoverTipSet.getActive(context, (step, detail) => {
    failure = `${step}: ${detail}`
  })
  if (!dict) return fail('getActive', failure ?? 'returned null with no reason')

  const screen = safe(() => NGame.getInstance(context).getSize(), null)
  if (!screen || !screen[0] || !screen[1]) {
    return fail('screenSize', `NGame control size is ${screen ? screen.join('x') : 'unreadable'}`)
  }

  tips.version = safe(() => dict.version, null)
  const count = safe(() => dict.count, -1)
  let sets: NHoverTipSet[]
  try {
    sets = dict.values()
  } catch (err) {
    return fail('values', `${err instanceof Error ? err.message : String(err)} · count=${count}`)
  }
  if (sets.length === 0) {
    // An empty dictionary is the normal state — the game has no tips up most of
    // the time. A dictionary that CLAIMS entries and yields none is something
    // else, and which something else depends on whether it persists: the game
    // rehashing the dictionary under us produces exactly this for a poll or
    // two, while a field-layout mismatch produces it forever. Tearing is not an
    // error and must not be reported as one — a skipped poll costs nothing,
    // because the placement holds its last clear position through it.
    if (count > 0) {
      tornWalks++
      if (++tornStreak < TORN_TOLERANCE) {
        tips.partial = true
        // Counted, not announced: once per order of magnitude, so a persistent
        // background rate is still visible without a line per poll.
        if (isMilestone(tornWalks)) {
          hoverDbg(`transient torn walk (count=${count} yielded nothing) · ${tornWalks} so far`)
        }
        return tips
      }
      return fail(
        'values',
        `dictionary reports count=${count} but yielded no entries on ` +
          `${tornStreak} consecutive polls — a layout mismatch, not tearing`
      )
    }
    tornStreak = 0
    // Version deliberately left out of this line: it changes constantly, and
    // the dedupe is by message, so including it would print a fresh copy of
    // "nothing here" forever and bury the line that matters.
    hoverDbg(`ok, dictionary reachable, no tip sets (count=${count})`)
    return tips
  }

  tornStreak = 0

  let containers = 0
  for (const set of sets) {
    if (!set) continue

    const textContainer = safe(() => set._textHoverTipContainer, null)
    if (textContainer) {
      containers++
      // One walk for the container, then each child's LOCAL offset added to it:
      // the children are laid out by the flow container, so their own global
      // transforms are the ones most likely to be a frame stale.
      const base = safe(() => textContainer.computeGlobalPosition(screen), null)
      const nodes = safe(() => textContainer.getChildNodes(), null)
      if (!base) drop('text', 'base', 'computeGlobalPosition failed on the container')
      if (!nodes) drop('text', 'children', 'child-node walk threw')
      else if (nodes.length === 0) drop('text', 'children', 'container has no child nodes')
      if (base && nodes) {
        for (let i = 0; i < nodes.length; i++) {
          const box = measureTip(nodes[i], base, 1, (why, detail) =>
            drop('text', why, `child#${i} ${detail}`)
          )
          // Adjust for uneven tooltip margins (the original's constants).
          if (box) tips.text.push(toFraction(box, screen, 10.5, 3.5))
        }
      }
    }

    const cardContainer = safe(() => set._cardHoverTipContainer, null)
    if (cardContainer) {
      containers++
      const base = safe(() => cardContainer.computeGlobalPosition(screen), null)
      const size = safe(() => cardContainer.getSize(), null)
      if (!base) {
        drop('card', 'base', 'computeGlobalPosition failed on the container')
      } else if (size && size[0] > 0 && size[1] > 0) {
        tips.card.push(
          toFraction({ x0: base[0], y0: base[1], x1: base[0] + size[0], y1: base[1] + size[1] }, screen, 11, 5)
        )
      } else {
        // The container itself is an unsized wrapper sitting at its parent's
        // origin — confirmed live, 0x0 at 0,0 with one child — so its zero size
        // means "look lower", not "nothing here".
        const kids = safe(() => cardContainer.getChildNodes(), null)
        if (!kids || kids.length === 0) {
          drop(
            'card',
            !size ? 'size-err' : 'zero-size',
            `size=${size ? size.join('x') : 'THREW'} with no children to descend into`
          )
        } else {
          const box = union(
            kids.map((kid: any, i: number) =>
              measureTip(kid, base, 1, (why, detail) => drop('card', why, `child#${i} ${detail}`))
            )
          )
          if (box) tips.card.push(toFraction(box, screen, 11, 5))
        }
      }
    }
  }
  hoverDbg(
    `ok, ${sets.length} tip set(s), ${containers} container(s) → ` +
      `${tips.text.length} text + ${tips.card.length} card rects`
  )
  return tips
}

/** A rectangle in absolute game pixels, as two corners. */
interface PxBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * How deep below a container to look for geometry, counting its direct children
 * as depth 1.
 *
 * The container's own children are what the evidence demanded —
 * `_cardHoverTipContainer` reads 0x0 at its parent's origin with a single child
 * holding the actual card preview — and depth 2 is one level of slack for that
 * same pattern repeating. It costs a handful of reads on a path that only runs
 * while something is hovered. Deeper than that would be guessing at a tree we
 * have not seen.
 */
const MAX_TIP_DESCENT = 2

/**
 * The box a tip node occupies, in game pixels, relative to `base`.
 *
 * A zero size here does not mean "nothing is drawn": the containers in this
 * tree are frequently unsized wrappers sitting at their parent's origin, with
 * the real geometry one level down. So an empty box is a reason to look lower
 * before it is a reason to give up.
 *
 * The UNION of the sized descendants is returned rather than the first one. A
 * wrapper may hold a frame and its shadow as siblings, and for the one thing
 * these rectangles are used for — keeping our panel off the game's tooltip — a
 * rectangle slightly too large is the harmless direction to be wrong in, while
 * picking the wrong single child is not.
 */
function measureTip(
  node: any,
  base: [number, number],
  depth: number,
  drop: (why: string, detail: string) => void
): PxBox | null {
  // Cast per node, not across a list: one non-Control sibling must cost one tip
  // rather than every tip beside it.
  const control = safe(() => node.castControl(), null)
  if (!control) {
    drop('not-control', `depth ${depth}: not castable to a Control`)
    return null
  }
  const pos = safe(() => control.getPosition() as [number, number], null)
  if (!pos) {
    drop('pos-err', `depth ${depth}: getPosition threw`)
    return null
  }
  const size = safe(() => control.getSize() as [number, number], null)
  if (!size) {
    drop('size-err', `depth ${depth}: getSize threw`)
    return null
  }
  const x0 = base[0] + pos[0]
  const y0 = base[1] + pos[1]
  if (size[0] > 0 && size[1] > 0) return { x0, y0, x1: x0 + size[0], y1: y0 + size[1] }

  if (depth >= MAX_TIP_DESCENT) {
    drop('zero-size', `depth ${depth}: 0x0 with no descent budget left`)
    return null
  }
  const children = safe(() => node.getChildren(), null)
  if (!children || children.length === 0) {
    drop('zero-size', `depth ${depth}: 0x0 with no children to descend into`)
    return null
  }
  const box = union(children.map((child: any) => measureTip(child, [x0, y0], depth + 1, drop)))
  if (!box) {
    drop('zero-size', `depth ${depth}: 0x0 and all ${children.length} child(ren) were unusable`)
  }
  return box
}

/** The smallest box containing every box given; null when none survived. */
function union(boxes: Array<PxBox | null>): PxBox | null {
  let result: PxBox | null = null
  for (const box of boxes) {
    if (!box) continue
    result = result
      ? {
          x0: Math.min(result.x0, box.x0),
          y0: Math.min(result.y0, box.y0),
          x1: Math.max(result.x1, box.x1),
          y1: Math.max(result.y1, box.y1)
        }
      : box
  }
  return result
}

/**
 * Absolute game pixels to screen fractions, less the tip art's transparent
 * border (the original's per-container constants) so the frame's margin does
 * not read as occupied space. Clamped at zero: a rectangle smaller than its own
 * margin would otherwise invert.
 */
function toFraction(
  box: PxBox,
  screen: [number, number],
  marginW: number,
  marginH: number
): RawRect {
  return {
    x: box.x0 / screen[0],
    y: box.y0 / screen[1],
    w: Math.max(0, box.x1 - box.x0 - marginW) / screen[0],
    h: Math.max(0, box.y1 - box.y0 - marginH) / screen[1]
  }
}

/**
 * Report why a candidate rectangle was thrown away, once per distinct reason.
 *
 * Counting the rectangles that survived could never explain the ones that did
 * not, and the plausible causes are not variations of one fault: a tip that has
 * not been laid out yet is a transient worth waiting out, a child that will not
 * cast to a Control is a wrong assumption about the container's contents, and a
 * read that throws is a wrong member path. Only the reason separates them.
 */
function drop(kind: 'text' | 'card', why: string, detail: string): void {
  hoverDbg(`${kind} dropped [${why}]: ${detail}`)
}

/** Failure signatures already logged, so one bad hover does not spam the log. */
const hoverSeen = new Set<string>()

/**
 * Log a hover-tip step ONCE per distinct message. The poll runs four times a
 * second and a shape mismatch is identical on every one of them, so an
 * unthrottled line would bury the answer under thousands of copies of itself.
 */
function hoverDbg(message: string): void {
  if (!process.env['SPECTRA_DEBUG']) return
  if (hoverSeen.has(message)) return
  if (hoverSeen.size > 64) hoverSeen.clear()
  hoverSeen.add(message)
  console.log(`[reader] hoverTips ${message}`)
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
