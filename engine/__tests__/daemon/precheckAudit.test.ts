/**
 * The daemon precheck's audit records, read with the containment and the audit replaced (review of
 * slice S5, F242): nothing is started and no folder is made. A command killed by its two-minute cap has
 * no status, so its end record says null (the answer MissionRunner reads stays a non-zero code); a
 * precheck the containment refuses before anything starts has a `refused` record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecException } from 'node:child_process'

type Callback = (err: ExecException | null, stdout: string, stderr: string) => void
const state: { refusal: string | null; err: unknown } = { refusal: null, err: null }
const records: Array<Record<string, unknown>> = []

vi.mock('../../containment.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../containment.js')>()
  return {
    ...real,
    establishContainment: () => ({ ok: true, containment: { runId: 'precheck-t-1' } }),
    releaseContainment: () => ({ relabelled: true, note: '' }),
    toolSpawnRefusal: () => state.refusal,
    toolExec: (_c: string, _o: unknown, cb: Callback) => { setTimeout(() => cb(state.err as ExecException, 'partial', ''), 1); return {} as never },
  }
})
vi.mock('../../audit/toolAudit.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../audit/toolAudit.js')>()
  return {
    ...real,
    toolAudit: () => ({
      start: (r: Record<string, unknown>) => { records.push({ kind: 'start', ...r }); return { ok: true, call: 1 } },
      end: (call: number, r: Record<string, unknown>) => { records.push({ kind: 'end', call, ...r }) },
      refused: (r: Record<string, unknown>) => { records.push({ kind: 'refused', ...r }) },
    }),
  }
})

const { runPrecheck } = await import('../../daemon/precheck.js')

afterEach(() => { state.refusal = null; state.err = null; records.length = 0; vi.restoreAllMocks() })

describe('runPrecheck records', () => {
  it('a command killed by its cap: the answer is a non-zero code, the end record has no exit code (null)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    state.err = Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' })
    const r = await runPrecheck('python gate.py', 'C:/work/m', 't')
    expect(r.code).toBe(1)
    expect(records.map(x => x.kind)).toEqual(['start', 'end'])
    expect(records[1]).toMatchObject({ isError: true, exitCode: null })
  })
  it('a command that exits 3: the end record says 3', async () => {
    state.err = Object.assign(new Error('Command failed'), { code: 3 })
    const r = await runPrecheck('python gate.py', 'C:/work/m', 't')
    expect(r.code).toBe(3)
    expect(records[1]).toMatchObject({ isError: true, exitCode: 3 })
  })
  it('a precheck the containment refuses before anything starts has one refused record, and answers the skip', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    state.refusal = 'Refused [containment]: the low-integrity launcher is unavailable on this Windows runtime (not Bun). The command was not run.'
    const r = await runPrecheck('python gate.py', 'C:/work/m', 't')
    expect(r.stdout).toMatch(/^skip: precheck not run: Refused \[containment\]: /)
    expect(records).toEqual([expect.objectContaining({ kind: 'refused', src: 'precheck', by: 'site', input: { command: 'python gate.py' }, layer: 'containment' })])
  })
})
