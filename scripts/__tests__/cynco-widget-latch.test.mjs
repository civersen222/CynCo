// Wave 15 (NOW.md:57): the desk widget prints the integrity latch. cynco-widget.ps1 -Probe ends with one
// "integrity|<state>|<text>" line, read from the guard folder it is pointed at (-GuardDir, here this file's
// own temp folder): the latch's public summary, when and by whom, and that nothing unattended runs under it.
// Skipped where powershell is not on PATH (Linux CI).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dirname, '..', 'cynco-widget.ps1')
const hasPs = !spawnSync('powershell', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error
if (!hasPs) console.warn('cynco-widget latch test skipped: powershell is not on PATH')

let root
function probe(guard) {
  const r = spawnSync('powershell', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Probe',
    '-MissionsDir', join(root, 'missions'), '-ControlFile', join(root, 'daemon-control.json'), '-StateFile', join(root, 'widget.json'),
    '-GuardDir', guard], { encoding: 'utf8', timeout: 60000 })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.split(/\r?\n/).filter(Boolean)
}
const integrityLine = (lines) => lines.filter(l => l.startsWith('integrity|'))

describe.skipIf(!hasPs)('cynco-widget -Probe: the integrity line', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'widget-latch-'))
    mkdirSync(join(root, 'missions'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('clear: no latch in the guard folder', () => {
    const g = join(root, 'g-clear'); mkdirSync(g)
    expect(integrityLine(probe(g))).toEqual(['integrity|clear|-'])
  })

  it('latched: the public summary, when and by whom, and what it stops; no path from the record', () => {
    const g = join(root, 'g-latched'); mkdirSync(g)
    writeFileSync(join(g, 'HALT.json'), JSON.stringify({
      schema: 1, at: '2026-11-24T20:00:00.000Z', by: 'engine-tripwire', reason: 'presence-lost', summary: 'C:\\Users\\x\\.config gone',
      publicSummary: '1 change(s) in protected folders (first: PRESENCE)',
    }))
    expect(integrityLine(probe(g))).toEqual(['integrity|latched|INTEGRITY LATCH: 1 change(s) in protected folders (first: PRESENCE); set 2026-11-24T20:00:00.000Z by engine-tripwire (presence-lost). No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear'])
  })

  it('a record that cannot be read, and a guard folder that is not there', () => {
    const g = join(root, 'g-torn'); mkdirSync(g)
    writeFileSync(join(g, 'HALT.json'), '{ torn')
    expect(integrityLine(probe(g))).toEqual(['integrity|latched|INTEGRITY LATCH: the integrity latch is set, and its record cannot be read. No unattended run starts and no queued command runs until it is cleared at the desk: bun scripts/cynco-guard.mjs clear'])
    expect(integrityLine(probe(join(root, 'no-such-guard')))).toEqual(['integrity|unusable|INTEGRITY: the guard folder cannot be used, so no unattended run starts; bun scripts/cynco-guard.mjs status says why'])
  })
})
