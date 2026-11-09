// /api/missions + /api/daemon/pause: the mission schedule switches, inference scope.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DashboardServer } from '../../dashboard/server.js'
import { loadOrCreateTokens } from '../../security/localToken.js'
import type { MissionsPaths } from '../../dashboard/missionsApi.js'
import type { MissionConfig } from '../../daemon/types.js'

const mission = {
  id: 'mfl-dynasty', goal: 'Run the dynasty rebuild', cwd: 'C:/work', leagues: [], trustLadder: {},
  triggers: [
    { id: 'dynasty-tin-trades', kind: 'cron', cron: '25 7-21/2 * * *', precheck: 'command', precheckCommand: 'x', missedPolicy: 'skip', prompt: 'p' },
    { id: 'dynasty-tin-daily', kind: 'daily', at: '11:15', precheck: 'none', missedPolicy: 'run-once-on-startup', prompt: 'p', timeoutMs: 600000 },
  ],
} as MissionConfig

let root: string
let mdir: string
let p: MissionsPaths
const servers: DashboardServer[] = []
afterEach(() => { for (const s of servers.splice(0)) s.stop() })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'missions-routes-'))
  const missionsDir = join(root, 'missions')
  mdir = join(missionsDir, 'mfl-dynasty')
  mkdirSync(mdir, { recursive: true })
  writeFileSync(join(mdir, 'mission.json'), JSON.stringify(mission))
  p = { missionsDir, controlPath: join(root, 'daemon-control.json'), gpuBusyPath: join(root, 'gpu-busy.json') }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function start(missions?: MissionsPaths) {
  const tokens = loadOrCreateTokens(root)
  const server = new DashboardServer({ port: 0, tokens, deps: { remoteAddress: () => '127.0.0.1', onCommand: () => {}, ...(missions ? { missions } : {}) } })
  servers.push(server)
  await new Promise(r => setTimeout(r, 100))
  const base = `http://127.0.0.1:${server.getPort()}`
  const auth = { Authorization: `Bearer ${tokens.tokenFor('inference')!}`, 'Content-Type': 'application/json' }
  return { base, auth }
}

describe('mission schedule routes', () => {
  it('GET /api/missions lists the missions and their triggers', async () => {
    const { base, auth } = await start(p)
    const r = await fetch(`${base}/api/missions`, { headers: auth })
    expect(r.status).toBe(200)
    const v = await r.json() as any
    expect(v.missions[0].triggers.length).toBe(2)
  })

  it('PUT a trigger with the inference token changes the file', async () => {
    const { base, auth } = await start(p)
    const r = await fetch(`${base}/api/missions/mfl-dynasty/triggers/dynasty-tin-trades`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: false }) })
    expect(r.status).toBe(200)
    expect((await r.json() as any).enabled).toBe(false)
    expect(readFileSync(join(mdir, 'schedule.json'), 'utf8')).toContain('dynasty-tin-trades')
  })

  it('PUT on a mission whose schedule.json is unreadable is 409 and leaves the file alone', async () => {
    const { base, auth } = await start(p)
    writeFileSync(join(mdir, 'schedule.json'), '{"triggers": {')
    const r = await fetch(`${base}/api/missions/mfl-dynasty/triggers/dynasty-tin-trades`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: false }) })
    expect(r.status).toBe(409)
    expect((await r.json() as any).error).toBe('schedule.json is unreadable; fix or delete it before editing')
    expect(readFileSync(join(mdir, 'schedule.json'), 'utf8')).toBe('{"triggers": {')
  })

  it('PUT with no token is 401', async () => {
    const { base } = await start(p)
    const r = await fetch(`${base}/api/missions/mfl-dynasty/triggers/dynasty-tin-trades`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' })
    expect(r.status).toBe(401)
  })

  it('an unknown trigger is 404', async () => {
    const { base, auth } = await start(p)
    const r = await fetch(`${base}/api/missions/mfl-dynasty/triggers/nope`, { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: false }) })
    expect(r.status).toBe(404)
  })

  it('POST /api/daemon/pause writes the control file as the dashboard', async () => {
    const { base, auth } = await start(p)
    const r = await fetch(`${base}/api/daemon/pause`, { method: 'POST', headers: auth, body: JSON.stringify({ paused: true }) })
    expect(r.status).toBe(200)
    expect(JSON.parse(readFileSync(p.controlPath, 'utf8'))).toMatchObject({ paused: true, by: 'dashboard' })
  })

  it('POST /api/daemon/pause refuses a non-boolean', async () => {
    const { base, auth } = await start(p)
    const r = await fetch(`${base}/api/daemon/pause`, { method: 'POST', headers: auth, body: JSON.stringify({ paused: 'yes' }) })
    expect(r.status).toBe(400)
  })

  it('unwired: GET is empty, writes are 503', async () => {
    const { base, auth } = await start()
    expect(await (await fetch(`${base}/api/missions`, { headers: auth })).json()).toEqual({ paused: { paused: false }, missions: [] })
    const put = await fetch(`${base}/api/missions/a/triggers/b`, { method: 'PUT', headers: auth, body: '{}' })
    expect(put.status).toBe(503)
    expect(await put.json()).toEqual({ error: 'missions not wired' })
    const post = await fetch(`${base}/api/daemon/pause`, { method: 'POST', headers: auth, body: '{"paused":true}' })
    expect(post.status).toBe(503)
  })
})
