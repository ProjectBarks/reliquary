/**
 * Types shared across the main process, preload bridge, and renderer.
 * One source of truth for the IPC contract and the StS2 domain model.
 *
 * The domain shapes mirror what the vendored `untapped-scry` readers produce
 * (see decomp/scry). Values are supplied by the live scry provider in
 * src/main/scry by default; the stub provider in src/main/stub is a
 * developer-only fallback (SPECTRA_STUB) that emits the same keyed snapshots so
 * the overlays can be exercised without the game running.
 */

/** Screen-space rectangle the overlay is pinned to. */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Whether the tracked target window is currently visible/available. */
export interface TrackerState {
  /** True when a target window was found and has valid bounds. */
  attached: boolean
  bounds: WindowBounds | null
  /** Human label for what we're tracking (e.g. "Slay the Spire 2"). */
  target: string
}

// ── StS2 domain model ─────────────────────────────────────────────────────

/** A single card instance in a pile. */
export interface Sts2Card {
  id: string
  upgradeLevel: number
  enchantment: string | null
  isPermanent: boolean
  hasBeenCycled: boolean
  /** Current energy cost; null = "use default". */
  cost: number | null
  /** Printed/base cost; null = variable. */
  defaultCost: number | null
  costsX: boolean
  /** Populated by the DeckTracker grouping pass (not from scry). */
  count?: number
  total?: number
}

/** Static card metadata keyed by card id (mirrors sts2.cardData). */
export interface Sts2CardInfo {
  name: string
  /** attack | skill | power | status | curse | quest | … */
  type: string
  /** ironclad | silent | regent | necrobinder | defect | colorless */
  color: string
  /** basic | common | uncommon | rare | event | status | quest | curse | ancient */
  rarity: string
  cost?: string
  starCost?: string
  upgrade?: { cost: string }
}

export type Sts2CardData = Record<string, Sts2CardInfo>

/** The three combat piles. */
export interface Sts2PileState {
  draw: Sts2Card[]
  hand: Sts2Card[]
  discard: Sts2Card[]
}

/** One enemy intent (attack/defend/buff/etc). */
export interface Sts2Intent {
  /** Fully-qualified node type, e.g. "…SingleAttackIntent". */
  type: string
  /** Raw label from the game, e.g. "12" or "6x3". */
  valueLabel: string
}

export interface Sts2Enemy {
  name?: string
  intents: Sts2Intent[]
}

export interface Sts2EnemiesState {
  enemies: Sts2Enemy[]
  isCombatInProgress: boolean
  /** 1 = Player turn, 2 = Enemy turn (mirrors CombatSide). */
  currentSide: number
}

export interface Sts2Room {
  type: 'combat' | 'merchant' | 'event' | 'rest' | 'treasure' | string
}

/** Top-level game/UI state that gates which overlays are visible. */
export interface Sts2NGameState {
  room: Sts2Room | null
  isPeekButtonVisible: boolean
  isPeeking: boolean
  capstoneScreen: boolean
  isSubMenuOpen: boolean
  isMapOpen: boolean
  isTraveling: boolean
  isPreviewContainerOpen: boolean
  isInspectCardScreenOpen: boolean
  isInspectRelicScreenOpen: boolean
  isGameOver: boolean
  currentActIndex: number
  localPlayer: { characterId: string } | null
}

