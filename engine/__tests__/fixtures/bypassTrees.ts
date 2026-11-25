/**
 * Run under Bun on Windows by `engine/__tests__/bypassTreesJob.test.ts` (wave 15b, check C4-3 and
 * C4-5). The sites that start a process without the executor (a contract check through
 * `runCommandDetailed`, LSP diagnostics) own their tree from the start; under Bun that is a Job
 * Object, the path every engine on this PC takes, which vitest's Node never does (it finds the tree
 * when it kills it). Each case asks, by the pid the program wrote and the mark it carries, what is left:
 *   contractCut       a check cut at its cap: the program it started is gone
 *   contractNatural   a check that ends on its own: a program it started on purpose lives on (the
 *                     handle is released, not killed); the fixture ends it afterwards
 *   contractOverflow  a check whose output overruns its buffer: exec ends the shell alone, and the
 *                     program the shell started is ended with the tree
 *   lspCut            diagnostics cut at their cap: the program a planted py_compile started is gone
 *   lspOverflow       diagnostics whose output overruns their buffer: the program a planted
 *                     py_compile started is ended with the tree (wave 15c, check B4-7)
 *   lspTscOverflow    the same for tsc's form: the TypeScript errors read before the overrun are
 *                     diagnostics, and the program a planted npx started is ended (wave 19, C4-3)
 *   bestOfNCut        a best-of-N test run cut at its cap: the program it started is gone (wave 15c,
 *                     P4(1b))
 *   bestOfNNatural    a test run that ends on its own: a program it started on purpose lives on
 *   bestOfNOverflow   a test run whose output overruns its buffer: what the shell started is ended
 *
 * argv: <dir>, a folder the test made with mkdtemp. Everything is written in there; no run context is
 * set, nothing is labelled, and the engine's own kill-on-close job is installed as `main.ts` does, so a
 * survivor dies with this process at the latest. Prints one JSON line.
 *
 * What ends a survivor (F255, wave 24): every program a case tracks carries two marks in its command line
 * (`helpers/markedProcesses.ts`), the fixture's own and the case's. "Gone" is `goneWithin(pid, case mark)`
 * and "still running on purpose" is `isMarked(pid, case mark)`; the last act is one `endMarked` of the
 * fixture's mark, whose pids the report gives as `endedAtEnd`. Never a kill by number: until wave 24 the
 * last line ended "what was left" by the nine pids the cases had read, seven of them of programs the cases
 * had already seen gone up to sixteen seconds earlier, and `process.kill(pid, 0)` answers for whatever
 * process has a number now, so the kill could end another program that had been given one of them
 * (another test's Python ended with status 1 and nothing printed, beside this fixture's end, in one suite
 * run of eight). The fixture's mark is made here, so it is in none of this process's own command line (the
 * scratch folder's name is), and the end cannot reach the fixture. Every program ends by itself within two
 * minutes in any case (a `setTimeout`, a bounded sleep), so nothing has to be ended for the machine to be
 * left clean; the end is for what a case leaves.
 *
 * "Gone" is also what `goneWithin` answers when nothing ever carried the mark, so each case that reports a program
 * gone also reports `seenMarked`: a watcher (`watchMarked`), listing before the site starts, saw the program's pid
 * carrying the case's mark while it ran (wave 24, round two). A cut case's program lives until the cap (3 s, 10 s),
 * long enough for several listings. An overrun case's program lived only a few hundred milliseconds (the writer
 * overran at once), too briefly for two listings a second: its writer now waits on a gate file, which the fixture
 * writes once the watcher has seen the program (or after 15 s, when the case then fails on `seenMarked`), and only
 * then overruns.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installKillOnCloseJob } from '../../security/jobObject.js'
import { ownProcessTree } from '../../processTree.js'
import { runCommandDetailed } from '../../tools/contractVerify.js'
import { LSPManager } from '../../lsp/manager.js'
import { runTests } from '../../bestOfN/sampler.js'
import { getShellInfo } from '../../tools/shellInfo.js'
import { endMarked, goneWithin, isMarked, newMark, noneMarkedWithin, watchMarked, type MarkWatch } from '../helpers/markedProcesses.js'

const dir = process.argv[2]
if (!dir || !existsSync(dir)) {
  console.log(JSON.stringify({ ok: false, error: `the fixture needs an existing folder, got ${dir}` }))
  process.exit(2)
}
/** The fixture's mark: on every program a case tracks, so that one `endMarked` ends what is left. */
const fixtureMark = newMark('bypassTrees')
/** A case's own mark, and the text a program carries: both marks, letters and digits only, no space. */
const marksFor = (name: string): { mark: string; tag: string } => {
  const mark = newMark(name)
  return { mark, tag: `${fixtureMark}x${mark}` }
}
const pidIn = async (file: string, ms = 15_000): Promise<number | null> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(file)) { const n = Number(readFileSync(file, 'utf-8').trim()); if (Number.isInteger(n) && n > 0) return n }
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}
/** A watcher already listing for `mark`: what it sees is the evidence that the mark named the program. */
const watchers: MarkWatch[] = []
const watching = async (mark: string): Promise<MarkWatch> => { const w = watchMarked(mark); watchers.push(w); await w.ready; return w }
/** Whether the stopped watcher saw `pid`; a watcher that could not look is no evidence, and says why. */
const sawIt = async (w: MarkWatch, pid: number | null): Promise<boolean | string | null> => {
  try { const seen = await w.stop(); return pid ? seen.includes(pid) : null } catch (e) { return `the watcher failed: ${(e as Error).message}` }
}
/**
 * The gate of an overrun case: written once the watcher has seen the program whose pid `pidFile` names (or after
 * 15 s, so the case ends either way). The writer overruns only then. Resolves to that pid.
 */
