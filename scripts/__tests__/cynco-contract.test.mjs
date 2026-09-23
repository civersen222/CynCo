// scripts/cynco-contract.mjs had no dedicated test file — every function in it
// was exercised only indirectly, through scripts/cynco-mission-driver.mjs
// (untestable: it opens a WebSocket at import time) or through
// scripts/__tests__/cynco-brief.test.mjs's single `sidecarFor` describe block.
//
// This file is the direct one for `toAssertion`'s role round-trip (Task 5,
// 2b-i): a withheld sidecar assertion may now carry `role: 'keep-green'`, and
// nothing else — the same discipline every other field here follows (F34's
// `refuse(file, ...)` style, checked at dispatch where a person is watching).
import { describe, it, expect } from 'vitest'
import { toAssertion } from '../cynco-contract.mjs'

describe('toAssertion — role round-trips through a withheld command', () => {
  it('passes role: keep-green through unchanged', () => {
    const a = toAssertion({ text: 'The KEEP-GREEN set passes.', command: 'pytest -q', role: 'keep-green' }, 'sidecar.json')
    expect(a).toEqual({ text: 'The KEEP-GREEN set passes.', command: 'pytest -q', role: 'keep-green' })
  })

  it('an entry with no role carries none — the field stays absent, not undefined-but-present', () => {
    const a = toAssertion({ text: 'plain check', command: 'pytest -q' }, 'sidecar.json')
    expect(a).toEqual({ text: 'plain check', command: 'pytest -q' })
    expect('role' in a).toBe(false)
  })

  it('role survives alongside an explicit timeoutMs', () => {
    const a = toAssertion({ text: 'slow gate', command: 'pytest -q', timeoutMs: 60000, role: 'keep-green' }, 'sidecar.json')
    expect(a).toEqual({ text: 'slow gate', command: 'pytest -q', timeoutMs: 60000, role: 'keep-green' })
  })

  it('refuses any role other than keep-green', () => {
    expect(() => toAssertion({ text: 'x', command: 'pytest -q', role: 'other' }, 'sidecar.json'))
      .toThrow(/keep-green/)
  })

  it('the refusal names the sidecar file, matching every other refuse() message', () => {
    expect(() => toAssertion({ text: 'x', command: 'pytest -q', role: 'bogus' }, 'wave3.contract.json'))
      .toThrow(/wave3\.contract\.json/)
  })

  it('a plain-sentence assertion (no object at all) is unaffected — no role is possible on a string', () => {
    expect(toAssertion('File a.py was modified (git diff shows changes)', 'sidecar.json'))
      .toBe('File a.py was modified (git diff shows changes)')
  })
})
