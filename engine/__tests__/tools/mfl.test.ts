// engine/__tests__/tools/mfl.test.ts
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { mflTool, buildMflExportUrl } from '../../tools/impl/mfl.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('buildMflExportUrl', () => {
  it('builds an export URL with JSON=1', () => {
    const url = buildMflExportUrl({ query: 'rosters', league: '12345', year: 2026 })
    expect(url).toBe('https://api.myfantasyleague.com/2026/export?TYPE=rosters&L=12345&JSON=1')
  })

  it('appends APIKEY when provided', () => {
    const url = buildMflExportUrl({ query: 'rosters', league: '12345', year: 2026, apiKey: 'sekret' })
    expect(url).toContain('APIKEY=sekret')
  })

  it('appends extra params', () => {
    const url = buildMflExportUrl({ query: 'players', league: '12345', year: 2026, extra: { DETAILS: '1' } })
    expect(url).toContain('DETAILS=1')
  })
})

describe('Mfl tool', () => {
  it('rejects non-whitelisted queries (read-only guard)', async () => {
    const result = await mflTool.execute({ query: 'import', league: '12345' }, {} as any)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not allowed/i)
  })

  it('rejects the calendar injection of write types via casing', async () => {
    const result = await mflTool.execute({ query: 'IMPORT', league: '12345' }, {} as any)
    expect(result.isError).toBe(true)
  })

  it('fetches and returns JSON for a whitelisted query', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ rosters: { franchise: [] } }), { status: 200 }))
    vi.stubGlobal('fetch', fakeFetch)
    const result = await mflTool.execute({ query: 'rosters', league: '12345', year: 2026 }, {} as any)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('rosters')
    const calledUrl = (fakeFetch.mock.calls[0] as any[])[0] as string
    expect(calledUrl).toContain('TYPE=rosters')
    expect(calledUrl).toContain('L=12345')
  })

  it('redacts the API key from error output', async () => {
    const fakeFetch = vi.fn(async () => { throw new Error('connect failed for APIKEY=sekret') })
    vi.stubGlobal('fetch', fakeFetch)
    const result = await mflTool.execute({ query: 'rosters', league: '12345', year: 2026 }, {} as any)
    expect(result.isError).toBe(true)
    expect(result.output).not.toContain('sekret')
  })
})
