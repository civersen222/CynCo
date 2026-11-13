/**
 * GET /api/mission-history — every mission in the outcome ledger, newest first
 * and paged, whatever launched it. A mission dispatched by hand with no
 * campaign (the Party Night casino's t1 and t2) must appear; one a runner
 * campaign drove links to that campaign, including rows written before the
 * ledger carried `campaignId` (found through the campaign's waves.jsonl).
 * Every ledger and campaign dir here is a temp dir.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import { reduceLedgerRow, checkResult, missionHistoryQuery, MissionHistory } from '../../dashboard/missionHistory.js'

const tokenDir = mkdtempSync(join(tmpdir(), 'cynco-mh-tok-'))
const tokens = loadOrCreateTokens(tokenDir)
const READ = tokens.tokenFor('inference')!
const ledgerDir = mkdtempSync(join(tmpdir(), 'cynco-mh-ledger-'))
let home = ''
const savedHome = process.env.CYNCO_HOME
process.on('exit', () => { rmSync(tokenDir, { recursive: true, force: true }); rmSync(ledgerDir, { recursive: true, force: true }) })

const row = (o: Record<string, unknown>) => JSON.stringify({ schema: 1, turns: [{ t: 1 }, { t: 2 }], ...o })
// Shard 1 (frozen): a C8 wave from before the ledger carried campaignId.
const c8wave = row({ missionId: 'c8-wave2-1789649392765', cwd: 'C:/Users/civer/civkings', briefFile: 'docs\\civkings-redesign-briefs\\c8-wave2.txt', dispatchedAt: '2026-09-17T12:49:52.765Z', durationS: 24147, outcome: 'landed', verified: false, exitReason: 'marker' })
// Shard 0004: an authoring run, a C11 wave, then the casino's two hand-run missions.
const author = row({ missionId: 'brief-1-1790962309082', campaignId: 'c11-author', cwd: 'C:/Users/civer/.cynco/authoring/c11', dispatchedAt: '2026-10-02T17:31:49.082Z', outcome: 'landed', verified: null })
const c11 = row({ missionId: 'c11-wave2-1791237906699', campaignId: 'c11', cwd: 'C:/Users/civer/civkings', dispatchedAt: '2026-10-05T22:05:06.698Z', durationS: 7726, outcome: 'landed', verified: true,
  commitRange: { base: '16311886b51d7861842f8c4884ab3195f99b5b2b', head: '91a8cd7501361394949cbeab23f3ff3cd6b14037' }, graderProbes: { total: 85, probes: 0, uninspectable: 0, byPattern: {}, samples: [] } })
const t1 = row({ missionId: 't1-brief-1794596799340', campaignId: null, cwd: 'C:\\Users\\civer\\casino', briefFile: 'C:/Users/civer/.cynco/campaigns/partynight/t1-brief.txt', marker: 'cast task 1 complete', markerSeen: true,
  dispatchedAt: '2026-11-13T19:06:39.340Z', durationS: 555, outcome: 'landed', verified: true, exitReason: 'engine_closed_the_turn',
  verify: { command: 'node C:/Users/civer/.cynco/heldout/partynight/t1/gate_t1.mjs', exitCode: 0, timedOut: false, spawnFailed: false, harnessFault: null, outputTail: 'T1.1 each game says what it is like: PASS' },
  commitRange: { base: 'aaaa', head: '293dc1cfbd02d0591b61086b8b3bf849375d2734' }, graderProbes: { total: 59, probes: 0, uninspectable: 0 } })
const t2 = row({ missionId: 't2-brief-1794600000000', cwd: 'C:\\Users\\civer\\casino', briefFile: 'C:/Users/civer/.cynco/campaigns/partynight/t2-brief.txt', dispatchedAt: '2026-11-13T19:30:35.000Z', durationS: 28000, outcome: 'timeout', verified: false,
  verify: { command: 'node gate_t2.mjs', exitCode: null, timedOut: true } })

function writeLedger() {
  writeFileSync(join(ledgerDir, 'missions.jsonl'), c8wave + '\n')
  writeFileSync(join(ledgerDir, 'missions.0004.jsonl'), [author, c11, t1, t2].join('\n') + '\n')
}
function writeCampaigns() {
  home = mkdtempSync(join(tmpdir(), 'cynco-mh-home-'))
  process.env.CYNCO_HOME = home
  for (const [id, missions] of [['c8', ['c8-wave2-1789649392765']], ['c11', ['c11-wave2-1791237906699']]] as const) {
    const dir = join(home, 'campaigns', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ id, waveCount: 1 }))
    writeFileSync(join(dir, 'waves.jsonl'), missions.map((m: string, i: number) => JSON.stringify({ wave: i + 1, missionId: m })).join('\n') + '\n')
  }
}

let server: DashboardServer
let BASE = ''
const get = (path: string, token: string | null = READ) => fetch(`${BASE}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {})

beforeAll(async () => {
  writeLedger()
  server = new DashboardServer({ port: 0, tokens, deps: { ledgerDir } })
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && server.getPort() <= 0) await new Promise(r => setTimeout(r, 10))
  BASE = `http://localhost:${server.getPort()}`
})
afterAll(() => {
  server.stop()
  if (savedHome === undefined) delete process.env.CYNCO_HOME
  else process.env.CYNCO_HOME = savedHome
})
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = '' })

describe('GET /api/mission-history', () => {
  it('lists every ledger mission newest first, the hand-run casino missions included with no campaign', async () => {
    writeCampaigns()
    const res = await get('/api/mission-history')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.total).toBe(5)
    expect(data.errors).toEqual([])
    expect(data.missions.map((m: any) => m.missionId)).toEqual(['t2-brief-1794600000000', 't1-brief-1794596799340', 'c11-wave2-1791237906699', 'brief-1-1790962309082', 'c8-wave2-1789649392765'])
    const [r2, r1] = data.missions
    expect(r1).toEqual({
      missionId: 't1-brief-1794596799340', campaignId: null, campaignFrom: null, campaignLink: null,
      cwd: 'C:\\Users\\civer\\casino', briefFile: 'C:/Users/civer/.cynco/campaigns/partynight/t1-brief.txt', marker: 'cast task 1 complete', markerSeen: true,
      dispatchedAt: '2026-11-13T19:06:39.340Z', durationS: 555, outcome: 'landed', verified: true,
      check: { command: 'node C:/Users/civer/.cynco/heldout/partynight/t1/gate_t1.mjs', result: 'exit 0', tail: 'T1.1 each game says what it is like: PASS' },
      exitReason: 'engine_closed_the_turn', commitRange: { base: 'aaaa', head: '293dc1cfbd02d0591b61086b8b3bf849375d2734' }, turns: 2,
      graderProbes: { total: 59, probes: 0, uninspectable: 0 }, ledger: 'missions.0004.jsonl:3',
    })
    // A row with no campaignId field at all is no campaign too, and a timed-out check says so.
    expect(r2.campaignId).toBeNull()
    expect(r2.check).toEqual({ command: 'node gate_t2.mjs', result: 'timed out', tail: '' })
    expect(r2.graderProbes).toBeNull()
    expect(r2.commitRange).toBeNull()
  })

  it('links a mission to its campaign: by the ledger\'s campaignId, or by the runner campaign\'s waves.jsonl for an older row', async () => {
    writeCampaigns()
    const data = await (await get('/api/mission-history')).json()
    const by = (id: string) => data.missions.find((m: any) => m.missionId === id)
    expect(by('c11-wave2-1791237906699')).toMatchObject({ campaignId: 'c11', campaignFrom: 'ledger', campaignLink: 'c11' })
    expect(by('c8-wave2-1789649392765')).toMatchObject({ campaignId: 'c8', campaignFrom: 'waves', campaignLink: 'c8', ledger: 'missions.jsonl:1' })
    // An authoring run names a campaign id with no campaign directory: grouped, never linked.
    expect(by('brief-1-1790962309082')).toMatchObject({ campaignId: 'c11-author', campaignFrom: 'ledger', campaignLink: null })
    expect(data.groups).toEqual([
      { campaignId: null, count: 2 },
      { campaignId: 'c11', count: 1 },
      { campaignId: 'c11-author', count: 1 },
      { campaignId: 'c8', count: 1 },
    ])
  })

  it('pages with offset and limit, and filters by campaign or by none', async () => {
    writeCampaigns()
    const page = await (await get('/api/mission-history?offset=1&limit=2')).json()
    expect(page).toMatchObject({ total: 5, offset: 1, limit: 2 })
    expect(page.missions.map((m: any) => m.missionId)).toEqual(['t1-brief-1794596799340', 'c11-wave2-1791237906699'])
    const none = await (await get('/api/mission-history?campaign=none')).json()
    expect(none.total).toBe(2)
    expect(none.missions.every((m: any) => m.campaignId === null)).toBe(true)
    const c8 = await (await get('/api/mission-history?campaign=c8')).json()
    expect(c8.missions.map((m: any) => m.missionId)).toEqual(['c8-wave2-1789649392765'])
    // Malformed paging is the default, not a 400; the limit is capped.
    const odd = await (await get('/api/mission-history?offset=-3&limit=abc')).json()
    expect(odd).toMatchObject({ offset: 0, limit: 25 })
    expect((await (await get('/api/mission-history?limit=5000')).json()).limit).toBe(100)
  })

  it('a hand-run series recorded under CYNCO_CAMPAIGN_ID groups without a runner campaign behind it', async () => {
    writeCampaigns()
    const shard = join(ledgerDir, 'missions.0004.jsonl')
    appendFileSync(shard, row({ missionId: 't3-brief-1794700000000', campaignId: 'partynight-cast', cwd: 'C:/Users/civer/casino', dispatchedAt: '2026-11-14T08:00:00.000Z', outcome: 'landed', verified: true }) + '\n')
    // The shard is re-read because its size moved (mtime may not, inside a second).
    try {
      const data = await (await get('/api/mission-history?campaign=partynight-cast')).json()
      expect(data.missions.map((m: any) => m.missionId)).toEqual(['t3-brief-1794700000000'])
      expect(data.missions[0]).toMatchObject({ campaignId: 'partynight-cast', campaignFrom: 'ledger', campaignLink: null })
      const all = await (await get('/api/mission-history?limit=1')).json()
      expect(all.total).toBe(6)
      expect(all.missions[0].missionId).toBe('t3-brief-1794700000000')
    } finally { writeLedger() }
  })

  it('a row caught mid-append keeps the rows read before and names the shard', async () => {
    writeCampaigns()
    const shard = join(ledgerDir, 'missions.0004.jsonl')
    // Read once so the shard is cached, then leave a half-written line in it.
    expect((await (await get('/api/mission-history')).json()).total).toBe(5)
    appendFileSync(shard, '{"missionId":"half')
    utimesSync(shard, new Date(), new Date(Date.now() + 5000))
    try {
      const data = await (await get('/api/mission-history')).json()
      expect(data.total).toBe(5)
      expect(data.errors).toHaveLength(1)
      expect(data.errors[0]).toMatch(/^missions\.0004\.jsonl: could not be re-read, showing the rows read before/)
    } finally { writeLedger() }
  })

  it('is a read: the inference token opens it, no token is refused', async () => {
    writeCampaigns()
    expect((await get('/api/mission-history', null)).status).toBe(401)
    expect((await get('/api/mission-history', READ)).status).toBe(200)
  })
})

describe('missionHistory pieces', () => {
  it('says what a check said in words', () => {
    expect(checkResult({ exitCode: 1 })).toBe('exit 1')
    expect(checkResult({ spawnFailed: true, exitCode: null })).toBe('did not start')
    expect(checkResult({ harnessFault: 'gate printed no terminator' })).toBe('harness fault: gate printed no terminator')
    expect(checkResult({})).toBe('no result recorded')
  })
  it('reduces a row with nothing in it to nulls, never to guesses', () => {
    const r = reduceLedgerRow({}, { shard: 'C:/x/missions.0002.jsonl', line: 4 })
    expect(r).toMatchObject({ missionId: 'missions.0002.jsonl:5', campaignId: null, cwd: null, verified: null, check: null, turns: null, graderProbes: null, ledger: 'missions.0002.jsonl:5' })
  })
  it('reads the query string, with defaults for anything malformed', () => {
    expect(missionHistoryQuery(new URL('http://x/api/mission-history'))).toEqual({ offset: 0, limit: 25, campaign: null })
    expect(missionHistoryQuery(new URL('http://x/api/mission-history?offset=50&limit=10&campaign=%20c8%20'))).toEqual({ offset: 50, limit: 10, campaign: 'c8' })
  })
  it('a ledger reader that does not load is an error on the page, not a throw', async () => {
    const h = new MissionHistory({ load: () => Promise.reject(new Error('no such module')) })
    const page = await h.page({ campaignsDir: join(tmpdir(), 'nowhere-' + Date.now()) })
    expect(page.missions).toEqual([])
    expect(page.errors[0]).toMatch(/cynco-ledger-shards\.mjs did not load \(no such module\)/)
  })
})
