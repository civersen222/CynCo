/**
 * engine/daemon/awayFeed.ts — "while you were away": what the missions did.
 *
 * Read-only. Tails every `<missionsDir>/<mission>/runs.jsonl` (the ledger's
 * append-only run records, `RunRecord` in types.ts), merges them newest first
 * and caps the count. Bounded on purpose: only the last `tailBytes` of each
 * file are read, a line that is not JSON is skipped, a missing directory is
 * `[]`. Served by the dashboard as `GET /api/away` (inference scope) for the
 * phone's Away tab. Design: docs/decisions/2026-11-08-wakefulness-design.md (slice 4).
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

export type AwayRun = { ts: string; mission: string; triggerId: string; ok: boolean; summary: string }

const DEFAULT_LIMIT = 50
const DEFAULT_TAIL_BYTES = 256 * 1024

function readTail(path: string, tailBytes: number): string {
  const size = statSync(path).size
  const start = Math.max(0, size - tailBytes)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try { readSync(fd, buf, 0, buf.length, start) } finally { closeSync(fd) }
  const text = buf.toString('utf-8')
  // A tail cut mid-line: drop the first partial line.
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
}

export function collectAwayRuns(missionsDir: string, opts: { limit?: number; tailBytes?: number } = {}): AwayRun[] {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES
  if (!existsSync(missionsDir)) return []
  const out: AwayRun[] = []
  let entries: string[]
  try { entries = readdirSync(missionsDir) } catch (e) { console.log(`[away] cannot list ${missionsDir}: ${e instanceof Error ? e.message : String(e)}`); return [] }
  for (const mission of entries) {
    const file = join(missionsDir, mission, 'runs.jsonl')
    if (!existsSync(file)) continue
    let text: string
    try { text = readTail(file, tailBytes) } catch (e) { console.log(`[away] cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`); continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        if (typeof r?.ts !== 'string' || typeof r?.triggerId !== 'string') continue
        out.push({ ts: r.ts, mission, triggerId: r.triggerId, ok: Boolean(r.ok), summary: typeof r.summary === 'string' ? r.summary : '' })
      } catch (e) {
        // a torn or foreign line in an append-only log: skip it, keep the rest
        console.log(`[away] skipped a line in ${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return out.slice(0, limit)
}
