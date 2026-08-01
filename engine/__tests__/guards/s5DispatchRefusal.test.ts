/**
 * F59: the warning about S5 enforcement arrived after the dispatch it should
 * have stopped.
 *
 * The driver learned that enforcement was live from the first `s5.decision`
 * frame carrying `enforced: true`. That is late in two separate ways. It is
 * after the mission has been sent, so the only remedy — restart the engine
 * capped — costs the whole run. And it depends on some decision ACTUALLY
 * enforcing: an engine with enforcement on that happens to enforce nothing in
 * the first thirty turns emits no such frame, so the run is confounded and
 * silent about it. A detector that fires on a symptom of the hazard cannot
 * report the hazard's absence.
 *
 * S5 enforcement can restrict tools mid-mission (F7, which killed a run) and
 * every ledger label the mission produces is confounded by it, because the
 * outcome then partly measures the governor rather than the work. So this is
 * not a warning; it is a precondition of dispatching at all.
 *
 * Shaped like F41 deliberately. The engine advertises a POSITIVE word for the
 * safe state — `s5-advisory`, meaning "S5 is capped at recommend in this
 * process" — and the driver refuses on ABSENCE. The inverse encoding, a word
 * for the hazard, would make an engine too old to say anything indistinguishable
 * from a safe one, and the silent case is the one that has already cost a run.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAP_S5_ADVISORY, governanceCapabilities } from '../../bridge/capabilities.js'
// @ts-ignore — untyped harness module
import { s5DispatchRefusal, CAP_S5_ADVISORY as CONTRACT_WORD } from '../../../scripts/cynco-contract.mjs'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')

const wiring = (s5Enforcing: () => boolean) => ({
  seal: () => {},
  probe: () => true,
  unseal: () => {},
  s5Enforcing,
})

describe('the engine says whether S5 can restrict this mission', () => {
  const original = process.env.LOCALCODE_S5_ENFORCE
  afterEach(() => {
    if (original === undefined) delete process.env.LOCALCODE_S5_ENFORCE
    else process.env.LOCALCODE_S5_ENFORCE = original
  })

  it('advertises s5-advisory when enforcement is capped', () => {
    expect(governanceCapabilities(wiring(() => false))).toContain(CAP_S5_ADVISORY)
  })

  it('withholds the word when enforcement is live', () => {
    expect(governanceCapabilities(wiring(() => true))).not.toContain(CAP_S5_ADVISORY)
  })

  it('reads the live process, not a literal: the env toggles the word', () => {
    // The measurement rule. A hardcoded list would satisfy the first case above
    // on an engine that enforces, which is the only case that matters.
    process.env.LOCALCODE_S5_ENFORCE = 'false'
    expect(governanceCapabilities()).toContain(CAP_S5_ADVISORY)
    process.env.LOCALCODE_S5_ENFORCE = 'true'
    expect(governanceCapabilities()).not.toContain(CAP_S5_ADVISORY)
  })

  it('asks the same predicate the enforcing site asks', () => {
    // F42: a limit read from one place and enforced from another is two limits.
    // `conversationLoop` decides whether to APPLY an S5 decision by calling
    // isS5EnforcementEnabled; the advertisement must not have its own opinion.
    expect(read('engine/bridge/capabilities.ts')).toContain('isS5EnforcementEnabled')
    expect(read('engine/bridge/conversationLoop.ts')).toContain('isS5EnforcementEnabled')
  })

  it('the two capabilities are independent — one hazard does not mask the other', () => {
    const caps = governanceCapabilities({
      seal: () => {}, probe: () => false, unseal: () => {}, s5Enforcing: () => false,
    })
    expect(caps).toContain(CAP_S5_ADVISORY)
    expect(caps).not.toContain('sealed-gates')
  })
})

describe('the driver refuses to dispatch into a governor that can restrict it', () => {
  it('the driver and the engine spell the word identically', () => {
    // Two constants meaning one thing is how a guard stops matching.
    expect(CONTRACT_WORD).toBe(CAP_S5_ADVISORY)
  })

  it('refuses when the engine advertises capabilities without the word', () => {
    const refusal = s5DispatchRefusal({ capabilities: ['sealed-gates'] })
    expect(refusal).toBeTruthy()
    expect(refusal).toMatch(/S5/)
  })

  it('refuses when the engine sent no capabilities at all — absence is not permission', () => {
    expect(s5DispatchRefusal({ capabilities: undefined })).toBeTruthy()
  })

  it('refuses when session.ready never arrived, because unknown is not present', () => {
    expect(s5DispatchRefusal({ capabilities: null })).toBeTruthy()
  })

  it('dispatches when the engine advertises the cap', () => {
    expect(s5DispatchRefusal({ capabilities: [CAP_S5_ADVISORY] })).toBeNull()
  })

  it('applies to every mission, not only the ones that seal something', () => {
    // Unlike the seal guard. Enforcement confounds the labels of a mission with
    // nothing withheld exactly as much as one with a held-out gate.
    expect(s5DispatchRefusal({ capabilities: [], sealedCount: 0 })).toBeTruthy()
  })

  it('names the remedy, because the operator is the only one who can apply it', () => {
    const refusal = String(s5DispatchRefusal({ capabilities: [] }))
    expect(refusal).toContain('LOCALCODE_S5_ENFORCE=false')
    expect(refusal).toMatch(/restart/i)
  })
})

describe('the guard is on the live dispatch path, before the mission is sent', () => {
  const driver = read('scripts/cynco-mission-driver.mjs').replace(/\r\n/g, '\n')

  it('imports the guard rather than re-deriving the decision', () => {
    expect(driver).toMatch(/import \{[^}]*\bs5DispatchRefusal\b[^}]*\} from \S*cynco-contract/)
  })

  // The two guards live in two blocks: one runs when the engine answers, one
  // when it never does. A check that finds `s5DispatchRefusal` anywhere in the
  // file is satisfied by either, so each block is asked separately — a mutation
  // must name its target, and "somewhere in this file" names neither.
  const block = (from: string, to: string) => {
    const start = driver.indexOf(from)
    expect(start).toBeGreaterThan(-1)
    const end = driver.indexOf(to, start)
    expect(end).toBeGreaterThan(start)
    return driver.slice(start, end)
  }

  it('consults the guard in the branch that handles the engine answering', () => {
    const ready = block("if (m.type === 'session.ready'", 'dispatchMission()')
    expect(ready).toContain('s5DispatchRefusal(')
  })

  it('a refused dispatch exits there, rather than logging and sending anyway', () => {
    // F32: the absence of work needs its own name. A mission never sent must not
    // be recorded as one that ran and produced nothing.
    const ready = block("if (m.type === 'session.ready'", 'dispatchMission()')
    expect(ready).toMatch(/if \(refusal\)[\s\S]{0,200}process\.exit\(/)
  })

  it('nothing is dispatched before the engine has said what it is', () => {
    // The property, not the mechanism: an unsealed mission used to be sent on
    // `onopen`, before session.ready and therefore before any capability could
    // be read. A guard that only runs on the sealed path is not a guard on the
    // dispatch. So `onopen` may no longer dispatch at all.
    const onopen = driver.slice(driver.indexOf('ws.onopen'), driver.indexOf('ws.onmessage'))
    expect(onopen).not.toContain('dispatchMission()')
  })

  it('a session.ready that never arrives is refused by name, not waited out', () => {
    // Otherwise the fix trades a confounded mission for a hung one — and a
    // timeout that does not say which guarantee went unestablished leaves the
    // operator to guess between two very different repairs.
    const timer = block('const readyGateTimer', 'ws.onopen')
    expect(timer).toContain('s5DispatchRefusal(')
    expect(timer).toMatch(/process\.exit\(/)
  })

  it('the timer is armed for every mission, not only sealed ones', () => {
    // It used to be `SEALED_COUNT > 0 ? setTimeout(...) : null`, which is the
    // same hole as the dispatch path had: no seal, no guard, no timeout. The
    // timer must therefore be built by an unconditional call, not by an
    // expression that can evaluate to null.
    expect(driver).toMatch(/const readyGateTimer = setTimeout\(/)
  })
})
