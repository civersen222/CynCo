import { describe, it, expect } from 'bun:test'
import { HuggingFaceEngine } from '../../../research/engines/huggingface.js'

describe('HuggingFaceEngine', () => {
  it('has correct metadata', () => {
    const engine = new HuggingFaceEngine()
    expect(engine.name).toBe('huggingface')
    expect(engine.domains).toContain('models')
    expect(engine.domains).toContain('ai')
  })

  it('parses model response', () => {
    const engine = new HuggingFaceEngine()
    const data = [
      {
        modelId: 'org/model-name',
        pipeline_tag: 'text-generation',
        downloads: 123456,
        likes: 42,
        tags: ['transformers', 'pytorch', 'text-generation'],
        lastModified: '2026-01-15T00:00:00Z',
      },
    ]
    const results = engine.parseResponse(data)
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('org/model-name')
    expect(results[0].url).toBe('https://huggingface.co/org/model-name')
    expect(results[0].source).toBe('huggingface')
    expect(results[0].snippet).toContain('123,456')
    expect(results[0].snippet).toContain('text-generation')
    expect(results[0].metadata?.stars).toBe(42)
  })

  it('handles empty array', () => {
    const engine = new HuggingFaceEngine()
    expect(engine.parseResponse([])).toEqual([])
  })

  it('handles non-array input', () => {
    const engine = new HuggingFaceEngine()
    expect(engine.parseResponse(null)).toEqual([])
    expect(engine.parseResponse({})).toEqual([])
  })
})
