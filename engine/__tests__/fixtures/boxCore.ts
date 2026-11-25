/**
 * Run under Bun on Windows by `engine/__tests__/containmentBoxCore.test.ts`: the real low-integrity
 * launcher, real `icacls` labels and the real probe, for the box-core changes of 2026-11-24:
 *   noProfile   a contained PowerShell is started with -NoProfile -NonInteractive (NOW.md:261)
 *   pathOrder   a contained child's PATH is the one it was given (P2-F5: no reorder), so under a
 *               PATH with Git's usr\bin first its bare `whoami` and `grep` are Git's; OneDrive* name
 *               the sandbox home (R1 F2, NOW.md:96)
 *   release     a release sets the sandbox's home, tmp and scratch back to medium, and a low child
 *               can no longer create a file there (NOW.md:78)
 *
 * argv: <dir>, a folder the test made with mkdtemp. Everything is made and labelled inside it:
 * <dir>/root (the sandbox root), <dir>/home (a fake home), <dir>/mission (git init), <dir>/state,
 * <dir>/models, <dir>/guard. It installs the engine's kill-on-close job as `main.ts` does,
 * acknowledges in its OWN environment whatever volumes `listUnprotectedVolumes()` reports (it writes
 * nothing to one), and prints one JSON line: `{ ok, cases: { <name>: {...} } }`. The test decides.
 */
import { execFileSync, spawnSync, type ExecException } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContainmentRefusal, establishContainment, listUnprotectedVolumes, releaseContainment, setRunContainment, toolExec,
  type RunContainment,
} from '../../containment.js'
import { installKillOnCloseJob } from '../../security/jobObject.js'

const dir = process.argv[2]
if (!dir || !existsSync(dir)) {
  console.log(JSON.stringify({ ok: false, error: `the fixture needs an existing folder, got ${dir}` }))
  process.exit(2)
}
const SYS = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const PS = join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const ICACLS = join(SYS, 'icacls.exe')
const GIT_USR_BIN = 'C:\\Program Files\\Git\\usr\\bin'

type Ran = { err: string | null; refusal: boolean; stdout: string; stderr: string }
function run(command: string, o: { cwd: string; ctx: RunContainment; env?: Record<string, string | undefined> }): Promise<Ran> {
  return new Promise(resolve => {
    try {
      toolExec(command, { cwd: o.cwd, shell: PS, encoding: 'utf-8', env: o.env }, (err: ExecException | null, stdout: string, stderr: string) => {
        resolve({ err: err ? err.message : null, refusal: err instanceof ContainmentRefusal, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }, o.ctx)
    } catch (e) {
      resolve({ err: (e as Error).message, refusal: e instanceof ContainmentRefusal, stdout: '', stderr: '' })
    }
  })
}
function labelsOf(path: string): string[] {
  const r = spawnSync(ICACLS, [path], { encoding: 'utf-8', windowsHide: true })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).filter(l => /Mandatory Label/i.test(l)).map(l => l.trim())
}
const isLow = (lines: string[]) => lines.some(l => /Low Mandatory Level/i.test(l))

const root = join(dir, 'root'), home = join(dir, 'home'), mission = join(dir, 'mission')
const folders = { state: join(dir, 'state'), models: join(dir, 'models'), guard: join(dir, 'guard'), audit: null }
for (const d of [root, home, mission, folders.state, folders.models, folders.guard]) mkdirSync(d, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: mission, windowsHide: true })

const cases: Record<string, unknown> = {}
async function step(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    cases[name] = await fn()
  } catch (e) {
    cases[name] = { threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

const engineJob = await installKillOnCloseJob()
delete process.env.LOCALCODE_CONTAINMENT_OFF
let volumes: string[] = []
try {
  volumes = listUnprotectedVolumes().map(v => v.root)
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: `volume listing failed: ${(e as Error).message}` }))
  process.exit(0)
}
if (volumes.length) process.env.LOCALCODE_UNPROTECTED_VOLUMES_OK = volumes.join(';')
else delete process.env.LOCALCODE_UNPROTECTED_VOLUMES_OK

const est = establishContainment({ test: true, kind: 'mission', label: 'boxcore-fixture', missionCwd: mission, sandboxRoot: root, home, folders })
if (!est.ok) {
  console.log(JSON.stringify({ ok: false, error: `establish refused: ${est.reason}`, engineJob: engineJob.installed }))
  process.exit(0)
}
const ctx = est.containment
setRunContainment(ctx)

await step('noProfile', async () => {
  const r = await run('[Environment]::CommandLine', { cwd: mission, ctx })
  return { commandLine: r.stdout.trim(), err: r.err }
})

await step('pathOrder', async () => {
  const gitUsr = existsSync(join(GIT_USR_BIN, 'grep.exe'))
  const path = `${GIT_USR_BIN};${process.env.PATH ?? ''}`
  const r = await run(
    "Write-Output \"whoami=$((Get-Command whoami -CommandType Application | Select-Object -First 1).Source)\"; Write-Output \"grep=$((Get-Command grep -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source)\"; Write-Output \"onedrive=$env:OneDrive\"; Write-Output \"onedriveconsumer=$env:OneDriveConsumer\"; Write-Output \"path=$env:PATH\"",
    { cwd: mission, ctx, env: { ...process.env, PATH: path, OneDrive: join(home, 'OneDrive'), OneDriveConsumer: join(home, 'OneDrive') } },
  )
  const said: Record<string, string> = {}
  for (const l of r.stdout.split(/\r?\n/)) { const m = /^(\w+)=(.*)$/.exec(l.trim()); if (m) said[m[1]] = m[2] }
  return { said, gitUsr, given: path, sandboxHome: ctx.sandbox.home, err: r.err }
})

await step('lowWritesBeforeRelease', async () => {
  const target = join(ctx.sandbox.scratch, 'before.txt')
  const r = await run(`try { [IO.File]::WriteAllText('${target}', 'x'); 'created' } catch { 'denied' }`, { cwd: mission, ctx })
  return { said: r.stdout.trim(), exists: existsSync(target), labels: labelsOf(ctx.sandbox.scratch) }
})

const rel = releaseContainment(ctx)
cases.releaseNote = { relabelled: rel.relabelled, note: rel.note }

await step('release', async () => {
  const sb = ctx.sandbox
  const labels = Object.fromEntries([sb.home, sb.tmp, sb.scratch].map(d => [d, labelsOf(d)]))
  const target = join(sb.scratch, 'after.txt')
  // A low child after the release: the record is released, not gone, so the launcher still starts.
  const r = await run(`try { [IO.File]::WriteAllText('${target}', 'x'); 'created' } catch { 'denied' }`, { cwd: mission, ctx })
  return { labels, anyLow: Object.values(labels).some(isLow), said: r.stdout.trim(), exists: existsSync(target), err: r.err }
})

setRunContainment(null)
console.log(JSON.stringify({ ok: true, engineJob: engineJob.installed, isolation: ctx.isolation, cases }))
process.exit(0)
