import { useMemo } from 'react'
import { codexImageUrl, type CodexCard, type CodexPotion, type CodexRelic } from '@shared/codex'
import { useCatalog } from '../codex/data'
import { prettifyId } from '../codex/format'

/**
 * Names and art for the ids a run file records.
 *
 * A run file stores ids and nothing else — `ANGER`, `BREAD`, `ASHWATER` — which
 * is the right thing for a file that has to survive a compendium outage and a
 * decade of card renames. Everything human about them is a join, and this is
 * the join.
 *
 * It has two halves on purpose:
 *
 *   1. **The compendium**, when it is loaded. `useCatalog('cards')` is already
 *      warm for anyone who has opened the Codex tab, and it carries the real
 *      display name, the sprite and both full renders (base and upgraded).
 *   2. **A derived CDN path**, when it is not. The compendium is a network
 *      resource behind a cache; the Journal is a local file the user opened to
 *      read about their own run, and blanking every card in it because a
 *      revalidation is in flight would be absurd. The CDN's layout is stable
 *      and mechanical (`cards/anger.webp`, `cards-full/stable/anger_upg.webp`),
 *      the same one `codexImageUrl` produces from an API path, so an id alone
 *      is enough to paint a card.
 *
 * Both halves can be wrong about a given id — a modded card, a renamed one, an
 * id the CDN has no render for — which is why every image this module feeds
 * carries an `onerror` plate at the call site. The fallback is not decoration;
 * it is the state this join is in for anything the compendium has never heard
 * of.
 */

export interface ResolvedEntity {
  id: string
  /** The compendium's name, or the id prettified — never empty. */
  name: string
  /** Small sprite: route rows, sighting chips, mini rows. */
  sprite: string | null
  /** Full render: the deck ledger's 34×44 cells and the findings' 110px slots. */
  render: string | null
  /** Two letters for the name plate an image falls back to. */
  initials: string
  /** True when the compendium actually knew this id. */
  known: boolean
}

/** `ANGER` → `AN`, `SHRUG_IT_OFF` → `SO`, `X` → `X`. */
export function initialsFor(id: string, name?: string): string {
  const source = name && name.trim() ? name.trim() : id.replace(/_/g, ' ')
  const words = source.split(/[\s_]+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** The CDN's own file name for an id: `SHRUG_IT_OFF` → `shrug_it_off`. */
function slug(id: string): string {
  return id.trim().toLowerCase()
}

const CDN = 'https://cdn.spire-codex.com'

/** Derived sprite path — the same one `codexImageUrl('/static/images/…')` yields. */
export function derivedSprite(kind: 'cards' | 'relics' | 'potions', id: string): string | null {
  if (!id.trim()) return null
  return `${CDN}/${kind}/${slug(id)}.webp`
}

/** Derived full render. Cards only; relics and potions have no large art. */
export function derivedRender(id: string, upgraded: boolean): string | null {
  if (!id.trim()) return null
  return `${CDN}/cards-full/stable/${slug(id)}${upgraded ? '_upg' : ''}.webp`
}

/**
 * The lookup a component holds: `card(id, upgradeLevel)` and its two siblings.
 *
 * Returned as one object of functions rather than three hooks because a single
 * table row resolves a card, and the deck ledger resolves nineteen of them —
 * one memo over the catalogs beats nineteen subscriptions with identical
 * contents.
 */
export interface EntityLookup {
  card: (id: string, upgradeLevel?: number) => ResolvedEntity
  relic: (id: string) => ResolvedEntity
  potion: (id: string) => ResolvedEntity
  /** A merchant id of unknown kind: relic first, then potion, then card. */
  item: (id: string) => ResolvedEntity
  /** True once the card catalog has landed — drives "names are ids" whispers. */
  cardsKnown: boolean
}

export function useEntities(): EntityLookup {
  // `useCatalog` is stale-while-revalidate and never rejects, so these are
  // simply "the best copy so far, possibly null". Nothing below waits on them.
  const cards = useCatalog('cards')
  const relics = useCatalog('relics')
  const potions = useCatalog('potions')

  return useMemo(() => {
    const cardIndex = indexById(cards.data as CodexCard[] | null)
    const relicIndex = indexById(relics.data as CodexRelic[] | null)
    const potionIndex = indexById(potions.data as CodexPotion[] | null)

    const card = (id: string, upgradeLevel = 0): ResolvedEntity => {
      const row = cardIndex.get(key(id))
      const upgraded = upgradeLevel > 0
      const name = row?.name ?? prettifyId(id)
      // `image_url_card_upg` is genuinely absent for cards with no upgrade art;
      // falling back to the base render is better than an empty slot, and the
      // `+` on the name already says which copy this row is.
      const render = upgraded
        ? codexImageUrl(row?.image_url_card_upg) ??
          codexImageUrl(row?.image_url_card) ??
          derivedRender(id, true)
        : codexImageUrl(row?.image_url_card) ?? derivedRender(id, false)
      return {
        id,
        name,
        sprite: codexImageUrl(row?.image_url) ?? derivedSprite('cards', id),
        render,
        initials: initialsFor(id, row?.name),
        known: Boolean(row)
      }
    }

    const simple =
      <T extends { name: string; image_url: string | null }>(
        index: Map<string, T>,
        kind: 'relics' | 'potions'
      ) =>
      (id: string): ResolvedEntity => {
        const row = index.get(key(id))
        return {
          id,
          name: row?.name ?? prettifyId(id),
          sprite: codexImageUrl(row?.image_url) ?? derivedSprite(kind, id),
          render: null,
          initials: initialsFor(id, row?.name),
          known: Boolean(row)
        }
      }

    const relic = simple(relicIndex, 'relics')
    const potion = simple(potionIndex, 'potions')

    return {
      card,
      relic,
      potion,
      item: (id: string): ResolvedEntity => {
        if (relicIndex.has(key(id))) return relic(id)
        if (potionIndex.has(key(id))) return potion(id)
        // Nothing knows it: relic art is the better guess for shop stock, and
        // the plate covers the miss either way.
        return relic(id)
      },
      cardsKnown: cardIndex.size > 0
    }
  }, [cards.data, relics.data, potions.data])
}

/** Ids are upper-case on both sides today; matching on a normalised key anyway. */
function key(id: string): string {
  return id.trim().toUpperCase()
}

function indexById<T extends { id: string }>(rows: T[] | null | undefined): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows ?? []) map.set(key(row.id), row)
  return map
}
