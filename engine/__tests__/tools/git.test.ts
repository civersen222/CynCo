import { describe, expect, it } from 'bun:test'
import * as os from 'node:os'
const SKIP_ENV = !process.env.CYNCO_INTEGRATION
import { gitTool, tokenizeArgs } from '../../tools/impl/git.js'

// Non-repo cwd: guards fire before spawn, but if a guard ever regresses the
// command runs against an empty temp dir instead of this repository.
const NON_REPO_CWD = os.tmpdir()

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

  // Short-flag variant of push --force must also be blocked
  it('rejects push -f (short flag)', async () => {
    const result = await gitTool.execute({ subcommand: 'push', args: '-f origin main' }, NON_REPO_CWD)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('dangerous')
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

// ---------------------------------------------------------------------------
// Argument injection: options whose VALUES git executes as programs.
// These contain no shell metacharacters, so they pass the metachar guard —
// they must be blocked by an explicit option deny-list.
// ---------------------------------------------------------------------------
describe('Git tool — argument injection guard', () => {
  it('blocks --upload-pack (fetch/clone runs the given program)', async () => {
    const result = await gitTool.execute(
      { subcommand: 'fetch', args: '--upload-pack=/tmp/evil.sh origin' },
      NON_REPO_CWD
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('blocked')
  })

  it('blocks --receive-pack as a bare token with separate value', async () => {
    const result = await gitTool.execute(
      { subcommand: 'push', args: '--receive-pack /tmp/evil.sh origin main' },
      NON_REPO_CWD
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('blocked')
  })

  it('blocks --exec (alias for upload/receive-pack)', async () => {
    const result = await gitTool.execute(
      { subcommand: 'fetch', args: '--exec=/tmp/evil.sh origin' },
      NON_REPO_CWD
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('blocked')
  })

  it('blocks --config (clone can plant core.fsmonitor etc.)', async () => {
    const result = await gitTool.execute(
      { subcommand: 'clone', args: '--config=core.fsmonitor=/tmp/evil.sh https://example.com/r.git' },
      NON_REPO_CWD
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('blocked')
  })

  it('blocks config-style -c name=value (core.sshCommand injection)', async () => {
    const result = await gitTool.execute(
      { subcommand: 'fetch', args: '-c core.sshCommand=/tmp/evil.sh origin' },
      NON_REPO_CWD
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('blocked')
  })

  it('allows non-config -c (switch -c <branch>)', async () => {
    const result = await gitTool.execute(
      { subcommand: 'switch', args: '-c feature-x' },
      NON_REPO_CWD
    )
    // Must not be blocked by any guard; git itself errors (not a repository)
    expect(result.output).not.toContain('blocked')
  })
})

// ---------------------------------------------------------------------------
// Failure reporting. git does not put its diagnostics where you would expect:
// a commit with nothing staged exits 1 with stderr EMPTY and the whole
// explanation on stdout. Reporting stderr alone told the agent only "exited
// with code 1", costing it a turn on `git status` to learn what the failure
// had already said.
// ---------------------------------------------------------------------------
describe('Git tool — failure reporting', () => {
  it('surfaces the explanation git wrote to stdout, not just an exit code', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittool-'))
    try {
      await gitTool.execute({ subcommand: 'init', args: '-q .' }, dir)
      fs.writeFileSync(path.join(dir, 'untracked.txt'), 'hi')

      const result = await gitTool.execute(
        { subcommand: 'commit', args: '-m "nothing is staged"' },
        dir
      )

      expect(result.isError).toBe(true)
      expect(result.output).toContain('nothing added to commit')
      // The old behaviour, and the thing the agent actually saw.
      expect(result.output).not.toBe('git commit exited with code 1')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Finding (s): a commit is a claim of delivery, and the engine watched a run
// stage exactly the two files its contract named, commit, and walk away — while
// a third tracked file holding the entire foundation of the feature sat
// modified in the tree. HEAD did not import. Every measurement taken (25 harness
// checks, 470 pytest, diffClean) read the WORKING TREE, so all of them were
// green about code nobody had delivered.
//
// git knows. It has always known. Nobody asked it at the moment the answer
// mattered. Reported, never blocked: unrelated dirt is legitimate and the agent
// is the only one who can tell which is which.
// ---------------------------------------------------------------------------
describe('Git tool — what a commit left behind', () => {
  async function repoWithCommitAndLeftover() {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleft-'))
    await gitTool.execute({ subcommand: 'init', args: '-q .' }, dir)
    await gitTool.execute({ subcommand: 'config', args: 'user.email t@t' }, dir)
    await gitTool.execute({ subcommand: 'config', args: 'user.name t' }, dir)
    fs.writeFileSync(path.join(dir, 'banner.py'), 'v1\n')
    fs.writeFileSync(path.join(dir, 'market.py'), 'v1\n')
    await gitTool.execute({ subcommand: 'add', args: '.' }, dir)
    await gitTool.execute({ subcommand: 'commit', args: '-m base' }, dir)
    // Now the run: both files change, only one is staged.
    fs.writeFileSync(path.join(dir, 'banner.py'), 'v2 calls market.delta\n')
    fs.writeFileSync(path.join(dir, 'market.py'), 'v2 defines delta\n')
    await gitTool.execute({ subcommand: 'add', args: 'banner.py' }, dir)
    return { dir, fs }
  }

  it('names the tracked files a commit left modified in the tree', async () => {
    const { dir, fs } = await repoWithCommitAndLeftover()
    try {
      const result = await gitTool.execute(
        { subcommand: 'commit', args: '-m "the half of it that was staged"' },
        dir
      )
      expect(result.isError).toBe(false)
      expect(result.output).toContain('market.py')
      // and it must still be a success, not a refusal
      expect(result.output).not.toContain('blocked')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says nothing extra when the commit took everything tracked', async () => {
    const { dir, fs } = await repoWithCommitAndLeftover()
    try {
      await gitTool.execute({ subcommand: 'add', args: 'market.py' }, dir)
      const result = await gitTool.execute(
        { subcommand: 'commit', args: '-m "all of it"' },
        dir
      )
      expect(result.isError).toBe(false)
      expect(result.output).not.toContain('still modified')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores untracked files — only tracked modifications are a delivery gap', async () => {
    const { dir, fs } = await repoWithCommitAndLeftover()
    const path = await import('node:path')
    try {
      await gitTool.execute({ subcommand: 'add', args: 'market.py' }, dir)
      fs.writeFileSync(path.join(dir, 'scratch.log'), 'noise\n')
      const result = await gitTool.execute(
        { subcommand: 'commit', args: '-m "all of it"' },
        dir
      )
      expect(result.output).not.toContain('scratch.log')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not interrogate the tree after a non-commit subcommand', async () => {
    const { dir, fs } = await repoWithCommitAndLeftover()
    try {
      const result = await gitTool.execute({ subcommand: 'status', args: '--short' }, dir)
      expect(result.output).not.toContain('still modified')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// The subcommand field arrives with the flags already folded in.
//
// Observed live on Gilded UI Wave 6d: the model called
//   { subcommand: 'status --porcelain' }
// and git answered `git: 'status --porcelain' is not a git command`, because
// the whole string went in as ONE argv element. That reads like a broken git
// or a broken repo, not a malformed call, so the turn was spent on the wrong
// question. The two spellings mean the same thing and must now behave the same.
//
// The risk this introduces is that the subcommand field gets the laxer
// treatment `args` gets. It must not: every guard still evaluates the unsplit
// string, so the last three tests here are the ones that matter.
// ---------------------------------------------------------------------------
describe('Git tool — flags folded into the subcommand field', () => {
  async function tinyRepo() {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitfold-'))
    await gitTool.execute({ subcommand: 'init', args: '-q .' }, dir)
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'hi')
    return { dir, fs }
  }

  it('runs `status --porcelain` submitted as one subcommand string', async () => {
    const { dir, fs } = await tinyRepo()
    try {
      const result = await gitTool.execute({ subcommand: 'status --porcelain' }, dir)
      expect(result.output).not.toContain('is not a git command')
      expect(result.isError).toBeFalsy()
      // --porcelain reached git as its own argv element: the short format is
      // `?? scratch.txt`, the long format git prints without it is not.
      expect(result.output).toContain('?? scratch.txt')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives the folded and the split spelling the same output', async () => {
    const { dir, fs } = await tinyRepo()
    try {
      const folded = await gitTool.execute({ subcommand: 'status --porcelain' }, dir)
      const split = await gitTool.execute({ subcommand: 'status', args: '--porcelain' }, dir)
      expect(folded.output).toBe(split.output)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still blocks a dangerous command folded into the subcommand field', async () => {
    const result = await gitTool.execute({ subcommand: 'push --force origin main' }, NON_REPO_CWD)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('dangerous git command blocked')
  })

  it('still blocks shell metacharacters folded into the subcommand field', async () => {
    const result = await gitTool.execute({ subcommand: 'status; rm -rf /' }, NON_REPO_CWD)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Shell metacharacters not allowed')
  })

  it('blocks an argument-injection option folded into the subcommand field', async () => {
    const result = await gitTool.execute({ subcommand: 'clone --upload-pack=evil host:/r' }, NON_REPO_CWD)
    expect(result.isError).toBe(true)
    // Assert the GUARD spoke, not merely that something failed. Before the
    // split, argTokens was built from `args` alone, so this option was invisible
    // to the guard — and the call still "failed", because git rejected the
    // whole folded string as an unknown subcommand. An error whose text happens
    // to quote the command back is not evidence that anything inspected it.
    expect(result.output).toContain('can execute arbitrary programs')
  })

  it('does not let quoting inside the subcommand field launder a metacharacter', async () => {
    // `args` exempts quoted regions, because array-spawn makes them inert.
    // The subcommand field gets no such exemption — if folding a string in
    // bought that exemption, this would run.
    const result = await gitTool.execute({ subcommand: 'log "--grep=$(whoami)"' }, NON_REPO_CWD)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Shell metacharacters not allowed')
  })
})
