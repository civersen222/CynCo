// engine/__tests__/tools/shellInfo.test.ts
import { describe, expect, it } from 'bun:test'
import { classifyShell, checkShellDialect, getShellInfo, validateVerificationCommand } from '../../tools/shellInfo.js'

describe('classifyShell', () => {
  it('non-Windows → /bin/bash, && supported', () => {
    const info = classifyShell('linux', false)
    expect(info.shell).toBe('/bin/bash')
    expect(info.supportsAndAnd).toBe(true)
    expect(info.dialectNote).toMatch(/bash/i)
  })

  it('Windows with pwsh → pwsh.exe, && supported', () => {
    const info = classifyShell('win32', true)
    expect(info.shell).toBe('pwsh.exe')
    expect(info.supportsAndAnd).toBe(true)
  })

  it('Windows without pwsh → powershell.exe, && NOT supported, note explains it', () => {
    const info = classifyShell('win32', false)
    expect(info.shell).toBe('powershell.exe')
    expect(info.supportsAndAnd).toBe(false)
    expect(info.dialectNote).toContain('&&')
    expect(info.dialectNote).toContain(';')
  })
})

describe('checkShellDialect', () => {
  const ps51 = classifyShell('win32', false)
  const pwsh = classifyShell('win32', true)
  const bash = classifyShell('linux', false)

  it('rejects && on PowerShell 5.1 with an instructive error', () => {
    const err = checkShellDialect('cd proj && python -m pytest', ps51)
    expect(err).toBeTruthy()
    expect(err).toContain('PowerShell 5.1')
    expect(err).toContain(';')
  })

  it('rejects || on PowerShell 5.1', () => {
    expect(checkShellDialect('run || echo failed', ps51)).toBeTruthy()
  })

  it('allows ; sequencing on PowerShell 5.1', () => {
    expect(checkShellDialect('cd proj; python -m pytest', ps51)).toBeNull()
  })

  it('allows && on pwsh and bash', () => {
    expect(checkShellDialect('a && b', pwsh)).toBeNull()
    expect(checkShellDialect('a && b', bash)).toBeNull()
  })

  /**
   * `NAME=value command` is a parse error in every PowerShell, and it is the
   * first thing a model reaches for — briefs are written that way. On a live
   * run the failure was silent enough that the model tried it, then the correct
   * `$env:` form (blocked at the time by the env-dump safety rule), then the
   * cmd.exe `set` form (refused by the && check), before escaping through
   * `python -c "os.environ[...]"`. Five turns to set two variables.
   */
  it('rejects a POSIX env-var prefix on PowerShell and names the replacement', () => {
    for (const info of [ps51, pwsh]) {
      const err = checkShellDialect('GILDED_NARRATE=0 SDL_VIDEODRIVER=dummy python -m pytest', info)
      expect(err).toBeTruthy()
      expect(err).toContain('$env:GILDED_NARRATE="0"')
      expect(err).toContain('$env:SDL_VIDEODRIVER="dummy"')
    }
  })

  it('leaves the POSIX env-var prefix alone on bash', () => {
    expect(checkShellDialect('FOO=1 python -m pytest', bash)).toBeNull()
  })

  it('does not mistake an ordinary argument for an env-var prefix', () => {
    expect(checkShellDialect('python -m pytest -k test_x=1', ps51)).toBeNull()
    expect(checkShellDialect('git config user.name=someone', ps51)).toBeNull()
  })
})

/**
 * These run the real validator against the real shell on this machine, because
 * the thing under test IS "would this resolve here". A mocked shell would only
 * prove the mock.
 */
const onPowerShell = getShellInfo().isPowerShell
const psOnly = onPowerShell ? it : it.skip

describe('validateVerificationCommand', () => {
  /**
   * The exact assertion I shipped in the Gilded L4.1d contract. It parses —
   * PowerShell reads the parenthetical as a sub-expression calling a command
   * named `every` — so no parse check catches it. It cost ~60 turns and ended
   * with the agent writing an `every` stub onto PATH to make it exit 0.
   */
  psOnly('rejects prose trailing a verification command', () => {
    const err = validateVerificationCommand(
      'python C:/tmp/bite41d.py  (every mutation in the L4.1 set turns the shipped test suite red)',
    )
    expect(err).toBeTruthy()
    expect(err).toContain('every')
    expect(err).toContain('the command and nothing else')
  })

  psOnly('accepts the same command with the prose removed', () => {
    expect(validateVerificationCommand('python C:/tmp/bite41d.py')).toBeNull()
  })

  psOnly('rejects a command that does not parse', () => {
    const err = validateVerificationCommand('python -c "unterminated')
    expect(err).toBeTruthy()
    expect(err).toContain('does not parse')
  })

  // A path or an extension means the task may be about to create it, and
  // resolution is relative to a cwd this function cannot know.
  psOnly('accepts a qualified name that does not exist yet', () => {
    expect(validateVerificationCommand('./scripts/verify-l41e.sh')).toBeNull()
    expect(validateVerificationCommand('build/run-gate.exe --strict')).toBeNull()
  })

  psOnly('accepts a real multi-step check', () => {
    expect(validateVerificationCommand('cd C:/tmp; python -c "import sys; sys.exit(0)"')).toBeNull()
  })

  it('reports the dialect error before attempting to run anything', () => {
    const ps51 = classifyShell('win32', false)
    const err = validateVerificationCommand('cd proj && python -m pytest', ps51)
    expect(err).toBeTruthy()
    expect(err).toContain("does not support '&&'")
  })
})

describe('getShellInfo', () => {
  it('returns a stable cached value for this platform', () => {
    const a = getShellInfo()
    const b = getShellInfo()
    expect(a).toBe(b)
    expect(typeof a.shell).toBe('string')
    expect(typeof a.dialectNote).toBe('string')
  })
})
