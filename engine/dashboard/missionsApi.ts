/**
 * engine/dashboard/missionsApi.ts — the dashboard's read/write over the daemon's files.
 *
 * No IPC: the daemon (process A) and the dashboard (process B) share `<missionsDir>/<id>/{mission.json,
 * state.json, runs.jsonl, schedule.json}`, the control file and the GPU-busy claim. This module is the pure
 * file layer; the HTTP routes and the page sit on top of it.
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { readTail } from '../daemon/awayFeed.js'
import { readControl, writeControl, type DaemonControl } from '../daemon/control.js'
import { readGpuBusy } from '../daemon/gpuBusyFile.js'
import {
  applySchedule,
  cadenceFingerprint,
  describeCadence,
  readSchedule,
  validateOverride,
  writeSchedule,
  type EffectiveTrigger,
  type TriggerOverride,
} from '../daemon/schedule.js'
import { computeNextFire } from '../daemon/scheduler.js'
import type { MissionConfig, MissionState, RunRecord, TriggerSpec } from '../daemon/types.js'

export type MissionsPaths = { missionsDir: string; controlPath: string; gpuBusyPath?: string; now?: () => Date }
export type LastRun = { ts: string; ok: boolean; kind: 'go' | 'skip' | 'fail' | 'paused' | 'dropped'; summary: string }
export type TriggerView = {
  id: string
  name: string
  kind: TriggerSpec['kind']
  cron?: string
  at?: string
  day?: string
  everyMinutes?: number
  cadenceText: string
  enabled: boolean
  overridden: string[]
  timeoutMs: number | null
  missedPolicy: string
  precheck: string
  nextFire: string | null
  nextFirePreview: boolean
  lastRun: LastRun | null
}
export type MissionView = {
  id: string
  goal: string
  cwd: string | null
  running: { triggerId: string; since: string; timeoutMs: number } | null
  triggers: TriggerView[]
  orphans: string[]
  /** readSchedule's verdict. On 'bad' the daemon runs on its last good overrides, which this view cannot see. */
  scheduleStatus: 'ok' | 'absent' | 'bad'
  error?: string
}
export type MissionsView = { paused: DaemonControl; missions: MissionView[] }

const TAIL_BYTES = 64 * 1024
const ID_RE = /^[a-z0-9-]+$/i
const CADENCE_KEYS: readonly string[] = ['kind', 'cron', 'at', 'day', 'everyMinutes']

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T } catch { return null }
}

/** `dynasty-tin-trades` -> `tin trades`: drop the mission prefix (first dash-segment), dashes to spaces. */
function triggerName(id: string): string {
  const i = id.indexOf('-')
  return (i >= 0 ? id.slice(i + 1) : id).replace(/-/g, ' ')
}

function runKind(ok: boolean, summary: string): LastRun['kind'] {
  if (!ok) return 'fail'
  if (summary.startsWith('precheck skipped')) return 'skip'
  if (summary.startsWith('paused on request')) return 'paused'
  if (summary.startsWith('dropped on disable')) return 'dropped'
  return 'go'
}

/** Newest run per trigger from the bounded tail of runs.jsonl. */
function lastRuns(missionDir: string): Map<string, LastRun> {
  const out = new Map<string, LastRun>()
  const file = join(missionDir, 'runs.jsonl')
  if (!existsSync(file)) return out
  let text: string
  try { text = readTail(file, TAIL_BYTES) } catch { return out }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as RunRecord
      if (typeof r?.ts !== 'string' || typeof r?.triggerId !== 'string') continue
      const summary = typeof r.summary === 'string' ? r.summary : ''
      const prev = out.get(r.triggerId)
      if (!prev || r.ts >= prev.ts) out.set(r.triggerId, { ts: r.ts, ok: Boolean(r.ok), kind: runKind(Boolean(r.ok), summary), summary })
    } catch { continue } // a torn or foreign line in an append-only log
  }
  return out
}

function nextFireOf(t: EffectiveTrigger, state: MissionState | null, now: Date): { nextFire: string | null; preview: boolean } {
  const stored = state?.nextFire?.[t.id] ?? null
  if (!t.enabled) return { nextFire: stored, preview: false }
  const seen = state?.scheduleSeen?.[t.id]
  const preview = seen === undefined ? t.overridden.some((k) => CADENCE_KEYS.includes(k)) : seen !== cadenceFingerprint(t)
  if (!preview) return { nextFire: stored, preview: false }
  try { return { nextFire: computeNextFire(t, now).toISOString(), preview: true } } catch { return { nextFire: null, preview: false } }
}

function triggerView(t: EffectiveTrigger, mission: MissionConfig, state: MissionState | null, runs: Map<string, LastRun>, now: Date): TriggerView {
  const { nextFire, preview } = nextFireOf(t, state, now)
  return {
    id: t.id,
    name: triggerName(t.id),
    kind: t.kind,
    ...(t.cron !== undefined ? { cron: t.cron } : {}),
    ...(t.at !== undefined ? { at: t.at } : {}),
    ...(t.day !== undefined ? { day: t.day } : {}),
    ...(t.everyMinutes !== undefined ? { everyMinutes: t.everyMinutes } : {}),
    cadenceText: describeCadence(t),
    enabled: t.enabled,
    overridden: t.overridden as string[],
    timeoutMs: t.timeoutMs ?? mission.timeoutMs ?? null,
    missedPolicy: t.missedPolicy,
    precheck: t.precheck,
    nextFire,
    nextFirePreview: preview,
    lastRun: runs.get(t.id) ?? null,
  }
}

