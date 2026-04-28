import { describe, expect, it } from 'bun:test'
import {
  buildAgentPrompt,
  validatePersona,
  AGENT_PERSONAS,
  type PersonaConfig,
} from '../../agents/prism.js'

// ─── buildAgentPrompt ─────────────────────────────────────────

describe('buildAgentPrompt', () => {
  it('puts role statement at the top of the prompt', () => {
    const persona: PersonaConfig = {
      role: 'software engineer',
      focus: 'codebase exploration',
    }
    const result = buildAgentPrompt(persona, 'Find all dead code.')
    const lines = result.split('\n')
    // First non-empty line should contain the role
    const firstLine = lines.find(l => l.trim().length > 0)
    expect(firstLine).toContain('software engineer')
    expect(firstLine).toContain('codebase exploration')
  })

  it('puts task instruction at the end of the prompt', () => {
    const persona: PersonaConfig = {
      role: 'software engineer',
      focus: 'testing',
    }
    const task = 'Write unit tests for the auth module.'
    const result = buildAgentPrompt(persona, task)
    // Task should appear after the role
    const roleIndex = result.indexOf('software engineer')
    const taskIndex = result.indexOf(task)
    expect(taskIndex).toBeGreaterThan(roleIndex)
    // Task should be at the end
    const afterTask = result.slice(taskIndex + task.length).trim()
    expect(afterTask).toBe('')
  })

  it('includes constraints when provided', () => {
    const persona: PersonaConfig = {
      role: 'software engineer',
      focus: 'implementation',
      constraints: ['Do not modify test files', 'Use TDD approach'],
    }
    const result = buildAgentPrompt(persona, 'Implement the feature.')
    expect(result).toContain('Do not modify test files')
    expect(result).toContain('Use TDD approach')
  })

  it('works without constraints', () => {
    const persona: PersonaConfig = {
      role: 'technical researcher',
      focus: 'API research',
    }
    const result = buildAgentPrompt(persona, 'Research the new API.')
    expect(result).toContain('technical researcher')
    expect(result).toContain('Research the new API.')
  })

  it('constraints appear between role and task', () => {
    const persona: PersonaConfig = {
      role: 'software architect',
      focus: 'system design',
      constraints: ['Consider scalability'],
    }
    const task = 'Design the caching layer.'
    const result = buildAgentPrompt(persona, task)
    const roleIndex = result.indexOf('software architect')
    const constraintIndex = result.indexOf('Consider scalability')
    const taskIndex = result.indexOf(task)
    expect(constraintIndex).toBeGreaterThan(roleIndex)
    expect(taskIndex).toBeGreaterThan(constraintIndex)
  })
})

// ─── validatePersona ──────────────────────────────────────────

describe('validatePersona', () => {
  it('valid persona passes validation', () => {
    const persona: PersonaConfig = {
      role: 'software engineer',
      focus: 'testing',
    }
    const result = validatePersona(persona)
    expect(result.valid).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('flags superlative "best"', () => {
    const persona: PersonaConfig = {
      role: 'the best software engineer',
      focus: 'testing',
    }
    const result = validatePersona(persona)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.toLowerCase().includes('superlative'))).toBe(true)
  })

  it('flags superlative "expert"', () => {
    const persona: PersonaConfig = {
      role: 'expert software engineer',
      focus: 'testing',
    }
    const result = validatePersona(persona)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.toLowerCase().includes('superlative'))).toBe(true)
  })

  it('flags superlative "world"', () => {
    const persona: PersonaConfig = {
      role: "world's leading architect",
      focus: 'design',
    }
    const result = validatePersona(persona)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.toLowerCase().includes('superlative'))).toBe(true)
  })

  it('flags roles over 50 tokens', () => {
    // A very long role string that exceeds 50 whitespace-separated tokens
    const longRole = Array.from({ length: 55 }, (_, i) => `word${i}`).join(' ')
    const persona: PersonaConfig = {
      role: longRole,
      focus: 'testing',
    }
    const result = validatePersona(persona)
    expect(result.valid).toBe(false)
    expect(result.issues.some(i => i.toLowerCase().includes('token'))).toBe(true)
  })

  it('accepts a role at exactly 50 tokens', () => {
    const role50 = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')
    const persona: PersonaConfig = {
      role: role50,
      focus: 'testing',
    }
    const result = validatePersona(persona)
    // Should not have a token-count issue
    expect(result.issues.some(i => i.toLowerCase().includes('token'))).toBe(false)
  })

  it('can flag multiple issues at once', () => {
    const longRole = 'the best ' + Array.from({ length: 55 }, (_, i) => `w${i}`).join(' ')
    const persona: PersonaConfig = {
      role: longRole,
      focus: 'testing',
    }
    const result = validatePersona(persona)
    expect(result.valid).toBe(false)
    expect(result.issues.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── AGENT_PERSONAS ───────────────────────────────────────────

describe('AGENT_PERSONAS', () => {
  const expectedAgentTypes = ['scout', 'oracle', 'kraken', 'spark', 'architect']

  it('defines all expected agent types', () => {
    for (const agentType of expectedAgentTypes) {
      expect(AGENT_PERSONAS[agentType]).toBeDefined()
    }
  })

  it('all personas pass validation', () => {
    for (const agentType of expectedAgentTypes) {
      const persona = AGENT_PERSONAS[agentType]!
      const result = validatePersona(persona)
      expect(result.valid).toBe(true)
      if (result.issues.length > 0) {
        throw new Error(
          `Persona '${agentType}' failed validation: ${result.issues.join(', ')}`,
        )
      }
    }
  })

  it('each persona has a non-empty role and focus', () => {
    for (const agentType of expectedAgentTypes) {
      const persona = AGENT_PERSONAS[agentType]!
      expect(persona.role.length).toBeGreaterThan(0)
      expect(persona.focus.length).toBeGreaterThan(0)
    }
  })
})
