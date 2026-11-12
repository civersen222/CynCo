/**
 * engine/power/reporter/jobs.ts — the daemon's scheduled-job runs, as events.
 *
 * Each mission's `runs.jsonl` (`engine/daemon/missionLedger.ts`, `RunRecord`)
 * is appended once per run. A line becomes one `job.run` event stamped with
 * the run's own `ts`, so a run reported late (the watcher was unreachable, or
 * this is the first look) still lands where it happened. Read-only.
 */
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { FileTail, withoutCr } from './logTail.js'
import type { WatchEvent } from './types.js'

const SUMMARY_MAX = 160

export function jobEvents(mission: string, lines: string[]): WatchEvent[] {
  const out: WatchEvent[] = []
  for (const raw of lines) {
    const line = withoutCr(raw) // JSON.parse would forgive it; the rule is that no reader of lines depends on that (F231)
    if (!line.trim()) continue
    let r: Record<string, unknown>
    try { r = JSON.parse(line) as Record<string, unknown> } catch { continue } // a torn line: the next look has it whole or not at all
    if (!r || typeof r.ts !== 'string' || typeof r.triggerId !== 'string' || !Number.isFinite(Date.parse(r.ts))) continue
    out.push({
      t: 'event', at: r.ts, kind: 'job.run', key: `${mission}/${r.triggerId}/${r.ts}`,
      data: { mission, triggerId: r.triggerId, ok: r.ok === true, summary: typeof r.summary === 'string' ? r.summary.slice(0, SUMMARY_MAX) : '' },
    })
  }
  return out
}

/** One tail per mission's `runs.jsonl`; `offsets` (by mission id) is what the last look left. */
export class JobTails {
  private readonly tails = new Map<string, FileTail>()

  constructor(private readonly missionsDir: string, private readonly offsets: Record<string, number> = {}) {}

  read(): WatchEvent[] {
    if (!existsSync(this.missionsDir)) return []
    const out: WatchEvent[] = []
    for (const entry of readdirSync(this.missionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      let tail = this.tails.get(entry.name)
      if (!tail) {
        tail = new FileTail(join(this.missionsDir, entry.name, 'runs.jsonl'), this.offsets[entry.name] ?? null)
        this.tails.set(entry.name, tail)
      }
      out.push(...jobEvents(entry.name, tail.read()))
    }
    return out
  }

  /** Where each tail stands, to persist. */
  positions(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, tail] of this.tails) if (tail.offset !== null) out[name] = tail.offset
    return out
  }
}
