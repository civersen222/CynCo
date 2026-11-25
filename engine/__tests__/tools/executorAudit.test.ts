/**
 * The tool-call audit through ToolExecutor (F242, slice S5): the start record is on disk before the
 * tool runs, a record that cannot be written runs nothing, every pre-run refusal has a record, and
 * the exit code survives the executor's rebuilds. Every case that writes records names its own
 * marked temp audit folder (auditWorld); with no context nothing is written anywhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolExecutor, refusalFaultOf } from '../../tools/executor.js'
import { getToolByName } from '../../tools/registry.js'
import { setTaskSealedPaths } from '../../tools/sealedPaths.js'
import { AUDIT_NOT_WRITTEN, setContainmentFaultSink } from '../../audit/toolAudit.js'
import { refusalLayerOf, refusalText, setRunContainment } from '../../containment.js'
import { auditWorld, blockDayFile, type AuditWorld } from '../audit/auditWorld.js'

// These cases start real shells (PowerShell on Windows), which under the full suite's load take
// longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

const win = process.platform === 'win32'
const worlds: AuditWorld[] = []
const world = (o?: Parameters<typeof auditWorld>[0]) => { const w = auditWorld(o); worlds.push(w); return w }
const savedSwitch = process.env.LOCALCODE_CONTAINMENT_OFF

afterEach(() => {
  setRunContainment(null)
  setContainmentFaultSink(null)
  setTaskSealedPaths([], () => [])
  if (savedSwitch === undefined) delete process.env.LOCALCODE_CONTAINMENT_OFF
  else process.env.LOCALCODE_CONTAINMENT_OFF = savedSwitch
  vi.restoreAllMocks()
  for (const w of worlds.splice(0)) w.cleanup()
})

const executor = (cwd: string, o: Partial<ConstructorParameters<typeof ToolExecutor>[0]> = {}) =>
  new ToolExecutor({ cwd, approveAll: true, requestApproval: async () => true, ...o })

/** A real shell under a test context: vitest's Node cannot lower a token, so `lowil` is off. */
function lowil(words = 'lowil'): void {
  process.env.LOCALCODE_CONTAINMENT_OFF = words
}

describe('the start record is on disk before the tool runs', () => {
  it('a Bash call that copies the day file finds its own start in it, and no end', async () => {
    const w = world()
    setRunContainment(w.ctx)
    lowil('lowil,paths')
    const copy = join(w.mission, 'copy.jsonl')
    const day = w.dayFile()
    const command = win
      ? `Copy-Item -LiteralPath '${day}' -Destination '${copy}'`
      : `cp '${day}' '${copy}'`
    const r = await executor(w.mission).execute('Bash', { command })
    expect(r.isError, r.output).toBe(false)
    const lines = readFileSync(copy, 'utf-8').split('\n').filter(l => l !== '').map(l => JSON.parse(l))
    const start = lines.find(l => l.kind === 'start')
    expect(start).toMatchObject({ src: 'tool', tool: 'Bash', run: w.ctx.runId, cwd: w.mission })
    expect(start.input.command).toBe(command)
    expect(lines.some(l => l.kind === 'end')).toBe(false)
    // ...and the end arrived after the tool answered.
    const all = w.records()
    expect(all.find(l => l.kind === 'end' && l.call === start.seq)).toMatchObject({ isError: false, exitCode: 0 })
  })
})

describe('fail closed', () => {
  it('a Write whose start cannot be written is not run, returns rule 5\'s text and raises one audit fault', async () => {
    const w = world()
    setRunContainment(w.ctx)
    blockDayFile(w)
    const sink = vi.fn()
    setContainmentFaultSink(sink)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const target = join(w.mission, 'never.txt')
    const r = await executor(w.mission).execute('Write', { file_path: target, content: 'x' })
    expect(r.isError).toBe(true)
    expect(refusalLayerOf(r.output)).toBe('audit')
    expect(r.output).toBe(refusalText('audit', AUDIT_NOT_WRITTEN('audit-dir-unwritable')))
    expect(r.output).toBe('Refused [audit]: the record of this call could not be written before it ran (audit-dir-unwritable). Nothing was run. No tool will run until that is fixed, and it cannot be fixed from inside the run: do not retry and do not try another tool. Say in your reply that the run stopped because the record could not be written, and stop.')
    expect('exitCode' in r).toBe(false)
    expect(existsSync(target)).toBe(false)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith('audit', AUDIT_NOT_WRITTEN('audit-dir-unwritable'))
  })
})

