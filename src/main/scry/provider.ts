/* eslint-disable @typescript-eslint/no-explicit-any */

import { get as httpsGet } from 'https'
import { telemetry } from '../telemetry/Telemetry'
import { ScryConnection } from './connection'
import { CodexClient, type DeckAdvice } from '../codex/CodexClient'
import {
  readEnemiesState,
  readNGameState,
  readPileState,
  readVisibleItems,
  readGameVersion,
  type RawCard,
  type RawPileState,
  type RawVisibleItems
} from './readers'
import type {
  KeyedSnapshot,
  Sts2Card,
  Sts2CardData,
  Sts2EnemiesState,
  Sts2LayoutState,
  Sts2NGameState,
  Sts2PileState,
  Sts2StatPanel,
  WindowBounds
} from '@shared/types'

/**
 * Live StS2 data provider. Replaces the stub: detects the running game, opens a
 * scry connection, and polls the scene-tree readers, emitting the same keyed
 * snapshots the renderer already consumes. Card metadata (names/types/costs) is
 * fetched from Untapped's public sts2json CDN, keyed by the running build's
 * version — the readers only produce ids.
 *
 * Cadence and error handling mirror the original watchers (decomp/scry): poll
 * on a setTimeout chain, back off on repeated errors, rebuild the dotnet/godot
 * views on a crash, and re-detect when the process comes and goes.
 */

const POLL_MS = 150
const DETECT_MS = 1000
const RESTART_AFTER_ERRORS = 8
const REDETECT_AFTER_ERRORS = 40

// A card offer must be stable for this many consecutive polls (~450ms at 150ms)
// before we spend a deck-conditioned draft-advice API call on it.
const OFFER_STABLE_POLLS = 3

export interface ProcessState {
  detected: boolean
  pid: number | null
  bounds: WindowBounds | null
  active: boolean
}

export interface ScryProviderCallbacks {
  emit(snap: KeyedSnapshot): void
  onProcess(state: ProcessState): void
}

/**
 * True for failures that come from reading a moving target rather than from a
 * bug: a freed scene during a room swap, or a pointer read across a write.
 * They recover on the next tick by themselves.
 */
function isTransientRead(err: unknown): boolean {
  const anyErr = err as { type?: string; message?: string } | null
  if (anyErr?.type === 'memory-access-exception') return true
  const m = anyErr?.message ?? ''
  return (
    m.includes('Invalid access to memory location') ||
    m.includes('Only part of a ReadProcessMemory') ||
    m.includes('Failed to read')
  )
}

export class Sts2ScryProvider {
  private conn = new ScryConnection()
  private pollTimer: NodeJS.Timeout | null = null
  private detectTimer: NodeJS.Timeout | null = null
  private errorStreak = 0
  /** Reads that failed twice but are inherent to unsynchronised access. */
  private transientReads = 0
  private running = false

  // Change-detection caches so we only emit when something actually changed.
  private lastNGame = ''
  private lastPile = ''
  private lastEnemies = ''
  private lastLayout = ''

  // Transition-only audit logging (fires on change, not every poll).
  private lastRoomType: string | null = null
  private lastCombatInProgress = false
  private lastObscured = false
  private lastLoggedDeckHash = ''

  // Cards created mid-combat only join the tracked deck once they leave hand.
  private cycledCardAddrs = new Set<string>()

  private cardDataVersion: string | null = null
  private cardDataFetching = false
  private cardDataRetryTimer: NodeJS.Timeout | null = null
  private cardDataRetries = 0
  // id -> display name, spanning cards/relics/potions (for offered-item panels).
  private nameMap: Record<string, string> = {}

  // ── Spire Codex advisor ──
  private codex = new CodexClient()
  // Last-combat deck snapshot: union of draw+hand+discard ids from the most
  // recent non-empty pile read. Used to deck-condition draft-advice without a
  // full-deck memory reader (piles are the only owned-card surface we read).
  private deckSnapshot: string[] = []
  private deckHash = ''
  private character = ''
  // offerKey -> per-offered-id deck advice (filled async by ensureAdvise).
  private adviceCache = new Map<string, Record<string, DeckAdvice>>()
  private adviceInFlight = new Set<string>()
  // offerKey -> earliest epoch ms to retry after a failed/no-data advise call.
  private adviceBackoff = new Map<string, number>()
  // Offer keys that returned a definitive "no deck data" — stops the loading
  // placeholder from spinning forever when the API simply has nothing.
  private adviceNoData = new Set<string>()
  private reprimeTimer: NodeJS.Timeout | null = null
  // Offer-set stability debounce: only fire draft-advice once the same offer key
  // has been seen on N consecutive layout reads (avoids scoring transient sets).
  private lastOfferKey = ''
  private offerKeyStreak = 0

