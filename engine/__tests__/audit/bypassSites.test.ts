/**
 * The sites that run workspace code without the executor (F242, slice S5, rule 9): the contract
 * command and verify-first (`runCommandDetailed`, src `contract`, withheld), best-of-N test runs
 * (`runTests`, src `best-of-n`) and LSP diagnostics (`runDiag`, src `lsp`). Each records one start and
 * one end under a test context; each runs nothing when the start cannot be written and answers its
 * own "no answer"; with no context each behaves as before and writes nothing. The daemon precheck's
 * cases are in daemon/precheck.test.ts (it establishes a real containment, so they run off Windows).
 *
 * A real shell runs under the test context, so on Windows `lowil` is off for these cases (vitest's
 * Node cannot lower a token).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { runCommandDetailed } from '../../tools/contractVerify.js'
import { runTests } from '../../bestOfN/sampler.js'
import { LSPManager } from '../../lsp/manager.js'
import { runPrecheck } from '../../daemon/precheck.js'
import { getShellInfo } from '../../tools/shellInfo.js'
import { AUDIT_NOT_WRITTEN, setContainmentFaultSink } from '../../audit/toolAudit.js'
import { containmentRecords, refusalPrefix, setRunContainment } from '../../containment.js'
import { INTEGRITY_LOSS_TO_MODEL, resetPresenceTripwireForTests, startPresenceTripwire, takeBaseline } from '../../integrity.js'
import { auditWorld, blockDayFile, type AuditWorld } from './auditWorld.js'

// These cases start real shells (PowerShell on Windows), which under the full suite's load take
// longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

const worlds: AuditWorld[] = []
const world = () => { const w = auditWorld(); worlds.push(w); return w }
const savedSwitch = process.env.LOCALCODE_CONTAINMENT_OFF
const savedSandboxRoot = process.env.LOCALCODE_SANDBOX_ROOT
beforeEach(() => { process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil' })
afterEach(() => {
  setRunContainment(null)
  setContainmentFaultSink(null)
  if (savedSwitch === undefined) delete process.env.LOCALCODE_CONTAINMENT_OFF
  else process.env.LOCALCODE_CONTAINMENT_OFF = savedSwitch
  if (savedSandboxRoot === undefined) delete process.env.LOCALCODE_SANDBOX_ROOT
  else process.env.LOCALCODE_SANDBOX_ROOT = savedSandboxRoot
  vi.restoreAllMocks()
  for (const w of worlds.splice(0)) w.cleanup()
})

/** Letters outside the hex alphabet, so no hash in the day file can hold a piece of them. */
function letters(n: number): string {
  const abc = 'ghijklmnopqrstuvwxyz'
  return [...randomBytes(n)].map(b => abc[b % abc.length]).join('')
}
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const ps = getShellInfo().isPowerShell

/** A command in the Bash tool's shell that prints `marker` and creates `witness`. */
function shellCommand(marker: string, witness: string): string {
  return ps
    ? `Write-Output '${marker}'; Set-Content -LiteralPath '${witness}' -Value x`
    : `echo '${marker}'; echo x > '${witness}'`
}

describe('contract (runCommandDetailed): withheld, hashes only (entry 3.M4)', () => {
  it('one start and one end with the exit code; neither the command nor its output is in the day file', async () => {
    const w = world()
    setRunContainment(w.ctx)
    const secretOut = `OUT${letters(20)}`
    const witnessName = `w${letters(12)}.txt`
    const command = shellCommand(secretOut, join(w.mission, witnessName))
    const r = await runCommandDetailed(w.mission, command)
    expect(r.outcome).toBe('passed')
    expect(r.tail).toContain(secretOut)
    const recs = w.records()
    const start = recs.find(x => x.kind === 'start')!
    expect(start).toMatchObject({ src: 'contract', commandSha256: sha(command), commandBytes: Buffer.byteLength(command) })
    const end = recs.find(x => x.kind === 'end')!
    expect(end).toMatchObject({ call: start.seq, isError: false, exitCode: 0 })
    expect(typeof end.outputSha256).toBe('string')
    const text = w.text()
    expect(text).not.toContain(secretOut.slice(3, 15))
    expect(text).not.toContain(command.slice(0, 14))
    expect(text).not.toContain(witnessName)
  })

  it('with a start that cannot be written the check is not run: unrunnable, and the tail says so', async () => {
    const w = world()
    setRunContainment(w.ctx)
    blockDayFile(w)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const witness = join(w.mission, 'ran.txt')
    const r = await runCommandDetailed(w.mission, shellCommand('x', witness))
    expect(r).toEqual({ outcome: 'unrunnable', ms: 0, tail: `[tool-audit] this check was not run: ${AUDIT_NOT_WRITTEN('audit-dir-unwritable')}` })
    expect(existsSync(witness)).toBe(false)
  })

  it('with no context it runs as before and writes nothing', async () => {
    const w = world()
    const witness = join(w.mission, 'ran.txt')
    const r = await runCommandDetailed(w.mission, shellCommand('x', witness))
    expect(r.outcome).toBe('passed')
    expect(existsSync(witness)).toBe(true)
    expect(w.records()).toEqual([])
  })
})

