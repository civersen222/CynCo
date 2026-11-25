/**
 * The four harness sites that start workspace code without the executor (the contract check, a
 * best-of-N test run, LSP diagnostics, the daemon precheck) and a command Windows would cut or cannot
 * carry (wave 19b, from package C's measurement: `engine/tools/impl/bash.ts` `longCommandRefusal`).
 *
 * Measured with the Bash tool on 2026-11-25: from 32,741 characters the spawn threw `ENAMETOOLONG`
 * instead of answering, and Git's bash and sh run only the first 8,190 or so characters of a `-c`
 * text and exit 0. A site that started such a command would either throw (an answer nobody reads)
 * or score a command that ran cut short. Each site asks `longCommandRefusal` before anything starts
 * and gives its own "did not run" word: `unrunnable`, `refused`, no diagnostics, `skip`. A spawn that
 * throws anyway is the same "did not run", never a throw out of the site.
 *
 * `longCommandRefusal` answers on Windows only; here it is asked as on Windows whatever the host,
 * so every case runs on the Linux CI too. `toolExec` is the seam: it counts its starts and either
 * answers at once or throws as a spawn that cannot carry its command line does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  starts: 0,
  programStarts: 0,
  establishes: 0,
  releases: 0,
  mode: 'answer' as 'answer' | 'throw',
  records: [] as Array<[string, Record<string, unknown>]>,
  windowsPowerShell: false,
}))

vi.mock('../tools/shellInfo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tools/shellInfo.js')>()
  // The contract check's shell as on Windows PowerShell 5.1 (its preamble included) for the one case that
  // sets it, whatever the host; every other case sees the host's own shell, as before.
  return { ...real, getShellInfo: () => (seam.windowsPowerShell ? real.classifyShell('win32', false) : real.getShellInfo()) }
})

vi.mock('../tools/impl/bash.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tools/impl/bash.js')>()
  // Asked as on Windows whatever the host, so the cases hold on the Linux CI.
  return { ...real, longCommandRefusal: (command: string, runnable: string) => real.longCommandRefusal(command, runnable, 'win32') }
})

vi.mock('../containment.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../containment.js')>()
  return {
    ...real,
    toolSpawnRefusal: () => null,
    toolExec: (_command: string, _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      seam.starts++
      if (seam.mode === 'throw') throw Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG', errno: -4064, syscall: 'spawn' })
      setTimeout(() => callback(null, '', ''), 5)
      return { pid: undefined }
    },
    containedCommand: (...a: Parameters<typeof real.containedCommand>) => { seam.programStarts++; return real.containedCommand(...a) },
    establishContainment: () => { seam.establishes++; return { ok: true, containment: { runId: 'test-precheck' } } },
    releaseContainment: () => { seam.releases++; return { relabelled: true } },
  }
})

vi.mock('../audit/toolAudit.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audit/toolAudit.js')>()
  // A recording handle in place of a day file: what each site writes, in order.
  const handle = {
    start: (r: Record<string, unknown>) => { seam.records.push(['start', r]); return { ok: true, call: seam.records.length } },
    end: (_call: number, r: Record<string, unknown>) => { seam.records.push(['end', r]) },
    refused: (r: Record<string, unknown>) => { seam.records.push(['refused', r]) },
  }
  return { ...real, toolAudit: () => handle }
})

const { runCommandDetailed } = await import('../tools/contractVerify.js')
const { runTests } = await import('../bestOfN/sampler.js')
const { LSPManager } = await import('../lsp/manager.js')
const { runPrecheck } = await import('../daemon/precheck.js')
const { setContainmentFaultSink } = await import('../audit/toolAudit.js')

const faults: Array<[string, string]> = []
setContainmentFaultSink((layer, reason) => { faults.push([layer, reason]) })
afterEach(() => {
  seam.starts = 0; seam.programStarts = 0; seam.establishes = 0; seam.releases = 0
  seam.mode = 'answer'; seam.records.length = 0; faults.length = 0; seam.windowsPowerShell = false
})

const cwd = process.cwd()
const pytest = (command: string) => ({ available: true, framework: 'pytest' as const, command })
/** Longer than one Windows command line carries (32,000 characters with the shell's own words). */
const tooLongForWindows = `echo ${'x'.repeat(33_000)}`
/** Starts Git's bash with a `-c` text it would run cut short (over 8,000 characters). */
const cutByGitBash = `bash -c "echo START; : ${'y'.repeat(8_200)}; echo END"`
const WINDOWS_LINE = /^Error: the command is \d+ characters long, longer than one Windows command line carries/
const POSIX_SHELL = /^Error: this command starts a POSIX shell \(bash or sh\) and is \d+ characters long/
// The LSP manager's command runner is private; the tsc form takes shell text, as a site would.
const lspRun = (m: InstanceType<typeof LSPManager>, cmd: { shell: string } | { file: string; args: string[] }) =>
  (m as unknown as { runDiag(c: typeof cmd, t: number): Promise<{ ran: boolean; err: unknown }> }).runDiag(cmd, 5000)

