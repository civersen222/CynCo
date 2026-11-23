// engine/__tests__/daemon/precheck.test.ts
// The daemon's precheck runs contained, or not at all (F242; 01-isolation 6.1, tests 9.6). A precheck that
// could not run answers `skip: precheck not run: <reason>`, never a failing code: a failing code would let
// the pass run although the gate did not. On Windows the contained run itself is shown by the Bun fixture
// (containmentLauncher.test.ts, step `precheck`); vitest's Node has no launcher.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPrecheck } from '../../daemon/precheck.js'
import { LAUNCHER_UNAVAILABLE, containmentRecords } from '../../containment.js'
import { SUITE_CONTAINMENT_ENV } from '../setup/containment.js'

describe('runPrecheck', () => {
  let dir = ''
  let said: string[] = []
  const log = console.log
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cynco-precheck-'))
    said = []
    console.log = (...a: unknown[]) => { said.push(a.map(String).join(' ')) }
  })
  afterEach(() => {
    console.log = log
    rmSync(dir, { recursive: true, force: true })
  })

  it('a trigger with no cwd is not run, and says so', async () => {
    const r = await runPrecheck('echo go')
    expect(r).toEqual({ code: 0, stdout: 'skip: precheck not run: this trigger names no cwd' })
    expect(said).toContain('[daemon] precheck not run: this trigger names no cwd')
  })

  it("with the suite's sandbox root (a folder that does not exist) nothing runs and the answer is a skip", async () => {
    const witness = join(dir, 'ran.txt')
    const r = await runPrecheck(`echo x > "${witness}"`, dir, 't1')
    expect(r.code).toBe(0)
    // On Windows vitest's Node cannot start the launcher, which is asked before the root (E6).
    expect(r.stdout).toMatch(process.platform === 'win32'
      ? `skip: precheck not run: ${LAUNCHER_UNAVAILABLE('not Bun')}`
      : `skip: precheck not run: the sandbox root ${SUITE_CONTAINMENT_ENV.LOCALCODE_SANDBOX_ROOT} is not an absolute path to an existing folder`)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a switch set in the daemon refuses: a precheck is never run with a layer off', async () => {
    const before = process.env.LOCALCODE_CONTAINMENT_OFF
    process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
    try {
      const r = await runPrecheck('echo go', dir, 't1')
      expect(r.code).toBe(0)
      expect(r.stdout).toMatch(/^skip: precheck not run: LOCALCODE_CONTAINMENT_OFF switches a containment layer off/)
    } finally {
      if (before === undefined) delete process.env.LOCALCODE_CONTAINMENT_OFF
      else process.env.LOCALCODE_CONTAINMENT_OFF = before
    }
  })

  describe.skipIf(process.platform === 'win32')('off Windows, under a sandbox root of its own', () => {
    let root = ''
    let mission = ''
    let rootBefore: string | undefined
    beforeEach(() => {
      root = join(dir, 'root')
      mission = join(dir, 'mission')
      mkdirSync(root)
      mkdirSync(mission)
      rootBefore = process.env.LOCALCODE_SANDBOX_ROOT
      process.env.LOCALCODE_SANDBOX_ROOT = root
    })
    afterEach(() => {
      if (rootBefore === undefined) delete process.env.LOCALCODE_SANDBOX_ROOT
      else process.env.LOCALCODE_SANDBOX_ROOT = rootBefore
    })

    it('the command sees the sandbox as its home, the mission folder is not labelled, and the record is released', async () => {
      const r = await runPrecheck('echo "home=$HOME"; echo "tmp=$TMPDIR"', mission, 'trades')
      expect(r.code).toBe(0)
      const recs = containmentRecords({ sandboxRoot: root })
      expect(recs.length).toBe(1)
      const rec = recs[0]
      expect(rec.kind).toBe('precheck')
      expect(rec.runId.startsWith('precheck-trades-')).toBe(true)
      expect(rec.cwdLabel).toBe('none')
      expect(rec.holder?.pid).toBe(process.pid)
      expect(rec.releasedAt).not.toBeNull()
      expect(rec.releasedBy).toBe('release')
      const runDir = join(realpathSync(root), rec.runId)
      expect(r.stdout).toContain(`home=${join(runDir, 'home')}`)
      expect(r.stdout).toContain(`tmp=${join(runDir, 'tmp')}`)
      // The record on disk says the same (containmentRecords reads it).
      expect(JSON.parse(readFileSync(join(runDir, 'containment.json'), 'utf-8')).releasedAt).toBe(rec.releasedAt)
    })

    it('a command that exits 3 answers code 3', async () => {
      const r = await runPrecheck('echo go; exit 3', mission, 'trades')
      expect(r).toEqual({ code: 3, stdout: 'go\n' })
      expect(containmentRecords({ sandboxRoot: root }).every((rec) => rec.releasedAt !== null)).toBe(true)
    })

    it('with no trigger id the label is the folder name', async () => {
      await runPrecheck('true', mission)
      expect(containmentRecords({ sandboxRoot: root })[0].runId.startsWith('precheck-mission-')).toBe(true)
    })
  })
})
