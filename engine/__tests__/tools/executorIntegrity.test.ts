/**
 * The presence tripwire through ToolExecutor (F242, slice S7, directive 17): once a contained engine
 * has lost a protected folder, every tool call is refused with the integrity prefix, nothing runs, and
 * each refusal is recorded in the tool-call audit. Every folder is under the audit world's mkdtemp
 * root: the guard folder, the fake home and the baseline are the test's own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ToolExecutor } from '../../tools/executor.js'
import { getToolByName } from '../../tools/registry.js'
import { setContainmentFaultSink } from '../../audit/toolAudit.js'
import { refusalPrefix, setRunContainment } from '../../containment.js'
import { INTEGRITY_LOSS_TO_MODEL, resetPresenceTripwireForTests, startPresenceTripwire, takeBaseline } from '../../integrity.js'
import { auditWorld, type AuditWorld } from '../audit/auditWorld.js'

const worlds: AuditWorld[] = []
afterEach(() => {
  resetPresenceTripwireForTests()
  setRunContainment(null)
  setContainmentFaultSink(null)
  vi.restoreAllMocks()
  for (const w of worlds.splice(0)) w.cleanup()
})

const executor = (cwd: string) => new ToolExecutor({ cwd, approveAll: true, requestApproval: async () => true })

/** An audit world with a guard folder, a dot-folder in its fake home and a baseline of that home. */
function tripwired(o: { start?: boolean } = {}) {
  const w = auditWorld()
  worlds.push(w)
  const guard = w.ctx.folders.guard
  mkdirSync(guard)
  mkdirSync(join(w.home, '.config', 'x'), { recursive: true })
  mkdirSync(join(w.home, '.other', 'y'), { recursive: true })
  writeFileSync(join(w.mission, 'a.txt'), 'hello')
  takeBaseline({
    runId: w.ctx.runId, cwd: w.mission, by: 'test', guard, home: w.home, checkModels: false,
    sandboxRoot: dirname(w.ctx.sandbox.root),
    roots: { frozen: [], presence: [{ path: w.home, dotOnly: true, files: true, counts: true, volume: false, network: false }] },
  })
  const losses: string[] = []
  if (o.start !== false) {
    const r = startPresenceTripwire({ ctx: w.ctx, onLoss: (l) => { losses.push(l.kind) }, timer: false })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
  return { w, losses }
}

describe('the presence tripwire is the first check of every tool call', () => {
  it('after a dot-folder of the home is removed, every call is refused [integrity], nothing runs, and each is recorded', async () => {
    const { w, losses } = tripwired()
    setRunContainment(w.ctx)
    const read = getToolByName('Read')!
    const spy = vi.spyOn(read, 'execute')
    const ex = executor(w.mission)
    // Nothing lost yet: the call runs.
    const ok = await ex.execute('Read', { file_path: join(w.mission, 'a.txt') })
    expect(ok.isError).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)

    rmSync(join(w.home, '.config'), { recursive: true })
    // The check looks again only 10 s after the last look; a new tripwire over the same baseline looks at once.
    resetPresenceTripwireForTests()
    expect(startPresenceTripwire({ ctx: w.ctx, onLoss: (l) => { losses.push(l.kind) }, timer: false }).ok).toBe(true)

    const first = await ex.execute('Read', { file_path: join(w.mission, 'a.txt') })
    expect(first.isError).toBe(true)
    expect(first.output.startsWith(`${refusalPrefix('integrity')} ${INTEGRITY_LOSS_TO_MODEL}.`)).toBe(true)
    const second = await ex.execute('Glob', { pattern: '*.txt', path: w.mission })
    expect(second.isError).toBe(true)
    expect(second.output.startsWith(refusalPrefix('integrity'))).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(losses).toEqual(['presence'])

    const refused = w.records().filter(r => r.kind === 'refused')
    expect(refused.map(r => r.tool)).toEqual(['Read', 'Glob'])
    for (const r of refused) expect(r.layer).toBe('integrity')
  })

  it('with no tripwire started the same call runs', async () => {
    const { w } = tripwired({ start: false })
    setRunContainment(w.ctx)
    rmSync(join(w.home, '.config'), { recursive: true })
    const r = await executor(w.mission).execute('Read', { file_path: join(w.mission, 'a.txt') })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('hello')
  })
})
