// The grader fixture (scripts/__tests__/fixtures/graderContainment.mjs) follows the graders' contract since
// R3-F1 (wave 12): establish is handed the run id the start record already carries (`runId`, minted in
// scripts/cynco-spawn.mjs), and the audit handle is made per run (`harnessAudit({ run })`). A fixture that
// dropped either gave a test's grader a context id other than the one on its records (found in wave 15).
//
// Nothing here switches a containment layer off: the context builder is called with a stand-in for the real
// module's testContainment, and the audit records go to the fixture's own marked temp folder.
import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as toolAudit from '../../engine/audit/toolAudit.js'
import { graderContainment, graderAuditModule, graderContext } from './fixtures/graderContainment.mjs'

afterAll(() => graderContainment.stop())

describe('graderContext: the test context establish returns', () => {
  it('carries the run id establish was handed', () => {
    const asked = []
    const actual = { testContainment: (a) => { asked.push(a); return { runId: a.runId ?? 'made-up', missionCwd: a.missionCwd } } }
    const root = 'C:/r'
    const c = graderContext(actual, { kind: 'grader', runId: 'grade-base-20261124T220000-ab12', missionCwd: 'C:/m', extraRoots: [] }, root)
    expect(c.runId).toBe('grade-base-20261124T220000-ab12')
    expect(asked[0]).toMatchObject({ kind: 'grader', runId: 'grade-base-20261124T220000-ab12', missionCwd: 'C:/m', extraRoots: [],
      sandbox: { root, home: join(root, 'home'), tmp: join(root, 'tmp'), scratch: join(root, 'scratch') } })
  })
})

describe('graderAuditModule: the handle is made for the run it is asked for', () => {
  it('each run\'s start and end records carry that run, in the one marked folder', () => {
    const mod = graderAuditModule(toolAudit)
    const a = mod.harnessAudit({ run: 'grade-a-20261124T220000-aaaa' })
    const b = mod.harnessAudit({ run: 'grade-b-20261124T220000-bbbb' })
    const n = mod.harnessAudit()
    for (const [h, cmd] of [[a, 'python a.py'], [b, 'python b.py'], [n, 'python n.py']]) {
      const s = h.start({ src: 'gate', command: cmd, cwd: 'C:/x' })
      expect(s.ok).toBe(true)
      h.end(s.call, { isError: false, exitCode: 0, ms: 1, output: '' })
    }
    expect(mod.harnessAudit({ run: 'grade-a-20261124T220000-aaaa' }), 'one handle per run').toBe(a)
    const dir = graderContainment.audit
    const recs = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
    const runsOf = (kind) => recs.filter(r => r.kind === kind).map(r => r.run)
    expect(runsOf('start')).toEqual(['grade-a-20261124T220000-aaaa', 'grade-b-20261124T220000-bbbb', null])
    expect(runsOf('end')).toEqual(['grade-a-20261124T220000-aaaa', 'grade-b-20261124T220000-bbbb', null])
  })
})
