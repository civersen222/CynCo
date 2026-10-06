import { describe, it, expect } from 'bun:test'
import { chunkSegments, chunkTranscriptTurns, TARGET_WORDS, MAX_WORDS } from '../../projects/proseChunker.js'

const words = (n: number, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ')
const para = (n: number, w?: string) => words(n, w)

describe('chunkSegments', () => {
  it('packs paragraphs toward TARGET_WORDS and never crosses a heading', () => {
    const segs = [
      { heading: ['Book', 'Starter'], text: [para(200, 'a'), para(200, 'b'), para(200, 'c')].join('\n\n') },
      { heading: ['Book', 'Bake'], text: para(50, 'd') },
    ]
    const chunks = chunkSegments(segs)
    expect(chunks.map(c => c.heading)).toEqual(['Book › Starter', 'Book › Starter', 'Book › Bake'])
    expect(chunks[0].text.split(/\s+/).length).toBeLessThanOrEqual(MAX_WORDS)
    expect(chunks[0].text).toContain('a0')
    expect(chunks[0].text).toContain('b0')
    expect(chunks[0].text).not.toContain('c0')
    expect(chunks.map(c => c.ordinal)).toEqual([1, 2, 3])
  })
  it('carries the previous chunk\'s last paragraph as overlap', () => {
    const segs = [{ heading: ['H'], text: [para(400, 'a'), para(400, 'b')].join('\n\n') }]
    const chunks = chunkSegments(segs)
    expect(chunks).toHaveLength(2)
    expect(chunks[1].text.startsWith('a0 ')).toBe(true)   // overlap = whole previous paragraph
    expect(chunks[1].text).toContain('b399')
  })
  it('splits a single paragraph longer than MAX_WORDS by sentence', () => {
    const long = Array.from({ length: 120 }, (_, i) => `Sentence ${i} has exactly eight words in it.`).join(' ')
    const chunks = chunkSegments([{ heading: ['H'], text: long }])
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.split(/\s+/).length).toBeLessThanOrEqual(MAX_WORDS)
  })
  it('keeps page and chapter and skips empty segments', () => {
    const chunks = chunkSegments([{ heading: ['g.pdf', 'page 3'], page: 3, text: 'short' }, { heading: ['x'], text: '  ' }])
    expect(chunks).toEqual([{ heading: 'g.pdf › page 3', page: 3, chapter: undefined, ordinal: 3, text: 'short' }])
  })
  it('TARGET_WORDS is 500 and MAX_WORDS 800', () => { expect(TARGET_WORDS).toBe(500); expect(MAX_WORDS).toBe(800) })
})

describe('chunkTranscriptTurns', () => {
  it('one chunk per user/assistant pair under the chat title', () => {
    const chunks = chunkTranscriptTurns([{ user: 'How much resin?', assistant: 'About 400 ml.' }, { user: 'Brand?', assistant: 'Any clear epoxy.' }], 'Resin questions')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ heading: 'Resin questions', ordinal: 1, text: 'User: How much resin?\n\nAssistant: About 400 ml.' })
    expect(chunks[1].ordinal).toBe(2)
  })
})
