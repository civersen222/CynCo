import { describe, expect, it } from 'bun:test'
import { bashTool, failedOutput, formatBashFailure } from '../../tools/impl/bash.js'
import { getShellInfo } from '../../tools/shellInfo.js'
import { tmpdir } from 'os'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'

// A realistic red pytest run: the traceback legitimately contains the word
// AttributeError, and the process exits non-zero. Nothing here is a harness
// fault — the suite ran and reported results.
const PYTEST_RED_OUTPUT = [
  '============================= test session starts ==============================',
  'platform win32 -- Python 3.11.5, pytest-8.0.0, pluggy-1.4.0',
  'collected 12 items',
  '',
  'tests/test_econ.py ..F.......F.                                          [100%]',
  '',
  '=================================== FAILURES ===================================',
  '_______________________________ test_build_wonder ______________________________',
  '',
  '    def test_build_wonder():',
  '        city = make_city()',
  '>       assert city.wonder.happiness == 3',
  "E       AttributeError: 'NoneType' object has no attribute 'happiness'",
  '',
  'tests/test_econ.py:42: AttributeError',
  '=========================== short test summary info ============================',
  "FAILED tests/test_econ.py::test_build_wonder - AttributeError: 'NoneType'",
  '2 failed, 10 passed in 3.1s',
].join('\n')

const SCRIPT_CRASH_OUTPUT = [
  'Traceback (most recent call last):',
  '  File "myscript.py", line 7, in <module>',
  '    print(cfg.name)',
  "AttributeError: 'NoneType' object has no attribute 'name'",
].join('\n')

describe('Bash tool', () => {
  it('has correct metadata', () => {
    expect(bashTool.name).toBe('Bash')
    expect(bashTool.tier).toBe('approval')
  })

  it('executes a command and returns stdout', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, tmpdir())
    expect(result.isError).toBe(false)
    expect(result.output.trim()).toBe('hello')
  })

  it('returns stderr on failure', async () => {
    const result = await bashTool.execute({ command: 'ls /nonexistent_dir_xyz' }, tmpdir())
    expect(result.isError).toBe(true)
  })

  it('respects timeout', async () => {
    const result = await bashTool.execute({ command: 'sleep 30', timeout: 1000 }, tmpdir())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('timeout')
  }, 10000)

  /**
   * A killed command returned the bare sentence "Error: command timeout after
   * 60000ms" and nothing else. Two of the Wave 4 agent's Bash errors were this,
   * on a target suite measured at ~52s: it had asked for 60s (the default is
   * 120s), lost the race, and got back zero information — not the partial pytest
   * report, not the fact that it may ask for up to 600s. So it had no way to tell
   * "my command hangs" from "my budget was too small", which are opposite fixes.
   */
  it('a timeout says what the budget was, that it can be raised, and how far the command got', async () => {
    const cmd = 'node -e "process.stdout.write(\'collected 12 items\'); setTimeout(()=>{},60000)"'
    const result = await bashTool.execute({ command: cmd, timeout: 1500 }, tmpdir())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('1500ms')
    expect(result.output).toContain('600000')
    expect(result.output).toContain('collected 12 items')
  }, 20000)
})

