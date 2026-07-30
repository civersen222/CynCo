import { describe, expect, it } from 'bun:test'
import { applyToolFloor } from '../../bridge/toolFloor.js'

/**
 * Finding (l), measured on the L3-3.3b run (trajectory task-f62b0bce).
 *
 * S5 declared a crisis at the top of the request and narrowed the base tool set
 * to read-only:
 *
 *   [s5] Decision: ... heterarchy: S5 commanding (crisis) — restricting to read-only
 *   [s5] ENFORCE: tool restriction to [Read, Glob, Grep, Ls]
 *
 * The floor then did its job as written and restored exactly what *enforcement*
 * demands:
 *
 *   [tool-floor] Restored Bash, ContractAssertPass, ContractAssertFail,
 *                ContractStatus — required by active contract enforcement
 *
 * leaving `Read, Glob, Grep, Ls, Bash, ContractAssert*` — an agent that can run
 * the test suite and mark assertions passed, and cannot change a file. The
 * contract it was holding asserted that two files WOULD be modified.
 *
 * The model spent 84 iterations saying "I need to STOP reading and actually EDIT
 * the file" and emitting Read, because Read was the nearest thing to its
 * intention that existed. 57 Reads, 0 Edits, 0 lines written. Its self-report
 * was accurate and the engine was the one at fault.
 *
 * The floor guaranteed the contract could be CLAIMED, never that it could be
 * ACHIEVED — which is the worse of the two failures, because Bash plus
 * ContractAssertPass without a way to write is precisely the kit for
 * manufacturing a dishonest pass.
 *
 * So the floor's requirement has to come from the contract's own assertions
 * rather than from a fixed list of the enforcement message's verbs.
 */

const READ_ONLY_PLUS_ENFORCEMENT = [
  { name: 'Read' }, { name: 'Glob' }, { name: 'Grep' }, { name: 'Ls' },
  { name: 'Bash' }, { name: 'ContractAssertPass' }, { name: 'ContractAssertFail' },
  { name: 'ContractStatus' },
]

const ALL = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'Git', 'Ls', 'MultiEdit',
  'ApplyPatch', 'ReplaceFunction', 'NotebookEdit',
  'ContractAssertPass', 'ContractAssertFail', 'ContractStatus',
].map(name => ({ name }))

describe('tool floor keeps the contract achievable, not merely claimable', () => {
  it('restores a way to write when the contract asserts a file will be modified', () => {
    // The measured incident, verbatim: the 3.3b offered set and the 3.3b assertion.
    const verdict = applyToolFloor({
      offered: READ_ONLY_PLUS_ENFORCEMENT,
      allTools: ALL,
      operatorPin: null,
      enforcementActive: true,
      assertions: ['File gilded/docket.py was modified (git diff shows changes)'],
    })
    expect(verdict.kind).toBe('restored')
    const names = verdict.tools.map(t => t.name)
    expect(names).toContain('Edit')
  })

  it('adds no writing tool when the contract makes no claim about the filesystem', () => {
    // The clause that stops this fix from being "always offer Edit". A contract
    // whose assertions are all commands has no business widening the set a
    // narrowing layer chose — the floor is a floor, not a veto on governance.
    const verdict = applyToolFloor({
      offered: READ_ONLY_PLUS_ENFORCEMENT,
      allTools: ALL,
      operatorPin: null,
      enforcementActive: true,
      assertions: ['Verification command exits 0: python C:/tmp/verify_l3_3.py ranked'],
    })
    expect(verdict.kind).toBe('ok')
    expect(verdict.tools.map(t => t.name)).not.toContain('Edit')
  })

  it('is satisfied by any one writing tool and does not pile on the rest', () => {
    // An any-of requirement, not an all-of one. A set that already contains
    // Write is not missing a way to write, and restoring Edit/MultiEdit/
    // ApplyPatch alongside it would be the floor overruling a deliberate
    // narrowing for no reason.
    const verdict = applyToolFloor({
      offered: [...READ_ONLY_PLUS_ENFORCEMENT, { name: 'Write' }],
      allTools: ALL,
      operatorPin: null,
      enforcementActive: true,
      assertions: ['File gilded/docket.py was modified (git diff shows changes)'],
    })
    expect(verdict.kind).toBe('ok')
    expect(verdict.tools.map(t => t.name)).not.toContain('Edit')
  })

  it('treats a deletion assertion as needing a writing tool too', () => {
    const verdict = applyToolFloor({
      offered: READ_ONLY_PLUS_ENFORCEMENT,
      allTools: ALL,
      operatorPin: null,
      enforcementActive: true,
      assertions: ['File src/legacy.ts no longer exists after changes'],
    })
    expect(verdict.kind).toBe('restored')
    expect(verdict.tools.map(t => t.name)).toContain('Edit')
  })

  it('reports unsatisfiable when the operator pin has no way to write', () => {
    // The human's explicit allowlist still wins. But saying so out loud beats
    // nagging the model for 84 iterations to perform an impossible action —
    // which is exactly what the unfixed engine did.
    const verdict = applyToolFloor({
      offered: READ_ONLY_PLUS_ENFORCEMENT,
      allTools: ALL,
      operatorPin: ['Read', 'Glob', 'Grep', 'Ls', 'Bash', 'ContractAssertPass', 'ContractAssertFail', 'ContractStatus'],
      enforcementActive: true,
      assertions: ['File gilded/docket.py was modified (git diff shows changes)'],
    })
    expect(verdict.kind).toBe('unsatisfiable')
    if (verdict.kind === 'unsatisfiable') expect(verdict.missing).toContain('Edit')
  })

  it('adds no requirement when no assertions were supplied', () => {
    // Absent is not the same as "no files will change". Callers without a
    // contract in hand must not be told the floor is unsatisfiable.
    const verdict = applyToolFloor({
      offered: READ_ONLY_PLUS_ENFORCEMENT,
      allTools: ALL,
      operatorPin: null,
      enforcementActive: true,
    })
    expect(verdict.kind).toBe('ok')
  })

  it('does not invent a writing tool this build never registered', () => {
    const verdict = applyToolFloor({
      offered: READ_ONLY_PLUS_ENFORCEMENT,
      allTools: READ_ONLY_PLUS_ENFORCEMENT,
      operatorPin: null,
      enforcementActive: true,
      assertions: ['File gilded/docket.py was modified (git diff shows changes)'],
    })
    expect(verdict.kind).toBe('ok')
  })
})
