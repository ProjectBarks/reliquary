import type {
  KeyedSnapshot,
  Sts2Card,
  Sts2CardData,
  Sts2EnemiesState,
  Sts2LayoutState,
  Sts2NGameState,
  Sts2PileState,
  StubScenario
} from '@shared/types'

/**
 * Stub StS2 data provider.
 *
 * Emits believable snapshots for every `sts2.*` key so the overlays can be
 * built and iterated on without the game (or the native scry module) running.
 * A slow timer nudges the combat state so the UI feels alive. The dashboard can
 * switch scenarios to exercise every overlay. Real scry replaces this later
 * with zero renderer changes — the keyed contract is identical.
 */

// ── static card catalogue (mirrors sts2.cardData) ──────────────────────────

const CARD_DATA: Sts2CardData = {
  strike: { name: 'Strike', type: 'Attack', color: 'ironclad', rarity: 'basic', cost: '1' },
  defend: { name: 'Defend', type: 'Skill', color: 'ironclad', rarity: 'basic', cost: '1' },
  bash: { name: 'Bash', type: 'Attack', color: 'ironclad', rarity: 'basic', cost: '2' },
  anger: { name: 'Anger', type: 'Attack', color: 'ironclad', rarity: 'common', cost: '0' },
  cleave: { name: 'Cleave', type: 'Attack', color: 'ironclad', rarity: 'common', cost: '1' },
  iron_wave: { name: 'Iron Wave', type: 'Attack', color: 'ironclad', rarity: 'common', cost: '1' },
  pommel_strike: {
    name: 'Pommel Strike',
    type: 'Attack',
    color: 'ironclad',
    rarity: 'common',
    cost: '1'
  },
  twin_strike: {
    name: 'Twin Strike',
    type: 'Attack',
    color: 'ironclad',
    rarity: 'common',
    cost: '1'
  },
  clothesline: {
    name: 'Clothesline',
    type: 'Attack',
    color: 'ironclad',
    rarity: 'uncommon',
    cost: '2'
  },
  shrug_it_off: {
    name: 'Shrug It Off',
    type: 'Skill',
    color: 'ironclad',
    rarity: 'common',
    cost: '1'
  },
  flex: { name: 'Flex', type: 'Skill', color: 'ironclad', rarity: 'common', cost: '0' },
  inflame: { name: 'Inflame', type: 'Power', color: 'ironclad', rarity: 'uncommon', cost: '1' },
  wound: { name: 'Wound', type: 'Status', color: 'colorless', rarity: 'status' },
  regret: { name: 'Regret', type: 'Curse', color: 'colorless', rarity: 'curse' }
}

function mk(id: string, over: Partial<Sts2Card> = {}): Sts2Card {
  const base = CARD_DATA[id]
  const printed = base?.cost !== undefined ? Number.parseInt(base.cost) : null
  return {
    id,
    upgradeLevel: 0,
    enchantment: null,
    isPermanent: false,
    hasBeenCycled: false,
    cost: Number.isFinite(printed as number) ? (printed as number) : null,
    defaultCost: Number.isFinite(printed as number) ? (printed as number) : null,
    costsX: false,
    ...over
  }
}

// ── scenario builders ──────────────────────────────────────────────────────

function combatPiles(): Sts2PileState {
  return {
    draw: [
      mk('strike'),
      mk('strike'),
      mk('strike'),
      mk('bash'),
      mk('defend'),
      mk('defend'),
      mk('cleave'),
      mk('iron_wave'),
      mk('anger'),
      mk('twin_strike'),
      mk('clothesline', { upgradeLevel: 1 })
    ],
    hand: [
      mk('strike'),
      mk('defend'),
      mk('pommel_strike'),
      mk('shrug_it_off', { upgradeLevel: 1 }),
      mk('flex')
    ],
    discard: [mk('strike'), mk('defend'), mk('inflame'), mk('wound', { hasBeenCycled: true })]
  }
}

function combatEnemies(phase = 0): Sts2EnemiesState {
  const cycle = [
    [{ type: 'SingleAttackIntent', valueLabel: '12' }],
    [{ type: 'MultiAttackIntent', valueLabel: '6x3' }],
    [{ type: 'SingleAttackIntent', valueLabel: '20' }, { type: 'DefendIntent', valueLabel: '' }]
  ]
  return {
    enemies: [{ name: 'Cultist', intents: cycle[phase % cycle.length] }],
    isCombatInProgress: true,
    currentSide: 1
  }
}

function baseNGameState(): Sts2NGameState {
  return {
    room: { type: 'combat' },
    isPeekButtonVisible: false,
    isPeeking: false,
    capstoneScreen: false,
    isSubMenuOpen: false,
    isMapOpen: false,
    isTraveling: false,
    isPreviewContainerOpen: false,
    isInspectCardScreenOpen: false,
    isInspectRelicScreenOpen: false,
    isGameOver: false,
    currentActIndex: 0,
    localPlayer: { characterId: 'ironclad' }
  }
}

const EMPTY_LAYOUT: Sts2LayoutState = { source: 'none', panels: [] }

