/**
 * Layout engine for the deck tracker.
 *
 * Every row the tracker draws has a KNOWN height (card tiles are fixed-height
 * strips), which means the optimal layout for a given panel size is arithmetic,
 * not measurement: no ResizeObserver, no reflow loops, no CSS multicol
 * guessing. The engine takes the grouped pile and the space available and
 * returns explicit columns of segments, chosen so that
 *
 *   - content FITS the box: no scrollbar, ever;
 *   - waste is minimized: the panel hugs its content, shrinking to what is
 *     actually used rather than holding the dragged rectangle open;
 *   - anything that cannot fit is declared honestly (a "+N hidden" chip),
 *     never silently clipped.
 *
 * Five strategies share this engine (the mock harness switches between them):
 *
 *   flow    – CSS multicol + scroll; the control. Not computed here.
 *   packer  – height is authoritative, width is derived: groups pack into as
 *             many fixed-width columns as the height demands.
 *   balance – the user's box is authoritative: pick the column count from the
 *             width, then split groups (with "continued" headers) so columns
 *             come out even and nothing overflows.
 *   scale   – the user's box is authoritative and groups stay atomic: step the
 *             row density down (24 → 21 → 18 px) until everything fits.
 *   squeeze – fixed density, atomic groups: reclaim space by collapsing the
 *             least valuable rows first (cards already drawn) into one summary
 *             line per group.
 */

export type LayoutMode = 'flow' | 'packer' | 'balance' | 'scale' | 'squeeze'

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

/** Step 0 is the original tracker's density; steps 1–2 are the shrink ladder. */
export const DENSITIES: readonly Density[] = [
  { rowH: 24, rowGap: 2, headerH: 19, groupGap: 10, font: 13, countFont: 12 },
  { rowH: 21, rowGap: 2, headerH: 17, groupGap: 8, font: 12, countFont: 11 },
  { rowH: 18, rowGap: 1, headerH: 16, groupGap: 6, font: 11, countFont: 10 }
]

export const COL_GAP = 13
export const MIN_COL_W = 150
export const MAX_COL_W = 230
/** Hard ceiling on columns the packer may open (keeps width on-screen). */
export const MAX_PACK_COLS = 6
export const PACK_COL_W = 176

export interface LayoutGroup<R> {
  type: string
  count: number
  total: number
  rows: R[]
  /** Rows folded into a one-line summary (squeeze mode). */
  collapsed: number
  collapsedLabel: string
}

export interface Segment<R> {
  group: LayoutGroup<R>
  rows: R[]
  /** 1 renders the full header; >1 renders a "· cont" header. */
  part: number
  /** The collapsed-rows summary line renders after the final part only. */
  showSummary: boolean
}

export interface TrackerLayout<R> {
  columns: Segment<R>[][]
  density: Density
  densityStep: number
  colW: number
  /** Rows that fit nowhere; rendered as a "+N hidden" chip when > 0. */
  hiddenRows: number
  /** Height of the tallest column — what the shell shrinks to. */
  usedH: number
}

interface PackResult<R> {
  columns: Segment<R>[][]
  hiddenRows: number
  usedH: number
}

const segHeight = (d: Density, lines: number): number =>
  d.headerH + lines * (d.rowH + d.rowGap) - (lines > 0 ? d.rowGap : 0)

const groupLines = <R>(g: LayoutGroup<R>): number => g.rows.length + (g.collapsed > 0 ? 1 : 0)

export const naturalHeight = <R>(groups: LayoutGroup<R>[], d: Density): number =>
  groups.reduce(
    (sum, g, i) => sum + (i > 0 ? d.groupGap : 0) + segHeight(d, groupLines(g)),
    0
  )

/**
 * First-fit packing of groups (in type order) into columns of height targetH.
 *
 * When `allowSplit` is set, a group that will not fit in the remaining space
 * continues into the next column under a "· cont" header — but never leaves an
 * orphan of fewer than 2 tiles on either side of the break.
 */
function pack<R>(
  groups: LayoutGroup<R>[],
  d: Density,
  targetH: number,
  maxCols: number,
  allowSplit: boolean
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
  /** Rows that fit in `room` alongside a header (and optional summary line). */
  const rowsThatFit = (summaryToo: boolean): number =>
    Math.floor((room() - d.headerH + d.rowGap) / (d.rowH + d.rowGap)) - (summaryToo ? 1 : 0)

  for (const group of groups) {
    const summary = group.collapsed > 0
    let rows = group.rows
    let part = 1
    // Once anything is hidden, everything after it is hidden too: showing
    // OTHER while POWER is missing would make the "+N hidden" chip a lie
    // about WHERE the missing cards are.
    if (hidden > 0) {
      hidden += rows.length + (summary ? 1 : 0)
      continue
    }
    for (;;) {
      const lines = rows.length + (summary ? 1 : 0)
      if (lines === 0) break
      const wantH = segHeight(d, lines)
      if (wantH <= room()) {
        place({ group, rows, part, showSummary: summary }, wantH)
        break
      }
      const fit = rowsThatFit(false)
      // Split forward when allowed and both sides keep at least 2 tiles.
      if (allowSplit && fit >= 2 && rows.length - fit >= 2) {
        place({ group, rows: rows.slice(0, fit), part, showSummary: false }, segHeight(d, fit))
        rows = rows.slice(fit)
        part++
      } else if (current().length === 0) {
        // An empty column still cannot hold it: the box is genuinely too
        // small. Keep what fits, declare the rest.
        const keep = Math.max(fit, 1)
        const kept = rows.slice(0, keep)
        hidden += rows.length - kept.length + (summary ? 1 : 0)
        place({ group, rows: kept, part, showSummary: false }, segHeight(d, kept.length))
        break
      }
      if (columns.length >= maxCols) {
        hidden += rows.length + (summary ? 1 : 0)
        break
      }
      columns.push([])
      heights.push(0)
    }
  }

  return {
    columns: columns.filter((c) => c.length > 0),
    hiddenRows: hidden,
    usedH: Math.max(0, ...heights)
  }
}

