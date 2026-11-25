// engine/__tests__/daemon/baselineChild.test.ts
// Wave 15 (NOW.md:83): the daemon takes a run's integrity baseline in a process of its own
// (`bun scripts/cynco-guard.mjs pre`), awaited, so the walk (6 to 9 s cold) is not on the daemon's
// event loop; a child that cannot start, fails or hangs refuses the run, never lets it go on.
// The guard command is stood in for by a small script of this file's own temp folder (run by this
// process's own runtime), so nothing here reads the real profile or writes a real guard folder.
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TaskRunner, baselineInChild, bunNoInstall, guardPreArgv } from '../../daemon/taskRunner.js'
import * as I from '../../integrity.js'

const dir = mkdtempSync(join(tmpdir(), 'cynco-baseline-child-'))
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

/** A stand-in for scripts/cynco-guard.mjs: writes its argv, waits `ms`, prints `out`/`err`, exits `code`. */
function standIn(name: string, o: { ms?: number; code?: number; out?: string; err?: string }): string {
  const file = join(dir, `${name}.mjs`)
  const argvFile = join(dir, `${name}.argv.json`)
  writeFileSync(file, [
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
    `setTimeout(() => {`,
    o.out ? `  process.stdout.write(${JSON.stringify(o.out)} + '\\n')` : '',
    o.err ? `  process.stderr.write(${JSON.stringify(o.err)} + '\\n')` : '',
    `  process.exit(${o.code ?? 0})`,
    `}, ${o.ms ?? 0})`,
  ].join('\n'))
  return file
}
const argvOf = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.argv.json`), 'utf-8')) as string[]

describe('the daemon\'s baseline in a process of its own', () => {
  it('the guard command\'s argv: the run, its folder or --no-cwd, the holder, the deadline', () => {
    expect(guardPreArgv({ runId: 'r-1', cwd: 'C:/m', by: 'daemon', holderPid: 42, maxSeconds: 2700 }))
      .toEqual(['pre', 'r-1', '--cwd', 'C:/m', '--by', 'daemon', '--holder-pid', '42', '--max-seconds', '2700'])
    expect(guardPreArgv({ runId: 'r-1', cwd: undefined, by: 'daemon', holderPid: 42, maxSeconds: 2700 }))
      .toEqual(['pre', 'r-1', '--no-cwd', '--by', 'daemon', '--holder-pid', '42', '--max-seconds', '2700'])
  })

  it('a child that exits 0 resolves with its lines, and the event loop runs while it works', async () => {
    const script = standIn('ok', { ms: 400, out: '[guard] integrity baseline r-1: 3 frozen entries, 4 presence entries, 5 ms' })
    let ticks = 0
    const t = setInterval(() => { ticks++ }, 50)
    try {
      const lines = await baselineInChild({ runId: 'r-1', cwd: 'C:/m', by: 'daemon', holderPid: 42, maxSeconds: 60, runtime: process.execPath, script })
      expect(lines).toEqual(['[guard] integrity baseline r-1: 3 frozen entries, 4 presence entries, 5 ms'])
    } finally { clearInterval(t) }
    expect(ticks).toBeGreaterThanOrEqual(4)
    expect(argvOf('ok')).toEqual(['pre', 'r-1', '--cwd', 'C:/m', '--by', 'daemon', '--holder-pid', '42', '--max-seconds', '60'])
  })

  it('a refusal (exit 3) rejects with the guard\'s own reason', async () => {
    const script = standIn('refused', { code: 3, err: '[guard] REFUSED: integrity: the integrity latch is present at C:/g/HALT.json — nothing was dispatched' })
    await expect(baselineInChild({ runId: 'r-2', cwd: 'C:/m', by: 'daemon', holderPid: 42, maxSeconds: 60, runtime: process.execPath, script }))
      .rejects.toThrow(/^the integrity latch is present at C:\/g\/HALT\.json$/)
  })

  it('any other failure rejects with its exit code and last line; a child that cannot start rejects', async () => {
    const script = standIn('broken', { code: 1, err: 'TypeError: something broke' })
    await expect(baselineInChild({ runId: 'r-3', cwd: 'C:/m', by: 'daemon', holderPid: 42, maxSeconds: 60, runtime: process.execPath, script }))
      .rejects.toThrow('the baseline process exited 1 (TypeError: something broke)')
    await expect(baselineInChild({ runId: 'r-4', cwd: 'C:/m', by: 'daemon', holderPid: 42, maxSeconds: 60, runtime: join(dir, 'no-such-runtime.exe'), script }))
      .rejects.toThrow(/^the baseline process could not be started \(ENOENT/)
  })

  it('a child that does not end within its time is ended and rejects', async () => {
    const script = standIn('hung', { ms: 60_000 })
    const t0 = Date.now()
    await expect(baselineInChild({ runId: 'r-5', cwd: 'C:/m', by: 'daemon', holderPid: 42, maxSeconds: 60, runtime: process.execPath, script, timeoutMs: 500 }))
      .rejects.toThrow('the baseline process did not end within 500 ms; it was ended')
    expect(Date.now() - t0).toBeLessThan(15_000)
  })

  it('TaskRunner awaits an integrity before that is a promise, and a rejection refuses the run', async () => {
    const work = mkdtempSync(join(dir, 'tr-'))
    const runner = new TaskRunner({
      workDir: work, spawnCmd: [process.execPath, join(dir, 'never-run.mjs')], isGpuBusyImpl: async () => false,
      integrity: {
        before: async () => { await new Promise(r => setTimeout(r, 50)); throw new Error('the baseline process exited 1 (x)') },
        after: async () => null,
      },
    })
    const out = await runner.run({ missionId: 'm1', triggerId: 't1', prompt: 'p', context: 'c', allowedTools: ['Read'], timeoutMs: 3000, outcomePath: join(work, 'o.json') })
    expect(out.ok).toBe(false)
    expect(out.error).toBe('REFUSED: integrity: no integrity baseline could be taken (the baseline process exited 1 (x))')
  })
})

// Wave 15b: what the check of wave 15 left in the daemon's part (P1-C3, C6, C7).
describe('wave 15b: the daemon\'s baseline in a process of its own', () => {
  const input = (work: string) => ({ missionId: 'm1', triggerId: 't1', prompt: 'p', context: 'c', allowedTools: ['Read'], timeoutMs: 3000, outcomePath: join(work, 'o.json') })

  it('(C7) a guard reason that already says no baseline could be taken is handed on once, not wrapped twice', async () => {
    const script = standIn('wrapped', { code: 2, err: '[guard] REFUSED: integrity: no integrity baseline could be taken (the baseline C:/g/manifests/r.before.json could not be written (EACCES)) — nothing was dispatched' })
    await expect(baselineInChild({ runId: 'r-6', cwd: 'C:/m', by: 'daemon', holderPid: 42, maxSeconds: 60, runtime: process.execPath, script }))
      .rejects.toThrow(/^the baseline C:\/g\/manifests\/r\.before\.json could not be written \(EACCES\)$/)
    // And TaskRunner leaves a reason that already starts with the phrase as it is.
    const work = mkdtempSync(join(dir, 'tr-'))
    const runner = new TaskRunner({
      workDir: work, spawnCmd: [process.execPath, join(dir, 'never-run.mjs')], isGpuBusyImpl: async () => false,
      integrity: { before: async () => { throw new Error('no integrity baseline could be taken (EACCES)') }, after: async () => null },
    })
    const out = await runner.run(input(work))
    expect(out.error).toBe('REFUSED: integrity: no integrity baseline could be taken (EACCES)')
  })

  it('(C3) a baseline the refused child left behind is settled at once, so it never becomes an orphan that latches', async () => {
    const work = mkdtempSync(join(dir, 'tr-'))
    const left = new Set<string>()
    const settled: Array<{ runId: string; notConfirmedDead: string | undefined }> = []
    let spawned = false
    const runner = new TaskRunner({
      workDir: work, spawnCmd: [process.execPath, join(dir, 'never-run.mjs')], isGpuBusyImpl: async () => false,
      contain: () => { spawned = true; return { ok: false, reason: 'not reached' } },
      integrity: {
        // The child wrote its baseline and then failed (exit 1, or it hung past its time and was ended).
        before: async (runId) => { left.add(runId); throw new Error('the baseline process did not end within 120000 ms; it was ended') },
        after: async (runId, notConfirmedDead) => { settled.push({ runId, notConfirmedDead }); left.delete(runId); return null },
        opened: (runId) => left.has(runId),
      },
    })
    const out = await runner.run(input(work))
    expect(out.ok).toBe(false)
    expect(out.error).toBe('REFUSED: integrity: no integrity baseline could be taken (the baseline process did not end within 120000 ms; it was ended)')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.runId).toMatch(/^daemon-m1-t1-\d{8}T\d{6}-[0-9a-f]{4}$/)
    expect(settled[0]!.notConfirmedDead).toBeUndefined()
    expect(left.size).toBe(0)
    expect(spawned).toBe(false)
    // No baseline left: nothing is settled.
    const none: string[] = []
    const r2 = new TaskRunner({
      workDir: work, spawnCmd: [process.execPath, join(dir, 'never-run.mjs')], isGpuBusyImpl: async () => false,
      integrity: { before: async () => { throw new Error('x') }, after: async (id) => { none.push(id); return null }, opened: () => false },
    })
    await r2.run(input(work))
    expect(none).toEqual([])
  })

  it('(C3) with the real guard folder: the baseline a failed child wrote is closed clean, no orphan is left and no latch is written', async () => {
    const base = mkdtempSync(join(dir, 'real-'))
    const home = join(base, 'home'), guard = join(base, 'guard'), mission = join(base, 'mission'), state = join(home, '.cynco')
    for (const d of [home, guard, mission, join(state, 'profiles'), join(home, '.config')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, '.config', 'a'), 'a')
    const roots = I.protectedRoots({ home, cynco: state, models: join(base, 'models'), volumes: [] })
    const work = mkdtempSync(join(dir, 'tr-'))
    const runner = new TaskRunner({
      workDir: work, spawnCmd: [process.execPath, join(dir, 'never-run.mjs')], isGpuBusyImpl: async () => false,
      integrity: {
        // What `cynco-guard.mjs pre` does before it fails: the baseline is on disk, then the process exits 1.
        before: async (runId) => {
          I.takeBaseline({ runId, cwd: mission, by: 'daemon', guard, home, roots, checkModels: false, holderPid: process.pid })
          throw new Error('the baseline process exited 1 (after the write)')
        },
        after: async (runId, notConfirmedDead) => {
          const c = await I.settleRun(runId, { by: 'daemon', guard, page: async () => true, sleep: () => {}, ...(notConfirmedDead !== undefined ? { notConfirmedDead } : {}) })
          return c.changed ? c.publicSummary : null
        },
        opened: (runId) => I.openBaselines(guard).some(b => b.runId === runId),
      },
    })
    const out = await runner.run(input(work))
    expect(out.error).toBe('REFUSED: integrity: no integrity baseline could be taken (the baseline process exited 1 (after the write))')
    expect(I.openBaselines(guard)).toEqual([])
    expect(I.orphanedBaselines(guard, { now: Date.now() + 7 * 24 * 3600_000 })).toEqual([])
    expect(existsSync(join(guard, I.LATCH_FILE))).toBe(false)
  })

  it('(C3) a change the settle of a refused run finds is named in the refusal', async () => {
    const work = mkdtempSync(join(dir, 'tr-'))
    const runner = new TaskRunner({
      workDir: work, spawnCmd: [process.execPath, join(dir, 'never-run.mjs')], isGpuBusyImpl: async () => false,
      integrity: {
        before: async () => { throw new Error('the baseline process exited 1 (x)') },
        after: async () => '1 change(s) in protected folders (first: PRESENCE)',
        opened: () => true,
      },
    })
    const out = await runner.run(input(work))
    expect(out.error).toBe('REFUSED: integrity: no integrity baseline could be taken (the baseline process exited 1 (x)); the baseline it left was settled: 1 change(s) in protected folders (first: PRESENCE)')
  })

  // Wave 19b (B4: Bun never fetches a package by itself): the daemon runs under Bun, so the guard's `pre` is
  // started by Bun and is told --no-install before its script; a test's Node runtime is told nothing (Node
  // refuses the flag). Pure and host-independent: the name is read after either separator, so it holds on Linux.
  it('wave 19b: a Bun runtime is told --no-install before the guard script; another runtime nothing', () => {
    for (const bun of ['C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe', 'C:/b/BUN.EXE', '/usr/local/bin/bun', 'bun', 'bun.exe']) {
      expect(bunNoInstall(bun), bun).toEqual(['--no-install'])
    }
    for (const other of ['C:\\Program Files\\nodejs\\node.exe', '/usr/bin/node', 'C:\\bun\\node.exe', '/opt/bun/node', 'bunx', 'C:/x/bun.cmd', '']) {
      expect(bunNoInstall(other), other).toEqual([])
    }
  })

  it('wave 19b: both Bun starts of the task runner carry --no-install (text pin)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon', 'taskRunner.ts'), 'utf-8').replace(/\r\n/g, '\n')
    expect(src).toContain("const cmd = this.opts.spawnCmd ?? ['bun', '--no-install', join(repoRoot, 'engine', 'main.ts')]")
    expect(src).toContain('child = spawn(runtime, [...bunNoInstall(runtime), script, ...guardPreArgv(o)], {')
    expect(src).not.toMatch(/\['bun', join\(/)
  })

  it('(C6) the daemon wires the child baseline, the settle of what a refused child left, and the once-a-day pager', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon', 'main.ts'), 'utf-8').replace(/\r\n/g, '\n')
    expect(src).toContain('await baselineInChild({')
    expect(src).not.toContain('takeBaseline(')
    expect(src).toContain('opened: (runId) => openBaselines().some(b => b.runId === runId)')
    expect(src).toContain('const publishRun = onceADayRefusals({')
    expect(src).toContain('publish: publishRun,')
    expect(src).not.toMatch(/publish: \(p\) => ntfy\.publish\(p\),\n\s*publishRecommendation/)
    expect(src).toMatch(/runHousekeeping\(\{[\s\S]*?lastPaged, save: savePaged/)
  })
})