/** A single "hover tip" style stat panel positioned at a screen fraction. */
export interface Sts2StatPanel {
  /**
   * Anchor as a fraction of the overlay [0..1] — the CENTRE of the game item the
   * panel belongs to. The renderer offsets by w/h to sit the tip beside the item
   * rather than on top of it (matching the original's hover-tip placement).
   */
  x: number
  y: number
  /** Item size as a fraction of the overlay [0..1], used to offset the tip. */
  w: number
  h: number
  /**
   * Whether the game reports this item as hovered (from memory `_isHovered`).
   * The original only renders the full stat tip for the hovered item; the
   * renderer gates on this so at most one tip shows at a time.
   */
  isHovered: boolean
  header: string
  rows: Array<[string, string]>
  // ── Spire Codex enrichment (all optional; absent on stub/no-data paths) ──
  /** metrics tier (A/B/C/…) for the item, from the primed snapshot. */
  tier?: string | null
  /** Codex score 0–100 (baseline-corrected, sample-aware). */
  score?: number | null
  /** Take/skip verdict — only set once scoring is deck-conditioned (phase 2). */
  verdict?: 'TAKE' | 'SITUATIONAL' | 'SKIP' | 'NO_DATA'
  /** Sample-size confidence for the win-rate figure. */
  confidence?: 'high' | 'med' | 'low'
  /** True when the id resolved against the Codex vocabulary; false ⇒ "no data". */
  known?: boolean
  /** True when rows reflect the player's actual deck (draft-advice), not global stats. */
  deckScored?: boolean
  /**
   * True while the deck-conditioned advice for this offer is still in flight (the
   * async draft-advice call hasn't returned). The renderer shows an animated
   * placeholder in the "For your deck" slot instead of a blank until it lands.
   */
  deckAdvicePending?: boolean
  /** Deck-conditioned reasons from draft-advice (the held cards driving the pick). */
  reasons?: string[]
  /** Revealed-preference vs outcome divergence: >0 overdrafted, <0 sleeper. */
  trap?: number | null
}

/** Reward/merchant/event/ancient overlays render from these panels. */
export interface Sts2LayoutState {
  source: 'cardReward' | 'chooseACard' | 'grid' | 'merchant' | 'ancient' | 'event' | 'none'
  panels: Sts2StatPanel[]
}

/** User-toggleable overlay switches (mirrors the sts2.enable* settings). */
export interface Sts2Settings {
  enableDeckTracker: boolean
  enableAttackSummary: boolean
  enableCardRewardStats: boolean
  enableShopStats: boolean
  enableAncientChoiceStats: boolean
  enableDebugStats: boolean
}

/** Single source of truth for default toggles (shared by the store + providers). */
export const DEFAULT_SETTINGS: Sts2Settings = {
  enableDeckTracker: true,
  enableAttackSummary: true,
  enableCardRewardStats: true,
  enableShopStats: true,
  enableAncientChoiceStats: true,
  enableDebugStats: true
}

/** The keyed data contract. `useIpc(key)` returns the matching value type. */
export interface Sts2StateMap {
  'sts2.nGameState': Sts2NGameState
  'sts2.cardData': Sts2CardData
  'sts2.pileState': Sts2PileState
  'sts2.enemiesState': Sts2EnemiesState
  'sts2.layoutState': Sts2LayoutState
  'sts2.settings': Sts2Settings
}

export type Sts2Key = keyof Sts2StateMap

/** Named developer stub scenarios the dashboard can switch between (SPECTRA_STUB). */
export type StubScenario = 'combat' | 'merchant' | 'event' | 'reward' | 'ancient' | 'idle'

/** A keyed snapshot pushed main -> renderer on IPC.Data. */
export interface KeyedSnapshot<K extends Sts2Key = Sts2Key> {
  key: K
  value: Sts2StateMap[K]
}

/** One captured main-process log line, streamed to the in-app Logs tab. */
export interface LogLine {
  /** Epoch ms when captured. */
  t: number
  level: 'log' | 'warn' | 'error'
  text: string
}

/** Window control actions the custom titlebar can request (renderer -> main). */
export type WindowAction = 'minimize' | 'maximize' | 'close'

