import { useSyncExternalStore } from 'react'
import { DEFAULT_BRACKET, isCodexBracket, type CodexBracket, type CodexKind } from '@shared/codex'

/**
 * The Codex's own small memory: the things that describe *how you like to
 * browse* rather than *what you are looking at*.
 *
 * The split matters. What you are looking at lives in the URL — kind, query,
 * filters, sort, the open entity — so a view is linkable and the back button
 * means something. What you prefer lives here, in localStorage under
 * `reliquary.codex.*`, so the app opens the way you left it without dragging a
 * paragraph of state through every link.
 *
 * Everything reads through a try/catch. localStorage throws in enough real
 * situations (quota, a disabled storage partition) that a preference read is
 * not worth a white screen over.
 */

const NS = 'reliquary.codex.'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(NS + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(NS + key, JSON.stringify(value))
  } catch {
    // A preference that cannot be saved is a preference that resets next
    // launch. That is a fine outcome; a thrown exception is not.
  }
}

// ── how you browse ──────────────────────────────────────────────────────────

export type CodexView = 'grid' | 'list'

export function isCodexView(v: unknown): v is CodexView {
  return v === 'grid' || v === 'list'
}

export function getViewPref(): CodexView {
  const v = read<unknown>('view', 'grid')
  return isCodexView(v) ? v : 'grid'
}

export function setViewPref(view: CodexView): void {
  write('view', view)
}

export function getBracketPref(): CodexBracket {
  const v = read<unknown>('bracket', DEFAULT_BRACKET)
  return isCodexBracket(v) ? v : DEFAULT_BRACKET
}

export function setBracketPref(bracket: CodexBracket): void {
  write('bracket', bracket)
}

/** Character id, or null for "every character". */
export function getCharacterPref(): string | null {
  const v = read<unknown>('character', null)
  return typeof v === 'string' && v && v !== 'all' ? v : null
}

export function setCharacterPref(character: string | null): void {
  write('character', character ?? null)
}

// ── pins and recents ────────────────────────────────────────────────────────

/**
 * A pinned or recently-viewed entity, denormalised on purpose.
 *
 * The rail has to paint before any catalog has loaded — it is the first thing
 * on screen on a cold, offline launch — so it stores the name and art it needs
 * rather than an id to look up in a table that may never arrive.
 */
export interface CodexRef {
  kind: CodexKind
  id: string
  name: string
  /** Already resolved through `codexImageUrl`; null when the entity had none. */
  art: string | null
}

export const PIN_MAX = 24
export const RECENT_MAX = 10

type Listener = () => void

function isRef(v: unknown): v is CodexRef {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<CodexRef>
  return (
    (r.kind === 'cards' || r.kind === 'relics' || r.kind === 'potions') &&
    typeof r.id === 'string' &&
    typeof r.name === 'string'
  )
}

function readRefs(key: string, cap: number): CodexRef[] {
  const raw = read<unknown>(key, [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isRef)
    .map((r) => ({ kind: r.kind, id: r.id, name: r.name, art: r.art ?? null }))
    .slice(0, cap)
}

/**
 * Both lists are held in module state and only written through, so every
 * component reading them shares one array identity — `useSyncExternalStore`
 * needs a snapshot that is stable between changes, and re-parsing JSON on each
 * render would hand it a new array every time and never stop rendering.
 */
let pins: CodexRef[] = readRefs('pins', PIN_MAX)
let recents: CodexRef[] = readRefs('recents', RECENT_MAX)

const pinListeners = new Set<Listener>()
const recentListeners = new Set<Listener>()

function notify(set: Set<Listener>): void {
  for (const l of set) l()
}

export function usePins(): CodexRef[] {
  return useSyncExternalStore(
    (l) => {
      pinListeners.add(l)
      return () => pinListeners.delete(l)
    },
    () => pins
  )
}

export function useRecents(): CodexRef[] {
  return useSyncExternalStore(
    (l) => {
      recentListeners.add(l)
      return () => recentListeners.delete(l)
    },
    () => recents
  )
}

export function isPinned(list: readonly CodexRef[], kind: CodexKind, id: string): boolean {
  return list.some((p) => p.kind === kind && p.id === id)
}

function setPins(next: CodexRef[]): void {
  pins = next
  write('pins', pins)
  notify(pinListeners)
}

/**
 * Pin or unpin. New pins go on the front: the thing you just pinned is the
 * thing you are about to click, and appending it to a rail of 23 others would
 * hide it behind a scroll.
 */
export function togglePin(ref: CodexRef): void {
  if (isPinned(pins, ref.kind, ref.id)) {
    setPins(pins.filter((p) => !(p.kind === ref.kind && p.id === ref.id)))
    return
  }
  setPins([ref, ...pins].slice(0, PIN_MAX))
}

export function unpin(kind: CodexKind, id: string): void {
  if (!isPinned(pins, kind, id)) return
  setPins(pins.filter((p) => !(p.kind === kind && p.id === id)))
}

/** Record a visit. Idempotent per entity: revisiting moves it to the front. */
export function pushRecent(ref: CodexRef): void {
  const rest = recents.filter((r) => !(r.kind === ref.kind && r.id === ref.id))
  if (recents.length === rest.length + 1 && recents[0]?.id === ref.id && recents[0]?.kind === ref.kind) {
    // Already at the front — re-writing would notify every listener for nothing.
    return
  }
  recents = [ref, ...rest].slice(0, RECENT_MAX)
  write('recents', recents)
  notify(recentListeners)
}
