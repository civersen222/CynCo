/**
 * A test or a fixture ends a process only through the object that started it or through a mark (F255).
 *
 * On 2026-11-25 one test of the suite failed with exit status 1 and nothing printed, once in eight runs: the last
 * line of a fixture ended "what was left" of nine pids by number, seven of them of processes it had already seen
 * gone, and Windows had given one of those numbers to another test's Python meanwhile. The idiom ("is something
 * alive at this number? then end it", or "end every pid this file saw, at the end") had been copied into about
 * fifteen tests and fixtures, and nothing said a test may not do that.
 *
 * This guard reads every test and fixture under `engine/`, `scripts/`, `tui/tests` and `jlens/tests`:
 *
 *   - a CALL that ends a process by number (`process.kill(x)` with no signal or one that ends, `killProcessTree`,
 *     `killProcessTreeSync`, a started `taskkill`) must be in `CALLS` below, file by file, with how many there are
 *     and why each one's target cannot be another process. A question (`process.kill(x, 0)`) is not a terminate,
 *     but it is no answer about a program either: `helpers/markedProcesses.ts` says why;
 *   - a command TEXT that names a terminate (`taskkill`, `Stop-Process`, `kill -9`, `pkill`, `.Kill()`,
 *     `os.kill(`) inside a string must have its file in `TEXTS` with why none of them reaches a process that is
 *     not the test's own. There is no count: such texts are mostly expectations and inputs, and the reason is
 *     about the file.
 *
 * A new terminate fails here until it goes through `helpers/markedProcesses.ts` or `ChildProcess.kill()`, or is
 * classified with a reason someone can check. An entry that no longer matches the file fails too, so the table
 * cannot go stale.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Calls that end a process by number: file, pattern, how many, and why each target is the caller's own. */
const CALLS: Record<string, Partial<Record<CallPattern, { count: number; why: string }>>> = {
  'engine/__tests__/helpers/markedProcesses.ts': {
    'process.kill': { count: 1, why: 'the helper itself, off Windows: SIGKILL to the pids `pgrep -f <mark>` listed a moment before; on Windows it ends through an opened, checked process, never by number' },
  },
  'engine/__tests__/containment.test.ts': {
    'process.kill': { count: 1, why: 'ends the Git namespace holder this test made the module start: the module holds its ChildProcess with the exit unhandled, which keeps the number its own, and the kill is in the same turn as the read of the pid' },
  },
  'engine/__tests__/processTree.test.ts': {
    killProcessTree: { count: 2, why: 'the primitive under test: once on the test\'s own parent, a ChildProcess it holds and asserts unhandled just before (stillHeld), and once on a pid no process can have (2,000,000,000) for the "already gone" answer' },
  },
  'engine/__tests__/fixtures/ownedTreeBurst.ts': {
    killProcessTree: { count: 1, why: 'the walk mode of the burst measurement (F210): the fixture\'s own exec child, which exec still holds unhandled when the kill is issued' },
  },
}

/** Files whose string literals name a terminate, and why none of them reaches a process that is not the test's own. */
const TEXTS: Record<string, string> = {
  'engine/__tests__/helpers/markedProcesses.ts': 'the helper: `.Kill()` on a process it opened and checked against the listing\'s creation time',
  'engine/__tests__/guards/testsEndOnlyMarked.test.ts': 'this guard: its messages, its needles on the helper\'s text and the sample source its own cases read; it starts nothing',
  'engine/__tests__/containment.test.ts': 'a source pin: the containment module and the launcher must not contain the word; nothing is run',
  'engine/__tests__/guards/containmentWiring.test.ts': 'needles on source text and lifted dispatch script texts whose `taskkill` and `kill` are bash functions that only record (the file\'s own BYPASS scan refuses a form that would reach the real ones, and its made-up pids must never reach them); the one case run for real ends, once, the bun it started itself and whose pid the lifted confirmation had just confirmed',
  'engine/__tests__/llama/processManager.test.ts': 'the netstat text, the log lines and the injected kill of the port-sweep cases, and the expected `taskkill` of the stop() fallback cases: the listing and the kill are injected, and stop()\'s `execSync` is replaced on the shared `child_process` module for the synchronous part only, with a child object of the test\'s own; the port serves nothing and every pid is a number no process can have',
  'scripts/__tests__/cynco-services-select.test.mjs': 'needles on the services script\'s stop line (`$h.Kill()` through a handle opened and checked against the listed creation time); the one line run for real is that line, lifted, against a node waiter this file started, holds with its exit unhandled (the run is synchronous) and marks; cleanup is `ChildProcess.kill()` and `endMarked`',
  'engine/__tests__/processTree.test.ts': 'expectations on the log line of the tree kill and on source text; the kills themselves are the two calls classified above',
  'engine/__tests__/tools/protectedPaths.test.ts': 'command texts handed to the path check, which reads a command and runs nothing',
}

