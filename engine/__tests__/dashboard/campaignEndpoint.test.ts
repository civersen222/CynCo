/**
 * GET /api/campaign — the campaign-recursion readout for the 9161 dashboard.
 *
 * Reads scripts/cynco-campaign.mjs's on-disk state (`~/.cynco/campaigns/<id>/
 * state.json` + `waves.jsonl`) the same way the runner writes it, and never
 * caches beyond the request — a campaign the operator just approved a proposal
 * on must show the new state on the next poll, not the one from ten seconds
 * ago.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// @ts-expect-error — .mjs script, no types; the roadmap's own status vocabulary.
import { STATUSES } from '../../../scripts/cynco-roadmap.mjs'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

const _tokenDir = mkdtempSync(join(tmpdir(), 'cynco-dash-test-'))
const _tokens = loadOrCreateTokens(_tokenDir)
const _ADMIN = _tokens.tokenFor('management')!
process.on('exit', () => rmSync(_tokenDir, { recursive: true, force: true }))

function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${_ADMIN}`)
  return fetch(url, { ...init, headers })
}

let server: DashboardServer
let BASE: string
let CYNCO_HOME: string
const savedCyncoHome = process.env.CYNCO_HOME
const savedCampaignId = process.env.CYNCO_CAMPAIGN_ID

beforeAll(async () => {
  server = new DashboardServer({ port: 0, tokens: _tokens })
  // Poll until the server is ready (max 2 s) instead of a fixed sleep — the
  // shim's http.createServer().listen() binds asynchronously even though real
  // Bun.serve() binds synchronously, so a fixed wait is a race under vitest.
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const port = server.getPort()
    if (port > 0) {
      try { await authFetch(`http://localhost:${port}/api/campaign`); break } catch { /* not ready yet */ }
    }
    await new Promise(r => setTimeout(r, 10))
  }
  BASE = `http://localhost:${server.getPort()}`
})

afterAll(() => {
  server.stop()
  if (savedCyncoHome === undefined) delete process.env.CYNCO_HOME
  else process.env.CYNCO_HOME = savedCyncoHome
  if (savedCampaignId === undefined) delete process.env.CYNCO_CAMPAIGN_ID
  else process.env.CYNCO_CAMPAIGN_ID = savedCampaignId
})

afterEach(() => {
  if (CYNCO_HOME) rmSync(CYNCO_HOME, { recursive: true, force: true })
  delete process.env.CYNCO_CAMPAIGN_ID
})

function writeCampaign(home: string, id: string, state: Record<string, unknown>, waves: Record<string, unknown>[] = []) {
  const dir = join(home, 'campaigns', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ id, ...state }, null, 2))
  if (waves.length) {
    writeFileSync(join(dir, 'waves.jsonl'), waves.map(w => JSON.stringify(w)).join('\n') + '\n')
  }
}

