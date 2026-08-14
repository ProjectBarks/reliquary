/**
 * Self-check for the run journal's persistence layer (`src/main/journal/RunStore.ts`).
 *
 * The repo has no test runner and this work package must not add one, so this
 * script is the acceptance harness: it bundles `RunStore.ts` with the esbuild
 * that already ships inside vite, runs it against throwaway directories under
 * the OS temp dir, and asserts the round-trips the plan's WP2 acceptance names —
 * write/load, torn-target recovery from a surviving temp, `.corrupt`
 * quarantine, rebuild-by-scan equivalence, the stat cache, a newer schema being
 * listed rather than crashed on, the read-only capture-run guard, per-run
 * delete, and the synchronous quit flush.
 *
 *   node scripts/journal-selfcheck.mjs [--keep]
 *
 * `--keep` leaves the temp directories behind for inspection.
 */

import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, utimes } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const keep = process.argv.includes('--keep')

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0
const failures = []
const tempDirs = []

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, `expected ${e}, got ${a}`)
}

async function section(name, fn) {
  console.log(`\n${name}`)
  try {
    await fn()
  } catch (err) {
    failures.push(`${name} (threw)`)
    console.log(`  FAIL ${name} threw: ${err && err.stack ? err.stack : err}`)
  }
}

async function freshDir(tag) {
  const dir = await mkdtemp(join(tmpdir(), `journal-selfcheck-${tag}-`))
  tempDirs.push(dir)
  return join(dir, 'runs')
}

// ── bundle the TypeScript under test ─────────────────────────────────────────

const outFile = join(tmpdir(), 'journal-selfcheck-bundle', 'RunStore.mjs')
await mkdir(dirname(outFile), { recursive: true })

// esbuild comes along with vite; nothing is added to package.json for this.
let build
try {
  ;({ build } = await import('esbuild'))
} catch {
  console.error('esbuild not found — run `npm install` first (it ships inside vite).')
  process.exit(2)
}