type CallPattern = 'process.kill' | 'killProcessTree' | 'taskkill started'

/**
 * For each character of a JavaScript or TypeScript text: `c` code, `s` inside a string or template literal, `m`
 * inside a comment, `x` inside a regular-expression literal. Enough of a reading to tell a call from its mention.
 */
export function kinds(text: string): string {
  const n = text.length
  const out = new Array<string>(n).fill('c')
  const mark = (from: number, to: number, k: string): void => { for (let j = from; j < to && j < n; j++) out[j] = k }
  /** `i` at an opening backtick: the index just past its closing one. */
  const template = (i: number): number => {
    i++
    while (i < n) {
      const c = text[i]
      if (c === '\\') { i += 2; continue }
      if (c === '`') return i + 1
      if (c === '$' && text[i + 1] === '{') {
        i += 2
        let depth = 1
        while (i < n && depth > 0) {
          const d = text[i]
          if (d === '`') { i = template(i); continue }
          if (d === '\'' || d === '"') { i = quoted(i); continue }
          if (d === '{') depth++
          else if (d === '}') depth--
          i++
        }
        continue
      }
      i++
    }
    return n
  }
  /** `i` at an opening quote: the index just past its closing one (or the line's end). */
  const quoted = (i: number): number => {
    const q = text[i]
    i++
    while (i < n && text[i] !== q && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
    return Math.min(n, i + 1)
  }
  let i = 0
  let before = ''   // the last code character that is not white space: what tells a regular expression from a division
  let word = ''     // the identifier that ends at `before`, if any
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') { const end = text.indexOf('\n', i); const to = end === -1 ? n : end; mark(i, to, 'm'); i = to; continue }
    if (c === '/' && next === '*') { const end = text.indexOf('*/', i + 2); const to = end === -1 ? n : end + 2; mark(i, to, 'm'); i = to; continue }
    if (c === '\'' || c === '"') { const to = quoted(i); mark(i, to, 's'); i = to; before = c; word = ''; continue }
    if (c === '`') { const to = template(i); mark(i, to, 's'); i = to; before = c; word = ''; continue }
    if (c === '/' && (before === '' || '(,=:[!&|?{};+-*%<>~^'.includes(before) || ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'void'].includes(word))) {
      let j = i + 1
      let inClass = false
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) break
        j++
      }
      if (j < n && text[j] === '/') { mark(i, j + 1, 'x'); i = j + 1; before = '/'; word = ''; continue }
    }
    if (!/\s/.test(c)) {
      word = /[A-Za-z_$]/.test(c) ? (/[A-Za-z0-9_$]/.test(before) && text[i - 1] === before ? word + c : c) : ''
      before = c
    }
    i++
  }
  return out.join('')
}

/** The arguments of the call whose opening parenthesis is at `open`, split at its own commas; null when it does not close. */
export function callArgs(text: string, open: number): string[] | null {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        const last = text.slice(start, i).trim()
        if (last !== '' || args.length > 0) args.push(last)
        return args
      }
    } else if (c === ',' && depth === 1) { args.push(text.slice(start, i).trim()); start = i + 1 }
  }
  return null
}

