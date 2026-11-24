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
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { runCommandDetailed } from '../../tools/contractVerify.js'
import { runTests } from '../../bestOfN/sampler.js'
import { LSPManager } from '../../lsp/manager.js'
import { getShellInfo } from '../../tools/shellInfo.js'
import { AUDIT_NOT_WRITTEN, setContainmentFaultSink } from '../../audit/toolAudit.js'
import { setRunContainment } from '../../containment.js'
import { auditWorld, blockDayFile, type AuditWorld } from './auditWorld.js'

// These cases start real shells (PowerShell on Windows), which under the full suite's load take
// longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

const worlds: AuditWorld[] = []
const world = () => { const w = auditWorld(); worlds.push(w); return w }
const savedSwitch = process.env.LOCALCODE_CONTAINMENT_OFF
beforeEach(() => { process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil' })
afterEach(() => {
  setRunContainment(null)
  setContainmentFaultSink(null)
  if (savedSwitch === undefined) delete process.env.LOCALCODE_CONTAINMENT_OFF
  else process.env.LOCALCODE_CONTAINMENT_OFF = savedSwitch
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

  it('one start with the command and one end with the exit code', () => {
    const w = world()
    setRunContainment(w.ctx)
    const witness = join(w.mission, 'ran.txt')
    const command = `echo BEST && echo x > "${witness}"`
    runTests(w.mission, testInfo(command))
    const recs = w.records()
    const start = recs.find(x => x.kind === 'start')!
    expect(start).toMatchObject({ src: 'best-of-n', command })
    expect(recs.find(x => x.kind === 'end')).toMatchObject({ call: start.seq, isError: false, exitCode: 0 })
    expect(recs.find(x => x.kind === 'end')!.outputTail).toContain('BEST')
    const failing = runTests(w.mission, testInfo('exit 2'))
    expect(failing.refused).toBeUndefined()
    const ends = w.records().filter(x => x.kind === 'end')
    expect(ends[1]).toMatchObject({ isError: true, exitCode: 2 })
  })

  it('with a start that cannot be written nothing runs and the answer is refused', () => {
    const w = world()
    setRunContainment(w.ctx)
    blockDayFile(w)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const witness = join(w.mission, 'ran.txt')
    const r = runTests(w.mission, testInfo(`echo x > "${witness}"`))
    expect(r).toEqual({ passed: 0, total: 0, output: '', refused: AUDIT_NOT_WRITTEN('audit-dir-unwritable') })
    expect(existsSync(witness)).toBe(false)
  })

  it('with no context it runs as before and writes nothing', () => {
    const w = world()
    const witness = join(w.mission, 'ran.txt')
    const r = runTests(w.mission, testInfo(`echo x > "${witness}"`))
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
    expect(start).toMatchObject({ src: 'lsp', command: `python -m py_compile "${file}" 2>&1`, cwd: w.mission })
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
  it('best-of-N: refused, one refused record with the command verbatim', () => {
    const { w, faults } = refusedWorld()
    const command = `echo ${letters(12)}`
    const r = runTests(w.mission, { framework: 'pytest', command } as never)
    expect(r.refused).toBeTruthy()
    const recs = w.records().filter(x => x.kind !== 'open')
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ kind: 'refused', src: 'best-of-n', by: 'site', input: { command }, layer: 'containment' })
    expect(faults.map(x => x[1]).every(x => !x.startsWith('Refused ['))).toBe(true)
  })
})
