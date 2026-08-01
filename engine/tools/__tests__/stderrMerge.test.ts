/**
 * F60: a trailing `2>&1` makes PowerShell report a successful command as failed.
 *
 * `git worktree add --detach <p> HEAD 2>&1` creates the worktree and git exits 0.
 * powershell.exe -Command exits 1. In PowerShell `2>&1` does not merge two file
 * descriptors the way it does in bash — it merges the ERROR stream into the
 * success pipeline as ErrorRecord objects, and any native command that wrote a
 * byte to stderr therefore leaves `$?` false. `git worktree add` writes
 * "Preparing worktree" to stderr on a completely ordinary success. bash.ts keys
 * `isError` off exec's `err`, so the model is handed a failure for work that
 * succeeded, and goes to repair something that was never broken.
 *
 * It is the universal bash idiom, so it is everywhere: 165 of 782 Bash calls in
 * the trajectory corpus end in a trailing `2>&1`, and they come back errored
 * 29.9% of the time against 18.4% for calls carrying none. And `toolSuccessRate`
 * is a REWARD COMPONENT, so a false failure is not only a wasted turn — it is a
 * wrong label in the training corpus.
 *
 * The fix is a translation, not a guess, and it is the same argument as
 * `autoTranslateEnvPrefix`: the engine already reports stdout AND stderr, so a
 * trailing `2>&1` asks for something it is going to get anyway, and dropping it
 * cannot change what the model sees. A PIPED `2>&1` is a different statement —
 * it routes stderr into the next command — so it is left alone.
 */
import { describe, expect, it } from 'vitest'
import { classifyShell } from '../shellInfo.js'
import { stripTrailingStderrMerge } from '../shellInfo.js'

const ps51 = classifyShell('win32', false)
const pwsh = classifyShell('win32', true)
const bash = classifyShell('linux', false)

describe('a trailing stderr merge is removed on PowerShell, and only there', () => {
  it('drops it from the end of a command', () => {
    const r = stripTrailingStderrMerge('git worktree add --detach C:/t HEAD 2>&1', ps51)
    expect(r.command).toBe('git worktree add --detach C:/t HEAD')
    expect(r.stripped).toBe(true)
  })

  it('drops it on pwsh too — the pipeline semantics are the same in 7', () => {
    expect(stripTrailingStderrMerge('git fetch 2>&1', pwsh).stripped).toBe(true)
  })

  it('leaves bash alone, where 2>&1 means what the model thinks it means', () => {
    const r = stripTrailingStderrMerge('git fetch 2>&1', bash)
    expect(r.command).toBe('git fetch 2>&1')
    expect(r.stripped).toBe(false)
  })

  it('tolerates trailing whitespace, because the model writes it', () => {
    expect(stripTrailingStderrMerge('git fetch 2>&1   ', ps51).command).toBe('git fetch')
  })

  it('drops a trailing merge that ends a sequence', () => {
    const r = stripTrailingStderrMerge('cd C:/p; python x.py 2>&1', ps51)
    expect(r.command).toBe('cd C:/p; python x.py')
    expect(r.stripped).toBe(true)
  })

  it('strips it after an apostrophe, which is not an open quote', () => {
    // A trailing merge is trailing whatever prose comes before it. Counting
    // quotes to decide "the token is inside a string" cannot be right: a string
    // opened before the token has to close after it, and then the command no
    // longer ends in 2>&1, so the $ anchor has already refused it. All the count
    // could do was decline to fix `git commit -m "don't ..." 2>&1`.
    const r = stripTrailingStderrMerge(`git commit -m "don't break it" 2>&1`, ps51)
    expect(r.command).toBe(`git commit -m "don't break it"`)
    expect(r.stripped).toBe(true)
  })

  it('leaves a command with no merge untouched and says so', () => {
    const r = stripTrailingStderrMerge('git status', ps51)
    expect(r.command).toBe('git status')
    expect(r.stripped).toBe(false)
  })
})

describe('a merge that is not trailing is a different statement and is kept', () => {
  it('keeps a piped merge — removing it would stop stderr reaching the pipe', () => {
    const cmd = 'python -m pytest 2>&1 | Select-String FAIL'
    const r = stripTrailingStderrMerge(cmd, ps51)
    expect(r.command).toBe(cmd)
    expect(r.stripped).toBe(false)
  })

  it('keeps a merge followed by another command in the sequence', () => {
    const cmd = 'python x.py 2>&1; git status'
    expect(stripTrailingStderrMerge(cmd, ps51).command).toBe(cmd)
  })

  it('keeps a merge inside a quoted python body, which is not shell syntax at all', () => {
    // `python -c "... subprocess.run(x, ...) 2>&1"` — the token is inside the
    // argument. Stripping it would edit the model's program, not its plumbing.
    // The end anchor is what saves it: the closing quote comes after the token,
    // so the command does not end in a merge. That is true of every in-string
    // occurrence, which is why no quote counting is needed on top.
    const cmd = 'python -c "print(1) 2>&1"'
    expect(stripTrailingStderrMerge(cmd, ps51).command).toBe(cmd)
  })

  it('keeps a redirect to a file, which is not a merge', () => {
    const cmd = 'python x.py 2>err.txt'
    expect(stripTrailingStderrMerge(cmd, ps51).command).toBe(cmd)
  })
})

describe('the guarantee that makes stripping honest: nothing is hidden', () => {
  it('the success path shows stderr as well when a merge was stripped', async () => {
    // Otherwise this trades a false failure for a silent truncation, and the
    // model asked for stderr explicitly. Only when stripped: a command that did
    // not ask keeps the existing output, so no unrelated run gains SDL noise.
    const { bashTool } = await import('../impl/bash.js')
    const out = await bashTool.execute(
      { command: 'node -e "console.log(\'OUT\'); console.error(\'ERR\')" 2>&1' },
      process.cwd(),
    )
    expect(out.isError).toBe(false)
    expect(out.output).toContain('OUT')
    expect(out.output).toContain('ERR')
  })

  it('without the merge the model gets what it always got, and no more', async () => {
    // The other half of the scoping. Showing stderr on EVERY success would put
    // SDL/pygame/deprecation noise on top of every green pytest run — a cost
    // paid by commands that never asked. So the absence is asserted, not just
    // the presence above: only the request is honoured.
    const { bashTool } = await import('../impl/bash.js')
    const out = await bashTool.execute(
      { command: 'node -e "console.log(\'ONLYOUT\'); console.error(\'NOISE\')"' },
      process.cwd(),
    )
    expect(out.isError).toBe(false)
    expect(out.output).toContain('ONLYOUT')
    expect(out.output).not.toContain('NOISE')
  })
})

describe('the strip is on the live path, not merely exported', () => {
  it('bash.ts calls it', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(import.meta.dirname, '..', 'impl', 'bash.ts'), 'utf-8')
    expect(src).toContain('stripTrailingStderrMerge(')
  })
})
