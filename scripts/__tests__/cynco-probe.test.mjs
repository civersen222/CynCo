import { describe, it, expect } from 'vitest'
import { probeConfigError, shouldProbe, overrideDecision, probeMessage } from '../cynco-probe.mjs'

describe('probeConfigError', () => {
  it('refuses a probe command without an operator-chosen cap', () => {
    expect(probeConfigError('pytest -q', undefined)).toMatch(/CYNCO_PROBE_TIMEOUT_MS/)
  })
  it('accepts a probe command with an explicit cap', () => {
    expect(probeConfigError('pytest -q', '600000')).toBeNull()
  })
  it('accepts no probe at all', () => {
    expect(probeConfigError(undefined, undefined)).toBeNull()
  })
  it('refuses a cap that is not a positive integer', () => {
    expect(probeConfigError('pytest -q', 'soon')).toMatch(/CYNCO_PROBE_TIMEOUT_MS/)
    expect(probeConfigError('pytest -q', '0')).toMatch(/CYNCO_PROBE_TIMEOUT_MS/)
  })
})

describe('shouldProbe', () => {
  const base = { probeCmd: 'pytest -q', landed: true, exitReason: 'engine_closed_the_turn' }
  it('probes a landed mission at a quiescent turn boundary', () => {
    expect(shouldProbe(base)).toBe(true)
    expect(shouldProbe({ ...base, exitReason: 'quiet_heuristic' })).toBe(true)
  })
  it('never probes without a probe command', () => {
    expect(shouldProbe({ ...base, probeCmd: undefined })).toBe(false)
  })
  it('never probes an unlanded mission — the probe would grade the base, not the work', () => {
    expect(shouldProbe({ ...base, landed: false })).toBe(false)
  })
  it('never probes a dead harness — engine_error and engine_gone cannot continue', () => {
    expect(shouldProbe({ ...base, exitReason: 'engine_error' })).toBe(false)
    expect(shouldProbe({ ...base, exitReason: 'engine_gone' })).toBe(false)
  })
})

describe('overrideDecision', () => {
  const base = { verified: false, overridesUsed: 0, maxOverrides: 3, socketOpen: true }
  it('injects on FAIL with budget and a live socket', () => {
    expect(overrideDecision(base)).toEqual({ inject: true, why: 'probe FAIL — overriding the exit (1/3)' })
  })
  it('never injects on PASS', () => {
    expect(overrideDecision({ ...base, verified: true }).inject).toBe(false)
  })
  it('never injects on UNMEASURED — a probe that said nothing overrides nothing', () => {
    const d = overrideDecision({ ...base, verified: null })
    expect(d.inject).toBe(false)
    expect(d.why).toMatch(/UNMEASURED/)
  })
  it('stops at the override budget and says exhausted', () => {
    const d = overrideDecision({ ...base, overridesUsed: 3 })
    expect(d.inject).toBe(false)
    expect(d.why).toMatch(/exhausted/)
  })
  it('cannot inject over a closed socket and says so', () => {
    const d = overrideDecision({ ...base, socketOpen: false })
    expect(d.inject).toBe(false)
    expect(d.why).toMatch(/socket/)
  })
})

describe('probeMessage', () => {
  it('quotes the probe verbatim — sha, exit code, tail', () => {
    const msg = probeMessage({ sha: 'abc1234', exitCode: 1, timedOut: false, spawnFailed: false, outputTail: '2 failed, 40 passed' })
    expect(msg).toContain('[PROBE]')
    expect(msg).toContain('abc1234')
    expect(msg).toContain('exit=1')
    expect(msg).toContain('2 failed, 40 passed')
    expect(msg).toContain('NOT done')
  })
  it('names a timeout instead of inventing an exit code', () => {
    const msg = probeMessage({ sha: 'abc1234', exitCode: null, timedOut: true, spawnFailed: false, outputTail: '' })
    expect(msg).toContain('TIMED OUT')
  })
})
