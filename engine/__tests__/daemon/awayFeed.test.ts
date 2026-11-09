import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectAwayRuns } from '../../daemon/awayFeed.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cynco-away-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function mission(name: string, lines: string[]) {
  mkdirSync(join(dir, name))
  writeFileSync(join(dir, name, 'runs.jsonl'), lines.join('\n') + '\n', 'utf-8')
}

describe('collectAwayRuns', () => {
  it('merges every mission newest first and names the mission', () => {
    mission('fantasy-digest', [
      JSON.stringify({ ts: '2026-11-08T19:45:29Z', triggerId: 'digest-espn', ok: true, summary: 'Published the espn card', recommendationIds: [] }),
      JSON.stringify({ ts: '2026-11-08T20:15:10Z', triggerId: 'digest-tin-card', ok: false, summary: 'snapshot UNREADABLE', recommendationIds: [] }),
    ])
    mission('mfl-dynasty', [
      JSON.stringify({ ts: '2026-11-08T20:00:00Z', triggerId: 'transaction-watch', ok: true, summary: 'no change', recommendationIds: [] }),
    ])
    const runs = collectAwayRuns(dir)
    expect(runs.map(r => r.triggerId)).toEqual(['digest-tin-card', 'transaction-watch', 'digest-espn'])
    expect(runs[0]).toEqual({ ts: '2026-11-08T20:15:10Z', mission: 'fantasy-digest', triggerId: 'digest-tin-card', ok: false, summary: 'snapshot UNREADABLE' })
  })

  it('skips a line that is not JSON and keeps the rest', () => {
    mission('m', ['{not json', JSON.stringify({ ts: '2026-11-08T10:00:00Z', triggerId: 't', ok: true, summary: 's', recommendationIds: [] })])
    expect(collectAwayRuns(dir).length).toBe(1)
  })

  it('returns [] for a missing directory and ignores folders without runs.jsonl', () => {
    expect(collectAwayRuns(join(dir, 'nope'))).toEqual([])
    mkdirSync(join(dir, 'empty-mission'))
    expect(collectAwayRuns(dir)).toEqual([])
  })

  it('honours the limit and reads only the tail of a big file', () => {
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ ts: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), triggerId: `t${i}`, ok: true, summary: 'x'.repeat(2000), recommendationIds: [] }))
    mission('big', lines)
    const runs = collectAwayRuns(dir, { limit: 5, tailBytes: 64 * 1024 })
    expect(runs.length).toBe(5)
    expect(runs[0].triggerId).toBe('t299')
  })
})
