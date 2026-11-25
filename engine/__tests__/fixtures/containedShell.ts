/**
 * Run under Bun on Windows by `engine/__tests__/containmentLauncher.test.ts` (F242, entry 1.B1,
 * F201, F210). The Windows layer of the containment: the real low-integrity launcher, real
 * `icacls` labels, the real probe. vitest's Node cannot do any of it (no bun:ffi).
 *
 * argv: <dir>. The fixture works only inside that folder, which the test made with mkdtemp:
 *   <dir>/root      its sandbox root (the run folder <dir>/root/<run id> is made by establish)
 *   <dir>/home      a fake home folder (never labelled; the run must not write it)
 *   <dir>/mission   its mission folder (`git init`), labelled low for the run
 *   <dir>/extra     an extra root, labelled low for the run
 *   <dir>/outside   an ordinary medium-integrity folder
 *   <dir>/mission2  a second mission folder, for a run that blocks its own release
 *   <dir>/cfg       a folder with a planted bunfig.toml and .env, used as the launcher's working folder
 *   <dir>/state, <dir>/models, <dir>/guard   the folders the context names
 * It labels only those folders, writes nothing anywhere else, removes the junctions it made and
 * undoes the one permission change a case makes before it exits. The test removes <dir>.
 *
 * It installs the engine's kill-on-close job as `main.ts` does, acknowledges whatever volumes
 * `listUnprotectedVolumes()` reports by setting the acknowledgement variable in its OWN
 * environment (it writes nothing to such a volume), calls the real
 * `establishContainment({ test: true, ... })`, sets the context, runs every case and prints one
 * JSON line: `{ ok, establish, cases: { <name>: {...} } }`. A case that throws is reported with
 * its error; the test decides what passes.
 */
import { execFileSync, execSync, spawn, spawnSync, type ChildProcess, type ExecException } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  containedCommand, containmentHint, ContainmentRefusal, establishContainment, gitNamespaceHolder, installedGitRoot, listUnprotectedVolumes,
  releaseContainment, setRunContainment, toolExec, toolExecSync, type RunContainment,
} from '../../containment.js'
import { ownProcessTree } from '../../processTree.js'
import { installKillOnCloseJob } from '../../security/jobObject.js'

const dir = process.argv[2]
if (!dir || !existsSync(dir)) {
  console.log(JSON.stringify({ ok: false, error: `the fixture needs an existing folder, got ${dir}` }))
  process.exit(2)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const PS = 'powershell.exe'
const WHOAMI = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'whoami.exe')
const ICACLS = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'icacls.exe')

type Ran = { err: { code?: unknown; killed?: boolean; signal?: unknown; message: string; name: string; isRefusal: boolean } | null; stdout: string; stderr: string; ms: number }

/** One command through `toolExec`, as the Bash tool runs it, with or without a context. */
function run(command: string, o: { cwd: string; shell?: string; maxBuffer?: number; ctx: RunContainment | null; onChild?: (c: ChildProcess) => void }): Promise<Ran> {
  const t0 = Date.now()
  return new Promise(resolve => {
    try {
      // The options the Bash tool passes (engine/tools/impl/bash.ts): no windowsHide, which changes
      // the console code page a direct PowerShell child writes its output in.
      const child = toolExec(command, { cwd: o.cwd, shell: o.shell, encoding: 'utf-8', maxBuffer: o.maxBuffer ?? 2 * 1024 * 1024 },
        (err: ExecException | null, stdout: string, stderr: string) => {
          resolve({
            err: err ? { code: (err as { code?: unknown }).code, killed: err.killed, signal: err.signal, message: err.message, name: err.name, isRefusal: err instanceof ContainmentRefusal } : null,
            stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ms: Date.now() - t0,
          })
        }, o.ctx)
      o.onChild?.(child)
    } catch (e) {
      const err = e as Error & { code?: unknown }
      resolve({ err: { code: err.code, message: err.message, name: err.name, isRefusal: e instanceof ContainmentRefusal }, stdout: '', stderr: '', ms: Date.now() - t0 })
    }
  })
}

/** The integrity label lines icacls prints for one path (empty: no explicit label, i.e. medium). */
function labelsOf(path: string): string[] {
  const r = spawnSync(ICACLS, [path], { encoding: 'utf-8', windowsHide: true })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).filter(l => /Mandatory Label/i.test(l)).map(l => l.trim())
}
const isLow = (lines: string[]) => lines.some(l => /Low Mandatory Level/i.test(l))

/** Every path under `root`, links reported and never entered. */
function walk(root: string, out: string[] = []): string[] {
  for (const n of readdirSync(root)) {
    const p = join(root, n)
    out.push(p)
    const st = statSyncNoFollow(p)
    if (st === 'dir') walk(p, out)
  }
  return out
}
function statSyncNoFollow(p: string): 'dir' | 'link' | 'file' | 'gone' {
  try {
    const st = lstatSync(p)
    return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'file'
  }
}

/** C:\tmp when it exists as a folder (a temp root outside the home folder), else null. Never created here. */
function outsideHomeTemp(): string | null {
  try {
    return statSync('C:/tmp').isDirectory() ? 'C:/tmp' : null
  } catch (e) {
    void e
    return null
  }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : -1 }

// ─── The folders ─────────────────────────────────────────────────────────────────────────────────

const root = join(dir, 'root'), home = join(dir, 'home'), mission = join(dir, 'mission'), extra = join(dir, 'extra')
const outside = join(dir, 'outside'), mission2 = join(dir, 'mission2'), cfg = join(dir, 'cfg')
const folders = { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null }
for (const d of [root, home, mission, extra, outside, mission2, cfg, folders.state, folders.models, folders.guard]) mkdirSync(d, { recursive: true })
for (const m of [mission, mission2]) execFileSync('git', ['init', '-q'], { cwd: m, windowsHide: true })
writeFileSync(join(mission, 'README.txt'), 'fixture\n')
// A file of the owner's that happens to carry the probe's sandbox file name: never removed from a work folder.
for (const d of [mission, extra]) writeFileSync(join(d, 'probe-1.tmp'), 'kept\n')

// Entry 1.B1: what a run could plant for a medium-integrity bun to read. Each witness write is
// tried on its own, so ANY execution of the preload, at any level, leaves a trace somewhere.
const planted = (tag: string) => [
  `import { writeFileSync } from 'node:fs'`,
  ...[outside, mission, dir].map(d => `try { writeFileSync(${JSON.stringify(join(d, `witness-${tag}.txt`))}, 'ran') } catch (e) { void e }`),
].join('\n') + '\n'
writeFileSync(join(mission, 'plant.ts'), planted('mission-bunfig'))
writeFileSync(join(mission, 'bunfig.toml'), `preload = ["./plant.ts"]\n`)
writeFileSync(join(mission, '.env'), 'PLANTED_VALUE=1\n')
writeFileSync(join(outside, 'plant-home.ts'), planted('home-bunfig'))
// The same planted in a folder used as the launcher's own working folder: the launcher normally
// starts in the checkout, so the case above would pass even without --no-env-file and --config=.
writeFileSync(join(cfg, 'plant.ts'), [
  `import { writeFileSync } from 'node:fs'`,
  `try { writeFileSync(${JSON.stringify(join(cfg, 'witness-cfg.txt'))}, 'ran') } catch (e) { void e }`,
].join('\n') + '\n')
writeFileSync(join(cfg, 'bunfig.toml'), `preload = ["./plant.ts"]\n`)
writeFileSync(join(cfg, '.env'), 'PLANTED_VALUE=cfg\n')

// The label leak case: a junction three levels down. Rule M walks the whole folder since 2026-11-24
// (NOW.md:84) and refuses a mission folder holding a link that leads out, so the junction is made
// right after the establish, and the mission folder's label is then set again as the establish set
// it: what is measured is whether that label reaches through the junction (labelLeakAfterEstablish).
mkdirSync(join(mission, 'a', 'b'), { recursive: true })
const linkedOut = join(mission, 'a', 'b', 'linked-out')
writeFileSync(join(outside, 'before.txt'), 'medium\n')

const cases: Record<string, unknown> = {}
const report = (extraFields: Record<string, unknown>) => {
  console.log(JSON.stringify({ ...extraFields, cases }))
}