describe('failedOutput (which stream the model actually gets to see)', () => {
  // pytest writes its report to stdout. pygame/SDL, libpng, plugin warnings and
  // deprecation notices routinely write to stderr. Choosing `stderr || stdout`
  // means one line of unrelated noise hides the entire test report.
  it('keeps stdout when stderr also has content', () => {
    const out = failedOutput('hello from SDL\n', PYTEST_RED_OUTPUT, 1)
    expect(out).toContain('2 failed')
    expect(out).toContain('hello from SDL')
  })

  it('still reports stderr when stdout is empty', () => {
    expect(failedOutput('NameError: name x is not defined\n', '', 1)).toContain('NameError')
  })

  it('falls back to the exit code when both streams are empty', () => {
    expect(failedOutput('', '', 137)).toContain('137')
  })

  // Gilded I4d2b3g. Every Bash call in that run came back as the single line
  // `Command exited with code 66` — no stream, no signal, no shell named. The
  // run read that as its own mistake, rewrote the command eight times, and
  // never learned that `Write-Host "hello"` was failing too. A failure that
  // prints nothing at all is the one case where the tool must volunteer what
  // it knows, because the model has nothing else to reason from.
  it('names the shell when a failure produced no output at all', () => {
    const out = failedOutput('', '', 66, 'shell=powershell.exe, signal=none')
    expect(out).toContain('66')
    expect(out).toContain('powershell.exe')
    expect(out).toContain('no output')
  })

  it('tells the model that a no-output failure is not the command it wrote', () => {
    const out = failedOutput('', '', 66, 'shell=powershell.exe, signal=none')
    expect(out).toContain('not that the command was wrong')
  })

  it('reports the signal when the shell was killed rather than exiting', () => {
    const out = failedOutput('', '', null, 'shell=powershell.exe, signal=SIGKILL')
    expect(out).toContain('SIGKILL')
  })

  // The timeout branch reuses this to show whatever was collected before the
  // kill, and there the explanation is already known and is the opposite one:
  // the command DID run, it ran too long. Handing it "the shell failed to run
  // it" would contradict the sentence it is pasted underneath.
  it('offers no shell theory when the caller already knows why it died', () => {
    const out = failedOutput('', '', null, undefined, 'nothing')
    expect(out).toBe('nothing')
  })

  // The diagnosis banner is applied on top of failedOutput's text, and it must
  // not swallow the one message that carries the whole explanation.
  it('the no-output explanation survives formatBashFailure', () => {
    const out = formatBashFailure('python --version',
      failedOutput('', '', 66, 'shell=powershell.exe, signal=none'))
    expect(out).toContain('no output')
    expect(out).toContain('powershell.exe')
  })

  // The circuit breaker quotes the original error back through `.slice(0, 300)`,
  // and this explanation matters most in exactly the case that trips it: three
  // silent failures in a row. If it does not fit, the mechanism reacting to the
  // retry loop decapitates the one message that would have ended it.
  it('fits inside the 300 characters the circuit breaker quotes back', () => {
    const out = formatBashFailure('python --version',
      failedOutput('', '', 66, 'shell=powershell.exe, signal=none'))
    expect(out.slice(0, 300)).toContain('not that the command was wrong')
  })

  it('a red pytest run with stderr noise is not mistaken for a runtime error', () => {
    const out = failedOutput('libpng warning: iCCP known incorrect sRGB profile\n', PYTEST_RED_OUTPUT, 1)
    expect(out).not.toContain('[ERROR:')
  })
})

describe('formatBashFailure (no diagnosis banner on test-runner output)', () => {
  it('returns red pytest output verbatim — no [ERROR: runtime] banner', () => {
    const out = formatBashFailure('python -m pytest tests/ -q', PYTEST_RED_OUTPUT)
    expect(out).not.toContain('[ERROR:')
    expect(out).toBe(PYTEST_RED_OUTPUT)
  })

  it('still diagnoses a genuine crash from a non-test command', () => {
    const out = formatBashFailure('python myscript.py', SCRIPT_CRASH_OUTPUT)
    expect(out).toContain('[ERROR: runtime]')
    expect(out).toContain(SCRIPT_CRASH_OUTPUT)
  })

  it('still diagnoses a pytest command that never ran a suite (collection error)', () => {
    const collectionError = [
      'ImportError while loading conftest',
      'ModuleNotFoundError: No module named "gilded"',
      'errors during collection',
    ].join('\n')
    const out = formatBashFailure('python -m pytest tests/', collectionError)
    expect(out).toContain('[ERROR:')
  })

  it('returns red vitest output verbatim', () => {
    const vitestRed = [
      'FAIL  engine/__tests__/foo.test.ts > does a thing',
      "TypeError: Cannot read properties of undefined (reading 'x')",
      ' Test Files  1 failed | 20 passed (21)',
      '      Tests  2 failed | 130 passed (132)',
    ].join('\n')
    const out = formatBashFailure('npx vitest run', vitestRed)
    expect(out).not.toContain('[ERROR:')
  })
})