describe('best-of-N (runTests): the command verbatim, the output tail', () => {
  const testInfo = (command: string) => ({ available: true, command, framework: 'pytest' })

  it('one start with the command and one end with the exit code', async () => {
    const w = world()
    setRunContainment(w.ctx)
    const witness = join(w.mission, 'ran.txt')
    const command = `echo BEST && echo x > "${witness}"`
    await runTests(w.mission, testInfo(command))
    const recs = w.records()
    const start = recs.find(x => x.kind === 'start')!
    expect(start).toMatchObject({ src: 'best-of-n', command })
    expect(recs.find(x => x.kind === 'end')).toMatchObject({ call: start.seq, isError: false, exitCode: 0 })
    expect(recs.find(x => x.kind === 'end')!.outputTail).toContain('BEST')
    const failing = await runTests(w.mission, testInfo('exit 2'))
    expect(failing.refused).toBeUndefined()
    const ends = w.records().filter(x => x.kind === 'end')
    expect(ends[1]).toMatchObject({ isError: true, exitCode: 2 })
  })

  it('with a start that cannot be written nothing runs and the answer is refused', async () => {
    const w = world()
    setRunContainment(w.ctx)
    blockDayFile(w)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const witness = join(w.mission, 'ran.txt')
    const r = await runTests(w.mission, testInfo(`echo x > "${witness}"`))
    expect(r).toEqual({ passed: 0, total: 0, output: '', refused: AUDIT_NOT_WRITTEN('audit-dir-unwritable') })
    expect(existsSync(witness)).toBe(false)
  })

  it('with no context it runs as before and writes nothing', async () => {
    const w = world()
    const witness = join(w.mission, 'ran.txt')
    const r = await runTests(w.mission, testInfo(`echo x > "${witness}"`))
    expect(r.refused).toBeUndefined()
    expect(existsSync(witness)).toBe(true)
    expect(w.records()).toEqual([])
  })
})

describe('LSP diagnostics (runDiag)', () => {
  it('one start with the command verbatim and one end', async () => {
    const w = world()
    setRunContainment(w.ctx)
    const file = join(w.mission, 'ok.py')
    writeFileSync(file, 'x = 1\n')
    await new LSPManager(w.mission).getDiagnostics(file)
    const recs = w.records()
    const start = recs.find(x => x.kind === 'start')!
    // The file is one argument of python since 2026-11-24, never shell text (NOW.md): the record names
    // the program and its arguments as passed (a quote only around an argument with a space).
    const shown = /\s/.test(file) ? `"${file}"` : file
    expect(start).toMatchObject({ src: 'lsp', command: `python -m py_compile ${shown}`, cwd: w.mission })
    const end = recs.find(x => x.kind === 'end')!
    expect(end.call).toBe(start.seq)
    expect(end.exitCode === null || typeof end.exitCode === 'number').toBe(true)
  })

  it('with a start that cannot be written it runs nothing, gives no diagnostics and says why', async () => {
    const w = world()
    setRunContainment(w.ctx)
    blockDayFile(w)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const file = join(w.mission, 'bad.py')
    writeFileSync(file, 'def (:\n')
    expect(await new LSPManager(w.mission).getDiagnostics(file)).toEqual([])
    expect(err).toHaveBeenCalledWith(`[lsp] diagnostics not run: ${AUDIT_NOT_WRITTEN('audit-dir-unwritable')}`)
    expect(readdirSync(w.audit).filter(n => n.endsWith('.jsonl'))).toHaveLength(1) // only the blocking folder
  })

  it('with no context it writes nothing', async () => {
    const w = world()
    const file = join(w.mission, 'ok.py')
    writeFileSync(file, 'x = 1\n')
    await new LSPManager(w.mission).getDiagnostics(file)
    expect(w.records()).toEqual([])
  })
})

