// R3-F1 (wave 12, P5-C1 of wave 15): a grader's start and end audit records carry the run id of the grader's
// own containment. Both graders hand runSync the `forRun` form of the audit option (scripts/cynco-spawn.mjs):
// the wave grader (scripts/cynco-campaign-grade.mjs, which grades every wave) and the calibration grader
// (scripts/cynco-campaign-calibrate.mjs). The handle is made by `harnessAudit({ run })` for the id runSync
// passes; a call that is not contained is handed over untouched, with no audit option.
//
// No process is started here: runSync and harnessAudit are replaced, and what the graders hand them is read.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const seen = vi.hoisted(() => ({ runs: [], audits: [] }))

vi.mock('../cynco-spawn.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  runSync: (cmd, args, opts) => { seen.runs.push({ cmd, args, opts }); return { status: 0, stdout: '', stderr: '', elapsedMs: 0, timedOut: false, fault: null } },
}))
vi.mock('../../engine/audit/toolAudit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  harnessAudit: (a) => { seen.audits.push(a); return { made: a } },
}))

const { defaultIo: gradeIo } = await import('../cynco-campaign-grade.mjs')
const { defaultIo: calibrateIo } = await import('../cynco-campaign-calibrate.mjs')

beforeEach(() => { seen.runs.length = 0; seen.audits.length = 0 })

describe.each([
  ['the wave grader (cynco-campaign-grade.mjs)', gradeIo],
  ['the calibration grader (cynco-campaign-calibrate.mjs)', calibrateIo],
])('%s: the audit records carry the run id', (_name, io) => {
  it('a contained run hands runSync forRun and src gate, and no ready-made handle', () => {
    io.run('python', ['gate.py'], { cwd: 'C:/x', contained: { own: 'C:/x' } })
    expect(seen.runs).toHaveLength(1)
    const { audit } = seen.runs[0].opts
    expect(audit.src).toBe('gate')
    expect(typeof audit.forRun).toBe('function')
    expect('handle' in audit).toBe(false)
    // No handle is made before runSync asks for one: the id is not known until then.
    expect(seen.audits).toEqual([])
  })

  it('forRun makes the handle for the id it is given, and for null', () => {
    io.run('python', ['gate.py'], { cwd: 'C:/x', contained: { own: 'C:/x' } })
    const { audit } = seen.runs[0].opts
    expect(audit.forRun('grade-x-20261124T220000-ab12')).toEqual({ made: { run: 'grade-x-20261124T220000-ab12' } })
    expect(audit.forRun(null)).toEqual({ made: { run: null } })
    expect(seen.audits).toEqual([{ run: 'grade-x-20261124T220000-ab12' }, { run: null }])
  })

  it('a run that is not contained is handed over untouched, with no audit option', () => {
    const opts = { cwd: 'C:/x', timeoutMs: 5 }
    io.run('git', ['status'], opts)
    expect(seen.runs[0].opts).toBe(opts)
    expect(seen.audits).toEqual([])
  })
})