const REWARD_LAYOUT: Sts2LayoutState = {
  source: 'cardReward',
  panels: [
    {
      x: 0.34,
      y: 0.32,
      w: 0.09,
      h: 0.22,
      isHovered: false,
      header: 'Anger',
      known: true,
      tier: 'B',
      score: 62,
      rows: [
        ['For your deck', 'B'],
        ['Tier', 'B'],
        ['Win rate', '54%'],
        ['Pick rate', '38%'],
        ['Sample', '12k']
      ],
      deckScored: true,
      reasons: ['Adrenaline 80%', 'Acrobatics 74%']
    },
    {
      x: 0.5,
      y: 0.32,
      w: 0.09,
      h: 0.22,
      isHovered: true,
      header: 'Inflame',
      known: true,
      tier: 'A',
      score: 71,
      rows: [
        ['For your deck', 'A'],
        ['Tier', 'A'],
        ['Win rate', '58%'],
        ['Pick rate', '61%'],
        ['Sample', '9.4k']
      ],
      deckScored: true,
      reasons: ['Twin Strike 75%', 'Pommel Strike 68%', 'Cleave 66%']
    },
    {
      x: 0.66,
      y: 0.32,
      w: 0.09,
      h: 0.22,
      isHovered: false,
      header: 'Regret',
      known: false,
      rows: []
    }
  ]
}

const MERCHANT_LAYOUT: Sts2LayoutState = {
  source: 'merchant',
  panels: [
    {
      x: 0.3,
      y: 0.28,
      w: 0.09,
      h: 0.22,
      isHovered: true,
      header: 'Shop — Clothesline',
      rows: [
        ['Buy rate', '44%'],
        ['Win rate', '56%'],
        ['Cost', '68g']
      ]
    },
    {
      x: 0.55,
      y: 0.28,
      w: 0.09,
      h: 0.22,
      isHovered: false,
      header: 'Shop — Flex',
      rows: [
        ['Buy rate', '19%'],
        ['Win rate', '49%'],
        ['Cost', '52g']
      ]
    }
  ]
}

const EVENT_LAYOUT: Sts2LayoutState = {
  source: 'event',
  panels: [
    {
      x: 0.5,
      y: 0.24,
      w: 0.16,
      h: 0.06,
      isHovered: true,
      header: 'Golden Idol',
      rows: [
        ['Take idol', '72% chose'],
        ['Win rate', '55%'],
        ['Leave', '28% chose']
      ]
    }
  ]
}

const ANCIENT_LAYOUT: Sts2LayoutState = {
  source: 'ancient',
  panels: [
    {
      x: 0.4,
      y: 0.3,
      w: 0.16,
      h: 0.06,
      isHovered: true,
      header: 'Ancient — Might',
      rows: [
        ['Offered', '1,204'],
        ['Picked', '63%'],
        ['Win rate', '59%']
      ]
    },
    {
      x: 0.6,
      y: 0.3,
      w: 0.16,
      h: 0.06,
      isHovered: false,
      header: 'Ancient — Guile',
      rows: [
        ['Offered', '980'],
        ['Picked', '37%'],
        ['Win rate', '52%']
      ]
    }
  ]
}

export class Sts2Stub {
  private scenario: StubScenario = 'combat'
  private piles: Sts2PileState = combatPiles()
  private phase = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly emit: (snap: KeyedSnapshot) => void) {}

  start(): void {
    this.emitAll()
    this.timer = setInterval(() => this.tick(), 2500)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  getScenario(): StubScenario {
    return this.scenario
  }

  setScenario(scenario: StubScenario): void {
    this.scenario = scenario
    this.phase = 0
    this.piles = combatPiles()
    this.emitAll()
  }

  /** Push every key's current value — used on start and on renderer request. */
  emitAll(): void {
    this.emit({ key: 'sts2.cardData', value: CARD_DATA })
    this.emit({ key: 'sts2.nGameState', value: this.nGameState() })
    this.emit({ key: 'sts2.pileState', value: this.piles })
    this.emit({ key: 'sts2.enemiesState', value: this.enemiesState() })
    this.emit({ key: 'sts2.layoutState', value: this.layoutState() })
  }

  // ── per-scenario state ──

  private nGameState(): Sts2NGameState {
    const s = baseNGameState()
    switch (this.scenario) {
      case 'combat':
      case 'reward':
        s.room = { type: 'combat' }
        break
      case 'merchant':
        s.room = { type: 'merchant' }
        break
      case 'event':
        s.room = { type: 'event' }
        break
      case 'ancient':
        s.room = { type: 'combat' }
        break
      case 'idle':
        s.room = null
        break
    }
    return s
  }

  private enemiesState(): Sts2EnemiesState {
    if (this.scenario === 'combat') return combatEnemies(this.phase)
    // Reward/ancient share a combat room but combat is over.
    return { enemies: [], isCombatInProgress: false, currentSide: 1 }
  }

  private layoutState(): Sts2LayoutState {
    switch (this.scenario) {
      case 'reward':
        return REWARD_LAYOUT
      case 'merchant':
        return MERCHANT_LAYOUT
      case 'event':
        return EVENT_LAYOUT
      case 'ancient':
        return ANCIENT_LAYOUT
      default:
        return EMPTY_LAYOUT
    }
  }

  // ── liveness timer ──

  private tick(): void {
    if (this.scenario !== 'combat') return
    this.phase++
    // Rotate the draw pile so the tracker's odds shift a little.
    if (this.piles.draw.length > 1) {
      const [first, ...rest] = this.piles.draw
      this.piles = { ...this.piles, draw: [...rest, first] }
    }
    this.emit({ key: 'sts2.pileState', value: this.piles })
    this.emit({ key: 'sts2.enemiesState', value: this.enemiesState() })
  }
}
