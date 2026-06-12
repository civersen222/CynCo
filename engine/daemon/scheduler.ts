// engine/daemon/scheduler.ts
// Pure trigger arithmetic — no I/O, no Date.now(). Local time semantics.
import type { TriggerSpec, Weekday } from './types.js'

const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Grace window: a fire time missed by more than this is "missed" (missedPolicy applies). */
export const GRACE_MS = 10 * 60 * 1000

function parseAt(at: string): { h: number; m: number } {
  const [h, m] = at.split(':').map(Number)
  return { h: h || 0, m: m || 0 }
}

// Expand one cron field ("*", "5", "1-5", "*/15", "0,30", "10-20/2") into a value set.
function parseCronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart, ...rest] = part.split('/')
    const step = stepPart !== undefined ? Number(stepPart) : 1
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min; hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      lo = a; hi = b
    } else {
      lo = Number(rangePart)
      // "N/step" means "from N to max, stepping" (vixie-cron extension)
      hi = stepPart !== undefined ? max : lo
    }
    if (
      rest.length > 0 || rangePart === '' ||
      !Number.isInteger(lo) || !Number.isInteger(hi) || !Number.isInteger(step) ||
      step < 1 || lo < min || hi > max || lo > hi
    ) {
      throw new Error(`Invalid cron field "${field}" (expected ${min}-${max})`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** Next local-time match of a 5-field cron expression, strictly after `from`. */
function nextCronFire(expr: string, from: Date): Date {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Invalid cron expression "${expr}" (expected 5 fields)`)
  const minutes = parseCronField(fields[0], 0, 59)
  const hours = parseCronField(fields[1], 0, 23)
  const doms = parseCronField(fields[2], 1, 31)
  const months = parseCronField(fields[3], 1, 12)
  // 0 and 7 both mean Sunday
  const dows = new Set([...parseCronField(fields[4], 0, 7)].map((d) => d % 7))

  // POSIX semantics: when BOTH day-of-month and day-of-week are restricted,
  // a day matches if EITHER does; otherwise the restricted one decides.
  const domRestricted = fields[2] !== '*'
  const dowRestricted = fields[4] !== '*'
  const dayMatches = (d: Date): boolean => {
    const domOk = doms.has(d.getDate())
    const dowOk = dows.has(d.getDay())
    if (domRestricted && dowRestricted) return domOk || dowOk
    if (domRestricted) return domOk
    if (dowRestricted) return dowOk
    return true
  }

  const c = new Date(from)
  c.setSeconds(0, 0)
  c.setMinutes(c.getMinutes() + 1) // strictly after `from`
  // Walk forward field-by-field; bounded to 4 years (covers Feb-29-only crons)
  const limit = from.getTime() + 4 * 366 * 24 * 3600 * 1000
  while (c.getTime() <= limit) {
    if (!months.has(c.getMonth() + 1)) {
      c.setMonth(c.getMonth() + 1, 1)
      c.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(c)) {
      c.setDate(c.getDate() + 1)
      c.setHours(0, 0, 0, 0)
      continue
    }
    if (!hours.has(c.getHours())) {
      c.setHours(c.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!minutes.has(c.getMinutes())) {
      c.setMinutes(c.getMinutes() + 1, 0, 0)
      continue
    }
    return c
  }
  throw new Error(`Cron expression "${expr}" never fires within 4 years`)
}

export function computeNextFire(t: TriggerSpec, from: Date): Date {
  if (t.kind === 'interval') {
    return new Date(from.getTime() + (t.everyMinutes ?? 60) * 60000)
  }
  if (t.kind === 'cron') {
    if (!t.cron) throw new Error(`Trigger "${t.id}": kind "cron" requires a cron expression`)
    return nextCronFire(t.cron, from)
  }
  const { h, m } = parseAt(t.at ?? '00:00')
  const next = new Date(from)
  next.setHours(h, m, 0, 0)
  if (t.kind === 'daily') {
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
    return next
  }
  // weekly
  const targetDow = WEEKDAYS.indexOf(t.day ?? 'sun')
  let delta = (targetDow - next.getDay() + 7) % 7
  if (delta === 0 && next.getTime() <= from.getTime()) delta = 7
  next.setDate(next.getDate() + delta)
  return next
}

export type TriggerEvaluation =
  | { action: 'wait' }
  | { action: 'init'; next: Date }
  | { action: 'fire'; next: Date }
  | { action: 'skip'; next: Date }

export function evaluateTrigger(t: TriggerSpec, nextFireIso: string | undefined, now: Date): TriggerEvaluation {
  if (!nextFireIso) {
    return { action: 'init', next: computeNextFire(t, now) }
  }
  const due = new Date(nextFireIso)
  if (now.getTime() < due.getTime()) return { action: 'wait' }

  const next = computeNextFire(t, now)
  const missedByMs = now.getTime() - due.getTime()
  if (missedByMs > GRACE_MS && t.missedPolicy === 'skip') {
    return { action: 'skip', next }
  }
  return { action: 'fire', next }
}
