import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Plain .mjs harness module, used by scripts/cynco-mission-driver.mjs
// @ts-ignore — untyped harness module
import { snapshotHeldOut, restoreHeldOut, withHeldOutRestored, driverInstrumentAssertions } from '../../../scripts/cynco-held-out.mjs'
import { withheldGatePaths } from '../../bridge/contractAutoCreate.js'

describe('held-out instrument snapshots', () => {
  let root: string
  let gate: string
  let vault: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'heldout-'))
    gate = join(root, 'gate.py')
    vault = join(root, 'vault')
    writeFileSync(gate, 'print("the real gate")\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('copies the instrument out of reach and leaves the original alone', () => {
    const snaps = snapshotHeldOut([gate], vault)
    expect(snaps).toHaveLength(1)
    expect(existsSync(snaps[0].snapshot)).toBe(true)
    expect(readFileSync(snaps[0].snapshot, 'utf-8')).toBe('print("the real gate")\n')
    expect(readFileSync(gate, 'utf-8')).toBe('print("the real gate")\n')
  })

  /**
   * F152. The live C9 authoring run's check command names the read-only
   * archive of the game at BASE — a directory — and `copyFileSync` on a
   * directory is EPERM on Windows. It killed the driver before iteration 1.
   * `withheldGatePaths` is the fix; this is the floor under it.
   */
  it('records a directory as unsnapshottable instead of dying on it', () => {
    const dir = join(root, 'base_archive')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'app.py'), 'print("the game")\n')
    const snaps = snapshotHeldOut([dir, gate], vault)
    expect(snaps[0]).toMatchObject({ path: dir, snapshot: null, missing: true })
    // The real instrument beside it is still taken.
    expect(snaps[1].missing).toBe(false)
    expect(readFileSync(snaps[1].snapshot, 'utf-8')).toBe('print("the real gate")\n')
    // And restore steps over it without touching the directory.
    expect(restoreHeldOut(snaps)).toEqual([])
    expect(readFileSync(join(dir, 'app.py'), 'utf-8')).toBe('print("the game")\n')
  })

  it('says nothing changed when nothing changed', () => {
    expect(restoreHeldOut(snapshotHeldOut([gate], vault))).toEqual([])
  })

  it('puts back an instrument the mission rewrote, and names it', () => {
    // Measured on Gilded I4d2b3f: the run found the unsealed script that
    // GENERATES the gate, ran it, and regenerated the gate from a stale base --
    // wiping the calibration and replacing the instrument with one whose
    // demands were a previous wave's. The seal hides a path; it does not stop a
    // child process the shell spawns from writing to it.
    const snaps = snapshotHeldOut([gate], vault)
    writeFileSync(gate, 'import sys; sys.exit(0)\n')
    const changed = restoreHeldOut(snaps)
    expect(changed).toEqual([gate])
    expect(readFileSync(gate, 'utf-8')).toBe('print("the real gate")\n')
  })

  it('puts back an instrument the mission deleted', () => {
    const snaps = snapshotHeldOut([gate], vault)
    rmSync(gate)
    expect(restoreHeldOut(snaps)).toEqual([gate])
    expect(readFileSync(gate, 'utf-8')).toBe('print("the real gate")\n')
  })

  it('reports a path that was already missing at dispatch rather than inventing one', () => {
    const ghost = join(root, 'never-existed.py')
    const snaps = snapshotHeldOut([ghost], vault)
    expect(snaps[0].missing).toBe(true)
    // Nothing to restore, and restoring must not create a file that never was.
    expect(restoreHeldOut(snaps)).toEqual([])
    expect(existsSync(ghost)).toBe(false)
  })

  it('keeps two instruments apart even when they share a basename', () => {
    const other = join(root, 'sub')
    mkdirSync(other)
    const gate2 = join(other, 'gate.py')
    writeFileSync(gate2, 'print("the other gate")\n')
    const snaps = snapshotHeldOut([gate, gate2], vault)
    expect(snaps[0].snapshot).not.toBe(snaps[1].snapshot)
    writeFileSync(gate, 'wrecked\n')
    writeFileSync(gate2, 'wrecked\n')
    expect(restoreHeldOut(snaps).sort()).toEqual([gate, gate2].sort())
    expect(readFileSync(gate, 'utf-8')).toBe('print("the real gate")\n')
    expect(readFileSync(gate2, 'utf-8')).toBe('print("the other gate")\n')
  })

  it('compares bytes, not size or mtime', () => {
    // A regeneration from a stale base can land on exactly the same length.
    const snaps = snapshotHeldOut([gate], vault)
    writeFileSync(gate, 'print("the fake gate")\n')
    expect(readFileSync(gate, 'utf-8').length).toBe('print("the real gate")\n'.length)
    expect(restoreHeldOut(snaps)).toEqual([gate])
  })
})

