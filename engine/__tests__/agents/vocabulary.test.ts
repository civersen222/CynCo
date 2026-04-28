import { describe, expect, it } from 'bun:test'
import {
  getVocabulary,
  formatVocabularyPrompt,
  type VocabularyPayload,
} from '../../agents/vocabulary.js'

// ─── getVocabulary ────────────────────────────────────────────

describe('getVocabulary', () => {
  const knownAgentTypes = ['scout', 'oracle', 'kraken', 'spark', 'architect']

  it('returns a payload for each known agent type', () => {
    for (const agentType of knownAgentTypes) {
      const payload = getVocabulary(agentType)
      expect(payload).toBeDefined()
      expect(payload!.agentType).toBe(agentType)
    }
  })

  it('returns undefined for unknown agent types', () => {
    expect(getVocabulary('unknown-agent')).toBeUndefined()
    expect(getVocabulary('')).toBeUndefined()
    expect(getVocabulary('explorer')).toBeUndefined()
  })

  it('each vocabulary has 3-5 clusters', () => {
    for (const agentType of knownAgentTypes) {
      const payload = getVocabulary(agentType)
      expect(payload).toBeDefined()
      expect(payload!.clusters.length).toBeGreaterThanOrEqual(3)
      expect(payload!.clusters.length).toBeLessThanOrEqual(5)
    }
  })

  it('every cluster has a name and at least one term', () => {
    for (const agentType of knownAgentTypes) {
      const payload = getVocabulary(agentType)
      expect(payload).toBeDefined()
      for (const cluster of payload!.clusters) {
        expect(cluster.name).toBeTruthy()
        expect(cluster.terms.length).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('total terms per agent type are between 15 and 30', () => {
    for (const agentType of knownAgentTypes) {
      const payload = getVocabulary(agentType)
      expect(payload).toBeDefined()
      const totalTerms = payload!.clusters.reduce(
        (sum, c) => sum + c.terms.length,
        0,
      )
      expect(totalTerms).toBeGreaterThanOrEqual(15)
      expect(totalTerms).toBeLessThanOrEqual(30)
    }
  })

  it('no duplicate terms within a single agent vocabulary', () => {
    for (const agentType of knownAgentTypes) {
      const payload = getVocabulary(agentType)
      expect(payload).toBeDefined()
      const allTerms = payload!.clusters.flatMap(c => c.terms)
      const uniqueTerms = new Set(allTerms)
      expect(uniqueTerms.size).toBe(allTerms.length)
    }
  })
})

// ─── formatVocabularyPrompt ───────────────────────────────────

describe('formatVocabularyPrompt', () => {
  it('produces a non-empty string', () => {
    const payload: VocabularyPayload = {
      agentType: 'scout',
      clusters: [
        { name: 'graph', terms: ['call graph', 'dependency chain'] },
        { name: 'metrics', terms: ['cyclomatic complexity'] },
        { name: 'structure', terms: ['module boundary'] },
      ],
    }
    const result = formatVocabularyPrompt(payload)
    expect(result.length).toBeGreaterThan(0)
  })

  it('includes all terms from the payload', () => {
    const payload: VocabularyPayload = {
      agentType: 'test',
      clusters: [
        { name: 'a', terms: ['alpha', 'beta'] },
        { name: 'b', terms: ['gamma'] },
        { name: 'c', terms: ['delta'] },
      ],
    }
    const result = formatVocabularyPrompt(payload)
    expect(result).toContain('alpha')
    expect(result).toContain('beta')
    expect(result).toContain('gamma')
    expect(result).toContain('delta')
  })

  it('contains "Domain vocabulary" label', () => {
    const payload: VocabularyPayload = {
      agentType: 'test',
      clusters: [
        { name: 'a', terms: ['term1'] },
        { name: 'b', terms: ['term2'] },
        { name: 'c', terms: ['term3'] },
      ],
    }
    const result = formatVocabularyPrompt(payload)
    expect(result).toContain('Domain vocabulary')
  })
})
