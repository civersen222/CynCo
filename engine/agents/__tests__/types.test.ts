import { describe, test, expect } from 'bun:test'
import {
  makeSubAgentConfig,
  makeS2Decision,
  type SubAgentConfig,
  type SubAgentStatus,
  type SubAgentResult,
  type S2Decision,
  type S2State,
} from '../types.js'

describe('makeSubAgentConfig', () => {
  test('creates valid config with readonly defaults', () => {
    const cfg = makeSubAgentConfig({ task: 'scan the codebase', persona: 'scout' })

    expect(cfg.task).toBe('scan the codebase')
    expect(cfg.persona).toBe('scout')
    expect(cfg.trustTier).toBe('readonly')
    expect(cfg.id).toMatch(/^scout-[a-f0-9]{6}$/)
    expect(cfg.policyConstraints.allowedTools).toEqual([
      'Read', 'Glob', 'Grep', 'CodeIndex', 'Ls', 'ImageView', 'Git',
    ])
    expect(cfg.policyConstraints.maxIterations).toBe(10)
    expect(cfg.policyConstraints.maxTokenBudget).toBe(8192)
    expect(cfg.parentContext).toBeUndefined()
    expect(cfg.policyConstraints.scopePaths).toBeUndefined()
  })

  test('creates valid config with specialist defaults', () => {
    const cfg = makeSubAgentConfig({ task: 'analyse dependencies', persona: 'oracle', trustTier: 'specialist' })

    expect(cfg.trustTier).toBe('specialist')
    expect(cfg.id).toMatch(/^oracle-[a-f0-9]{6}$/)
    expect(cfg.policyConstraints.maxIterations).toBe(25)
    expect(cfg.policyConstraints.maxTokenBudget).toBe(16384)
  })

  test('creates valid config with full defaults', () => {
    const cfg = makeSubAgentConfig({ task: 'refactor module', persona: 'kraken', trustTier: 'full' })

    expect(cfg.trustTier).toBe('full')
    expect(cfg.id).toMatch(/^kraken-[a-f0-9]{6}$/)
    expect(cfg.policyConstraints.maxIterations).toBe(50)
    expect(cfg.policyConstraints.maxTokenBudget).toBe(32768)
  })

  test('respects explicit maxIterations override', () => {
    const cfg = makeSubAgentConfig({ task: 'quick scan', persona: 'spark', maxIterations: 5 })
    expect(cfg.policyConstraints.maxIterations).toBe(5)
  })

  test('respects explicit maxTokenBudget override', () => {
    const cfg = makeSubAgentConfig({ task: 'quick scan', persona: 'spark', maxTokenBudget: 4096 })
    expect(cfg.policyConstraints.maxTokenBudget).toBe(4096)
  })

  test('respects explicit scopePaths override', () => {
    const cfg = makeSubAgentConfig({ task: 'check engine', persona: 'architect', scopePaths: ['engine/'] })
    expect(cfg.policyConstraints.scopePaths).toEqual(['engine/'])
  })

  test('respects explicit parentContext override', () => {
    const cfg = makeSubAgentConfig({ task: 'sub task', persona: 'scout', parentContext: 'session-abc' })
    expect(cfg.parentContext).toBe('session-abc')
  })

  test('generates unique IDs each call', () => {
    const a = makeSubAgentConfig({ task: 't', persona: 'scout' })
    const b = makeSubAgentConfig({ task: 't', persona: 'scout' })
    expect(a.id).not.toBe(b.id)
  })
})

describe('makeS2Decision', () => {
  test('creates valid decision with timestamp', () => {
    const before = Date.now()
    const decision = makeS2Decision({
      type: 'schedule',
      agentId: 'scout-abc123',
      input: { gpuUtil: 0.4, queueDepth: 2, fileLocks: [] },
      decision: 'run',
      reasoning: 'GPU is under 50%, queue is shallow',
    })
    const after = Date.now()

    expect(decision.timestamp).toBeGreaterThanOrEqual(before)
    expect(decision.timestamp).toBeLessThanOrEqual(after)
    expect(decision.type).toBe('schedule')
    expect(decision.agentId).toBe('scout-abc123')
    expect(decision.decision).toBe('run')
    expect(decision.reasoning).toBe('GPU is under 50%, queue is shallow')
    expect(decision.input.gpuUtil).toBe(0.4)
    expect(decision.input.fileLocks).toEqual([])
  })

  test('carries optional signal field', () => {
    const decision = makeS2Decision({
      type: 'algedonic',
      agentId: 'kraken-def456',
      input: { gpuUtil: 0.9, queueDepth: 5, fileLocks: ['engine/tools/executor.ts'], signal: 'STUCK' },
      decision: 'kill',
      reasoning: 'Agent stuck, GPU overloaded',
    })

    expect(decision.type).toBe('algedonic')
    expect(decision.decision).toBe('kill')
    expect(decision.input.signal).toBe('STUCK')
    expect(decision.input.fileLocks).toContain('engine/tools/executor.ts')
  })
})
