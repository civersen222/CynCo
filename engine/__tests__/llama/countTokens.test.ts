// engine/__tests__/llama/countTokens.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { LlamaCppProvider, COUNT_TOKENS_CACHE_BOUND } from '../../llama/provider.js'

const PRIMARY_URL = 'http://localhost:8080'

function makeProvider(tokenCacheBound?: number): LlamaCppProvider {
  return new LlamaCppProvider({
    primaryUrl: PRIMARY_URL,
    modelName: 'test-model',
    modelsDir: '/tmp/models',
    tokenCacheBound,
  })
}

function mockFetchOk(tokens: number[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ tokens }),
  } as unknown as Response)
}

describe('LlamaCppProvider.countTokens', () => {
  let provider: LlamaCppProvider

  beforeEach(() => {
    provider = makeProvider()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns tokens.length from /tokenize response', async () => {
    const fetchMock = mockFetchOk([1, 2, 3, 4, 5])
    vi.stubGlobal('fetch', fetchMock)

    const count = await provider.countTokens('hello world')
    expect(count).toBe(5)
  })

  it('calls the correct URL: primaryUrl + /tokenize', async () => {
    const fetchMock = mockFetchOk([10, 20])
    vi.stubGlobal('fetch', fetchMock)

    await provider.countTokens('some text')
    const calledUrl = fetchMock.mock.calls[0][0]
    expect(calledUrl).toBe(`${PRIMARY_URL}/tokenize`)
  })

  it('returns 0 for empty string without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const count = await provider.countTokens('')
    expect(count).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('memoizes: same text called twice results in only one fetch', async () => {
    const fetchMock = mockFetchOk([1, 2, 3])
    vi.stubGlobal('fetch', fetchMock)

    const a = await provider.countTokens('cached text')
    const b = await provider.countTokens('cached text')
    expect(a).toBe(3)
    expect(b).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns chars/4 fallback when fetch rejects, and does NOT cache it', async () => {
    // First call: fetch rejects
    const failing = vi.fn().mockRejectedValue(new Error('network error'))
    vi.stubGlobal('fetch', failing)

    const text = 'fallback text' // 13 chars => Math.ceil(13/4) = 4
    const fallback = await provider.countTokens(text)
    expect(fallback).toBe(Math.ceil(text.length / 4))

    // Second call: fetch now succeeds — must call fetch again (not cached)
    const success = mockFetchOk([100, 200, 300])
    vi.stubGlobal('fetch', success)

    const real = await provider.countTokens(text)
    expect(real).toBe(3)
    expect(success).toHaveBeenCalledTimes(1)
  })

  it('returns chars/4 fallback when response is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const text = 'error path' // 10 chars => ceil(10/4) = 3
    const count = await provider.countTokens(text)
    expect(count).toBe(Math.ceil(text.length / 4))
  })

  it('returns chars/4 fallback when JSON has no tokens array', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: 'shape' }),
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const text = 'bad json' // 8 chars => ceil(8/4) = 2
    const count = await provider.countTokens(text)
    expect(count).toBe(Math.ceil(text.length / 4))
  })

  it('FIFO eviction: fills cache past bound, oldest entry evicted', async () => {
    const cacheBound = 3
    const smallProvider = makeProvider(cacheBound)

    // Populate cache with entries 0,1,2 (fills to bound exactly: size=3)
    for (let i = 0; i < cacheBound; i++) {
      const text = `entry-${i}`
      const fetchMock = mockFetchOk([i + 1])
      vi.stubGlobal('fetch', fetchMock)
      await smallProvider.countTokens(text)
    }
    // Cache now: {entry-0, entry-1, entry-2} (FIFO order)

    // Add one more entry — should evict 'entry-0' (oldest)
    // Cache after: {entry-1, entry-2, entry-new}
    const evictFetch = mockFetchOk([99])
    vi.stubGlobal('fetch', evictFetch)
    await smallProvider.countTokens('entry-new')

    // Re-request 'entry-0' — evicted, so fetch is called again.
    // Storing entry-0 evicts entry-1 (now oldest).
    // Cache after: {entry-2, entry-new, entry-0}
    const refetchMock = mockFetchOk([1])
    vi.stubGlobal('fetch', refetchMock)
    await smallProvider.countTokens('entry-0')
    expect(refetchMock).toHaveBeenCalledTimes(1)

    // 'entry-2' and 'entry-new' should still be cached (no fetch needed)
    const noFetchMock = vi.fn()
    vi.stubGlobal('fetch', noFetchMock)
    await smallProvider.countTokens('entry-2')
    await smallProvider.countTokens('entry-new')
    expect(noFetchMock).not.toHaveBeenCalled()
  })

  it('exports COUNT_TOKENS_CACHE_BOUND constant (512)', () => {
    expect(COUNT_TOKENS_CACHE_BOUND).toBe(512)
  })
})