async function openOnceSeen(w: MarkWatch, pidFile: string, goFile: string): Promise<number | null> {
  const pid = await pidIn(pidFile, 15_000)
  if (pid) await w.saw(pid, 15_000)
  writeFileSync(goFile, '')
  return pid
}

/**
 * A node program that starts a grandchild waiting two minutes and carrying `tag`, writes the grandchild's pid
 * to `pidFile`, prints `bytes` (once `goFile` exists, when one is named) and waits (two minutes, when `stay`).
 */
function program(name: string, pidFile: string, bytes: number, stay: boolean, tag: string, goFile?: string): string {
  const file = join(dir, `${name}.js`)
  writeFileSync(file, [
    "const { spawn } = require('child_process')",
    `const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000) // ${tag}'], { stdio: 'ignore' })`,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
    `const b = 'x'.repeat(1 << 16); let left = ${bytes}`,
    'const more = () => { while (left > 0) { left -= b.length; if (!process.stdout.write(b)) return process.stdout.once(\'drain\', more) } }',
    goFile === undefined ? 'more()' : `const go = () => require('fs').existsSync(${JSON.stringify(goFile)}) ? more() : setTimeout(go, 50); go()`,
    stay ? 'setTimeout(() => {}, 120000)' : "c.unref(); process.exit(0)",
    '',
  ].join('\n'))
  return `node "${file}"`
}

const engineJob = await installKillOnCloseJob()
// What this process takes for a child's tree ('job' is the case under test), asked of a short child.
const kind = await new Promise<string>(resolve => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore', windowsHide: true })
  const t = ownProcessTree(c.pid)
  c.on('exit', () => { t.release(); resolve(t.kind) })
})
const cases: Record<string, unknown> = {}

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { cases[name] = await fn() } catch (e) { cases[name] = { threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } }
}

