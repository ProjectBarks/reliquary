import type { GapReason, RunEvent, RunFile } from '@shared/types'
import { roomKind, type RoomKind } from './format'

/**
 * The run file's event log, folded into the two ledgers the report renders.
 *
 * Everything here is a *projection*: the file is the truth, nothing is stored,
 * and re-running this over the same file always produces the same rows. That
 * matters more than it sounds — the recorder writes events the moment it sees
 * them and this is the only place that decides what they meant, so a mistake
 * here is a rendering bug rather than data loss.
 *
 * Three structural facts shape everything below:
 *
 *   1. **Offers resolve late, and usually in the next room.** `enterRoom`
 *      closes any open offer's inference window, so the `offer_resolved` for a
 *      reward shown in R10 is written *after* R11's `room_enter`. Attaching
 *      outcomes to "whatever room is current" would put every skip one row too
 *      low. Offers are tracked by `eid` and their outcome is attached to the
 *      room they were *shown* in — the room the reader remembers.
 *   2. **Notes are data, not sentences.** A route note needs a card's display
 *      name, and names live in the compendium join, not in the log. So this
 *      module emits structured notes and `routeNoteText` turns them into words
 *      given a name function. It keeps the fold pure and testable, and keeps
 *      one copy of the phrasing.
 *   3. **Unknown event types must survive.** The recorder writes more types
 *      than `shared/journal.ts` names, and a future build will write more still.
 *      Every read goes through a tolerant accessor and every unrecognised type
 *      is skipped — a file from a newer build renders what it can.
 */

// ── tolerant field access ───────────────────────────────────────────────────

type Bag = Record<string, unknown>

function str(e: RunEvent, key: string): string | null {
  const v = (e as unknown as Bag)[key]
  return typeof v === 'string' ? v : null
}

