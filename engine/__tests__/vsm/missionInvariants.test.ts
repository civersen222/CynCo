import { describe, it, expect, beforeEach } from 'bun:test'
import { MissionInvariants, DEFAULT_INVARIANT_CAPS, parseInvariantCaps } from '../../vsm/missionInvariants.js'

const read = (n: number) => ['Read', { file_path: `C:\\repo\\f${n}.py` }] as const
const bashRead = (n: number) => ['Bash', { command: `Get-Content C:\\repo\\f${n}.py` }] as const

describe('MissionInvariants', () => {
  let inv: MissionInvariants
  beforeEach(() => { inv = new MissionInvariants({ ...DEFAULT_INVARIANT_CAPS, editGapCap: 5, commitGapCap: 8 }) })

  it('parses caps and rejects malformed ones', () => {
    expect(parseInvariantCaps({ editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: false }))
      .toEqual({ editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: false })
    expect(parseInvariantCaps(undefined)).toBeNull()
    expect(parseInvariantCaps({ editGapCap: 'x' })).toBeNull()
    expect(parseInvariantCaps({ editGapCap: 0, commitGapCap: 1, revertBan: true, codeIndexFirst: true })).toBeNull()
  })

  it('refuses the revert family with a teachback naming the alternative', () => {
    const v = inv.evaluate('Bash', { command: 'git checkout -- gilded/ui/app.py' })
    expect(v.kind).toBe('deny')
    if (v.kind === 'deny') {
      expect(v.invariant).toBe('revert')
      expect(v.message).toContain('discards work')
      expect(v.message).toContain('targeted Edit')
    }
    expect(inv.evaluate('Git', { subcommand: 'stash', args: '' }).kind).toBe('deny')
    expect(inv.evaluate('Bash', { command: 'git checkout -b topic' }).kind).toBe('allow')
    expect(inv.snapshot().revertRefusals).toBe(2)
  })

  it('steps to edit-only after the edit gap is exceeded, with dwell, and back after an edit', () => {
    for (let n = 0; n < 5; n++) { expect(inv.evaluate(...read(n)).kind).toBe('allow'); inv.observeCall('Read', read(n)[1], false) }
    // 6th call: callsSinceSourceEdit = 6 > 5 → the homeostat steps
    inv.evaluate(...read(5)); inv.observeCall('Read', read(5)[1], false)
    expect(inv.snapshot().configuration).toBe('edit-only')
    expect(inv.snapshot().steps).toHaveLength(1)
    expect(inv.snapshot().steps[0]).toMatchObject({ variable: 'callsSinceSourceEdit', from: 'full', to: 'edit-only' })
    const denied = inv.evaluate(...read(6))
    expect(denied.kind).toBe('deny')
    if (denied.kind === 'deny') {
      expect(denied.invariant).toBe('edit-gap')
      expect(denied.message).toContain('6 calls since your last source edit')
      expect(denied.message).toContain('smallest edit')
    }
    inv.observeCall('Read', read(6)[1], true) // the denial is still a call
    expect(inv.evaluate('Edit', { file_path: 'C:\\repo\\a.py', old_string: 'x', new_string: 'y' }).kind).toBe('allow')
    inv.observeCall('Edit', { file_path: 'C:\\repo\\a.py' }, false)
    expect(inv.snapshot().callsSinceSourceEdit).toBe(0)
    expect(inv.snapshot().configuration).toBe('full')
    expect(inv.snapshot().steps[0].restoredAfter).toBe(2)
    expect(inv.evaluate(...read(7)).kind).toBe('allow')
  })

  it('edit-only denies read-shaped Bash and relents once after three refusals', () => {
    for (let n = 0; n < 6; n++) inv.observeCall('Read', read(n)[1], false)
    expect(inv.snapshot().configuration).toBe('edit-only')
    expect(inv.evaluate(...bashRead(1)).kind).toBe('deny'); inv.observeCall('Bash', bashRead(1)[1], true)
    expect(inv.evaluate(...bashRead(2)).kind).toBe('deny'); inv.observeCall('Bash', bashRead(2)[1], true)
    expect(inv.evaluate(...bashRead(3)).kind).toBe('deny'); inv.observeCall('Bash', bashRead(3)[1], true)
    expect(inv.evaluate(...bashRead(4)).kind).toBe('allow')  // relent: one read served
    inv.observeCall('Bash', bashRead(4)[1], false)
    expect(inv.evaluate(...bashRead(5)).kind).toBe('deny')
    expect(inv.evaluate('Bash', { command: 'python -m pytest gilded/tests -q' }).kind).toBe('allow')
  })

  it('records what the call after each denial did', () => {
    for (let n = 0; n < 6; n++) inv.observeCall('Read', read(n)[1], false)
    inv.evaluate(...read(9)); inv.observeCall('Read', read(9)[1], true)
    inv.observeCall('Edit', { file_path: 'C:\\repo\\a.py' }, false)
    const d = inv.snapshot().denials
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ invariant: 'edit-gap', tool: 'Read', nextCallClass: 'sourceEdit' })
  })

  it('commit gap steps to edit-only and a commit restores it', () => {
    for (let n = 0; n < 9; n++) { inv.observeCall('Edit', { file_path: 'C:\\repo\\a.py' }, false) }
    // 9 edits: callsSinceSourceEdit stays 0, callsSinceCommit = 9 > 8
    expect(inv.snapshot().configuration).toBe('edit-only')
    expect(inv.snapshot().steps.at(-1)?.variable).toBe('callsSinceCommit')
    const v = inv.evaluate(...read(0))
    expect(v.kind).toBe('deny')
    if (v.kind === 'deny') { expect(v.invariant).toBe('commit-gap'); expect(v.message).toContain('9 calls since your last commit') }
    inv.observeCommit()
    inv.observeCall('Bash', { command: 'git status --short' }, false)
    expect(inv.snapshot().configuration).toBe('full')
  })

  it('counts CodeIndex-assisted greps', () => {
    inv.noteCodeIndexAssisted(); inv.noteCodeIndexAssisted()
    expect(inv.snapshot().codeIndexAssisted).toBe(2)
  })
})