// Phase 7 final review I1 + M5: the marker check (the suite gate and its
// baseline) reaches the driver on its own channel, not as a contract
// assertion; its instruments are still snapshotted at dispatch and put back —
// and the put-back runs on EVERY exit of the check routine, the skipped-gate
// path included.
describe('the marker-check path: snapshotted, restored on every exit', () => {
  let home: string
  let repo: string
  let baseline: string
  let suite: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mc-home-'))
    repo = mkdtempSync(join(tmpdir(), 'mc-repo-')).replace(/\\/g, '/')
    mkdirSync(join(home, 'heldout', 'c9'), { recursive: true })
    mkdirSync(join(home, 'heldout', 'common'), { recursive: true })
    baseline = join(home, 'heldout', 'c9', 'suite_baseline_abc1234.txt').replace(/\\/g, '/')
    suite = join(home, 'heldout', 'common', 'g_suite_no_regression.py').replace(/\\/g, '/')
    writeFileSync(baseline, 'tests/test_a.py::test_one_standing_failure\n')
    writeFileSync(suite, '# the suite gate\n')
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  const env = () => ({ CYNCO_MARKER_CHECK: `CHK_SUITE_BASELINE=${baseline} CYNCO_GATE_REPO=${repo} python "${suite}"`, CYNCO_MARKER_CHECK_TIMEOUT_MS: '1800000' })
  const keepGreen = [{ text: 'held out', command: 'python -m pytest tests -q' }]

  it('takes the baseline into the driver\'s instrument set from the channel, not from the contract', () => {
    expect(withheldGatePaths(keepGreen, repo)).toEqual([])
    const paths = withheldGatePaths(driverInstrumentAssertions(keepGreen, env()), repo).map((p: string) => p.toLowerCase())
    expect(paths).toEqual([baseline, suite].map(p => p.toLowerCase()).sort())
    // No channel: the contract alone, as before.
    expect(driverInstrumentAssertions(keepGreen, {})).toEqual(keepGreen)
    expect(driverInstrumentAssertions(null, {})).toEqual([])
  })

  it('puts a rewritten baseline back when the check routine returns, throws, or never runs the check', async () => {
    const snaps = snapshotHeldOut(withheldGatePaths(driverInstrumentAssertions(keepGreen, env()), repo), join(home, 'vault'))
    const logged: string[] = []
    const log = (s: string) => logged.push(s)

    // The skipped-gate path: the routine runs no check at all.
    writeFileSync(baseline, 'tests/test_a.py::test_everything_forgiven\n')
    const skipped = await withHeldOutRestored(snaps, async () => 'skipped', log)
    expect(skipped).toEqual({ value: 'skipped', restoredAtExit: [baseline] })
    expect(readFileSync(baseline, 'utf-8')).toBe('tests/test_a.py::test_one_standing_failure\n')
    expect(logged.join('\n')).toMatch(/HELD-OUT INSTRUMENT CHANGED .* restored at the end of the check routine/)

    // A routine that throws still puts it back, and the throw goes on.
    writeFileSync(baseline, 'wrecked\n')
    await expect(withHeldOutRestored(snaps, async () => { throw new Error('boom') }, log)).rejects.toThrow('boom')
    expect(readFileSync(baseline, 'utf-8')).toBe('tests/test_a.py::test_one_standing_failure\n')

    // Nothing touched: nothing restored, nothing said.
    logged.length = 0
    expect(await withHeldOutRestored(snaps, async () => 1, log)).toEqual({ value: 1, restoredAtExit: [] })
    expect(logged).toEqual([])
  })

  // The driver is a top-level script with no unit seam, so its wiring is read.
  it('the driver runs the marker check (with its ordinal) and wraps the check routine in the restore', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../scripts/cynco-mission-driver.mjs', import.meta.url)), 'utf-8')
    expect(src).toMatch(/const MARKER = markerCheckFrom\(process\.env, checkCmd, CHECK_TIMEOUT_MS\)/)
    expect(src).toMatch(/await runCheckAsync\(MARKER\.command, CWD, MARKER\.timeoutMs, \{ env: \{ CYNCO_CHECK_ORDINAL: String\(ordinal\) \} \}\)/)
    expect(src).not.toMatch(/runCheckAsync\(checkCmd/)
    expect(src).toMatch(/await withHeldOutRestored\(heldOutSnapshots, async \(\) => \{\s*\n\s*if \(MARKER\.command && !gate\.run\)/)
  })
})
