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
})
