/**
 * Finding (z): a reward is a measurement made by a particular labeler, and the
 * record said nothing about which one.
 *
 * Between 2026-07-25 and 2026-07-27 the semantics in taskOutcome.ts and
 * rewardLabeler.ts changed sixteen times — testsPass scope, the tests-weakened
 * veto, the auto-contract rule, hygiene weights, the engine-error carve-out —
 * and `labelerVersion` stayed the literal 2 through all sixteen. So every
 * grounded record on disk claims version 2 and they were produced by up to
 * sixteen different rules. `MIN_LABELER_VERSION = 2` reads that field and
 * admits all of them, including L4.2 at 0.9736 for a run that deleted 32 test
 * cases — a run the current labeler scores -1.0.
 *
 * And the evidence was thrown away. buildComponents was called with live
 * in-memory state and the input discarded, so a record could never be
 * remeasured: every labeler fix destroyed corpus rather than repairing it.
 *
 * Two things are tested here, and they are the same rule twice:
 *   - the record names the semantics that produced it, and the name moves when
 *     the semantics move
 *   - the record carries what it was measured from, so the measurement can be
 *     redone rather than assumed still valid
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  LABELER_VERSION,
  computeReward,
  finalizeTask,
  relabel,
} from '../../training/rewardLabeler.js'
import { buildComponents } from '../../training/taskOutcome.js'
import type { TaskOutcomeInput } from '../../training/taskOutcome.js'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'labeler-identity-'))
}

function baseInput(): TaskOutcomeInput {
  return {
    testObservations: [],
    commandObservations: [],
    contract: null,
    git: null,
    trackedModifiedFiles: [],
    baselineDirty: null,
    stuckTurns: 0,
    turns: 0,
    hitIterationLimit: false,
    endedInEngineError: false,
  }
}

// ─── The semantics fingerprint ────────────────────────────────────

/**
 * A fixed table of outcome inputs chosen to touch every branch whose meaning
 * has changed at least once: the harness/auto contract split, the engine-error
 * carve-out, the turn-budget rule, the tests-weakened veto and its contract
 * escape, the testsPass scope check, and the inherited-dirt baseline.
 *
 * These are not assertions about what the right answer is. They are a tripwire:
 * if what the labeler says about ANY of them changes, the fingerprint moves.
 */