describe('refused calls', () => {
  it('a sealed path, an unknown tool and a denied approval each leave one refused record and no start', async () => {
    const w = world()
    setRunContainment(w.ctx)
    const gate = join(w.mission, 'gates', 'SEALED_q7.test.ts')
    setTaskSealedPaths([gate], () => [])
    const ex = executor(w.mission)
    const sealed = await ex.execute('Read', { file_path: gate })
    expect(sealed.isError).toBe(true)
    const unknown = await ex.execute('NoSuchTool', { x: 1 })
    expect(unknown.output).toContain('unknown tool')
    const asking = executor(w.mission, { approveAll: false, requestApproval: async () => false })
    const denied = await asking.execute('Write', { file_path: join(w.mission, 'a.txt'), content: 'x' })
    expect(denied.output).toContain('denied by user')
    const recs = w.records()
    const refused = recs.filter(r => r.kind === 'refused')
    expect(refused.map(r => r.tool)).toEqual(['Read', 'NoSuchTool', 'Write'])
    for (const r of refused) expect(r.by).toBe('executor')
    expect(refused[1]!.input).toEqual({ x: 1 })
    expect(refused[2]!.reason).toBe('Tool call denied by user: Write')
    expect(recs.some(r => r.kind === 'start')).toBe(false)
  })

  it('a call that passes the checks and whose tool reports an error leaves a start and an end and no refused', async () => {
    const w = world()
    setRunContainment(w.ctx)
    const r = await executor(w.mission).execute('Read', { file_path: join(w.mission, 'missing.txt') })
    expect(r.isError).toBe(true)
    const recs = w.records()
    expect(recs.filter(x => x.kind === 'refused')).toEqual([])
    const s = recs.find(x => x.kind === 'start')!
    expect(recs.find(x => x.kind === 'end')).toMatchObject({ call: s.seq, isError: true })
    expect('exitCode' in recs.find(x => x.kind === 'end')!).toBe(false)
  })
})

describe('the exit code after the executor rebuilt the result (no context)', () => {
  it('Bash success is 0, `exit 3` is 3, a timeout is null; Blocked and Read carry no key', async () => {
    const w = world()
    const ex = executor(w.mission)
    expect((await ex.execute('Bash', { command: 'echo hi' })).exitCode).toBe(0)
    expect((await ex.execute('Bash', { command: 'exit 3' })).exitCode).toBe(3)
    expect((await ex.execute('Bash', { command: 'sleep 30', timeout: 1000 })).exitCode).toBeNull()
    const blocked = await ex.execute('Bash', { command: 'rm -rf /' })
    expect('exitCode' in blocked).toBe(false)
    writeFileSync(join(w.mission, 'f.txt'), 'x')
    expect('exitCode' in (await ex.execute('Read', { file_path: join(w.mission, 'f.txt') }))).toBe(false)
  }, 20000)

  it('the third identical failing Bash (the doom-loop return) still carries its code', async () => {
    const w = world()
    const ex = executor(w.mission)
    let last = await ex.execute('Bash', { command: 'exit 4' })
    for (let i = 0; i < 2; i++) last = await ex.execute('Bash', { command: 'exit 4' })
    expect(last.output).toContain('DOOM LOOP DETECTED')
    expect(last.exitCode).toBe(4)
  })
})

