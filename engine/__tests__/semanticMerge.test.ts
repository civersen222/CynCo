import { describe, expect, it } from 'bun:test'
import { attemptSemanticMerge } from '../tools/semanticMerge.js'

const SMALL_FILE = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
const LARGE_FILE = Array.from({ length: 501 }, (_, i) => `line ${i + 1}`).join('\n')

describe('attemptSemanticMerge', () => {
  it('returns null for files with more than 500 lines', () => {
    const attempted = new Set<string>()
    const result = attemptSemanticMerge(LARGE_FILE, 'old', 'new', 'foo.ts', attempted)
    expect(result).toBeNull()
  })

  it('marks the file as attempted even when file is too large', () => {
    const attempted = new Set<string>()
    attemptSemanticMerge(LARGE_FILE, 'old', 'new', 'foo.ts', attempted)
    expect(attempted.has('foo.ts')).toBe(true)
  })

  it('returns null if the file has already been attempted', () => {
    const attempted = new Set<string>(['bar.ts'])
    const result = attemptSemanticMerge(SMALL_FILE, 'old', 'new', 'bar.ts', attempted)
    expect(result).toBeNull()
  })

  it('marks the file as attempted after a successful call', () => {
    const attempted = new Set<string>()
    attemptSemanticMerge(SMALL_FILE, 'old', 'new', 'baz.ts', attempted)
    expect(attempted.has('baz.ts')).toBe(true)
  })

  it('returns null on second call for the same file', () => {
    const attempted = new Set<string>()
    const first = attemptSemanticMerge(SMALL_FILE, 'old', 'new', 'dup.ts', attempted)
    expect(first).not.toBeNull()
    const second = attemptSemanticMerge(SMALL_FILE, 'old', 'new', 'dup.ts', attempted)
    expect(second).toBeNull()
  })

  it('returns a MergePrompt with system and user fields for a valid small file', () => {
    const attempted = new Set<string>()
    const result = attemptSemanticMerge(SMALL_FILE, 'old code', 'new code', 'valid.ts', attempted)
    expect(result).not.toBeNull()
    expect(typeof result!.system).toBe('string')
    expect(typeof result!.user).toBe('string')
    expect(result!.system.length).toBeGreaterThan(0)
    expect(result!.user.length).toBeGreaterThan(0)
  })

  it('system prompt instructs returning only file content', () => {
    const attempted = new Set<string>()
    const result = attemptSemanticMerge(SMALL_FILE, 'old', 'new', 'sys.ts', attempted)
    expect(result!.system).toContain('Return ONLY the complete updated file content')
    expect(result!.system).toContain('No markdown fences')
  })

  it('user prompt contains the file content, old string, and new string', () => {
    const attempted = new Set<string>()
    const result = attemptSemanticMerge(SMALL_FILE, 'old snippet', 'new snippet', 'usr.ts', attempted)
    expect(result!.user).toContain(SMALL_FILE)
    expect(result!.user).toContain('old snippet')
    expect(result!.user).toContain('new snippet')
  })

  it('handles a file with exactly 500 lines (boundary: should return prompt)', () => {
    const boundary = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n')
    const attempted = new Set<string>()
    const result = attemptSemanticMerge(boundary, 'old', 'new', 'boundary.ts', attempted)
    expect(result).not.toBeNull()
  })
})
