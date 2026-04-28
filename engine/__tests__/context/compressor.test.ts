import { describe, expect, it } from 'bun:test'
import { ContextCompressor } from '../../context/compressor.js'
import type { CompressorConfig } from '../../context/compressor.js'

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: [{ type: 'text', text: `Message ${i + 1}` }],
  }))
}

describe('ContextCompressor', () => {
  it('does not compress when below threshold', () => {
    const config: CompressorConfig = { threshold: 0.8, targetRatio: 0.4, keepRecent: 4 }
    const compressor = new ContextCompressor(config)
    const messages = makeMessages(20)
    // 40% utilization — well below 80% threshold
    expect(compressor.shouldCompress(messages, 4000, 10000)).toBe(false)
  })

  it('compresses when above threshold with enough messages', () => {
    const config: CompressorConfig = { threshold: 0.8, targetRatio: 0.4, keepRecent: 4 }
    const compressor = new ContextCompressor(config)
    // 20 messages (> keepRecent*2=8), 85% utilization
    const messages = makeMessages(20)
    expect(compressor.shouldCompress(messages, 8500, 10000)).toBe(true)
  })

  it('selects older messages for compression, keeping recent pairs', () => {
    const config: CompressorConfig = { threshold: 0.8, targetRatio: 0.4, keepRecent: 2 }
    const compressor = new ContextCompressor(config)
    const messages = makeMessages(10)
    const toCompress = compressor.selectForCompression(messages, 2)
    // keepRecent=2 pairs = 4 messages kept → first 6 selected for compression
    expect(toCompress).toHaveLength(6)
    expect(toCompress[0].content[0].text).toBe('Message 1')
    expect(toCompress[5].content[0].text).toBe('Message 6')
  })

  it('builds a summary prompt containing the conversation text', () => {
    const config: CompressorConfig = { threshold: 0.8, targetRatio: 0.4 }
    const compressor = new ContextCompressor(config)
    const messages = [
      { role: 'user' as const, content: [{ type: 'text', text: 'How do I fix this bug?' }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'Try checking the null case.' }] },
    ]
    const prompt = compressor.buildSummaryPrompt(messages)
    expect(prompt).toContain('Summarize the conversation into a structured context summary')
    expect(prompt).toContain('How do I fix this bug?')
    expect(prompt).toContain('Try checking the null case.')
    expect(prompt).toContain('User:')
    expect(prompt).toContain('Assistant:')
    expect(prompt).toContain('Provide the structured summary:')
  })
})
