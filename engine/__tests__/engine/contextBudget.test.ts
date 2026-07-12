import { describe, expect, it } from 'bun:test'
import {
  estimateTokens,
  checkBudget,
  estimateTokensAsync,
  checkBudgetAsync,
  DEFAULT_BUDGET,
  type BudgetConfig,
  type BudgetCheck,
  type TokenCounter,
} from '../../engine/contextBudget.js'

// ─── estimateTokens ────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateTokens([])).toBe(0)
  })

  it('returns 0 for messages with no content', () => {
    expect(estimateTokens([{ content: undefined }, {}])).toBe(0)
  })

  it('counts text block characters divided by 4', () => {
    // "Hello world" = 11 chars => ceil(11/4) = 3
    const messages = [
      { content: [{ type: 'text', text: 'Hello world' }] },
    ]
    expect(estimateTokens(messages)).toBe(3)
  })

  it('counts tool input JSON length divided by 4', () => {
    // JSON.stringify({command:"ls"}) = '{"command":"ls"}' = 16 chars => ceil(16/4) = 4
    const input = { command: 'ls' }
    const messages = [
      { content: [{ type: 'tool_use', input }] },
    ]
    expect(estimateTokens(messages)).toBe(4)
  })

  it('handles string content blocks', () => {
    // "Hello" = 5 chars => ceil(5/4) = 2
    const messages = [
      { content: ['Hello'] },
    ]
    expect(estimateTokens(messages)).toBe(2)
  })

  it('rounds up to the nearest integer', () => {
    // "Hi" = 2 chars => ceil(2/4) = 1
    const messages = [
      { content: [{ type: 'text', text: 'Hi' }] },
    ]
    expect(estimateTokens(messages)).toBe(1)
  })

  it('sums across multiple messages and blocks', () => {
    // "Hello" (5) + "World" (5) + "!" (1) = 11 chars => ceil(11/4) = 3
    const messages = [
      { content: [{ type: 'text', text: 'Hello' }] },
      { content: [{ type: 'text', text: 'World' }, { type: 'text', text: '!' }] },
    ]
    expect(estimateTokens(messages)).toBe(3)
  })
})

// ─── checkBudget ───────────────────────────────────────────────