describe('Bash tool banner suppression (end to end)', () => {
  // The output is base64-carried so the same command string is valid in bash,
  // pwsh and powershell.
  const emit = (text: string) =>
    `node -e "process.stdout.write(Buffer.from('${Buffer.from(text).toString('base64')}','base64').toString()); process.exit(1)"`

  /**
   * A directory whose `npm test` fails with the given output.
   *
   * This used to be `node -e "…" python -m pytest tests/` — the trailing argv
   * ran nothing and existed only so that a substring search for "pytest" would
   * find one. That search was the defect: it also found the word in `rg -n
   * pytest docs/brief.md` and in a commit message, and invented a test result
   * from each. Detection is anchored at command position now, so the fixture
   * has to name a runner where a runner actually goes. `npm test` is one, it
   * needs nothing installed, and the command really does run and really does
   * exit non-zero.
   */
  function npmTestDir(output: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'banner-e2e-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'banner-e2e', version: '1.0.0', private: true,
      scripts: { test: emit(output) },
    }))
    return dir
  }

  it('a failing test run comes back without the diagnosis banner', async () => {
    const result = await bashTool.execute({ command: 'npm test' }, npmTestDir(PYTEST_RED_OUTPUT))
    // A non-zero exit is still an error result — only the banner is gone.
    expect(result.isError).toBe(true)
    expect(result.output).not.toContain('[ERROR:')
    expect(result.output).toContain('2 failed, 10 passed')
  }, 60000)

  it('a failing plain script still gets the diagnosis banner', async () => {
    const result = await bashTool.execute({ command: emit(SCRIPT_CRASH_OUTPUT) }, tmpdir())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('[ERROR: runtime]')
  }, 20000)
})

describe('Bash tool — redirecting the model to the purpose-built tool', () => {
  it('a successful file read carries the Read hint and every byte of output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-hint-'))
    const file = join(dir, 'sample.py')
    writeFileSync(file, 'def alpha():\n    return 1\n')

    const result = await bashTool.execute({ command: `Get-Content "${file}"` }, dir)

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Read tool')
    expect(result.output).toContain('def alpha()')
  }, 20000)

  it('a real command gets no hint at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-hint-'))
    const result = await bashTool.execute({ command: 'echo done' }, dir)
    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('Note: prefer')
  }, 20000)
})

/**
 * The unit tests in shellInfo.test.ts prove the translation; this proves it is
 * wired in. Deliberately not conditioned on the host shell: the POSIX env prefix
 * is what briefs are written with, and after this change it has to work on every
 * shell CynCo runs on — natively on bash, by translation on either PowerShell.
 */
describe('Bash tool — a POSIX env-var prefix runs instead of being refused', () => {
  // No `||` in here, deliberately. The first version of this probe read
  // `process.env.X || 'unset'` and came back refused: the operator scan is
  // textual and does not know that `||` inside a quoted JS argument is not a
  // shell operator. That direction of error is the safe one — it falls through
  // to the instructive message rather than mistranslating — but it is a real
  // limit worth pinning here so nobody reads a future failure as a regression.
  const readVar = 'node -e "process.stdout.write(String(process.env.CYNCO_PROBE))"'

  it('sets the variable for the command', async () => {
    const result = await bashTool.execute({ command: `CYNCO_PROBE=hello ${readVar}` }, tmpdir())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  }, 20000)

  it('still refuses — with the rewrite named — when a second command follows', async () => {
    const result = await bashTool.execute(
      { command: `CYNCO_PROBE=hello ${readVar}; echo after` },
      tmpdir(),
    )
    if (getShellInfo().isPowerShell) {
      expect(result.isError).toBe(true)
      expect(result.output).toContain('$env:CYNCO_PROBE="hello"')
    } else {
      expect(result.isError).toBe(false)
    }
  }, 20000)
})
