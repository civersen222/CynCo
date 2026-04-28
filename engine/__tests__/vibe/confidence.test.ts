import { describe, expect, it } from 'bun:test'
import { classifyDifficulty, ConfidenceScorer } from '../../vibe/confidence.js'

describe('classifyDifficulty', () => {
  it('classifies trivial tasks', () => {
    expect(classifyDifficulty('make button blue')).toBe('trivial')
    expect(classifyDifficulty('change the text color')).toBe('trivial')
  })

  it('classifies simple tasks', () => {
    expect(classifyDifficulty('add settings page')).toBe('simple')
    expect(classifyDifficulty('create a new component')).toBe('simple')
  })

  it('classifies medium tasks', () => {
    expect(classifyDifficulty('build inventory system with items and equipment')).toBe('medium')
  })

  it('classifies complex tasks', () => {
    expect(classifyDifficulty('multiplayer real-time combat with matchmaking and leaderboards')).toBe('complex')
  })

  it('classifies massive tasks', () => {
    expect(classifyDifficulty('complete app like Uber with payments maps driver matching ratings notifications')).toBe('massive')
  })
})

describe('ConfidenceScorer', () => {
  it('starts with all dimensions at 0', () => {
    const scorer = new ConfidenceScorer('medium')
    const state = scorer.getState()
    expect(state.purpose).toBe(0)
    expect(state.mechanics).toBe(0)
    expect(state.integration).toBe(0)
    expect(state.ambiguity).toBe(0)
  })

  it('updates individual dimensions', () => {
    const scorer = new ConfidenceScorer('medium')
    scorer.update('purpose', 80, 'user described goal')
    expect(scorer.get('purpose')).toBe(80)
    expect(scorer.get('mechanics')).toBe(0)
  })

  it('clamps values to 0-100', () => {
    const scorer = new ConfidenceScorer('simple')
    scorer.update('purpose', 150, 'over max')
    expect(scorer.get('purpose')).toBe(100)
    scorer.update('purpose', -10, 'under min')
    expect(scorer.get('purpose')).toBe(0)
  })

  it('reports overall as minimum of all dimensions', () => {
    const scorer = new ConfidenceScorer('medium')
    scorer.update('purpose', 90, 'clear')
    scorer.update('mechanics', 70, 'understood')
    scorer.update('integration', 80, 'mapped')
    scorer.update('ambiguity', 60, 'some unknowns')
    expect(scorer.overall()).toBe(60)
  })

  it('isReady when all dimensions meet threshold', () => {
    const scorer = new ConfidenceScorer('medium') // threshold 65
    scorer.update('purpose', 70, 'ok')
    scorer.update('mechanics', 70, 'ok')
    scorer.update('integration', 70, 'ok')
    scorer.update('ambiguity', 70, 'ok')
    expect(scorer.isReady()).toBe(true)
  })

  it('is not ready when any dimension is below threshold', () => {
    const scorer = new ConfidenceScorer('medium') // threshold 65
    scorer.update('purpose', 70, 'ok')
    scorer.update('mechanics', 70, 'ok')
    scorer.update('integration', 70, 'ok')
    scorer.update('ambiguity', 50, 'too low')
    expect(scorer.isReady()).toBe(false)
  })

  it('returns lowest dimension in status', () => {
    const scorer = new ConfidenceScorer('simple')
    scorer.update('purpose', 90, 'clear')
    scorer.update('mechanics', 40, 'unclear how')
    scorer.update('integration', 80, 'mapped')
    scorer.update('ambiguity', 60, 'some unknowns')
    const st = scorer.status()
    expect(st.lowest).toBe('mechanics')
    expect(st.reason).toBe('unclear how')
    expect(st.overall).toBe(40)
    expect(st.ready).toBe(false)
  })

  it('getState returns a copy', () => {
    const scorer = new ConfidenceScorer('trivial')
    scorer.update('purpose', 50, 'half')
    const state = scorer.getState()
    state.purpose = 999
    expect(scorer.get('purpose')).toBe(50)
  })
})
