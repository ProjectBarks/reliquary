import type {
  RawCard,
  RawEnemiesState,
  RawItem,
  RawNGameState,
  RawPileState,
  RawVisibleItems
} from '../scry/readers'
import type { RawSnapshot } from '../scry/readerProtocol'
import type { RawTapContext } from '../scry/provider'

/**
 * A scripted Ironclad evening, played through the *real* `RunRecorder` in stub
 * mode.
 *
 * Stub mode has no reader, so `onRaw` never fires and the recorder — the one
 * part of the journal that turns polls into meaning — was the only component
 * nothing in the app ever exercised. `runs-stub/catalog.json` stayed empty, and
 * the Journal tab could only be seen through `#/mock/journal`, which is
 * hand-written fixtures rather than anything the recorder produced. This driver
 * closes that loop: observe → record → close → analyse → read it in the tab,
 * with real files on disk at the end of it.
 *
 * Three rules it holds itself to, because a demo that cheats proves nothing:
 *
 *   1. **It only speaks the reader's vocabulary.** Every poll is a `RawSnapshot`
 *      in the exact shape `readers.ts` produces — including the fact that the
 *      room type it can see is only `combat | merchant | event | other`, so a
 *      campfire is `'other'` and an elite is `'combat'`. Nothing here can be
 *      truer than the real reader is.
 *   2. **It goes through the recorder's public surface only** — `observe()` and
 *      `onProcess()`. It never touches the store, never mints a run file, never
 *      writes an event. Every room, pick, upgrade and tally in the resulting
 *      files was *derived*, by the same code that derives them from a real game.
 *   3. **Time is compressed, not faked.** The recorder's injected clocks are
 *      driven by `DemoClock`, so the evening reads as the ~20 minutes it would
 *      have taken while the script finishes in a few seconds. Durations, pace
 *      and timestamps are internally consistent; only the wall between polls is
 *      shorter than life.
 *
 * The script, in order:
 *
 * ```
 *   process attach ─ menu
 *   run A  ironclad, run key R1, 11 rooms across act 1 → act 2
 *          6 fights with real play/draw tallies from per-instance addresses
 *          a card reward taken (pick inferred from the deck delta)
 *          a card reward skipped, a shop purchase, a campfire upgrade
 *          death on floor 11 ─→ closed, queued for analysis
 *   run B  a fresh starter, run key R2, 3 rooms, then the game is closed
 *          ─→ suspended, still starter-shaped and therefore resumable
 *   run C  the game comes back but `RunManager` reads back null this launch,
 *          so the sighting is indistinguishable from run B ─→ D4: a provisional
 *          run and the ambiguity banner
 * ```
 *
 * That last one is the one deliberate arrangement, and it is a real scenario
 * rather than a contortion: `readers.ts` documents `runStartTime` as null
 * "when it could not be read", and the whole point of the D4 window is that two
 * starter-shaped runs with no key evidence between them cannot be told apart.
 */

// ── the clock ────────────────────────────────────────────────────────────────

/**
 * The recorder's `now`/`monotonic`, virtualised — but only once the demo
 * engages it. Un-engaged it *is* the real clock, which is what lets `index.ts`
 * hand it to the recorder without stub-only branches in the recorder itself.
 */
export class DemoClock {
  private wallMs = 0
  private monoMs = 0
  private engaged = false

  /** Start virtual time at `startWall`; from here the driver owns the clock. */
  engage(startWall: number): void {
    this.wallMs = startWall
    this.monoMs = 0
    this.engaged = true
  }

  get virtualElapsedMs(): number {
    return this.monoMs
  }

  /** Move both clocks forward together — they only ever advance in lockstep. */
  advance(ms: number): void {
    if (!this.engaged || ms <= 0) return
    this.wallMs += ms
    this.monoMs += ms
  }

  readonly now = (): number => (this.engaged ? this.wallMs : Date.now())

  readonly monotonic = (): number =>
    this.engaged ? this.monoMs : Number(process.hrtime.bigint() / 1_000_000n)
}

// ── options ──────────────────────────────────────────────────────────────────

/** The half of `RunRecorder` this driver is allowed to touch. */
export interface DemoRecorderSurface {
  observe(raw: RawSnapshot, ctx: RawTapContext): void
  onProcess(state: { detected: boolean }): void
}

