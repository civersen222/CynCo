import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LSPManager } from '../../lsp/manager.js'
import { setContainmentFaultSink } from '../../audit/toolAudit.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
const folder = () => { const d = mkdtempSync(join(tmpdir(), 'cynco-lsp-')); dirs.push(d); return d }
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

// NOW.md, 2026-11-24: py_compile got the file name inside a shell string, so the shell read it
// (cmd expands `%NAME%` even inside quotes; a POSIX shell a `$(...)`), and its `2>&1` left stderr an
// empty string, which `stderr ?? stdout` took, so no Python error ever reached the model.
describe('LSPManager: Python diagnostics pass the file as one argument', () => {
  it('a syntax error is reported with the compiler\'s own message', async () => {
    const d = folder()
    const file = join(d, 'bad.py')
    writeFileSync(file, 'def (:\n')
    const diags = await new LSPManager(d).getDiagnostics(file)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ file, severity: 'error', source: 'python' })
    expect(diags[0].message).toMatch(/SyntaxError|invalid syntax/)
  }, 30000)

  it('a file name holding shell syntax is compiled under its own name', async () => {
    const d = folder()
    const name = process.platform === 'win32' ? 'a%OS%b.py' : 'a$(echo x)b.py'
    const file = join(d, name)
    writeFileSync(file, 'x = 1\n')
    expect(await new LSPManager(d).getDiagnostics(file)).toEqual([])
    // py_compile wrote the byte code of the file it was given, by that file's own name.
    const cache = join(d, '__pycache__')
    expect(existsSync(cache) ? readdirSync(cache).some(n => n.startsWith(name.slice(0, -3) + '.')) : false,
      `no byte code for ${name}: ${existsSync(cache) ? readdirSync(cache).join(', ') : 'no __pycache__'}`).toBe(true)
  }, 30000)
})

// The diagnostics command owns its tree and ends it at its cap (NOW.md, 2026-11-24). A py_compile.py
// planted in the folder is what `python -m py_compile` imports (the reason it is workspace code): this
// one starts a grandchild, writes its pid and hangs; at the 10 s cap the grandchild must be gone.
describe('LSPManager: a diagnostics command cut at its cap ends what it started', () => {
  it('the grandchild of a hung py_compile is gone after the cap', async () => {
    const d = folder()
    const pidFile = join(d, 'grandchild.pid')
    writeFileSync(join(d, 'py_compile.py'), [
      'import subprocess, sys, time',
      `p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(4000)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)`,
      `open(${JSON.stringify(pidFile)}, 'w').write(str(p.pid))`,
      // What a cut command printed is not a diagnostic of the file.
      'sys.stderr.write("not a diagnostic\\n"); sys.stderr.flush()',
      'time.sleep(4000)',
      '',
    ].join('\n'))
    const file = join(d, 'ok.py')
    writeFileSync(file, 'x = 1\n')
    const started = Date.now()
    const diags = await new LSPManager(d).getDiagnostics(file)
    expect(Date.now() - started).toBeLessThan(25_000)
    expect(diags).toEqual([])
    const pid = Number(readFileSync(pidFile, 'utf-8'))
    expect(pid).toBeGreaterThan(0)
    const until = Date.now() + 5000
    while (alive(pid) && Date.now() < until) await new Promise(res => setTimeout(res, 100))
    const survived = alive(pid)
    if (survived) process.kill(pid)
    expect(survived, `python ${pid}, started by the diagnostics command, outlived its cap`).toBe(false)
  }, 40000)
})

// Wave 15b, checks C4-8 and C4-9: why a diagnostics command did not start is said by name, and only a
// containment refusal is a containment fault.
describe('LSPManager: a diagnostics command that cannot start', () => {
  function logged(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = []
    const log = console.log
    const err = console.error
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
    return fn().then(() => lines, e => { throw e }).finally(() => { console.log = log; console.error = err })
  }

  it('a start that throws for a reason other than containment gives no diagnostics and raises no containment fault', async () => {
    const d = folder()
    const faults: Array<[string, string]> = []
    setContainmentFaultSink((layer, reason) => { faults.push([layer, reason]) })
    try {
      let diags: unknown
      // A NUL in an argument makes the start throw at once (ERR_INVALID_ARG_VALUE): not a refusal of
      // the box, and in a contained run it must not end the mission as one.
      const lines = await logged(async () => { diags = await new LSPManager(d).getDiagnostics(join(d, 'a\u0000b.py')) })
      expect(diags).toEqual([])
      expect(faults).toEqual([])
      expect(lines.some(l => l.startsWith('[lsp] diagnostics not run: ') && /null bytes|ERR_INVALID_ARG_VALUE|must be a string without null/.test(l)), lines.join('\n')).toBe(true)
    } finally {
      setContainmentFaultSink(null)
    }
  }, 30000)

  it('a python that cannot be started (on Windows a .cmd shim, which a start without a shell cannot run) is named once in the log', async () => {
    const d = folder()
    const shims = folder()
    // Elsewhere the folder is left empty: no python at all, the same failure to start.
    if (process.platform === 'win32') writeFileSync(join(shims, 'python.cmd'), '@echo off\r\nexit /b 0\r\n')
    const file = join(d, 'ok.py')
    writeFileSync(file, 'x = 1\n')
    const path = process.env.PATH
    process.env.PATH = shims
    try {
      const mgr = new LSPManager(d)
      const lines = await logged(async () => {
        expect(await mgr.getDiagnostics(file)).toEqual([])
        expect(await mgr.getDiagnostics(file)).toEqual([])
      })
      const named = lines.filter(l => l.startsWith('[lsp] python could not be started'))
      expect(named, lines.join('\n')).toHaveLength(1)
      expect(named[0]).toContain('ENOENT')
    } finally {
      process.env.PATH = path
    }
  }, 30000)
})

describe('LSPManager', () => {
  it('detects available language servers', () => {
    const mgr = new LSPManager(process.cwd())
    const available = mgr.detectAvailable()
    // On this system, TypeScript server should be available
    expect(Array.isArray(available)).toBe(true)
  })

  it('collects diagnostics from file save', async () => {
    const mgr = new LSPManager(process.cwd())
    // Not a stub: for a .ts path this runs `npx tsc --noEmit` over the whole
    // repository (manager.ts getTypeScriptDiagnostics, 15 s cap), which takes
    // 5-7 s on a quiet machine and longer under the suite's load. The default
    // 5 s test timeout was the failure on Linux CI and the flake on Windows.
    const diags = await mgr.getDiagnostics('test.ts')
    expect(Array.isArray(diags)).toBe(true)
  }, 30000)

  it('formats diagnostics for model context', () => {
    const mgr = new LSPManager(process.cwd())
    const formatted = mgr.formatForModel([
      { file: 'src/app.ts', line: 10, column: 5, severity: 'error', message: "Cannot find name 'foo'", source: 'typescript' },
    ])
    expect(formatted).toContain('error')
    expect(formatted).toContain('app.ts')
    expect(formatted).toContain('foo')
  })
})
