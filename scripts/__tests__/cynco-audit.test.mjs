// scripts/cynco-audit.mjs (F242, slice S5): `check` is the dispatch's audit gate, one line on stdout;
// `verify` reads day files back into the driver log. Pure functions over injected inputs and temp files;
// nothing here resolves the live audit folder or spawns the script.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLine, verifyReport, selectDayFiles, main } from '../cynco-audit.mjs'
import { AUDIT_MARKER } from '../../engine/audit/toolAudit.js'

const roots = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const root = () => { const r = mkdtempSync(join(tmpdir(), 'cynco-audit-cli-')); roots.push(r); return r }

const RUN = 'mission-20261123T120000-ab12'
const rec = (proc, seq, kind, extra = {}) =>
  JSON.stringify({ v: 1, ts: '2026-11-23T12:00:00.000Z', kind, proc, seq, src: 'tool', run: RUN, ...extra })

function dayFile(dir, name, lines) {
  const p = join(dir, name)
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}

describe('checkLine', () => {
  it('a probe that was written: the writing-to line and exit 0', () => {
    expect(checkLine({ auditRefusal: () => null, realDir: () => 'C:\\cynco-audit' })).toEqual({ exit: 0, line: 'writing to C:\\cynco-audit' })
  })
  it('a refusal: the reason as the one line and exit 3', () => {
    const why = 'audit-dir-missing: the audit folder C:\\cynco-audit does not exist'
    expect(checkLine({ auditRefusal: () => why, realDir: () => 'unused' })).toEqual({ exit: 3, line: why })
  })
  it('with no injection it asks the suite default, which refuses and creates nothing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = checkLine()
    expect(r.exit).toBe(3)
    expect(r.line).toMatch(/^audit-dir-(missing|in-home): /)
    vi.restoreAllMocks()
  })
  it('main check prints exactly one line on stdout', () => {
    const out = []
    expect(main(['check'], { auditRefusal: () => null, realDir: () => '/a', out: l => out.push(l), err: () => {} })).toBe(0)
    expect(out).toEqual(['writing to /a'])
  })
})

