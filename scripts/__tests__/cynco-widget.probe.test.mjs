// cynco-widget.ps1 -Probe: the GPU line plus one "mission|<id>|<next>|<last>" line per mission.
// Named .mjs because vitest.config.ts only includes scripts/__tests__/**/*.test.mjs.
// Skipped where powershell is not on PATH (Linux CI).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dirname, '..', 'cynco-widget.ps1')
const hasPs = !spawnSync('powershell', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).error
if (!hasPs) console.warn('cynco-widget probe test skipped: powershell is not on PATH')

const WHEN = String.raw`(?:\w{3} )?\d\d:\d\d` // Format-When: HH:mm today, else "ddd HH:mm"
let root, missions, control, stateFile
const w = (p, o) => writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o))

function probe(extra = []) {
  const r = spawnSync('powershell', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Probe',
    '-MissionsDir', missions, '-ControlFile', control, '-StateFile', stateFile, ...extra], { encoding: 'utf8', timeout: 60000 })
  expect(r.status).toBe(0)
  return r.stdout.split(/\r?\n/).filter(Boolean)
}
const mline = (lines, id) => lines.find(l => l.startsWith(`mission|${id}|`))?.split('|')

describe.skipIf(!hasPs)('cynco-widget -Probe mission lines', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'widget-probe-'))
    missions = join(root, 'missions'); control = join(root, 'daemon-control.json'); stateFile = join(root, 'widget.json')
    const a = join(missions, 'alpha'), b = join(missions, 'beta'), c = join(missions, 'gamma'), d = join(missions, 'delta')
    for (const x of [a, b, c, d]) mkdirSync(x, { recursive: true })
    w(join(a, 'mission.json'), { id: 'alpha', triggers: [{ id: 'dynasty-tin-trades' }, { id: 'dynasty-tin-daily' }] })
    w(join(a, 'state.json'), { nextFire: { 'dynasty-tin-trades': '2031-01-01T04:00:00.000Z', 'dynasty-tin-daily': '2031-01-02T18:00:00.000Z', 'dynasty-gone': '2030-01-01T00:00:00.000Z' } })
    w(join(a, 'schedule.json'), { triggers: { 'dynasty-tin-trades': { enabled: false } } })
    w(join(a, 'runs.jsonl'), [
      { ts: '2031-01-01T01:00:00.000Z', triggerId: 'dynasty-tin-daily', ok: true, summary: 'did things' },
      { ts: '2031-01-01T03:00:00.000Z', triggerId: 'dynasty-tin-trades', ok: true, summary: 'precheck skipped: no incoming offers' },
    ].map(r => JSON.stringify(r)).join('\n') + '\n{"ts":"2031-01-0')
    w(join(b, 'mission.json'), { id: 'beta', triggers: [{ id: 'fantasy-weekly-digest' }] })
    w(join(b, 'state.json'), { nextFire: { 'fantasy-weekly-digest': '2031-01-03T15:00:00.000Z' } })
    w(join(b, 'runs.jsonl'), JSON.stringify({ ts: '2031-01-01T02:00:00.000Z', triggerId: 'fantasy-weekly-digest', ok: false, summary: 'boom' }) + '\n')
    // newest record first, an older one (within 7 h, so a UTC-vs-local mix-up would pick it) last
    w(join(d, 'mission.json'), { id: 'delta', triggers: [{ id: 'dynasty-tin-daily' }] })
    w(join(d, 'runs.jsonl'), [
      { ts: '2031-01-01T10:00:00.000Z', triggerId: 'dynasty-tin-daily', ok: true, summary: 'newest' },
      { ts: '2031-01-01T06:00:00.000Z', triggerId: 'dynasty-tin-trades', ok: true, summary: 'older' },
    ].map(r => JSON.stringify(r)).join('\n') + '\n')
    w(join(c, 'mission.json'), { id: 'gamma', triggers: [{ id: 'x-y' }] })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('prints the GPU line then a mission line per mission; disabled triggers are not next', () => {
    const lines = probe()
    expect(lines[0]).toMatch(/^#[0-9a-f]{6}\|.+\|.+$/i)
    expect(lines.filter(l => l.startsWith('mission|'))).toHaveLength(4)
    const a = mline(lines, 'alpha')
    expect(a[2]).toMatch(new RegExp(`^tin daily ${WHEN}$`)) // trades is disabled, gone-trigger undeclared
    expect(a[3]).toMatch(new RegExp(`^tin trades skip ${WHEN}$`)) // newest run, torn tail line skipped
    const b = mline(lines, 'beta')
    expect(b[2]).toMatch(new RegExp(`^weekly digest ${WHEN}$`))
    expect(b[3]).toMatch(new RegExp(`^weekly digest FAIL ${WHEN}$`))
    expect(mline(lines, 'delta')[3]).toMatch(new RegExp(`^tin daily ok ${WHEN}$`)) // newest by ts, not last in file
    expect(mline(lines, 'gamma').slice(2)).toEqual(['-', '-'])
  })

  it('next moves back to the trigger once schedule.json no longer disables it', () => {
    w(join(missions, 'alpha', 'schedule.json'), { triggers: { 'dynasty-tin-trades': { enabled: true } } })
    expect(mline(probe(), 'alpha')[2]).toMatch(new RegExp(`^tin trades ${WHEN}$`))
  })
})

describe('cynco-widget Hold note', () => {
  it('says passes that came due during a hold wait for their next slot (Resume is from now), in ASCII', () => {
    const src = readFileSync(script, 'utf8')
    const line = src.split(/\r?\n/).find(l => l.includes("hold asked:"))
    expect(line).toBeDefined()
    expect(line).not.toContain('fire late or skip')
    expect(line).toContain('starts no pass until Release')
    expect(line).toContain('wait for their next slot')
    expect(/^[\x00-\x7f]*$/.test(line)).toBe(true)
  })
})