export interface JournalDemoOptions {
  recorder: DemoRecorderSurface
  clock: DemoClock
  /** Real milliseconds between polls. The virtual gap is always 250 ms. */
  pollMs?: number
  /**
   * How far in the past the script starts. Chosen so the demo *ends* about a
   * minute before now: the script consumes ~25 virtual minutes, and a run whose
   * last sighting is in the future would read as a clock bug in every relative
   * timestamp the Archive prints.
   */
  spanMs?: number
  log?: (line: string) => void
}

const GAME_VERSION = '1.3.0.123'
/** The reader's real poll interval — the virtual gap between two polls. */
const POLL_VIRTUAL_MS = 250
const DEFAULT_POLL_REAL_MS = 18
/**
 * The script consumes just under 20 virtual minutes (it says so in its own
 * closing log line), so starting 21 minutes back lands the last poll about a
 * minute before real now — recent enough to read as "just now" in the Archive,
 * never ahead of the clock.
 */
const DEFAULT_SPAN_MS = 21 * 60_000

// ── card instances ───────────────────────────────────────────────────────────

/**
 * One card object, with the stable address the play/draw tally is built on. In
 * the game a card keeps its address as it moves between piles, which is exactly
 * what makes "this instance was in hand and is not any more" mean a play — so
 * the demo's addresses have to behave the same way.
 */
interface Inst {
  id: string
  upgrade: number
  addr: string
}

const COSTS: Record<string, number> = {
  STRIKE: 1,
  DEFEND: 1,
  BASH: 2,
  ANGER: 0,
  CLEAVE: 1,
  IRON_WAVE: 1,
  POMMEL_STRIKE: 1,
  SHRUG_IT_OFF: 1,
  INFLAME: 1,
  WHIRLWIND: -1,
  CARNAGE: 2,
  UPPERCUT: 2
}

function rawCard(inst: Inst): RawCard {
  const cost = COSTS[inst.id] ?? 1
  return {
    id: inst.id,
    upgradeLevel: inst.upgrade,
    enchantment: null,
    costsX: cost < 0,
    cost: cost < 0 ? null : cost,
    defaultCost: cost < 0 ? null : cost,
    isPermanent: true,
    baseAddress: inst.addr
  }
}

const INTENTS = [
  [{ type: 'SingleAttackIntent', valueLabel: '12' }],
  [{ type: 'MultiAttackIntent', valueLabel: '6x3' }],
  [
    { type: 'SingleAttackIntent', valueLabel: '20' },
    { type: 'DefendIntent', valueLabel: '' }
  ]
]

// ── the driver ───────────────────────────────────────────────────────────────

export class JournalDemoDriver {
  private readonly recorder: DemoRecorderSurface
  private readonly clock: DemoClock
  private readonly pollMs: number
  private readonly spanMs: number
  private readonly log: (line: string) => void

  private seq = 0
  private addrSeq = 0
  private stopped = false
  private finished: Promise<void> | null = null

  // What the reader would see this poll.
  private detected = false
  private inRun = false
  private character = 'ironclad'
  private act = 0
  private floor = 1
  private roomType: string | null = null
  private traveling = false
  private gameOver = false
  private runStartTime: number | null = null

  private deck: Inst[] = []
  private drawPile: Inst[] = []
  private hand: Inst[] = []
  private discardPile: Inst[] = []
  private exhaustPile: Inst[] = []
  private combatRoom = false
  private inCombat = false
  private enemyCount = 2
  private side = 1
  private intentPhase = 0
  private items: RawVisibleItems | null = null

  constructor(opts: JournalDemoOptions) {
    this.recorder = opts.recorder
    this.clock = opts.clock
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_REAL_MS
    this.spanMs = opts.spanMs ?? DEFAULT_SPAN_MS
    this.log = opts.log ?? ((): void => {})
  }

  /** Runs the whole script. Idempotent: a second call joins the first. */
  start(): Promise<void> {
    if (!this.finished) {
      this.clock.engage(Date.now() - this.spanMs)
      this.finished = this.play()
        .catch((err) => {
          this.log(`aborted: ${err instanceof Error ? err.message : String(err)}`)
        })
        .then(() => {
          this.log(
            `done — ${Math.round(this.clock.virtualElapsedMs / 60_000)} virtual minutes played`
          )
        })
    }
    return this.finished
  }