const engineJob = await installKillOnCloseJob()
delete process.env.LOCALCODE_CONTAINMENT_OFF
let volumes: string[] = []
try {
  volumes = listUnprotectedVolumes().map(v => v.root)
} catch (e) {
  report({ ok: false, error: `volume listing failed: ${(e as Error).message}` })
  process.exit(0)
}
if (volumes.length) process.env.LOCALCODE_UNPROTECTED_VOLUMES_OK = volumes.join(';')
else delete process.env.LOCALCODE_UNPROTECTED_VOLUMES_OK

const est = establishContainment({
  test: true, kind: 'mission', label: 'launcher-fixture', missionCwd: mission, extraRoots: [extra],
  sandboxRoot: root, home, folders,
})
if (!est.ok) {
  report({ ok: false, error: `establish refused: ${est.reason}`, engineJob: engineJob.installed })
  process.exit(0)
}
const ctx = est.containment
setRunContainment(ctx)
const runDir = ctx.sandbox.root
execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', linkedOut, outside], { windowsHide: true, stdio: 'ignore' })
const relabel = spawnSync(ICACLS, [mission, '/setintegritylevel', '(OI)(CI)L'], { encoding: 'utf-8', windowsHide: true })
if (relabel.status !== 0) {
  report({ ok: false, error: `the mission folder could not be labelled again over the junction: ${`${relabel.stdout ?? ''}${relabel.stderr ?? ''}`.trim()}`, engineJob: engineJob.installed })
  rmdirSync(linkedOut)
  process.exit(0)
}

