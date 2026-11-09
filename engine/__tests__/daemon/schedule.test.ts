// engine/__tests__/daemon/schedule.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SCHEDULE_FILE_NAME, applySchedule, cadenceFingerprint, describeCadence, readSchedule, validateOverride, writeSchedule,
} from '../../daemon/schedule.js'
import type { TriggerSpec } from '../../daemon/types.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cynco-sched-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const base = { precheck: 'none', missedPolicy: 'skip', prompt: 'p' } as const
const t = (o: Partial<TriggerSpec> & { id: string; kind: TriggerSpec['kind'] }): TriggerSpec => ({ ...base, ...o })

describe('readSchedule', () => {
  it('absent file reads as no overrides with status absent', () => {
    expect(readSchedule(dir)).toEqual({ schedule: { triggers: {} }, status: 'absent', mtimeMs: null })
  })

  it('a malformed file reads as status bad with empty overrides', () => {
    writeFileSync(join(dir, SCHEDULE_FILE_NAME), '{"triggers": {', 'utf-8')
    const r = readSchedule(dir)
    expect(r.status).toBe('bad')
    expect(r.schedule).toEqual({ triggers: {} })
    expect(typeof r.mtimeMs).toBe('number')
  })
})

describe('applySchedule', () => {
  it('spreads enabled/cron/timeoutMs over the trigger and lists overridden keys', () => {
    const trig = t({ id: 't', kind: 'cron', cron: '25 7-21/2 * * *' })
    const r = applySchedule([trig], { triggers: { t: { enabled: false, cron: '25 9-17/4 * * *', timeoutMs: 600000 } } })
    expect(r.orphans).toEqual([])
    expect(r.triggers[0].enabled).toBe(false)
    expect(r.triggers[0].cron).toBe('25 9-17/4 * * *')
    expect(r.triggers[0].timeoutMs).toBe(600000)
    expect(r.triggers[0].overridden).toEqual(['enabled', 'cron', 'timeoutMs'])
  })

  it('an override for an undeclared trigger is reported as an orphan and applied to nothing', () => {
    const r = applySchedule([t({ id: 'a', kind: 'daily', at: '11:15' })], { triggers: { ghost: { enabled: false } } })
    expect(r.orphans).toEqual(['ghost'])
    expect(r.triggers).toHaveLength(1)
    expect(r.triggers[0].enabled).toBe(true)
    expect(r.triggers[0].overridden).toEqual([])
  })

  it('omitted enabled means enabled and a value equal to the base is not overridden', () => {
    const r = applySchedule([t({ id: 'a', kind: 'daily', at: '11:15' })], { triggers: { a: { at: '11:15' } } })
    expect(r.triggers[0].enabled).toBe(true)
    expect(r.triggers[0].overridden).toEqual([])
  })

  it('precheck and missedPolicy in an override are ignored', () => {
    const v = validateOverride({ enabled: false, precheck: 'command', missedPolicy: 'run-once-on-startup' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value).toEqual({ enabled: false })
  })
})

describe('writeSchedule', () => {
  it('is atomic and sets updatedAt; a second write merges', () => {
    writeSchedule(dir, (s) => ({ ...s, triggers: { ...s.triggers, a: { enabled: false } } }))
    const out = writeSchedule(dir, (s) => ({ ...s, triggers: { ...s.triggers, b: { timeoutMs: 120000 } } }))
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(existsSync(join(dir, SCHEDULE_FILE_NAME))).toBe(true)
    expect(new Date(out.updatedAt!).toISOString()).toBe(out.updatedAt!)
    const r = readSchedule(dir)
    expect(r.status).toBe('ok')
    expect(Object.keys(r.schedule.triggers).sort()).toEqual(['a', 'b'])
    expect(r.schedule.updatedAt).toBe(out.updatedAt)
  })
})

describe('describeCadence', () => {
  it('words', () => {
    expect(describeCadence(t({ id: 'x', kind: 'cron', cron: '25 7-21/2 * * *' }))).toBe('every 2 hours, 7:25 AM to 9:25 PM')
    expect(describeCadence(t({ id: 'x', kind: 'daily', at: '11:15' }))).toBe('daily at 11:15 AM')
    expect(describeCadence(t({ id: 'x', kind: 'cron', cron: '45 19 * * 4' }))).toBe('Thursdays at 7:45 PM')
    expect(describeCadence(t({ id: 'x', kind: 'interval', everyMinutes: 90 }))).toBe('every 90 minutes')
    expect(describeCadence(t({ id: 'x', kind: 'cron', cron: '5 10 * * 2' }))).toBe('Tuesdays at 10:05 AM')
  })

  it('weekly, midnight/noon, a step that stops short of the end, and unrecognised crons', () => {
    expect(describeCadence(t({ id: 'x', kind: 'weekly', day: 'sun', at: '12:00' }))).toBe('Sundays at 12:00 PM')
    expect(describeCadence(t({ id: 'x', kind: 'daily', at: '00:05' }))).toBe('daily at 12:05 AM')
    expect(describeCadence(t({ id: 'x', kind: 'cron', cron: '25 9-18/4 * * *' }))).toBe('every 4 hours, 9:25 AM to 5:25 PM')
    expect(describeCadence(t({ id: 'x', kind: 'cron', cron: '*/10 * * * *' }))).toBe('cron */10 * * * *')
  })
})

describe('cadenceFingerprint', () => {
  it('ignores enabled and timeoutMs and changes with cron', () => {
    const a = t({ id: 'x', kind: 'cron', cron: '25 7-21/2 * * *' })
    expect(cadenceFingerprint(a)).toBe('cron|25 7-21/2 * * *|||')
    expect(cadenceFingerprint({ ...a, timeoutMs: 1 })).toBe(cadenceFingerprint(a))
    expect(cadenceFingerprint({ ...a, cron: '25 9-17/4 * * *' })).not.toBe(cadenceFingerprint(a))
  })
})

describe('validateOverride', () => {
  it('rejects a cron that never fires, an at that is not HH:MM, timeoutMs outside 60000..7200000', () => {
    expect(validateOverride({ cron: '0 0 31 2 *' }).ok).toBe(false)
    expect(validateOverride({ cron: '99 * * * *' }).ok).toBe(false)
    expect(validateOverride({ at: '25:00' }).ok).toBe(false)
    expect(validateOverride({ at: '9:5' }).ok).toBe(false)
    expect(validateOverride({ timeoutMs: 59999 }).ok).toBe(false)
    expect(validateOverride({ timeoutMs: 7200001 }).ok).toBe(false)
    expect(validateOverride({ everyMinutes: 0 }).ok).toBe(false)
    expect(validateOverride({ day: 'someday' }).ok).toBe(false)
    expect(validateOverride({ kind: 'monthly' }).ok).toBe(false)
    expect(validateOverride('nope').ok).toBe(false)
    const ok = validateOverride({ cron: '25 9-17/4 * * *', at: '09:30', timeoutMs: 60000, everyMinutes: 1440, day: 'thu' })
    expect(ok.ok).toBe(true)
  })
})
