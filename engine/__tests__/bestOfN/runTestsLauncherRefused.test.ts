/**
 * A best-of-N test run whose launcher could not run is refused, never a score (wave 19, check C4-4).
 *
 * In a contained run on Windows the candidate's tests start through the low-integrity launcher. A
 * launcher that exits 197 (nothing was started) or 198 (its child was lost) with its seal line
 * reaches exec's callback as a `ContainmentRefusal` (`toolExec`, engine/containment.ts). `runTests`
 * must answer `refused` for it and raise the containment fault: scored as 0/0 instead, a run whose
 * every candidate's launcher failed that way would leave `selectWinner` a candidate with a patch and
 * no test that measured it, and the loop would apply it. No case reached that branch (deleting it
 * survived, check C4-4). Here `toolExec` is the one seam: it starts nothing and answers through the
 * callback as the real one does after a launcher fault.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../containment.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../containment.js')>()
  return {
    ...real,
    toolExec: (_command: string, _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      calls.n++
      setTimeout(() => callback(new real.ContainmentRefusal('ECONTAINMENT', 'the launcher exited 197', 'Refused [containment]: the launcher exited 197. Nothing was run.'), '', ''), 10)
      return { pid: undefined }
    },
  }
})

const { runTests } = await import('../../bestOfN/sampler.js')
const { setContainmentFaultSink } = await import('../../audit/toolAudit.js')

afterEach(() => { setContainmentFaultSink(null); calls.n = 0 })

describe('runTests after a launcher fault', () => {
  it('answers refused with the refusal text, no score, and raises the containment fault', async () => {
    const faults: Array<[string, string]> = []
    setContainmentFaultSink((layer, reason) => { faults.push([layer, reason]) })
    const r = await runTests(process.cwd(), { available: true, framework: 'pytest', command: 'python -m pytest' }, 5000)
    expect(calls.n).toBe(1)
    expect(r).toEqual({ passed: 0, total: 0, output: '', refused: 'Refused [containment]: the launcher exited 197. Nothing was run.' })
    expect(faults).toHaveLength(1)
    expect(faults[0][0]).toBe('containment')
  })
})
