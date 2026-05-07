import { describe, it, expect } from 'bun:test'
import { makeSubAgentConfig, type AgentPersona } from '../../agents/types.js'
import { AGENT_PERSONAS, validatePersona } from '../../agents/prism.js'
import { getVocabulary } from '../../agents/vocabulary.js'

describe('Researcher agent', () => {
  it('researcher is a valid AgentPersona', () => {
    const persona: AgentPersona = 'researcher'
    expect(persona).toBe('researcher')
  })
  it('makeSubAgentConfig gives researcher specialist tools', () => {
    const config = makeSubAgentConfig({
      task: 'Research WebSocket patterns',
      persona: 'researcher',
      trustTier: 'specialist',
    })
    expect(config.trustTier).toBe('specialist')
    expect(config.policyConstraints.allowedTools).toContain('WebSearch')
    expect(config.policyConstraints.allowedTools).toContain('WebFetch')
    expect(config.policyConstraints.allowedTools).toContain('Read')
    expect(config.policyConstraints.maxIterations).toBe(25)
    expect(config.policyConstraints.maxTokenBudget).toBe(16384)
  })
  it('readonly tier still gets only READONLY_TOOLS', () => {
    const config = makeSubAgentConfig({
      task: 'Explore codebase',
      persona: 'scout',
    })
    expect(config.policyConstraints.allowedTools).not.toContain('WebSearch')
    expect(config.policyConstraints.allowedTools).not.toContain('WebFetch')
  })
  it('researcher persona passes PRISM validation', () => {
    const persona = AGENT_PERSONAS['researcher']
    expect(persona).toBeDefined()
    const { valid, issues } = validatePersona(persona)
    expect(valid).toBe(true)
    expect(issues).toEqual([])
  })
  it('researcher has vocabulary', () => {
    const vocab = getVocabulary('researcher')
    expect(vocab).toBeDefined()
    expect(vocab!.agentType).toBe('researcher')
    expect(vocab!.clusters.length).toBeGreaterThanOrEqual(3)
  })
  it('researcher vocabulary has source evaluation terms', () => {
    const vocab = getVocabulary('researcher')!
    const sourceCluster = vocab.clusters.find(c => c.name === 'source evaluation')
    expect(sourceCluster).toBeDefined()
    expect(sourceCluster!.terms).toContain('peer-reviewed')
    expect(sourceCluster!.terms).toContain('citation')
  })
})