const VECTORS: [string, TaskOutcomeInput][] = [
  ['nothing observed', baseInput()],
  [
    'harness contract met, suite green, tree clean',
    {
      ...baseInput(),
      testObservations: [{ passed: 10, total: 12 }, { passed: 12, total: 12 }],
      commandObservations: [{ kind: 'typecheck', ok: true }],
      contract: { active: true, complete: true, failed: 0, origin: 'harness', passedAssertions: ['x'] },
      git: { changed: [{ path: 'src/a.ts', added: 5, deleted: 1 }], removed: [], dirty: [] },
      trackedModifiedFiles: ['src/a.ts'],
      baselineDirty: [],
      turns: 40,
    },
  ],
  [
    'auto contract met, suite green — completion not evidence',
    {
      ...baseInput(),
      testObservations: [{ passed: 12, total: 12 }],
      contract: { active: true, complete: true, failed: 0, origin: 'auto', passedAssertions: [] },
      turns: 20,
    },
  ],
  [
    'harness contract unmet, cut off by an engine error',
    {
      ...baseInput(),
      testObservations: [{ passed: 30, total: 30 }],
      contract: { active: true, complete: false, failed: 0, origin: 'harness', passedAssertions: [] },
      endedInEngineError: true,
      turns: 60,
    },
  ],
  // The vector above cannot see the crash rule: with git null its testsPass is
  // already 'unknown', so the row was degenerate for want of any outcome at all
  // and stayed degenerate for a different reason. task-25d8015a's shape is the
  // one that mattered — a real green test run banked BEFORE the server died,
  // enough outcome evidence to qualify, and an ending that never happened.
  [
    'cut off by an engine error after banking a green suite',
    {
      ...baseInput(),
      testObservations: [{ passed: 30, total: 30 }],
      contract: { active: true, complete: false, failed: 0, origin: 'harness', passedAssertions: [] },
      git: {
        changed: [{ path: 'src/a.test.ts', added: 97, deleted: 0, casesAdded: 7, casesLost: 0 }],
        removed: [],
        dirty: [],
      },
      trackedModifiedFiles: ['/repo/src/a.test.ts'],
      baselineDirty: [],
      endedInEngineError: true,
      turns: 59,
    },
  ],
  [
    'ran out of turns with nothing to judge completion by',
    { ...baseInput(), testObservations: [{ passed: 4, total: 4 }], hitIterationLimit: true, turns: 500 },
  ],
  [
    'test cases lost, no contract spoke about the file',
    {
      ...baseInput(),
      testObservations: [{ passed: 8, total: 8 }],
      contract: { active: true, complete: true, failed: 0, origin: 'harness', passedAssertions: ['product works'] },
      git: {
        changed: [
          { path: 'src/a.ts', added: 9, deleted: 2 },
          { path: 'tests/a.test.ts', added: 4, deleted: 40, casesLost: 32, assertions: -20 },
        ],
        removed: [],
        dirty: [],
      },
      trackedModifiedFiles: ['src/a.ts', 'tests/a.test.ts'],
      baselineDirty: [],
      turns: 90,
    },
  ],
  [
    'a skip marker was introduced',
    {
      ...baseInput(),
      testObservations: [{ passed: 8, total: 8 }],
      git: { changed: [{ path: 'tests/a.test.ts', added: 1, deleted: 0, skips: 1 }], removed: [], dirty: [] },
      trackedModifiedFiles: ['tests/a.test.ts'],
      baselineDirty: [],
      turns: 12,
    },
  ],
  [
    'a green one-test run beside a suite it does not cover',
    {
      ...baseInput(),
      testObservations: [{ passed: 421, total: 431 }, { passed: 1, total: 1 }],
      git: { changed: [{ path: 'src/a.ts', added: 3, deleted: 0 }], removed: [], dirty: [] },
      trackedModifiedFiles: ['src/a.ts'],
      baselineDirty: [],
      turns: 39,
    },
  ],
  [
    'the only dirty paths were dirty before the task began',
    {
      ...baseInput(),
      testObservations: [{ passed: 5, total: 5 }],
      git: { changed: [{ path: 'src/a.ts', added: 2, deleted: 0 }], removed: [], dirty: ['stale.md', 'src/a.ts'] },
      trackedModifiedFiles: ['src/a.ts'],
      baselineDirty: ['stale.md'],
      turns: 8,
    },
  ],
  [
    'stuck for ten turns',
    { ...baseInput(), testObservations: [{ passed: 5, total: 5 }], stuckTurns: 10, turns: 45 },
  ],
  // The two rows below exist to make the WEIGHTS visible. Every vector above
  // has its measurable positives all at 1 or all unknown, and a weighted mean
  // of a set of 1s is 1 for any weights at all — proven by nudging diffClean
  // from 0.10 to 0.11 and watching the fingerprint sit still. A tripwire that
  // does not move when the weights move is not watching the weights. These two
  // mix passes and failures across components so each weight has to carry.
  [
    'suite still partly red under a satisfied harness contract',
    {
      ...baseInput(),
      testObservations: [{ passed: 5, total: 20 }, { passed: 15, total: 20 }],
      commandObservations: [{ kind: 'typecheck', ok: true }, { kind: 'build', ok: false }],
      contract: { active: true, complete: true, failed: 0, origin: 'harness', passedAssertions: ['x'] },
      git: { changed: [{ path: 'src/a.ts', added: 6, deleted: 1 }], removed: [], dirty: ['scratch.txt'] },
      trackedModifiedFiles: ['src/a.ts'],
      baselineDirty: [],
      turns: 55,
    },
  ],
  [
    'suite green and the job done, but typecheck fails',
    {
      ...baseInput(),
      testObservations: [{ passed: 18, total: 20 }, { passed: 20, total: 20 }],
      commandObservations: [{ kind: 'typecheck', ok: false }, { kind: 'build', ok: true }],
      contract: { active: true, complete: true, failed: 0, origin: 'harness', passedAssertions: ['x'] },
      git: { changed: [{ path: 'src/a.ts', added: 6, deleted: 1 }], removed: [], dirty: [] },
      trackedModifiedFiles: ['src/a.ts'],
      baselineDirty: [],
      turns: 30,
    },
  ],
]

/**
 * What the labeler says about the whole table, in one hash.
 *
 * Taken from the record `finalizeTask` actually persists, not from
 * `buildComponents` alone, so the `degenerate` flag is covered too. That flag
 * is a verdict — it decides whether a row enters the corpus at all — and its
 * rule has already changed once (3a957da, hygiene alone cannot qualify a row).
 * A fingerprint over the components would have watched that change go by.
 *
 * `labelerVersion` is stripped: it is the label, not the semantics, and leaving
 * it in would make every bump invalidate its own new entry.
 */