describe('verifyReport', () => {
  it('a start with no end: exit 1 and the start is listed', () => {
    const d = root()
    const p = dayFile(d, '2026-11-23.jsonl', [rec('9-a', 1, 'open'), rec('9-a', 2, 'start', { tool: 'Bash' })])
    const r = verifyReport([p], null)
    expect(r.exit).toBe(1)
    expect(r.lines[0]).toBe('[tool-audit] verify: 1 process(es), 2 record(s), 0 gap(s), 1 start(s) without an end, 0 unparsable line(s)')
    expect(r.lines).toContain('[tool-audit] verify: 9-a seq 2 (2026-11-23T12:00:00.000Z, tool, Bash) started and has no end')
  })
  it('a gap: exit 1 and the missing numbers', () => {
    const d = root()
    const p = dayFile(d, '2026-11-23.jsonl', [rec('9-a', 1, 'open'), rec('9-a', 3, 'probe'), rec('9-a', 7, 'probe')])
    const r = verifyReport([p], null)
    expect(r.exit).toBe(1)
    expect(r.lines).toContain('[tool-audit] verify: 9-a is missing seq 2, 4-6')
    expect(r.lines[0]).toContain('4 gap(s)')
  })
  it('a clean pair of files: exit 0, the end in the next day\'s file pairs with its start', () => {
    const d = root()
    const a = dayFile(d, '2026-11-23.jsonl', [rec('9-a', 1, 'open'), rec('9-a', 2, 'start', { tool: 'Read' })])
    const b = dayFile(d, '2026-11-24.jsonl', [rec('9-a', 3, 'end', { call: 2 })])
    expect(verifyReport([a, b], null)).toEqual({ exit: 0, lines: ['[tool-audit] verify: 1 process(es), 3 record(s), 0 gap(s), 0 start(s) without an end, 0 unparsable line(s)'] })
  })
  it('--run keeps the processes that carry the id, and says so when none does', () => {
    const d = root()
    const p = dayFile(d, '2026-11-23.jsonl', [
      rec('9-a', 1, 'open'),
      JSON.stringify({ v: 1, ts: 'x', kind: 'open', proc: '8-b', seq: 1, src: 'driver', run: 'other-20261123T110000-cd34' }),
      JSON.stringify({ v: 1, ts: 'x', kind: 'start', proc: '8-b', seq: 2, src: 'driver', run: 'other-20261123T110000-cd34' }),
    ])
    const r = verifyReport([p], RUN)
    expect(r.exit).toBe(0)
    expect(r.lines).toEqual([`[tool-audit] verify run ${RUN}: 1 process(es), 1 record(s), 0 gap(s), 0 start(s) without an end, 0 unparsable line(s)`])
    const none = verifyReport([p], 'nobody-20261123T100000-ef56')
    expect(none).toEqual({ exit: 1, lines: ['[tool-audit] verify run nobody-20261123T100000-ef56: no record carries this run id'] })
  })
  it('a malformed run id is exit 2 and reads nothing', () => {
    expect(verifyReport([join(root(), 'missing.jsonl')], 'not a run id').exit).toBe(2)
    const out = []
    expect(main(['verify', '--run', 'not a run id'], { out: l => out.push(l), err: () => {} })).toBe(2)
    expect(main(['verify', '--run'], { out: () => {}, err: () => {} })).toBe(2)
    expect(main(['frobnicate'], { out: () => {}, err: () => {} })).toBe(2)
  })
  it('an unparsable line is exit 1', () => {
    const d = root()
    const p = dayFile(d, '2026-11-23.jsonl', [rec('9-a', 1, 'open'), '{"half'])
    expect(verifyReport([p], null).exit).toBe(1)
  })
})

describe('selectDayFiles and main verify over a folder', () => {
  const names = ['2026-11-20.jsonl', '2026-11-21.jsonl', '2026-11-22.jsonl', '2026-11-22.1.jsonl', '2026-11-23.jsonl', '.cynco-audit', 'notes.txt']
  it('today and yesterday by default; from the day before the run id\'s date with --run', () => {
    expect(selectDayFiles(names, { now: new Date(2026, 10, 23, 9) })).toEqual(['2026-11-22.1.jsonl', '2026-11-22.jsonl', '2026-11-23.jsonl'])
    expect(selectDayFiles(names, { runId: 'm-20261122T080000-ab12' })).toEqual(['2026-11-21.jsonl', '2026-11-22.1.jsonl', '2026-11-22.jsonl', '2026-11-23.jsonl'])
  })
  it('main verify lists the folder it is given, and a folder that cannot be listed is exit 3', () => {
    const r = root()
    const dir = join(r, 'audit')
    mkdirSync(dir)
    writeFileSync(join(dir, AUDIT_MARKER), '')
    dayFile(dir, '2026-11-23.jsonl', [rec('9-a', 1, 'open')])
    const out = []
    expect(main(['verify', '--run', RUN], { dir, home: join(r, 'home'), out: l => out.push(l), err: () => {} })).toBe(0)
    expect(out[0]).toContain(`verify run ${RUN}: 1 process(es)`)
    const missing = []
    expect(main(['verify'], { dir: join(r, 'nope'), home: join(r, 'home'), out: l => missing.push(l), err: () => {} })).toBe(3)
    expect(missing[0]).toMatch(/^\[tool-audit\] verify: the audit folder .* could not be listed/)
    const inHome = []
    expect(main(['verify'], { dir: join(r, 'home', 'audit'), home: join(r, 'home'), out: l => inHome.push(l), err: () => {} })).toBe(3)
    expect(inHome[0]).toMatch(/^\[tool-audit\] verify: audit-dir-in-home: /)
  })
})
