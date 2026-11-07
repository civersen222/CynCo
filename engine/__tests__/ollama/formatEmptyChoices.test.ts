import { describe, it, expect } from 'vitest'
import { fromOpenAIResponse } from '../../ollama/format.js'

/**
 * A response with no choices returned a usage block keyed `inputTokens` /
 * `outputTokens` while `TokenUsage` is `input_tokens` / `output_tokens`, with
 * no `id` and a `stopReason` key nobody reads. Found by the strict type-check
 * (A1). The empty response must come back in the one shape every consumer
 * expects.
 */
describe('fromOpenAIResponse with no choices', () => {
  it('returns a well-formed empty completion', () => {
    const r = fromOpenAIResponse({ id: 'x', model: 'm', choices: [] } as any)
    expect(r.content).toEqual([])
    expect(r.model).toBe('m')
    expect(r.usage.input_tokens).toBe(0)
    expect(r.usage.output_tokens).toBe(0)
    expect(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence']).toContain(r.stop_reason)
    expect((r as any).stopReason).toBeUndefined()
  })
})
