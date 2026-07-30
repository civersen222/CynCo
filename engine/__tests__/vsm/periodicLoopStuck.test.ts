// Finding (e), measured on the live L3-3.3 run (trajectory task-17656b4b).
//
// Turns 78-105 were a perfect period-5 cycle: four byte-identical Read calls
// (inputHash 7720e12a3092, 28 of them) then one byte-identical
// ContractAssertFail, over and over. Every call returned success=true, so the
// governance report read `tools=1.00 stuck=0` and filesTouched stayed 0 for
// nearly thirty turns while no work was done at all. Nothing ever climbed
// toward the stuckCount >= 15 halt, and the run burned toward the iteration cap.
//
// Two compounding faults produced that blindness:
//
//   1. toolStuck required uniqueToolSigs === 1 across the whole 5-call window.
//      The observed window is [Read,Read,Read,Read,ContractAssertFail] — two
//      distinct signatures — so it was false on every single turn. Stuck
//      detection could only ever see a PURE repetition, never a periodic one.
//
//   2. The else branch decremented stuckCount whenever no pure repetition was
//      found. FingerprintRepetitionDetector already fires 'identical' on 2 of
//      every 5 turns of this cycle, but -1 on the other 3 nets to -1 per
//      period. Consuming the alarm alone does NOT fix it; both halves must go.
//
// stuckCount already resets to 0 on a successful mutating tool and on real file
// progress. Those are the honest progress signals. Decaying on the mere absence
// of a pure repetition was erasing evidence rather than recording it.
import { beforeEach, describe, expect, it } from 'vitest'
import { CyberneticsGovernance } from '../../vsm/cyberneticsGovernance.js'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'

const READ_INPUT = { file_path: 'C:/Users/civer/civkings/gilded/docket.py' }

function turn(gov: CyberneticsGovernance, response = '') {
  gov.onTurnComplete({
    toolsCalled: 1,
    thinkingTokens: 0,
    totalTokens: 100,
    latencyMs: 10,
    response,
  })
}

/** One iteration of the measured cycle: 4 identical Reads, then the same fail. */
function measuredCycle(gov: CyberneticsGovernance) {
  for (let i = 0; i < 4; i++) {
    gov.onToolResult('Read', true, 3, '', READ_INPUT)
    turn(gov, `looking at docket ${i}`)
  }
  gov.onToolResult('ContractAssertFail', true, 2, '', { assertion: 'ranked' })
  turn(gov, 'reporting the failure')
}

describe('periodic tool loops are visible to stuck detection', () => {
  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
    globalContract.clear()
  })

  it('the measured period-5 cycle climbs to the halt threshold', () => {
    const gov = new CyberneticsGovernance()
    // The live run ran this cycle at least six times over turns 78-105 without
    // stuck ever leaving 0. Ten cycles is fifty turns — comfortably longer than
    // what was observed, and still under the run's iteration budget.
    for (let i = 0; i < 10; i++) measuredCycle(gov)
    expect(gov.getStuckCount()).toBeGreaterThanOrEqual(15)
  })

  it('a no-progress turn never erodes accumulated stuck evidence', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 3; i++) {
      gov.onToolResult('Read', true, 3, '', READ_INPUT)
      turn(gov, `read ${i}`)
    }
    const earned = gov.getStuckCount()
    expect(earned).toBeGreaterThan(0)
    // A single unrelated read is not progress. It is just a different call.
    gov.onToolResult('Grep', true, 5, '', { pattern: 'appoint_director' })
    turn(gov, 'grepping')
    expect(gov.getStuckCount()).toBeGreaterThanOrEqual(earned)
  })

  it('a successful mutating call still clears stuck outright', () => {
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 6; i++) {
      gov.onToolResult('Read', true, 3, '', READ_INPUT)
      turn(gov, `read ${i}`)
    }
    expect(gov.getStuckCount()).toBeGreaterThan(0)
    gov.onToolResult('Edit', true, 12, '', { file_path: 'gilded/docket.py' })
    turn(gov, 'wrote the handler')
    expect(gov.getStuckCount()).toBe(0)
  })

  it('varied genuine work never accumulates stuck', () => {
    const gov = new CyberneticsGovernance()
    const files = ['a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py', 'g.py', 'h.py']
    for (const f of files) {
      gov.onToolResult('Read', true, 3, '', { file_path: f })
      turn(gov, `reading ${f}`)
    }
    expect(gov.getStuckCount()).toBe(0)
  })

  it('a whitelisted polling tool repeated alone does not count as stuck', () => {
    // ContractStatus is on the FingerprintRepetitionDetector whitelist by
    // design — the model re-polls contract state deliberately. Repeating it must
    // not be mistaken for a loop by the newly-consumed alarm. Note this DOES
    // still trip the pre-existing pure-repetition rule, which is correct and
    // unchanged; what is asserted here is that the alarm adds no new false
    // positive of its own.
    const gov = new CyberneticsGovernance()
    for (let i = 0; i < 4; i++) {
      gov.onToolResult('ContractStatus', true, 1, '', {})
    }
    expect(gov.getReport().fingerprintAlarm).toBeNull()
  })
})
