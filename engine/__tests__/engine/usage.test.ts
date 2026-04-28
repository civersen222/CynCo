import { describe, expect, it } from 'bun:test'
import {
  updateUsage,
  accumulateUsage,
  EMPTY_USAGE,
  type NonNullableUsage,
} from '../../engine/usage.js'

// ─── Helpers ────────────────────────────────────────────────────

/** Create a usage object with known non-zero values for testing. */
function makeUsage(overrides?: Partial<NonNullableUsage>): NonNullableUsage {
  return {
    input_tokens: 100,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 25,
    output_tokens: 200,
    server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5 },
    inference_geo: 'us-east-1',
    iterations: [],
    speed: 'standard',
    ...overrides,
  }
}

// ─── EMPTY_USAGE ────────────────────────────────────────────────

describe('EMPTY_USAGE', () => {
  it('has all numeric fields set to 0', () => {
    expect(EMPTY_USAGE.input_tokens).toBe(0)
    expect(EMPTY_USAGE.cache_creation_input_tokens).toBe(0)
    expect(EMPTY_USAGE.cache_read_input_tokens).toBe(0)
    expect(EMPTY_USAGE.output_tokens).toBe(0)
    expect(EMPTY_USAGE.server_tool_use.web_search_requests).toBe(0)
    expect(EMPTY_USAGE.server_tool_use.web_fetch_requests).toBe(0)
    expect(EMPTY_USAGE.cache_creation.ephemeral_1h_input_tokens).toBe(0)
    expect(EMPTY_USAGE.cache_creation.ephemeral_5m_input_tokens).toBe(0)
  })

  it('has expected default string values', () => {
    expect(EMPTY_USAGE.service_tier).toBe('standard')
    expect(EMPTY_USAGE.inference_geo).toBe('')
    expect(EMPTY_USAGE.speed).toBe('standard')
    expect(EMPTY_USAGE.iterations).toEqual([])
  })
})

// ─── updateUsage ────────────────────────────────────────────────

describe('updateUsage', () => {
  it('returns a copy when partUsage is undefined', () => {
    const usage = makeUsage()
    const result = updateUsage(usage, undefined)
    expect(result).toEqual(usage)
    // Must be a new object, not the same reference
    expect(result).not.toBe(usage)
  })

  it('overwrites output_tokens unconditionally via ?? fallback', () => {
    const usage = makeUsage({ output_tokens: 200 })
    const result = updateUsage(usage, { output_tokens: 0 })
    // output_tokens uses ?? so 0 (not null/undefined) IS taken
    expect(result.output_tokens).toBe(0)
  })

  it('does NOT overwrite input_tokens when delta is 0', () => {
    const usage = makeUsage({ input_tokens: 100 })
    const result = updateUsage(usage, { input_tokens: 0 })
    // Critical invariant: message_delta sends 0, must not clobber real value
    expect(result.input_tokens).toBe(100)
  })

  it('does NOT overwrite input_tokens when delta is null/undefined', () => {
    const usage = makeUsage({ input_tokens: 100 })
    const resultNull = updateUsage(usage, { input_tokens: null as unknown as number })
    expect(resultNull.input_tokens).toBe(100)

    const resultUndefined = updateUsage(usage, {})
    expect(resultUndefined.input_tokens).toBe(100)
  })

  it('DOES overwrite input_tokens when delta > 0', () => {
    const usage = makeUsage({ input_tokens: 100 })
    const result = updateUsage(usage, { input_tokens: 500 })
    expect(result.input_tokens).toBe(500)
  })

  it('applies same > 0 guard for cache_creation_input_tokens', () => {
    const usage = makeUsage({ cache_creation_input_tokens: 50 })
    // delta = 0 should NOT overwrite
    expect(updateUsage(usage, { cache_creation_input_tokens: 0 }).cache_creation_input_tokens).toBe(50)
    // delta > 0 SHOULD overwrite
    expect(updateUsage(usage, { cache_creation_input_tokens: 99 }).cache_creation_input_tokens).toBe(99)
  })

  it('applies same > 0 guard for cache_read_input_tokens', () => {
    const usage = makeUsage({ cache_read_input_tokens: 25 })
    // delta = 0 should NOT overwrite
    expect(updateUsage(usage, { cache_read_input_tokens: 0 }).cache_read_input_tokens).toBe(25)
    // delta > 0 SHOULD overwrite
    expect(updateUsage(usage, { cache_read_input_tokens: 77 }).cache_read_input_tokens).toBe(77)
  })

  it('preserves service_tier from original usage (not from delta)', () => {
    const usage = makeUsage({ service_tier: 'priority' })
    const result = updateUsage(usage, { service_tier: 'standard' } as Partial<NonNullableUsage>)
    expect(result.service_tier).toBe('priority')
  })

  it('preserves inference_geo from original usage (not from delta)', () => {
    const usage = makeUsage({ inference_geo: 'us-west-2' })
    const result = updateUsage(usage, { inference_geo: 'eu-west-1' } as Partial<NonNullableUsage>)
    expect(result.inference_geo).toBe('us-west-2')
  })

  it('takes iterations from partUsage via ?? fallback', () => {
    const usage = makeUsage({ iterations: ['a'] as unknown[] })
    // When provided, takes from delta
    const result = updateUsage(usage, { iterations: ['b', 'c'] as unknown[] })
    expect(result.iterations).toEqual(['b', 'c'])
    // When not provided (undefined), keeps original
    const result2 = updateUsage(usage, {})
    expect(result2.iterations).toEqual(['a'])
  })

  it('takes speed from partUsage via ?? fallback', () => {
    const usage = makeUsage({ speed: 'standard' })
    const result = updateUsage(usage, { speed: 'fast' })
    expect(result.speed).toBe('fast')
    // When not provided, keeps original
    const result2 = updateUsage(usage, {})
    expect(result2.speed).toBe('standard')
  })

  it('takes server_tool_use fields from partUsage via ?? fallback', () => {
    const usage = makeUsage({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 4 } })
    const result = updateUsage(usage, {
      server_tool_use: { web_search_requests: 5, web_fetch_requests: 6 },
    })
    expect(result.server_tool_use).toEqual({ web_search_requests: 5, web_fetch_requests: 6 })
  })

  it('takes cache_creation fields from partUsage via ?? fallback', () => {
    const usage = makeUsage({
      cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5 },
    })
    const result = updateUsage(usage, {
      cache_creation: { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 15 },
    })
    expect(result.cache_creation).toEqual({ ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 15 })
  })
})

