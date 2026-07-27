import { describe, expect, it } from 'bun:test'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'

/**
 * Finding (k), measured on the L3-3.3b run (trajectory task-f62b0bce).
 *
 * The engine log, in order, at the top of a brand-new task:
 *
 *   [loop] Handling message: "GILDED STAGE 4 — L3 TASK 3.3b: ..."
 *   [vsm] Stuck counter reset (new user message)
 *   [contract] Harness-supplied: "..." (34 assertion(s))
 *   [s5] Decision: ... (homeostat unstable 72x — enforcing balanced priority;
 *        variety balance: overload (ratio 5.50); heterarchy: S5 commanding
 *        (crisis) — restricting to read-only)
 *   [s5] ENFORCE: tool restriction to [Read, Glob, Grep, Ls]
 *
 * `72x` is not a reading about this task. Iteration 1 had not happened yet. It
 * is the count left over from the previous task — a nine-minute run that ended
 * in a clean commit and 429 passing tests — and on the strength of it S5
 * declared a crisis and confiscated every writing tool for the whole of the
 * next task.
 *
 * The boundary reset was partial. It cleared the stuck counter and the tool
 * signatures, and left the escalation counter that S5 actually escalates on. So
 * the first governance decision of every task was made about the task before it.
 *
 * This is the same class as findings (f), (i) and the three before them: a
 * stale record standing in for a measurement nobody took. The rule is that a
 * measurement is either taken or it is absent — and for iteration 1 of a fresh
 * task, "how long has this task been unstable" is zero, not seventy-two.
 */

function destabilize(gov: CyberneticsGovernance, turns: number) {
  // Wide swings in tool and thinking pressure, which is what the homeostat
  // integrates over. The exact numbers do not matter; alternating extremes do.
  for (let i = 0; i < turns; i++) {
    const hot = i % 2 === 0
    gov.onTurnComplete({
      toolsCalled: hot ? 12 : 0,
      thinkingTokens: hot ? 4000 : 5,
      totalTokens: 5000,
      latencyMs: hot ? 30000 : 50,
      response: `turn ${i}`,
      contextUtilization: hot ? 0.95 : 0.05,
    })
  }
}

describe('a fresh task starts with fresh governance', () => {
  it('clears the consecutive-instability count at the task boundary', () => {
    const gov = new CyberneticsGovernance()
    destabilize(gov, 30)
    const before = (gov.getReport() as any).consecutiveUnstable
    // Guard the fixture: if this run never destabilized, the assertion below
    // would pass for the wrong reason.
    expect(before).toBeGreaterThan(0)

    gov.resetForNewTask()

    expect((gov.getReport() as any).consecutiveUnstable).toBe(0)
  })

  it('still clears the stuck counter it always cleared', () => {
    // The narrower guarantee the old resetStuck() made must survive the rename.
    //
    // This test was written first with `destabilize()` as its fixture and it
    // passed — vacuously. Mutation M7 (delete `this.stuckCount = 0` from the
    // reset) left it green, because destabilize varies its metrics and so never
    // raises the stuck count at all: the assertion was reading a zero that was
    // never anything else. A read loop is what actually raises it.
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 5; i++) {
      // Byte-identical calls — the signature window collapses to one entry.
      gov.onToolResult('Read', true, 5, '', { file_path: 'gilded/docket.py' })
      gov.onTurnComplete({
        toolsCalled: 1,
        thinkingTokens: 20,
        totalTokens: 500,
        latencyMs: 100,
        response: 'I need to STOP reading and actually EDIT the file.',
      })
    }
    expect(gov.getStuckCount()).toBeGreaterThan(0)

    gov.resetForNewTask()

    expect(gov.getStuckCount()).toBe(0)
  })

  it('does not declare the first turn of a new task stuck from inherited windows', () => {
    // Zeroing the counter is not enough if the evidence windows survive. Every
    // stuck rule asks whether the tail of a rolling window is uniform, so if the
    // previous task's entries are still in there, ONE turn of the new task can
    // re-trigger the count immediately and the reset buys nothing.
    //
    // The first version of this test ran an `Edit` after the reset and passed —
    // vacuously, the same way mutation M7 slipped past the test above. A
    // different signature breaks tail uniformity all by itself, so the
    // assertion never depended on the windows being cleared at all (mutation M8,
    // deleting both signature clears, left it green).
    //
    // The honest fixture is the case that actually happens: the previous task
    // died in a read loop, and the new task opens by reading. Two tasks in a row
    // touching gilded/docket.py is the norm, not a coincidence. On turn 1 there
    // is exactly ONE observation, and one observation cannot be a repetition —
    // "has this task repeated itself" is zero, not five.
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 5; i++) {
      gov.onToolResult('Read', true, 5, '', { file_path: 'gilded/docket.py' })
      gov.onTurnComplete({
        toolsCalled: 1, thinkingTokens: 20, totalTokens: 500, latencyMs: 100,
        response: 'I need to STOP reading and actually EDIT the file.',
      })
    }
    expect(gov.getStuckCount()).toBeGreaterThan(0)

    gov.resetForNewTask()

    // One turn of the new task, repeating the previous task's signature.
    gov.onToolResult('Read', true, 5, '', { file_path: 'gilded/docket.py' })
    gov.onTurnComplete({
      toolsCalled: 1, thinkingTokens: 30, totalTokens: 600, latencyMs: 120,
      response: 'Reading docket.py to find _init_appoint_director.',
    })
    expect(gov.getStuckCount()).toBe(0)
  })

  it('does not inherit the previous task\'s narration window', () => {
    // lastResponses is the third window feeding stuck detection, and the reset
    // never touched it. Three uniform responses are enough for responseStuck, so
    // a task that opens with two turns of the same narration as the task before
    // it is declared stuck on turn 2 — on a window in which only two of the
    // five entries belong to this task at all.
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 5; i++) {
      // Vary the tool so ONLY the response window is loaded up. This keeps the
      // test measuring one thing: if it fails, it is the narration window.
      gov.onToolResult('Read', true, 5, '', { file_path: `gilded/file${i}.py` })
      gov.onTurnComplete({
        toolsCalled: 1, thinkingTokens: 20, totalTokens: 500, latencyMs: 100,
        response: 'Let me look at the enterprise ledger.',
      })
    }

    gov.resetForNewTask()

    for (let i = 0; i < 2; i++) {
      gov.onToolResult('Read', true, 5, '', { file_path: `gilded/other${i}.py` })
      gov.onTurnComplete({
        toolsCalled: 1, thinkingTokens: 20, totalTokens: 500, latencyMs: 100,
        response: 'Let me look at the enterprise ledger.',
      })
    }
    // Two identical turns is below the >=3 threshold the rule states.
    expect(gov.getStuckCount()).toBe(0)
  })

  it('reports no recent tools for a task that has called none', () => {
    // lastToolSignatures drives no stuck rule — it feeds the report's
    // recentTools and prediction evaluation — so it is not a false-crisis path
    // like the three windows above. It is pinned anyway because deleting its
    // clear from the reset survived mutation, which means nothing was watching
    // it: S4's predictions would open the next task against the last task's
    // tool history.
    const gov = new CyberneticsGovernance()
    gov.onToolResult('Read', true, 5, '', { file_path: 'gilded/docket.py' })
    gov.onToolResult('Grep', true, 5, '', { pattern: 'director' })
    expect(gov.getRecentToolNames().length).toBeGreaterThan(0)

    gov.resetForNewTask()

    expect(gov.getRecentToolNames()).toEqual([])
  })
})