describe('a command Windows would cut or cannot carry is not started at the four harness sites', () => {
  for (const [name, command, reason] of [
    ['over one Windows command line', tooLongForWindows, WINDOWS_LINE],
    ["a POSIX shell's -c text Git's bash would cut", cutByGitBash, POSIX_SHELL],
  ] as const) {
    it(`contract check (${name}): unrunnable with the reason, nothing started, a refused record`, async () => {
      const r = await runCommandDetailed(cwd, command, 5000)
      expect(r.outcome).toBe('unrunnable')
      expect(r.tail).toMatch(reason)
      expect(seam.starts).toBe(0)
      expect(seam.records.map(([k, v]) => [k, v.src, v.by])).toEqual([['refused', 'contract', 'site']])
      expect(faults).toEqual([])
    })

    it(`best-of-N tests (${name}): refused with the reason, no score, nothing started, a refused record`, async () => {
      const r = await runTests(cwd, pytest(command), 5000)
      expect(r.refused ?? '').toMatch(reason)
      expect(r).toMatchObject({ passed: 0, total: 0, output: '' })
      expect(seam.starts).toBe(0)
      expect(seam.records.map(([k, v]) => [k, v.src, v.by])).toEqual([['refused', 'best-of-n', 'site']])
      expect(faults).toEqual([])
    })

    it(`LSP diagnostics (${name}): none, nothing started, a refused record`, async () => {
      const r = await lspRun(new LSPManager(cwd), { shell: command })
      expect(r).toEqual({ ran: false, err: null })
      expect(seam.starts).toBe(0)
      expect(seam.records.map(([k, v]) => [k, v.src, v.by])).toEqual([['refused', 'lsp', 'site']])
      expect(String(seam.records[0][1].reason)).toMatch(reason)
      expect(faults).toEqual([])
    })

    it(`daemon precheck (${name}): skip with the reason, no sandbox made, nothing started`, async () => {
      const r = await runPrecheck(command, cwd, 't-long')
      expect(r.code).toBe(0)
      expect(r.stdout).toMatch(/^skip: precheck not run: Error: /)
      expect(r.stdout.slice('skip: precheck not run: '.length)).toMatch(reason)
      expect(seam.establishes).toBe(0)
      expect(seam.starts).toBe(0)
    })
  }

  it('contract check: a command under the line that the shell preamble pushes past it is unrunnable (wave 19c, check D19b-5)', async () => {
    // What reaches the shell is judged, not the model's text alone: 31,990 characters plus Windows
    // PowerShell's preamble is more than one command line carries.
    seam.windowsPowerShell = true
    const command = `echo ${'x'.repeat(31_985)}`
    const { getShellInfo, shellPreamble } = await import('../tools/shellInfo.js')
    expect(command.length).toBeLessThanOrEqual(32_000)
    expect(command.length + shellPreamble(getShellInfo()).length).toBeGreaterThan(32_000)
    const r = await runCommandDetailed(cwd, command, 5000)
    expect(r.outcome).toBe('unrunnable')
    expect(r.tail).toMatch(WINDOWS_LINE)
    expect(seam.starts).toBe(0)
    expect(seam.records.map(([k, v]) => [k, v.src, v.by])).toEqual([['refused', 'contract', 'site']])
    expect(faults).toEqual([])
  })

  it('LSP diagnostics in the program form: a file argument past the line is not started either', async () => {
    const r = await lspRun(new LSPManager(cwd), { file: 'python', args: ['-m', 'py_compile', `${'z'.repeat(33_000)}.py`] })
    expect(r).toEqual({ ran: false, err: null })
    expect(seam.programStarts).toBe(0)
    expect(seam.records.map(([k, v]) => [k, v.src, v.by])).toEqual([['refused', 'lsp', 'site']])
  })

  it('a command under both limits is started at every site (the check refuses nothing else)', async () => {
    const short = `echo ${'s'.repeat(7_000)}`
    expect((await runCommandDetailed(cwd, short, 5000)).outcome).toBe('passed')
    expect((await runTests(cwd, pytest(short), 5000)).refused).toBeUndefined()
    expect((await lspRun(new LSPManager(cwd), { shell: short })).ran).toBe(true)
    expect((await runPrecheck(short, cwd, 't-short')).stdout).toBe('')
    expect(seam.starts).toBe(4)
  })
})

describe('a spawn that throws (ENAMETOOLONG) is a "did not run" answer at the four harness sites, never a throw', () => {
  it('contract check: unrunnable, the start record ended', async () => {
    seam.mode = 'throw'
    const r = await runCommandDetailed(cwd, 'echo short', 5000)
    expect(r.outcome).toBe('unrunnable')
    expect(r.tail).toBe('spawn ENAMETOOLONG')
    expect(seam.records.map(([k]) => k)).toEqual(['start', 'end'])
    expect(faults).toEqual([])
  })

  it('best-of-N tests: refused, no score, no containment fault', async () => {
    seam.mode = 'throw'
    const r = await runTests(cwd, pytest('python -m pytest'), 5000)
    expect(r).toEqual({ passed: 0, total: 0, output: '', refused: 'spawn ENAMETOOLONG' })
    expect(faults).toEqual([])
  })

  it('LSP diagnostics: none, no containment fault', async () => {
    seam.mode = 'throw'
    expect(await lspRun(new LSPManager(cwd), { shell: 'npx tsc --noEmit' })).toEqual({ ran: false, err: null })
    expect(faults).toEqual([])
  })

  it('daemon precheck: skip, and its sandbox is released', async () => {
    seam.mode = 'throw'
    const r = await runPrecheck('echo short', cwd, 't-throw')
    expect(r).toEqual({ code: 0, stdout: 'skip: precheck not run: spawn ENAMETOOLONG' })
    expect(seam.establishes).toBe(1)
    expect(seam.releases).toBe(1)
  })
})