await build({
  entryPoints: [join(repo, 'src/main/journal/RunStore.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // The shared journal model is types-only plus two tiny helpers; the alias
  // mirrors tsconfig's `@shared/*` so the source needs no test-only import path.
  alias: { '@shared/journal': join(repo, 'src/shared/journal.ts') },
  external: ['electron'],
  logLevel: 'warning'
})

const store = await import(pathToFileURL(outFile).href)
const {
  RunStore,
  CATALOG_FILE,
  catalogEntryFromRun,
  newRunFile,
  newRunId,
  normalizeRunCharacter,
  resolveRunsDir,
  parseRunFile,
  runFileName,
  serializeRun,
  withRetries,
  writeAtomic,
  writeAtomicSync
} = store

// A run the recorder would plausibly have produced: mid-flight, one session,
// a deck that has already diverged from the starter.
function sampleRun(overrides = {}) {
  const at = 1786662011000
  const run = newRunFile(newRunId('ironclad', at, 'a41f3c'), {
    character: 'ironclad',
    observedFrom: 'start',
    startedAt: at,
    firstSeenAt: at,
    gameVersion: '1.3.0.123',
    playerCount: 1
  })
  run.lastSeenAt = at + 3093000
  run.actReached = 2
  run.roomsEntered = 23
  run.sessions = [
    {
      sid: 1,
      attachedAt: at,
      detachedAt: at + 1712000,
      reason: 'menu',
      activeMs: 1712000,
      playerCount: 1,
      gameVersion: '1.3.0.123'
    }
  ]
  run.snapshot = {
    ...run.snapshot,
    at: at + 3093000,
    act: 2,
    roomIndex: 23,
    roomType: 'combat',
    deck: ['BASH#1', 'CARNAGE#0', 'STRIKE#0', 'STRIKE#0'],
    deckHash: 'c1f4deadbeef',
    deckSize: 4,
    eventCount: 3
  }
  run.signature = { deckHash: 'c1f4deadbeef', relicHash: null, core: ['CARNAGE'] }
  run.events = [
    { t: at, type: 'session_attach', sid: 1, fresh: true },
    { t: at + 1000, type: 'room_enter', roomType: 'combat', roomIndex: 1, actIndex: 0 },
    { t: at + 1712000, type: 'session_detach', sid: 1, reason: 'menu' }
  ]
  return Object.assign(run, overrides)
}

const silent = () => {}
function recorder() {
  const seen = []
  const sink = (key, severity, props) => seen.push({ key, severity, props })
  sink.seen = seen
  sink.has = (key) => seen.some((i) => i.key === key)
  return sink
}

// ── 1. write / load round-trip ───────────────────────────────────────────────

await section('write + load round-trip', async () => {
  const dir = await freshDir('roundtrip')
  const a = new RunStore({ baseDir: dir, env: {}, onIssue: silent, debounceMs: 10 })
  await a.open()
  const run = sampleRun()
  a.save(run, { immediate: true })
  await a.flush()

  const files = await readdir(dir)
  ok('run file and catalog on disk', files.includes(runFileName(run.id)) && files.includes(CATALOG_FILE))
  ok('no temp files left behind', !files.some((f) => f.endsWith('.tmp')), files.join(', '))

  const b = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await b.open()
  eq('catalog survives a reopen', b.list().length, 1)
  const loaded = await b.getRun(run.id)
  eq('run file round-trips byte-for-byte', serializeRun(loaded), serializeRun(run))

  const entry = b.entry(run.id)
  eq('entry state', entry.state, 'recording')
  eq('entry activeMs sums sessions', entry.activeMs, 1712000)
  eq('entry carries the candidate deck (A6)', entry.deck, run.snapshot.deck)
  ok('entry carries stat cache (A10)', entry.fileBytes > 0 && entry.fileMtimeMs > 0)

  // A terminal run is never a matching candidate, so it drops the multiset.
  run.state = 'closed'
  run.outcome = 'ended'
  b.save(run)
  await b.flush()
  eq('closed run drops the deck from its row', b.entry(run.id).deck, null)
  eq('closed run is no longer a candidate', b.candidates('IRONCLAD').length, 0)
})

// ── 2. candidates + provisional/ambiguity ────────────────────────────────────

await section('candidates and the ambiguity banner state', async () => {
  const dir = await freshDir('candidates')
  const s = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s.open()

  const older = sampleRun()
  older.state = 'suspended'
  older.lastSeenAt = 1000
  s.save(older)

  const provisional = s.createRun({
    character: 'ironclad',
    observedFrom: 'start',
    startedAt: 2000,
    firstSeenAt: 2000,
    ambiguity: { candidateId: older.id, raisedAt: 2000, resolution: null, resolvedAt: null }
  })
  provisional.lastSeenAt = 2000
  s.save(provisional)
  await s.flush()

  eq('case-insensitive character match', s.candidates('IrOnClAd').length, 2)
  eq('candidates are newest first', s.candidates('ironclad')[0].id, provisional.id)
  eq('other characters see nothing', s.candidates('silent').length, 0)
  eq('pending resolution is listed', s.pendingResolutions().map((e) => e.id), [provisional.id])

  // Resolving the banner as "fresh" leaves the provisional standing alone.
  provisional.ambiguity = {
    candidateId: older.id,
    raisedAt: 2000,
    resolution: 'fresh',
    resolvedAt: 3000
  }
  s.save(provisional)
  await s.flush()
  eq('resolved runs leave the pending list', s.pendingResolutions().length, 0)

  const reread = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await reread.open()
  eq(
    'ambiguity survives the round trip',
    (await reread.getRun(provisional.id)).ambiguity.resolution,
    'fresh'
  )
})

// ── 3. torn target, surviving temp ───────────────────────────────────────────

await section('crash between write and rename', async () => {
  const dir = await freshDir('torn')
  const s = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s.open()
  const run = sampleRun()
  s.save(run)
  await s.flush()

  // Simulate the crash: the target is half-written, a complete temp survives.
  const path = join(dir, runFileName(run.id))
  const good = await readFile(path, 'utf8')
  await writeFile(`${path}.9999.1.tmp`, good, 'utf8')
  await writeFile(path, good.slice(0, Math.floor(good.length / 2)), 'utf8')

  const issues = recorder()
  const s2 = new RunStore({ baseDir: dir, env: {}, onIssue: issues })
  await s2.open()
  const res = await s2.load(run.id)
  ok('recovered from the surviving temp', res.ok && res.recoveredFromTmp)
  eq('recovered content is the complete run', serializeRun(res.run), good)
  ok('recovery is reported', issues.has('journal_run_recovered_from_tmp'))
  const after = await readFile(path, 'utf8')
  eq('the temp was promoted over the torn target', after, good)
  ok(
    'no temp left after promotion',
    !(await readdir(dir)).some((f) => f.endsWith('.tmp'))
  )
})

// ── 4. quarantine ────────────────────────────────────────────────────────────

await section('unparseable run file is quarantined', async () => {
  const dir = await freshDir('corrupt')
  const s = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s.open()
  const good = sampleRun()
  s.save(good)
  const bad = sampleRun()
  bad.id = newRunId('ironclad', 1786662011000, 'bbbbbb')
  s.save(bad)
  await s.flush()

  await writeFile(join(dir, runFileName(bad.id)), '{"schema":1,"id":"x",', 'utf8')

  const issues = recorder()
  const s2 = new RunStore({ baseDir: dir, env: {}, onIssue: issues })
  await s2.open()
  const scan = await s2.scan()

  eq('corrupt file quarantined', scan.quarantined, 1)
  ok('quarantine keeps the bytes', existsSync(join(dir, `${runFileName(bad.id)}.corrupt`)))
  ok('quarantine is reported', issues.has('journal_run_file_corrupt'))
  eq('the corrupt run left the catalog', s2.entry(bad.id), null)
  eq('every other run is unaffected', s2.entry(good.id).id, good.id)
  eq('load of the quarantined id says missing', (await s2.load(bad.id)).reason, 'missing')
})

// ── 5. rebuild-by-scan + stat cache ──────────────────────────────────────────

await section('rebuild-by-scan and the stat cache', async () => {
  const dir = await freshDir('rebuild')
  const s = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s.open()
  const runs = []
  for (let i = 0; i < 3; i++) {
    const run = sampleRun()
    run.id = newRunId('ironclad', 1786662011000 + i * 1000, `00000${i}`)
    run.lastSeenAt = 1786662011000 + i * 1000
    runs.push(run)
    s.save(run)
  }
  await s.flush()
  const before = JSON.parse(await readFile(join(dir, CATALOG_FILE), 'utf8'))

  // The catalog is a cache: delete it and the archive must come back whole.
  await rm(join(dir, CATALOG_FILE))
  const s2 = new RunStore({ baseDir: dir, env: {}, onIssue: silent, now: () => before.rebuiltAt })
  await s2.open()
  ok('a missing catalog demands a scan', s2.needsScan)
  const scan = await s2.scan()
  eq('every file was parsed on the cold scan', scan.parsed, 3)
  const rebuilt = JSON.parse(await readFile(join(dir, CATALOG_FILE), 'utf8'))
  eq('rebuilt catalog equals the original', rebuilt, before)

  // Second scan: nothing moved, so nothing is re-parsed.
  const again = await s2.scan()
  eq('stat cache means a warm scan parses nothing', again.parsed, 0)
  eq('warm scan still sees every file', again.files, 3)

  // Touch one file's mtime: only that one is re-read.
  const target = join(dir, runFileName(runs[1].id))
  const st = await stat(target)
  await utimes(target, st.atime, new Date(st.mtimeMs + 10000))
  const s3 = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s3.open()
  const third = await s3.scan()
  eq('only the moved file is re-parsed', third.parsed, 1)

  // A file deleted behind our back drops its row.
  await rm(target)
  const s4 = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s4.open()
  const fourth = await s4.scan()
  eq('a vanished file drops its row', fourth.dropped, 1)
  eq('remaining rows intact', s4.list().length, 2)
})

// ── 6. a newer schema is listed, not crashed on ──────────────────────────────

await section('unknown higher schema', async () => {
  const dir = await freshDir('schema')
  const s = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s.open()
  const run = sampleRun()
  s.save(run)
  await s.flush()

  const future = { ...JSON.parse(await readFile(join(dir, runFileName(run.id)), 'utf8')), schema: 99 }
  await writeFile(join(dir, runFileName(run.id)), JSON.stringify(future), 'utf8')

  const s2 = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s2.open()
  const scanned = await s2.scan()
  eq('listed as unreadable', scanned.unreadable, 1)
  eq('not quarantined', scanned.quarantined, 0)
  const entry = s2.entry(run.id)
  eq('row survives for the Archive', entry.unreadable, true)
  eq('row remembers the schema', entry.schema, 99)
  eq('never offered to the matcher', s2.candidates('ironclad').length, 0)
  const res = await s2.load(run.id)
  eq('load refuses it by name', res.reason, 'unsupported-schema')
  ok('the file itself is untouched', existsSync(join(dir, runFileName(run.id))))

  // A newer *catalog* is discardable — a scan rebuilds it exactly.
  await writeFile(join(dir, CATALOG_FILE), JSON.stringify({ schema: 99, entries: [] }), 'utf8')
  const s3 = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await s3.open()
  ok('a newer catalog is quarantined and rebuilt', s3.needsScan)
  ok('the old catalog is kept as evidence', existsSync(join(dir, `${CATALOG_FILE}.corrupt`)))
})

// ── 7. two-instance write guard (audit A8) ───────────────────────────────────

await section('capture runs and lock-less instances never write', async () => {
  const dir = await freshDir('guard')
  const writer = new RunStore({ baseDir: dir, env: {}, onIssue: silent })
  await writer.open()
  const run = sampleRun()
  writer.save(run)
  await writer.flush()
  const beforeBytes = (await readFile(join(dir, runFileName(run.id)), 'utf8')).length

  const issues = recorder()
  const capture = new RunStore({
    baseDir: dir,
    env: { SPECTRA_CAPTURE: 'C:/shots' },
    hasLock: true,
    onIssue: issues
  })
  ok('capture instance is read-only despite hasLock', capture.writable === false)
  await capture.open()
  eq('reads still work', (await capture.getRun(run.id)).id, run.id)

  const mutated = await capture.getRun(run.id)
  mutated.roomsEntered = 999
  capture.save(mutated, { immediate: true })
  await capture.flush()
  capture.flushSync()
  eq(
    'no write reached the disk',
    (await readFile(join(dir, runFileName(run.id)), 'utf8')).length,
    beforeBytes
  )
  ok('refusal is reported once', issues.seen.filter((i) => i.key === 'journal_store_readonly').length === 1)
  eq('delete is refused too', await capture.delete(run.id), false)
  ok('the run file is still there', existsSync(join(dir, runFileName(run.id))))

  const noLock = new RunStore({ baseDir: dir, env: {}, hasLock: false, onIssue: silent })
  ok('an instance without the lock is read-only', noLock.writable === false)

  // Synthetic sessions get their own directory, so a fixture or a screenshot
  // run can never appear in — or clobber — the real archive.
  eq('real play journals into runs/', resolveRunsDir('C:/ud', {}), join('C:/ud', 'runs'))
  eq(
    'a stub session journals into runs-stub/',
    resolveRunsDir('C:/ud', { SPECTRA_JOURNAL_STUB: '1' }),
    join('C:/ud', 'runs-stub')
  )
  eq(
    'a capture run journals into runs-stub/',
    resolveRunsDir('C:/ud', { SPECTRA_CAPTURE: 'C:/shots' }),
    join('C:/ud', 'runs-stub')
  )
})

// ── 8. delete, debounce, synchronous quit flush ──────────────────────────────

await section('delete, debounce and the will-quit flush', async () => {
  const dir = await freshDir('flush')
  const s = new RunStore({ baseDir: dir, env: {}, onIssue: silent, debounceMs: 20 })
  await s.open()
  const run = sampleRun()
  s.save(run)
  ok('debounced: nothing on disk yet', !existsSync(join(dir, runFileName(run.id))))
  await new Promise((r) => setTimeout(r, 60))
  ok('debounce flushed it', existsSync(join(dir, runFileName(run.id))))

  // The quit path: synchronous, and idempotent because will-quit fires twice.
  run.roomsEntered = 44
  s.save(run)
  s.flushSync()
  const onDisk = JSON.parse(await readFile(join(dir, runFileName(run.id)), 'utf8'))
  eq('sync flush wrote the latest state', onDisk.roomsEntered, 44)
  s.flushSync()
  s.flushSync()
  ok('repeat sync flushes are harmless', existsSync(join(dir, CATALOG_FILE)))
  ok(
    'sync flush leaves no temps',
    !(await readdir(dir)).some((f) => f.endsWith('.tmp'))
  )

  // lastSeenAt never rewinds, even when the wall clock does.
  run.lastSeenAt = 1
  s.save(run)
  ok('lastSeenAt is clamped monotonic', s.entry(run.id).lastSeenAt > 1)

  eq('delete removes the run', await s.delete(run.id), true)
  ok('file gone', !existsSync(join(dir, runFileName(run.id))))
  eq('row gone', s.entry(run.id), null)
  const catalog = JSON.parse(await readFile(join(dir, CATALOG_FILE), 'utf8'))
  eq('catalog written on delete', catalog.entries.length, 0)
  s.dispose()
})

// ── 9. atomic write primitives ───────────────────────────────────────────────

await section('atomic write primitives', async () => {
  const dir = await freshDir('atomic')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'thing.json')
  let n = 0
  await writeAtomic(path, '{"v":1}', () => `${path}.${++n}.tmp`)
  eq('async write lands', await readFile(path, 'utf8'), '{"v":1}')
  writeAtomicSync(path, '{"v":2}', () => `${path}.${++n}.tmp`)
  eq('sync write replaces in place', await readFile(path, 'utf8'), '{"v":2}')
  ok('temp names are unique per write', n === 2)
  ok(
    'no temps survive a successful write',
    !(await readdir(dir)).some((f) => f.endsWith('.tmp'))
  )

  // The EPERM ladder cannot be provoked reliably from a test, so the retry
  // helper is exercised directly — the thing that would actually be wrong.
  let attempts = 0
  const value = await withRetries(async () => {
    if (++attempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' })
    return 'wrote'
  }, [1, 1, 1])
  eq('retries a transient EPERM', [attempts, value], [3, 'wrote'])

  let hardAttempts = 0
  let threw = null
  try {
    await withRetries(async () => {
      hardAttempts++
      throw Object.assign(new Error('nope'), { code: 'ENOSPC' })
    }, [1, 1, 1])
  } catch (err) {
    threw = err.code
  }
  eq('a real error is not retried', [hardAttempts, threw], [1, 'ENOSPC'])
})

// ── 10. pure helpers ─────────────────────────────────────────────────────────

await section('pure helpers', async () => {
  // UTC, colons and dots swapped for dashes: sortable, and legal on NTFS.
  eq(
    'ids are filesystem-safe and sortable',
    newRunId('IronClad', Date.parse('2026-08-13T23:00:11.000Z'), 'a41f3c'),
    '2026-08-13T23-00-11Z-ironclad-a41f3c'
  )
  eq('character casing is normalised', normalizeRunCharacter(' ironclad '), 'IRONCLAD')

  const run = sampleRun()
  const entry = catalogEntryFromRun(run, { size: 10, mtimeMs: 20 })
  eq('entry is a pure projection', [entry.id, entry.fileBytes, entry.fileMtimeMs], [run.id, 10, 20])

  // Unknown fields on a same-schema file must survive: a newer minor version
  // may have written them and we rewrite the whole file on every flush.
  const withExtra = { ...JSON.parse(serializeRun(run)), futureField: { keep: 'me' } }
  const parsed = parseRunFile(JSON.stringify(withExtra))
  eq('unknown fields round-trip', parsed.run.futureField, { keep: 'me' })

  eq('garbage is corrupt', parseRunFile('not json').reason, 'corrupt')
  eq('a non-run object is corrupt', parseRunFile('{"schema":1,"id":"x"}').reason, 'corrupt')

  // Honest nullability: act 0 and "unknown act" must never collapse.
  const nulled = parseRunFile(
    JSON.stringify({ ...JSON.parse(serializeRun(run)), snapshot: { ...run.snapshot, act: null } })
  )
  eq('null act survives', nulled.run.snapshot.act, null)
  eq('a fresh mid-run file is partial by construction', newRunFile('x', {
    character: 'silent',
    observedFrom: 'mid-run',
    startedAt: null
  }).countsArePartial, true)
})

// ── report ───────────────────────────────────────────────────────────────────

if (!keep) {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
  await rm(dirname(outFile), { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