describe('checkBudget', () => {
  it('returns "ok" when under warning threshold', () => {
    // 100 chars = 25 tokens, contextLength=32768, utilization = 25/32768 ~= 0.0008
    const messages = [
      { content: [{ type: 'text', text: 'x'.repeat(100) }] },
    ]
    const result = checkBudget(messages)
    expect(result.status).toBe('ok')
    expect(result.shouldCompact).toBe(false)
  })

  it('returns "warning" at 40% utilization', () => {
    // Need tokens >= 0.4 * 1000 = 400 tokens = 1600 chars
    // Use small contextLength to make test manageable
    const messages = [
      { content: [{ type: 'text', text: 'x'.repeat(1600) }] },
    ]
    const result = checkBudget(messages, { contextLength: 1000 })
    expect(result.status).toBe('warning')
    expect(result.shouldCompact).toBe(true)
  })

  it('returns "exceeded" at 80% utilization', () => {
    // Need tokens >= 0.8 * 1000 = 800 tokens = 3200 chars
    const messages = [
      { content: [{ type: 'text', text: 'x'.repeat(3200) }] },
    ]
    const result = checkBudget(messages, { contextLength: 1000 })
    expect(result.status).toBe('exceeded')
    expect(result.shouldCompact).toBe(true)
  })

  it('shouldCompact is true for warning status', () => {
    const messages = [
      { content: [{ type: 'text', text: 'x'.repeat(1600) }] },
    ]
    const result = checkBudget(messages, { contextLength: 1000 })
    expect(result.status).toBe('warning')
    expect(result.shouldCompact).toBe(true)
  })

  it('shouldCompact is true for exceeded status', () => {
    const messages = [
      { content: [{ type: 'text', text: 'x'.repeat(3200) }] },
    ]
    const result = checkBudget(messages, { contextLength: 1000 })
    expect(result.status).toBe('exceeded')
    expect(result.shouldCompact).toBe(true)
  })

  it('shouldCompact is false for ok status', () => {
    const messages = [
      { content: [{ type: 'text', text: 'x'.repeat(100) }] },
    ]
    const result = checkBudget(messages, { contextLength: 1000 })
    expect(result.status).toBe('ok')
    expect(result.shouldCompact).toBe(false)
  })

  it('supports custom thresholds', () => {
    // 15% warning, 50% hard limit
    // 160 chars = 40 tokens, contextLength=100 => utilization = 0.4
    // With warningThreshold=0.15, hardLimit=0.50 => 40% should be warning
    const messages = [
      { content: [{ type: 'text', text: 'x'.repeat(160) }] },
    ]
    const result = checkBudget(messages, {
      contextLength: 100,
      warningThreshold: 0.15,
      hardLimit: 0.50,
    })
    expect(result.status).toBe('warning')
    expect(result.shouldCompact).toBe(true)

    // Now test exceeded: 200 chars = 50 tokens, utilization = 0.5 => exactly at hard limit
    const messages2 = [
      { content: [{ type: 'text', text: 'x'.repeat(200) }] },
    ]
    const result2 = checkBudget(messages2, {
      contextLength: 100,
      warningThreshold: 0.15,
      hardLimit: 0.50,
    })
    expect(result2.status).toBe('exceeded')
  })

  it('uses default contextLength of 32768', () => {
    const messages: { content?: unknown[] }[] = []
    const result = checkBudget(messages)
    expect(result.contextLength).toBe(32768)
  })

  it('returns correct estimatedTokens and utilization', () => {
    // 400 chars = 100 tokens, contextLength = 1000 => utilization = 0.1
    const messages = [
      { content: [{ type: 'text', text: 'x'.repeat(400) }] },
    ]
    const result = checkBudget(messages, { contextLength: 1000 })
    expect(result.estimatedTokens).toBe(100)
    expect(result.utilization).toBeCloseTo(0.1, 5)
    expect(result.contextLength).toBe(1000)
  })
})

// ─── DEFAULT_BUDGET ────────────────────────────────────────────

describe('DEFAULT_BUDGET', () => {
  it('has contextLength of 32768', () => {
    expect(DEFAULT_BUDGET.contextLength).toBe(32768)
  })

  it('has warningThreshold of 0.4', () => {
    expect(DEFAULT_BUDGET.warningThreshold).toBe(0.4)
  })

  it('has hardLimit of 0.8', () => {
    expect(DEFAULT_BUDGET.hardLimit).toBe(0.8)
  })
})

// ─── estimateTokensAsync ───────────────────────────────────────