function num(e: RunEvent, key: string): number | null {
  const v = (e as unknown as Bag)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strs(e: RunEvent, key: string): string[] {
  const v = (e as unknown as Bag)[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function costMap(e: RunEvent, key: string): Record<string, number> {
  const v = (e as unknown as Bag)[key]
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [id, cost] of Object.entries(v as Bag)) {
    if (typeof cost === 'number' && Number.isFinite(cost)) out[id] = cost
  }
  return out
}

// ── the route ledger ────────────────────────────────────────────────────────

/** One card in a route row's pickup cell. */
export interface RouteCard {
  id: string
  upgradeLevel: number
  /** Gold price, when the room was a shop and the price was readable. */
  cost: number | null
}

/**
 * What happened in a room, before it becomes words. Each note is at most a
 * handful of words once rendered — the blend spec's ≤6-word budget for the
 * entry cell is enforced by there being nothing longer to say.
 */
export type RouteNote =
  | { t: 'enemies'; n: number }
  | { t: 'removed'; id: string; upgradeLevel: number }
  | { t: 'upgraded'; id: string; upgradeLevel: number }
  | { t: 'bought'; id: string; cost: number | null }
  | { t: 'skipped' }
  | { t: 'no-purchase' }
  | { t: 'event-add' }
  | { t: 'gained' }
  | { t: 'game-over' }

export interface RouteRoom {
  kind: 'room'
  key: string
  /** Our own count of rooms entered — `R01`, `R02`, … */
  roomIndex: number
  /** The game's own cumulative floor. Exact since WP1; null on older files. */
  floor: number | null
  act: number | null
  room: RoomKind
  notes: RouteNote[]
  /** What entered the deck here. */
  pickup: RouteCard | null
  /** What was offered and left — struck through beside the pickup. */
  passed: RouteCard[]
  /** The run's last room: the one tinted row. */
  end: boolean
  /** Finding reference (`F-01`), attached from the analysis when there is one. */
  flag: string | null
}

export interface RouteActBreak {
  kind: 'act'
  key: string
  /** 1-based, the way a human counts acts. */
  act: number
  note: string
}

export interface RouteGap {
  kind: 'gap'
  key: string
  reason: GapReason
  note: string
}

export type RouteLine = RouteRoom | RouteActBreak | RouteGap

export interface RouteCensus {
  fight: number
  event: number
  shop: number
  other: number
  total: number
}

export interface RouteTotals {
  rooms: number
  taken: number
  skipped: number
  upgrades: number
  removals: number
}

/** Shop stock we could see but never owned — the only relic/potion trace today. */
export interface Sighting {
  id: string
  cost: number | null
  roomIndex: number
  floor: number | null
}

export interface DerivedRoute {
  lines: RouteLine[]
  rooms: RouteRoom[]
  census: RouteCensus
  totals: RouteTotals
  sightings: Sighting[]
  /** True when the file holds no `room_enter` at all — an empty ledger, honestly. */
  empty: boolean
}

interface OpenOffer {
  source: string
  offered: string[]
  costs: Record<string, number>
  room: RouteRoom | null
  picked: string | null
}

const MAX_NOTES = 3
const MAX_PASSED = 3

export function deriveRoute(run: RunFile): DerivedRoute {
  const lines: RouteLine[] = []
  const rooms: RouteRoom[] = []
  const sightings: Sighting[] = []
  const offers = new Map<number, OpenOffer>()
  const totals: RouteTotals = { rooms: 0, taken: 0, skipped: 0, upgrades: 0, removals: 0 }
  let current: RouteRoom | null = null
  let act: number | null = null
  let seq = 0

  const note = (row: RouteRoom | null, entry: RouteNote): void => {
    if (!row || row.notes.length >= MAX_NOTES) return
    row.notes.push(entry)
  }

  for (const event of run.events) {
    seq++
    switch (event.type) {
      case 'room_enter': {
        const roomIndex = num(event, 'roomIndex') ?? totals.rooms + 1
        act = num(event, 'actIndex') ?? act
        current = {
          kind: 'room',
          key: `r${roomIndex}-${seq}`,
          roomIndex,
          floor: num(event, 'floor'),
          act,
          room: roomKind(str(event, 'roomType')),
          notes: [],
          pickup: null,
          passed: [],
          end: false,
          flag: null
        }
        totals.rooms++
        rooms.push(current)
        lines.push(current)
        break
      }

      case 'act_change': {
        const to = num(event, 'to')
        if (to === null) break
        act = to
        lines.push({
          kind: 'act',
          key: `act${to}-${seq}`,
          act: to + 1,
          note: 'act index changed after this room (boss inferred)'
        })
        break
      }

      case 'gap': {
        const reason = (str(event, 'reason') ?? 'unobserved-play') as GapReason
        const added = strs(event, 'deckAdded').length
        const removed = strs(event, 'deckRemoved').length
        const from = num(event, 'actFrom')
        const to = num(event, 'actTo')
        const parts = [reason === 'save-restore' ? 'restored save' : 'played without us']
        if (from !== null && to !== null && from !== to) parts.push(`act ${from + 1}→${to + 1}`)
        if (added) parts.push(`+${added} card${added === 1 ? '' : 's'}`)
        if (removed) parts.push(`−${removed} card${removed === 1 ? '' : 's'}`)
        lines.push({ kind: 'gap', key: `gap-${seq}`, reason, note: parts.join(' · ') })
        break
      }

      case 'combat_start': {
        const enemies = num(event, 'enemies')
        if (enemies !== null && enemies > 1) note(current, { t: 'enemies', n: enemies })
        break
      }

      case 'offer_shown': {
        const eid = num(event, 'eid')
        if (eid === null) break
        const source = str(event, 'source') ?? 'unknown'
        const offered = strs(event, 'offered')
        const costs = costMap(event, 'costs')
        offers.set(eid, { source, offered, costs, room: current, picked: null })
        // Merchant stock carries priced ids that are *not* cards — relics and
        // potions. Shop stock is the only observable trace either leaves today,
        // which is exactly what the Relics & Potions strip admits to showing.
        if (source === 'merchant') {
          for (const [id, cost] of Object.entries(costs)) {
            if (offered.includes(id)) continue
            if (sightings.some((s) => s.id === id && s.roomIndex === current?.roomIndex)) continue
            sightings.push({
              id,
              cost,
              roomIndex: current?.roomIndex ?? 0,
              floor: current?.floor ?? null
            })
          }
        }
        break
      }

      case 'offer_resolved': {
        const eid = num(event, 'eid')
        const offer = eid === null ? undefined : offers.get(eid)
        if (!offer) break
        const picked = str(event, 'picked')
        offer.picked = picked
        if (picked === null) {
          totals.skipped++
          note(offer.room, offer.source === 'merchant' ? { t: 'no-purchase' } : { t: 'skipped' })
        }
        // Everything offered and not taken is recorded either way. When the row
        // has no pickup they render struck through; when it does, they ride the
        // pickup cell's tooltip — the row already spends its one accent on the
        // card that was taken, and sixteen reward rows each listing three
        // rejected cards is the noise the blend spec exists to prevent.
        if (offer.room) {
          offer.room.passed = offer.offered
            .filter((id) => id !== picked)
            .slice(0, MAX_PASSED)
            .map((id) => ({ id, upgradeLevel: 0, cost: offer.costs[id] ?? null }))
        }
        break
      }

      case 'deck_add': {
        const id = str(event, 'id')
        if (!id) break
        totals.taken++
        const eid = num(event, 'offerEid')
        const offer = eid === null ? undefined : offers.get(eid)
        const row = offer?.room ?? current
        const cost = offer?.costs[id] ?? null
        const card: RouteCard = { id, upgradeLevel: num(event, 'upgradeLevel') ?? 0, cost }
        if (row) row.pickup = card
        if (offer?.source === 'merchant') note(row, { t: 'bought', id, cost })
        else if (!offer) note(row, row?.room === 'event' ? { t: 'event-add' } : { t: 'gained' })
        break
      }

      case 'deck_remove': {
        const id = str(event, 'id')
        totals.removals++
        if (id) note(current, { t: 'removed', id, upgradeLevel: num(event, 'upgradeLevel') ?? 0 })
        break
      }

      case 'deck_upgrade': {
        const id = str(event, 'id')
        totals.upgrades++
        if (id) note(current, { t: 'upgraded', id, upgradeLevel: num(event, 'upgradeLevel') ?? 1 })
        break
      }

      case 'game_over': {
        if (current) {
          current.end = true
          current.notes = [{ t: 'game-over' }]
        }
        break
      }

      default:
        break
    }
  }

  const census: RouteCensus = { fight: 0, event: 0, shop: 0, other: 0, total: 0 }
  for (const room of rooms) {
    census[room.room]++
    census.total++
  }

  return { lines, rooms, census, totals, sightings, empty: census.total === 0 }
}

// ── the live view's tail of the same ledger ─────────────────────────────────

/** The Current Run panel's slice of a `DerivedRoute`, ready for `RouteLedger`. */
export interface RecentRoute extends Pick<DerivedRoute, 'lines' | 'totals' | 'empty'> {
  /** Rooms hidden above the strip — "…R01–R18 collapsed". Null when none are. */
  collapsedBefore: number | null
  /** How many rooms the strip is actually showing. */
  shown: number
}

/**
 * The last few rooms of a run in progress.
 *
 * This is the *only* thing the Current Run view is allowed to do differently
 * from the report, and it is presentation, not derivation: same `deriveRoute`
 * over the same run file, sliced. It lives here rather than in the view for the
 * reason the whole unification exists — a route row assembled anywhere but this
 * module is a second engine, and the last one shipped with `pickup: null`
 * hard-coded into it, so the live view showed no pickups for runs whose report
 * listed every card.
 *
 * The slice is taken over *rooms* and then widened back to `lines`, so an act
 * break or a gap that falls inside the tail travels with it — cutting `lines`
 * directly would drop the act divider that explains the rows under it.
 */
export function recentRoute(route: DerivedRoute, limit = 6): RecentRoute {
  const kept = limit > 0 ? route.rooms.slice(-limit) : []
  const first = kept[0]
  if (!first) {
    return { lines: [], totals: route.totals, empty: true, collapsedBefore: null, shown: 0 }
  }
  const from = route.lines.indexOf(first)
  const lines = from === -1 ? kept : route.lines.slice(from)
  return {
    lines,
    totals: route.totals,
    empty: false,
    collapsedBefore: first.roomIndex > 1 ? first.roomIndex - 1 : null,
    shown: kept.length
  }
}

/**
 * A note, in words.
 *
 * `name` is the caller's resolver (the compendium join, or `prettifyId` when
 * the catalog has not landed); `outcome` is the run's own verdict word, so the
 * last row says DEFEATED or VICTORIOUS rather than a generic "game over" that
 * the header has already contradicted.
 */
export function routeNoteText(
  note: RouteNote,
  name: (id: string) => string,
  outcome: string
): string {
  switch (note.t) {
    case 'enemies':
      return `${note.n} enemies`
    case 'removed':
      return `removed ${name(note.id)}`
    case 'upgraded':
      return `upgraded ${name(note.id)}${note.upgradeLevel > 0 ? '+' : ''}`
    case 'bought':
      return note.cost === null
        ? `bought ${name(note.id)}`
        : `bought ${name(note.id)} ${note.cost}g`
    case 'skipped':
      return 'reward skipped'
    case 'no-purchase':
      return 'no card gained'
    case 'event-add':
      return 'event add'
    case 'gained':
      return 'card gained'
    case 'game-over':
      return `${outcome} — game over`
  }
}

// ── the deck ledger ─────────────────────────────────────────────────────────

export interface DeckLedgerRow {
  /** Base card id. One row per id — see the note on `deriveDeck`. */
  id: string
  copies: number
  /** How many copies are upgraded, and how far the best one went. */
  upgradedCopies: number
  maxUpgrade: number
  /** Null when no combat was ever observed — not zero. */
  drawn: number | null
  played: number | null
  dead: number | null
  /** Plays per draw, 0–100, or null when there is nothing to divide. */
  rate: number | null
  /** Named in the run's own signature: the cards that defined it. */
  core: boolean
  /** Drawn at least once and never played. */
  never: boolean
}

export interface DeckLedger {
  rows: DeckLedgerRow[]
  cards: number
  drawn: number | null
  played: number | null
  dead: number | null
  rate: number | null
  neverPlayed: number
  /** True when `combatAgg` is empty: composition without counts. */
  countsMissing: boolean
  /** True when there is no final deck yet (the run is still going). */
  empty: boolean
}

/**
 * The final deck, joined to the run's play tallies.
 *
 * **One row per base id, not per upgrade level** — a deliberate departure from
 * the mockup, forced by the data. The recorder tallies plays and draws per
 * instance id (`bump(combat.plays, card.id)`), and a card's id does not carry
 * its upgrade level; only the deck multiset does. `Shrug It Off` and
 * `Shrug It Off+` therefore share exactly one pair of numbers, and two rows
 * would mean either duplicating them (implying each copy was drawn 19 times) or
 * splitting them (inventing an attribution nobody measured). The upgrade
 * composition rides inside the row instead — `×2` plus an upgrade mark — so the
 * only thing lost is a false precision.
 */
export function deriveDeck(run: RunFile): DeckLedger {
  const groups = run.finalDeck ?? []
  const plays = run.snapshot.combatAgg?.plays ?? {}
  const drawn = run.snapshot.combatAgg?.drawn ?? {}
  const countsMissing = Object.keys(drawn).length === 0 && Object.keys(plays).length === 0
  const core = new Set(run.signature.core.map((id) => id.toUpperCase()))

  const byId = new Map<string, DeckLedgerRow>()
  for (const group of groups) {
    let row = byId.get(group.id)
    if (!row) {
      row = {
        id: group.id,
        copies: 0,
        upgradedCopies: 0,
        maxUpgrade: 0,
        drawn: null,
        played: null,
        dead: null,
        rate: null,
        core: core.has(group.id.toUpperCase()),
        never: false
      }
      byId.set(group.id, row)
    }
    row.copies += group.count
    if (group.upgradeLevel > 0) row.upgradedCopies += group.count
    row.maxUpgrade = Math.max(row.maxUpgrade, group.upgradeLevel)
  }

  for (const row of byId.values()) {
    if (countsMissing) continue
    const d = drawn[row.id] ?? 0
    const p = plays[row.id] ?? 0
    row.drawn = d
    row.played = p
    row.dead = Math.max(0, d - p)
    row.rate = d > 0 ? (p / d) * 100 : null
    row.never = d > 0 && p === 0
  }

  const rows = [...byId.values()].sort(compareDeckRows)
  const totals = rows.reduce(
    (acc, row) => ({
      cards: acc.cards + row.copies,
      drawn: acc.drawn + (row.drawn ?? 0),
      played: acc.played + (row.played ?? 0),
      dead: acc.dead + (row.dead ?? 0)
    }),
    { cards: 0, drawn: 0, played: 0, dead: 0 }
  )

  return {
    rows,
    cards: totals.cards,
    drawn: countsMissing ? null : totals.drawn,
    played: countsMissing ? null : totals.played,
    dead: countsMissing ? null : totals.dead,
    rate: countsMissing || totals.drawn === 0 ? null : (totals.played / totals.drawn) * 100,
    neverPlayed: rows.filter((r) => r.never).length,
    countsMissing,
    empty: groups.length === 0
  }
}

/** Played descending, never-played last, ties broken by draws then by id. */
function compareDeckRows(a: DeckLedgerRow, b: DeckLedgerRow): number {
  if (a.never !== b.never) return a.never ? 1 : -1
  const ap = a.played ?? -1
  const bp = b.played ?? -1
  if (ap !== bp) return bp - ap
  const ad = a.drawn ?? -1
  const bd = b.drawn ?? -1
  if (ad !== bd) return bd - ad
  return a.id.localeCompare(b.id)
}

/** Whether anything in this file is an under-count: drives the `≈` prefixes. */
export function isPartial(run: Pick<RunFile, 'countsArePartial' | 'observedFrom'>): boolean {
  return run.countsArePartial || run.observedFrom === 'mid-run'
}