  constructor(private readonly cb: ScryProviderCallbacks) {}

  start(): void {
    this.running = true
    // Settings are owned/emitted by the main-process SettingsStore, not here.
    this.cb.emit({ key: 'sts2.layoutState', value: { source: 'none', panels: [] } })
    // The Codex aggregates are game-agnostic — prime immediately so the advisor
    // is warm (and the dashboard shows status) before the game is even detected.
    void this.codex.prime().catch((err) => {
          console.warn('[codex-provider] prime failed', err)
          telemetry.issue('codex_prime_failed', 'warn', {}, err)
        })
    this.detect()
    this.detectTimer = setInterval(() => this.detect(), DETECT_MS)
    // Self-heal a failed/incomplete prime (offline at launch, API rebuilding):
    // retry periodically until the snapshot is ready.
    this.reprimeTimer = setInterval(() => {
      const state = this.codex.status().state
      if (state === 'error' || state === 'priming' || state === 'stale') {
        void this.codex.prime().catch(() => {})
      }
    }, 3 * 60_000)
  }

  stop(): void {
    this.running = false
    if (this.detectTimer) clearInterval(this.detectTimer)
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.cardDataRetryTimer) clearTimeout(this.cardDataRetryTimer)
    if (this.reprimeTimer) clearInterval(this.reprimeTimer)
    this.detectTimer = null
    this.pollTimer = null
    this.cardDataRetryTimer = null
    this.reprimeTimer = null
    this.conn.disconnect()
  }

  get scryError(): string | null {
    return this.conn.error
  }
  get connectedPid(): number | null {
    return this.conn.connectedPid
  }
  /** Primed-snapshot status for the dashboard diagnostics panel. */
  get codexStatus(): ReturnType<CodexClient['status']> {
    return this.codex.status()
  }

  // ── process detection ──

  private detect(): void {
    // Runs from a setInterval; a throw here would escape uncaught and kill the
    // process (no JS stack — a crashpad-kill profile). Never let it propagate.
    try {
      this.detectInner()
    } catch (err) {
      console.error('[codex-provider] detect failed', err)
      telemetry.issue('scry_detect_failed', 'error', {}, err)
    }
  }

  private detectInner(): void {
    const { proc } = ScryConnection.findGameProcess()
    if (!proc) {
      if (this.conn.isConnected()) this.handleProcessGone()
      this.cb.onProcess({ detected: false, pid: null, bounds: null, active: false })
      return
    }
    this.cb.onProcess({
      detected: true,
      pid: proc.pid,
      bounds: proc.bounds,
      active: proc.active
    })
    if (!this.conn.isConnected() || this.conn.connectedPid !== proc.pid) {
      const connected = this.conn.connect(proc.pid)
      telemetry.capture('scry_connect', { ok: connected, had_prior: this.conn.connectedPid != null })
      if (!connected) {
        // We can see the game but cannot attach — usually a permissions or
        // anti-cheat interaction, and completely invisible to the user.
        telemetry.issue('scry_connect_failed', 'error', { scry_error: this.scryError })
      }
      if (connected) {
        this.errorStreak = 0
        this.fetchCardData()
        // Prime the Codex snapshot (cached per API version; cheap no-op if fresh).
        void this.codex.prime().catch((err) => {
          console.warn('[codex-provider] prime failed', err)
          telemetry.issue('codex_prime_failed', 'warn', {}, err)
        })
        this.startPolling()
      }
    }
  }

  private handleProcessGone(): void {
    telemetry.capture('scry_process_gone', { error_streak: this.errorStreak })
    this.conn.disconnect()
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.resetRunState()
    this.lastNGame = this.lastPile = this.lastEnemies = this.lastLayout = ''
    this.cb.emit({ key: 'sts2.nGameState', value: idleNGameState() })
    this.cb.emit({ key: 'sts2.pileState', value: { draw: [], hand: [], discard: [] } })
    this.cb.emit({
      key: 'sts2.enemiesState',
      value: { enemies: [], isCombatInProgress: false, currentSide: 1 }
    })
    this.cb.emit({ key: 'sts2.layoutState', value: { source: 'none', panels: [] } })
  }

  // ── polling loop ──

  private startPolling(): void {
    if (this.pollTimer) return
    const tick = (): void => {
      if (!this.running || !this.conn.isConnected()) {
        this.pollTimer = null
        return
      }
      try {
        this.poll()
      } catch (err) {
        // poll() already handles read errors; this is a last-resort guard so a
        // throw from the error path (e.g. an emit) can never stop the loop.
        console.error('[codex-provider] poll tick failed', err)
        telemetry.issue('poll_tick_failed', 'error', {}, err)
      } finally {
        // Always reschedule while running so one bad tick can't kill the loop.
        if (this.running && this.conn.isConnected()) {
          this.pollTimer = setTimeout(tick, POLL_MS)
        } else {
          this.pollTimer = null
        }
      }
    }
    this.pollTimer = setTimeout(tick, POLL_MS)
  }

  private poll(): void {
    const context = this.conn.getContext()
    if (!context) return
    try {
      this.pollNGame(context)
      this.pollPile(context)
      this.pollEnemies(context)
      this.pollItems(context)
      this.errorStreak = 0
    } catch (err) {
      // Reading a live process without synchronisation means some failures are
      // inherent, not defects: the game frees a scene mid-traversal, or a
      // pointer is sampled across a write. These are worth counting and worth
      // escalating if sustained, but reporting them at error severity buried
      // the genuine faults — they were 65% of all errors while being the least
      // actionable thing in the set.
      const transient = isTransientRead(err)
      this.errorStreak++
      if (transient) this.transientReads++
      // Only the first of a streak, and only when it is not the expected kind —
      // a scene freed mid-read is normal and does not deserve a stack trace.
      if (this.errorStreak === 1 && !transient) {
        console.warn('[codex-provider] poll read failed', err)
      }
      // Aggregated inside telemetry, so a persistent fault reports occurrences
      // 1, 2, 5, 25… rather than ~6 events a second.
      telemetry.issue(
        transient ? 'poll_read_transient' : 'poll_read_failed',
        transient ? 'warn' : 'error',
        {
          error_streak: this.errorStreak,
          transient_total: this.transientReads
        },
        err
      )
      if (this.errorStreak === RESTART_AFTER_ERRORS) {
        telemetry.capture('scry_connection_restart', { error_streak: this.errorStreak })
        this.conn.restart()
      } else if (this.errorStreak >= REDETECT_AFTER_ERRORS) {
        telemetry.issue('scry_redetect_after_errors', 'warn', { error_streak: this.errorStreak })
        this.handleProcessGone()
      }
    }
  }

  private pollNGame(context: NonNullable<ReturnType<ScryConnection['getContext']>>): void {
    const raw = readNGameState(context)
    const value: Sts2NGameState = raw
      ? {
          room: raw.roomType ? { type: raw.roomType } : null,
          isPeekButtonVisible: false,
          isPeeking: false,
          capstoneScreen: raw.capstoneScreen,
          isSubMenuOpen: raw.isSubMenuOpen,
          isMapOpen: raw.isMapOpen,
          isTraveling: raw.isTraveling,
          isPreviewContainerOpen: false,
          isInspectCardScreenOpen: raw.isInspectCardScreenOpen,
          isInspectRelicScreenOpen: raw.isInspectRelicScreenOpen,
          isGameOver: raw.isGameOver,
          currentActIndex: raw.currentActIndex,
          localPlayer: raw.characterId ? { characterId: raw.characterId } : null
        }
      : idleNGameState()
    // Detect a real character change (a new run) and reset run-scoped state so
    // the first reward isn't scored against the previous run's deck. Ignore the
    // transient '' the game reports on menus/transitions (don't reset or clobber).
    const newChar = value.localPlayer?.characterId ?? ''
    if (newChar) {
      if (this.character && newChar !== this.character) this.resetRunState()
      this.character = newChar
    }

    const roomType = value.room?.type ?? null
    if (roomType !== this.lastRoomType) {
      this.dbg(
        `room: ${this.lastRoomType ?? 'none'} → ${roomType ?? 'none'} ` +
          `(char=${this.character || '?'}, act=${value.currentActIndex})`
      )
      this.lastRoomType = roomType
    }
    const obscured =
      value.capstoneScreen ||
      value.isSubMenuOpen ||
      value.isMapOpen ||
      value.isTraveling ||
      value.isInspectCardScreenOpen ||
      value.isInspectRelicScreenOpen ||
      value.isGameOver
    if (obscured !== this.lastObscured) {
      const flags = [
        value.capstoneScreen && 'capstone',
        value.isSubMenuOpen && 'subMenu',
        value.isMapOpen && 'map',
        value.isTraveling && 'traveling',
        value.isInspectCardScreenOpen && 'inspectCard',
        value.isInspectRelicScreenOpen && 'inspectRelic',
        value.isGameOver && 'gameOver'
      ].filter(Boolean)
      this.dbg(`obscured: ${obscured ? `ON [${flags.join(',')}]` : 'OFF — overlays visible'}`)
      this.lastObscured = obscured
    }

    const json = JSON.stringify(value)
    if (json !== this.lastNGame) {
      this.lastNGame = json
      this.cb.emit({ key: 'sts2.nGameState', value })
    }
  }

  private pollPile(context: NonNullable<ReturnType<ScryConnection['getContext']>>): void {
    const raw = readPileState(context)
    const value: Sts2PileState = raw
      ? this.toPileState(raw)
      : { draw: [], hand: [], discard: [] }
    const json = JSON.stringify(value)
    if (json !== this.lastPile) {
      this.lastPile = json
      this.cb.emit({ key: 'sts2.pileState', value })
    }
  }

  private pollEnemies(context: NonNullable<ReturnType<ScryConnection['getContext']>>): void {
    const raw = readEnemiesState(context)
    const value: Sts2EnemiesState = raw
      ? {
          enemies: raw.enemies.map((e) => ({ intents: e.intents })),
          isCombatInProgress: raw.isCombatInProgress,
          currentSide: raw.currentSide
        }
      : { enemies: [], isCombatInProgress: false, currentSide: 1 }
    if (value.isCombatInProgress !== this.lastCombatInProgress) {
      this.dbg(
        `combat ${value.isCombatInProgress ? 'START' : 'END'} ` +
          `(enemies=${value.enemies.length}, side=${value.currentSide})`
      )
      // The cycled-address set is per-combat: freed godot addresses get reused for
      // new temporaries next fight, so a stale entry would mis-flag them. Reset it
      // when a combat ends.
      if (!value.isCombatInProgress) this.cycledCardAddrs.clear()
      this.lastCombatInProgress = value.isCombatInProgress
    }
    const json = JSON.stringify(value)
    if (json !== this.lastEnemies) {
      this.lastEnemies = json
      this.cb.emit({ key: 'sts2.enemiesState', value })
    }
  }

  private pollItems(context: NonNullable<ReturnType<ScryConnection['getContext']>>): void {
    const raw = readVisibleItems(context)
    const value: Sts2LayoutState = raw
      ? this.toLayoutState(raw)
      : { source: 'none', panels: [] }
    const json = JSON.stringify(value)
    if (json !== this.lastLayout) {
      this.lastLayout = json
      if (value.source !== 'none') {
        const resolved = value.panels.filter((p) => p.known !== false).length
        const hovered = value.panels.filter((p) => p.isHovered).length
        this.dbg(
          `layout ${value.source}: ${value.panels.length} panels, ${resolved} resolved, ` +
            `${value.panels.length - resolved} no-data, ${hovered} hovered`
        )
        const hp = value.panels.find((p) => p.isHovered)
        if (hp) {
          this.dbg(
            `  hovered "${hp.header}" known=${hp.known} ` +
              `x=${hp.x?.toFixed(3)} y=${hp.y?.toFixed(3)} w=${hp.w?.toFixed(3)} h=${hp.h?.toFixed(3)}`
          )
        }
      }
      this.cb.emit({ key: 'sts2.layoutState', value })
    }
  }

  private dbg(msg: string): void {
    if (process.env['SPECTRA_DEBUG']) console.log(`[codex-provider] ${msg}`)
  }

  /**
   * Build the overlay panels for the currently-offered items. Real ids + positions
   * come from memory; the stat rows now come from the primed Spire Codex snapshot
   * (global context stats) enriched, when available, with deck-conditioned advice
   * from a prior draft-advice call cached under this offer's key. Unknown ids
   * degrade to a "no data" panel — never a fabricated card (the API prettifies
   * unknown ids into plausible names, so we gate every id on the vocabulary).
   */
  private toLayoutState(raw: RawVisibleItems): Sts2LayoutState {
    // Card offers on add-a-card screens are the only deck-conditioned surface.
    const offerIds = raw.items
      .filter((i) => i.kind === 'card' && i.id)
      .map((i) => i.id as string)
    const offerKey = this.ensureAdvise(raw.source, offerIds)
    const advice = offerKey ? this.adviceCache.get(offerKey) : undefined
    // Deck advice is expected (additive offer, key assigned) but hasn't arrived and
    // isn't known-empty → the renderer shows an animated placeholder meanwhile.
    const advicePending = !!offerKey && !advice && !this.adviceNoData.has(offerKey)

    const panels: Sts2StatPanel[] = []
    for (const item of raw.items) {
      if (!item.id) continue
      const ctx = this.codex.contextStats(item)
      const header = this.codex.displayName(item.id) ?? this.nameMap[item.id] ?? prettifyId(item.id)

      if (!ctx || !ctx.known) {
        // Unresolved id: honest "no data" rather than a made-up stat line.
        panels.push({
          x: item.cx,
          y: item.cy,
          w: item.w,
          h: item.h,
          isHovered: item.isHovered,
          header,
          rows: ctx?.rows ?? [],
          known: false
        })
        continue
      }

      const deckAdvice = advice?.[item.id]
      const panel: Sts2StatPanel = {
        x: item.cx,
        y: item.cy,
        w: item.w,
        h: item.h,
        isHovered: item.isHovered,
        header,
        rows: ctx.rows,
        tier: ctx.tier,
        score: ctx.score,
        confidence: ctx.confidence,
        known: true,
        trap: ctx.trap,
        // Only card offers get deck-conditioned advice; relics/potions never do.
        deckAdvicePending: advicePending && item.kind === 'card'
      }
      if (deckAdvice) applyDeckAdvice(panel, deckAdvice)
      panels.push(panel)
    }
    return { source: raw.source, panels }
  }

  /**
   * Fire a deck-conditioned draft-advice call for a *stable* card offer, at most
   * once per offer key. Returns the offer key (so the caller can read the cache)
   * or '' when there's nothing to score. The result lands asynchronously; on
   * arrival we clear the layout cache so the next poll re-emits enriched panels.
   */
  private ensureAdvise(source: string, offerIds: string[]): string {
    // Deck-conditioned advice only for genuinely ADDITIVE surfaces — reward,
    // choose-a-card, and shop card stock — so the "for your deck" grade means
    // "adding this". Grid screens (removal / transform / upgrade) and ancient
    // choices are NOT additive and fall back to global context stats. offerIds are
    // already filtered to card ids upstream, so shop relics/potions are excluded.
    const additive = source === 'cardReward' || source === 'chooseACard' || source === 'merchant'
    if (!additive || offerIds.length < 2 || !this.codex.isReady()) {
      this.lastOfferKey = ''
      this.offerKeyStreak = 0
      return ''
    }
    // Key includes the API snapshot version so advice computed under an old
    // aggregate is invalidated when the API rebuilds.
    const apiVersion = this.codex.status().apiVersion ?? 0
    const key = `${apiVersion}|${this.character}|${this.deckHash}|${[...offerIds].sort().join(',')}`

    // Debounce: require the same offer set on OFFER_STABLE_POLLS consecutive reads
    // before spending an API call (memory can flicker mid-transition).
    if (key === this.lastOfferKey) this.offerKeyStreak++
    else {
      this.lastOfferKey = key
      this.offerKeyStreak = 1
    }

    if (this.adviceCache.has(key) || this.adviceInFlight.has(key)) return key
    if (this.offerKeyStreak < OFFER_STABLE_POLLS) return key
    // Negative-result backoff: a failed advise doesn't cache, so without this the
    // same parked offer would re-POST every poll (~150ms) against the 15/min limit.
    const backoffUntil = this.adviceBackoff.get(key)
    if (backoffUntil && Date.now() < backoffUntil) return key

    this.adviceInFlight.add(key)
    const deck = this.deckSnapshot
    this.dbg(
      `firing draft-advice: char=${this.character || '?'} deck=${deck.length} cards, ` +
        `offer=[${offerIds.join(', ')}]`
    )
    void this.codex
      .advise(deck, offerIds)
      .then((res) => {
        this.adviceInFlight.delete(key)
        if (res) {
          this.adviceBackoff.delete(key)
          this.adviceNoData.delete(key)
          this.adviceCache.set(key, res)
          // Bound memory: evict the oldest entry once the cache grows large.
          if (this.adviceCache.size > 200) {
            const oldest = this.adviceCache.keys().next().value
            if (oldest !== undefined) this.adviceCache.delete(oldest)
          }
          this.dbg(`draft-advice cached for offer [${offerIds.join(', ')}] — re-emitting layout`)
          // Force the next poll to re-emit with the deck-conditioned rows merged in.
          this.lastLayout = ''
        } else {
          // Definitive no-data: stop the loading placeholder and back off retries.
          this.adviceNoData.add(key)
          this.adviceBackoff.set(key, Date.now() + 15_000)
          this.lastLayout = '' // re-emit so the placeholder clears to global stats
          this.dbg(`draft-advice returned no data for [${offerIds.join(', ')}] — backing off`)
        }
      })
      .catch((err) => {
        this.adviceInFlight.delete(key)
        this.adviceBackoff.set(key, Date.now() + 15_000)
        console.warn('[codex-provider] advise handler failed', err)
        telemetry.issue('draft_advice_failed', 'warn', {}, err)
      })
    return key
  }

  private toPileState(raw: RawPileState): Sts2PileState {
    for (const c of raw.draw) this.cycledCardAddrs.add(String(c.baseAddress))
    for (const c of raw.discard) this.cycledCardAddrs.add(String(c.baseAddress))
    const conv = (cards: RawCard[]): Sts2Card[] =>
      cards.map((c) => ({
        id: c.id,
        upgradeLevel: c.upgradeLevel,
        enchantment: c.enchantment,
        isPermanent: c.isPermanent,
        hasBeenCycled: this.cycledCardAddrs.has(String(c.baseAddress)),
        cost: c.cost,
        defaultCost: c.defaultCost,
        costsX: c.costsX
      }))
    this.captureDeckSnapshot(raw)
    return { draw: conv(raw.draw), hand: conv(raw.hand), discard: conv(raw.discard) }
  }

  /**
   * Record the owned deck for deck-conditioned advice: the union of ALL four piles
   * (draw + hand + discard + exhaust) filtered to permanent cards. Exhaust is
   * included because exhausted/one-shot cards are still part of the deck; the
   * isPermanent filter drops combat-generated temporaries (Shivs, statuses) that
   * would otherwise inflate the deck sent to draft-advice. Piles are the only
   * owned-card surface we read, so mid-combat this is a near-complete deck (powers
   * in play are the only gap); between combats it's the last-combat snapshot.
   * Ignore empty reads so a card-reward screen doesn't wipe the snapshot.
   */
  private captureDeckSnapshot(raw: RawPileState): void {
    const ids: string[] = []
    for (const c of [...raw.draw, ...raw.hand, ...raw.discard, ...raw.exhaust]) {
      if (c.id && c.isPermanent) ids.push(c.id)
    }
    if (!ids.length) return
    this.deckSnapshot = ids
    this.deckHash = [...ids].sort().join(',')
    if (this.deckHash !== this.lastLoggedDeckHash) {
      this.lastLoggedDeckHash = this.deckHash
      this.dbg(`deck snapshot: ${ids.length} cards (draw+hand+discard+exhaust, owned only)`)
    }
  }

  /**
   * Clear all run-scoped state so a new run/character can't be conditioned on the
   * previous one. Called on character change and on process loss.
   */
  private resetRunState(): void {
    this.deckSnapshot = []
    this.deckHash = ''
    this.lastLoggedDeckHash = ''
    this.adviceCache.clear()
    this.adviceInFlight.clear()
    this.adviceBackoff.clear()
    this.adviceNoData.clear()
    this.lastOfferKey = ''
    this.offerKeyStreak = 0
    this.cycledCardAddrs.clear()
    this.dbg('run/character change — deck + advice state reset')
  }

  // ── card metadata (CDN) ──

  private fetchCardData(): void {
    if (this.cardDataFetching) return
    const context = this.conn.getContext()
    if (!context) return
    let version: string | null = null
    try {
      version = readGameVersion(context)
    } catch {
      version = null
    }
    if (version && version === this.cardDataVersion) return
    this.cardDataFetching = true
    const candidates = version
      ? [`public/${version}`, 'public/latest']
      : ['public/latest']
    void this.tryFetchCardData(candidates, version)
  }

  private async tryFetchCardData(candidates: string[], version: string | null): Promise<void> {
    for (const path of candidates) {
      const url = `https://sts2json.untapped.gg/data/${path}/sts_data.json`
      try {
        const data = await fetchJson(url)
        if (data && Array.isArray(data.cards)) {
          const map: Sts2CardData = {}
          const names: Record<string, string> = {}
          for (const card of data.cards) {
            if (card?.id) {
              map[card.id] = card
              if (card.name) names[card.id] = card.name
            }
          }
          for (const list of [data.relics, data.potions]) {
            if (Array.isArray(list)) {
              for (const entry of list) if (entry?.id && entry.name) names[entry.id] = entry.name
            }
          }
          this.nameMap = names
          // Only record the exact game version when the version-specific path
          // served it; if we fell back to 'latest', leave it unset so a later
          // connect can still fetch build-specific data (don't cache latest AS
          // the build version).
          this.cardDataVersion = path === `public/${version}` ? version : null
          this.cardDataFetching = false
          this.cardDataRetries = 0
          this.cb.emit({ key: 'sts2.cardData', value: map })
          return
        }
      } catch {
        // try next candidate
      }
    }
    // Every candidate failed (CDN blip / offline at launch). Without a retry the
    // whole session runs with no card metadata (every card renders as a raw id),
    // so schedule a backoff retry instead of giving up.
    this.cardDataFetching = false
    this.scheduleCardDataRetry()
  }

  private scheduleCardDataRetry(): void {
    if (this.cardDataRetryTimer || !this.running) return
    if (this.cardDataRetries >= 6) {
      this.dbg('card-data fetch: giving up after repeated failures')
      return
    }
    const delay = Math.min(30_000, 2000 * 2 ** this.cardDataRetries)
    this.cardDataRetries++
    this.dbg(
      `card-data fetch failed; retrying in ${Math.round(delay / 1000)}s ` +
        `(attempt ${this.cardDataRetries})`
    )
    this.cardDataRetryTimer = setTimeout(() => {
      this.cardDataRetryTimer = null
      if (this.running && this.conn.isConnected()) this.fetchCardData()
    }, delay)
  }
}