describe('GET /api/campaign', () => {
  it('answers { active: null, campaigns: [] } when the campaigns dir is empty', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-empty-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: null, campaigns: [] })
  })

  it('answers { active: null, campaigns: [] } when CYNCO_HOME itself does not exist', async () => {
    CYNCO_HOME = join(tmpdir(), 'cynco-campaign-missing-' + Date.now())
    process.env.CYNCO_HOME = CYNCO_HOME
    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: null, campaigns: [] })
  })

  it('reports two campaigns, the inFlight one active, waves + proposals + budget shaped per the brief', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-two-'))
    process.env.CYNCO_HOME = CYNCO_HOME

    // c8: two waves, the second carrying governancePosiwid; a pending cap
    // proposal on invariants/editGapCap — the real docs/civkings-redesign-briefs/
    // c8.campaign.json (budget.waves: 8) is checked into this repo, so budgetWaves
    // comes back from the real spec rather than a fixture.
    writeCampaign(CYNCO_HOME, 'c8', {
      waveCount: 2,
      lastBase: 'deadbeef',
      lastFails: ['C8.1a.tiers-pressable', 'C8.2b.portraits-distinct-and-stable'],
      ideationAuthority: 0.3,
      invariantOverrides: { editGapCap: 60 },
      proposals: [
        {
          type: 'Parameter', name: 'invariants/editGapCap', newValue: 60, currentValue: 40,
          bounds: { min: 40, max: 80 }, status: 'pending', proposedAt: '2026-09-20T00:00:00.000Z',
        },
      ],
      governancePosiwid: { windows: [{ wave: 1 }, { wave: 2 }] },
    }, [
      { wave: 1, decision: { kind: 'next', why: '2 line(s) still FAIL' }, gate: { terminator: 'MISS' },
        posiwid: { verdict: 'Consistent', divergence: 0.05 }, verified: true },
      { wave: 2, decision: { kind: 'next', why: '1 line(s) still FAIL' },
        gate: { terminator: 'MISS', fails: [{ id: 'C8.2b.portraits-distinct-and-stable', line: 'C8.2b.portraits-distinct-and-stable: FAIL two houses share a portrait hash' }] },
        posiwid: { verdict: 'Consistent', divergence: 0.02 }, verified: true,
        governancePosiwid: { verdict: 'Consistent', divergence: 0.01, dominantObserved: 'inspect', support: 5, onsetWave: null, counts: { wave: 2 } } },
    ])

    // c9: no waves yet, inFlight set — this is the active campaign.
    writeCampaign(CYNCO_HOME, 'c9', {
      waveCount: 0,
      inFlight: { wave: 1, missionId: null, briefFile: 'docs/civkings-redesign-briefs/c9-wave1.txt', pidFile: 'C:/tmp/c9.pid', driverLog: 'C:/tmp/c9.log', dispatchedAt: '2026-09-21T00:00:00.000Z' },
    })

    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    const data = await res.json() as any

    expect(data.active).toBe('c9')
    expect(data.campaigns).toHaveLength(2)

    const c8 = data.campaigns.find((c: any) => c.id === 'c8')
    const c9 = data.campaigns.find((c: any) => c.id === 'c9')
    expect(c8).toBeTruthy()
    expect(c9).toBeTruthy()

    // c8: waves, proposals, invariant overrides, ideation authority verbatim.
    expect(c8.waveCount).toBe(2)
    // Spec r9: verbatim gate lines off the last wave record, NOT state.lastFails' ids.
    expect(c8.lastFails).toEqual(['C8.2b.portraits-distinct-and-stable: FAIL two houses share a portrait hash'])
    expect(c8.ideationAuthority).toBe(0.3)
    expect(c8.invariantOverrides).toEqual({ editGapCap: 60 })
    expect(c8.lastDecision).toEqual({ kind: 'next', why: '1 line(s) still FAIL' })
    expect(c8.inFlight).toBeNull()
    expect(c8.budgetWaves).toBe(8)

    expect(c8.waves).toHaveLength(2)
    expect(c8.waves[0]).toEqual({ wave: 1, decision: { kind: 'next', why: '2 line(s) still FAIL' }, posiwid: { verdict: 'Consistent', divergence: 0.05 }, governancePosiwid: null, verified: true })
    expect(c8.waves[1].governancePosiwid).toEqual({ verdict: 'Consistent', onsetWave: null })
    expect(c8.governancePosiwid).toEqual({ verdict: 'Consistent', divergence: 0.01, dominantObserved: 'inspect', support: 5, onsetWave: null, counts: { wave: 2 } })

    expect(c8.pendingProposals).toHaveLength(1)
    expect(c8.pendingProposals[0]).toEqual({
      name: 'invariants/editGapCap',
      currentValue: 40,
      newValue: 60,
      max: 80,
      approveCommand: 'bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c8.campaign.json --approve-proposal invariants/editGapCap',
      type: 'Parameter',
      decidedBy: null,
    })
    // Neither fixture ran the gate-authoring verb.
    expect(c8.authoring).toBeNull()
    expect(c8.gateAuthorAuthority).toBe(0)

    // c9: no spec file on disk for this id -> budgetWaves null; inFlight passed through.
    expect(c9.waveCount).toBe(0)
    expect(c9.budgetWaves).toBeNull()
    expect(c9.lastFails).toEqual([])
    expect(c9.lastDecision).toBeNull()
    expect(c9.waves).toEqual([])
    expect(c9.pendingProposals).toEqual([])
    expect(c9.inFlight).toEqual({ wave: 1, missionId: null, briefFile: 'docs/civkings-redesign-briefs/c9-wave1.txt', pidFile: 'C:/tmp/c9.pid', driverLog: 'C:/tmp/c9.log', dispatchedAt: '2026-09-21T00:00:00.000Z' })

    // The real checked-in roadmap.json (c6..c9) — read cwd-relative, same as
    // budgetWaves reads the real c8.campaign.json above.
    //
    // The STATUS is read from that file rather than written here. A roadmap
    // line's status is exactly what the runner advances (`open → authoring →
    // proposed → sealed → running → done`), so pinning today's value would
    // make the first real `--author` run fail this test — it did, on the live
    // C9 run, which left c9 at `authoring`. What the endpoint owes the panel is
    // a faithful projection of the file to {id, name, status}, and that is what
    // is asserted.
    const onDisk = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'civkings-redesign-briefs', 'roadmap.json'), 'utf-8'))
    expect(data.roadmap).toHaveLength(onDisk.lines.length)
    expect(data.roadmap).toEqual(onDisk.lines.map((l: any) => ({ id: l.id, name: l.name, status: l.status })))
    const c9Line = data.roadmap.find((r: any) => r.id === 'c9')
    expect(c9Line.name).toBe('Ship shell')
    expect(STATUSES).toContain(c9Line.status)
  })

  it('authoring state and a gate/<id> proposal carry the shape the panel needs', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-authoring-'))
    process.env.CYNCO_HOME = CYNCO_HOME

    // c9 has no docs/civkings-redesign-briefs/c9.campaign.json in this repo,
    // so the gate/c9 proposal's approve command is built from the roadmap id
    // (== the campaign directory id) alone — no spec file needed (Task 4).
    writeCampaign(CYNCO_HOME, 'c9', {
      waveCount: 0,
      gateAuthorAuthority: 0.2,
      authoring: {
        c9: {
          missionId: 'mission-c9-author-1',
          verified: true,
          sealedAt: '2026-09-22T00:00:00.000Z',
          lastCheck: { at: '2026-09-22T00:00:00.000Z', ok: false, problems: ['C9.1a.saves-list-restores: no BASE MISS'], lineCount: 3 },
        },
      },
      proposals: [
        {
          type: 'Code', name: 'gate/c9', description: 'Seal the CynCo-authored gate triple for c9',
          status: 'pending', proposedAt: '2026-09-22T00:00:00.000Z',
          evidence: { lineCount: 3, problems: [], missionId: 'mission-c9-author-1', verified: true },
        },
      ],
    })

    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    const c9 = data.campaigns.find((c: any) => c.id === 'c9')

    expect(c9.gateAuthorAuthority).toBe(0.2)
    expect(c9.authoring).toEqual({
      missionId: 'mission-c9-author-1',
      verified: true,
      sealedAt: '2026-09-22T00:00:00.000Z',
      lastCheck: { ok: false, problems: ['C9.1a.saves-list-restores: no BASE MISS'] },
    })

    expect(c9.pendingProposals).toHaveLength(1)
    expect(c9.pendingProposals[0]).toEqual({
      name: 'gate/c9',
      currentValue: null,
      newValue: undefined,
      max: null,
      approveCommand: 'bun scripts/cynco-campaign.mjs docs/civkings-redesign-briefs/c9.campaign.json --approve-proposal gate/c9',
      type: 'Code',
      decidedBy: null,
    })
  })

  it('roadmap is null when docs/civkings-redesign-briefs/roadmap.json cannot be read', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-noroadmap-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    writeCampaign(CYNCO_HOME, 'c8', { waveCount: 1 })

    // readRoadmap reads cwd-relative, same as readCampaignBudget — chdir
    // somewhere with no docs/civkings-redesign-briefs/roadmap.json, same
    // technique engine/__tests__/config.test.ts uses to isolate cwd-relative
    // reads, then restore cwd so later tests still see the real repo files.
    const noRoadmapDir = mkdtempSync(join(tmpdir(), 'cynco-campaign-noroadmap-cwd-'))
    const savedCwd = process.cwd()
    process.chdir(noRoadmapDir)
    try {
      const res = await authFetch(`${BASE}/api/campaign`)
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.roadmap).toBeNull()
    } finally {
      process.chdir(savedCwd)
      rmSync(noRoadmapDir, { recursive: true, force: true })
    }
  })

  it('reduces a dispatched-but-not-yet-checked authoring record (no lastCheck key) to lastCheck: null', async () => {
    // scripts/cynco-gate-author.mjs writes exactly this shape at dispatch
    // time (authorCampaign, before checkStaged has run): missionId null (not
    // yet known), verified null, fault null, and no `lastCheck` key at all —
    // the key is only added once the check runs. reduceAuthoring must not
    // synthesize a lastCheck out of nothing for this in-flight state.
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-authoring-inflight-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    writeCampaign(CYNCO_HOME, 'c9', {
      waveCount: 0,
      authoring: {
        c9: {
          stagingDir: 'C:/tmp/c9-author-staging', baseDir: 'C:/civkings',
          briefFile: 'C:/tmp/c9-author-brief.txt', attempts: 1,
          dispatchedAt: '2026-09-22T00:00:00.000Z', missionId: null, verified: null, fault: null,
        },
      },
    })

    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    const c9 = (await res.json() as any).campaigns.find((c: any) => c.id === 'c9')
    expect(c9.authoring).toEqual({ missionId: null, verified: null, sealedAt: null, lastCheck: null })
  })

  it('a malformed lastCheck.problems (not an array) reduces to problems: []', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-authoring-badproblems-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    writeCampaign(CYNCO_HOME, 'c9', {
      waveCount: 0,
      authoring: {
        c9: {
          missionId: 'mission-c9-author-1', verified: false, sealedAt: null,
          lastCheck: { at: '2026-09-22T00:00:00.000Z', ok: false, problems: 'not an array', lineCount: 0 },
        },
      },
    })

    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    const c9 = (await res.json() as any).campaigns.find((c: any) => c.id === 'c9')
    expect(c9.authoring).toEqual({
      missionId: 'mission-c9-author-1',
      verified: false,
      sealedAt: null,
      lastCheck: { ok: false, problems: [] },
    })
  })

  it('falls back to state.lastFails ids when the last wave record carries no gate.fails', async () => {
    // A wave recorded before the gate lines were kept (or a harness fault that
    // wrote no fails) must still show something. Ids are worse than lines, but
    // they are what that campaign has.
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-failsfallback-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    writeCampaign(CYNCO_HOME, 'c8', { waveCount: 1, lastFails: ['C8.1a.tiers-pressable'] }, [
      { wave: 1, decision: { kind: 'next', why: '1 line(s) still FAIL' }, gate: { terminator: 'MISS' }, verified: true },
    ])

    const res = await authFetch(`${BASE}/api/campaign`)
    const c8 = (await res.json() as any).campaigns.find((c: any) => c.id === 'c8')
    expect(c8.lastFails).toEqual(['C8.1a.tiers-pressable'])
  })

  it('falls back to CYNCO_CAMPAIGN_ID when no campaign is inFlight', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-env-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    writeCampaign(CYNCO_HOME, 'c8', { waveCount: 1 })
    process.env.CYNCO_CAMPAIGN_ID = 'c8'

    const res = await authFetch(`${BASE}/api/campaign`)
    const data = await res.json() as any
    expect(data.active).toBe('c8')
  })

  it('active is null when nothing is inFlight and CYNCO_CAMPAIGN_ID is unset', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-noenv-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    writeCampaign(CYNCO_HOME, 'c8', { waveCount: 1 })

    const res = await authFetch(`${BASE}/api/campaign`)
    const data = await res.json() as any
    expect(data.active).toBeNull()
  })

  it('a corrupt state.json is skipped rather than crashing the whole endpoint', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-corrupt-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    mkdirSync(join(CYNCO_HOME, 'campaigns', 'broken'), { recursive: true })
    writeFileSync(join(CYNCO_HOME, 'campaigns', 'broken', 'state.json'), '{ not json')
    writeCampaign(CYNCO_HOME, 'c8', { waveCount: 1 })

    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.campaigns.map((c: any) => c.id)).toEqual(['c8'])
  })

  // Review finding (fix round 1): readCampaignSummary's own try/catch only
  // covers the state.json JSON.parse and each waves.jsonl line parse. Anything
  // ELSE it throws — proposals present but not an array from a partial write,
  // readFileSync(wavesPath) itself failing — used to escape to getCampaign's
  // outer catch and wipe the ENTIRE response (every healthy campaign along
  // with the broken one) down to { active: null, campaigns: [], error }.
  it('a campaign whose proposals is not an array is skipped, not fatal to the whole response', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-badprops-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    // proposals: {} — valid JSON, invalid shape. (state.proposals ?? []).filter(...)
    // throws TypeError: state.proposals.filter is not a function.
    writeCampaign(CYNCO_HOME, 'broken', { waveCount: 1, proposals: {} })
    writeCampaign(CYNCO_HOME, 'c8', { waveCount: 1 })

    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.error).toBeUndefined()
    expect(data.campaigns.map((c: any) => c.id)).toEqual(['c8'])
  })

  it('a campaign whose waves.jsonl is a directory (not a file) is skipped, not fatal to the whole response', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-wavesdir-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    writeCampaign(CYNCO_HOME, 'broken', { waveCount: 1 })
    // readFileSync(wavesPath) throws EISDIR — a directory where waves.jsonl belongs.
    mkdirSync(join(CYNCO_HOME, 'campaigns', 'broken', 'waves.jsonl'), { recursive: true })
    writeCampaign(CYNCO_HOME, 'c8', { waveCount: 1 })

    const res = await authFetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.error).toBeUndefined()
    expect(data.campaigns.map((c: any) => c.id)).toEqual(['c8'])
  })

  it('requires a token like every other read route', async () => {
    CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-campaign-auth-'))
    process.env.CYNCO_HOME = CYNCO_HOME
    const res = await fetch(`${BASE}/api/campaign`)
    expect(res.status).toBe(401)
  })
})
