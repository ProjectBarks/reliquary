/**
 * Compendium search ranking — a pure function, on purpose.
 *
 * Everything that searches the Codex (the library toolbar, the compare modal's
 * candidate picker, and the quick-peek window this app will eventually grow)
 * has to agree about what "best match" means, or the same three letters will
 * produce three different first results. Keeping the ranking free of React and
 * of the store also makes it the one part of the feature that is trivially
 * testable.
 */

/** The minimum an item must offer to be rankable. */
export interface Searchable {
  id: string
  name: string
  description?: string | null
}

/**
 * Rank bands, best first. The gaps are deliberate: a name prefix and a
 * description mention are not neighbours, and leaving room between the bands
 * means a future tie-breaker can slot in without renumbering everything.
 */
export const RANK_PREFIX = 0
export const RANK_WORD = 1
export const RANK_SUBSTRING = 2
export const RANK_DESCRIPTION = 10

/** Non-alphanumerics start a word, which is what makes "strike" hit "Wild_Strike". */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9]/i.test(ch)
}

/**
 * Where `needle` sits inside `hay`, as a rank band — or null if it isn't there.
 * `needle` must already be lower-cased and trimmed by the caller; this runs
 * once per item per keystroke and shouldn't re-do that work 577 times.
 */
function rankIn(hay: string, needle: string): number | null {
  const at = hay.indexOf(needle)
  if (at < 0) return null
  if (at === 0) return RANK_PREFIX
  return isBoundary(hay[at - 1]) ? RANK_WORD : RANK_SUBSTRING
}

/**
 * How well one item answers a query. Lower is better; null means "no match".
 *
 * The id is searched as well as the name because the ids are what the API,
 * the tier list and the overlay's logs all speak — someone who has seen
 * `wild_strike` in a log should be able to paste it in and find the card.
 * A description-only hit still counts, but lands far below any name hit.
 */
export function rankMatch(item: Searchable, needle: string): number | null {
  if (!needle) return RANK_PREFIX
  const byName = rankIn(item.name.toLowerCase(), needle)
  if (byName !== null) return byName
  const byId = rankIn(item.id.toLowerCase(), needle)
  if (byId !== null) return byId
  const description = item.description
  if (description && description.toLowerCase().includes(needle)) return RANK_DESCRIPTION
  return null
}

/**
 * Filter and rank a list against a raw query string.
 *
 * An empty query returns the input untouched — same array, same order — so a
 * caller's own sort survives an empty search box instead of being re-shuffled
 * into alphabetical by a ranking that has nothing to rank on.
 *
 * Ties keep their incoming order (the sort is made stable by carrying the
 * original index), which is what lets "sort by score" still mean something
 * while a query is active.
 */
export function rankItems<T extends Searchable>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items.slice()
  const hits: Array<{ item: T; rank: number; at: number }> = []
  for (let i = 0; i < items.length; i++) {
    const rank = rankMatch(items[i], needle)
    if (rank !== null) hits.push({ item: items[i], rank, at: i })
  }
  hits.sort((a, b) => a.rank - b.rank || a.at - b.at)
  return hits.map((h) => h.item)
}