/** Diagnostics surfaced on the dashboard. */
export interface DiagnosticsState {
  /** 'live' = real scry provider, 'stub' = hardcoded demo data. */
  mode: 'live' | 'stub'
  overlayCreated: boolean
  overlayVisible: boolean
  overlayBounds: WindowBounds | null
  scryModuleLoaded: boolean
  scryLoadError: string | null
  /** Telemetry client state, surfaced in the Debug tab. */
  telemetry?: Record<string, unknown>
  gameDetected: boolean
  gamePid: number | null
  scenario: StubScenario
  /** Spire Codex advisor snapshot status (null until first prime attempt). */
  codex?: CodexStatus | null
}

/** Status of the primed Spire Codex snapshot, surfaced on the dashboard. */
export interface CodexStatus {
  /** 'priming' | 'ready' | 'stale' | 'error' | 'idle' */
  state: 'idle' | 'priming' | 'ready' | 'stale' | 'error'
  /** API aggregate snapshot version the local cache was built from. */
  apiVersion: number | null
  /** Number of cards in the validator vocabulary (577 when healthy). */
  cardVocab: number
  relicVocab: number
  /** Offered-card ids seen live vs how many resolved (runtime coverage). */
  idsSeen: number
  idsResolved: number
  error: string | null
}

/** IPC channel names — one place so main/preload/renderer never drift. */
export const IPC = {
  /** main -> renderer: a keyed state snapshot ({ key, value }) */
  Data: 'spectra:data',
  /** main -> renderer: tracker attach/bounds updates */
  Tracker: 'spectra:tracker',
  /** main -> renderer: diagnostics for the dashboard */
  Diagnostics: 'spectra:diagnostics',
  /** renderer -> main: toggle whether the overlay swallows mouse input */
  SetInteractive: 'spectra:set-interactive',
  /** renderer -> main: replay all current state to this window */
  RequestState: 'spectra:request-state',
  /** renderer -> main: switch the active stub scenario */
  SetScenario: 'spectra:set-scenario',
  /** renderer -> main: patch overlay settings */
  SetSettings: 'spectra:set-settings',
  /** main -> renderer: captured log line(s) for the Logs tab (array; 1 live, N on replay) */
  Log: 'spectra:log',
  /** renderer -> main: perform a window control action on the dashboard window */
  WindowControl: 'spectra:window-control',
  /** main -> renderer: dashboard maximized-state changed (boolean) */
  WindowMaximized: 'spectra:window-maximized',
  /** renderer -> main: a renderer error / diagnostic event to report */
  Telemetry: 'spectra:telemetry'
} as const

/**
 * A diagnostic event raised in a renderer and forwarded to the main process,
 * which owns the only telemetry client. Renderers never talk to the network.
 */
export interface RendererTelemetryEvent {
  kind: 'error' | 'event' | 'crumb'
  /** Stable grouping key, e.g. 'overlay_render_failed'. */
  name: string
  /** Which window raised it. */
  surface: 'overlay' | 'dashboard' | 'unknown'
  message?: string
  stack?: string
  componentStack?: string
  props?: Record<string, unknown>
}

/** The typed API the preload script exposes on window.spectra. */
export interface SpectraApi {
  /** Report a renderer error or diagnostic event to the main-process telemetry. */
  report(event: RendererTelemetryEvent): void
  onData(cb: (snapshot: KeyedSnapshot) => void): () => void
  onTracker(cb: (state: TrackerState) => void): () => void
  onDiagnostics(cb: (state: DiagnosticsState) => void): () => void
  /** true = overlay is clickable; false = clicks pass through to the game */
  setInteractive(interactive: boolean): void
  /** ask main to replay all current state (call on mount) */
  requestState(): void
  setScenario(scenario: StubScenario): void
  setSettings(patch: Partial<Sts2Settings>): void
  /** main -> renderer: captured log lines (batched array). Returns unsubscribe. */
  onLog(cb: (lines: LogLine[]) => void): () => void
  /** main -> renderer: dashboard maximized-state changed. Returns unsubscribe. */
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
  /** renderer -> main: minimize / maximize-toggle / close the dashboard window */
  windowControl(action: WindowAction): void
}