const TEXT_TERMINATE = /\btaskkill(?:\.exe)?\b|\bStop-Process\b|\b(?:pkill|killall)\b|\bkill\s+-(?:9|KILL)\b|\.Kill\(\)|\bTerminateProcess\b|\bos\.kill\(/g

/** What one JavaScript or TypeScript source holds: the calls that end by number, and whether a string names a terminate. */
export function terminatesIn(text: string): { calls: Record<CallPattern, number[]>; texts: number[] } {
  const k = kinds(text)
  const inCode = (index: number): boolean => k[index] === 'c'
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length
  const calls: Record<CallPattern, number[]> = { 'process.kill': [], killProcessTree: [], 'taskkill started': [] }
  for (const m of text.matchAll(/\bprocess\.kill\(/g)) {
    if (!inCode(m.index)) continue
    const args = callArgs(text, m.index + m[0].length - 1)
    // A question, not a terminate: signal 0.
    if (args && args.length === 2 && args[1] === '0') continue
    calls['process.kill'].push(lineOf(m.index))
  }
  for (const m of text.matchAll(/\bkillProcessTree(?:Sync)?\(/g)) {
    // A declaration or an import is not a call; neither is a property that happens to carry the name.
    if (!inCode(m.index) || /(?:function|\.)\s*$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    calls.killProcessTree.push(lineOf(m.index))
  }
  for (const m of text.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*(['"`])taskkill(?:\.exe)?\1/g)) {
    if (inCode(m.index)) calls['taskkill started'].push(lineOf(m.index))
  }
  const texts: number[] = []
  for (const m of text.matchAll(TEXT_TERMINATE)) if (k[m.index] === 's') texts.push(lineOf(m.index))
  return { calls, texts }
}

/** A Python test: a terminate by number or by name. `Popen.terminate()` and `.kill()` go through a held process and are not listed. */
export function pythonTerminatesIn(text: string): number[] {
  const lines: number[] = []
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/#.*$/, '')
    if (/\bos\.kill\(|\btaskkill\b|\bpkill\b|\bkillall\b|\bpsutil\b.*\.(?:kill|terminate)\(/.test(code)) lines.push(i + 1)
  })
  return lines
}

const SKIP = new Set(['node_modules', '.git', 'cybernetics-core', 'dist', '.venv', 'venv', '__pycache__', '.pytest_cache'])
function walk(dir: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name), out) } else out.push(join(dir, e.name))
  }
  return out
}
const rel = (file: string): string => relative(ROOT, file).split(sep).join('/')
const isScriptTest = (r: string): boolean => /\.(ts|mjs|js|cjs)$/.test(r) && (/(^|\/)__tests__\//.test(r) || /\.test\.(ts|mjs|js)$/.test(r))
const isPythonTest = (r: string): boolean => /\.py$/.test(r) && /(^|\/)tests?\//.test(r)

/** Python tests that name a terminate, and why it is the test's own (or a stub). */
const PYTHON: Record<string, string> = {
  'tui/tests/test_project_picker.py': 'the picker\'s listing, image reading and kill are patched: the cases assert which `taskkill` the picker WOULD start, and none is started',
}

describe('tests and fixtures end only what is theirs (F255)', () => {
  const found = (() => {
    const calls: Record<string, Partial<Record<CallPattern, number[]>>> = {}
    const texts: Record<string, number[]> = {}
    const python: Record<string, number[]> = {}
    for (const top of ['engine', 'scripts']) {
      for (const file of walk(join(ROOT, top))) {
        const r = rel(file)
        if (!isScriptTest(r)) continue
        const t = terminatesIn(readFileSync(file, 'utf-8'))
        for (const [name, lines] of Object.entries(t.calls) as Array<[CallPattern, number[]]>) {
          if (lines.length > 0) (calls[r] ??= {})[name] = lines
        }
        if (t.texts.length > 0) texts[r] = t.texts
      }
    }
    for (const top of ['tui', 'jlens', 'scripts']) {
      for (const file of walk(join(ROOT, top))) {
        const r = rel(file)
        if (!isPythonTest(r)) continue
        const lines = pythonTerminatesIn(readFileSync(file, 'utf-8'))
        if (lines.length > 0) python[r] = lines
      }
    }
    return { calls, texts, python }
  })()

  it('every call that ends a process by number is classified, with its count', () => {
    const problems: string[] = []
    for (const [file, patterns] of Object.entries(found.calls)) {
      for (const [name, lines] of Object.entries(patterns) as Array<[CallPattern, number[]]>) {
        const entry = CALLS[file]?.[name]
        if (!entry) problems.push(`${file}: ${lines.length} ${name} call(s) at line ${lines.join(', ')} end a process by number. End it through the ChildProcess that started it or through engine/__tests__/helpers/markedProcesses.ts, or classify it in CALLS with why its target cannot be another process (F255)`)
        else if (entry.count !== lines.length) problems.push(`${file}: CALLS says ${entry.count} ${name} call(s), the file has ${lines.length} (line ${lines.join(', ')}): classify the new one, or correct the count`)
      }
    }
    for (const [file, patterns] of Object.entries(CALLS)) {
      for (const name of Object.keys(patterns) as CallPattern[]) {
        if (!found.calls[file]?.[name]) problems.push(`${file}: CALLS lists ${name}, and the file has none any more: take the entry out`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('every file whose command texts name a terminate says why none of them reaches another process', () => {
    const problems: string[] = []
    for (const [file, lines] of Object.entries(found.texts)) {
      if (!TEXTS[file]) problems.push(`${file}: a string names a terminate (line ${lines.slice(0, 8).join(', ')}${lines.length > 8 ? ', ...' : ''}). If a test runs it, it must end only what carries the test's own mark; say in TEXTS why none of these reaches a process that is not the test's own (F255)`)
    }
    for (const file of Object.keys(TEXTS)) if (!found.texts[file]) problems.push(`${file}: TEXTS lists it, and no string in it names a terminate any more: take the entry out`)
    for (const [file, lines] of Object.entries(found.python)) {
      if (!PYTHON[file]) problems.push(`${file}: line ${lines.join(', ')} names a terminate by number or by name. End through the process object the test holds, or say in PYTHON why it is the test's own (F255)`)
    }
    for (const file of Object.keys(PYTHON)) if (!found.python[file]) problems.push(`${file}: PYTHON lists it, and it names no terminate any more: take the entry out`)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('the helper is where a marked program is ended, and it ends nothing by number on Windows', () => {
    const helper = readFileSync(join(ROOT, 'engine/__tests__/helpers/markedProcesses.ts'), 'utf-8')
    // Opened, checked against the listing's creation time, ended through that handle.
    expect(helper).toContain('[System.Diagnostics.Process]::GetProcessById(')
    expect(helper).toContain('[void]$p.Handle')
    expect(helper).toContain('$p.Kill()')
    expect(helper).not.toContain('Stop-Process')
    expect(helper).not.toContain('taskkill')
  })
})

describe('the reading the guard rests on', () => {
  it('a call in code is found; the same words in a comment, a string or a regular expression are not a call', () => {
    const src = [
      'const a = 1 // process.kill(pid) in a comment',
      '/* killProcessTree(pid) in a block comment */',
      'const s = "process.kill(pid)"',
      'const t = `taskkill /F /PID ${pid}`',
      'const r = /process\\.kill\\(/',
      'process.kill(pid)',
      'process.kill(pid, 0)',
      'process.kill(Number(readFileSync(f, "utf-8")))',
      'process.kill(pid, "SIGKILL")',
      'await killProcessTree(pid, () => {})',
      'killProcessTreeSync(n)',
      'spawnSync("taskkill", ["/PID", String(pid)])',
      'expect(fn.indexOf("spawnSync(\'taskkill\'")).toBe(1)',
      'export function killProcessTree(pid) {}',
    ].join('\n')
    const t = terminatesIn(src)
    expect(t.calls['process.kill']).toEqual([6, 8, 9])
    expect(t.calls.killProcessTree).toEqual([10, 11])
    expect(t.calls['taskkill started']).toEqual([12])
    // The command text in the template literal, and the needle inside a string.
    expect(t.texts).toEqual([4, 12, 13])
  })

  it('kinds: strings, templates with nested expressions, comments and regular expressions are told from code', () => {
    const src = 'a = `x ${b ? `y ${c}` : "z"} w`; d = e / f; g = /h\'i/.test(j); // k\'l\nm = \'n\''
    const k = kinds(src)
    const at = (needle: string): string => k[src.indexOf(needle)]
    expect(at('x $')).toBe('s')
    expect(at('y $')).toBe('s')
    expect(at(' w`')).toBe('s')
    expect(at('d = e')).toBe('c')
    expect(at('/ f')).toBe('c')
    expect(at('h\'i')).toBe('x')
    expect(at('.test(j)')).toBe('c')
    expect(at('k\'l')).toBe('m')
    expect(at('m = ')).toBe('c')
    expect(at('n\'')).toBe('s')
  })

  it('callArgs splits a call at its own commas only', () => {
    const src = 'f(a, g(b, c), "d, e", [h, i])'
    expect(callArgs(src, 1)).toEqual(['a', 'g(b, c)', '"d, e"', '[h, i]'])
    expect(callArgs('f()', 1)).toEqual([])
    expect(callArgs('f(a', 1)).toBeNull()
  })

  it('a Python test: os.kill and taskkill are listed, a comment and a Popen kill are not', () => {
    expect(pythonTerminatesIn('p.terminate()\nos.kill(pid, 9)\n# os.kill(pid)\nsubprocess.run(["taskkill", "/PID", pid])\np.kill()')).toEqual([2, 4])
  })
})
