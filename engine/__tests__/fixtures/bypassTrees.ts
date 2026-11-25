/**
 * Run under Bun on Windows by `engine/__tests__/bypassTreesJob.test.ts` (wave 15b, check C4-3 and
 * C4-5). The sites that start a process without the executor (a contract check through
 * `runCommandDetailed`, LSP diagnostics) own their tree from the start; under Bun that is a Job
 * Object, the path every engine on this PC takes, which vitest's Node never does (it finds the tree
 * when it kills it). Each case asks by pid what is left:
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

const dir = process.argv[2]
if (!dir || !existsSync(dir)) {
  console.log(JSON.stringify({ ok: false, error: `the fixture needs an existing folder, got ${dir}` }))
  process.exit(2)
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const waitGone = async (pid: number, ms = 5000): Promise<boolean> => {
  const until = Date.now() + ms
  while (alive(pid) && Date.now() < until) await new Promise(r => setTimeout(r, 100))
  return !alive(pid)
}
const pidIn = async (file: string, ms = 15_000): Promise<number | null> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(file)) { const n = Number(readFileSync(file, 'utf-8').trim()); if (Number.isInteger(n) && n > 0) return n }
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}
/** A node program that starts a grandchild running forever, writes its pid to `pidFile`, prints `bytes` and waits. */
function program(name: string, pidFile: string, bytes: number, stay: boolean): string {
  const file = join(dir, `${name}.js`)
  writeFileSync(file, [
    "const { spawn } = require('child_process')",
    "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
    `const b = 'x'.repeat(1 << 16); let left = ${bytes}`,
    'const more = () => { while (left > 0) { left -= b.length; if (!process.stdout.write(b)) return process.stdout.once(\'drain\', more) } }',
    'more()',
    stay ? 'setInterval(() => {}, 1000)' : "c.unref(); process.exit(0)",
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
const leftovers: number[] = []

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { cases[name] = await fn() } catch (e) { cases[name] = { threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } }
}

await step('contractCut', async () => {
  const pidFile = join(dir, 'cut.pid')
  const r = await runCommandDetailed(dir, program('cut', pidFile, 0, true), 3000)
  const pid = await pidIn(pidFile, 1000)
  if (pid) leftovers.push(pid)
  return { outcome: r.outcome, pid, gone: pid ? await waitGone(pid) : null }
})

await step('contractNatural', async () => {
  // A background program the check started on purpose, as the vitest case starts it (a node child
  // of a node program would not do: node ends the children it did not detach when it exits, and a
  // detached one leaves the job). Ending on its own, the check gives the handle back and kills nothing.
  const cmd = getShellInfo().isPowerShell
    ? 'Start-Process -WindowStyle Hidden -PassThru node -ArgumentList \'-e\',\'setTimeout(()=>{},20000)\' | ForEach-Object { \'pid=\' + $_.Id }'
    : 'node -e "setTimeout(()=>{},20000)" > /dev/null 2>&1 & echo pid=$!'
  const r = await runCommandDetailed(dir, cmd, 20_000)
  const pid = Number(/pid=(\d+)/.exec(r.tail)?.[1]) || null
  if (pid) leftovers.push(pid)
  await new Promise(res => setTimeout(res, 500))
  return { outcome: r.outcome, pid, aliveAfter: pid ? alive(pid) : null, tail: r.tail.slice(0, 300) }
})

await step('contractOverflow', async () => {
  const pidFile = join(dir, 'overflow.pid')
  // The shell starts a program that outlives it (not a node grandchild of the writer: node ends the
  // children it did not detach when the overrun ends it, which would hide a missing tree kill), then
  // a writer prints 12 MiB against the check's 8 MiB buffer and waits: only the overflow ends it.
  const writer = program('overflow', join(dir, 'overflow-writer.pid'), 12 * 1024 * 1024, true)
  const cmd = getShellInfo().isPowerShell
    ? `Start-Process -WindowStyle Hidden -PassThru node -ArgumentList '-e','setInterval(()=>{},1000)' | ForEach-Object { Set-Content -LiteralPath '${pidFile}' -Value $_.Id }; ${writer.replace(/^node /, '& node ')}`
    : `node -e "setInterval(()=>{},1000)" > /dev/null 2>&1 & echo $! > '${pidFile}'; ${writer}`
  const r = await runCommandDetailed(dir, cmd, 60_000)
  const pid = await pidIn(pidFile, 1000)
  if (pid) leftovers.push(pid)
  return { outcome: r.outcome, ms: r.ms, pid, gone: pid ? await waitGone(pid) : null }
})

await step('lspCut', async () => {
  const lsp = join(dir, 'lsp')
  mkdirSync(lsp)
  const pidFile = join(lsp, 'grandchild.pid')
  writeFileSync(join(lsp, 'py_compile.py'), [
    'import subprocess, sys, time',
    "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(4000)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
    `open(${JSON.stringify(pidFile)}, 'w').write(str(p.pid))`,
    'time.sleep(4000)', '',
  ].join('\n'))
  writeFileSync(join(lsp, 'ok.py'), 'x = 1\n')
  const t0 = Date.now()
  const diags = await new LSPManager(lsp).getDiagnostics(join(lsp, 'ok.py'))
  const ms = Date.now() - t0
  const pid = await pidIn(pidFile, 1000)
  if (pid) leftovers.push(pid)
  return { diags, ms, pid, gone: pid ? await waitGone(pid) : null }
})

await step('lspOverflow', async () => {
  // A planted py_compile starts a program that outlives it, then prints 9 MiB against the
  // diagnostics' 8 MiB buffer and waits: only the overrun ends it, long before the 10 s cap.
  const lsp = join(dir, 'lsp-overflow')
  mkdirSync(lsp)
  const pidFile = join(lsp, 'grandchild.pid')
  writeFileSync(join(lsp, 'py_compile.py'), [
    'import subprocess, sys, time',
    "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(4000)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
    `open(${JSON.stringify(pidFile)}, 'w').write(str(p.pid))`,
    "sys.stdout.write('x' * (9 * 1024 * 1024))",
    'sys.stdout.flush()',
    'time.sleep(4000)', '',
  ].join('\n'))
  writeFileSync(join(lsp, 'ok.py'), 'x = 1\n')
  const t0 = Date.now()
  const diags = await new LSPManager(lsp).getDiagnostics(join(lsp, 'ok.py'))
  const ms = Date.now() - t0
  const pid = await pidIn(pidFile, 1000)
  if (pid) leftovers.push(pid)
  return { diags: diags.length, ms, pid, gone: pid ? await waitGone(pid) : null }
})

await step('lspTscOverflow', async () => {
  // Wave 19, check C4-3: tsc's form. A planted npx, put first on PATH for this step, starts a
  // program that outlives it, then prints 9 MiB of TypeScript error lines against the 8 MiB buffer
  // and waits. The lines read before the overrun are diagnostics (a broken build is not reported
  // clean), and the tree is still ended.
  const lsp = join(dir, 'lsp-tsc-overflow')
  mkdirSync(lsp)
  const pidFile = join(lsp, 'grandchild.pid')
  writeFileSync(join(lsp, 'tsc-stand-in.js'), [
    "const { spawn } = require('child_process')",
    "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
    // 59 bytes a line: a cut exactly at the 8 MiB buffer lands 47 bytes into a line, inside its message.
    "const line = 'src/f.ts(1,1): error TS1005: a stand-in error xxxxxxxxxxx.\\n'",
    'const b = line.repeat(1024); let left = 9 * 1024 * 1024',
    'const more = () => { while (left > 0) { left -= b.length; if (!process.stdout.write(b)) return process.stdout.once(\'drain\', more) } }',
    'more()',
    'setInterval(() => {}, 1000)', '',
  ].join('\n'))
  writeFileSync(join(lsp, 'npx.cmd'), '@node "%~dp0tsc-stand-in.js"\r\n')
  writeFileSync(join(lsp, 'f.ts'), 'export const x = 1\n')
  // First on PATH for this step only: cmd does not look in the working folder when
  // NoDefaultCurrentDirectoryInExePath is set (it is, in the shells this suite runs from: measured).
  const path = process.env.PATH
  process.env.PATH = `${lsp};${path ?? ''}`
  const t0 = Date.now()
  let diags: Awaited<ReturnType<LSPManager['getDiagnostics']>>
  try {
    diags = await new LSPManager(lsp).getDiagnostics(join(lsp, 'f.ts'))
  } finally {
    process.env.PATH = path
  }
  const ms = Date.now() - t0
  const pid = await pidIn(pidFile, 1000)
  if (pid) leftovers.push(pid)
  const cut = diags.filter(d => d.message !== 'a stand-in error xxxxxxxxxxx.').map(d => d.message)
  return { diags: diags.length, first: diags[0]?.message ?? null, cut, ms, pid, gone: pid ? await waitGone(pid) : null }
})

const bestOfN = (command: string) => ({ available: true, framework: 'pytest', command })

await step('bestOfNCut', async () => {
  const pidFile = join(dir, 'bon-cut.pid')
  const t0 = Date.now()
  const r = await runTests(dir, bestOfN(program('bon-cut', pidFile, 0, true)), 3000)
  const ms = Date.now() - t0
  const pid = await pidIn(pidFile, 1000)
  if (pid) leftovers.push(pid)
  return { passed: r.passed, total: r.total, refused: r.refused ?? null, ms, pid, gone: pid ? await waitGone(pid) : null }
})

// The test run's shell is cmd.exe on Windows (toolExec's default), so the program a run starts on
// purpose, outside node's own children, is started through Windows PowerShell's Start-Process.
const startOutside = (pidOut: string): string =>
  `powershell -NoProfile -NonInteractive -Command "Start-Process -WindowStyle Hidden -PassThru node -ArgumentList '-e','setInterval(()=>{},1000)' | ForEach-Object { ${pidOut} }"`

await step('bestOfNNatural', async () => {
  const r = await runTests(dir, bestOfN(startOutside("'pid=' + $_.Id")), 20_000)
  const pid = Number(/pid=(\d+)/.exec(r.output)?.[1]) || null
  if (pid) leftovers.push(pid)
  await new Promise(res => setTimeout(res, 500))
  return { refused: r.refused ?? null, pid, aliveAfter: pid ? alive(pid) : null, output: r.output.slice(0, 300) }
})

await step('bestOfNOverflow', async () => {
  const pidFile = join(dir, 'bon-overflow.pid')
  // 6 MiB against the run's 5 MiB buffer, after a program that outlives the shell is started.
  const writer = program('bon-overflow', join(dir, 'bon-overflow-writer.pid'), 6 * 1024 * 1024, true)
  const t0 = Date.now()
  const r = await runTests(dir, bestOfN(`${startOutside(`Set-Content -LiteralPath '${pidFile}' -Value $_.Id`)} & ${writer}`), 60_000)
  const ms = Date.now() - t0
  const pid = await pidIn(pidFile, 1000)
  if (pid) leftovers.push(pid)
  return { refused: r.refused ?? null, ms, pid, gone: pid ? await waitGone(pid) : null }
})

// Whatever is still running (the natural case's program, or a survivor of a defect) is ended here.
for (const pid of leftovers) if (alive(pid)) { try { process.kill(pid) } catch { /* gone between the two calls */ } }
console.log(JSON.stringify({ ok: true, kind, engineJob: engineJob.installed, cases }))