  /** Resolves when the script has played out (or given up). */
  get done(): Promise<void> {
    return this.finished ?? Promise.resolve()
  }

  /** App quitting mid-script: stop feeding the recorder and let it flush. */
  stop(): void {
    this.stopped = true
  }

  // ── the script ─────────────────────────────────────────────────────────────

  private async play(): Promise<void> {
    this.log('scripted stub run starting — driving the real recorder')

    // The game launches and sits on the main menu: detected, but no run.
    this.recorder.onProcess({ detected: true })
    this.detected = true
    await this.polls(4)
    this.jump(20_000)

    await this.runA()
    await this.runB()
    await this.runC()
  }

  /** The full run: eleven rooms, act 1 → act 2, and a death on the last one. */
  private async runA(): Promise<void> {
    this.log('run A — a full Ironclad run')
    this.beginRun(Math.floor(this.clock.now() / 1000))
    // Three identical polls are a sighting; the fourth is the recorder already
    // recording the room it opened on.
    await this.polls(4)

    // ── act 1 ──
    await this.fight(3, 2)
    await this.offer('cardReward', [{ id: 'ANGER' }, { id: 'CLEAVE' }, { id: 'FLEX' }], 'ANGER')

    await this.travelTo(2, 'event')
    await this.polls(6)

    await this.travelTo(3, 'combat')
    await this.fight(3, 3)
    // Shown, deliberated over, and left on the table: the pick window closes
    // with the deck unchanged, which is how a skip is inferred.
    await this.offer(
      'cardReward',
      [{ id: 'SHRUG_IT_OFF' }, { id: 'CLASH' }, { id: 'THUNDERCLAP' }],
      null
    )

    await this.travelTo(4, 'merchant')
    await this.offer(
      'merchant',
      [
        { id: 'WHIRLWIND', cost: 156 },
        { id: 'SEVER_SOUL', cost: 142 }
      ],
      'WHIRLWIND'
    )
    await this.polls(4)

    // A campfire is an `other` room to the reader — it cannot see the fire.
    await this.travelTo(5, 'other')
    await this.polls(3)
    this.upgrade('BASH')
    await this.polls(3)

    await this.travelTo(6, 'combat')
    await this.fight(3, 2)
    await this.offer(
      'cardReward',
      [{ id: 'POMMEL_STRIKE' }, { id: 'IRON_WAVE' }, { id: 'CLOTHESLINE' }],
      'POMMEL_STRIKE'
    )

    // The elite reads as an ordinary combat room; only the fight is longer.
    await this.travelTo(7, 'combat')
    await this.fight(4, 1)
    await this.offer(
      'cardReward',
      [{ id: 'INFLAME' }, { id: 'HEAVY_BLADE' }, { id: 'RAMPAGE' }],
      'INFLAME'
    )

    await this.travelTo(8, 'combat')
    await this.fight(4, 1)
    await this.polls(4)

    // ── act 2 ──
    await this.travelTo(9, 'combat', 1)
    await this.fight(3, 3)
    await this.offer(
      'cardReward',
      [{ id: 'CARNAGE' }, { id: 'DROPKICK' }, { id: 'RUPTURE' }],
      'CARNAGE'
    )

    await this.travelTo(10, 'event')
    await this.polls(6)

    await this.travelTo(11, 'combat')
    await this.fight(4, 2)

    // Death. Two polls of the game-over screen close the run (Q9's guard).
    this.gameOver = true
    await this.polls(4)
    this.log('run A — died on floor 11')

    // The screen is dismissed and the game returns to its menu.
    this.endRun()
    await this.polls(4)
  }

  /** A second run, abandoned by closing the game while it is still a starter. */
  private async runB(): Promise<void> {
    this.jump(15_000)
    await this.polls(3)
    this.log('run B — a short second run')
    this.beginRun(Math.floor(this.clock.now() / 1000))
    await this.polls(4)

    await this.fight(2, 2)
    // Nothing taken: the deck has to stay starter-shaped for run C's sighting
    // to be genuinely undecidable.
    await this.offer('cardReward', [{ id: 'ANGER' }, { id: 'FLEX' }, { id: 'CLEAVE' }], null)

    await this.travelTo(2, 'event')
    await this.polls(5)

    await this.travelTo(3, 'combat')
    await this.fight(2, 2)
    await this.polls(3)

    // The player closes the game. The detector corroborates it immediately, so
    // there is no menu debounce to wait out.
    this.endRun()
    this.detected = false
    this.recorder.onProcess({ detected: false })
    this.log('run B — game closed, run suspended')
  }

