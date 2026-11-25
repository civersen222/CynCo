// scripts/cynco-campaign-adopt.mjs main(): adopting a wave by hand. The adoption itself (adopt()) is tested in
// cynco-campaign.test.mjs; this file runs the command's main() on a real spec file and a state folder of its own.
//
// C5-7 (wave 19): a wave adopted by hand is graded with no integrity reading by the runner (runWave's ADOPT path
// skips DISPATCH and WAIT, where the reading is taken), and a ledger row carries no run id to look a settle up by.
// `--adopt-inflight` says so for a record without a run id; the hand adopt now says it too, on a line of its own
// after the adopt line, and names the command that shows whether a baseline is still open.
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../cynco-campaign-adopt.mjs'

const ROOT = mkdtempSync(join(tmpdir(), 'cynco-adopt-test-'))
afterAll(() => {
  // Only this harness writes here (a state.json), so no link can be in it.
  rmSync(ROOT, { recursive: true, force: true })
})

// Check G19-7 (wave 19b): from this file, not from the working folder, so a run started elsewhere tests the line.
const SPEC = fileURLToPath(new URL('../../docs/civkings-redesign-briefs/c8.campaign.json', import.meta.url))
const row = { missionId: 'c8-wave1-1788634174399', briefFile: 'docs/civkings-redesign-briefs/c8-wave1.txt', commitRange: { base: '1d03308abc', head: '1bc0f8c' } }

/** main() with its output caught: what it printed on stdout and stderr, and its exit code. */
const run = (argv, io) => {
  const out = [], err = []
  const ol = console.log, oe = console.error
  console.log = (m) => { out.push(String(m)) }
  console.error = (m) => { err.push(String(m)) }
  try { return { code: main(argv, io), out, err } } finally { console.log = ol; console.error = oe }
}

describe('cynco-campaign-adopt main()', () => {
  it('adopts the row and says, after the adopt line, that the runner takes no integrity reading for it', () => {
    const dir = mkdtempSync(join(ROOT, 'state-'))
    const r = run([SPEC, row.missionId], { readRow: (id) => (id === row.missionId ? row : null), stateDir: () => dir })
    expect(r.code).toBe(0)
    expect(r.err).toEqual([])
    expect(r.out).toEqual([
      `[adopt] c8: wave 1 will GRADE ${row.missionId} (base 1d03308, brief ${row.briefFile}) instead of dispatching`,
      '[adopt] the runner takes no integrity reading for a wave adopted by hand: check that the run\'s baseline was settled (bun scripts/cynco-guard.mjs status) before you rely on the grade',
    ])
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).adoptedRow).toBe(row.missionId)
  })

  it('refuses a mission with no ledger row, and a campaign with no state, and says nothing about integrity', () => {
    const dir = mkdtempSync(join(ROOT, 'state-'))
    const none = run([SPEC, 'c8-wave9-1'], { readRow: () => null, stateDir: () => dir })
    expect(none).toEqual({ code: 2, out: [], err: ['[adopt] no ledger row with missionId c8-wave9-1'] })
    const missing = join(ROOT, 'not-made')
    const noState = run([SPEC, row.missionId], { readRow: () => row, stateDir: () => missing })
    expect(noState.code).toBe(2)
    expect(noState.out).toEqual([])
    expect(noState.err).toEqual([`[adopt] no campaign state at ${missing} \u2014 run the campaign once first`])
    expect(existsSync(missing)).toBe(false)
  })
})
