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

export function computeNextFire(t: TriggerSpec, from: Date): Date {
  if (t.kind === 'interval') {
    return new Date(from.getTime() + (t.everyMinutes ?? 60) * 60000)
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
