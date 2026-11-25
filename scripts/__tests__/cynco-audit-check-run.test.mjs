// Wave 19 (plan P6 item 1, R1 F3 / R2-9): the dispatch's audit gate, `cynco-audit.mjs check --run <id>`, writes its
// probe record with the run's id and src 'dispatch-check', so `verify --run <id>` finds the dispatch's own record and
// it is never mistaken for the driver's probe. The real writer runs against a folder of the test's own (createToolAudit
// is not the gate; the gate is auditRefusal, whose folder policy refuses a temp folder, so the record's shape is read
// back from the function the gate calls, harnessAudit, with a run, through checkLine's seam).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLine, main } from '../cynco-audit.mjs'
import { createToolAudit } from '../../engine/audit/toolAudit.js'

const RUN = 'm-20261125T010203-ab12'

describe('cynco-audit.mjs check --run', () => {
  let dirs = []
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

  it('hands the run id and the dispatch-check source to the gate question', () => {
    const asked = []
    const r = checkLine({ auditRefusal: (a) => { asked.push(a); return null }, realDir: () => 'C:/a', runId: RUN })
    expect(r).toEqual({ exit: 0, line: 'writing to C:/a' })
    expect(asked).toEqual([{ by: 'dispatch-check', run: RUN }])
  })

  it('main: check --run <id> passes the id; a malformed id or a missing one is usage (exit 2), and nothing is probed', () => {
    const asked = []
    const io = { auditRefusal: (a) => { asked.push(a); return null }, realDir: () => '/a', out: () => {}, err: () => {} }
    expect(main(['check', '--run', RUN], io)).toBe(0)
    expect(asked).toEqual([{ by: 'dispatch-check', run: RUN }])
    expect(main(['check', '--run', 'not a run'], io)).toBe(2)
    expect(main(['check', '--run'], io)).toBe(2)
    expect(main(['check', 'extra'], io)).toBe(2)
    expect(asked).toHaveLength(1)
    // `check` alone stays the dispatch's question without a run, as before.
    expect(main(['check'], io)).toBe(0)
    expect(asked[1]).toEqual({ by: 'dispatch-check', run: null })
  })

  it('a probe by dispatch-check is written with src dispatch-check and the run id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-check-run-'))
    dirs.push(dir)
    writeFileSync(join(dir, '.cynco-audit'), '')
    const audit = createToolAudit({ dir, run: RUN, proc: 'w19-a' })
    expect(audit.probe('dispatch-check')).toBeNull()
    const file = readdirSync(dir).find(n => n.endsWith('.jsonl'))
    const recs = readFileSync(join(dir, file), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const probe = recs.find(r => r.kind === 'probe')
    expect(probe.src).toBe('dispatch-check')
    expect(probe.run).toBe(RUN)
    expect(probe.by).toBe('dispatch-check')
  })
})
