import { describe, expect, it } from 'bun:test'
const SKIP_ENV = !process.env.CYNCO_INTEGRATION
import { gitTool, tokenizeArgs } from '../../tools/impl/git.js'

// ---------------------------------------------------------------------------
// tokenizeArgs unit tests (Issue 3 + Issue 4)
// ---------------------------------------------------------------------------
describe('tokenizeArgs', () => {
  it('splits simple args', () => {
    expect(tokenizeArgs('--oneline -5')).toEqual(['--oneline', '-5'])
  })

  it('handles spaces inside double-quoted arg', () => {
    expect(tokenizeArgs('-m "two words"')).toEqual(['-m', 'two words'])
  })

  it('handles adjacent quoted segment (--message="a b")', () => {
    expect(tokenizeArgs('--message="a b"')).toEqual(['--message=a b'])
  })

  it('returns empty array for empty input', () => {
    expect(tokenizeArgs('')).toEqual([])
    expect(tokenizeArgs('   ')).toEqual([])
  })

  it('preserves empty quoted string (Issue 4)', () => {
    // -m "" must produce ['-m', ''] so the empty string is the commit message
    expect(tokenizeArgs('-m ""')).toEqual(['-m', ''])
  })
})

// ---------------------------------------------------------------------------
// Git tool tests
// ---------------------------------------------------------------------------
describe('Git tool', () => {
  it('has correct metadata', () => {
    expect(gitTool.name).toBe('Git')
    expect(gitTool.tier).toBe('approval')
  })

  it.skipIf(SKIP_ENV)('runs git status', async () => {
    const result = await gitTool.execute({ subcommand: 'status' }, process.cwd())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('branch')
  })

  it.skipIf(SKIP_ENV)('runs git log', async () => {
    const result = await gitTool.execute({ subcommand: 'log', args: '--oneline -5' }, process.cwd())
    expect(result.isError).toBe(false)
  })

  it('rejects dangerous commands', async () => {
    const result = await gitTool.execute({ subcommand: 'push', args: '--force' }, process.cwd())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('dangerous')
  })

  // Issue 2: quoted --force must also be blocked (tokenized form check)
  it('rejects push with quoted --force (Issue 2)', async () => {
    const result = await gitTool.execute({ subcommand: 'push', args: '"--force"' }, process.cwd())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('dangerous')
  })

  // Issue 7: use process.cwd() instead of /tmp
  it('blocks shell metacharacters in args', async () => {
    const result = await gitTool.execute(
      { subcommand: 'status', args: '; echo INJECTED > /tmp/proof' },
      process.cwd()
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/dangerous.*command.*blocked/i)
    expect(result.output).toContain('Shell metacharacters not allowed')
  })

  // Issue 1: commit message with parens/dollar/braces in quoted region must be ALLOWED
  it('allows quoted commit message with parens and special chars (Issue 1)', async () => {
    // The guard must NOT fire on metacharacters that are inside quotes.
    // We can't actually commit in tests, but we can confirm the guard doesn't
    // short-circuit — the tool should either succeed or fail for git reasons,
    // not return "Shell metacharacters not allowed".
    const result = await gitTool.execute(
      { subcommand: 'log', args: '--grep="feat(scope): add parser" --oneline' },
      process.cwd()
    )
    // Must NOT be blocked by the metachar guard
    expect(result.output).not.toContain('Shell metacharacters not allowed')
    // isError may be true if no commits match, that's fine
  })

  // Issue 1: unquoted semicolon must still be blocked
  it('still blocks unquoted metacharacters after Issue 1 fix', async () => {
    const result = await gitTool.execute(
      { subcommand: 'status', args: 'unquoted; rm -rf /' },
      process.cwd()
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Shell metacharacters not allowed')
  })

  // Issue 3: rename / replace misleading "handles quoted commit messages safely"
  // Now tests an actual quoted arg flowing through execute without being blocked
  it('handles quoted log --grep without metachar false positive', async () => {
    const result = await gitTool.execute(
      { subcommand: 'log', args: '--grep="nonexistent phrase xyz" --oneline' },
      process.cwd()
    )
    expect(result.output).not.toContain('Shell metacharacters not allowed')
  })
})