  /**
   * The ambiguity demo. The game comes back, an Ironclad run is on screen with
   * the same untouched starter deck — and this launch cannot read
   * `RunManager._startTime`. With no key on either side and both decks inside
   * the pre-first-pick window, D4 is the honest answer: record into a new
   * provisional file and ask.
   */
  private async runC(): Promise<void> {
    this.jump(45_000)
    this.detected = true
    this.recorder.onProcess({ detected: true })
    await this.polls(4)
    this.log('run C — same starter, no readable run key: the D4 window')
    this.beginRun(null)
    await this.polls(4)

    await this.fight(2, 2)
    await this.travelTo(2, 'event')
    await this.polls(6)
    this.log('run C — left recording, ambiguity unanswered')
  }

  // ── run-level state ────────────────────────────────────────────────────────

  /** A brand new run on floor 1: fresh starter deck, fresh card instances. */
  private beginRun(runStartTime: number | null): void {
    this.inRun = true
    this.gameOver = false
    this.act = 0
    this.floor = 1
    this.roomType = 'combat'
    this.combatRoom = true
    this.inCombat = false
    this.traveling = false
    this.runStartTime = runStartTime
    this.deck = [
      ...this.mintMany('STRIKE', 5),
      ...this.mintMany('DEFEND', 5),
      ...this.mintMany('BASH', 1)
    ]
    this.clearPiles()
    this.items = null
  }

  private endRun(): void {
    this.inRun = false
    this.gameOver = false
    this.inCombat = false
    this.combatRoom = false
    this.items = null
    this.clearPiles()
  }

  private mint(id: string, upgrade = 0): Inst {
    this.addrSeq++
    return { id, upgrade, addr: `0x${(0x14000 + this.addrSeq * 0x40).toString(16)}` }
  }

  private mintMany(id: string, count: number): Inst[] {
    return Array.from({ length: count }, () => this.mint(id))
  }

  /** A campfire smith: one copy leaves, a better one arrives, in one poll. */
  private upgrade(id: string): void {
    const card = this.deck.find((c) => c.id === id && c.upgrade === 0)
    if (card) card.upgrade = 1
  }

  private clearPiles(): void {
    this.drawPile = []
    this.hand = []
    this.discardPile = []
    this.exhaustPile = []
  }

  // ── rooms, offers, fights ──────────────────────────────────────────────────

  /**
   * Walk the map to the next room. The floor is the game's own cumulative
   * counter, and its rising edge is what the recorder counts rooms by.
   */
  private async travelTo(floor: number, roomType: string, act?: number): Promise<void> {
    this.traveling = true
    this.items = null
    this.clearPiles()
    await this.polls(2)
    this.jump(22_000)
    this.floor = floor
    if (act !== undefined) this.act = act
    this.roomType = roomType
    this.combatRoom = roomType === 'combat'
    this.traveling = false
    await this.polls(2)
  }

  /**
   * Cards on offer, and what the deck did about them. The recorder needs the
   * same three stable polls the provider does before it believes a panel, and
   * infers the pick from the deck gaining one of the offered ids — never from
   * anything on screen.
   */
  private async offer(
    source: RawVisibleItems['source'],
    cards: Array<{ id: string; cost?: number }>,
    pick: string | null
  ): Promise<void> {
    this.items = {
      source,
      items: cards.map((card, index): RawItem => {
        const item: RawItem = {
          kind: 'card',
          id: card.id,
          isHovered: index === 0,
          cx: 0.32 + index * 0.18,
          cy: 0.48,
          w: 0.13,
          h: 0.28
        }
        return card.cost === undefined ? item : { ...item, cost: card.cost }
      })
    }
    await this.polls(4)
    this.jump(7_000)
    await this.polls(2)
    this.items = null
    if (pick) this.deck.push(this.mint(pick))
    await this.polls(3)
  }

