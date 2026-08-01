import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBashSafety } from '../../tools/bashSafety.js'
import { bashTool } from '../../tools/impl/bash.js'

describe('Bash Safety', () => {
  it('allows normal commands', () => {
    expect(checkBashSafety('echo hello').safe).toBe(true)
    expect(checkBashSafety('bun test').safe).toBe(true)
    expect(checkBashSafety('git status').safe).toBe(true)
  })

  it('blocks .env file access', () => {
    expect(checkBashSafety('cat .env').safe).toBe(false)
    expect(checkBashSafety('cat .env.local').safe).toBe(false)
    expect(checkBashSafety('echo SECRET=x >> .env').safe).toBe(false)
  })

  it('blocks credential file access', () => {
    expect(checkBashSafety('cat ~/.ssh/id_rsa').safe).toBe(false)
    expect(checkBashSafety('cat /etc/shadow').safe).toBe(false)
  })

  it('blocks destructive system commands', () => {
    expect(checkBashSafety('rm -rf /').safe).toBe(false)
    expect(checkBashSafety('rm -rf ~').safe).toBe(false)
    expect(checkBashSafety('mkfs.ext4 /dev/sda').safe).toBe(false)
  })

  it('blocks commands that leak env vars', () => {
    expect(checkBashSafety('env').safe).toBe(false)
    expect(checkBashSafety('printenv').safe).toBe(false)
    expect(checkBashSafety('echo $SECRET_KEY').safe).toBe(false)
  })

  it('returns reason when blocked', () => {
    const result = checkBashSafety('cat .env')
    expect(result.reason).toContain('.env')
  })

  /**
   * On Windows the Bash tool is PowerShell, where setting a variable for one
   * command is written `$env:NAME="value"`. The env-dump rule matched the bare
   * word `env` anywhere in the string, so it caught every one of those — and
   * the two POSIX alternatives are already unavailable (`NAME=value cmd` is a
   * PowerShell parse error, `set NAME=... && ...` is refused by the 5.1
   * dialect check). A live run hit all three in a row and escaped only by
   * shelling out to `python -c "os.environ[...]"`.
   *
   * Setting a variable dumps nothing. Reading a secret one still does.
   */
  it('allows a PowerShell environment assignment — it dumps nothing', () => {
    expect(checkBashSafety('$env:GILDED_NARRATE="0"; python -m pytest gilded/ -q').safe).toBe(true)
    expect(checkBashSafety('cd proj; $env:SDL_VIDEODRIVER="dummy"; python -m pytest').safe).toBe(true)
  })

  it('still blocks the dump itself, in either shell', () => {
    expect(checkBashSafety('env').safe).toBe(false)
    expect(checkBashSafety('cd proj; printenv | sort').safe).toBe(false)
    expect(checkBashSafety('Get-ChildItem Env:').safe).toBe(false)
  })

  it('still blocks reading a secret out of the PowerShell environment', () => {
    expect(checkBashSafety('echo $env:AWS_SECRET_ACCESS_KEY').safe).toBe(false)
    expect(checkBashSafety('Write-Output $env:GITHUB_TOKEN').safe).toBe(false)
  })
})

/**
 * Every case above proves what the function answers. None proves anyone asks
 * it. The whole guard could be lifted out of the Bash tool and the file above
 * would stay green, which is the shape that lets a wired check quietly become
 * an unwired one.
 *
 * These drive the tool the way the model does. Nothing is stubbed: a refused
 * command must never reach a shell, so a real refusal is observable without
 * running anything.
 */
describe('the Bash tool asks', () => {
  it('refuses a blocked command instead of running it', async () => {
    const result = await bashTool.execute({ command: 'cat .env' }, tmpdir())
    expect(result.isError).toBe(true)
    expect(result.output.startsWith('Blocked:')).toBe(true)
    expect(result.output).toContain('.env')
  })

  it('refuses a blocked command whatever else is on the line', async () => {
    const result = await bashTool.execute({ command: 'cat /etc/shadow' }, tmpdir())
    expect(result.isError).toBe(true)
    expect(result.output.startsWith('Blocked:')).toBe(true)
  })

  it('refuses a session-blocking command with the advice attached', async () => {
    const result = await bashTool.execute({ command: 'npm start' }, tmpdir())
    expect(result.isError).toBe(true)
    expect(result.output.startsWith('Blocked:')).toBe(true)
    expect(result.output).toContain('background')
  })

  it('refuses before the shell runs, not after', async () => {
    // If the guard moved below execution this would leave a file behind. The
    // command is refused for `env`, and its side effect is what proves the
    // refusal came first.
    const dir = mkdtempSync(join(tmpdir(), 'bashsafety-'))
    const witness = join(dir, 'ran.txt')
    const result = await bashTool.execute(
      { command: `env > ${JSON.stringify(witness)}` },
      dir,
    )
    expect(result.isError).toBe(true)
    expect(result.output.startsWith('Blocked:')).toBe(true)
    expect(existsSync(witness)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('still runs a command the guard allows', async () => {
    const result = await bashTool.execute({ command: 'echo wired' }, tmpdir())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('wired')
  })
})