await step('contractCut', async () => {
  const { mark, tag } = marksFor('contractCut')
  const pidFile = join(dir, 'cut.pid')
  const w = await watching(mark)
  const r = await runCommandDetailed(dir, program('cut', pidFile, 0, true, tag), 3000)
  const pid = await pidIn(pidFile, 1000)
  return { outcome: r.outcome, pid, seenMarked: await sawIt(w, pid), gone: pid ? await goneWithin(pid, mark) : null }
})

await step('contractNatural', async () => {
  // A background program the check started on purpose, as the vitest case starts it (a node child
  // of a node program would not do: node ends the children it did not detach when it exits, and a
  // detached one leaves the job). Ending on its own, the check gives the handle back and kills nothing.
  const { mark, tag } = marksFor('contractNatural')
  const cmd = getShellInfo().isPowerShell
    ? `Start-Process -WindowStyle Hidden -PassThru node -ArgumentList '-e','setTimeout(()=>{},20000)/*${tag}*/' | ForEach-Object { 'pid=' + $_.Id }`
    : `node -e "setTimeout(()=>{},20000)/*${tag}*/" > /dev/null 2>&1 & echo pid=$!`
  const r = await runCommandDetailed(dir, cmd, 20_000)
  const pid = Number(/pid=(\d+)/.exec(r.tail)?.[1]) || null
  await new Promise(res => setTimeout(res, 500))
  return { outcome: r.outcome, pid, aliveAfter: pid ? isMarked(pid, mark) : null, tail: r.tail.slice(0, 300) }
})

await step('contractOverflow', async () => {
  const { mark, tag } = marksFor('contractOverflow')
  const pidFile = join(dir, 'overflow.pid')
  // The shell starts a program that outlives it (not a node grandchild of the writer: node ends the
  // children it did not detach when the overrun ends it, which would hide a missing tree kill), then
  // a writer prints 12 MiB against the check's 8 MiB buffer and waits: only the overflow ends it.
  const goFile = join(dir, 'overflow.go')
  const writer = program('overflow', join(dir, 'overflow-writer.pid'), 12 * 1024 * 1024, true, tag, goFile)
  const cmd = getShellInfo().isPowerShell
    ? `Start-Process -WindowStyle Hidden -PassThru node -ArgumentList '-e','setTimeout(()=>{},120000)/*${tag}*/' | ForEach-Object { Set-Content -LiteralPath '${pidFile}' -Value $_.Id }; ${writer.replace(/^node /, '& node ')}`
    : `node -e "setTimeout(()=>{},120000)/*${tag}*/" > /dev/null 2>&1 & echo $! > '${pidFile}'; ${writer}`
  const w = await watching(mark)
  const run = runCommandDetailed(dir, cmd, 60_000)
  const opened = openOnceSeen(w, pidFile, goFile)
  const r = await run
  const pid = await opened
  return { outcome: r.outcome, ms: r.ms, pid, seenMarked: await sawIt(w, pid), gone: pid ? await goneWithin(pid, mark) : null }
})

await step('lspCut', async () => {
  const { mark, tag } = marksFor('lspCut')
  const lsp = join(dir, 'lsp')
  mkdirSync(lsp)
  const pidFile = join(lsp, 'grandchild.pid')
  writeFileSync(join(lsp, 'py_compile.py'), [
    'import subprocess, sys, time',
    `p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)  # ${tag}'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)`,
    `open(${JSON.stringify(pidFile)}, 'w').write(str(p.pid))`,
    'time.sleep(120)', '',
  ].join('\n'))
  writeFileSync(join(lsp, 'ok.py'), 'x = 1\n')
  const w = await watching(mark)
  const t0 = Date.now()
  const diags = await new LSPManager(lsp).getDiagnostics(join(lsp, 'ok.py'))
  const ms = Date.now() - t0
  const pid = await pidIn(pidFile, 1000)
  return { diags, ms, pid, seenMarked: await sawIt(w, pid), gone: pid ? await goneWithin(pid, mark) : null }
})

