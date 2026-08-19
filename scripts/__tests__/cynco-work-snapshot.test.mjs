import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { snapshotUncommittedWork } from '../cynco-work-snapshot.mjs'

let repo, out

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'snap-repo-'))
  out = mkdtempSync(join(tmpdir(), 'snap-out-'))
  spawnSync('git', ['init'], { cwd: repo })
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repo })
  writeFileSync(join(repo, 'a.py'), 'x = 1\n')
  spawnSync('git', ['add', 'a.py'], { cwd: repo })
  spawnSync('git', ['commit', '-m', 'base'], { cwd: repo })
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
})

describe('snapshotUncommittedWork', () => {
  it('writes a patch of tracked modifications', () => {
    writeFileSync(join(repo, 'a.py'), 'x = 2\n')
    const r = snapshotUncommittedWork(repo, out, 'mission_test')
    expect(r.written).toBe(true)
    expect(existsSync(r.patchPath)).toBe(true)
    expect(readFileSync(r.patchPath, 'utf-8')).toContain('-x = 1')
  })

  it('reports nothing to save on a clean tree', () => {
    const r = snapshotUncommittedWork(repo, out, 'mission_test')
    expect(r.written).toBe(false)
  })

  it('never writes inside the workspace it is snapshotting', () => {
    writeFileSync(join(repo, 'a.py'), 'x = 3\n')
    const r = snapshotUncommittedWork(repo, out, 'mission_test')
    expect(r.patchPath.startsWith(repo)).toBe(false)
  })

  it('lists untracked files without copying them into the repo', () => {
    writeFileSync(join(repo, 'scratch.py'), 'print(1)\n')
    const r = snapshotUncommittedWork(repo, out, 'mission_test')
    expect(r.untracked).toContain('scratch.py')
  })

  // The whole point of this function is that it runs on the exit path of a
  // six-hour mission. A throw here would cost the ledger record, so every
  // failure mode has to come back as a value.
  it('does not throw when the output directory does not exist yet', () => {
    writeFileSync(join(repo, 'a.py'), 'x = 4\n')
    const nested = join(out, 'does', 'not', 'exist')
    let r
    expect(() => { r = snapshotUncommittedWork(repo, nested, 'mission_test') }).not.toThrow()
    expect(r.written).toBe(true)
    expect(existsSync(r.patchPath)).toBe(true)
  })

  it('does not throw on garbage arguments', () => {
    let r
    expect(() => { r = snapshotUncommittedWork(join(out, 'no-such-repo'), undefined, undefined) }).not.toThrow()
    expect(r.written).toBe(false)
  })

  // The driver's own exit path is the only caller. If the import or the call
  // ever goes away, this goes red rather than leaving a pure function that
  // nothing runs.
  it('is imported and called by the mission driver', () => {
    const driver = readFileSync(join(import.meta.dirname, '..', 'cynco-mission-driver.mjs'), 'utf-8')
    // Asserted as booleans, not against the file text: a `toContain` failure
    // here prints the whole 700-line driver and buries the reason.
    const imported = driver.includes("from './cynco-work-snapshot.mjs'")
    const called = /snapshotUncommittedWork\(\s*CWD\s*,/.test(driver)
    expect({ imported, called }).toEqual({ imported: true, called: true })
  })
})
