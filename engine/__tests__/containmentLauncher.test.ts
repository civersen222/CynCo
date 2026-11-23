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
    expect(v.missing.status).toBe(197)
    expect(v.missing.stderr).toBe('[containment] refused: the command could not be started (ENOENT)')
    expect(v.unknownMode.status).toBe(197)
    expect(v.unknownMode.stderr).toBe('[containment] refused: unknown launcher mode --bogus-mode')
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
