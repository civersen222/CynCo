// engine/__tests__/tools/mfl.test.ts
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { mflTool, buildMflExportUrl } from '../../tools/impl/mfl.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('buildMflExportUrl', () => {
  it('builds an export URL with JSON=1', () => {
    const url = buildMflExportUrl({ query: 'rosters', league: '12345', year: 2026 })
    expect(url).toBe('https://api.myfantasyleague.com/2026/export?TYPE=rosters&L=12345&JSON=1')
  })

  it('omits L for global queries so MFL does not redirect to the league host', () => {
    // 2026-06-12 incident: api.myfantasyleague.com 302s any L= request to the
    // league host (www47), which rejects TYPE=injuries with "must go to
    // api.myfantasyleague.com". Without L there is no redirect and api serves it.
    const url = buildMflExportUrl({ query: 'injuries', league: '65042', year: 2026 })
    expect(url).toBe('https://api.myfantasyleague.com/2026/export?TYPE=injuries&JSON=1')
  })

  it('appends APIKEY when provided', () => {
    const url = buildMflExportUrl({ query: 'rosters', league: '12345', year: 2026, apiKey: 'sekret' })
    expect(url).toContain('APIKEY=sekret')
  })

  it('appends extra params', () => {
    const url = buildMflExportUrl({ query: 'players', league: '12345', year: 2026, extra: { DETAILS: '1' } })
    expect(url).toContain('DETAILS=1')
  })

  it('extra cannot override TYPE — write endpoints stay unreachable', () => {
    const url = buildMflExportUrl({
      query: 'rosters', league: '12345', year: 2026, apiKey: 'sekret',
      extra: { TYPE: 'import', type: 'import' },
    })
    expect(url).toContain('TYPE=rosters')
    expect(url).not.toContain('import')
  })

  it('extra cannot override L, JSON, or APIKEY', () => {
    const url = buildMflExportUrl({
      query: 'rosters', league: '12345', year: 2026, apiKey: 'sekret',
      extra: { L: '99999', JSON: '0', APIKEY: 'stolen', ApiKey: 'stolen2' },
    })
    expect(url).toContain('L=12345')
    expect(url).toContain('JSON=1')
    expect(url).toContain('APIKEY=sekret')
    expect(url).not.toContain('99999')
    expect(url).not.toContain('stolen')
  })
})

describe('Mfl tool', () => {
  it('description teaches the PLAYERS filter for the players query', () => {
    // 2026-06-12 incident: rosters returns ids only; the model looped fetching
    // the ENTIRE player database (truncated) because nothing told it the
    // players query accepts a PLAYERS=id1,id2 filter.
    expect(mflTool.description).toContain('PLAYERS')
    expect(mflTool.description).toMatch(/players.*entire|entire.*players/i)
  })

  it('rejects non-whitelisted queries (read-only guard)', async () => {
    const result = await mflTool.execute({ query: 'import', league: '12345' }, {} as any)
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not allowed/i)
  })

  it('rejects case-variant injection of write types (IMPORT vs import)', async () => {
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