function missionView(p: MissionsPaths, dirName: string, now: Date): MissionView | null {
  const dir = join(p.missionsDir, dirName)
  const file = join(dir, 'mission.json')
  if (!existsSync(file)) return null
  let mission: MissionConfig
  try {
    mission = JSON.parse(readFileSync(file, 'utf-8')) as MissionConfig
  } catch (e) {
    return { id: dirName, goal: '', cwd: null, running: null, triggers: [], orphans: [], scheduleStatus: readSchedule(dir).status, error: e instanceof Error ? e.message : String(e) }
  }
  const state = readJson<MissionState>(join(dir, 'state.json'))
  const sched = readSchedule(dir)
  const { triggers, orphans } = applySchedule(mission.triggers ?? [], sched.schedule)
  const runs = lastRuns(dir)
  const busy = readGpuBusy(p.gpuBusyPath)
  return {
    id: dirName,
    goal: String(mission.goal ?? '').slice(0, 200),
    cwd: mission.cwd ?? null,
    running: busy && busy.task === dirName ? { triggerId: busy.triggerId, since: busy.startedAt, timeoutMs: busy.timeoutMs } : null,
    triggers: triggers.map((t) => triggerView(t, mission, state, runs, now)),
    orphans,
    scheduleStatus: sched.status,
  }
}

export function readMissionsView(p: MissionsPaths): MissionsView {
  const now = p.now?.() ?? new Date()
  let names: string[] = []
  try { names = readdirSync(p.missionsDir).sort() } catch { names = [] } // no missions dir yet
  const missions: MissionView[] = []
  for (const name of names) {
    const v = missionView(p, name, now)
    if (v) missions.push(v)
  }
  return { paused: readControl(p.controlPath), missions }
}

/** Why an effective trigger is not a coherent schedule, or null. */
function scheduleProblem(t: EffectiveTrigger, o: TriggerOverride, now: Date): string | null {
  const applies: Record<string, TriggerSpec['kind'][]> = { cron: ['cron'], at: ['daily', 'weekly'], day: ['weekly'], everyMinutes: ['interval'] }
  for (const [key, kinds] of Object.entries(applies)) {
    if ((o as Record<string, unknown>)[key] !== undefined && !kinds.includes(t.kind)) return `${key} does not apply to a ${t.kind} trigger (set kind too)`
  }
  try { computeNextFire(t, now); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
}

export function patchTrigger(p: MissionsPaths, missionId: string, triggerId: string, body: unknown): { status: number; json: unknown } {
  if (!ID_RE.test(missionId) || !ID_RE.test(triggerId)) return { status: 400, json: { error: 'invalid id' } }
  const dir = join(p.missionsDir, missionId)
  const mission = readJson<MissionConfig>(join(dir, 'mission.json'))
  if (!mission) return { status: 404, json: { error: `unknown mission ${missionId}` } }
  const spec = (mission.triggers ?? []).find((t) => t.id === triggerId)
  if (!spec) return { status: 404, json: { error: `unknown trigger ${triggerId}` } }
  // An unreadable file reads as empty: writing over it would drop every other override the daemon still
  // honours from memory (its last good set). Refuse until the owner fixes or deletes it.
  if (readSchedule(dir).status === 'bad') return { status: 409, json: { error: 'schedule.json is unreadable; fix or delete it before editing' } }
  const now = p.now?.() ?? new Date()
  const reset = !!body && typeof body === 'object' && (body as Record<string, unknown>).reset === true
  let next: TriggerOverride | null = null
  if (!reset) {
    const v = validateOverride(body)
    if (!v.ok) return { status: 400, json: { error: v.error } }
    // A body that names any cadence field carries the whole new shape: drop the old shape's fields first,
    // or a stale `at` or `cron` survives a daily <-> cron change and the result is rejected.
    const existing: TriggerOverride = { ...(readSchedule(dir).schedule.triggers[triggerId] ?? {}) }
    if (CADENCE_KEYS.some((k) => (v.value as Record<string, unknown>)[k] !== undefined)) {
      for (const k of CADENCE_KEYS) delete (existing as Record<string, unknown>)[k]
    }
    next = { ...existing, ...v.value }
    const eff = applySchedule([spec], { triggers: { [triggerId]: next } }).triggers[0]
    const problem = scheduleProblem(eff, next, now)
    if (problem) return { status: 400, json: { error: `override does not produce a valid schedule: ${problem}` } }
  }
  writeSchedule(dir, (s) => {
    const triggers = { ...s.triggers }
    if (next) triggers[triggerId] = next
    else delete triggers[triggerId]
    return { ...s, triggers }
  })
  const row = readMissionsView(p).missions.find((m) => m.id === missionId)?.triggers.find((t) => t.id === triggerId)
  return { status: 200, json: row }
}

export function setPaused(p: MissionsPaths, paused: boolean): DaemonControl {
  return writeControl(p.controlPath, paused, 'dashboard')
}