function fingerprint(): string {
  const d = dir()
  const rows = VECTORS.map(([name, input], i) => {
    const { taskId: _t, labelerVersion: _v, ...verdict } = finalizeTask(
      `fp-${i}`,
      input.turns,
      buildComponents(input),
      d,
      // The outcome, not just the components. finalizeTask reads it directly —
      // a run the engine killed is excluded from the corpus on that field
      // alone — so a fingerprint that withheld it would have watched that rule
      // change go by, which is the exact failure this file exists to prevent.
      input,
    )
    return { name, ...verdict, reward: Number(verdict.reward.toFixed(6)) }
  })
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)
}

/**
 * APPEND-ONLY. Each entry binds a version number to what that version said.
 *
 * Changing the labeler moves the fingerprint, which breaks the entry for the
 * CURRENT version. The only honest repair is a new entry and a bump of
 * LABELER_VERSION — which is exactly the step that was skipped sixteen times.
 * Editing an existing entry in place is the dishonest repair, and it is at
 * least visible in a diff, which the silent omission never was.
 */
const SEMANTICS_HISTORY: Record<number, string> = {
  3: '8b8fdab1d63f89b8',
  // 4 (2026-07-31): two changes to what a row means.
  //   - diffClean stopped treating "the agent touched it" as an excuse for
  //     leaving it uncommitted. task-25d8015a scored 1 with ten of its own
  //     scratch files dirty in the tree.
  //   - a run the engine killed is degenerate. Withholding taskCompleted was
  //     not enough; testsPass alone then carried that same row to 0.9882.
  4: '1353acea4b26c20d',
}

describe('the labeler names its own semantics', () => {
  it('binds the current fingerprint to the current version', () => {
    expect(SEMANTICS_HISTORY[LABELER_VERSION]).toBe(fingerprint())
  })

  it('has not been bumped without recording what the new version says', () => {
    expect(Object.keys(SEMANTICS_HISTORY).map(Number)).toContain(LABELER_VERSION)
  })

  it('stamps records with the version constant rather than a literal', () => {
    const r = finalizeTask('task-v', 3, buildComponents(baseInput()), dir())
    expect(r.labelerVersion).toBe(LABELER_VERSION)
  })
})

describe('a reward record carries what it was measured from', () => {
  it('persists the outcome input beside the reward', () => {
    const d = dir()
    const input = VECTORS[1][1]
    finalizeTask('task-a', 40, buildComponents(input), d, input)
    const written = JSON.parse(readFileSync(join(d, 'task-a.outcome.json'), 'utf-8'))
    expect(written).toEqual(input)
  })

  it('writes no outcome file when the input was not supplied', () => {
    const d = dir()
    finalizeTask('task-b', 1, buildComponents(baseInput()), d)
    expect(existsSync(join(d, 'task-b.outcome.json'))).toBe(false)
  })

  it('relabels a record from its persisted input', () => {
    const d = dir()
    const input = VECTORS[5][1]
    finalizeTask('task-c', 90, buildComponents(input), d, input)
    const again = relabel('task-c', d)
    expect(again).not.toBeNull()
    expect(again!.components).toEqual(buildComponents(input))
    expect(again!.labelerVersion).toBe(LABELER_VERSION)
  })

  it('rewrites the record on disk so a stale reward cannot be read again', () => {
    const d = dir()
    const input = VECTORS[5][1]
    finalizeTask('task-d', 90, buildComponents(input), d, input)
    // Corrupt the stored reward the way a superseded labeler would have left it.
    const path = join(d, 'task-d.reward.json')
    const stale = JSON.parse(readFileSync(path, 'utf-8'))
    stale.reward = 0.9736
    stale.labelerVersion = 2
    require('fs').writeFileSync(path, JSON.stringify(stale), 'utf-8')

    relabel('task-d', d)
    const fixed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(fixed.labelerVersion).toBe(LABELER_VERSION)
    expect(fixed.reward).toBe(computeReward(buildComponents(input)))
  })

  it('returns null rather than guessing when there is no persisted input', () => {
    const d = dir()
    finalizeTask('task-e', 5, buildComponents(baseInput()), d)
    expect(relabel('task-e', d)).toBeNull()
  })

  it('preserves the turn count, which is not derivable from the components', () => {
    const d = dir()
    const input = { ...VECTORS[1][1], turns: 40 }
    finalizeTask('task-f', 40, buildComponents(input), d, input)
    expect(relabel('task-f', d)!.turns).toBe(40)
  })
})
