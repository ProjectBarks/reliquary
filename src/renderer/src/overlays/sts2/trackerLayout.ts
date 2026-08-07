/**
 * Layout engine for the free-placement deck tracker.
 *
 * Every row the tracker draws has a KNOWN height (card tiles are fixed-height
 * strips), so the optimal layout for a given panel size is arithmetic, not
 * measurement: no ResizeObserver, no reflow loops, no CSS multicol guessing.
 *
 * The dragged rectangle is treated as a DESIRED AREA. The engine fills it
 * with even columns of type-groups, and the panel then hugs whatever is
 * actually used. Three guarantees, in order:
 *
 *   1. Content FITS the area — there is never a scrollbar. Groups split
 *      across columns under a "· cont" header when that packs better, and
 *      the row density steps down (24 → 21 → 18 px) before anything is
 *      given up on.
 *   2. Reading order is preserved. If the area is genuinely too small, what
 *      is hidden is exactly the TAIL of the list, and it is declared by a
 *      "+N hidden" chip — content is never silently clipped and never
 *      reordered around a gap.
 *   3. Columns come out even. The packer tries the balanced height first and
 *      a few taller targets, keeping the most level result, so no column is
 *      left as a two-row stub under a full neighbour.
 */

export interface Density {
  /** Card tile height / gap between tiles. */
  rowH: number
  rowGap: number
  /** Group header line height, incl. its hairline rule. */
  headerH: number
  /** Vertical space between two groups in the same column. */
  groupGap: number
  /** Font sizes handed to the tiles. */
  font: number
  countFont: number
}

/** Step 0 is the classic tracker's density; steps 1–2 are the shrink ladder. */
export const DENSITIES: readonly Density[] = [
  { rowH: 24, rowGap: 2, headerH: 19, groupGap: 10, font: 13, countFont: 12 },
  { rowH: 21, rowGap: 2, headerH: 17, groupGap: 8, font: 12, countFont: 11 },
  { rowH: 18, rowGap: 1, headerH: 16, groupGap: 6, font: 11, countFont: 10 }
]

export const COL_GAP = 13
export const MIN_COL_W = 150
export const MAX_COL_W = 230

export interface LayoutGroup<R> {
  type: string
  count: number
  total: number
  rows: R[]
}

export interface Segment<R> {
  group: LayoutGroup<R>
  rows: R[]
  /** 1 renders the full header; >1 renders a "· cont" header. */
  part: number
}

export interface TrackerLayout<R> {
  columns: Segment<R>[][]
  density: Density
  densityStep: number
  colW: number
  /** Rows that fit nowhere; rendered as a "+N hidden" chip when > 0. */
  hiddenRows: number
  /** Height of the tallest column — what the shell hugs down to. */
  usedH: number
}

interface PackResult<R> {
  columns: Segment<R>[][]
  hiddenRows: number
  usedH: number
  colHeights: number[]
}

const segHeight = (d: Density, lines: number): number =>
  d.headerH + lines * (d.rowH + d.rowGap) - (lines > 0 ? d.rowGap : 0)

const naturalHeight = <R>(groups: LayoutGroup<R>[], d: Density): number =>
  groups.reduce(
    (sum, g, i) => sum + (i > 0 ? d.groupGap : 0) + segHeight(d, g.rows.length),
    0
  )

/**
 * First-fit packing of groups (in type order) into columns of height targetH.
 *
 * A group that will not fit in the remaining space continues into the next
 * column under a "· cont" header — but never leaves an orphan of fewer than
 * 2 tiles on either side of the break. Once anything is hidden, everything
 * after it is hidden too, so the chip always describes a clean tail.
 */
