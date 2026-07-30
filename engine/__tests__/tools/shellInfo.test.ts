// engine/__tests__/tools/shellInfo.test.ts
import { describe, expect, it } from 'bun:test'
import {
  autoTranslateEnvPrefix,
  classifyShell,
  checkShellDialect,
  getShellInfo,
  shellPreamble,
  translateEnvPrefix,
  validateVerificationCommand,
} from '../../tools/shellInfo.js'

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

describe('translateEnvPrefix', () => {
  const ps51 = classifyShell('win32', false)

  it('rewrites a leading prefix into the $env: form', () => {
    expect(translateEnvPrefix('FOO=1 python -m pytest', ps51))
      .toBe('$env:FOO="1"; python -m pytest')
  })

  /**
   * ENV_PREFIX anchors on `^` OR `;`, so a prefix in the SECOND command of a
   * sequence matches at the `;` — and the rewrite sliced from the match's start,
   * discarding everything before it. Measured: `cd proj; FOO=1 python -m pytest`
   * came back `$env:FOO="1"; python -m pytest`, with the `cd` gone.
   *
   * That is a silent wrong answer rather than a failure, which is what makes it
   * worth a test: verifyAssertion RUNS the translated string, so a contract that
   * changed directory first would have been measured in the wrong directory and
   * whatever verdict came back recorded as if it meant something.
   */
  it('keeps everything before the prefix it rewrites', () => {
    expect(translateEnvPrefix('cd proj; FOO=1 python -m pytest', ps51))
      .toBe('cd proj; $env:FOO="1"; python -m pytest')
  })
})

/**
 * `NAME=value command` is a parse error in every PowerShell, and the engine has
 * always known the exact replacement — it quoted it back in an error and spent a
 * turn. Measured on the Wave 4 run: five of the agent's thirty-eight Bash errors
 * were this, long after the instructive error had already taught it once. The
 * refusal does not carry across turns, so it is paid for repeatedly.
 *
 * bash.ts already rewrites what reaches the shell without changing what is
 * reported (shellPreamble's UTF-8 redirection default). Translating the env
 * prefix there is the same act — but only where the translation is provably
 * meaning-identical.
 *
 * POSIX `NAME=value cmd` scopes the variable to ONE command; `$env:NAME=...; cmd`
 * scopes it to the rest of the shell. Those agree only when `cmd` is the whole
 * remainder, because each Bash call spawns a fresh shell that then exits. So a
 * prefix that is not at the start, or one followed by another command, is refused
 * and falls through to the instructive error rather than being quietly widened.
 */
describe('autoTranslateEnvPrefix (rewrite instead of refuse)', () => {
  const ps51 = classifyShell('win32', false)
  const pwsh = classifyShell('win32', true)
  const bash = classifyShell('linux', false)

  it('translates the single-command case on both PowerShells', () => {
    for (const info of [ps51, pwsh]) {
      expect(autoTranslateEnvPrefix('GILDED_NARRATE=0 SDL_VIDEODRIVER=dummy python -m pytest', info))
        .toBe('$env:GILDED_NARRATE="0"; $env:SDL_VIDEODRIVER="dummy"; python -m pytest')
    }
  })

  it('refuses when another command follows — the variable would outlive its scope', () => {
    expect(autoTranslateEnvPrefix('FOO=1 pytest; git status', ps51)).toBeNull()
    expect(autoTranslateEnvPrefix('FOO=1 pytest && git status', pwsh)).toBeNull()
    expect(autoTranslateEnvPrefix('FOO=1 pytest || echo no', pwsh)).toBeNull()
  })

  it('refuses when the prefix is not the first thing in the command', () => {
    expect(autoTranslateEnvPrefix('cd proj; FOO=1 pytest', ps51)).toBeNull()
  })

  it('returns null when there is nothing to translate', () => {
    expect(autoTranslateEnvPrefix('python -m pytest', ps51)).toBeNull()
    expect(autoTranslateEnvPrefix('python -m pytest -k test_x=1', ps51)).toBeNull()
  })

  it('never touches a shell that understands the POSIX form', () => {
    expect(autoTranslateEnvPrefix('FOO=1 python -m pytest', bash)).toBeNull()
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

  /**
   * verifyAssertion translates this before running it, so refusing it here
   * would refuse contracts the engine executes without trouble — every L4.1
   * contract has carried exactly this line.
   */
  psOnly('accepts a POSIX env prefix, which the runner translates', () => {
    expect(validateVerificationCommand(
      'GILDED_NARRATE=0 SDL_VIDEODRIVER=dummy python -m pytest gilded/ -q',
    )).toBeNull()
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

/**
 * Finding (ab), measured on this machine:
 *
 *   powershell.exe -NoProfile -Command "'hello' > f"   ->  ff fe 68 00 65 00 ...
 *
 * `>` in Windows PowerShell 5.1 is Out-File, whose default encoding is UTF-16LE.
 * So every `command > out.txt` the agent writes produces a file that git calls
 * binary and that every text tool downstream reads as nonsense. Setting
 * Out-File's default parameter for the invocation moves it to UTF-8:
 *
 *   ... "$PSDefaultParameterValues['Out-File:Encoding']='utf8'; 'hello' > f"
 *                                                     ->  ef bb bf 68 65 ...
 *
 * This is the same act as the PYTHONUTF8 injection already in bash.ts: the
 * engine forcing UTF-8 on a subprocess whose default is not, rather than asking
 * the model to remember. It is a shell setting, not a rewrite of the command —
 * nothing the model wrote changes meaning, only the bytes redirection emits.
 *
 * 5.1 has no BOM-less UTF-8 (`utf8NoBOM` arrives in PowerShell 6), so the mark
 * remains; Read strips it. Only powershell.exe is touched. pwsh is documented to
 * default to UTF-8 already and is not installed here, so it cannot be measured —
 * and an unmeasured shell gets the unchanged path, not a guess.
 */
describe('shellPreamble', () => {
  it('forces UTF-8 redirection on Windows PowerShell 5.1', () => {
    const preamble = shellPreamble(classifyShell('win32', false))
    expect(preamble).toContain("$PSDefaultParameterValues['Out-File:Encoding']='utf8'")
    expect(preamble.trimEnd().endsWith(';')).toBe(true)
  })

  it('leaves pwsh alone', () => {
    expect(shellPreamble(classifyShell('win32', true))).toBe('')
  })

  it('leaves bash alone', () => {
    expect(shellPreamble(classifyShell('linux', false))).toBe('')
  })
})
