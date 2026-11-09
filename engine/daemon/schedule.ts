// engine/daemon/schedule.ts
// Per-mission schedule overrides: `<missionDir>/schedule.json` lets the owner switch a trigger
// off, move its cadence, or change its timeout without editing mission.json. Pure module — the
// daemon re-reads the file every tick and the dashboard writes it; neither is imported here.
// Only the fields in TriggerOverride can be overridden: precheck, missedPolicy, prompt, tools
// stay with mission.json.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { validateCron } from './scheduler.js'
import type { TriggerSpec, Weekday } from './types.js'

export const SCHEDULE_FILE_NAME = 'schedule.json'

export type TriggerOverride = {
  enabled?: boolean
  kind?: TriggerSpec['kind']
  cron?: string
  at?: string
  day?: TriggerSpec['day']
  everyMinutes?: number
  timeoutMs?: number
}

export type Schedule = { updatedAt?: string; triggers: Record<string, TriggerOverride> }

export type ReadScheduleResult = { schedule: Schedule; status: 'ok' | 'absent' | 'bad'; mtimeMs: number | null }

const KINDS: TriggerSpec['kind'][] = ['interval', 'daily', 'weekly', 'cron']
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Override keys in the order applySchedule reports them. */
const OVERRIDE_KEYS = ['enabled', 'kind', 'cron', 'at', 'day', 'everyMinutes', 'timeoutMs'] as const

export const MIN_TIMEOUT_MS = 60_000
export const MAX_TIMEOUT_MS = 7_200_000

function scheduleFile(missionDir: string): string {
  return join(missionDir, SCHEDULE_FILE_NAME)
}

/** Reads schedule.json. Absent and unreadable files both mean "no overrides"; `status` says which. */
export function readSchedule(missionDir: string): ReadScheduleResult {
  const path = scheduleFile(missionDir)
  if (!existsSync(path)) return { schedule: { triggers: {} }, status: 'absent', mtimeMs: null }
  let mtimeMs: number | null = null
  try {
    mtimeMs = statSync(path).mtimeMs
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { updatedAt?: unknown; triggers?: unknown }
    if (!raw || typeof raw !== 'object' || !raw.triggers || typeof raw.triggers !== 'object' || Array.isArray(raw.triggers)) {
      return { schedule: { triggers: {} }, status: 'bad', mtimeMs }
    }
    const triggers: Record<string, TriggerOverride> = {}
    for (const [id, o] of Object.entries(raw.triggers as Record<string, unknown>)) {
      const v = validateOverride(o)
      if (!v.ok) return { schedule: { triggers: {} }, status: 'bad', mtimeMs }
      triggers[id] = v.value
    }
    return {
      schedule: { ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}), triggers },
      status: 'ok',
      mtimeMs,
    }
  } catch {
    return { schedule: { triggers: {} }, status: 'bad', mtimeMs }
  }
}

