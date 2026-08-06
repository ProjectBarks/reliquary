import type { WindowBounds } from '@shared/types'
import type {
  RawEnemiesState,
  RawNGameState,
  RawPileState,
  RawVisibleItems
} from './readers'

/**
 * The wire between the main process and the forked memory reader.
 *
 * Deliberately raw: the child sends what it read, the parent decides what it
 * means. Keeping Codex enrichment, settings and IPC on the parent side means a
 * reader restart loses at most one snapshot, never any app state — and the
 * types here are the whole contract, so a crash cannot leave the two halves
 * disagreeing about shape.
 */

export type HostToReader = { type: 'start' } | { type: 'stop' }

/** The four raw reads that make up one poll, as a unit the cache can hold. */
export interface RawSnapshot {
  nGame: RawNGameState | null
  pile: RawPileState | null
  enemies: RawEnemiesState | null
  items: RawVisibleItems | null
}

export type ReaderToHost =
  /** Sent immediately on spawn, before any command. */
  | { type: 'spawned'; pid: number; lastPid: number | null }
  | { type: 'ready'; pid: number }
  /** Whether the native reader loaded, reported once per child start. */
  | { type: 'moduleStatus'; loaded: boolean; error: string | null }
  | {
      type: 'process'
      detected: boolean
      pid: number | null
      bounds: WindowBounds | null
      active: boolean
    }
  | { type: 'connect'; ok: boolean; pid: number; error: string | null }
  | { type: 'processGone' }
  | { type: 'gameVersion'; version: string | null }
  | ({ type: 'snapshot' } & RawSnapshot)
  | {
      type: 'readFailed'
      message: string
      stack: string | null
      transient: boolean
      errorStreak: number
      transientTotal: number
    }
  | { type: 'error'; scope: string; message: string; stack: string | null; transient: boolean }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; text: string }
