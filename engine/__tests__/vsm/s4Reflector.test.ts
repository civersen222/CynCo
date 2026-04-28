import { describe, it, expect, beforeEach } from 'bun:test'
import { S4Reflector, type ReflectionScores } from '../../vsm/s4Reflector.js'

describe('S4Reflector', () => {
  it('starts with X=8', () => {
    const r = new S4Reflector()
    expect(r.getFrequency()).toBe(8)
  })

  it('reports shouldReflect=true when turn count reaches X', () => {
    const r = new S4Reflector()
    for (let i = 0; i < 7; i++) expect(r.shouldReflect(i + 1)).toBe(false)
    expect(r.shouldReflect(8)).toBe(true)
  })

  it('computes composite score from 4 scores', () => {
    const r = new S4Reflector()
    const scores: ReflectionScores = { progress: 8, confidence: 7, toolQuality: 9, stuckness: 2 }
    const composite = r.recordScores(scores)
    expect(composite).toBeCloseTo(8.0, 1)
  })

  it('signals pain when composite below 4', () => {
    const r = new S4Reflector()
    r.recordScores({ progress: 2, confidence: 1, toolQuality: 2, stuckness: 9 })
    expect(r.getLastSignal()).toBe('pain')
  })

  it('signals pleasure when composite above 7', () => {
    const r = new S4Reflector()
    r.recordScores({ progress: 9, confidence: 8, toolQuality: 9, stuckness: 1 })
    expect(r.getLastSignal()).toBe('pleasure')
  })

  it('signals neutral for mid-range scores', () => {
    const r = new S4Reflector()
    r.recordScores({ progress: 5, confidence: 5, toolQuality: 5, stuckness: 5 })
    expect(r.getLastSignal()).toBe('neutral')
  })

  it('increases X when scores are stable (low variance)', () => {
    const r = new S4Reflector()
    r.recordScores({ progress: 7, confidence: 7, toolQuality: 7, stuckness: 3 })
    r.recordScores({ progress: 7, confidence: 7, toolQuality: 7, stuckness: 3 })
    r.recordScores({ progress: 7, confidence: 7, toolQuality: 7, stuckness: 3 })
    expect(r.getFrequency()).toBe(9)
  })

  it('decreases X when scores are volatile (high variance)', () => {
    const r = new S4Reflector()
    r.recordScores({ progress: 2, confidence: 2, toolQuality: 2, stuckness: 9 })
    r.recordScores({ progress: 9, confidence: 9, toolQuality: 9, stuckness: 1 })
    r.recordScores({ progress: 2, confidence: 2, toolQuality: 2, stuckness: 9 })
    expect(r.getFrequency()).toBe(7)
  })

  it('clamps X to bounds [3, 15]', () => {
    const r = new S4Reflector(3)
    r.recordScores({ progress: 2, confidence: 2, toolQuality: 2, stuckness: 8 })
    r.recordScores({ progress: 2, confidence: 2, toolQuality: 2, stuckness: 8 })
    r.recordScores({ progress: 2, confidence: 2, toolQuality: 2, stuckness: 8 })
    expect(r.getFrequency()).toBeGreaterThanOrEqual(3)
  })

  it('detects stuck trigger from high stuckness score', () => {
    const r = new S4Reflector()
    r.recordScores({ progress: 5, confidence: 5, toolQuality: 5, stuckness: 8 })
    expect(r.shouldTriggerPerturbation()).toBe(true)
  })

  it('detects suppress-governance from high progress+confidence', () => {
    const r = new S4Reflector()
    r.recordScores({ progress: 9, confidence: 9, toolQuality: 8, stuckness: 1 })
    expect(r.shouldSuppressSignals()).toBe(true)
  })

  it('builds the self-report prompt', () => {
    const r = new S4Reflector()
    const prompt = r.getReflectionPrompt()
    expect(prompt).toContain('Progress')
    expect(prompt).toContain('0-10') // scores are in the range description
  })

  it('parses model response into scores', () => {
    const r = new S4Reflector()
    const scores = r.parseResponse('1. 7\n2. 6\n3. 8\n4. 3\nThings are going well.')
    expect(scores).toEqual({ progress: 7, confidence: 6, toolQuality: 8, stuckness: 3 })
  })

  it('handles malformed model response gracefully', () => {
    const r = new S4Reflector()
    const scores = r.parseResponse('I am doing great!')
    expect(scores).toEqual({ progress: 5, confidence: 5, toolQuality: 5, stuckness: 5 })
  })
})

describe('deriveFromMetrics', () => {
  let reflector: S4Reflector

  beforeEach(() => {
    reflector = new S4Reflector()
  })

  it('derives high stuckness from high stuck count', () => {
    const scores = reflector.deriveFromMetrics({ stuckTurns: 8, toolSuccessRate: 0.9, contextUtilization: 0.3 })
    expect(scores.stuckness).toBeGreaterThanOrEqual(7)
  })

  it('derives low progress from high stuck count', () => {
    const scores = reflector.deriveFromMetrics({ stuckTurns: 5, toolSuccessRate: 0.3, contextUtilization: 0.3 })
    expect(scores.progress).toBeLessThanOrEqual(4)
  })

  it('derives high confidence from good metrics', () => {
    const scores = reflector.deriveFromMetrics({ stuckTurns: 0, toolSuccessRate: 1.0, contextUtilization: 0.2 })
    expect(scores.confidence).toBeGreaterThanOrEqual(7)
  })
})

describe('parseResponse robustness', () => {
  let reflector: S4Reflector

  beforeEach(() => {
    reflector = new S4Reflector()
  })

  it('parses "Progress = 7"', () => {
    const scores = reflector.parseResponse('Progress = 7\nConfidence = 6\nQuality = 8\nStuckness = 2')
    expect(scores.progress).toBe(7)
    expect(scores.confidence).toBe(6)
  })

  it('parses em dash separator', () => {
    const scores = reflector.parseResponse('Progress\u20147\nConfidence\u20146\nQuality\u20148\nStuckness\u20142')
    expect(scores.progress).toBe(7)
  })

  it('parses "Progress: 7/10"', () => {
    const scores = reflector.parseResponse('Progress: 7/10\nConfidence: 6/10\nQuality: 8/10\nStuckness: 2/10')
    expect(scores.progress).toBe(7)
    expect(scores.confidence).toBe(6)
  })

  it('parses "progress 7" (no separator)', () => {
    const scores = reflector.parseResponse('progress 7\nconfidence 6\nquality 8\nstuckness 2')
    expect(scores.progress).toBe(7)
  })

  it('parses "Tool Quality: 8"', () => {
    const scores = reflector.parseResponse('Progress: 7\nConfidence: 6\nTool Quality: 8\nStuckness: 2')
    expect(scores.toolQuality).toBe(8)
  })
})
