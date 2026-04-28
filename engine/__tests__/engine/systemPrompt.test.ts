import { describe, expect, it } from 'bun:test'
import {
  buildSystemPromptBlocks,
  addCacheBreakpoints,
  getAPIMetadata,
  cleanupStream,
  type TextBlock,
} from '../../engine/systemPrompt.js'
import { asSystemPrompt } from '../../types.js'

// ─── buildSystemPromptBlocks ───────────────────────────────────

describe('buildSystemPromptBlocks', () => {
  it('returns text blocks from a simple string array prompt', () => {
    const prompt = asSystemPrompt(['You are a helpful assistant.', 'Be concise.'])
    const result = buildSystemPromptBlocks(prompt)

    expect(result).toEqual([
      { type: 'text', text: 'You are a helpful assistant.' },
      { type: 'text', text: 'Be concise.' },
    ])
  })

  it('returns empty array for empty prompt', () => {
    const prompt = asSystemPrompt([])
    const result = buildSystemPromptBlocks(prompt)

    expect(result).toEqual([])
  })

  it('blocks are simple text blocks', () => {
    const prompt = asSystemPrompt(['System prompt text.'])
    const result = buildSystemPromptBlocks(prompt)

    expect(result).toHaveLength(1)
    for (const block of result) {
      expect(block).not.toHaveProperty('cacheControl')
    }
  })

  it('filters out empty strings from the prompt array', () => {
    const prompt = asSystemPrompt(['First block', '', 'Third block'])
    const result = buildSystemPromptBlocks(prompt)

    expect(result).toEqual([
      { type: 'text', text: 'First block' },
      { type: 'text', text: 'Third block' },
    ])
  })

  it('each block has exactly type and text properties', () => {
    const prompt = asSystemPrompt(['Hello world'])
    const result = buildSystemPromptBlocks(prompt)

    expect(result).toHaveLength(1)
    expect(Object.keys(result[0]!)).toEqual(['type', 'text'])
  })
})

// ─── addCacheBreakpoints (no-op stub) ──────────────────────────

describe('addCacheBreakpoints', () => {
  it('is callable and returns undefined', () => {
    const result = addCacheBreakpoints('some', 'args')
    expect(result).toBeUndefined()
  })
})

// ─── getAPIMetadata (stub) ─────────────────────────────────────

describe('getAPIMetadata', () => {
  it('returns an empty object', () => {
    const result = getAPIMetadata()
    expect(result).toEqual({})
  })
})

// ─── cleanupStream (no-op stub) ────────────────────────────────

describe('cleanupStream', () => {
  it('is callable and returns undefined', () => {
    const result = cleanupStream('stream', 'args')
    expect(result).toBeUndefined()
  })
})