const done = <R>(r: PackResult<R>, d: Density, step: number, colW: number): TrackerLayout<R> => ({
  ...r,
  density: d,
  densityStep: step,
  colW
})

/** Column count the dragged width affords, and the width each column gets. */
function colsForWidth(availW: number): { cols: number; colW: number } {
  const cols = Math.max(1, Math.floor((availW + COL_GAP) / (MIN_COL_W + COL_GAP)))
  const colW = Math.min(MAX_COL_W, Math.floor((availW - (cols - 1) * COL_GAP) / cols))
  return { cols, colW }
}

/** packer: height rules; columns (and therefore width) follow from it. */
export function layoutPacker<R>(groups: LayoutGroup<R>[], availH: number): TrackerLayout<R> {
  const d = DENSITIES[0]
  // First pass finds how many columns the height demands; the second levels
  // them, so the last column is not left half-empty under a full first one.
  const first = pack(groups, d, availH, MAX_PACK_COLS, true)
  const cols = first.columns.length
  if (cols > 1 && first.hiddenRows === 0) {
    const even = Math.ceil(naturalHeight(groups, d) / cols) + d.headerH
    if (even < availH) {
      const leveled = pack(groups, d, even, cols, true)
      if (leveled.hiddenRows === 0 && leveled.columns.length === cols) {
        return done(leveled, d, 0, PACK_COL_W)
      }
    }
  }
  return done(first, d, 0, PACK_COL_W)
}

/** balance: fill the user's box with even, split-allowed columns. */
export function layoutBalance<R>(
  groups: LayoutGroup<R>[],
  availW: number,
  availH: number
): TrackerLayout<R> {
  const { cols, colW } = colsForWidth(availW)
  let last: TrackerLayout<R> | null = null
  for (let step = 0; step < DENSITIES.length; step++) {
    const d = DENSITIES[step]
    // Aim for even columns: the balanced height, not the full box — but the
    // extra "cont" headers splitting introduces can push a column past the
    // estimate, so fall back to the full box before giving up on this density.
    const even = Math.ceil(naturalHeight(groups, d) / cols) + d.headerH
    let r = pack(groups, d, Math.min(availH, even), cols, true)
    if (r.hiddenRows > 0) r = pack(groups, d, availH, cols, true)
    last = done(r, d, step, colW)
    if (r.hiddenRows === 0) return last
  }
  return last as TrackerLayout<R>
}

/** scale: keep groups atomic; shrink density until the box holds them. */
export function layoutScale<R>(
  groups: LayoutGroup<R>[],
  availW: number,
  availH: number
): TrackerLayout<R> {
  const { cols, colW } = colsForWidth(availW)
  let last: TrackerLayout<R> | null = null
  for (let step = 0; step < DENSITIES.length; step++) {
    const d = DENSITIES[step]
    const r = pack(groups, d, availH, cols, false)
    last = done(r, d, step, colW)
    if (r.hiddenRows === 0) return last
  }
  return last as TrackerLayout<R>
}

/**
 * squeeze: fixed density, atomic groups; make room by folding rows instead.
 * Stage 1 folds already-drawn cards (count 0) into "n drawn" per group; stage
 * 2 folds the Other group (statuses/curses) entirely. Only then the chip.
 */
export function layoutSqueeze<R>(
  groups: LayoutGroup<R>[],
  availW: number,
  availH: number,
  isDrawn: (row: R) => boolean
): TrackerLayout<R> {
  const { cols, colW } = colsForWidth(availW)
  const d = DENSITIES[0]

  const stages: Array<LayoutGroup<R>[]> = [groups]
  const drawnFolded = groups.map((g) => {
    const kept = g.rows.filter((row) => !isDrawn(row))
    const folded = g.rows.length - kept.length
    return folded > 0
      ? { ...g, rows: kept, collapsed: g.collapsed + folded, collapsedLabel: 'drawn' }
      : g
  })
  stages.push(drawnFolded)
  stages.push(
    drawnFolded.map((g) =>
      g.type === 'other' && g.rows.length > 0
        ? { ...g, rows: [], collapsed: g.collapsed + g.rows.length, collapsedLabel: 'cards' }
        : g
    )
  )

  let last: TrackerLayout<R> | null = null
  for (const stage of stages) {
    const r = pack(stage, d, availH, cols, false)
    last = done(r, d, 0, colW)
    if (r.hiddenRows === 0) return last
  }
  return last as TrackerLayout<R>
}