async function step(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    cases[name] = await fn()
  } catch (e) {
    cases[name] = { threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

await step('level', async () => {
  const cmd = `& '${WHOAMI}' /groups /fo csv /nh`
  const low = await run(cmd, { cwd: mission, shell: PS, ctx })
  const medium = await run(cmd, { cwd: mission, shell: PS, ctx: null })
  return {
    contained: (/S-1-16-\d+/.exec(low.stdout) ?? ['none'])[0], containedErr: low.err?.message ?? null,
    plain: (/S-1-16-\d+/.exec(medium.stdout) ?? ['none'])[0],
    isolation: ctx.isolation, establishMs: est.ms,
  }
})

await step('relay', async () => {
  const codes: Record<string, unknown> = {}
  for (const n of [0, 7, 300]) {
    const r = await run(`Write-Output to-stdout; [Console]::Error.WriteLine('to-stderr'); exit ${n}`, { cwd: mission, shell: PS, ctx })
    // The same command with no context: under Bun on Windows an exit status is cut to its low
    // 8 bits on both paths (300 arrives as 44), so the relay is judged against the direct path.
    const p = await run(`exit ${n}`, { cwd: mission, shell: PS, ctx: null })
    codes[n] = { code: r.err ? r.err.code : 0, plainCode: p.err ? p.err.code : 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }
  }
  const quoting: Array<{ shell: string; same: boolean; contained: string; plain: string }> = []
  for (const [shell, cmd] of [
    [PS, `Write-Output "dq \`"in\`" 'sq' a\\b\\\`" %OS% ^&|<>"`],
    ['', `echo "dq" 'sq' a\\"b %OS% ^^ ^& ^| ^< ^>`],
  ] as const) {
    const c = await run(cmd, { cwd: mission, shell: shell || undefined, ctx })
    const p = await run(cmd, { cwd: mission, shell: shell || undefined, ctx: null })
    quoting.push({ shell: shell || 'cmd (shell: true)', same: c.stdout === p.stdout && c.stderr === p.stderr && String(c.err?.code) === String(p.err?.code), contained: c.stdout, plain: p.stdout })
  }
  return { codes, quoting }
})

await step('text', async () => {
  const hereString = `$s = @'\r\nline one\r\nline "two" with 'quotes'\r\n'@\r\nWrite-Output $s\r\nWrite-Output 'after'`
  const nonAscii = `Write-Output 'Gr\u00fc\u00dfe, na\u00efve caf\u00e9 \u2014 \u65e5\u672c'`
  const out: Record<string, unknown> = {}
  for (const [name, cmd] of [['hereString', hereString], ['nonAscii', nonAscii]] as const) {
    const c = await run(cmd, { cwd: mission, shell: PS, ctx })
    const p = await run(cmd, { cwd: mission, shell: PS, ctx: null })
    out[name] = { same: c.stdout === p.stdout && !c.err && !p.err, contained: c.stdout, plain: p.stdout, err: c.err?.message ?? null }
  }
  return out
})

await step('longCommand', async () => {
  const payload = 'x'.repeat(20_000)
  const cmd = `Write-Output '${payload}'`
  const spawn = containedCommand({ file: cmd, args: [], shell: PS }, { ctx, cwd: mission })
  const viaFile = spawn.args.includes('--command-file')
  if (spawn.commandFile) {
    // containedCommand wrote it; this inspection call does not run it, so remove it here.
    unlinkSync(spawn.commandFile)
  }
  const r = await run(cmd, { cwd: mission, shell: PS, ctx })
  // Wave 19b (from package C): a command handed by file that is longer than a command line can hold
  // (32,767 characters on Windows) is the launcher's own named refusal, never a crash.
  const long = `Write-Output '${'y'.repeat(40_000)}'`
  const head = containedCommand({ file: long, args: [], shell: PS }, { ctx, cwd: mission })
  const tl = spawnSync(head.file, head.args, { cwd: head.cwd, env: head.env, encoding: 'utf-8', windowsHide: true, timeout: 60_000 })
  if (head.commandFile) unlinkSync(head.commandFile)
  const tooLong = { viaFile: head.args.includes('--command-file'), status: tl.status, stdout: tl.stdout, stderr: tl.stderr, seal: head.seal ?? null }
  const left = readdirSync(runDir).filter(n => /^cmd-.*\.txt$/.test(n))
  return { length: cmd.length, viaFile, printed: r.stdout.trim().length, err: r.err?.message ?? null, commandFilesLeft: left, tooLong }
})

await step('noShellForm', async () => {
  const r = await run('echo %USERPROFILE%', { cwd: mission, ctx })
  return { printed: r.stdout.trim(), home: ctx.sandbox.home, err: r.err?.message ?? null }
})

await step('didNotRun', async () => {
  // --exec of a program that does not exist, and an unknown mode, straight at the launcher.
  const head = containedCommand({ file: 'no-such-program-xyz', args: [] }, { ctx, cwd: mission })
  const missing = spawnSync(head.file, head.args, { cwd: head.cwd, env: head.env, encoding: 'utf-8', windowsHide: true })
  const modeArgs = [...head.args.slice(0, head.args.indexOf('--exec')), '--bogus-mode']
  const unknown = spawnSync(head.file, modeArgs, { cwd: head.cwd, env: head.env, encoding: 'utf-8', windowsHide: true })
  // The record gone: the launcher cannot read it, and toolExec answers a ContainmentRefusal.
  const rec = join(runDir, 'containment.json'), aside = join(runDir, 'containment.json.aside')
  renameSync(rec, aside)
  let noRecord: Ran
  try {
    noRecord = await run('Write-Output should-not-run', { cwd: mission, shell: PS, ctx })
  } finally {
    renameSync(aside, rec)
  }
  return {
    seal: head.seal ?? null,
    missing: { status: missing.status, stderr: String(missing.stderr).trim() },
    unknownMode: { status: unknown.status, stderr: String(unknown.stderr).trim() },
    noRecord: { code: noRecord.err?.code ?? null, isRefusal: noRecord.err?.isRefusal ?? false, message: noRecord.err?.message ?? null, stdout: noRecord.stdout },
  }
})

await step('plantedConfig', async () => {
  writeFileSync(join(ctx.sandbox.home, '.bunfig.toml'), `preload = [${JSON.stringify(join(outside, 'plant-home.ts').replace(/\\/g, '/'))}]\n`)
  const r = await run(`Write-Output "PLANTED=[$env:PLANTED_VALUE]"`, { cwd: mission, shell: PS, ctx })
  const witnesses = walk(dir).filter(p => /witness-/.test(p))
  return { printed: r.stdout.trim(), err: r.err?.message ?? null, witnesses }
})

// BB-5 (check B, wave 19b): a child the real launcher starts carries BUN_OPTIONS with --no-install after the
// starter's own value (toolEnv in the starter and again in the launcher); an uncontained child, the starter's alone.
await step('bunOptions', async () => {
  const before = process.env.BUN_OPTIONS
  process.env.BUN_OPTIONS = '--smol'
  try {
    const c = await run('Write-Output $env:BUN_OPTIONS', { cwd: mission, shell: PS, ctx })
    const p = await run('Write-Output $env:BUN_OPTIONS', { cwd: mission, shell: PS, ctx: null })
    return { contained: c.stdout.trim(), plain: p.stdout.trim(), err: c.err?.message ?? null }
  } finally {
    if (before === undefined) delete process.env.BUN_OPTIONS
    else process.env.BUN_OPTIONS = before
  }
})

await step('plantedConfigInLauncherCwd', async () => {
  // The launcher's exact start form, started in a folder holding a bunfig.toml preload and a .env;
  // then the same with each flag dropped, which shows the case can see what the flags prevent.
  const c = containedCommand({ file: 'Write-Output "PLANTED=[$env:PLANTED_VALUE]"', args: [], shell: PS }, { ctx, cwd: mission })
  const witness = join(cfg, 'witness-cfg.txt')
  const go = (args: string[]) => {
    if (existsSync(witness)) unlinkSync(witness)
    const r = spawnSync(c.file, args, { cwd: cfg, env: c.env, encoding: 'utf-8', windowsHide: true })
    return { printed: String(r.stdout ?? '').trim(), status: r.status, witness: existsSync(witness), stderr: String(r.stderr ?? '').trim().slice(0, 300) }
  }
  const exact = go(c.args)
  const noEnvFlag = go(c.args.filter(a => a !== '--no-env-file'))
  const noConfigFlag = go(c.args.filter(a => !a.startsWith('--config=')))
  if (existsSync(witness)) unlinkSync(witness)
  return { exact, noEnvFlag, noConfigFlag }
})

await step('probeLeftovers', async () => {
  return { mission: existsSync(join(mission, 'probe-1.tmp')), extra: existsSync(join(extra, 'probe-1.tmp')) }
})

await step('deniedAndAllowed', async () => {
  const targets: Record<string, string> = {
    outside: join(outside, 'd-outside.txt'), runFolder: join(runDir, 'd-run.txt'), fakeHome: join(home, 'd-home.txt'),
    scratch: join(ctx.sandbox.scratch, 'a-scratch.txt'), temp: join(ctx.sandbox.tmp, 'a-temp.txt'),
    mission: join(mission, 'a-mission.txt'), extra: join(extra, 'a-extra.txt'),
  }
  const lines = Object.entries(targets).map(([k, p]) =>
    `try { [IO.File]::WriteAllText('${p}', 'x'); Write-Output '${k}=created' } catch { Write-Output '${k}=denied' }`)
  const r = await run([...lines, `Write-Output "HOME=$HOME"`, `Write-Output "SCRATCH=$env:CYNCO_SCRATCH"`, `Write-Output "TEMP=$env:TEMP"`].join('; '), { cwd: mission, shell: PS, ctx })
  const said: Record<string, string> = {}
  for (const l of r.stdout.split(/\r?\n/)) { const m = /^(\w+)=(.*)$/.exec(l.trim()); if (m) said[m[1]] = m[2] }
  const exists: Record<string, boolean> = {}
  for (const [k, p] of Object.entries(targets)) exists[k] = existsSync(p)
  return { said, exists, sandbox: ctx.sandbox, err: r.err?.message ?? null }
})

await step('junctionOut', async () => {
  const link = join(mission, 'jout')
  const r = await run(`mklink /J "${link}" "${outside}"`, { cwd: mission, ctx })
  const made = statSyncNoFollow(link)
  if (made === 'link') rmdirSync(link)
  return { made, code: r.err?.code ?? 0, output: `${r.stdout}${r.stderr}`.trim() }
})

await step('syncSites', async () => {
  const spaced = join(dir, 'path with space')
  const cmd = `git apply --check "${join(spaced, 'x.patch')}" 2>&1`
  const grab = (f: () => unknown) => {
    try {
      return { threw: false, out: String(f()) }
    } catch (e) {
      const err = e as { status?: number | null; stdout?: unknown; name?: string; code?: unknown }
      return { threw: true, status: err.status ?? null, stdout: String(err.stdout ?? ''), name: err.name, code: err.code ?? null }
    }
  }
  const contained = grab(() => toolExecSync(cmd, { cwd: mission, encoding: 'utf-8' }, ctx))
  const plain = grab(() => execSync(cmd, { cwd: mission, encoding: 'utf-8' }))
  const input = grab(() => toolExecSync('findstr "^"', { cwd: mission, encoding: 'utf-8', input: 'line from stdin\n' }, ctx))
  return { contained, plain, input }
})

await step('gitToolShape', async () => {
  const c = containedCommand({ file: 'git', args: ['--version'] }, { ctx, cwd: mission })
  const Bun = (globalThis as unknown as { Bun: { spawn(cmd: string[], o: object): { exited: Promise<number>; stdout: ReadableStream } } }).Bun
  const p = Bun.spawn([c.file, ...c.args], { cwd: c.cwd, env: c.env, stdout: 'pipe', stderr: 'pipe' })
  const code = await p.exited
  const out = await new Response(p.stdout).text()
  return { viaLauncher: c.viaLauncher, code, stdout: out.trim() }
})

await step('burst', async () => {
  // fixtures/ownedTreeBurst.ts through the launcher: the job is taken on the LAUNCHER's pid.
  const burstDir = join(ctx.sandbox.scratch, 'burst')
  mkdirSync(burstDir)
  writeFileSync(join(burstDir, 'late.cmd'), '@echo off\r\necho x> started-%1\r\nping -n 4 127.0.0.1 >nul\r\necho x> marker-%1\r\n')
  const CHILDREN = 60, KILL_AFTER = 8
  let child: ChildProcess | null = null
  const done = run(`1..${CHILDREN} | ForEach-Object { Start-Process -WindowStyle Hidden cmd.exe -ArgumentList '/c', '.\\late.cmd', $_ }`,
    { cwd: burstDir, shell: PS, ctx, onChild: c => { child = c } })
  // The started process, not its pid (wave 24, F255): the kill below comes after a wait in which the root can end, and
  // a tree without a Job Object is then not looked for from a number that may be another process's.
  const tree = ownProcessTree((child as ChildProcess | null) ?? undefined)
  const count = (prefix: string) => readdirSync(burstDir).filter(f => f.startsWith(prefix)).length
  const giveUp = Date.now() + 30_000
  while (count('started-') < KILL_AFTER && Date.now() < giveUp) await sleep(15)
  const startedAtKill = count('started-')
  const t0 = Date.now()
  await tree.kill()
  const killMs = Date.now() - t0
  await done
  await sleep(6000)
  return { kind: tree.kind, engineJob: engineJob.installed, children: CHILDREN, startedAtKill, started: count('started-'), survivors: count('marker-'), killMs }
})

await step('maxBuffer', async () => {
  // A child that has written 3 MiB, then ignores the broken pipe and writes a marker 5 s later.
  const started = join(ctx.sandbox.scratch, 'maxbuf-started.txt'), marker = join(ctx.sandbox.scratch, 'maxbuf-marker.txt')
  const cmd = `Set-Content -LiteralPath '${started}' x; $s = 'x' * 1048576; try { 1..3 | ForEach-Object { [Console]::Out.Write($s) } } catch { }; Start-Sleep -Seconds 5; Set-Content -LiteralPath '${marker}' x`
  let child: ChildProcess | null = null
  const r = await run(cmd, { cwd: mission, shell: PS, ctx, maxBuffer: 2 * 1024 * 1024, onChild: c => { child = c } })
  // As the Bash tool does: the callback releases the tree, it does not kill it.
  ownProcessTree((child as ChildProcess | null)?.pid).release()
  await sleep(7000)
  return { code: r.err?.code ?? null, started: existsSync(started), marker: existsSync(marker) }
})

let gitBash: { kill(): void } | null = null
await step('msysHint', async () => {
  const gitExe = spawnSync('where', ['git'], { encoding: 'utf-8', windowsHide: true }).stdout.split(/\r?\n/).map(l => l.trim()).find(l => /\\cmd\\git\.exe$/i.test(l))
  const bashExe = gitExe ? join(gitExe, '..', '..', 'usr', 'bin', 'bash.exe') : null
  if (!bashExe || !existsSync(bashExe)) return { notRun: 'no Git Bash' }
  const Bun = (globalThis as unknown as { Bun: { spawn(cmd: string[], o: object): { kill(): void } } }).Bun
  gitBash = Bun.spawn([bashExe, '-c', 'sleep 60'], { stdout: 'ignore', stderr: 'ignore' })
  await sleep(1500)
  const failing = await run(`& '${bashExe}' -c 'echo x'`, { cwd: mission, shell: PS, ctx })
  const failText = `${failing.stderr}${failing.stdout}`
  const passing = await run(`& '${bashExe}' -c 'echo x'; Write-Output done; exit 0`, { cwd: mission, shell: PS, ctx })
  return {
    failureCode: failing.err?.code ?? 0, failureHint: containmentHint('failure', failText, ctx),
    successCode: passing.err?.code ?? 0, successHint: containmentHint('success', passing.stderr, ctx),
    msysLine: /NtCreateDirectoryObject/.test(failText),
  }
})
gitBash?.kill()

// Through the tools: the Bash tool itself, as the loop calls it, under the context set above.
await step('throughTheTool', async () => {
  const { bashTool } = await import('../../tools/impl/bash.js')
  const r = await bashTool.execute({ command: `Write-Output "home=$env:USERPROFILE"; & '${WHOAMI}' /groups /fo csv /nh` }, mission)
  return {
    isError: r.isError, home: (/home=(\S*)/.exec(r.output) ?? [null, null])[1],
    level: (/S-1-16-\d+/.exec(r.output) ?? ['none'])[0], sandboxHome: ctx.sandbox.home, output: r.output.slice(0, 400),
  }
})

// S3 (F242): the scratch folder the first message names is the one the shell is given, and it exists.
await step('scratchThroughTheTool', async () => {
  const { bashTool } = await import('../../tools/impl/bash.js')
  const r = await bashTool.execute({ command: '$env:CYNCO_SCRATCH; Test-Path -LiteralPath $env:CYNCO_SCRATCH' }, mission)
  const lines = r.output.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return { isError: r.isError, first: lines[0] ?? '', second: lines[1] ?? '', scratch: ctx.sandbox.scratch, output: r.output.slice(0, 400) }
})

// S2a: the engine's other spawn sites through the real launcher, as the loop calls them.
const levelOf = (text: string) => (/S-1-16-\d+/.exec(text) ?? ['none'])[0]
await step('throughTheSites', async () => {
  const { runCommandDetailed } = await import('../../tools/contractVerify.js')
  const { gitTool } = await import('../../tools/impl/git.js')
  const { applyPatchTool } = await import('../../tools/impl/applyPatch.js')
  const { runTests } = await import('../../bestOfN/sampler.js')
  const contract = await runCommandDetailed(mission, `Write-Output "home=$env:USERPROFILE"; & '${WHOAMI}' /groups /fo csv /nh`, 120_000)
  const git = await gitTool.execute({ subcommand: 'rev-parse', args: '--is-inside-work-tree' }, mission)
  const patch = [
    'diff --git a/added-by-patch.txt b/added-by-patch.txt', 'new file mode 100644', '--- /dev/null',
    '+++ b/added-by-patch.txt', '@@ -0,0 +1 @@', '+added', '',
  ].join('\n')
  const applied = await applyPatchTool.execute({ patch }, mission)
  const tests = await runTests(mission, { framework: 'pytest', command: `"${WHOAMI}" /groups /fo csv /nh` } as never)
  return {
    contract: { outcome: contract.outcome, home: (/home=(\S*)/.exec(contract.tail) ?? [null, null])[1], level: levelOf(contract.tail), tail: contract.tail.slice(0, 400) },
    git: { isError: git.isError, output: git.output.trim().slice(0, 400) },
    applyPatch: { isError: applied.isError, output: applied.output.slice(0, 400), created: existsSync(join(mission, 'added-by-patch.txt')) },
    runTests: { refused: tests.refused ?? null, level: levelOf(tests.output) },
    sandboxHome: ctx.sandbox.home,
  }
})

// S2a: the launcher exits 197 (here because the run's record is gone): a contract check is
// "unrunnable", never "failed", and the Git tool answers the refusal; nothing ran.
await step('sitesLauncherRefused', async () => {
  const { runCommandDetailed } = await import('../../tools/contractVerify.js')
  const { gitTool } = await import('../../tools/impl/git.js')
  const witness = join(mission, 'contract-witness.txt')
  const rec = join(runDir, 'containment.json'), aside = join(runDir, 'containment.json.aside')
  renameSync(rec, aside)
  try {
    const contract = await runCommandDetailed(mission, `Set-Content -LiteralPath '${witness}' x`, 120_000)
    const git = await gitTool.execute({ subcommand: 'add', args: '-A' }, mission)
    return {
      contract: { outcome: contract.outcome, tail: contract.tail.slice(0, 600) },
      git: { isError: git.isError, output: git.output.slice(0, 600) },
      witness: existsSync(witness),
    }
  } finally {
    renameSync(aside, rec)
  }
})

// S2b: the daemon's precheck, as the daemon runs it. NOT a test context: runPrecheck makes a real
// `precheck` sandbox, here under this fixture's own root (LOCALCODE_SANDBOX_ROOT points at it for the
// step), runs the command through the launcher, and releases. The folder it runs in gets no label.
await step('precheck', async () => {
  const { runPrecheck } = await import('../../daemon/precheck.js')
  const { containmentRecords } = await import('../../containment.js')
  const folder = join(dir, 'precheck')
  mkdirSync(folder)
  const rootBefore = process.env.LOCALCODE_SANDBOX_ROOT
  process.env.LOCALCODE_SANDBOX_ROOT = root
  // S5: the precheck's (real) context records its command in the tool-call audit, whose folder may
  // not lie in the home folder, and on Windows the temp folder is inside it. So this step's audit
  // folder is a marked temp folder of its own under an existing C:\tmp (the fixture creates no
  // folder outside its own), removed entry by entry afterwards. A machine with no C:\tmp skips the
  // step by name. A second, unmarked folder is the fail-closed case: a start that cannot be written.
  const auditRoot = outsideHomeTemp()
  if (auditRoot === null) {
    if (rootBefore === undefined) delete process.env.LOCALCODE_SANDBOX_ROOT
    else process.env.LOCALCODE_SANDBOX_ROOT = rootBefore
    return { skipped: 'C:\\tmp does not exist on this machine, and the precheck\'s audit folder must lie outside the home folder' }
  }
  const auditBefore = process.env.LOCALCODE_AUDIT_DIR
  const audit = mkdtempSync(join(auditRoot, 'cynco-fixture-audit-'))
  const unmarked = mkdtempSync(join(auditRoot, 'cynco-fixture-audit-'))
  writeFileSync(join(audit, '.cynco-audit'), '')
  process.env.LOCALCODE_AUDIT_DIR = audit
  try {
    const labelBefore = labelsOf(folder)
    const printed = await runPrecheck(`echo home=%USERPROFILE%& "${WHOAMI}" /groups /fo csv /nh`, folder, 'fixture-trades')
    const labelAfter = labelsOf(folder)
    const exited = await runPrecheck('echo go& exit 3', folder, 'fixture-trades')
    const recs = containmentRecords({ sandboxRoot: root }).filter(r => r.kind === 'precheck')
    // Fail closed: the audit folder has no marker, so the start cannot be written and nothing runs.
    process.env.LOCALCODE_AUDIT_DIR = unmarked
    const witness = join(folder, 'precheck-witness.txt')
    const blocked = await runPrecheck(`echo ran> "${witness}"& echo go`, folder, 'fixture-blocked')
    const blockedRecs = containmentRecords({ sandboxRoot: root }).filter(r => r.kind === 'precheck' && r.runId.startsWith('precheck-fixture-blocked-'))
    return {
      blocked: {
        code: blocked.code, stdout: blocked.stdout.trim(), witness: existsSync(witness),
        records: blockedRecs.map(r => ({ released: r.releasedAt !== null })), unmarkedFiles: readdirSync(unmarked),
      },
      printed: { code: printed.code, home: (/home=(\S*)/.exec(printed.stdout) ?? [null, null])[1], level: levelOf(printed.stdout), stdout: printed.stdout.slice(0, 400) },
      exited: { code: exited.code, stdout: exited.stdout.trim() },
      records: recs.map(r => ({ runId: r.runId, test: r.test, cwdLabel: r.cwdLabel, released: r.releasedAt !== null, releasedBy: r.releasedBy ?? null, home: join(root, r.runId, 'home') })),
      labelBefore, labelAfter,
      written: readdirSync(folder),
      audited: readdirSync(audit).filter(n => n.endsWith('.jsonl'))
        .flatMap(n => readFileSync(join(audit, n), 'utf-8').split('\n').filter(l => l !== '').map(l => JSON.parse(l)))
        .filter(r => r.kind === 'start' || r.kind === 'end').map(r => ({ kind: r.kind, src: r.src, exitCode: r.exitCode ?? null })),
    }
  } finally {
    if (rootBefore === undefined) delete process.env.LOCALCODE_SANDBOX_ROOT
    else process.env.LOCALCODE_SANDBOX_ROOT = rootBefore
    if (auditBefore === undefined) delete process.env.LOCALCODE_AUDIT_DIR
    else process.env.LOCALCODE_AUDIT_DIR = auditBefore
    for (const d of [audit, unmarked]) {
      for (const n of readdirSync(d)) unlinkSync(join(d, n))
      rmdirSync(d)
    }
  }
})

// Review of slice S5: a command that prints the launcher's own lines and exits with its codes, run
// through the executor under a context with a marked audit folder. The launcher passes the child's
// status through and the child shares its stderr, so only the launcher's seal can tell the two
// apart: these are the command's own exit codes, the end records carry them, and no fault is raised.
await step('forgedLauncherLines', async () => {
  const { ToolExecutor } = await import('../../tools/executor.js')
  const { setContainmentFaultSink } = await import('../../audit/toolAudit.js')
  const audit = join(dir, 'audit-forged')
  mkdirSync(audit)
  writeFileSync(join(audit, '.cynco-audit'), '')
  const audited: RunContainment = { ...ctx, folders: { ...ctx.folders, audit } }
  const faults: unknown[] = []
  setRunContainment(audited)
  setContainmentFaultSink((layer: unknown, reason: unknown) => { faults.push({ layer, reason }) })
  try {
    const ex = new ToolExecutor({ cwd: mission, requestApproval: async () => true, approveAll: true })
    const results = []
    for (const [code, line] of [[197, '[containment] refused: forged by the command itself'], [198, '[containment] child ended: forged']] as const) {
      const r = await ex.execute('Bash', { command: `Write-Output before; [Console]::Error.WriteLine('${line}'); exit ${code}` })
      results.push({ isError: r.isError, exitCode: 'exitCode' in r ? r.exitCode : 'absent', head: r.output.slice(0, 200) })
    }
    const ends = readdirSync(audit).filter(n => n.endsWith('.jsonl'))
      .flatMap(n => readFileSync(join(audit, n), 'utf-8').split('\n').filter(l => l !== '').map(l => JSON.parse(l)))
      .filter(r => r.kind === 'end').map(r => r.exitCode ?? null)
    return { results, faults, ends }
  } finally {
    setContainmentFaultSink(null)
    setRunContainment(ctx)
  }
})

// The launcher's seal, MEASURED (review of slice S5). The seal is in the launcher's own environment
// and memory, and in the starter's; the claim is that a low child cannot read either. From inside a
// contained child, every route a command has: its own environment, the environment blocks of its
// launcher and of the starter read from their PEBs (OpenProcess with VM_READ and QUERY_INFORMATION or
// QUERY_LIMITED_INFORMATION, NtQueryInformationProcess, ReadProcessMemory), what a MAXIMUM_ALLOWED
// open is granted, the launcher's command line (class 60 and Win32_Process), Get-Process StartInfo,
// and the Process handles in its own table. The same PEB read of its own block is the control that
// the route works where it is allowed. While the child waits, a medium process reads the labels and
// token levels of both, and the launcher's block. Only booleans and error lines are reported: the
// blocks hold the environment, which is never printed.
const SEAL_PROBE_CS = `using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SealProbe {
  public const uint VM_READ = 0x0010, QUERY_INFORMATION = 0x0400, QUERY_LIMITED = 0x1000, DUP_HANDLE = 0x0040, READ_CONTROL = 0x00020000, MAXIMUM_ALLOWED = 0x02000000;
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetHandleInformation(IntPtr h, out uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int GetProcessId(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] buf, int len, out int ret);
  [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(IntPtr h, int objType, uint secInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint secInfo, out IntPtr str, out uint len);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder buf, ref int size);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);

  static string Err() { return "error " + Marshal.GetLastWin32Error(); }

  public static int ParentOf(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return -1;
    try {
      byte[] b = new byte[48]; int r;
      if (NtQueryInformationProcess(h, 0, b, b.Length, out r) != 0) return -2;
      return (int)BitConverter.ToInt64(b, 40);
    } finally { CloseHandle(h); }
  }

  public static string Open(int pid, uint access) {
    IntPtr h = OpenProcess(access, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess " + Err();
    CloseHandle(h);
    return "opened";
  }

  public static string Granted(int pid) {
    IntPtr h = OpenProcess(MAXIMUM_ALLOWED, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess " + Err();
    try {
      IntPtr buf = Marshal.AllocHGlobal(56);
      try {
        int r;
        int st = NtQueryObject(h, 0, buf, 56, out r);
        if (st != 0) return "NtQueryObject 0x" + st.ToString("X8");
        return "0x" + ((uint)Marshal.ReadInt32(buf, 4)).ToString("X8");
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { CloseHandle(h); }
  }

  public static string ReadEnv(int pid, uint access) {
    IntPtr h = OpenProcess(access, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess " + Err();
    try { return ReadEnvVia(h); } finally { CloseHandle(h); }
  }

  public static string ReadEnvVia(IntPtr h) {
    byte[] pbi = new byte[48]; int r;
    int st = NtQueryInformationProcess(h, 0, pbi, 48, out r);
    if (st != 0) return "NtQueryInformationProcess 0x" + st.ToString("X8");
    IntPtr peb = new IntPtr(BitConverter.ToInt64(pbi, 8));
    byte[] p8 = new byte[8]; IntPtr got;
    if (!ReadProcessMemory(h, peb + 0x20, p8, (IntPtr)8, out got)) return "ReadProcessMemory(PEB) " + Err();
    IntPtr pp = new IntPtr(BitConverter.ToInt64(p8, 0));
    if (!ReadProcessMemory(h, pp + 0x80, p8, (IntPtr)8, out got)) return "ReadProcessMemory(ProcessParameters) " + Err();
    IntPtr env = new IntPtr(BitConverter.ToInt64(p8, 0));
    if (!ReadProcessMemory(h, pp + 0x3F0, p8, (IntPtr)8, out got)) return "ReadProcessMemory(EnvironmentSize) " + Err();
    long size = BitConverter.ToInt64(p8, 0);
    if (size <= 0 || size > (1 << 24)) return "EnvironmentSize " + size;
    byte[] block = new byte[size];
    if (!ReadProcessMemory(h, env, block, (IntPtr)size, out got)) return "ReadProcessMemory(Environment) " + Err();
    return "read:" + Encoding.Unicode.GetString(block);
  }

  public static string CommandLine(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess " + Err();
    try {
      byte[] b = new byte[65536]; int r;
      int st = NtQueryInformationProcess(h, 60, b, b.Length, out r);
      if (st != 0) return "NtQueryInformationProcess 0x" + st.ToString("X8");
      return "read:" + Encoding.Unicode.GetString(b, 16, BitConverter.ToUInt16(b, 0));
    } finally { CloseHandle(h); }
  }

  public static string[] OwnProcessHandles(int[] targets) {
    List<string> found = new List<string>();
    IntPtr buf = Marshal.AllocHGlobal(1024);
    try {
      for (long v = 4; v < 0x8000; v += 4) {
        IntPtr h = new IntPtr(v); uint flags; int r;
        if (!GetHandleInformation(h, out flags)) continue;
        if (NtQueryObject(h, 2, buf, 1024, out r) != 0) continue;
        if (Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, 8), Marshal.ReadInt16(buf, 0) / 2) != "Process") continue;
        int pid = GetProcessId(h);
        string line = "0x" + v.ToString("X") + "=" + pid;
        if (NtQueryObject(h, 0, buf, 56, out r) == 0) line += " access=0x" + ((uint)Marshal.ReadInt32(buf, 4)).ToString("X") + " inherit=" + (flags & 1);
        StringBuilder img = new StringBuilder(1024); int isz = 1024;
        line += " image=" + (QueryFullProcessImageNameW(h, 0, img, ref isz) ? System.IO.Path.GetFileName(img.ToString()) : "?") + " alive=" + (WaitForSingleObject(h, 0) == 0x102);
        if (Array.IndexOf(targets, pid) >= 0 || (flags & 1) == 1) { string e = ReadEnvVia(h); line += e.StartsWith("read:") ? " env=read" : " env=" + e; }
        found.Add(line);
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return found.ToArray();
  }

  public static string Label(int pid) {
    IntPtr h = OpenProcess(READ_CONTROL, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess " + Err();
    try {
      IntPtr sd;
      uint rc = GetSecurityInfo(h, 6, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
      if (rc != 0) return "GetSecurityInfo error " + rc;
      try {
        IntPtr s; uint n;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x10, out s, out n)) return "Convert " + Err();
        string text = Marshal.PtrToStringUni(s);
        LocalFree(s);
        return text;
      } finally { LocalFree(sd); }
    } finally { CloseHandle(h); }
  }

  public static string TokenLevel(int pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess " + Err();
    try {
      IntPtr tok;
      if (!OpenProcessToken(h, 0x0008, out tok)) return "OpenProcessToken " + Err();
      try {
        IntPtr buf = Marshal.AllocHGlobal(256);
        try {
          int r; IntPtr s;
          if (!GetTokenInformation(tok, 25, buf, 256, out r)) return "GetTokenInformation " + Err();
          if (!ConvertSidToStringSidW(Marshal.ReadIntPtr(buf, 0), out s)) return "ConvertSid " + Err();
          string text = Marshal.PtrToStringUni(s);
          LocalFree(s);
          return text;
        } finally { Marshal.FreeHGlobal(buf); }
      } finally { CloseHandle(tok); }
    } finally { CloseHandle(h); }
  }
}
`
await step('sealUnreadable', async () => {
  const cs = join(dir, 'sealProbe.cs')
  writeFileSync(cs, SEAL_PROBE_CS)
  // The probe needs PowerShell's Add-Type (the C# compiler of .NET Framework); where it cannot compile,
  // the step is skipped by name.
  const compiles = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -Path '${cs}'; 'compiled'`], { encoding: 'utf-8', windowsHide: true, timeout: 120_000 })
  if (String(compiles.stdout ?? '').trim() !== 'compiled') {
    return { skipped: `PowerShell Add-Type could not compile the probe (${`${compiles.stderr ?? ''}`.trim().split(/\r?\n/)[0] ?? compiles.status})` }
  }
  const mark = randomBytes(8).toString('hex')
  const pidFile = join(ctx.sandbox.scratch, 'seal-pids.txt'), goFile = join(ctx.sandbox.scratch, 'seal-go.txt')
  const NL = '[string][char]10'
  const childCmd = [
    `Add-Type -Path '${cs}'`,
    '$r = [ordered]@{}',
    '$me = $PID; $launcher = [SealProbe]::ParentOf($me); $engine = [SealProbe]::ParentOf($launcher)',
    '$r.pids = "$me $launcher $engine"',
    `$r.ownEnv = 'read:' + (([Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ${NL})`,
    '$rw = [SealProbe]::VM_READ -bor [SealProbe]::QUERY_INFORMATION; $rl = [SealProbe]::VM_READ -bor [SealProbe]::QUERY_LIMITED',
    '$r.ownPeb = [SealProbe]::ReadEnv($me, $rw)',
    '$r.launcherPeb = [SealProbe]::ReadEnv($launcher, $rw)',
    '$r.launcherPebLimited = [SealProbe]::ReadEnv($launcher, $rl)',
    '$r.enginePeb = [SealProbe]::ReadEnv($engine, $rw)',
    `$r.launcherOpen = (@('VM_READ', 'QUERY_INFORMATION', 'QUERY_LIMITED', 'DUP_HANDLE', 'READ_CONTROL') | ForEach-Object { "$_=" + [SealProbe]::Open($launcher, [SealProbe]::$_) }) -join '; '`,
    '$r.launcherGranted = [SealProbe]::Granted($launcher)',
    '$r.engineGranted = [SealProbe]::Granted($engine)',
    '$r.launcherCmdLine = [SealProbe]::CommandLine($launcher)',
    '$r.engineCmdLine = [SealProbe]::CommandLine($engine)',
    `$r.cimCmdLines = 'read:' + "$((Get-CimInstance Win32_Process -Filter "ProcessId=$launcher").CommandLine)|$((Get-CimInstance Win32_Process -Filter "ProcessId=$engine").CommandLine)"`,
    `try { $p = Get-Process -Id $launcher -ErrorAction Stop; $r.startInfo = 'read:' + (($p.StartInfo.EnvironmentVariables.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ${NL}) } catch { $r.startInfo = "threw: $($_.Exception.Message)" }`,
    '$r.handles = ([SealProbe]::OwnProcessHandles(@($launcher, $engine)) -join \'; \')',
    '$r.launcherLabel = [SealProbe]::Label($launcher)',
    `Set-Content -LiteralPath '${pidFile}' -Value "$me $launcher $engine"`,
    `$t = 0; while (-not (Test-Path -LiteralPath '${goFile}') -and $t -lt 600) { Start-Sleep -Milliseconds 100; $t++ }`,
    '$r | ConvertTo-Json -Compress',
  ].join('\r\n')
  const c = containedCommand({ file: childCmd, args: [], shell: PS }, { ctx, cwd: mission, extraEnv: { CYNCO_SEAL_PROBE_MARK: mark } })
  const seal = c.seal ?? ''
  let out = '', errText = ''
  const child = spawn(c.file, c.args, { cwd: c.cwd, env: c.env, windowsHide: true })
  // The started process, not its pid (wave 24, F255): the cap's kill comes up to 90 s later, when the root may have ended.
  const tree = ownProcessTree(child)
  child.stdout?.on('data', d => { out += String(d) })
  child.stderr?.on('data', d => { errText += String(d) })
  const exited = new Promise<number | null>(r => child.on('close', code => r(code)))
  const giveUp = Date.now() + 120_000
  while (!existsSync(pidFile) && Date.now() < giveUp) await sleep(100)
  let medium: Record<string, unknown> = { notRead: 'the child wrote no pid file' }
  const pids = existsSync(pidFile) ? readFileSync(pidFile, 'utf-8').trim().split(/\s+/).map(Number) : []
  if (pids.length === 3) {
    const [self, launcher] = pids
    // No seal on this command line: a low process can read a command line (class 60), and the child is still running.
    const m = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -Path '${cs}'; @{ launcherLabel = [SealProbe]::Label(${launcher}); launcherToken = [SealProbe]::TokenLevel(${launcher}); ` +
      `childLabel = [SealProbe]::Label(${self}); childToken = [SealProbe]::TokenLevel(${self}); ` +
      `launcherEnv = [SealProbe]::ReadEnv(${launcher}, [SealProbe]::VM_READ -bor [SealProbe]::QUERY_INFORMATION) } | ConvertTo-Json -Compress`],
    { encoding: 'utf-8', windowsHide: true, timeout: 120_000 })
    try {
      const j = JSON.parse(String(m.stdout ?? '').trim()) as Record<string, string>
      const env = String(j.launcherEnv ?? '')
      medium = { launcherLabel: j.launcherLabel, launcherToken: j.launcherToken, childLabel: j.childLabel, childToken: j.childToken, launcherEnvRead: env.startsWith('read:'), launcherEnvHasSeal: seal !== '' && env.includes(seal) }
    } catch (e) {
      medium = { notRead: `${(e as Error).message}: ${String(m.stderr ?? '').trim().slice(0, 300)}` }
    }
  }
  writeFileSync(goFile, 'go')
  const timer = setTimeout(() => { void tree.kill() }, 90_000)
  const code = await exited
  clearTimeout(timer)
  tree.release()
  if (c.commandFile && existsSync(c.commandFile)) unlinkSync(c.commandFile)
  const routes: Record<string, { hasSeal: boolean; hasMark: boolean; head: string }> = {}
  let handles: string[] = []
  try {
    const j = JSON.parse(out.trim().split(/\r?\n/).pop() ?? '') as Record<string, string>
    for (const [k, v] of Object.entries(j)) {
      const t = String(v ?? '')
      routes[k] = { hasSeal: seal !== '' && t.includes(seal), hasMark: t.includes(mark), head: t.startsWith('read:') ? `read: ${t.length - 5} characters` : t.slice(0, 300) }
    }
    handles = String(j.handles ?? '').split('; ').filter(Boolean)
  } catch (e) {
    return { seal, code, error: `the child printed no report (${(e as Error).message})`, stderr: errText.slice(0, 600) }
  }
  const [, launcherPid, enginePid] = pids
  return {
    seal, code, stderr: errText.slice(0, 600), routes, medium,
    pidsAsExpected: launcherPid === child.pid && enginePid === process.pid,
    handlesToLauncherOrEngine: handles.filter(h => { const pid = Number((/=(\d+)/.exec(h) ?? [])[1]); return pid === launcherPid || pid === enginePid }),
    handles,
  }
})

// S2c, entry 1.B2 (06 entry A7, 01-isolation 9.2): the gate-authoring check, run as the model and the
// driver run it, inside an authoring mission's containment whose extra root is the BASE archive. The
// check's own spawns run directly (the process is already low; no second sandbox), and its gates run
// in the labelled BASE. Two forms: an empty staging folder (the check's own "missing" verdict) and a
// staged triple whose gate leaves a witness in the BASE when it runs.
await step('authoringCheck', async () => {
  const python = spawnSync('python', ['--version'], { encoding: 'utf-8', windowsHide: true })
  if (python.status !== 0) return { notRun: 'no python' }
  const { checkCommand } = await import('../../../scripts/cynco-gate-author.mjs')
  const { getShellInfo, shellPreamble } = await import('../../tools/shellInfo.js')
  const { containmentRecords } = await import('../../containment.js')
  const staging = join(dir, 'authoring', 'a1')
  const base = join(dir, 'base-archive')
  mkdirSync(staging, { recursive: true })
  mkdirSync(base)
  execFileSync('git', ['init', '-q'], { cwd: staging, windowsHide: true })
  writeFileSync(join(staging, 'NOTES.md'), 'authoring\n')
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'add', '-A'], { cwd: staging, windowsHide: true })
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-q', '-m', 'one'], { cwd: staging, windowsHide: true })
  writeFileSync(join(base, 't_ok.py'), 'def test_ok():\n    assert 1 + 1 == 2\n')
  const est2 = establishContainment({
    test: true, kind: 'mission', label: 'authoring-check', missionCwd: staging, extraRoots: [base],
    sandboxRoot: root, home, folders,
  })
  if (!est2.ok) return { establish: est2.reason }
  const actx = est2.containment
  try {
    const info = getShellInfo()
    const sh = (command: string, cwd: string) => run(shellPreamble(info) + command, { cwd, shell: info.shell, ctx: actx })
    // A contained child writes the BASE (an extra root) and runs pytest there.
    const probe = await sh(`Set-Content -LiteralPath '${join(base, 'probe.txt')}' x`, staging)
    const hasPytest = spawnSync('python', ['-c', 'import pytest'], { encoding: 'utf-8', windowsHide: true }).status === 0
    const tests = hasPytest
      ? await sh('python -m pytest -q -p no:cacheprovider t_ok.py', base)
      : await sh('python -m py_compile t_ok.py', base)
    const recordsBefore = containmentRecords({ sandboxRoot: root }).length
    // 1. The empty staging folder: the check's own verdict.
    const empty = await sh(checkCommand(staging, base), staging)
    // 2. A staged triple: calibration runs the three gates in the BASE.
    const gateLines = (lines: string[]) => [
      'from pathlib import Path',
      `Path(${JSON.stringify(join(base, 'gate-ran.txt'))}).write_text('ran')`,
      ...lines.map(l => `print(${JSON.stringify(l)})`),
    ].join('\n') + '\n'
    writeFileSync(join(staging, 'gate_a1.py'), gateLines(['A1.1: FAIL absent', 'GATE: MISS (1 fails)']))
    writeFileSync(join(staging, 'perturb_a1.py'), '# EXPECT-FLIP:\n# MUST-FAIL: A1.1\n' + gateLines(['A1.1: FAIL absent', 'GATE: MISS (1 fails)']))
    writeFileSync(join(staging, 'positive_a1.py'), gateLines(['A1.1: PASS', 'GATE: PASS']))
    const staged = await sh(checkCommand(staging, base), staging)
    const recordsAfter = containmentRecords({ sandboxRoot: root }).length
    const out = (r: Ran) => `${r.stdout}${r.stderr}`
    return {
      probe: { err: probe.err?.message ?? null, created: existsSync(join(base, 'probe.txt')) },
      tests: { form: hasPytest ? 'pytest' : 'py_compile (no pytest)', code: tests.err?.code ?? 0, output: out(tests).slice(-300) },
      empty: { code: empty.err?.code ?? 0, isRefusal: empty.err?.isRefusal ?? false, message: empty.err?.message ?? null, output: out(empty).slice(0, 1200) },
      staged: { code: staged.err?.code ?? 0, isRefusal: staged.err?.isRefusal ?? false, message: staged.err?.message ?? null, output: out(staged).slice(0, 3000), gateRan: existsSync(join(base, 'gate-ran.txt')) },
      nestedRecords: recordsAfter - recordsBefore,
    }
  } finally {
    const r = releaseContainment(actx)
    cases.authoringCheckRelease = { relabelled: r.relabelled, note: r.note, probeLabels: existsSync(join(base, 'probe.txt')) ? labelsOf(join(base, 'probe.txt')) : null, baseLabels: labelsOf(base), stagingLabels: labelsOf(staging) }
  }
})

