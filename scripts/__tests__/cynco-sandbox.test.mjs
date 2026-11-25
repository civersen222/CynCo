// scripts/cynco-sandbox.mjs: the command line over a run's sandbox (F242, engine/containment.ts).
//
// The verbs are spawned with `bun` (skipped where it is absent), each with LOCALCODE_SANDBOX_ROOT
// naming a root inside this test's own mkdtemp folder. `create` labels folders on Windows, so its
// cases run off Windows only; on Windows the records the other verbs read are written by the test
// with no label (cwdLabel 'none'), so `release` runs no icacls. The pure parts run in process.
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isVolumeRefusal, main, statusLine } from '../cynco-sandbox.mjs'
import { RUN_ID_RE } from '../../engine/missionEnv.js'

const isWin = process.platform === 'win32'
const bunPresent = spawnSync('bun', ['--version'], { encoding: 'utf-8', shell: isWin }).status === 0
const dirs = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'cynco-sandbox-cli-')); dirs.push(d); return d }

const q = (a) => (isWin ? `"${a}"` : a)
function cli(args, root) {
  const env = { ...process.env, LOCALCODE_SANDBOX_ROOT: root }
  delete env.LOCALCODE_CONTAINMENT_OFF
  const r = spawnSync('bun', ['scripts/cynco-sandbox.mjs', ...args].map(q), { encoding: 'utf-8', shell: isWin, env, timeout: 60_000 })
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

/** A record as establishContainment writes it, with no label, so release runs no icacls anywhere. */
function plantRecord(root, runId, over = {}) {
  const runDir = join(root, runId)
  for (const d of ['home', 'tmp', 'scratch']) mkdirSync(join(runDir, d), { recursive: true })
  const rec = {
    schema: 1, runId, kind: 'mission', test: false, missionCwd: join(root, '..', 'mission'), cwdLabel: 'none', cwdGranted: false,
    extraRoots: [], home: join(root, '..', 'home'), folders: { state: 's', models: 'm', guard: 'g', audit: null }, unprotectedVolumes: [],
    createdAt: new Date().toISOString(), createdByPid: process.pid, holder: null, releasedAt: null, ...over,
  }
  writeFileSync(join(runDir, 'containment.json'), JSON.stringify(rec, null, 2) + '\n')
  return runDir
}
const recordOf = (root, id) => JSON.parse(readFileSync(join(root, id, 'containment.json'), 'utf-8'))

describe('cynco-sandbox.mjs in process', () => {
  const capture = () => { const io = { lines: [], errs: [] }; io.out = l => io.lines.push(l); io.err = l => io.errs.push(l); return io }

  it('mint prints one run id and nothing else', () => {
    const io = capture()
    expect(main(['mint', 'a label/with spaces'], io)).toBe(0)
    expect(io.lines).toHaveLength(1)
    expect(io.lines[0]).toMatch(RUN_ID_RE)
    expect(io.errs).toEqual([])
  })

  it('bad usage exits 2 with the usage text, and touches nothing', () => {
    for (const argv of [[], ['nonsense'], ['mint'], ['create', '--cwd', 'x'], ['create', '--run-id', 'x'], ['release'], ['release-dead', '--kind', 'bogus'], ['status', 'x'], ['create', '--run-id', 'x', '--cwd', 'y', '--test', 'true']]) {
      const io = capture()
      expect(main(argv, io), argv.join(' ')).toBe(2)
      expect(io.errs.join('\n')).toContain('usage: bun scripts/cynco-sandbox.mjs')
    }
  })

  it('the status line and the volume refusals', () => {
    const base = { runId: 'r-20261123T010203-abcd', kind: 'mission', missionCwd: 'C:/m', createdAt: 'T' }
    expect(statusLine({ ...base, releasedAt: 'X', releasedBy: 'sweep' })).toBe('[sandbox] r-20261123T010203-abcd  mission  C:/m  created T  released X (sweep)')
    expect(statusLine({ ...base, releasedAt: null, holder: { pid: 7 } })).toMatch(/ACTIVE \(holder pid 7\)$/)
    expect(statusLine({ ...base, releasedAt: null, holder: null })).toMatch(/ACTIVE \(no holder yet\)$/)
    // P2-B4 (wave 15c): a grant a release kept is shown, with the command that puts it back.
    expect(statusLine({ ...base, releasedAt: 'X', releasedBy: 'release', grantsKept: [{ folder: 'C:/m', aclFile: 'a' }] })).toBe('[sandbox] r-20261123T010203-abcd  mission  C:/m  created T  released X (release)  GRANT KEPT on C:/m (restore-acl r-20261123T010203-abcd)')
    // C9 (wave 19): a sandbox its release left low past the set-back budget is shown until the sweep removes it.
    expect(statusLine({ ...base, releasedAt: 'X', releasedBy: 'release', sandboxLeftLow: { folders: 200, at: 'X' } })).toBe('[sandbox] r-20261123T010203-abcd  mission  C:/m  created T  released X (release)  SANDBOX LEFT LOW past 200 folders (the sweep removes it)')
    expect(statusLine({ ...base, releasedAt: 'X', releasedBy: 'release', sandboxLeftLow: { folders: 3, at: 'X' }, grantsKept: [{ folder: 'C:/m', aclFile: 'a' }] })).toBe('[sandbox] r-20261123T010203-abcd  mission  C:/m  created T  released X (release)  GRANT KEPT on C:/m (restore-acl r-20261123T010203-abcd)  SANDBOX LEFT LOW past 3 folders (the sweep removes it)')
    // BB-6 (wave 19c): a sandbox left low for a folder whose name ends in a dot or a space (R2) says that, not a
    // budget stop that did not happen; both are said when both happened.
    expect(statusLine({ ...base, releasedAt: 'X', releasedBy: 'release', sandboxLeftLow: { folders: 12, at: 'X', notEntered: 1, budgetStopped: false } })).toBe('[sandbox] r-20261123T010203-abcd  mission  C:/m  created T  released X (release)  SANDBOX LEFT LOW under 1 folder whose name ends in a dot or a space (the sweep removes it)')
    expect(statusLine({ ...base, releasedAt: 'X', releasedBy: 'release', sandboxLeftLow: { folders: 200, at: 'X', notEntered: 2, budgetStopped: true } })).toBe('[sandbox] r-20261123T010203-abcd  mission  C:/m  created T  released X (release)  SANDBOX LEFT LOW past 200 folders and under 2 folders whose name ends in a dot or a space (the sweep removes it)')
    // R1 (check B, wave 19; wave 19b): a release still running in another live process is not a kept grant
    // yet: the line says so, and names that process; once it is gone, GRANT KEPT as before.
    const unfinished = { ...base, releasedAt: 'X', releasedBy: 'release', grantsKept: [{ folder: 'C:/m', aclFile: 'a', why: 'unfinished' }] }
    expect(statusLine({ ...unfinished, releasing: { pid: process.ppid, startedAt: 'S' } })).toBe(`[sandbox] r-20261123T010203-abcd  mission  C:/m  created T  released X (release)  RELEASE IN PROGRESS (process ${process.ppid}): the access list of C:/m is put back when it ends`)
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    expect(statusLine({ ...unfinished, releasing: { pid: dead, startedAt: 'S' } })).toBe('[sandbox] r-20261123T010203-abcd  mission  C:/m  created T  released X (release)  GRANT KEPT on C:/m (restore-acl r-20261123T010203-abcd)')
    expect(isVolumeRefusal('D:\\ (exFAT) cannot be protected by integrity labels and is not acknowledged')).toBe(true)
    expect(isVolumeRefusal('the attached volumes could not be listed (boom), so it is not known whether one of them is unprotected')).toBe(true)
    expect(isVolumeRefusal('the mission folder C:/x does not exist or is not a folder')).toBe(false)
  })

  // F248 list, w12 checker R1: release-dead released every unreleased record of its kind, a live
  // run's too (that run then lost write access to its mission folder). It now asks what the sweep
  // asks (holderGone): a live holder, or a holderless record younger than 15 minutes, is kept.
  it('release-dead keeps a record whose holder is alive and a fresh holderless one; a dead holder is released', () => {
    const root = join(tempDir(), 'root')
    const live = 'live-20261123T010203-aaaa', dead = 'dead-20261123T010203-bbbb', fresh = 'fresh-20261123T010203-cccc', stale = 'stale-20261123T010203-dddd'
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    plantRecord(root, live, { holder: { pid: process.pid, startedAt: new Date().toISOString() } })
    plantRecord(root, dead, { holder: { pid: deadPid, startedAt: new Date().toISOString() } })
    plantRecord(root, fresh)
    plantRecord(root, stale, { createdAt: new Date(Date.now() - 16 * 60_000).toISOString() })
    const saved = process.env.LOCALCODE_SANDBOX_ROOT
    process.env.LOCALCODE_SANDBOX_ROOT = root
    const io = capture()
    let code
    try {
      code = main(['release-dead', '--kind', 'mission'], io)
    } finally {
      // Wave 15c: assigning undefined set the variable to the text 'undefined' for the rest of the file.
      if (saved === undefined) delete process.env.LOCALCODE_SANDBOX_ROOT
      else process.env.LOCALCODE_SANDBOX_ROOT = saved
    }
    expect(code, [...io.lines, ...io.errs].join('\n')).toBe(0)
    expect(recordOf(root, live).releasedAt).toBeNull()
    expect(recordOf(root, fresh).releasedAt).toBeNull()
    expect(recordOf(root, dead).releasedAt).not.toBeNull()
    expect(recordOf(root, stale).releasedAt).not.toBeNull()
    expect(io.lines).toContain(`[sandbox] kept ${live}: its holder ${process.pid} is alive`)
    expect(io.lines.some(l => l.startsWith(`[sandbox] kept ${fresh}: it has no holder yet and was created `))).toBe(true)
    expect(io.lines.some(l => l.startsWith(`[sandbox] run ${dead} released`))).toBe(true)
    expect(io.lines.some(l => l.startsWith(`[sandbox] run ${stale} released`))).toBe(true)
  })

  // P2-B4 (wave 15c): a grant a release kept is put back by `restore-acl <run id>` (engine:
  // restoreKeptGrants), which asks what the release asked; it exits 3 while one is still kept.
  const inRoot = (root, argv) => {
    const saved = process.env.LOCALCODE_SANDBOX_ROOT
    process.env.LOCALCODE_SANDBOX_ROOT = root
    const io = capture()
    try {
      return { code: main(argv, io), io }
    } finally {
      if (saved === undefined) delete process.env.LOCALCODE_SANDBOX_ROOT
      else process.env.LOCALCODE_SANDBOX_ROOT = saved
    }
  }

  it('restore-acl: usage, a run id with no record, and a record that keeps no grant', () => {
    const root = join(tempDir(), 'root')
    mkdirSync(root)
    const io = capture()
    expect(main(['restore-acl'], io)).toBe(2)
    expect(io.errs.join('\n')).toContain('bun scripts/cynco-sandbox.mjs restore-acl <id>')
    const none = inRoot(root, ['restore-acl', 'none-20261124T010203-abcd'])
    expect(none.code).toBe(0)
    expect(none.io.lines).toEqual(['[sandbox] no containment record for none-20261124T010203-abcd'])
    const id = 'clean-20261124T010203-aaaa'
    plantRecord(root, id, { releasedAt: new Date().toISOString(), releasedBy: 'release' })
    const clean = inRoot(root, ['restore-acl', id])
    expect(clean.code).toBe(0)
    expect(clean.io.lines).toEqual([`[sandbox] run ${id} keeps no grant to put back`])
    // C6 (c), wave 19: a record that is there and cannot be read is not "no record": exit 3, and said.
    const broken = 'broken-20261124T010203-cccc'
    const brokenDir = plantRecord(root, broken, { releasedAt: new Date().toISOString(), releasedBy: 'release' })
    writeFileSync(join(brokenDir, 'containment.json'), '{ not json')
    const b = inRoot(root, ['restore-acl', broken])
    expect(b.code, [...b.io.lines, ...b.io.errs].join('\n')).toBe(3)
    expect(b.io.lines[0]).toMatch(new RegExp(`^\\[sandbox\\] the record of ${broken} could not be read \\(`))
    expect(b.io.errs).toEqual([`[sandbox] NOT PUT BACK: the record of ${broken} could not be read, so whether it keeps a grant is not known`])
  })

  it.skipIf(!isWin)('restore-acl: a grant whose folder still holds a link that leads out stays kept, said, exit 3, nothing written', () => {
    const d = tempDir()
    const root = join(d, 'root'), folder = join(d, 'granted'), outside = join(d, 'outside')
    for (const p of [root, folder, outside]) mkdirSync(p)
    const id = 'kept-20261124T010203-bbbb'
    const runDir = plantRecord(root, id, { releasedAt: new Date().toISOString(), releasedBy: 'release' })
    const aclFile = join(runDir, 'acl-0.before')
    writeFileSync(aclFile, Buffer.from('granted\r\nD:AI(A;;FA;;;WD)\r\n', 'utf16le'))
    const rec = recordOf(root, id)
    writeFileSync(join(runDir, 'containment.json'), JSON.stringify({ ...rec, grantsKept: [{ folder, aclFile }] }, null, 2) + '\n')
    const link = join(folder, 'out')
    symlinkSync(outside, link, 'junction')
    try {
      const r = inRoot(root, ['restore-acl', id])
      expect(r.code, [...r.io.lines, ...r.io.errs].join('\n')).toBe(3)
      expect(r.io.lines).toEqual([`[sandbox] run ${id}: ${folder}: the access list saved before this run's grant was not put back, because ${link} leads outside it (to ${outside}); writing it rewrites what every entry under the folder inherited; its saved access list is ${aclFile}`])
      expect(r.io.errs).toEqual([`[sandbox] NOT PUT BACK: run ${id} still keeps a grant; run restore-acl again once what kept it is gone`])
      // Wave 19 (C6 b), on purpose: a grant still kept now says why (here rule M: a link leads out).
      expect(recordOf(root, id).grantsKept).toEqual([{ folder, aclFile, why: 'link' }])
    } finally {
      rmdirSync(link)
    }
  })
})

describe.skipIf(!bunPresent)('cynco-sandbox.mjs under bun', () => {
  it('mint prints one run id', () => {
    const r = cli(['mint', 'probe'], join(tempDir(), 'root'))
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toMatch(RUN_ID_RE)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
  }, 60_000)

  it('a sandbox root that does not exist is a refusal (exit 3), and nothing is created', () => {
    const dir = tempDir()
    const mission = join(dir, 'mission')
    mkdirSync(mission)
    const r = cli(['create', '--run-id', 'probe-20261123T010203-abcd', '--cwd', mission], join(dir, 'root'))
    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(r.stderr).toContain('[sandbox] REFUSED: containment: the sandbox root')
    expect(r.stderr).toContain('— nothing was run')
    expect(existsSync(join(dir, 'root'))).toBe(false)
    expect(readdirSync(mission)).toEqual([])
  }, 60_000)

  it('release twice exits 0 both times; status lists the run as released', () => {
    const root = join(tempDir(), 'root')
    const id = 'one-20261123T010203-abcd'
    plantRecord(root, id)
    const first = cli(['release', id], root)
    expect(first.status).toBe(0)
    expect(first.stdout).toContain(`[sandbox] run ${id} released`)
    expect(recordOf(root, id).releasedBy).toBe('release')
    const second = cli(['release', id], root)
    expect(second.status).toBe(0)
    expect(second.stdout).toContain(`run ${id} was already released at`)
    const status = cli(['status'], root)
    expect(status.status).toBe(0)
    expect(status.stdout).toMatch(new RegExp(`\\[sandbox\\] ${id}  mission  .*released .* \\(release\\)`))
    expect(cli(['release', 'never-20261123T010203-abcd'], root)).toMatchObject({ status: 0 })
  }, 120_000)

  it.skipIf(!isWin)('a release that leaves a folder labelled low says NOT SET BACK on stderr and exits 3', () => {
    const root = join(tempDir(), 'root')
    const id = 'stuck-20261123T010203-abcd'
    // A labelled record whose mission folder is gone: nothing can be set back (and no icacls runs).
    plantRecord(root, id, { cwdLabel: 'low', missionCwd: join(root, '..', 'gone') })
    const r = cli(['release', id], root)
    expect(r.status, r.stdout + r.stderr).toBe(3)
    expect(r.stderr).toContain(`[sandbox] NOT SET BACK: run ${id} released`)
    expect(r.stderr).toContain('is missing, so its label was not set back')
    expect(recordOf(root, id).releasedBy).toBe('release')
  }, 60_000)

  it('release-dead --kind mission --except <id> leaves <id> active and releases another; other kinds are left', () => {
    const root = join(tempDir(), 'root')
    const keep = 'keep-20261123T010203-aaaa', dead = 'dead-20261123T010203-bbbb', task = 'task-20261123T010203-cccc'
    plantRecord(root, keep)
    // Changed on purpose (F248 list): release-dead now releases only a record whose holder is gone,
    // as the sweep does, so the record that must be released names a holder that has exited (a
    // fresh holderless record, which this case used to plant, is now kept).
    plantRecord(root, dead, { holder: { pid: spawnSync(process.execPath, ['-e', '']).pid, startedAt: new Date().toISOString() } })
    plantRecord(root, task, { kind: 'daemon-task' })
    const r = cli(['release-dead', '--kind', 'mission', '--except', keep], root)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(recordOf(root, keep).releasedAt).toBeNull()
    expect(recordOf(root, dead).releasedAt).not.toBeNull()
    expect(recordOf(root, task).releasedAt).toBeNull()
    const status = cli(['status'], root).stdout
    expect(status).toContain(`${keep}  mission`)
    expect(status).toMatch(new RegExp(`${keep} .*ACTIVE \\(no holder yet\\)`))
  }, 120_000)

  it('sweep exits 0 and keeps a fresh sandbox', () => {
    const root = join(tempDir(), 'root')
    const id = 'fresh-20261123T010203-abcd'
    plantRecord(root, id)
    const r = cli(['sweep'], root)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[sandbox] sweep: 0 removed, 1 kept')
    expect(existsSync(join(root, id, 'containment.json'))).toBe(true)
  }, 60_000)

  // `create` labels folders on Windows; there the Bun fixture (engine/__tests__/containmentLauncher.test.ts)
  // is what makes a real sandbox, inside its own temp folder.
  it.skipIf(isWin)('create exits 0 and prints the [sandbox] run line; the record names the folder', () => {
    const dir = tempDir()
    const root = join(dir, 'root'), mission = join(dir, 'mission')
    mkdirSync(root)
    mkdirSync(join(mission, '.git'), { recursive: true })
    writeFileSync(join(mission, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const id = 'create-20261123T010203-abcd'
    const r = cli(['create', '--run-id', id, '--cwd', mission], root)
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toMatch(new RegExp(`\\[sandbox\\] run ${id}: .* ready in \\d+ ms`))
    expect(recordOf(root, id)).toMatchObject({ runId: id, kind: 'mission', test: false, releasedAt: null })
    expect(cli(['release', id], root).status).toBe(0)
  }, 60_000)
})
