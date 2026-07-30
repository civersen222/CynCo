import { describe, expect, it } from 'bun:test'
import { applyPreLoopRestriction } from '../../bridge/s5Restriction.js'

/**
 * Finding (j), measured on the L3-3.3b run.
 *
 * S5 makes one decision per user message, before iteration 1 has happened, from
 * a governance report describing the PREVIOUS task. On L3-3.3b it read
 * "homeostat unstable 72x" and fired rule I4:
 *
 *   [s5] ENFORCE: tool restriction to [Read, Glob, Grep, Ls]
 *
 * Finding (k) removed the stale counter that produced that reading, and finding
 * (l) made the restriction non-fatal for contract tools. Neither addressed the
 * shape of the thing: the restriction was applied by assigning the filtered
 * array back to `toolDefs`, the variable handed to the model loop for the whole
 * task. It was a snapshot with no expiry. Nothing in the loop could widen it
 * again — the model could spend seventy turns unable to write a file because of
 * a reading taken before it had done anything.
 *
 * Every other narrowing in the loop — demoted tools, the tool gate, the live
 * stuck re-evaluation, the contract floor — is computed per iteration against
 * `iterationTools` and reconsidered on the next one. The pre-loop restriction
 * was the only one that stuck, and it was the only one decided on evidence from
 * before the task began.
 *
 * So it governs iteration 1 and no further. That is not a softening; it is the
 * scope the evidence actually has. From iteration 2 the task has produced its
 * own measurements, and the live re-evaluation at stuck >= 5 re-imposes a
 * restriction on THAT evidence if the crisis is real. A pre-task reading has no
 * standing to describe a turn that has since happened.
 */

const TOOLS = [
  { name: 'Read' }, { name: 'Glob' }, { name: 'Grep' }, { name: 'Ls' },
  { name: 'Edit' }, { name: 'Write' }, { name: 'Bash' },
]
const READ_ONLY = { tools: ['Read', 'Glob', 'Grep', 'Ls'], reasoning: 'heterarchy: S5 commanding (crisis)' }

describe('the pre-loop S5 restriction governs the turn it was decided for, and no more', () => {
  it('narrows the first iteration', () => {
    const { tools, applied } = applyPreLoopRestriction(TOOLS, READ_ONLY, 0)
    expect(applied).toBe(true)
    expect(tools.map(t => t.name)).toEqual(['Read', 'Glob', 'Grep', 'Ls'])
  })

  it('lifts on the second iteration', () => {
    // The turn S5 was reasoning about has now happened. Whatever it thought
    // before iteration 1 has been superseded by an actual observation.
    const { tools, applied } = applyPreLoopRestriction(TOOLS, READ_ONLY, 1)
    expect(applied).toBe(false)
    expect(tools).toBe(TOOLS)
  })

  it('stays lifted deep into the task', () => {
    // The failure mode being fixed: seventy turns of read-only.
    const { tools } = applyPreLoopRestriction(TOOLS, READ_ONLY, 70)
    expect(tools.map(t => t.name)).toContain('Edit')
  })

  it('passes tools through untouched when S5 restricted nothing', () => {
    const { tools, applied } = applyPreLoopRestriction(TOOLS, null, 0)
    expect(applied).toBe(false)
    expect(tools).toBe(TOOLS)
  })

  it('refuses a restriction that would leave the model no tools at all', () => {
    // Preserved from the old inline enforcement: a restriction naming only
    // tools that are not on offer must be skipped, not obeyed into an empty
    // set. A model with zero tools cannot do anything, including recover.
    const { tools, applied } = applyPreLoopRestriction(
      TOOLS, { tools: ['NotALoadedTool'], reasoning: 'x' }, 0,
    )
    expect(applied).toBe(false)
    expect(tools).toBe(TOOLS)
  })

  it('does not report a restriction that changed nothing as applied', () => {
    // If every offered tool is already permitted there is no narrowing, and
    // logging "ENFORCE" for it would put a phantom intervention in the record
    // the outcome ledger reads.
    const all = { tools: TOOLS.map(t => t.name), reasoning: 'x' }
    const { tools, applied } = applyPreLoopRestriction(TOOLS, all, 0)
    expect(applied).toBe(false)
    expect(tools).toBe(TOOLS)
  })
})
