import { describe, test, expect, beforeEach } from 'bun:test'
import { ReadLoopGate } from './readLoopGate.js'

describe('ReadLoopGate — redundancy', () => {
  let gate: ReadLoopGate
  beforeEach(() => { gate = new ReadLoopGate() })

  test('distinct reads always allow', () => {
    for (let n = 0; n < 10; n++) {
      expect(gate.evaluate('Read', { file_path: `/a/file${n}.ts` }).kind).toBe('allow')
    }
  })

  test('re-reading the same file warns once then denies', () => {
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('allow')
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('warn')
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('deny')
  })

  test('Grep signature: same pattern+path redundant, different pattern new', () => {
    expect(gate.evaluate('Grep', { pattern: 'foo', path: '/a' }).kind).toBe('allow')
    expect(gate.evaluate('Grep', { pattern: 'foo', path: '/a' }).kind).toBe('warn')
    expect(gate.evaluate('Grep', { pattern: 'bar', path: '/a' }).kind).toBe('allow')
  })

  test('onWrite re-arms the redundancy free pass', () => {
    gate.evaluate('Read', { file_path: '/a/x.ts' })          // allow (seen)
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('warn')
    gate.onWrite()
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('warn') // not deny
  })

  test('path normalization collapses ./foo and absolute foo', () => {
    const rel = gate.evaluate('Read', { file_path: './foo.ts' })
    expect(rel.kind).toBe('allow')
    const abs = gate.evaluate('Read', { file_path: `${process.cwd()}/foo.ts` })
    expect(abs.kind).toBe('warn') // same resolved path → redundant
  })

  test('non-read tools always allow', () => {
    expect(gate.evaluate('Bash', { command: 'ls' }).kind).toBe('allow')
    expect(gate.evaluate('Write', { file_path: '/a/x.ts' }).kind).toBe('allow')
  })

  test('warn-once is session-global: first redundant read warns, next redundant read of a different seen file denies', () => {
    expect(gate.evaluate('Read', { file_path: '/a/a.ts' }).kind).toBe('allow')
    expect(gate.evaluate('Read', { file_path: '/a/b.ts' }).kind).toBe('allow')
    expect(gate.evaluate('Read', { file_path: '/a/a.ts' }).kind).toBe('warn')  // first redundancy spends the free pass
    expect(gate.evaluate('Read', { file_path: '/a/b.ts' }).kind).toBe('deny')  // free pass gone, even though b was never warned
  })

  test('reset clears seen so a previously-seen file reads as allow again', () => {
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('allow')
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('warn')
    gate.reset()
    expect(gate.evaluate('Read', { file_path: '/a/x.ts' }).kind).toBe('allow')  // seen cleared
  })
})

describe('ReadLoopGate — stall backstop', () => {
  let gate: ReadLoopGate
  beforeEach(() => { gate = new ReadLoopGate() })

  test('20 distinct reads warns on the 20th, denies on the 21st', () => {
    for (let n = 0; n < 19; n++) {
      expect(gate.evaluate('Read', { file_path: `/a/f${n}.ts` }).kind).toBe('allow')
    }
    expect(gate.evaluate('Read', { file_path: '/a/f19.ts' }).kind).toBe('warn')  // 20th
    expect(gate.evaluate('Read', { file_path: '/a/f20.ts' }).kind).toBe('deny')  // 21st
  })

  test('a write resets the stall counter', () => {
    for (let n = 0; n < 10; n++) gate.evaluate('Read', { file_path: `/a/g${n}.ts` })
    gate.onWrite()
    for (let n = 10; n < 29; n++) {
      expect(gate.evaluate('Read', { file_path: `/a/g${n}.ts` }).kind).toBe('allow')
    }
    expect(gate.evaluate('Read', { file_path: '/a/g29.ts' }).kind).toBe('warn')  // 20th since write
  })

  test('a redundancy warn does not consume the stall free pass', () => {
    gate.evaluate('Read', { file_path: '/a/dup.ts' })                 // allow, seen
    expect(gate.evaluate('Read', { file_path: '/a/dup.ts' }).kind).toBe('warn') // redundancy warn
    // push to 20 distinct reads; the stall path must still get its own warn
    for (let n = 0; n < 17; n++) gate.evaluate('Read', { file_path: `/a/s${n}.ts` })
    // reads so far: dup(1) + dup(2) + 17 = 19 → next distinct is the 20th
    expect(gate.evaluate('Read', { file_path: '/a/s17.ts' }).kind).toBe('warn')  // stall warn
  })
})