/** "some_card_id" -> "Some Card Id" fallback when metadata hasn't loaded yet. */
function prettifyId(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Merge deck-conditioned draft-advice into a panel: prepend a "For your deck"
 * value row and attach the synergy reasons.
 *
 * draft-advice `score` is the deck-conditioned pick value (0..1); `base` is the
 * same value ignoring your deck. They're equal unless the card has a recorded
 * pairwise synergy with a card you already own — so `score - base` is ~always 0
 * and is the WRONG thing to surface. We show `score` itself (×100), which ranks
 * the offer (strong picks ~40+, filler ~15, basics 0) and is the number the
 * renderer colours by strength. `base < score` still shows up via the reasons.
 */
function applyDeckAdvice(panel: Sts2StatPanel, a: DeckAdvice): void {
  panel.deckScored = true
  panel.reasons = a.reasons
  // Drop the global 0..100 "Score" row so we don't show two different "scores"
  // on different scales in the same panel.
  const rows = panel.rows.filter(([label]) => label !== 'Score')
  panel.rows = [['For your deck', deckScoreGrade(a.score * 100)], ...rows]
}

/**
 * Deck-conditioned pick value (draft-advice score ×100) → letter grade. Strong
 * picks land ~40+, filler ~15, basic cards ~0. Aligned with the renderer's tier
 * colours so "For your deck" grades the same way the global Tier does.
 */
function deckScoreGrade(n: number): string {
  if (n >= 40) return 'A'
  if (n >= 25) return 'B'
  if (n >= 15) return 'C'
  if (n >= 5) return 'D'
  return 'F'
}

function idleNGameState(): Sts2NGameState {
  return {
    room: null,
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
    localPlayer: null
  }
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}
