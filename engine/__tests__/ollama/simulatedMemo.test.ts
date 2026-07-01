// engine/__tests__/ollama/simulatedMemo.test.ts
import { describe, expect, it } from 'bun:test'
import { buildSimulatedToolPrompt } from '../../ollama/simulated.js'

const toolA = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
} as any
const toolB = {
  name: 'run_shell',
  description: 'Run a command',
  input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
} as any

describe('buildSimulatedToolPrompt memoization', () => {
  it('returns the identical string instance for an unchanged tool set', () => {
    const p1 = buildSimulatedToolPrompt([toolA, toolB])
    const p2 = buildSimulatedToolPrompt([toolA, toolB])
    expect(p1).toBe(p2) // reference identity — byte-identical prefix guaranteed
  })

  it('rebuilds when the tool set changes, then re-caches', () => {
    const p1 = buildSimulatedToolPrompt([toolA, toolB])
    const p2 = buildSimulatedToolPrompt([toolA])
    expect(p2).not.toBe(p1)
    expect(p2).toContain('read_file')
    expect(p2).not.toContain('run_shell')
    const p3 = buildSimulatedToolPrompt([toolA])
    expect(p3).toBe(p2)
  })
})
