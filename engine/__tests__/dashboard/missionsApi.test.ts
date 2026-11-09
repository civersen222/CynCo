import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { patchTrigger, readMissionsView, setPaused, type MissionsPaths } from '../../dashboard/missionsApi.js'
import { applySchedule, cadenceFingerprint, writeSchedule } from '../../daemon/schedule.js'
import { computeNextFire } from '../../daemon/scheduler.js'
import type { MissionConfig } from '../../daemon/types.js'

const NOW = new Date('2026-11-08T12:00:00')
let root: string
let p: MissionsPaths
let mdir: string

const mission: MissionConfig = {
  id: 'mfl-dynasty',
  goal: 'Run the dynasty rebuild',
  cwd: 'C:/work',
  leagues: [],
  trustLadder: {},
  triggers: [
    { id: 'dynasty-tin-trades', kind: 'cron', cron: '25 7-21/2 * * *', precheck: 'command', precheckCommand: 'x', missedPolicy: 'skip', prompt: 'p' },
    { id: 'dynasty-tin-daily', kind: 'daily', at: '11:15', precheck: 'none', missedPolicy: 'run-once-on-startup', prompt: 'p', timeoutMs: 600000 },
  ],
} as MissionConfig

function seen() {
  return Object.fromEntries(mission.triggers.map((t) => [t.id, cadenceFingerprint(t)]))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'missions-api-'))
  const missionsDir = join(root, 'missions')
  mdir = join(missionsDir, 'mfl-dynasty')
  mkdirSync(mdir, { recursive: true })
  writeFileSync(join(mdir, 'mission.json'), JSON.stringify(mission))
  writeFileSync(join(mdir, 'state.json'), JSON.stringify({
    nextFire: { 'dynasty-tin-trades': '2026-11-08T13:25:00.000Z', 'dynasty-tin-daily': '2026-11-09T11:15:00.000Z' },
    scheduleSeen: seen(),
  }))
  const runs = [
    { ts: '2026-11-08T09:00:00.000Z', triggerId: 'dynasty-tin-trades', ok: true, summary: 'precheck skipped the pass: "skip: no incoming offers"', recommendationIds: [] },
    { ts: '2026-11-08T09:10:00.000Z', triggerId: 'dynasty-tin-daily', ok: false, summary: 'timed out', recommendationIds: [] },
    { ts: '2026-11-08T09:20:00.000Z', triggerId: 'dynasty-tin-daily', ok: true, summary: 'paused on request after 3 min', recommendationIds: [] },
  ]
  writeFileSync(join(mdir, 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  p = { missionsDir, controlPath: join(root, 'daemon-control.json'), gpuBusyPath: join(root, 'gpu-busy.json'), now: () => NOW }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const row = (id: string) => readMissionsView(p).missions[0].triggers.find((t) => t.id === id)!

describe('missionsApi', () => {
  it('lists missions with cadence words, names, next fire from state and the newest run per trigger', () => {
    const v = readMissionsView(p)
    expect(v.paused.paused).toBe(false)
    expect(v.missions).toHaveLength(1)
    const m = v.missions[0]
    expect(m.goal).toBe('Run the dynasty rebuild')
    expect(m.cwd).toBe('C:/work')
    const trades = m.triggers.find((t) => t.id === 'dynasty-tin-trades')!
    const daily = m.triggers.find((t) => t.id === 'dynasty-tin-daily')!
    expect(trades.name).toBe('tin trades')
    expect(trades.cadenceText).toBe('every 2 hours, 7:25 AM to 9:25 PM')
    expect(trades.lastRun?.kind).toBe('skip')
    expect(daily.lastRun?.kind).toBe('paused')
    expect(daily.timeoutMs).toBe(600000)
    expect(trades.nextFire).toBe('2026-11-08T13:25:00.000Z')
    expect(trades.nextFirePreview).toBe(false)
    expect(trades.enabled).toBe(true)
  })

  it('marks nextFire as a preview when the override fingerprint is not yet in scheduleSeen', () => {
    writeSchedule(mdir, (s) => ({ ...s, triggers: { 'dynasty-tin-trades': { cron: '25 9-17/4 * * *' } } }))
    const t = row('dynasty-tin-trades')
    expect(t.nextFirePreview).toBe(true)
    expect(t.overridden).toEqual(['cron'])
    const eff = applySchedule(mission.triggers, { triggers: { 'dynasty-tin-trades': { cron: '25 9-17/4 * * *' } } }).triggers[0]
    expect(t.nextFire).toBe(computeNextFire(eff, NOW).toISOString())
  })

  it('reports orphans and running', () => {
    writeSchedule(mdir, (s) => ({ ...s, triggers: { 'ghost-trigger': { enabled: false } } }))
    writeFileSync(p.gpuBusyPath!, JSON.stringify({ task: 'mfl-dynasty', triggerId: 'dynasty-tin-daily', startedAt: '2026-11-08T11:00:00.000Z', timeoutMs: 900000, pid: process.pid }))
    const m = readMissionsView(p).missions[0]
    expect(m.orphans).toEqual(['ghost-trigger'])
    expect(m.running).toEqual({ triggerId: 'dynasty-tin-daily', since: '2026-11-08T11:00:00.000Z', timeoutMs: 900000 })
  })

  it('patchTrigger merges, validates and returns the row; reset removes the override', () => {
    const off = patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-daily', { enabled: false })
    expect(off.status).toBe(200)
    expect((off.json as any).enabled).toBe(false)
    const both = patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-daily', { at: '08:00' })
    expect(both.status).toBe(200)
    expect((both.json as any).enabled).toBe(false)
    expect((both.json as any).overridden).toEqual(['enabled', 'at'])
    expect(patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-trades', { cron: '99 * * * *' }).status).toBe(400)
    const bad = patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-daily', { cron: '0 8 * * *' })
    expect(bad.status).toBe(400)
    const reset = patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-daily', { reset: true })
    expect(reset.status).toBe(200)
    expect((reset.json as any).overridden).toEqual([])
    expect((reset.json as any).enabled).toBe(true)
  })

  it('patchTrigger: a second cadence shape change replaces the first, keeping enabled and timeoutMs', () => {
    const stored = (id: string) => JSON.parse(readFileSync(join(mdir, 'schedule.json'), 'utf-8')).triggers[id]
    // tin trades (cron) -> daily 13:00 -> every 4 hours
    expect(patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-trades', { kind: 'daily', at: '13:00' }).status).toBe(200)
    expect(patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-trades', { enabled: false, timeoutMs: 120000 }).status).toBe(200)
    const every = patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-trades', { kind: 'cron', cron: '25 9-17/4 * * *' })
    expect(every.status).toBe(200)
    expect(stored('dynasty-tin-trades')).toEqual({ enabled: false, timeoutMs: 120000, kind: 'cron', cron: '25 9-17/4 * * *' })
    // tin daily (daily) -> every 3 hours -> daily 13:00
    expect(patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-daily', { kind: 'cron', cron: '0 7-21/3 * * *' }).status).toBe(200)
    const daily = patchTrigger(p, 'mfl-dynasty', 'dynasty-tin-daily', { kind: 'daily', at: '13:00' })
    expect(daily.status).toBe(200)
    expect(stored('dynasty-tin-daily')).toEqual({ kind: 'daily', at: '13:00' })
    expect((daily.json as any).cadenceText).toBe('daily at 1:00 PM')
  })

  it('patchTrigger 404s an unknown mission or trigger', () => {
    expect(patchTrigger(p, 'nope', 'dynasty-tin-daily', { enabled: false }).status).toBe(404)
    expect(patchTrigger(p, 'mfl-dynasty', 'nope', { enabled: false }).status).toBe(404)
    expect(patchTrigger(p, '../x', 'dynasty-tin-daily', {}).status).toBe(400)
    expect(existsSync(join(mdir, 'schedule.json'))).toBe(false)
  })

  it('setPaused writes by: dashboard and readMissionsView reflects it', () => {
    const c = setPaused(p, true)
    expect(c.paused).toBe(true)
    expect(JSON.parse(readFileSync(p.controlPath, 'utf-8')).by).toBe('dashboard')
    expect(readMissionsView(p).paused.paused).toBe(true)
    setPaused(p, false)
    expect(readMissionsView(p).paused.paused).toBe(false)
  })
})