// ─── accumulateUsage ────────────────────────────────────────────

describe('accumulateUsage', () => {
  it('sums all numeric token fields', () => {
    const total = makeUsage({
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
      output_tokens: 200,
    })
    const message = makeUsage({
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
      output_tokens: 20,
    })
    const result = accumulateUsage(total, message)
    expect(result.input_tokens).toBe(110)
    expect(result.cache_creation_input_tokens).toBe(55)
    expect(result.cache_read_input_tokens).toBe(28)
    expect(result.output_tokens).toBe(220)
  })

  it('takes service_tier from messageUsage (most recent)', () => {
    const total = makeUsage({ service_tier: 'standard' })
    const message = makeUsage({ service_tier: 'priority' })
    const result = accumulateUsage(total, message)
    expect(result.service_tier).toBe('priority')
  })

  it('takes inference_geo from messageUsage (most recent)', () => {
    const total = makeUsage({ inference_geo: 'us-east-1' })
    const message = makeUsage({ inference_geo: 'eu-west-1' })
    const result = accumulateUsage(total, message)
    expect(result.inference_geo).toBe('eu-west-1')
  })

  it('sums server_tool_use fields', () => {
    const total = makeUsage({
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 4 },
    })
    const message = makeUsage({
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
    })
    const result = accumulateUsage(total, message)
    expect(result.server_tool_use).toEqual({ web_search_requests: 4, web_fetch_requests: 6 })
  })

  it('sums cache_creation fields', () => {
    const total = makeUsage({
      cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5 },
    })
    const message = makeUsage({
      cache_creation: { ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 3 },
    })
    const result = accumulateUsage(total, message)
    expect(result.cache_creation).toEqual({
      ephemeral_1h_input_tokens: 17,
      ephemeral_5m_input_tokens: 8,
    })
  })

  it('takes iterations from messageUsage (most recent)', () => {
    const total = makeUsage({ iterations: ['a'] as unknown[] })
    const message = makeUsage({ iterations: ['b', 'c'] as unknown[] })
    const result = accumulateUsage(total, message)
    expect(result.iterations).toEqual(['b', 'c'])
  })

  it('takes speed from messageUsage (most recent)', () => {
    const total = makeUsage({ speed: 'standard' })
    const message = makeUsage({ speed: 'fast' })
    const result = accumulateUsage(total, message)
    expect(result.speed).toBe('fast')
  })
})