describe('the end record', () => {
  it('carries the result\'s exit code, and its output head is redacted for a sealed name', async () => {
    const w = world()
    setRunContainment(w.ctx)
    lowil()
    const gate = join(w.root, 'gates', 'SEALED_zz9.test.ts')
    setTaskSealedPaths([gate], () => [])
    writeFileSync(join(w.mission, 'notes.txt'), 'the gate is SEALED_zz9.test.ts\n')
    await executor(w.mission).execute('Read', { file_path: join(w.mission, 'notes.txt') })
    await executor(w.mission).execute('Bash', { command: 'exit 5' })
    const ends = w.records().filter(x => x.kind === 'end')
    expect(ends[0]!.outputHead).not.toContain('SEALED_zz9')
    expect(ends[1]!.exitCode).toBe(5)
  })

  it('a tool that throws gives one end with threw: and exitCode null', async () => {
    const w = world()
    setRunContainment(w.ctx)
    vi.spyOn(getToolByName('Read')!, 'execute').mockRejectedValue(new Error('boom'))
    const r = await executor(w.mission).execute('Read', { file_path: join(w.mission, 'x.txt') })
    expect(r.output).toBe('Tool execution error (Read): boom')
    const ends = w.records().filter(x => x.kind === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ isError: true, exitCode: null, outputHead: 'threw: boom' })
  })

  it('two calls under Promise.all on one executor give two pairs that pair correctly', async () => {
    const w = world()
    setRunContainment(w.ctx)
    writeFileSync(join(w.mission, 'a.txt'), 'A')
    writeFileSync(join(w.mission, 'b.txt'), 'B')
    const ex = executor(w.mission)
    await Promise.all([
      ex.execute('Read', { file_path: join(w.mission, 'a.txt') }),
      ex.execute('Read', { file_path: join(w.mission, 'b.txt') }),
    ])
    const recs = w.records()
    const starts = recs.filter(x => x.kind === 'start')
    const ends = recs.filter(x => x.kind === 'end')
    expect(starts).toHaveLength(2)
    expect(ends.map(e => e.call).sort()).toEqual(starts.map(s => s.seq).sort())
    for (const s of starts) {
      const e = ends.find(x => x.call === s.seq)!
      expect(e.outputHead).toContain(s.input.file_path.endsWith('a.txt') ? 'A' : 'B')
    }
    expect(recs.some(x => x.kind === 'refused')).toBe(false)
  })

  it('an executor built with auditSrc subagent writes src subagent', async () => {
    const w = world()
    setRunContainment(w.ctx)
    await executor(w.mission, { auditSrc: 'subagent' }).execute('Read', { file_path: join(w.mission, 'none.txt') })
    await executor(w.mission, { auditSrc: 'subagent' }).execute('NoSuchTool', {})
    const recs = w.records().filter(x => x.kind !== 'open')
    expect(recs.length).toBe(3)
    for (const r of recs) expect(r.src).toBe('subagent')
  })
})

describe('refusalFaultOf', () => {
  const long = 'y'.repeat(400)
  it('a containment or integrity refusal with no exit code is a fault; its first line, cut at 300', () => {
    expect(refusalFaultOf({ output: `Refused [containment]: no launcher\nmore`, isError: true })).toEqual({ layer: 'containment', reason: 'no launcher' })
    expect(refusalFaultOf({ output: `Refused [integrity]: ${long}`, isError: true })).toEqual({ layer: 'integrity', reason: long.slice(0, 300) })
  })
  it('anything else is not: the path check, the audit, a success, ordinary errors, and a result that ran a process', () => {
    expect(refusalFaultOf({ output: 'Refused [protected path]: x', isError: true })).toBeNull()
    expect(refusalFaultOf({ output: 'Refused [audit]: x', isError: true })).toBeNull()
    expect(refusalFaultOf({ output: 'Refused [containment]: x', isError: false })).toBeNull()
    expect(refusalFaultOf({ output: 'Error: no such file', isError: true })).toBeNull()
    expect(refusalFaultOf({ output: 'Refused [containment]: x', isError: true, exitCode: 1 })).toBeNull()
    expect(refusalFaultOf({ output: 'Refused [containment]: x', isError: true, exitCode: null })).toBeNull()
  })

  it('a Bash command that prints the prefix and exits 1 raises nothing (no context)', async () => {
    const w = world()
    const sink = vi.fn()
    setContainmentFaultSink(sink)
    const command = win ? `Write-Output 'Refused [containment]: x'; exit 1` : `echo 'Refused [containment]: x'; exit 1`
    const r = await executor(w.mission).execute('Bash', { command })
    expect(r.isError).toBe(true)
    expect(sink).not.toHaveBeenCalled()
  })

  it.skipIf(!win)('under a test context with the switch not set, the launcher check refuses Bash and the sink gets one containment fault', async () => {
    const w = world()
    setRunContainment(w.ctx)
    delete process.env.LOCALCODE_CONTAINMENT_OFF
    const sink = vi.fn()
    setContainmentFaultSink(sink)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = await executor(w.mission).execute('Bash', { command: 'echo x' })
    expect(refusalLayerOf(r.output)).toBe('containment')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]![0]).toBe('containment')
    // The start was recorded, and its end says the tool refused.
    const recs = w.records()
    const end = recs.find(x => x.kind === 'end')!
    expect(end.isError).toBe(true)
    expect('exitCode' in end).toBe(false)
  })
})

describe('with no context', () => {
  it('nothing is created anywhere under the temp root', async () => {
    const w = world()
    const before = readdirSync(w.audit)
    await executor(w.mission).execute('Read', { file_path: join(w.mission, 'none.txt') })
    await executor(w.mission).execute('NoSuchTool', {})
    expect(readdirSync(w.audit)).toEqual(before)
    expect(readdirSync(w.mission)).toEqual([])
  })
})
