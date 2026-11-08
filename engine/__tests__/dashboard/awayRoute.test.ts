// GET /api/away: the phone's "while you were away" list — inference scope,
// `{ runs: [] }` when the engine wired no provider (wakefulness slice 4).
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'

const dirs: string[] = []
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop() })
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function start(getAwayRuns?: () => any[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-away-route-'))
  dirs.push(dir)
  const tokens = loadOrCreateTokens(dir)
  const server = new DashboardServer({ port: 0, tokens, deps: { remoteAddress: () => '127.0.0.1', onCommand: () => {}, ...(getAwayRuns ? { getAwayRuns } : {}) } })
  servers.push(server)
  await new Promise(r => setTimeout(r, 100))
  const base = `http://127.0.0.1:${server.getPort()}`
  const inference = tokens.tokenFor('inference')!
  return { base, inference }
}

describe('GET /api/away', () => {
  it('needs the inference token', async () => {
    const { base } = await start()
    const r = await fetch(`${base}/api/away`)
    expect(r.status).toBe(401)
  })
  it('returns the wired runs', async () => {
    const run = { ts: '2026-11-08T20:15:10Z', mission: 'fantasy-digest', triggerId: 'digest-tin-card', ok: true, summary: 'Published the tin card' }
    const { base, inference } = await start(() => [run])
    const r = await fetch(`${base}/api/away`, { headers: { Authorization: `Bearer ${inference}` } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ runs: [run] })
  })
  it('returns an empty list when nothing is wired', async () => {
    const { base, inference } = await start()
    const r = await fetch(`${base}/api/away`, { headers: { Authorization: `Bearer ${inference}` } })
    expect(await r.json()).toEqual({ runs: [] })
  })
})
