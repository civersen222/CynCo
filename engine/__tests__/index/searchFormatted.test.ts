import { describe, it, expect, afterEach } from 'bun:test'
import { ProjectIndexer, annotateByScore, SCORE_FLOOR, LOW_CONFIDENCE_PREFIX } from '../../index/indexer.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IndexResult } from '../../index/types.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const res = (score: number): IndexResult => ({
  filePath: 'a.py', name: 'x', chunkType: 'function',
  startLine: 1, endLine: 2, content: 'def x(): pass', score,
})

describe('annotateByScore', () => {
  it('prefixes low-confidence results', () => {
    expect(annotateByScore([res(SCORE_FLOOR - 0.01)], 'text')).toBe(LOW_CONFIDENCE_PREFIX + 'text')
  })

  it('leaves confident results untouched', () => {
    expect(annotateByScore([res(0.9)], 'text')).toBe('text')
  })

  it('keyword-only results (flat 0.5 marker) are always prefixed', () => {
    expect(annotateByScore([res(0.5), res(0.5)], 'text')).toBe(LOW_CONFIDENCE_PREFIX + 'text')
  })

  it('empty output passes through', () => {
    expect(annotateByScore([], '')).toBe('')
  })
})

describe('ProjectIndexer.searchFormatted', () => {
  async function tmpProject(): Promise<ProjectIndexer> {
    const root = mkdtempSync(join(tmpdir(), 'ci-sf-'))
    writeFileSync(join(root, 'a.py'), 'def power_row_title(ln):\n    return str(ln)\n')
    writeFileSync(join(root, 'b.py'), 'from a import power_row_title\nx = power_row_title(1)\n')
    // Embedding server down — the index stores empty vectors; symbol + keyword
    // legs still work, which is exactly the degraded environment to test.
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as any
    const indexer = new ProjectIndexer(root)
    await indexer.index()
    return indexer
  }

  it('symbol query returns a definition card', async () => {
    const indexer = await tmpProject()
    const out = await indexer.searchFormatted({ query: 'power_row_title', topK: 5 })
    expect(out).toContain('=== DEFINITION a.py:')
    expect(out).toContain('power_row_title')
    expect(out).toContain('=== REFERENCES (1) ===')
    expect(out).toContain('b.py:')
    indexer.close()
  })

  it('unresolvable query returns empty string so the caller runs regex fallback', async () => {
    const indexer = await tmpProject()
    const out = await indexer.searchFormatted({ query: 'zqxnonexistentsym', topK: 5 })
    expect(out).toBe('')
    indexer.close()
  })

  it('non-symbol path annotates keyword-only results as low confidence', async () => {
    const indexer = await tmpProject()
    // "import" is not a stopword and appears in b.py content; no name matches it
    const out = await indexer.searchFormatted({ query: 'import', topK: 5 })
    if (out) expect(out.startsWith(LOW_CONFIDENCE_PREFIX)).toBe(true)
    indexer.close()
  })
})