await step('overhead', async () => {
  const out: Record<string, number> = {}
  for (const [name, shell] of [['powershell', PS], ['cmd', '']] as const) {
    for (const [mode, c] of [['launcher', ctx], ['direct', null]] as const) {
      const ms: number[] = []
      for (let i = 0; i < 10; i++) ms.push((await run('exit 0', { cwd: mission, shell: shell || undefined, ctx: c })).ms)
      out[`${name}_${mode}_median_ms`] = median(ms)
    }
  }
  return out
})

// Labels, written before release (residue) and read after it.
await step('residueWrite', async () => {
  const lines: string[] = []
  for (const base of [mission, extra]) {
    const deep = join(base, 'r1', 'r2')
    lines.push(`New-Item -ItemType Directory -Force -Path '${join(deep, 'dir')}' | Out-Null`, `Set-Content -LiteralPath '${join(deep, 'file.txt')}' x`)
    // What a run can do to outlast the release's root relabel: set a low label of its own.
    lines.push(`& '${ICACLS}' '${join(deep, 'dir')}' /setintegritylevel '(OI)(CI)L' | Out-Null`, `& '${ICACLS}' '${join(deep, 'file.txt')}' /setintegritylevel L | Out-Null`)
  }
  const r = await run(lines.join('; '), { cwd: mission, shell: PS, ctx })
  const explicit: Record<string, string[]> = {}
  for (const base of [mission, extra]) for (const p of [join(base, 'r1', 'r2', 'dir'), join(base, 'r1', 'r2', 'file.txt')]) explicit[p] = labelsOf(p)
  return { err: r.err?.message ?? null, explicit }
})
await step('labelLeakAfterEstablish', async () => {
  const entries = [outside, ...walk(outside)]
  const low = entries.filter(p => isLow(labelsOf(p)))
  const r = await run(`try { [IO.File]::WriteAllText('${join(linkedOut, 'through.txt')}', 'x'); 'created' } catch { 'denied' }`, { cwd: mission, shell: PS, ctx })
  return { lowUnderOutside: low, throughJunction: r.stdout.trim(), throughExists: existsSync(join(outside, 'through.txt')), missionLabel: labelsOf(mission), extraLabel: labelsOf(extra) }
})

