/**
 * A row whose label is known not to describe its trajectory has to be able to
 * leave the corpus, and stay gone.
 *
 * Measured 2026-07-31 on task-694ad10f. The run split gilded/tests/test_ui_hud.py
 * into a second file: 40 lines out of the first (1 case, 2 assertions), 520 lines
 * into gilded/tests/test_ui_hud_meters.py (36 cases, 60 assertions). The suite
 * went 639 passing to 645. `casesLost` is measured PER FILE — deliberately, since
 * a repo-wide net would let a run gut one suite and pad another (finding (w)) —
 * so a case that moved between files reads as a case destroyed. No assertion
 * named the path, because until ed047e5 no mission could name one (finding (ai)),
 * so `assessTestsUnmodified` returned 0 and `computeReward` returned -1.0.
 *
 * A row teaching that growing a suite by 35 cases earns the maximum penalty is
 * worse than no row. But `degenerate` is DERIVED — recomputed by finalizeTask
 * from the components every time — so setting it by hand is an assertion the
 * code cannot reproduce, and the next relabel pass silently restores the row.
 * That is finding (z)'s lesson pointed the other way: a judgement that is not
 * persisted as evidence does not survive contact with the machinery.
 *
 * So quarantine is its own field, carries the reason a person gave, and is
 * preserved across relabeling.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { quarantine, isQuarantined, relabel } from '../../training/rewardLabeler.js'
import { isUsable } from '../../training/datasetBuilder.js'

let dir: string

const reward = (over: Record<string, unknown> = {}) => ({
  taskId: 'task-abc', turns: 12, reward: -1, labelerVersion: 4,
  components: { testsUnmodified: 0, testsPass: 1, taskCompleted: 1 },
  ...over,
})

const write = (taskId: string, body: unknown) =>
  writeFileSync(join(dir, `${taskId}.reward.json`), JSON.stringify(body, null, 2), 'utf-8')

const read = (taskId: string) =>
  JSON.parse(readFileSync(join(dir, `${taskId}.reward.json`), 'utf-8'))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'quarantine-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('quarantining a row', () => {
  it('records the reason and when, on the row itself', () => {
    write('task-abc', reward())
    quarantine('task-abc', 'test split across files reads as a deletion', dir)
    const r = read('task-abc')
    expect(r.quarantined.reason).toBe('test split across files reads as a deletion')
    expect(Date.parse(r.quarantined.at)).not.toBeNaN()
  })

  it('leaves the measurement alone — the label was not wrong, it was inapplicable', () => {
    // Rewriting the reward would be inventing a measurement nobody took. The
    // components stay exactly as measured; what changes is whether the row is
    // offered as training data.
    write('task-abc', reward())
    quarantine('task-abc', 'r', dir)
    const r = read('task-abc')
    expect(r.reward).toBe(-1)
    expect(r.components.testsUnmodified).toBe(0)
    expect(r.labelerVersion).toBe(4)
  })

  it('refuses a row that does not exist rather than creating one', () => {
    expect(() => quarantine('task-nope', 'r', dir)).toThrow(/task-nope/)
    expect(existsSync(join(dir, 'task-nope.reward.json'))).toBe(false)
  })

  it('refuses an empty reason — an unexplained exclusion is a silent one', () => {
    write('task-abc', reward())
    expect(() => quarantine('task-abc', '   ', dir)).toThrow(/reason/)
    expect(read('task-abc').quarantined).toBeUndefined()
  })

  it('is idempotent but keeps the first reason and time', () => {
    write('task-abc', reward())
    quarantine('task-abc', 'first', dir)
    const at = read('task-abc').quarantined.at
    quarantine('task-abc', 'second', dir)
    expect(read('task-abc').quarantined.reason).toBe('first')
    expect(read('task-abc').quarantined.at).toBe(at)
  })
})

describe('a quarantined row is not training data', () => {
  it('isUsable is false even though every other condition holds', () => {
    const t = {
      taskId: 'task-abc', turns: [], hasSnapshot: true, snapshot: null,
      reward: reward() as never,
    }
    expect(isUsable(t as never)).toBe(true)
    const q = { ...t, reward: reward({ quarantined: { reason: 'r', at: 'x' } }) as never }
    expect(isUsable(q as never)).toBe(false)
  })

  it('isQuarantined reads the flag without needing the whole trajectory', () => {
    expect(isQuarantined(reward() as never)).toBe(false)
    expect(isQuarantined(reward({ quarantined: { reason: 'r', at: 'x' } }) as never)).toBe(true)
  })
})

describe('relabeling does not resurrect it', () => {
  /**
   * The failure this whole shape exists to prevent. `relabel` rebuilds the
   * record from the persisted outcome, and anything it does not carry forward
   * is dropped — so a hand-set flag comes back as a usable row on the next
   * labeler fix, with nobody watching.
   */
  it('carries the quarantine through a remeasurement', () => {
    write('task-abc', reward({ quarantined: { reason: 'split across files', at: '2026-07-31T00:00:00.000Z' } }))
    writeFileSync(join(dir, 'task-abc.outcome.json'), JSON.stringify({
      turns: 12, testObservations: [{ passed: 5, total: 5, command: 'pytest -q' }],
      commandObservations: [], contract: null, git: null,
      trackedModifiedFiles: [], baselineDirty: [], stuckTurns: 0,
    }), 'utf-8')

    const out = relabel('task-abc', dir)
    expect(out).not.toBeNull()
    expect(out!.quarantined?.reason).toBe('split across files')
    expect(out!.quarantined?.at).toBe('2026-07-31T00:00:00.000Z')
    expect(read('task-abc').quarantined.reason).toBe('split across files')
  })

  it('a row that was never quarantined stays unquarantined', () => {
    write('task-abc', reward())
    writeFileSync(join(dir, 'task-abc.outcome.json'), JSON.stringify({
      turns: 12, testObservations: [{ passed: 5, total: 5, command: 'pytest -q' }],
      commandObservations: [], contract: null, git: null,
      trackedModifiedFiles: [], baselineDirty: [], stuckTurns: 0,
    }), 'utf-8')
    expect(relabel('task-abc', dir)!.quarantined).toBeUndefined()
  })
})
