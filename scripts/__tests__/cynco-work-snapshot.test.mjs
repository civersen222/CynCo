import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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

  // The live C9 authoring run's only preserved change was a SQLite code-index
  // db, and without `--binary` the patch was 169 bytes of "Binary files … differ"
  // — which `git apply` refuses. A patch that cannot be replayed is not a
  // backup, it is a note saying work was lost.
  it('records a binary change as a patch git apply will take', () => {
    const bin = join(repo, 'index.db')
    writeFileSync(bin, Buffer.from([0, 1, 2, 3, 250, 251]))
    spawnSync('git', ['add', 'index.db'], { cwd: repo })
    spawnSync('git', ['commit', '-m', 'add binary'], { cwd: repo })
    writeFileSync(bin, Buffer.from([9, 8, 7, 6, 5, 4, 3]))

    const r = snapshotUncommittedWork(repo, out, 'mission_bin')
    expect(r.written).toBe(true)
    const patch = readFileSync(r.patchPath, 'utf-8')
    expect(patch).toContain('GIT binary patch')
    expect(patch).not.toMatch(/^Binary files .* differ$/m)

    // And it really replays: reset the tree, apply, and the new bytes are back.
    spawnSync('git', ['checkout', '--', '.'], { cwd: repo })
    expect(readFileSync(bin)).toEqual(Buffer.from([0, 1, 2, 3, 250, 251]))
    const check = spawnSync('git', ['apply', '--check', r.patchPath], { cwd: repo, encoding: 'utf-8' })
    expect(check.status).toBe(0)
    expect(spawnSync('git', ['apply', r.patchPath], { cwd: repo }).status).toBe(0)
    expect(readFileSync(bin)).toEqual(Buffer.from([9, 8, 7, 6, 5, 4, 3]))
  })

  /**
   * `--binary` alone was not enough. `.cynco/` is the harness's own tree and its
   * code-index db is rewritten on every dispatch, so by resume time the blob has
   * moved on and the whole patch is refused — `git apply` is all-or-nothing, so
   * one churning file the model never authored holds the model's real work
   * hostage. Live C9 attempt 5 lost nothing only because it had committed.
   */
  it('excludes .cynco/ so harness churn cannot hold real work hostage', () => {
    mkdirSync(join(repo, '.cynco', 'index'), { recursive: true })
    writeFileSync(join(repo, '.cynco', 'index', 'project.db'), Buffer.from([1, 2, 3]))
    spawnSync('git', ['add', '-A'], { cwd: repo })
    spawnSync('git', ['commit', '-m', 'add harness tree'], { cwd: repo })

    // Both change: one is the model's work, one is harness churn.
    writeFileSync(join(repo, 'a.py'), 'x = 99\n')
    writeFileSync(join(repo, '.cynco', 'index', 'project.db'), Buffer.from([9, 9, 9, 9]))

    const r = snapshotUncommittedWork(repo, out, 'mission_excl')
    expect(r.written).toBe(true)
    const patch = readFileSync(r.patchPath, 'utf-8')
    expect(patch).toContain('a.py')
    expect(patch).not.toContain('.cynco')

    // And what is left applies, which is the only thing a backup has to do.
    spawnSync('git', ['checkout', '--', '.'], { cwd: repo })
    expect(spawnSync('git', ['apply', '--check', r.patchPath], { cwd: repo }).status).toBe(0)
    expect(spawnSync('git', ['apply', r.patchPath], { cwd: repo }).status).toBe(0)
    // Line endings normalised: this box has core.autocrlf=true, so `git apply`
    // writes CRLF and the content, not the encoding, is what is being asserted.
    expect(readFileSync(join(repo, 'a.py'), 'utf-8').replace(/\r\n/g, '\n')).toBe('x = 99\n')
  })

  // Review I3: live C9 attempt 8's restore was refused on the root-level
  // `.cynco-debug.json` — `.cynco` excludes only the directory of that name.
  it('excludes root .cynco-* files and .cynco-snapshots/ too', () => {
    mkdirSync(join(repo, '.cynco-snapshots'), { recursive: true })
    writeFileSync(join(repo, '.cynco-debug.json'), '{"n":1}\n')
    writeFileSync(join(repo, '.cynco-snapshots', 'x'), 'one\n')
    spawnSync('git', ['add', '-A'], { cwd: repo })
    spawnSync('git', ['commit', '-m', 'add harness files'], { cwd: repo })

    writeFileSync(join(repo, 'a.py'), 'x = 7\n')
    writeFileSync(join(repo, '.cynco-debug.json'), '{"n":2}\n')
    writeFileSync(join(repo, '.cynco-snapshots', 'x'), 'two\n')

    const r = snapshotUncommittedWork(repo, out, 'mission_excl_root')
    expect(r.written).toBe(true)
    const patch = readFileSync(r.patchPath, 'utf-8')
    expect(patch).toContain('a.py')
    expect(patch).not.toContain('.cynco-debug.json')
    expect(patch).not.toContain('.cynco-snapshots')

    // The harness files move on again before the resume — the patch still applies.
    spawnSync('git', ['checkout', '--', 'a.py'], { cwd: repo })
    writeFileSync(join(repo, '.cynco-debug.json'), '{"n":3}\n')
    expect(spawnSync('git', ['apply', r.patchPath], { cwd: repo }).status).toBe(0)
    expect(readFileSync(join(repo, 'a.py'), 'utf-8').replace(/\r\n/g, '\n')).toBe('x = 7\n')
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
