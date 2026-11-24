/**
 * The Windows layer of the containment of unattended runs (F242), under Bun: the real
 * low-integrity launcher (`engine/lowIntegrityLauncher.ts`), real `icacls` labels and the real
 * probe. vitest's Node has no `bun:ffi`, so the layer is exercised by the fixture
 * `fixtures/containedShell.ts`, run under `bun` the way `processTreeJob.test.ts` runs its own,
 * and this file reads its one JSON line. CI (Ubuntu) shows none of it.
 *
 * The fixture works only inside the folder this test makes with mkdtemp; every folder it labels
 * is in there, and it removes its own junctions. This test removes the folder with a walk that
 * never enters a link.
 *
 * The argument parser and the bunfig file are checked everywhere.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAUNCHER_UNAVAILABLE, MSYS_IN_CONTAINED_RUN } from '../containment.js'
import { lowerOwnIntegrity, parseLauncherArgs } from '../lowIntegrityLauncher.js'

const PREFIX = 'cynco-launcher-'

/** Remove a folder this test made, never entering a link (a junction is removed as an entry). */
function removeOwnTree(dir: string): void {
  const abs = resolve(dir)
  if (dirname(abs) !== resolve(tmpdir()) || !basename(abs).startsWith(PREFIX)) {
    throw new Error(`refusing to remove ${abs}: not a ${PREFIX}* folder directly in the temp folder`)
  }
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) {
        try {
          rmdirSync(p)
        } catch (e) {
          console.log(`[containmentLauncher] ${p} is a file link (${(e as Error).message}); unlinking it`)
          unlinkSync(p)
        }
      } else if (st.isDirectory()) {
        walk(p)
        rmdirSync(p)
      } else {
        unlinkSync(p)
      }
    }
  }
  walk(abs)
  rmdirSync(abs)
}