describe('estimateTokensAsync', () => {
  // Word-count stand-in: each space-delimited word = 1 token.
  const wordCounter: TokenCounter = async (text: string) => text.split(' ').length

  it('returns sync estimateTokens result when countTokens is undefined', async () => {
    const messages = [
      { content: [{ type: 'text', text: 'Hello world' }] },
    ]
    const async_ = await estimateTokensAsync(messages, undefined)
    expect(async_).toBe(estimateTokens(messages))
  })

  it('uses the real counter for text blocks', async () => {
    // "one two three" → 3 words → 3 tokens
    const messages = [
      { content: [{ type: 'text', text: 'one two three' }] },
    ]
    const count = await estimateTokensAsync(messages, wordCounter)
    expect(count).toBe(3)
  })

  it('uses the real counter for string content blocks', async () => {
    // "hello world" → 2 words → 2 tokens
    const messages = [
      { content: ['hello world'] },
    ]
    const count = await estimateTokensAsync(messages, wordCounter)
    expect(count).toBe(2)
  })

  it('uses JSON.stringify for tool input blocks', async () => {
    // input: {a:1} => JSON '{"a":1}' (7 chars, 1 word) → wordCounter returns 1
    const messages = [
      { content: [{ type: 'tool_use', input: { a: 1 } }] },
    ]
    const count = await estimateTokensAsync(messages, wordCounter)
    expect(count).toBe(1)
  })

  it('concatenates multi-block messages before counting (single counter call per message)', async () => {
    // Message: ["foo bar", "baz"] → concatenated = "foo barbaz" → 2 words
    const messages = [
      { content: [{ type: 'text', text: 'foo bar' }, { type: 'text', text: 'baz' }] },
    ]
    const count = await estimateTokensAsync(messages, wordCounter)
    // "foo bar" + "baz" → joined = "foo barbaz" → 2 words
    expect(count).toBe(2)
  })

  it('sums across multiple messages', async () => {
    // Msg1: "one two" → 2 words; Msg2: "three four five" → 3 words; total = 5
    const messages = [
      { content: [{ type: 'text', text: 'one two' }] },
      { content: [{ type: 'text', text: 'three four five' }] },
    ]
    const count = await estimateTokensAsync(messages, wordCounter)
    expect(count).toBe(5)
  })

  it('returns 0 for empty messages array', async () => {
    const count = await estimateTokensAsync([], wordCounter)
    expect(count).toBe(0)
  })
})

// ─── checkBudgetAsync ──────────────────────────────────────────

describe('checkBudgetAsync', () => {
  // Word-count stand-in: each space-delimited word = 1 token.
  const wordCounter: TokenCounter = async (text: string) => text.split(' ').length

  it('returns "ok" when under warning threshold', async () => {
    // 1 word, contextLength=100, warningThreshold=0.4 → 0.01 utilization
    const messages = [{ content: [{ type: 'text', text: 'hello' }] }]
    const result = await checkBudgetAsync(messages, { contextLength: 100 }, wordCounter)
    expect(result.status).toBe('ok')
    expect(result.shouldCompact).toBe(false)
  })

  it('returns "warning" when over warning threshold', async () => {
    // 50 words, contextLength=100, warningThreshold=0.4 → 0.5 utilization → warning
    const text = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')
    const messages = [{ content: [{ type: 'text', text: text }] }]
    const result = await checkBudgetAsync(messages, { contextLength: 100 }, wordCounter)
    expect(result.status).toBe('warning')
    expect(result.shouldCompact).toBe(true)
  })

  it('returns "exceeded" when over hard limit', async () => {
    // 85 words, contextLength=100, hardLimit=0.8 → 0.85 utilization → exceeded
    const text = Array.from({ length: 85 }, (_, i) => `w${i}`).join(' ')
    const messages = [{ content: [{ type: 'text', text: text }] }]
    const result = await checkBudgetAsync(messages, { contextLength: 100 }, wordCounter)
    expect(result.status).toBe('exceeded')
    expect(result.shouldCompact).toBe(true)
  })

  it('with undefined counter matches sync checkBudget result', async () => {
    const messages = [{ content: [{ type: 'text', text: 'x'.repeat(400) }] }]
    const sync = checkBudget(messages, { contextLength: 1000 })
    const async_ = await checkBudgetAsync(messages, { contextLength: 1000 }, undefined)
    expect(async_.estimatedTokens).toBe(sync.estimatedTokens)
    expect(async_.status).toBe(sync.status)
    expect(async_.utilization).toBeCloseTo(sync.utilization, 10)
  })

  it('returns correct estimatedTokens and utilization', async () => {
    // 10 words, contextLength=100 → utilization = 0.1
    const text = Array.from({ length: 10 }, (_, i) => `word${i}`).join(' ')
    const messages = [{ content: [{ type: 'text', text: text }] }]
    const result = await checkBudgetAsync(messages, { contextLength: 100 }, wordCounter)
    expect(result.estimatedTokens).toBe(10)
    expect(result.utilization).toBeCloseTo(0.1, 5)
    expect(result.contextLength).toBe(100)
  })
})