function pack<R>(
  groups: LayoutGroup<R>[],
  d: Density,
  targetH: number,
  maxCols: number
): PackResult<R> {
  const columns: Segment<R>[][] = [[]]
  const heights = [0]
  let hidden = 0

  const current = (): Segment<R>[] => columns[columns.length - 1]
  const room = (): number =>
    targetH - heights[heights.length - 1] - (current().length ? d.groupGap : 0)
  const place = (seg: Segment<R>, h: number): void => {
    heights[heights.length - 1] += (current().length ? d.groupGap : 0) + h
    current().push(seg)
  }
  const rowsThatFit = (): number =>
    Math.floor((room() - d.headerH + d.rowGap) / (d.rowH + d.rowGap))

  for (const group of groups) {
    if (hidden > 0) {
      hidden += group.rows.length
      continue
    }
    let rows = group.rows
    let part = 1
    while (rows.length > 0) {
      const wantH = segHeight(d, rows.length)
      if (wantH <= room()) {
        place({ group, rows, part }, wantH)
        break
      }
      let fit = rowsThatFit()
      // Splitting at `fit` would strand a single row; give one row back so
      // both sides keep 2. Without this, a target that is one row too tight
      // dead-ends and forces the packer to a much looser (less level) target.
      if (fit >= 3 && rows.length - fit === 1) fit -= 1
      if (fit >= 2 && rows.length - fit >= 2) {
        place({ group, rows: rows.slice(0, fit), part }, segHeight(d, fit))
        rows = rows.slice(fit)
        part++
      } else if (current().length === 0) {
        // Even an empty column cannot hold it: the area is genuinely too
        // small. Keep what fits, declare the rest.
        const kept = rows.slice(0, Math.max(fit, 1))
        hidden += rows.length - kept.length
        place({ group, rows: kept, part }, segHeight(d, kept.length))
        break
      }
      if (columns.length >= maxCols) {
        hidden += rows.length
        break
      }
      columns.push([])
      heights.push(0)
    }
  }

  return {
    columns: columns.filter((c) => c.length > 0),
    hiddenRows: hidden,
    usedH: Math.max(0, ...heights),
    colHeights: heights.filter((h) => h > 0)
  }
}

/**
 * Pack toward EVEN columns: try the balanced estimate and a few taller
 * targets, and keep the most level fit. A single target can strand a 2-row
 * stub (a group that cannot split into the leftover space forces everything
 * after it onward); a slightly taller target absorbs the stub.
 */
function packEven<R>(
  groups: LayoutGroup<R>[],
  d: Density,
  availH: number,
  maxCols: number
): PackResult<R> {
  const even = Math.ceil(naturalHeight(groups, d) / maxCols) + d.headerH
  // A reasonably fine ladder from "perfectly balanced" up to "the whole box":
  // splitting adds header overhead the estimate cannot see, so the tightest
  // target often misses by a row or two, and the next rung must be close or
  // the final layout lurches from level to lopsided.
  const targets = [
    ...new Set(
      [1, 1.06, 1.12, 1.2, 1.3, 1.45]
        .map((f) => Math.round(even * f))
        .concat(availH)
        .map((t) => Math.min(t, availH))
    )
  ]
  let best: PackResult<R> | null = null
  const spread = (r: PackResult<R>): number =>
    Math.max(...r.colHeights) - Math.min(...r.colHeights)
  for (const target of targets) {
    const r = pack(groups, d, target, maxCols)
    if (r.hiddenRows > 0) continue
    if (!best || spread(r) < spread(best)) best = r
  }
  return best ?? pack(groups, d, availH, maxCols)
}

/** Column count the desired width affords, and the width each column gets. */
function colsForWidth(availW: number): { cols: number; colW: number } {
  const cols = Math.max(1, Math.floor((availW + COL_GAP) / (MIN_COL_W + COL_GAP)))
  const colW = Math.min(MAX_COL_W, Math.floor((availW - (cols - 1) * COL_GAP) / cols))
  return { cols, colW }
}

/** Fill the desired area: even split-allowed columns, density as a fallback. */
export function layoutTracker<R>(
  groups: LayoutGroup<R>[],
  availW: number,
  availH: number
): TrackerLayout<R> {
  const { cols, colW } = colsForWidth(availW)
  let last: TrackerLayout<R> | null = null
  for (let step = 0; step < DENSITIES.length; step++) {
    const d = DENSITIES[step]
    const r = packEven(groups, d, availH, cols)
    last = { ...r, density: d, densityStep: step, colW }
    if (r.hiddenRows === 0) return last
  }
  return last as TrackerLayout<R>
}