describe('the launcher argument parser (everywhere)', () => {
  it('reads the three modes and the options before them', () => {
    expect(parseLauncherArgs(['--run-dir', 'R', '--cwd', 'C', '--env', 'A=1=2', '--shell', '', 'echo x'])).toEqual({
      ok: true, args: { mode: 'shell', runDir: 'R', cwd: 'C', env: { A: '1=2' }, shell: '', command: 'echo x' },
    })
    expect(parseLauncherArgs(['--run-dir', 'R', '--cwd', 'C', '--shell', 'powershell.exe', '--command-file', 'F'])).toEqual({
      ok: true, args: { mode: 'shell', runDir: 'R', cwd: 'C', env: {}, shell: 'powershell.exe', command: '', commandFile: 'F' },
    })
    expect(parseLauncherArgs(['--run-dir', 'R', '--cwd', 'C', '--exec', 'git', '--version'])).toEqual({
      ok: true, args: { mode: 'exec', runDir: 'R', cwd: 'C', env: {}, file: 'git', args: ['--version'] },
    })
    expect(parseLauncherArgs(['--run-dir', 'R', '--probe', 'out', 'in1', 'in2'])).toEqual({
      ok: true, args: { mode: 'probe', runDir: 'R', env: {}, mustFail: 'out', mustSucceed: ['in1', 'in2'] },
    })
    // A command that looks like an option is still the command.
    expect(parseLauncherArgs(['--run-dir', 'R', '--cwd', 'C', '--shell', '', '--cwd'])).toMatchObject({ ok: true, args: { command: '--cwd' } })
  })

  it('refuses what does not parse, naming it', () => {
    const reason = (argv: string[]) => {
      const r = parseLauncherArgs(argv)
      return r.ok ? null : r.reason
    }
    expect(reason(['--run-dir', 'R', '--cwd', 'C', '--bogus'])).toBe('unknown launcher mode --bogus')
    expect(reason(['--cwd', 'C', '--shell', '', 'x'])).toBe('unknown launcher mode (no --run-dir)')
    expect(reason(['--run-dir', 'R', '--shell', '', 'x'])).toBe('unknown launcher mode --shell (no --cwd)')
    expect(reason(['--run-dir', 'R', '--cwd', 'C', '--shell', '', 'a', 'b'])).toBe('unknown launcher mode --shell (expected one command, got 2 arguments)')
    expect(reason(['--run-dir', 'R', '--cwd', 'C', '--env', 'NOEQUALS', '--exec', 'x'])).toBe('unknown launcher mode (--env NOEQUALS is not KEY=VALUE)')
    expect(reason(['--run-dir', 'R', '--probe', 'only-one'])).toMatch(/^unknown launcher mode \(--probe needs/)
    expect(reason(['--run-dir', 'R', '--cwd', 'C'])).toBe('unknown launcher mode (none given)')
  })

  it('without bun:ffi the token is not lowered, and says so', () => {
    const why = lowerOwnIntegrity()
    expect(why?.startsWith(LAUNCHER_UNAVAILABLE('bun:ffi did not load: ').slice(0, -1)), String(why)).toBe(true)
  })

  it('the config file holds one comment line and no setting', () => {
    const text = readFileSync(fileURLToPath(new URL('../lowIntegrityLauncher.bunfig.toml', import.meta.url)), 'utf-8')
    expect(text).toBe('# The low-integrity launcher starts with this file so that no bunfig.toml of a mission folder is read.\n')
  })
})

const onWindows = process.platform === 'win32'
const bunPresent = onWindows && spawnSync('bun', ['--version'], { encoding: 'utf-8', shell: true }).status === 0
if (onWindows && !bunPresent) console.log('[containmentLauncher] SKIPPED: bun is not on PATH, so the Windows layer was not exercised')

const made: string[] = []
afterAll(() => {
  for (const d of made) removeOwnTree(d)
})

type Report = { ok: boolean; error?: string; engineJob?: boolean; isolation?: string; establishMs?: number; volumesAcknowledged?: string[]; cases: Record<string, any> }

describe.skipIf(!onWindows || !bunPresent)('the low-integrity launcher under Bun on Windows (fixtures/containedShell.ts)', () => {
  let report: Report | null = null
  let failure = ''
  const get = (): Report => {
    if (report) return report
    if (failure) throw new Error(failure)
    const dir = mkdtempSync(join(tmpdir(), PREFIX))
    made.push(dir)
    const env = { ...process.env }
    delete env.LOCALCODE_CONTAINMENT_OFF
    const run = spawnSync('bun', ['engine/__tests__/fixtures/containedShell.ts', `"${dir}"`], { encoding: 'utf-8', shell: true, timeout: 240_000, env })
    const last = String(run.stdout ?? '').trim().split('\n').pop() ?? ''
    try {
      report = JSON.parse(last) as Report
    } catch (e) {
      failure = `the fixture printed no report (status ${run.status}, ${(e as Error).message}):\n${run.stdout}\n${run.stderr}`
      throw new Error(failure)
    }
    if (!report.ok) {
      failure = `the fixture could not start: ${report.error}\n${run.stdout}\n${run.stderr}`
      throw new Error(failure)
    }
    const c = report.cases
    console.log(`[containmentLauncher] establish ${report.establishMs} ms, isolation ${report.isolation}, volumes acknowledged in the fixture's own environment: ${JSON.stringify(report.volumesAcknowledged)}`)
    console.log(`[containmentLauncher] overhead (median of 10 'exit 0'): ${JSON.stringify(c.overhead)}`)
    console.log(`[containmentLauncher] burst: ${JSON.stringify(c.burst)}; maxBuffer: ${JSON.stringify(c.maxBuffer)}`)
    console.log(`[containmentLauncher] exit 300 arrives as ${JSON.stringify(c.relay?.codes?.['300'])}`)
    console.log(`[containmentLauncher] release: ${JSON.stringify(c.release)}`)
    if (c.msysHint?.notRun) console.log(`[containmentLauncher] msys hint not run: ${c.msysHint.notRun}`)
    return report
  }
  const ok = (name: string) => {
    const v = get().cases[name]
    expect(v, `case ${name} did not report`).toBeDefined()
    expect(v.threw, `case ${name} threw`).toBeUndefined()
    return v
  }

  it('level: a contained child is at low integrity, an uncontained one at medium, and the probe passed', () => {
    const v = ok('level')
    expect(v.contained, v.containedErr ?? '').toBe('S-1-16-4096')
    expect(v.plain).toBe('S-1-16-8192')
    expect(get().isolation).toBe('verified')
    expect(get().engineJob, 'the engine\'s kill-on-close job is installed in the fixture, as in main.ts').toBe(true)
  }, 300_000)

  it('relay: exit codes and the two streams arrive as they do with no context; quoting is byte-identical', () => {
    const v = ok('relay')
    expect(v.codes['0']).toMatchObject({ code: 0, plainCode: 0, stdout: 'to-stdout', stderr: 'to-stderr' })
    expect(v.codes['7']).toMatchObject({ code: 7, plainCode: 7, stdout: 'to-stdout', stderr: 'to-stderr' })
    // Under Bun on Windows a status is cut to its low 8 bits on the direct path as well (measured:
    // 300 arrives as 44 both ways); what the launcher must do is not change it.
    expect(v.codes['300'].code).toBe(v.codes['300'].plainCode)
    expect(v.codes['300'].code).not.toBe(0)
    for (const q of v.quoting) expect(q.same, `${q.shell}: ${JSON.stringify(q)}`).toBe(true)
  })

  it('text: a multi-line here-string and non-ASCII text arrive as the text the command printed', () => {
    const v = ok('text')
    // Judged against the literal text, not against the direct path: a direct PowerShell child's
    // non-ASCII output depends on the console the test runner was started in (measured garbled in
    // one run and correct in the next), the launcher's child came out as UTF-8 in every run.
    expect(v.hereString.err).toBeNull()
    expect(v.hereString.contained).toBe('line one\r\nline "two" with \'quotes\'\r\nafter\r\n')
    expect(v.nonAscii.err).toBeNull()
    expect(v.nonAscii.contained).toBe('Grüße, naïve café — 日本\r\n')
  })

  it('long command: 20,000 characters through --command-file, and the file is gone afterwards', () => {
    const v = ok('longCommand')
    expect(v.viaFile).toBe(true)
    expect(v.err).toBeNull()
    expect(v.printed).toBe(20_000)
    expect(v.commandFilesLeft).toEqual([])
  })

  it('no-shell form: toolExec with no shell option runs through --shell \'\' and sees the sandbox home', () => {
    const v = ok('noShellForm')
    expect(v.err).toBeNull()
    expect(v.printed).toBe(v.home)
  })

  it('did not run: 197 with the launcher\'s line, and a missing record is a ContainmentRefusal ECONTAINMENT', () => {
    const v = ok('didNotRun')
    // Each of the launcher's own 197 lines is followed by its seal line for this spawn.
    expect(v.seal).toMatch(/^[0-9a-f]{32}$/)
    expect(v.missing.status).toBe(197)
    expect(v.missing.stderr.split(/\r?\n/)).toEqual(['[containment] refused: the command could not be started (ENOENT)', `[containment] sealed ${v.seal} 197`])
    expect(v.unknownMode.status).toBe(197)
    expect(v.unknownMode.stderr.split(/\r?\n/)).toEqual(['[containment] refused: unknown launcher mode --bogus-mode', `[containment] sealed ${v.seal} 197`])
    expect(v.noRecord.code).toBe('ECONTAINMENT')
    expect(v.noRecord.isRefusal).toBe(true)
    expect(v.noRecord.message).toMatch(/^Refused \[containment\]: the containment record .* could not be read/)
    expect(v.noRecord.stdout).toBe('')
  })

  it('planted config (entry 1.B1): a bunfig.toml preload, a sandbox-home .bunfig.toml and a .env are never read', () => {
    const v = ok('plantedConfig')
    expect(v.err).toBeNull()
    expect(v.printed).toBe('PLANTED=[]')
    expect(v.witnesses).toEqual([])
  })

  it('planted config in the launcher\'s own working folder: not read with the two flags, read without either', () => {
    const v = ok('plantedConfigInLauncherCwd')
    expect(v.exact, JSON.stringify(v.exact)).toMatchObject({ printed: 'PLANTED=[]', status: 0, witness: false })
    // The same start without --no-env-file reads the .env; without --config= it runs the preload.
    expect(v.noEnvFlag.printed, JSON.stringify(v.noEnvFlag)).toBe('PLANTED=[cfg]')
    expect(v.noConfigFlag.witness, JSON.stringify(v.noConfigFlag)).toBe(true)
  })

  it('probe leftovers: a probe-1.tmp of the owner\'s in the mission folder and the extra root survives establish', () => {
    expect(ok('probeLeftovers')).toEqual({ mission: true, extra: true })
  })

  it('denied and allowed: outside, the run folder and the home are denied; scratch, temp, mission and extra root are written', () => {
    const v = ok('deniedAndAllowed')
    for (const k of ['outside', 'runFolder', 'fakeHome']) {
      expect(v.said[k], k).toBe('denied')
      expect(v.exists[k], k).toBe(false)
    }
    for (const k of ['scratch', 'temp', 'mission', 'extra']) {
      expect(v.said[k], k).toBe('created')
      expect(v.exists[k], k).toBe(true)
    }
    expect(v.said.HOME).toBe(v.sandbox.home)
    expect(v.said.SCRATCH).toBe(v.sandbox.scratch)
    expect(v.said.TEMP).toBe(v.sandbox.tmp)
  })

  it('junction out: a junction from the mission folder to a medium folder is refused', () => {
    const v = ok('junctionOut')
    expect(v.made, v.output).not.toBe('link')
  })

  it('sync sites: toolExecSync throws with the status and stdout execSync gives; input reaches stdin', () => {
    const v = ok('syncSites')
    expect(v.contained.threw).toBe(true)
    expect(v.contained.status).toBe(v.plain.status)
    expect(v.contained.stdout).toBe(v.plain.stdout)
    expect(v.input.threw, JSON.stringify(v.input)).toBe(false)
    expect(v.input.out.trim()).toBe('line from stdin')
  })

  it('Git tool shape: Bun.spawn of containedCommand runs git --version through the launcher', () => {
    const v = ok('gitToolShape')
    expect(v.viaLauncher).toBe(true)
    expect(v.code).toBe(0)
    expect(v.stdout).toMatch(/^git version /)
  })

  it('the tree (F210): the job taken on the launcher\'s pid ends a burst with no survivor', () => {
    const v = ok('burst')
    expect(v.kind).toBe('job')
    expect(v.engineJob).toBe(true)
    expect(v.startedAtKill).toBeGreaterThan(3)
    expect(v.startedAtKill).toBeLessThan(v.children)
    expect(v.survivors).toBe(0)
  })

  it('maxBuffer: 3 MiB against 2 MiB ends the launcher, and its child does not outlive it', () => {
    const v = ok('maxBuffer')
    expect(v.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect(v.started).toBe(true)
    expect(v.marker).toBe(false)
  })

  it('through the tools: one bashTool.execute runs at low integrity with the sandbox home', () => {
    const v = ok('throughTheTool')
    expect(v.isError, v.output).toBe(false)
    expect(v.level, v.output).toBe('S-1-16-4096')
    expect(String(v.home).toLowerCase().replace(/\\/g, '/'), v.output).toBe(String(v.sandboxHome).toLowerCase().replace(/\\/g, '/'))
  }, 300_000)

  it('scratch (S3): a contained shell is given CYNCO_SCRATCH, the context\'s scratch folder, and it exists', () => {
    const v = ok('scratchThroughTheTool')
    expect(v.isError, v.output).toBe(false)
    expect(v.first, v.output).not.toBe('')
    expect(String(v.first).toLowerCase().replace(/\\/g, '/'), v.output).toBe(String(v.scratch).toLowerCase().replace(/\\/g, '/'))
    expect(v.second, v.output).toBe('True')
  }, 300_000)

  it('through the sites (S2a): a contract check, the Git tool, ApplyPatch and best-of-N tests run low, with the sandbox home', () => {
    const v = ok('throughTheSites')
    const slash = (p: unknown) => String(p).toLowerCase().replace(/\\/g, '/')
    expect(v.contract.outcome, v.contract.tail).toBe('passed')
    expect(v.contract.level, v.contract.tail).toBe('S-1-16-4096')
    expect(slash(v.contract.home), v.contract.tail).toBe(slash(v.sandboxHome))
    expect(v.git.isError, v.git.output).toBe(false)
    expect(v.git.output).toBe('true')
    expect(v.applyPatch.isError, v.applyPatch.output).toBe(false)
    expect(v.applyPatch.created).toBe(true)
    expect(v.runTests.refused).toBeNull()
    expect(v.runTests.level).toBe('S-1-16-4096')
  })

  it('a launcher that exits 197: the contract check is unrunnable (never failed), the Git tool refuses, nothing ran', () => {
    const v = ok('sitesLauncherRefused')
    expect(v.contract.outcome, v.contract.tail).toBe('unrunnable')
    expect(v.contract.tail).toContain('[containment] refused:')
    expect(v.git.isError).toBe(true)
    expect(v.git.output).toMatch(/^Refused \[containment\]: /)
    expect(v.witness).toBe(false)
  })

  it('the daemon precheck runs contained with no label on its folder, answers its exit code, and is released', (t) => {
    const v = ok('precheck')
    if (v.skipped) {
      console.log(`[containmentLauncher] precheck case skipped: ${v.skipped}`)
      t.skip()
      return
    }
    const slash = (p: unknown) => String(p).toLowerCase().replace(/\\/g, '/')
    expect(v.printed.code, v.printed.stdout).toBe(0)
    expect(v.printed.level, v.printed.stdout).toBe('S-1-16-4096')
    expect(v.exited).toEqual({ code: 3, stdout: 'go' })
    expect(v.records.length).toBe(2)
    for (const r of v.records) {
      expect(r.runId.startsWith('precheck-fixture-trades-')).toBe(true)
      expect(r.test).toBe(false)
      expect(r.cwdLabel).toBe('none')
      expect(r.released).toBe(true)
      expect(r.releasedBy).toBe('release')
    }
    expect(v.records.map((r: { home: string }) => slash(r.home))).toContain(slash(v.printed.home))
    // No label was set on the folder, before, during or after; and nothing was written in it.
    expect(v.labelBefore).toEqual([])
    expect(v.labelAfter).toEqual([])
    expect(v.written).toEqual([])
    // S5: each precheck command has a start and an end in the tool-call audit, the second with its code.
    expect(v.audited).toEqual([
      { kind: 'start', src: 'precheck', exitCode: null }, { kind: 'end', src: 'precheck', exitCode: 0 },
      { kind: 'start', src: 'precheck', exitCode: null }, { kind: 'end', src: 'precheck', exitCode: 3 },
    ])
    // S5 fail closed (review): an audit folder without its marker; the start is not written, so the
    // command does not run, the answer is the skip line, and the sandbox is released all the same.
    expect(v.blocked.code).toBe(0)
    expect(v.blocked.stdout).toMatch(/^skip: precheck not run: audit: /)
    expect(v.blocked.witness).toBe(false)
    expect(v.blocked.records).toEqual([{ released: true }])
    expect(v.blocked.unmarkedFiles).toEqual([])
  })

  // Review of slice S5: the launcher's lines printed by the command itself, with its codes.
  it('a command that prints the launcher\'s lines and exits 197 or 198 keeps its own exit code, and no fault is raised', () => {
    const v = ok('forgedLauncherLines')
    expect(v.results.map((r: { exitCode: unknown }) => r.exitCode), JSON.stringify(v.results)).toEqual([197, 198])
    for (const r of v.results) expect(r.isError).toBe(true)
    expect(v.faults).toEqual([])
    expect(v.ends).toEqual([197, 198])
  })

  // MEASURED, 2026-11-23, Windows 11 26200, Bun 1.3.13, PowerShell 5.1: the seal rests on Windows'
  // no-read-up policy on process objects. The launcher lowers its own TOKEN after it was created, and
  // its process object keeps the label it was created with, medium with no-read-up and no-write-up
  // (S:AI(ML;;NWNR;;;ME)); so its low child is refused every right that reads its memory (error 5),
  // and so is the starter. A MAXIMUM_ALLOWED open is granted SYNCHRONIZE, QUERY_LIMITED_INFORMATION
  // and TERMINATE only (0x00101001): the child can end its launcher, which yields an unsealed status,
  // never a forged "did not run". The command line carries no seal, the child's own environment
  // holds none, its handle table holds no handle to either process, and the launcher's own block no
  // longer holds it either once the launcher has taken it out (read by a medium process).
  // ALSO MEASURED, and not a property of this code: the child inherits every inheritable handle of
  // the chain it was started from. Started from Git Bash, it held four Process handles msys had made
  // inheritable (SYNCHRONIZE | QUERY_LIMITED_INFORMATION | VM_READ | VM_OPERATION), and through the
  // one to a live medium bash.exe it READ that process's environment block: a handle's granted access
  // is not checked against the integrity label again. The seal stays out of reach only because no
  // process that holds a seal (the starter, a launcher) is ever the target of an inheritable handle;
  // the case pins that, and logs the rest.
  it('the seal: a contained child cannot learn its launcher\'s seal by any route a command has (MEASURED)', (t) => {
    const v = ok('sealUnreadable')
    if (v.skipped) {
      console.log(`[containmentLauncher] seal case skipped: ${v.skipped}`)
      t.skip()
      return
    }
    expect(v.error, JSON.stringify(v)).toBeUndefined()
    expect(v.seal).toMatch(/^[0-9a-f]{32}$/)
    expect(v.code, v.stderr).toBe(0)
    expect(v.pidsAsExpected, JSON.stringify(v.routes.pids)).toBe(true)
    const r = v.routes as Record<string, { hasSeal: boolean; hasMark: boolean; head: string }>
    // The controls: where the child may read, the same reads find the marker its starter passed it.
    expect(r.ownEnv.hasMark).toBe(true)
    expect(r.ownPeb.head, 'the PEB read of its own block').toMatch(/^read: \d+ characters$/)
    expect(r.ownPeb.hasMark).toBe(true)
    for (const [name, route] of Object.entries(r)) expect(route.hasSeal, `route ${name}: ${route.head}`).toBe(false)
    for (const name of ['launcherPeb', 'launcherPebLimited', 'enginePeb', 'launcherLabel']) expect(r[name].head, name).toBe('OpenProcess error 5')
    expect(r.launcherOpen.head).toBe('VM_READ=OpenProcess error 5; QUERY_INFORMATION=OpenProcess error 5; QUERY_LIMITED=opened; DUP_HANDLE=OpenProcess error 5; READ_CONTROL=OpenProcess error 5')
    // VM_READ, VM_WRITE, VM_OPERATION, QUERY_INFORMATION, DUP_HANDLE, READ_CONTROL, WRITE_DAC: none granted.
    for (const name of ['launcherGranted', 'engineGranted']) {
      expect(r[name].head, name).toMatch(/^0x[0-9A-F]{8}$/)
      expect(parseInt(r[name].head, 16) & (0x10 | 0x20 | 0x8 | 0x400 | 0x40 | 0x20000 | 0x40000), `${name} ${r[name].head}`).toBe(0)
    }
    expect(v.handlesToLauncherOrEngine, JSON.stringify(v.handles)).toEqual([])
    // Review of wave 5: through an inheritable handle to its medium Git Bash starter the low child read that
    // shell's environment block. The launcher now makes every handle it inherited non-inheritable before it
    // starts the child, so the child holds no inherited process handle at all, and reads no environment through one.
    expect(v.handles.filter((h: string) => / inherit=1/.test(h)), JSON.stringify(v.handles)).toEqual([])
    expect(v.handles.filter((h: string) => / env=read/.test(h)), JSON.stringify(v.handles)).toEqual([])
    // Read by a medium process while the child waited: the launcher's token is low, its process
    // object keeps the medium label it was created with; the child's object is labelled low.
    expect(v.medium.launcherToken, JSON.stringify(v.medium)).toBe('S-1-16-4096')
    expect(v.medium.launcherLabel).toMatch(/\(ML;;NWNR;;;ME\)/)
    expect(v.medium.childToken).toBe('S-1-16-4096')
    expect(v.medium.childLabel).toMatch(/\(ML;;NWNR;;;LW\)/)
    expect(v.medium.launcherEnvRead, 'the medium control reads the launcher\'s block').toBe(true)
    expect(v.medium.launcherEnvHasSeal).toBe(false)
    console.log(`[containmentLauncher] seal: launcher granted ${r.launcherGranted.head} to its child; label ${v.medium.launcherLabel}; startInfo: ${r.startInfo.head}; handles ${JSON.stringify(v.handles)}`)
  })

  // S2c, entry 1.B2 (06 entry A7): the authoring check inside an authoring mission's containment.
  it('authoring check: a contained child writes the BASE archive (an extra root) and runs its tests there; release leaves no Low label', () => {
    const v = ok('authoringCheck')
    if (v.notRun) {
      console.log(`[containmentLauncher] authoring check not run: ${v.notRun}`)
      return
    }
    expect(v.establish).toBeUndefined()
    expect(v.probe).toEqual({ err: null, created: true })
    expect(v.tests.code, v.tests.output).toBe(0)
    if (v.tests.form !== 'pytest') console.log(`[containmentLauncher] authoring check: ${v.tests.form}`)
    // Whatever the check did, it made no second sandbox.
    expect(v.nestedRecords).toBe(0)
    const rel = ok('authoringCheckRelease')
    expect(rel.relabelled, rel.note).toBe(true)
    for (const lines of [rel.probeLabels, rel.baseLabels, rel.stagingLabels]) {
      expect((lines as string[]).some(l => /Low Mandatory Level/i.test(l)), JSON.stringify(rel)).toBe(false)
    }
  })

  // MEASURED, 2026-11-23, Bun 1.3.13 on Windows 11: entry 1.B2 part 2 (06 entry A7) assumes that
  // `bun <checkout>/scripts/cynco-gate-author.mjs --check ...` runs inside a contained run. It does
  // not: a Bun process at low integrity cannot load ANY module file from a folder that is not
  // labelled low (`error: EPERM reading "<file>"`, also for C:\Windows\System32\drivers\etc\hosts),
  // while node and PowerShell at the same level read the same files. The check exits 1 before it
  // reads its staging folder. A7's acceptance (the check's own `[check] a1: REFUSED` verdict, its
  // gates run in the BASE) therefore does NOT hold, and how the authoring check is to run is the
  // owner's decision (run it as a harness process from the checkout, or refuse authoring
  // dispatches). Until then the outcome pinned here is the review's minimum (rule F35): the exit is
  // classified by `launcherFaultOf` as "did not run" (`ContainmentRefusal`, code ECONTAINMENT, the
  // file named), so the driver and the contract read a harness fault and never a FAILED check. This
  // case fails, and is revisited, the day a contained Bun can load the script.
  it('authoring check, MEASURED: a low-integrity Bun cannot load the check script (EPERM), and that reads as "did not run", never as a failed check', () => {
    const v = ok('authoringCheck')
    if (v.notRun) return
    for (const form of [v.empty, v.staged]) {
      expect(form.isRefusal, form.output).toBe(true)
      expect(form.code, form.output).toBe('ECONTAINMENT')
      expect(form.message).toMatch(/^Refused \[containment\]: Bun at low integrity could not read .*cynco-gate-author\.mjs \(EPERM\).*did not run/)
      expect(form.output).toMatch(/EPERM reading ".*cynco-gate-author\.mjs"/)
      expect(form.output).not.toContain('[check] a1:')
    }
    expect(v.staged.gateRan).toBe(false)
    console.log('[containmentLauncher] KNOWN: the gate-authoring check cannot run inside a contained run on this Bun (EPERM loading a medium-integrity module at low integrity); it reads as "did not run". Entry 1.B2 part 2 / 06 A7 waits on the owner')
  })

  it('msys hint: Git Bash that cannot start says why, on the failure and on the success path', () => {
    const v = ok('msysHint')
    if (v.notRun) return
    expect(v.msysLine).toBe(true)
    expect(v.failureHint).toContain(MSYS_IN_CONTAINED_RUN)
    expect(v.successCode).toBe(0)
    expect(v.successHint).toContain(MSYS_IN_CONTAINED_RUN)
  })

  it('label leak: a junction three levels down carries no Low label out, and a child is denied through it', () => {
    const v = ok('labelLeakAfterEstablish')
    expect(v.lowUnderOutside).toEqual([])
    expect(v.throughJunction).toBe('denied')
    expect(v.throughExists).toBe(false)
    expect(v.missionLabel.join(' ')).toMatch(/Low Mandatory Level/)
    expect(v.extraLabel.join(' ')).toMatch(/Low Mandatory Level/)
    expect(ok('afterRelease').lowUnderOutside).toEqual([])
  })

  it('labelResidue (rule R4) and release: nothing under the mission folder or the extra root stays Low', () => {
    const w = ok('residueWrite')
    expect(w.err).toBeNull()
    // The run set low labels of its own (not inherited), which the root relabel alone leaves in place.
    for (const [p, labels] of Object.entries(w.explicit as Record<string, string[]>)) {
      expect(labels.join(' '), p).toMatch(/Low Mandatory Level:\((OI|NW)/)
    }
    const rel = get().cases.release
    expect(rel.relabelled, rel.note).toBe(true)
    const v = ok('afterRelease')
    for (const [p, r] of Object.entries(v.residue as Record<string, { labels: string[]; low: boolean }>)) expect(r.low, `${p}: ${r.labels.join(' ')}`).toBe(false)
    expect(v.lowChildCreates).toEqual(['denied', 'denied', 'denied', 'denied', 'denied', 'denied'])
    expect(v.createdFiles.every((x: boolean) => x === false)).toBe(true)
    expect(v.missionLabel.join(' ')).toMatch(/Medium Mandatory Level/)
    expect(v.extraLabel.join(' ')).toMatch(/Medium Mandatory Level/)
    expect(rel.note).toMatch(/4 set back|2 set back/)
  })

  it('a release the run blocked is said, and the next establish for that folder refuses while it reads low', () => {
    const v = ok('releaseBlocked')
    expect(v.establish2, 'the second establish').toBeUndefined()
    expect(v.denyErr, v.denyOut).toBeNull()
    expect(v.relabelled, v.note).toBe(false)
    expect(v.note).toContain('could not be set back to medium integrity')
    expect(v.lowAfterRelease).toBe(true)
    expect(v.nextEstablish).toMatch(/^the mission folder .*mission2 is already labelled low integrity and no live run holds it/)
    expect(v.cleanedUp).toBe(true)
  })
})