/** Read-modify-write, atomically (tmp in the same dir, then rename). A bad file is replaced from empty. */
export function writeSchedule(missionDir: string, patch: (s: Schedule) => Schedule): Schedule {
  const next: Schedule = { ...patch(readSchedule(missionDir).schedule), updatedAt: new Date().toISOString() }
  const path = scheduleFile(missionDir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
  return next
}

export type EffectiveTrigger = TriggerSpec & { enabled: boolean; overridden: (keyof TriggerOverride)[] }

/** Lays the overrides over the declared triggers (mission.json order). Overrides for undeclared ids are orphans. */
export function applySchedule(
  triggers: TriggerSpec[],
  schedule: Schedule,
): { triggers: EffectiveTrigger[]; orphans: string[] } {
  const ids = new Set(triggers.map((t) => t.id))
  const orphans = Object.keys(schedule.triggers).filter((id) => !ids.has(id))
  const effective = triggers.map((t): EffectiveTrigger => {
    const o = schedule.triggers[t.id] ?? {}
    const merged: EffectiveTrigger = { ...t, enabled: o.enabled ?? true, overridden: [] }
    for (const key of OVERRIDE_KEYS) {
      if (o[key] === undefined) continue
      const base = key === 'enabled' ? true : t[key]
      if (o[key] === base) continue
      merged.overridden.push(key)
      if (key !== 'enabled') (merged as unknown as Record<string, unknown>)[key] = o[key]
    }
    return merged
  })
  return { triggers: effective, orphans }
}

function clock12(h: number, m: number): string {
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

function atTime(at: string | undefined): string {
  const [h, m] = (at ?? '00:00').split(':').map(Number)
  return clock12(h || 0, m || 0)
}

/** The cadence in words: "every 2 hours, 7:25 AM to 9:25 PM", "Thursdays at 7:45 PM", "daily at 11:15 AM". */
export function describeCadence(t: TriggerSpec): string {
  if (t.kind === 'interval') return `every ${t.everyMinutes ?? 60} minutes`
  if (t.kind === 'daily') return `daily at ${atTime(t.at)}`
  if (t.kind === 'weekly') return `${WEEKDAY_NAMES[WEEKDAYS.indexOf(t.day ?? 'sun')]}s at ${atTime(t.at)}`
  const expr = (t.cron ?? '').trim()
  const stepped = /^(\d{1,2}) (\d{1,2})-(\d{1,2})\/(\d+) \* \* \*$/.exec(expr)
  if (stepped) {
    const [m, h1, h2, n] = stepped.slice(1).map(Number)
    const last = h1 + Math.floor((h2 - h1) / n) * n
    return `every ${n} hours, ${clock12(h1, m)} to ${clock12(last, m)}`
  }
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7])$/.exec(expr)
  if (weekly) {
    const [m, h, d] = weekly.slice(1).map(Number)
    return `${WEEKDAY_NAMES[d % 7]}s at ${clock12(h, m)}`
  }
  return `cron ${expr}`
}

/** Identity of a trigger's cadence — enabled and timeoutMs deliberately do not move it. */
export function cadenceFingerprint(t: TriggerSpec): string {
  return `${t.kind}|${t.cron ?? ''}|${t.at ?? ''}|${t.day ?? ''}|${t.everyMinutes ?? ''}`
}

/** Checks one trigger's override; unknown keys (precheck, missedPolicy, ...) are dropped, not errors. */
export function validateOverride(o: unknown): { ok: true; value: TriggerOverride } | { ok: false; error: string } {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'override must be an object' }
  const r = o as Record<string, unknown>
  const value: TriggerOverride = {}
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' }
    value.enabled = r.enabled
  }
  if (r.kind !== undefined) {
    if (!KINDS.includes(r.kind as TriggerSpec['kind'])) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` }
    value.kind = r.kind as TriggerSpec['kind']
  }
  if (r.cron !== undefined) {
    if (typeof r.cron !== 'string') return { ok: false, error: 'cron must be a string' }
    const bad = validateCron(r.cron)
    if (bad) return { ok: false, error: bad }
    value.cron = r.cron
  }
  if (r.at !== undefined) {
    if (typeof r.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.at)) return { ok: false, error: 'at must be HH:MM (24-hour)' }
    value.at = r.at
  }
  if (r.day !== undefined) {
    if (!WEEKDAYS.includes(r.day as Weekday)) return { ok: false, error: `day must be one of ${WEEKDAYS.join(' ')}` }
    value.day = r.day as Weekday
  }
  if (r.everyMinutes !== undefined) {
    if (!Number.isInteger(r.everyMinutes) || (r.everyMinutes as number) < 1 || (r.everyMinutes as number) > 1440) {
      return { ok: false, error: 'everyMinutes must be a whole number from 1 to 1440' }
    }
    value.everyMinutes = r.everyMinutes as number
  }
  if (r.timeoutMs !== undefined) {
    if (!Number.isInteger(r.timeoutMs) || (r.timeoutMs as number) < MIN_TIMEOUT_MS || (r.timeoutMs as number) > MAX_TIMEOUT_MS) {
      return { ok: false, error: `timeoutMs must be a whole number from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}` }
    }
    value.timeoutMs = r.timeoutMs as number
  }
  return { ok: true, value }
}
