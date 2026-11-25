// engine/__tests__/daemon/precheck.test.ts
// The daemon's precheck runs contained, or not at all (F242; 01-isolation 6.1, tests 9.6). A precheck that
// could not run answers `skip: precheck not run: <reason>`, never a failing code: a failing code would let
// the pass run although the gate did not. On Windows the contained run itself is shown by the Bun fixture
// (containmentLauncher.test.ts, step `precheck`); vitest's Node has no launcher.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPrecheck } from '../../daemon/precheck.js'
import { LAUNCHER_UNAVAILABLE, containmentRecords } from '../../containment.js'
import { SUITE_CONTAINMENT_ENV } from '../setup/containment.js'
import { AUDIT_MARKER, AUDIT_NOT_WRITTEN } from '../../audit/toolAudit.js'

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
    let auditBefore: string | undefined
    let audit = ''
    beforeEach(() => {
      root = join(dir, 'root')
      mission = join(dir, 'mission')
      mkdirSync(root)
      mkdirSync(mission)
      rootBefore = process.env.LOCALCODE_SANDBOX_ROOT
      process.env.LOCALCODE_SANDBOX_ROOT = root
      // S5: the precheck's context records its command; the audit folder is a marked one of this test's own.
      audit = join(dir, 'audit')
      mkdirSync(audit)
      writeFileSync(join(audit, AUDIT_MARKER), '')
      auditBefore = process.env.LOCALCODE_AUDIT_DIR
      process.env.LOCALCODE_AUDIT_DIR = audit
    })
    afterEach(() => {
      if (rootBefore === undefined) delete process.env.LOCALCODE_SANDBOX_ROOT
      else process.env.LOCALCODE_SANDBOX_ROOT = rootBefore
      if (auditBefore === undefined) delete process.env.LOCALCODE_AUDIT_DIR
      else process.env.LOCALCODE_AUDIT_DIR = auditBefore
    })
    const records = () => readdirSync(audit).filter(n => n.endsWith('.jsonl'))
      .flatMap(n => readFileSync(join(audit, n), 'utf-8').split('\n').filter(l => l !== '').map(l => JSON.parse(l)))

    it('S5: one start with src precheck and the command verbatim, and one end with the exit code', async () => {
      const r = await runPrecheck('echo go; exit 3', mission, 'trades')
      expect(r.code).toBe(3)
      const recs = records()
      const start = recs.find(x => x.kind === 'start')
      expect(start).toMatchObject({ src: 'precheck', command: 'echo go; exit 3', cwd: mission })
      expect(start.run.startsWith('precheck-trades-')).toBe(true)
      expect(recs.find(x => x.kind === 'end')).toMatchObject({ call: start.seq, isError: true, exitCode: 3 })
    })

    it('S5: a start that cannot be written runs nothing, answers the skip and releases the sandbox', async () => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      mkdirSync(join(audit, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`))
      const witness = join(dir, 'ran.txt')
      const err = console.error
      console.error = () => undefined
      try {
        const r = await runPrecheck(`echo x > "${witness}"`, mission, 'trades')
        expect(r).toEqual({ code: 0, stdout: `skip: precheck not run: audit: ${AUDIT_NOT_WRITTEN('audit-dir-unwritable')}` })
        expect(said).toContain(`[daemon] precheck not run: audit: ${AUDIT_NOT_WRITTEN('audit-dir-unwritable')}`)
      } finally {
        console.error = err
      }
      expect(existsSync(witness)).toBe(false)
      expect(containmentRecords({ sandboxRoot: root }).every((rec) => rec.releasedAt !== null)).toBe(true)
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

    // NOW.md, 2026-11-24: exec's own timeout ended the shell alone and left what the precheck had
    // started running. The tree is owned from the start and ended on the precheck's cap; asked by
    // the pid of the program the shell started. Off Windows here; on Windows vitest's Node has no
    // launcher, so the same code runs only under Bun.
    it('a precheck cut at its cap ends what it started, and reads as a cut precheck (code 1, no status)', async () => {
      const r = await runPrecheck('sleep 300 & echo "pid=$!"; wait', mission, 'cap', 1000)
      expect(r.code).toBe(1)
      const pid = Number(/pid=(\d+)/.exec(r.stdout)?.[1])
      expect(Number.isInteger(pid) && pid > 0, r.stdout).toBe(true)
      const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
      const until = Date.now() + 5000
      while (alive() && Date.now() < until) await new Promise(res => setTimeout(res, 100))
      const survived = alive()
      if (survived) process.kill(pid, 'SIGKILL')
      expect(survived, `sleep ${pid}, started by the precheck, outlived its cap`).toBe(false)
      expect(said).toContain('[daemon] precheck cut at its cap of 1000 ms; its process tree is ended')
      expect(records().find(x => x.kind === 'end')).toMatchObject({ isError: true, exitCode: null })
      expect(containmentRecords({ sandboxRoot: root }).every((rec) => rec.releasedAt !== null)).toBe(true)
    }, 20_000)
  })
})
