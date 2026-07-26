import { describe, expect, it } from 'bun:test'
import { bashTool, failedOutput, formatBashFailure } from '../../tools/impl/bash.js'
import { tmpdir } from 'os'

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
  // pwsh and powershell; the trailing argv is what makes this a *pytest*
  // command as far as framework detection is concerned.
  const emit = (text: string, argv: string) =>
    `node -e "process.stdout.write(Buffer.from('${Buffer.from(text).toString('base64')}','base64').toString()); process.exit(1)" ${argv}`

  it('a failing pytest run comes back without the diagnosis banner', async () => {
    const result = await bashTool.execute(
      { command: emit(PYTEST_RED_OUTPUT, 'python -m pytest tests/') },
      tmpdir(),
    )
    // A non-zero exit is still an error result — only the banner is gone.
    expect(result.isError).toBe(true)
    expect(result.output).not.toContain('[ERROR:')
    expect(result.output).toContain('2 failed, 10 passed')
  }, 20000)

  it('a failing plain script still gets the diagnosis banner', async () => {
    const result = await bashTool.execute(
      { command: emit(SCRIPT_CRASH_OUTPUT, 'python myscript.py') },
      tmpdir(),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('[ERROR: runtime]')
  }, 20000)
})
