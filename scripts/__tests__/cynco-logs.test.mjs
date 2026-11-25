// scripts/cynco-logs.mjs (F242, slice S8): the mission-log prune a dispatch runs after its refusal
// gates. Every case works in its own temporary folder with an injected clock and injected home
// folders; nothing here names C:/tmp for real except the refusal cases, which delete nothing, and the
// parse of the default, which runs nothing.
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { citedKeep, citedWords, DEFAULT_MISSION_LOG_DIR, FAILURE_LOG, folderRefusal, main, parseArgs, pruneMissionLogs } from '../cynco-logs.mjs'

const roots = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 }) })
const root = () => { const r = mkdtempSync(join(tmpdir(), 'cynco-logs-')); roots.push(r); return r }

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 23, 12)
const OLD = 91
const YOUNG = 89

function file(dir, name, ageDays) {
  const p = join(dir, name)
  writeFileSync(p, name)
  const t = new Date(NOW - ageDays * DAY)
  utimesSync(p, t, t)
  return p
}

/** A home folder that is not the folder pruned, so the real home is never in play. */
const farHome = () => [join(root(), 'home', 'someone')]

describe('pruneMissionLogs', () => {
  it('old engine_*.log, driver_*.log and *.pid go; young ones, kept names, other names and a subfolder stay', () => {
    const d = root()
    const gone = ['engine_20260801.log', 'driver_20260801.log', 'driver_20260801.pid', 'engine_x.pid', 'engine_idle_after_20260801.log']
    for (const n of gone) file(d, n, OLD)
    const stay = [
      file(d, 'engine_young.log', YOUNG),
      file(d, 'driver_young.pid', YOUNG),
      file(d, 'engine_mine.log', OLD),
      file(d, 'driver_mine.log', OLD),
      file(d, 'engine.log', OLD),
      file(d, 'driver_a.txt', OLD),
      file(d, 'xdriver_a.log', OLD),
      file(d, 'notes.md', OLD),
    ]
    const sub = join(d, 'engine_x.log')
    mkdirSync(sub)
    const inner = file(sub, 'engine_inner.log', OLD)
    const t = new Date(NOW - OLD * DAY)
    utimesSync(sub, t, t)

    const r = pruneMissionLogs({
      dir: d, now: NOW, homes: farHome(),
      keep: [join(d, 'engine_mine.log'), `${d.replace(/\\/g, '/')}/driver_mine.log`],
    })
    expect(r.refused).toBe(false)
    expect(r.failed).toEqual([])
    expect([...r.deleted].sort()).toEqual([...gone].sort())
    for (const n of gone) expect(existsSync(join(d, n)), n).toBe(false)
    for (const p of stay) expect(existsSync(p), p).toBe(true)
    expect(existsSync(sub)).toBe(true)
    expect(existsSync(inner)).toBe(true)
  })

  it('a junction with a mission-log name is left, and so is what it points at', () => {
    const d = root()
    const elsewhere = root()
    const target = file(elsewhere, 'engine_target.log', OLD)
    symlinkSync(elsewhere, join(d, 'engine_link.log'), 'junction')
    const r = pruneMissionLogs({ dir: d, now: NOW, homes: farHome() })
    expect(r.deleted).toEqual([])
    expect(existsSync(join(d, 'engine_link.log'))).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('a folder that does not exist deletes nothing and is one failure, not a refusal', () => {
    const d = join(root(), 'absent')
    const r = pruneMissionLogs({ dir: d, now: NOW, homes: farHome() })
    expect(r.refused).toBe(false)
    expect(r.deleted).toEqual([])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error).toMatch(/could not be listed/)
  })

  describe('refusals: each deletes nothing', () => {
    function oldLogs() {
      const d = root()
      const p = file(d, 'engine_old.log', OLD)
      return { d, p }
    }
    const refused = (r, why) => {
      expect(r.refused).toBe(true)
      expect(r.deleted).toEqual([])
      expect(r.failed).toHaveLength(1)
      expect(r.failed[0].error).toBe(`${why}; nothing was deleted`)
    }

    it('an empty folder argument', () => {
      refused(pruneMissionLogs({ dir: '', now: NOW, homes: farHome() }), 'no folder was named')
      refused(pruneMissionLogs({ dir: '   ', now: NOW, homes: farHome() }), 'no folder was named')
    })
    it('a relative folder', () => {
      const { d, p } = oldLogs()
      const cwd = process.cwd()
      process.chdir(d)
      try {
        for (const rel of ['.', 'sub', '..\\x', './']) {
          refused(pruneMissionLogs({ dir: rel, now: NOW, homes: farHome() }), 'the folder is not an absolute path below a drive letter')
        }
      } finally {
        process.chdir(cwd)
      }
      expect(existsSync(p)).toBe(true)
    })
    it.skipIf(process.platform !== 'win32')('a folder without a drive letter: rooted on the current drive, drive-relative, or a share', () => {
      const { d, p } = oldLogs()
      for (const dir of [d.slice(2), `${d.slice(0, 2)}${d.slice(3)}`, '\\\\localhost\\c$\\tmp']) {
        refused(pruneMissionLogs({ dir, now: NOW, homes: farHome() }), 'the folder is not an absolute path below a drive letter')
      }
      expect(existsSync(p)).toBe(true)
    })
    it('a volume root', () => {
      const rootDir = process.platform === 'win32' ? 'C:\\' : '/'
      refused(pruneMissionLogs({ dir: rootDir, now: NOW, homes: farHome() }), 'the folder is a volume root')
      if (process.platform === 'win32') refused(pruneMissionLogs({ dir: 'C:/', now: NOW, homes: farHome() }), 'the folder is a volume root')
    })
    it('the home folder, and a folder that contains it, in any spelling', () => {
      const { d, p } = oldLogs()
      const home = join(d, 'users', 'someone')
      mkdirSync(home, { recursive: true })
      const inHome = file(home, 'engine_old.log', OLD)
      const why = 'the folder is the home folder or contains it'
      refused(pruneMissionLogs({ dir: home, now: NOW, homes: [home] }), why)
      refused(pruneMissionLogs({ dir: join(d, 'users'), now: NOW, homes: [home] }), why)
      refused(pruneMissionLogs({ dir: d, now: NOW, homes: [home] }), why)
      // Through `..` and with a trailing separator, each this platform's own (on Windows `\`): on Linux a
      // backslash is a character of a name, so `<home>\..\someone\` is one folder that is not the home.
      refused(pruneMissionLogs({ dir: `${home}${sep}..${sep}someone${sep}`, now: NOW, homes: [home] }), why)
      if (process.platform === 'win32') refused(pruneMissionLogs({ dir: home.toUpperCase(), now: NOW, homes: [home] }), why)
      expect(existsSync(p)).toBe(true)
      expect(existsSync(inHome)).toBe(true)
      // A folder below the home is not the home.
      const below = join(home, 'logs')
      mkdirSync(below)
      file(below, 'engine_old.log', OLD)
      file(below, 'written-today.txt', 0)
      expect(pruneMissionLogs({ dir: below, now: NOW, homes: [home] }).deleted).toEqual(['engine_old.log'])
    })
    it('the real home folder is refused with no injection at all', () => {
      const why = 'the folder is the home folder or contains it'
      // Read-only: the check only examines the folder.
      expect(folderRefusal(homedir())).toBe(why)
      expect(folderRefusal(dirname(homedir()))).toBe(why)
    })
    it('a folder reached through a junction', () => {
      const { d, p } = oldLogs()
      const jn = join(root(), 'jn')
      symlinkSync(d, jn, 'junction')
      refused(pruneMissionLogs({ dir: jn, now: NOW, homes: farHome() }), 'the folder is a link or a junction')
      expect(existsSync(p)).toBe(true)
    })
    it('a path that is a file, not a folder', () => {
      const { p } = oldLogs()
      refused(pruneMissionLogs({ dir: p, now: NOW, homes: farHome() }), 'the path is not a folder')
      expect(existsSync(p)).toBe(true)
    })
  })
})

describe('the command line', () => {
  it('parses the verb, --dir and repeated --keep; the folder defaults to C:/tmp', () => {
    expect(parseArgs(['prune-mission-logs'])).toEqual({ dir: 'C:/tmp', keep: [], dryRun: false })
    expect(DEFAULT_MISSION_LOG_DIR).toBe('C:/tmp')
    expect(parseArgs(['prune-mission-logs', '--dir', 'D:\\x', '--keep', 'a', '--keep', 'b', '--dry-run']))
      .toEqual({ dir: 'D:\\x', keep: ['a', 'b'], dryRun: true })
  })
  it('there is no --days: one retention, in one constant', () => {
    expect(parseArgs(['prune-mission-logs', '--days', '1'])).toEqual({ error: 'unknown argument "--days"' })
  })
  it('exit 2 for an unknown verb, --keep or --dir without a value, and a relative --dir', () => {
    const io = { out: () => undefined, err: () => undefined, homes: farHome() }
    expect(main([], io)).toBe(2)
    expect(main(['prune'], io)).toBe(2)
    expect(main(['prune-mission-logs', '--keep'], io)).toBe(2)
    expect(main(['prune-mission-logs', '--keep', '--dir', 'x'], io)).toBe(2)
    expect(main(['prune-mission-logs', '--dir'], io)).toBe(2)
    expect(main(['prune-mission-logs', '--dir', 'relative'], io)).toBe(2)
  })
  it('prints the pruned line and one line per failure, and exits 0', () => {
    const d = root()
    file(d, 'engine_a.log', OLD)
    file(d, 'driver_a.log', OLD)
    file(d, 'driver_b.log', YOUNG)
    const out = []
    const err = []
    const code = main(['prune-mission-logs', '--dir', d, '--keep', join(d, 'driver_a.log')], {
      out: (l) => out.push(l), err: (l) => err.push(l), now: NOW, homes: farHome(), cited: '',
    })
    expect(code).toBe(0)
    // R4-2 checker (wave 12): a real prune names each log it deleted, as the dry run names each it would.
    expect(out).toEqual([`[logs] pruned 1 mission log(s) older than 90 days from ${d}`, '[logs] deleted: engine_a.log'])
    expect(err).toEqual([])
    expect(existsSync(join(d, 'engine_a.log'))).toBe(false)
    expect(existsSync(join(d, 'driver_a.log'))).toBe(true)

    const absent = join(d, 'absent')
    const err2 = []
    expect(main(['prune-mission-logs', '--dir', absent], { out: () => undefined, err: (l) => err2.push(l), now: NOW, homes: farHome(), cited: '' })).toBe(0)
    expect(err2).toHaveLength(1)
    expect(err2[0].startsWith(`[logs] not pruned: ${absent}: the folder could not be listed`)).toBe(true)
  })
  // Review of wave 5: the first dispatch would have deleted 145 logs, among them the evidence behind
  // failure-log entries, with no dry run and nothing kept for the log that cites them.
  it('--dry-run names each log it would delete and deletes nothing; a log the failure log cites is kept', () => {
    const d = root()
    file(d, 'engine_mission_11O.log', OLD)
    file(d, 'driver_ui7h.log', OLD)
    file(d, 'engine_plain.log', OLD)
    file(d, 'driver_plain.pid', OLD)
    file(d, 'driver_today.log', 0)
    const cited = 'F12: the engine log of mission_11O showed it; see also driver_ui7h for the stall.'
    const out = []
    expect(main(['prune-mission-logs', '--dir', d, '--dry-run'], { out: (l) => out.push(l), err: () => undefined, now: NOW, homes: farHome(), cited })).toBe(0)
    expect(out[0]).toBe(`[logs] would prune 2 mission log(s) older than 90 days from ${d}; nothing was deleted`)
    expect(out.slice(1).sort()).toEqual(['[logs] would delete: driver_plain.pid', '[logs] would delete: engine_plain.log'])
    for (const n of ['engine_mission_11O.log', 'driver_ui7h.log', 'engine_plain.log', 'driver_plain.pid']) expect(existsSync(join(d, n))).toBe(true)
    const out2 = []
    expect(main(['prune-mission-logs', '--dir', d], { out: (l) => out2.push(l), err: () => undefined, now: NOW, homes: farHome(), cited })).toBe(0)
    // Each deleted name on a line of its own (R4-2 checker, wave 12).
    expect(out2[0]).toBe(`[logs] pruned 2 mission log(s) older than 90 days from ${d}`)
    expect(out2.slice(1).sort()).toEqual(['[logs] deleted: driver_plain.pid', '[logs] deleted: engine_plain.log'])
    expect(existsSync(join(d, 'engine_mission_11O.log'))).toBe(true)
    expect(existsSync(join(d, 'driver_ui7h.log'))).toBe(true)
    expect(existsSync(join(d, 'engine_plain.log'))).toBe(false)
  })
  it('a clock far ahead (every file in the folder older than 90 days) deletes nothing', () => {
    const d = root()
    file(d, 'engine_young.log', 1)
    file(d, 'driver_young.pid', 0)
    const err = []
    expect(main(['prune-mission-logs', '--dir', d], { out: () => undefined, err: (l) => err.push(l), now: NOW + 400 * DAY, homes: farHome(), cited: '' })).toBe(0)
    expect(existsSync(join(d, 'engine_young.log'))).toBe(true)
    expect(existsSync(join(d, 'driver_young.pid'))).toBe(true)
    expect(err).toHaveLength(1)
    expect(err[0]).toMatch(/the newest file in it is more than 90 days older than now .*nothing was deleted$/)
  })
  it('a log is cited by its name or by its stamp, each as a whole word', () => {
    const d = root()
    file(d, 'engine_plain.log', OLD)
    file(d, 'driver_today.log', 0)
    expect(citedKeep(citedWords('see engine_plain'))('engine_plain.log')).toBe(true)
    expect(citedKeep(citedWords('see plain'))('engine_plain.log')).toBe(true)
    expect(citedKeep(citedWords('see plainer'))('engine_plain.log')).toBe(false)
    expect(FAILURE_LOG.replace(/\\/g, '/')).toMatch(/\/docs\/cynco-failure-log\.md$/)
  })
  // R4-2 (wave 12, measured by the dry run of 2026-11-24): a run is cited by its mission id, the stamp of its
  // logs with a time after it, so the logs' own stamp was never a whole word and the prune would delete them:
  // `c4-wave3-1787791284792` did not keep engine_c4-wave3.log, `mission_ui7h-<n>` did not keep engine_ui7h.log.
  // Every run of a token's -/_ segments is a word as well. This errs toward keeping.
  it('a log is kept when its stamp is a run of the -/_ segments of a word of the failure log', () => {
    const words = citedWords('F201: see c4-wave3-1787791284792 and mission_ui7h-1787000000000 for the stall.')
    const keep = citedKeep(words)
    expect(keep('engine_c4-wave3.log')).toBe(true)
    expect(keep('driver_c4-wave3.log')).toBe(true)
    expect(keep('engine_ui7h.log')).toBe(true)
    expect(keep('engine_wave3.log')).toBe(true)
    expect(keep('engine_c4-wave4.log')).toBe(false)
    expect(keep('engine_wave.log')).toBe(false)
    for (const w of ['c4-wave3', 'wave3-1787791284792', 'mission_ui7h', 'ui7h-1787000000000', 'ui7h']) expect(words.has(w), w).toBe(true)
    // Shorter than three characters is still no word, alone or as a segment.
    expect(words.has('c4')).toBe(false)
  })
  it('the real failure log keeps engine_c4-wave3.log, which its mission id cites', () => {
    const text = readFileSync(FAILURE_LOG, 'utf8')
    expect(text).toMatch(/c4-wave3-\d+/)
    expect(citedKeep(citedWords(text))('engine_c4-wave3.log')).toBe(true)
  })
  it('a refused folder says so on one line and exits 2', () => {
    const d = root()
    const err = []
    expect(main(['prune-mission-logs', '--dir', d], { out: () => undefined, err: (l) => err.push(l), homes: [join(d, 'home')] })).toBe(2)
    expect(err).toEqual([`[logs] not pruned: ${d}: the folder is the home folder or contains it; nothing was deleted`])
  })
})