await step('lspOverflow', async () => {
  // A planted py_compile starts a program that outlives it, then prints 9 MiB against the
  // diagnostics' 8 MiB buffer and waits: only the overrun ends it, long before the 10 s cap.
  const { mark, tag } = marksFor('lspOverflow')
  const lsp = join(dir, 'lsp-overflow')
  mkdirSync(lsp)
  const pidFile = join(lsp, 'grandchild.pid')
  const goFile = join(lsp, 'overflow.go')
  writeFileSync(join(lsp, 'py_compile.py'), [
    'import os, subprocess, sys, time',
    `p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)  # ${tag}'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)`,
    `open(${JSON.stringify(pidFile)}, 'w').write(str(p.pid))`,
    // The gate: the overrun comes once the program was seen carrying its mark.
    `while not os.path.exists(${JSON.stringify(goFile)}): time.sleep(0.05)`,
    "sys.stdout.write('x' * (9 * 1024 * 1024))",
    'sys.stdout.flush()',
    'time.sleep(120)', '',
  ].join('\n'))
  writeFileSync(join(lsp, 'ok.py'), 'x = 1\n')
  const w = await watching(mark)
  const t0 = Date.now()
  const running = new LSPManager(lsp).getDiagnostics(join(lsp, 'ok.py'))
  const opened = openOnceSeen(w, pidFile, goFile)
  const diags = await running
  const ms = Date.now() - t0
  const pid = await opened
  return { diags: diags.length, ms, pid, seenMarked: await sawIt(w, pid), gone: pid ? await goneWithin(pid, mark) : null }
})

await step('lspTscOverflow', async () => {
  // Wave 19, check C4-3: tsc's form. A planted npx, put first on PATH for this step, starts a
  // program that outlives it, then prints 9 MiB of TypeScript error lines against the 8 MiB buffer
  // and waits. The lines read before the overrun are diagnostics (a broken build is not reported
  // clean), and the tree is still ended.
  const { mark, tag } = marksFor('lspTscOverflow')
  const lsp = join(dir, 'lsp-tsc-overflow')
  mkdirSync(lsp)
  const pidFile = join(lsp, 'grandchild.pid')
  const goFile = join(lsp, 'overflow.go')
  writeFileSync(join(lsp, 'tsc-stand-in.js'), [
    "const { spawn } = require('child_process')",
    `const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000) // ${tag}'], { stdio: 'ignore' })`,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
    // 59 bytes a line: a cut exactly at the 8 MiB buffer lands 47 bytes into a line, inside its message.
    "const line = 'src/f.ts(1,1): error TS1005: a stand-in error xxxxxxxxxxx.\\n'",
    'const b = line.repeat(1024); let left = 9 * 1024 * 1024',
    'const more = () => { while (left > 0) { left -= b.length; if (!process.stdout.write(b)) return process.stdout.once(\'drain\', more) } }',
    // The gate: the overrun comes once the program was seen carrying its mark.
    `const go = () => require('fs').existsSync(${JSON.stringify(goFile)}) ? more() : setTimeout(go, 50); go()`,
    'setTimeout(() => {}, 120000)', '',
  ].join('\n'))
  writeFileSync(join(lsp, 'npx.cmd'), '@node "%~dp0tsc-stand-in.js"\r\n')
  writeFileSync(join(lsp, 'f.ts'), 'export const x = 1\n')
  // First on PATH for this step only: cmd does not look in the working folder when
  // NoDefaultCurrentDirectoryInExePath is set (it is, in the shells this suite runs from: measured).
  const path = process.env.PATH
  process.env.PATH = `${lsp};${path ?? ''}`
  const w = await watching(mark)
  const t0 = Date.now()
  let diags: Awaited<ReturnType<LSPManager['getDiagnostics']>>
  let opened: Promise<number | null> = Promise.resolve(null)
  try {
    const running = new LSPManager(lsp).getDiagnostics(join(lsp, 'f.ts'))
    opened = openOnceSeen(w, pidFile, goFile)
    diags = await running
  } finally {
    process.env.PATH = path
  }
  const ms = Date.now() - t0
  const pid = await opened
  const cut = diags.filter(d => d.message !== 'a stand-in error xxxxxxxxxxx.').map(d => d.message)
  return { diags: diags.length, first: diags[0]?.message ?? null, cut, ms, pid, seenMarked: await sawIt(w, pid), gone: pid ? await goneWithin(pid, mark) : null }
})

