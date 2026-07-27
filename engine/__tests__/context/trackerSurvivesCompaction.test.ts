import { describe, expect, it } from 'bun:test'
import { ContextCompressor, FileOperationTracker } from '../../context/compressor.js'

/**
 * Finding (i), measured on the L3-3.3 run 2 (trajectory task-c2906f15).
 *
 * `filesTouched` read 2 from turn 24 — correct, the run edited docket.py and
 * test_docket.py — and then dropped to 0 at turn 79 and stayed 0 for the last
 * twelve training rows. Nothing happened at turn 79 but a `ContractAssertPass`.
 * The engine log records exactly one `[compact] in-loop at 86%`, and
 * compressor.ts:206 calls `fileTracker.reset()` at the end of every compaction.
 *
 * The tracker serves two consumers with opposite lifetimes:
 *
 *   - the summary prompt (compressor.ts:140), which lists files for the window
 *     it is summarizing — this is what reset() exists for, and it is right;
 *   - the measurement pipeline — `filesTouched` in every training row
 *     (conversationLoop.ts:3499), `trackedModifiedFiles` feeding diffClean's
 *     `wasTracked` (:2877), and the governance session outcome (main.ts:422).
 *     These are claims about the whole task and a compaction erases them.
 *
 * So a long run reports 0 files touched, and — exactly as in finding (f) —
 * diffClean charges the agent for dirt it honestly made, because the path is no
 * longer recognised as its own. A plausible default standing in for a record
 * that was deliberately discarded.
 *
 * These tests pin that the whole-task record survives a compaction while the
 * summary prompt keeps its narrow window.
 */

function convo(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: [{ type: 'text', text: `msg ${i}` }],
  }))
}

describe('FileOperationTracker across a compaction', () => {
  it('still reports a file modified before the compaction', () => {
    // The measured incident: two files edited, then one compaction, then 0.
    const t = new FileOperationTracker()
    t.record('gilded/docket.py', 'Edit')
    t.record('gilded/tests/test_docket.py', 'Edit')
    t.reset()
    expect(t.getModifiedFiles().sort()).toEqual(['gilded/docket.py', 'gilded/tests/test_docket.py'])
  })

  it('still reports a file read before the compaction', () => {
    const t = new FileOperationTracker()
    t.record('gilded/society/realm.py', 'Read')
    t.reset()
    expect(t.getReadFiles()).toEqual(['gilded/society/realm.py'])
  })

  it('counts a file edited on both sides of a compaction once', () => {
    // Guard against the naive fix: concatenating two logs must not double-count,
    // because filesTouched is a LENGTH and would silently inflate.
    const t = new FileOperationTracker()
    t.record('a.ts', 'Edit')
    t.reset()
    t.record('a.ts', 'Edit')
    expect(t.getModifiedFiles()).toEqual(['a.ts'])
  })

  it('keeps the summary prompt narrowed to the window it is summarizing', () => {
    // The other half, and the reason the fix is not simply deleting reset().
    // The prompt describes one compaction window; re-listing every file from
    // the whole task would attribute old work to it. This clause is what stops
    // the fix from being "make everything whole-task and call it done".
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5 })
    const t = new FileOperationTracker()
    t.record('old.ts', 'Edit')
    t.reset()
    t.record('new.ts', 'Edit')
    const prompt = c.buildStructuredSummaryPrompt(convo(4), t)
    expect(prompt).toContain('new.ts')
    expect(prompt).not.toContain('old.ts')
  })

  it('serializes the whole task, so a journal restore is not missing history', () => {
    // serialize() feeds the crash-safety journal at compressor.ts:203. If it
    // only carried the current window, a restore after two compactions would
    // come back with the same hole this finding is about.
    const t = new FileOperationTracker()
    t.record('early.ts', 'Edit')
    t.reset()
    t.record('late.ts', 'Edit')
    const restored = FileOperationTracker.deserialize(t.serialize())
    expect(restored.getModifiedFiles().sort()).toEqual(['early.ts', 'late.ts'])
  })

  it('reset on an empty tracker records nothing', () => {
    // Guard, not a gate: it passes at HEAD. Archiving must not invent an entry.
    const t = new FileOperationTracker()
    t.reset()
    expect(t.getModifiedFiles()).toEqual([])
    expect(t.getReadFiles()).toEqual([])
  })
})
