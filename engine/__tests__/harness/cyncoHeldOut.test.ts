import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// Plain .mjs harness module, used by scripts/cynco-mission-driver.mjs
// @ts-ignore — untyped harness module
import { snapshotHeldOut, restoreHeldOut } from '../../../scripts/cynco-held-out.mjs'

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