  /**
   * One fight, poll by poll, so the play and draw tallies are *derived* rather
   * than declared: cards move between real piles and the recorder works out
   * what happened from the addresses, exactly as it does in a live combat.
   *
   * The turn shape matters. A card leaving hand on the player's side is a play;
   * the end-of-turn bulk discard is not, and the recorder tells them apart by
   * the side flag plus a two-poll shadow behind the side change — so the beat
   * after drawing a new hand is deliberate, not padding.
   */
  private async fight(turns: number, enemies: number): Promise<void> {
    this.combatRoom = true
    this.enemyCount = enemies
    this.inCombat = true
    this.side = 1
    this.drawPile = [...this.deck]
    this.hand = []
    this.discardPile = []
    this.exhaustPile = []
    this.draw(5)
    await this.polls(1) // combat_start
    await this.polls(1) // the opening hand counts as drawn

    for (let turn = 0; turn < turns; turn++) {
      this.intentPhase++
      const plays = Math.min(3, this.hand.length)
      for (let i = 0; i < plays; i++) {
        this.playTopCard()
        await this.polls(1)
        this.jump(5_000)
      }
      // The enemy's turn: whatever is left in hand is discarded in bulk.
      this.side = 2
      this.discardPile.push(...this.hand.splice(0, this.hand.length))
      await this.polls(1)
      this.jump(6_000)
      this.side = 1
      this.draw(5)
      await this.polls(2)
    }

    this.inCombat = false
    this.side = 1
    this.clearPiles()
    await this.polls(2) // combat_end
    this.jump(4_000)
  }

  private draw(count: number): void {
    for (let i = 0; i < count; i++) {
      if (!this.drawPile.length) {
        this.drawPile = this.discardPile.splice(0, this.discardPile.length)
        if (!this.drawPile.length) return
      }
      const card = this.drawPile.shift()
      if (card) this.hand.push(card)
    }
  }

  /** A play: out of hand, into the discard — or out of play entirely (powers). */
  private playTopCard(): void {
    const card = this.hand.shift()
    if (!card) return
    if (card.id === 'INFLAME') return // a power leaves play and no pile holds it
    this.discardPile.push(card)
  }

  // ── polling ────────────────────────────────────────────────────────────────

  /** Emit `times` polls, advancing virtual time by the reader's own interval. */
  private async polls(times: number): Promise<void> {
    for (let i = 0; i < times && !this.stopped; i++) {
      this.recorder.observe(this.snapshot(), {
        seq: ++this.seq,
        detected: this.detected,
        errorStreak: 0,
        gameVersion: GAME_VERSION
      })
      this.clock.advance(POLL_VIRTUAL_MS)
      await sleep(this.pollMs)
    }
  }

  /** Virtual time with no polls in it: walking the map, reading an event. */
  private jump(ms: number): void {
    this.clock.advance(ms)
  }

  /** One poll, in the exact shape the reader child puts on the wire. */
  private snapshot(): RawSnapshot {
    if (!this.inRun) return { nGame: null, pile: null, enemies: null, items: null }
    const nGame: RawNGameState = {
      roomType: this.roomType,
      isMapOpen: this.traveling,
      isTraveling: this.traveling,
      isSubMenuOpen: false,
      isGameOver: this.gameOver,
      capstoneScreen: false,
      isInspectCardScreenOpen: false,
      isInspectRelicScreenOpen: false,
      currentActIndex: this.act,
      characterId: this.character,
      playerCount: 1,
      otherCharacterIds: [],
      runStartTime: this.runStartTime,
      totalFloor: this.floor
    }
    const pile: RawPileState = {
      draw: this.drawPile.map(rawCard),
      discard: this.discardPile.map(rawCard),
      hand: this.hand.map(rawCard),
      exhaust: this.exhaustPile.map(rawCard),
      deck: this.deck.map(rawCard),
      deckSize: this.deck.length,
      deckPartial: false
    }
    // `readEnemiesState` returns null outside a combat room — not an empty row.
    const enemies: RawEnemiesState | null = this.combatRoom
      ? {
          enemies: Array.from({ length: this.enemyCount }, () => ({
            intents: INTENTS[this.intentPhase % INTENTS.length]!
          })),
          isCombatInProgress: this.inCombat,
          currentSide: this.side
        }
      : null
    return { nGame, pile, enemies, items: this.items }
  }
}

/**
 * Deliberately *not* unref'd. The gap between two polls is a couple of dozen
 * milliseconds, so it can never hold a quit open for anything a user would
 * notice — and an unref'd timer would let a plain `node` host exit out from
 * under the script, which is exactly how this driver is exercised outside
 * Electron.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