// Review of slice S5: a site refused by the containment before its process starts leaves a `refused`
// record (`by: 'site'`), and raises the fault with the reason alone, never the whole `Refused [...]:` text.
describe('a site the containment refuses before anything starts', () => {
  const refusedWorld = () => {
    const w = world()
    setRunContainment(w.ctx)
    // A switch naming an unknown layer is a refusal of every spawn, before any process exists.
    process.env.LOCALCODE_CONTAINMENT_OFF = 'not-a-layer'
    const faults: Array<[string, string]> = []
    setContainmentFaultSink((layer, reason) => { faults.push([layer, reason]) })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    return { w, faults }
  }
  it('contract: unrunnable, one refused record with the command hashed, and the reason without its prefix', async () => {
    const { w, faults } = refusedWorld()
    const command = `echo ${letters(12)}`
    const r = await runCommandDetailed(w.mission, command)
    expect(r.outcome).toBe('unrunnable')
    const recs = w.records().filter(x => x.kind !== 'open')
    expect(recs.map(x => [x.kind, x.src, x.by])).toEqual([['refused', 'contract', 'site']])
    expect(recs[0].reasonSha256).toBe(sha(r.tail))
    expect(w.text()).not.toContain(command.slice(5))
    expect(faults).toHaveLength(1)
    expect(faults[0][0]).toBe('containment')
    expect(faults[0][1]).not.toMatch(/^Refused \[/)
    expect(faults[0][1]).toContain('LOCALCODE_CONTAINMENT_OFF names an unknown layer')
  })
  it('best-of-N: refused, one refused record with the command verbatim', async () => {
    const { w, faults } = refusedWorld()
    const command = `echo ${letters(12)}`
    const r = await runTests(w.mission, { framework: 'pytest', command } as never)
    expect(r.refused).toBeTruthy()
    const recs = w.records().filter(x => x.kind !== 'open')
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ kind: 'refused', src: 'best-of-n', by: 'site', input: { command }, layer: 'containment' })
    expect(faults.map(x => x[1]).every(x => !x.startsWith('Refused ['))).toBe(true)
  })
})