const bestOfN = (command: string) => ({ available: true, framework: 'pytest', command })

await step('bestOfNCut', async () => {
  const { mark, tag } = marksFor('bestOfNCut')
  const pidFile = join(dir, 'bon-cut.pid')
  const w = await watching(mark)
  const t0 = Date.now()
  const r = await runTests(dir, bestOfN(program('bon-cut', pidFile, 0, true, tag)), 3000)
  const ms = Date.now() - t0
  const pid = await pidIn(pidFile, 1000)
  return { passed: r.passed, total: r.total, refused: r.refused ?? null, ms, pid, seenMarked: await sawIt(w, pid), gone: pid ? await goneWithin(pid, mark) : null }
})

// The test run's shell is cmd.exe on Windows (toolExec's default), so the program a run starts on
// purpose, outside node's own children, is started through Windows PowerShell's Start-Process. It
// waits two minutes and carries `tag`.
const startOutside = (pidOut: string, tag: string): string =>
  `powershell -NoProfile -NonInteractive -Command "Start-Process -WindowStyle Hidden -PassThru node -ArgumentList '-e','setTimeout(()=>{},120000)/*${tag}*/' | ForEach-Object { ${pidOut} }"`

await step('bestOfNNatural', async () => {
  const { mark, tag } = marksFor('bestOfNNatural')
  const r = await runTests(dir, bestOfN(startOutside("'pid=' + $_.Id", tag)), 20_000)
  const pid = Number(/pid=(\d+)/.exec(r.output)?.[1]) || null
  await new Promise(res => setTimeout(res, 500))
  return { refused: r.refused ?? null, pid, aliveAfter: pid ? isMarked(pid, mark) : null, output: r.output.slice(0, 300) }
})

await step('bestOfNOverflow', async () => {
  const { mark, tag } = marksFor('bestOfNOverflow')
  const pidFile = join(dir, 'bon-overflow.pid')
  // 6 MiB against the run's 5 MiB buffer, after a program that outlives the shell is started.
  const goFile = join(dir, 'bon-overflow.go')
  const writer = program('bon-overflow', join(dir, 'bon-overflow-writer.pid'), 6 * 1024 * 1024, true, tag, goFile)
  const w = await watching(mark)
  const t0 = Date.now()
  const run = runTests(dir, bestOfN(`${startOutside(`Set-Content -LiteralPath '${pidFile}' -Value $_.Id`, tag)} & ${writer}`), 60_000)
  const opened = openOnceSeen(w, pidFile, goFile)
  const r = await run
  const ms = Date.now() - t0
  const pid = await opened
  return { refused: r.refused ?? null, ms, pid, seenMarked: await sawIt(w, pid), gone: pid ? await goneWithin(pid, mark) : null }
})

// Whatever still carries the fixture's mark (the programs left running on purpose, or a survivor of a
// defect) is ended here by that mark, never by a pid read earlier (F255; the header says why).
// Every watcher is stopped first (a second stop is the first one's answer): one a failing step left listing would
// keep this process alive after its report, and the test waiting on it.
for (const w of watchers) await w.stop().catch(() => undefined)
const endedAtEnd = endMarked(fixtureMark)
const cleanAfterEnd = await noneMarkedWithin(fixtureMark)
console.log(JSON.stringify({ ok: true, kind, engineJob: engineJob.installed, cases, endedAtEnd, cleanAfterEnd }))