// B1 (wave 19): the installed Git's namespace is held at normal integrity from the first contained child
// of this process on, so a low start of the installed Git fails always, whatever else runs on the machine.
await step('gitNamespaceHeld', async () => {
  const gitRoot = installedGitRoot()
  if (gitRoot === null) return { skip: 'no installed Git with an msys runtime' }
  const h = gitNamespaceHolder()
  const image = h ? (String(spawnSync(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tasklist.exe'), ['/FI', `PID eq ${h.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8', windowsHide: true }).stdout ?? '').split(',')[0] ?? '').replace(/"/g, '') : null
  const r = await run(`& '${join(gitRoot, 'usr', 'bin', 'bash.exe')}' -c 'echo started'`, { cwd: mission, shell: PS, ctx })
  return { holder: h, image, runs: h?.runs ?? [], lowInstalledBash: `${r.stdout}${r.stderr}`.trim().slice(0, 300) }
})

// B1 (wave 19), the investigation's PLAN step 5: with the switch on, the copy's bash runs grep and a
// shell hook's commit at low, while Git Bash processes of the installed Git run (the holder is one).
const mission3 = join(dir, 'mission3')
await step('msysCopySwitch', async () => {
  const gitRoot = installedGitRoot()
  if (gitRoot === null) return { skip: 'no installed Git with an msys runtime' }
  const copy = join(dir, 'msys-copy')
  for (const part of ['usr\\bin', 'etc', 'dev', 'tmp']) {
    const c = spawnSync('robocopy.exe', [join(gitRoot, part), join(copy, part), '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf-8', windowsHide: true })
    if (c.status === null || c.status >= 8) return { copyFailed: `${part}: ${c.status} ${String(c.stdout ?? '').trim().slice(0, 200)}` }
  }
  mkdirSync(mission3)
  execFileSync('git', ['init', '-q'], { cwd: mission3, windowsHide: true })
  writeFileSync(join(mission3, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook ran: $(uname -o)" > hook-ran.txt\nexit 0\n')
  const est3 = establishContainment({ test: true, kind: 'mission', label: 'launcher-fixture-msys', missionCwd: mission3, sandboxRoot: root, home, folders, msys: copy })
  if (!est3.ok) return { establish3: est3.reason }
  const ctx3 = est3.containment
  const grep = await run(`bash -c 'printf "a\\nhello\\nb\\n" | grep -c hello'`, { cwd: mission3, shell: PS, ctx: ctx3 })
  const commit = await run('git -c user.name=fixture -c user.email=fixture@localhost commit -q --allow-empty -m probe; Write-Output "exit=$LASTEXITCODE"', { cwd: mission3, shell: PS, ctx: ctx3 })
  const level = await run(`bash -c 'echo $PATH | cut -d: -f1; cygpath -w /usr/bin'; & '${WHOAMI}' /groups /fo csv /nh | Select-String 'S-1-16-4096' | Measure-Object | ForEach-Object Count`, { cwd: mission3, shell: PS, ctx: ctx3 })
  const hook = existsSync(join(mission3, 'hook-ran.txt')) ? readFileSync(join(mission3, 'hook-ran.txt'), 'utf-8').trim() : null
  const rel3 = releaseContainment(ctx3)
  return {
    msysRuntime: ctx3.msysRuntime, grep: grep.stdout.trim(), grepErr: `${grep.stderr}`.trim().slice(0, 300),
    commit: commit.stdout.trim(), commitErr: commit.stderr.trim().slice(0, 300), hook, level: level.stdout.trim().split(/\r?\n/).map(l => l.trim()),
    released: rel3.relabelled, releaseNote: rel3.note, runId: ctx3.runId,
  }
})

const rel = releaseContainment(ctx)
cases.release = { relabelled: rel.relabelled, note: rel.note }

await step('afterRelease', async () => {
  const residue: Record<string, { labels: string[]; low: boolean }> = {}
  for (const base of [mission, extra]) {
    for (const p of [join(base, 'r1'), join(base, 'r1', 'r2'), join(base, 'r1', 'r2', 'dir'), join(base, 'r1', 'r2', 'file.txt')]) {
      const labels = labelsOf(p)
      residue[p] = { labels, low: isLow(labels) }
    }
  }
  // A low child (the record is still there; it is released, not deleted) is denied a create in each.
  const targets = [mission, extra, join(mission, 'r1', 'r2'), join(mission, 'r1', 'r2', 'dir'), join(extra, 'r1', 'r2'), join(extra, 'r1', 'r2', 'dir')]
  const lines = targets.map((t, i) => `try { [IO.File]::WriteAllText('${join(t, `after-${i}.txt`)}', 'x'); Write-Output 'created' } catch { Write-Output 'denied' }`)
  const r = await run(lines.join('; '), { cwd: ctx.sandbox.scratch, shell: PS, ctx })
  const lowUnderOutside = [outside, ...walk(outside)].filter(p => isLow(labelsOf(p)))
  return {
    residue, anyLow: Object.values(residue).some(v => v.low),
    lowChildCreates: r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean), createdFiles: targets.map((t, i) => existsSync(join(t, `after-${i}.txt`))),
    missionLabel: labelsOf(mission), extraLabel: labelsOf(extra), lowUnderOutside,
  }
})

// A run that denies its owner WRITE_OWNER on its mission folder: the release cannot set it back,
// says so, and the next establish for that folder refuses while it still reads low.
await step('releaseBlocked', async () => {
  const who = spawnSync(WHOAMI, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf-8', windowsHide: true })
  const sid = (/"(S-1-[\d-]+)"/.exec(String(who.stdout ?? '')) ?? [null, null])[1]
  const est2 = establishContainment({ test: true, kind: 'mission', label: 'launcher-fixture-2', missionCwd: mission2, sandboxRoot: root, home, folders })
  if (!est2.ok) return { establish2: est2.reason }
  const ctx2 = est2.containment
  const r = await run(`& '${ICACLS}' '${mission2}' /deny '*${sid}:(WO)'`, { cwd: mission2, shell: PS, ctx: ctx2 })
  const rel2 = releaseContainment(ctx2)
  const lowAfterRelease = isLow(labelsOf(mission2))
  const again = establishContainment({ test: true, kind: 'mission', label: 'launcher-fixture-3', missionCwd: mission2, sandboxRoot: root, home, folders })
  // Clean up as the owner, who may always change the permissions of what it owns.
  const undo = spawnSync(ICACLS, [mission2, '/remove:d', `*${sid}`], { encoding: 'utf-8', windowsHide: true })
  const back = spawnSync(ICACLS, [mission2, '/setintegritylevel', '(OI)(CI)M'], { encoding: 'utf-8', windowsHide: true })
  return {
    denyOut: `${r.stdout}${r.stderr}`.trim().slice(0, 300), denyErr: r.err?.message ?? null,
    relabelled: rel2.relabelled, note: rel2.note, lowAfterRelease,
    nextEstablish: again.ok ? 'established' : again.reason,
    cleanedUp: undo.status === 0 && back.status === 0 && !isLow(labelsOf(mission2)),
  }
})

// B1: a released run is no longer held; a context this fixture never released (a test context of a
// case) still is, until the process ends (its end of the holder's stdin then closes).
await step('gitNamespaceAfterReleases', async () => {
  await sleep(300)
  // (The fixture's main context is used again after its release, by afterRelease, so it is held again.)
  return { holder: gitNamespaceHolder(), released: [(cases.msysCopySwitch as { runId?: string } | undefined)?.runId ?? null] }
})

setRunContainment(null)
// Remove the junctions this fixture made; never enter them.
for (const link of [linkedOut, join(mission, 'jout')]) if (statSyncNoFollow(link) === 'link') rmdirSync(link)
report({ ok: true, engineJob: engineJob.installed, runId: ctx.runId, isolation: ctx.isolation, establishMs: est.ms, volumesAcknowledged: volumes, runDirIsDir: statSync(runDir).isDirectory() })
process.exit(0)