// NOW.md (containment backlog): the presence tripwire was asked by the executor alone, so the sites
// that start a process without it (a contract check and verify-first, LSP diagnostics, the daemon's
// precheck) went on running after a contained engine had lost a protected folder. Each now asks
// `presenceTripwireConfirmed` first, and a loss is that site's own "did not run" answer, never a pass.
// The sites, all of them (the record's "capabilities" item names no process-starting site of its own):
//   contract and verify-first   runCommandDetailed   engine/tools/contractVerify.ts   unrunnable
//   LSP diagnostics             runDiag              engine/lsp/manager.ts             none
//   daemon precheck             runPrecheck          engine/daemon/precheck.ts         skip
//   best-of-N test runs         runTests             engine/bestOfN/sampler.ts         refused (asynchronous
//     since wave 15c, P4(1b), so it waits for the confirming look as the others do)
describe('the bypass sites ask the presence tripwire before they start anything', () => {
  afterEach(() => { resetPresenceTripwireForTests() })

  /** A world whose fake home lost a dot-folder after its baseline, with the tripwire running. */
  function lostWorld() {
    const w = world()
    const guard = w.ctx.folders.guard
    mkdirSync(guard)
    mkdirSync(join(w.home, '.config', 'x'), { recursive: true })
    mkdirSync(join(w.home, '.other', 'y'), { recursive: true })
    takeBaseline({
      runId: w.ctx.runId, cwd: w.mission, by: 'test', guard, home: w.home, checkModels: false,
      sandboxRoot: dirname(w.ctx.sandbox.root),
      roots: { frozen: [], presence: [{ path: w.home, dotOnly: true, files: true, counts: true, volume: false, network: false }] },
    })
    const losses: string[] = []
    const r = startPresenceTripwire({ ctx: w.ctx, onLoss: (l) => { losses.push(l.kind) }, timer: false, minGapMs: 0, confirmMs: 50 })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    setRunContainment(w.ctx)
    const faults: Array<[string, string]> = []
    setContainmentFaultSink((layer, reason) => { faults.push([layer, reason]) })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const lose = () => rmSync(join(w.home, '.config'), { recursive: true })
    return { w, losses, faults, lose }
  }

  it('contract: runs while nothing is lost; after a loss it is unrunnable, runs nothing and is recorded', async () => {
    const { w, faults, lose, losses } = lostWorld()
    const before = join(w.mission, 'before.txt')
    expect((await runCommandDetailed(w.mission, shellCommand('x', before))).outcome).toBe('passed')
    expect(existsSync(before)).toBe(true)
    lose()
    const witness = join(w.mission, 'after.txt')
    const r = await runCommandDetailed(w.mission, shellCommand('x', witness))
    expect(r.outcome).toBe('unrunnable')
    expect(r.tail.startsWith(`${refusalPrefix('integrity')} ${INTEGRITY_LOSS_TO_MODEL}.`)).toBe(true)
    expect(existsSync(witness)).toBe(false)
    expect(losses).toEqual(['presence'])
    expect(w.records().filter(x => x.kind === 'refused').map(x => [x.src, x.by, x.layer])).toEqual([['contract', 'site', 'integrity']])
    expect(faults).toContainEqual(['integrity', INTEGRITY_LOSS_TO_MODEL])
  })

  it('LSP: after a loss no diagnostics, the compiler is not run, and it says why', async () => {
    const { w, lose, faults } = lostWorld()
    lose()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const file = join(w.mission, 'bad.py')
    writeFileSync(file, 'def (:\n')
    expect(await new LSPManager(w.mission).getDiagnostics(file)).toEqual([])
    expect(log.mock.calls.some(c => String(c[0]).startsWith(`[lsp] diagnostics not run: ${refusalPrefix('integrity')}`))).toBe(true)
    expect(existsSync(join(w.mission, '__pycache__'))).toBe(false)
    expect(w.records().filter(x => x.kind === 'refused').map(x => [x.src, x.by, x.layer])).toEqual([['lsp', 'site', 'integrity']])
    expect(w.records().filter(x => x.kind === 'start')).toEqual([])
    // Wave 15b, check C4-4: the loss ends the contained run through the one fault channel.
    expect(faults).toContainEqual(['integrity', INTEGRITY_LOSS_TO_MODEL])
  })

  it('best-of-N: runs while nothing is lost; after a loss it is refused, runs nothing and is recorded', async () => {
    const { w, faults, lose, losses } = lostWorld()
    const before = join(w.mission, 'before.txt')
    expect((await runTests(w.mission, { available: true, framework: 'pytest', command: `echo x > "${before}"` })).refused).toBeUndefined()
    expect(existsSync(before)).toBe(true)
    lose()
    const witness = join(w.mission, 'after.txt')
    const r = await runTests(w.mission, { available: true, framework: 'pytest', command: `echo x > "${witness}"` })
    expect(r).toMatchObject({ passed: 0, total: 0, output: '' })
    expect(r.refused?.startsWith(`${refusalPrefix('integrity')} ${INTEGRITY_LOSS_TO_MODEL}.`), r.refused).toBe(true)
    expect(existsSync(witness)).toBe(false)
    expect(losses).toEqual(['presence'])
    expect(w.records().filter(x => x.kind === 'refused').map(x => [x.src, x.by, x.layer])).toEqual([['best-of-n', 'site', 'integrity']])
    expect(faults).toContainEqual(['integrity', INTEGRITY_LOSS_TO_MODEL])
  })

  it('precheck: after a loss it is a skip, before any sandbox is made', async () => {
    const { w, lose } = lostWorld()
    lose()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const witness = join(w.mission, 'ran.txt')
    // With the lowil switch a precheck sandbox is refused outright, so whether one would be made is
    // asked here without it (afterEach puts it back). Nothing starts: the tripwire answers first.
    delete process.env.LOCALCODE_CONTAINMENT_OFF
    // Wave 15c, check B4-3: the precheck makes its sandbox under LOCALCODE_SANDBOX_ROOT (it names no
    // root of its own), which the suite's setup points at a folder that is never created. Pointed at
    // the root the assertion below reads, a sandbox made before the tripwire's answer would be seen.
    process.env.LOCALCODE_SANDBOX_ROOT = dirname(w.ctx.sandbox.root)
    const r = await runPrecheck(`echo x > "${witness}"`, w.mission, 't1')
    expect(r.code).toBe(0)
    expect(r.stdout.startsWith(`skip: precheck not run: ${refusalPrefix('integrity')} ${INTEGRITY_LOSS_TO_MODEL}.`), r.stdout).toBe(true)
    expect(existsSync(witness)).toBe(false)
    // Wave 15b, check C4-4: what the name says. No precheck sandbox was made: the sandbox root holds
    // no precheck record, released or not (a record stays in its run folder after a release).
    expect(containmentRecords({ sandboxRoot: dirname(w.ctx.sandbox.root) }).filter(x => x.kind === 'precheck')).toEqual([])
  })
})
