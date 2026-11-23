import { open, type FileHandle } from 'fs/promises'
import { dirname, join, basename, extname } from 'path'

/**
 * Read-only access to the game's own Godot resource pack (SlayTheSpire2.pck)
 * on the player's machine.
 *
 * Exists for content no third-party catalog has yet: a character shipped
 * after the last Untapped/Codex update still has its real card names and its
 * energy icon sitting in the pack the player already has installed. Reading
 * them here means nothing is redistributed and a future character works the
 * day it ships, with no Reliquary release in between.
 *
 * Main-process only. The forked reader must not import this (see the
 * `reader-self-contained` build check); the reader only reports the game's
 * executable path, and the pack sits beside it.
 *
 * Format (Godot 4.4+, pack format 3, verified on 4.5.1 / v0.113.1):
 *   header: "GDPC", u32 pack version, u32×3 engine version, u32 flags,
 *           u64 file base, u64 directory offset
 *   directory: u32 count, then per file: u32 path length, path (NUL padded),
 *              u64 offset (relative to file base when flag 2 is set), u64
 *              size, 16-byte md5, u32 flags (1 = encrypted)
 * An encrypted directory (flag 1) is refused outright.
 */

interface PackEntry {
  offset: number
  size: number
  encrypted: boolean
}

const MAGIC = 'GDPC'
const FLAG_DIR_ENCRYPTED = 1
const FLAG_REL_FILEBASE = 2
const FILE_ENCRYPTED = 1
/** The directory of a 17k-file pack is ~2.3 MB; anything far past that is not one. */
const MAX_DIR_BYTES = 64 * 1024 * 1024
/** Nothing we read is large; a localization table is ~120 KB, an icon ~1 KB. */
const MAX_FILE_BYTES = 8 * 1024 * 1024

export class GamePack {
  private constructor(
    private readonly fh: FileHandle,
    private readonly entries: Map<string, PackEntry>
  ) {}

  /** The pack beside a game executable (`SlayTheSpire2.exe` -> `SlayTheSpire2.pck`). */
  static pathFor(exePath: string): string {
    return join(dirname(exePath), basename(exePath, extname(exePath)) + '.pck')
  }

  static async open(pckPath: string): Promise<GamePack> {
    const fh = await open(pckPath, 'r')
    try {
      const header = Buffer.alloc(40)
      await fh.read(header, 0, 40, 0)
      if (header.toString('latin1', 0, 4) !== MAGIC) throw new Error('not a Godot pack')
      const packVersion = header.readUInt32LE(4)
      if (packVersion < 3) throw new Error(`pack format ${packVersion} is not supported`)
      const flags = header.readUInt32LE(20)
      if (flags & FLAG_DIR_ENCRYPTED) throw new Error('pack directory is encrypted')
      const fileBase = flags & FLAG_REL_FILEBASE ? Number(header.readBigUInt64LE(24)) : 0
      const dirOffset = Number(header.readBigUInt64LE(32))
      const { size } = await fh.stat()
      const dirBytes = size - dirOffset
      if (dirOffset <= 0 || dirBytes <= 4 || dirBytes > MAX_DIR_BYTES) {
        throw new Error(`implausible directory (${dirBytes} bytes at ${dirOffset})`)
      }
      const dir = Buffer.alloc(dirBytes)
      await fh.read(dir, 0, dirBytes, dirOffset)

      const entries = new Map<string, PackEntry>()
      let o = 0
      const count = dir.readUInt32LE(o)
      o += 4
      for (let i = 0; i < count && o < dir.length; i++) {
        const len = dir.readUInt32LE(o)
        o += 4
        const path = dir.toString('utf8', o, o + len).replace(/\0+$/, '')
        o += len
        const offset = Number(dir.readBigUInt64LE(o)) + fileBase
        const fileSize = Number(dir.readBigUInt64LE(o + 8))
        const fileFlags = dir.readUInt32LE(o + 32)
        o += 36
        entries.set(path, { offset, size: fileSize, encrypted: !!(fileFlags & FILE_ENCRYPTED) })
      }
      return new GamePack(fh, entries)
    } catch (err) {
      await fh.close().catch(() => {})
      throw err
    }
  }

  get fileCount(): number {
    return this.entries.size
  }

  async close(): Promise<void> {
    await this.fh.close().catch(() => {})
  }

  private async read(path: string): Promise<Buffer | null> {
    const e = this.entries.get(path)
    if (!e || e.encrypted || e.size <= 0 || e.size > MAX_FILE_BYTES) return null
    const buf = Buffer.alloc(e.size)
    await this.fh.read(buf, 0, e.size, e.offset)
    return buf
  }

  /**
   * Card id -> display title, from the game's own localization table
   * (`localization/<lang>/cards.json`, keys like `STRIKE_FOOL.title`).
   */
  async cardTitles(lang = 'eng'): Promise<Record<string, string>> {
    const buf = await this.read(`localization/${lang}/cards.json`)
    if (!buf) return {}
    const table = JSON.parse(buf.toString('utf8')) as Record<string, unknown>
    const titles: Record<string, string> = {}
    for (const [key, value] of Object.entries(table)) {
      if (key.endsWith('.title') && typeof value === 'string' && value) {
        titles[key.slice(0, -'.title'.length)] = value
      }
    }
    return titles
  }

  /**
   * Every small energy icon a card's cost sits on (`<colour>_energy_icon.png`),
   * keyed by colour, as data URLs. Colours whose icon the pack holds
   * GPU-compressed (BPTC/S3TC) are absent: that is how the five original
   * characters ship theirs, and those are on the CDN anyway. Newer ones ship
   * as a plain WebP/PNG payload we can lift.
   */
  async energyIcons(): Promise<Record<string, string>> {
    const icons: Record<string, string> = {}
    const re = /^\.godot\/imported\/([a-z0-9_]+)_energy_icon\.png-[0-9a-f]+\.ctex$/
    for (const path of this.entries.keys()) {
      const m = re.exec(path)
      if (!m || icons[m[1]]) continue
      const buf = await this.read(path)
      const image = buf ? embeddedImage(buf) : null
      if (image) icons[m[1]] = `data:${image.mime};base64,${image.bytes.toString('base64')}`
    }
    return icons
  }
}

/**
 * The lossless payload inside a Godot `.ctex` (CompressedTexture2D): a WebP or
 * PNG stream after the GST2 header. Absent for VRAM-compressed textures.
 */
function embeddedImage(ctex: Buffer): { mime: string; bytes: Buffer } | null {
  const webp = ctex.indexOf('RIFF', 0, 'latin1')
  if (webp >= 0 && ctex.toString('latin1', webp + 8, webp + 12) === 'WEBP') {
    const len = ctex.readUInt32LE(webp + 4) + 8
    return { mime: 'image/webp', bytes: ctex.subarray(webp, Math.min(ctex.length, webp + len)) }
  }
  const png = ctex.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (png >= 0) return { mime: 'image/png', bytes: ctex.subarray(png) }
  return null
}
