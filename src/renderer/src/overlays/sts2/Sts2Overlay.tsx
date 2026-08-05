import type { Sts2StatPanel } from '@shared/types'
import { ErrorBoundary } from '../../telemetry'
import { useIpc, useSetting, useDiagnostics } from '../../hooks/useIpc'
import { DeckTracker } from './DeckTracker'
import { AttackSummary } from './AttackSummary'
import { StatPanels } from './StatPanels'
import { ModeBadge } from './ModeBadge'

/**
 * Root of the transparent StS2 overlay window (#/overlay/sts2).
 *
 * Mirrors the original's NGameStateOverlays -> RoomOverlay gating: read the
 * keyed game state, decide which overlays are visible for the current room, and
 * render them at fixed screen anchors. The whole surface is click-through; only
 * the DeckTracker opts back into pointer events (.interactive).
 */
export function Sts2Overlay(): JSX.Element {
  const nGameState = useIpc('sts2.nGameState')
  const cardData = useIpc('sts2.cardData')
  const pileState = useIpc('sts2.pileState')
  const enemiesState = useIpc('sts2.enemiesState')
  const layout = useIpc('sts2.layoutState')
  const diagnostics = useDiagnostics()

  const enableDeckTracker = useSetting('enableDeckTracker')
  const enableAttackSummary = useSetting('enableAttackSummary')
  const enableCardRewardStats = useSetting('enableCardRewardStats')
  const enableShopStats = useSetting('enableShopStats')
  const enableAncientChoiceStats = useSetting('enableAncientChoiceStats')

  const room = nGameState?.room ?? null
  // "Hard" obscurers always suppress every overlay (full-screen UI that genuinely
  // covers the game). isSubMenuOpen is deliberately NOT hard: the merchant's buy
  // screen registers as a submenu, so folding it in here would suppress the shop
  // stat tips (that was the shop-tip bug). It still hides the combat overlays.
  const hardObscured =
    !nGameState ||
    nGameState.capstoneScreen ||
    nGameState.isMapOpen ||
    nGameState.isTraveling ||
    nGameState.isPreviewContainerOpen ||
    nGameState.isInspectCardScreenOpen ||
    nGameState.isInspectRelicScreenOpen ||
    nGameState.isGameOver
  const subMenuOpen = nGameState?.isSubMenuOpen ?? false
  const isObscured = hardObscured || subMenuOpen
  const isHidden = !room || isObscured

  const isCombat = room?.type === 'combat'

  function gatedPanels(): Sts2StatPanel[] {
    // Panels are already gated to live-visible items in the provider's reader, so
    // only suppress them for full-screen obscuring UI — not for a missing room
    // (a card reward can sit over a null/transitioning room and must still show).
    if (!layout || hardObscured) return []
    // A submenu suppresses panels EXCEPT for the shop, where the buy screen itself
    // is the submenu the tips belong to.
    if (subMenuOpen && layout.source !== 'merchant') return []
    switch (layout.source) {
      case 'cardReward':
      case 'chooseACard':
      case 'grid':
        // All card-selection surfaces share the reward-stats toggle. Grid screens
        // (removal/transform/upgrade) show global card stats only — the provider
        // withholds deck-conditioned advice for them.
        return enableCardRewardStats ? layout.panels : []
      case 'merchant':
        return enableShopStats ? layout.panels : []
      case 'ancient':
        return enableAncientChoiceStats ? layout.panels : []
      case 'event':
        return layout.panels
      default:
        return []
    }
  }
  const panels = gatedPanels()

  return (
    <div className="sts2-overlay">
      <ModeBadge mode={diagnostics?.mode ?? 'live'} />

      {/* Each panel is isolated: the overlay is click-through and frameless, so
          an unhandled render error would silently blank the whole surface with
          nothing on screen to indicate anything went wrong. */}
      {enableAttackSummary && isCombat ? (
        <ErrorBoundary name="AttackSummary">
          <AttackSummary
            enemies={enemiesState?.enemies ?? null}
            isCombatInProgress={enemiesState?.isCombatInProgress ?? false}
            currentSide={enemiesState?.currentSide}
            isObscured={!!isObscured}
          />
        </ErrorBoundary>
      ) : null}

      {enableDeckTracker &&
      pileState &&
      !isObscured &&
      isCombat &&
      enemiesState?.isCombatInProgress ? (
        <ErrorBoundary name="DeckTracker">
          <DeckTracker
            pileState={pileState}
            cardData={cardData}
            isPeekButtonVisible={!!nGameState?.isPeekButtonVisible}
          />
        </ErrorBoundary>
      ) : null}

      <ErrorBoundary name="StatPanels">
        <StatPanels panels={panels} />
      </ErrorBoundary>
    </div>
  )
}
