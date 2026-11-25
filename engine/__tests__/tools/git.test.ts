import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildArgv, gitTool, tokenizeArgs } from '../../tools/impl/git.js'

// Non-repo cwd: guards fire before spawn, but if a guard ever regresses the
// command runs against an empty temp dir instead of this repository.
const NON_REPO_CWD = os.tmpdir()

// A repository of the test's own, on a branch, with one commit. `git status` and `git log` used
// to run against the checkout the suite happens to be in, and "runs git status" asserted the
// word "branch": true on a developer's branch, false on CI's detached merge commit ("HEAD
// detached at pull/256/merge"), which is how it failed the first time it ever ran there
// (2026-11-17, the day it left the CYNCO_INTEGRATION gate).
let OWN_REPO = ''
beforeAll(() => {
  OWN_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-git-tool-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', OWN_REPO, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first')
})
afterAll(() => { fs.rmSync(OWN_REPO, { recursive: true, force: true, maxRetries: 5 }) })

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

  it('runs git status', async () => {
    const result = await gitTool.execute({ subcommand: 'status' }, OWN_REPO)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('branch')
  })

  it('runs git log', async () => {
    const result = await gitTool.execute({ subcommand: 'log', args: '--oneline -5' }, OWN_REPO)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('first')
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

  // Identity config is the one -c the agent legitimately needs. Three
  // consecutive missions shipped commits authored by the repo's placeholder
  // identity because the brief mandated `git -c user.name=... commit` and this
  // tool refused to run it. A guard that makes the correct action impossible
  // does not prevent the mistake, it mandates it.
  it('allows -c user.name= and -c user.email=', async () => {
    const result = await gitTool.execute(
      { subcommand: 'commit', args: '-c user.name=civersen222 -c user.email=civersen222@users.noreply.github.com -m "msg"' },
      NON_REPO_CWD
    )
    expect(result.output).not.toContain('blocked')
  })

  it('still blocks every other -c key, even alongside an allowed one', async () => {
    const result = await gitTool.execute(
      { subcommand: 'commit', args: '-c user.name=x -c core.sshCommand=/tmp/evil.sh -m "msg"' },
      NON_REPO_CWD
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('blocked')
  })

  it('allowed -c keys are case-insensitive like git config itself', async () => {
    const result = await gitTool.execute(
      { subcommand: 'commit', args: '-c User.Email=a@b.c -m "msg"' },
      NON_REPO_CWD
    )
    expect(result.output).not.toContain('blocked')
  })

  it('does not allow a key that merely starts with an allowed one', async () => {
    const result = await gitTool.execute(
      { subcommand: 'commit', args: '-c user.namex=evil -m "msg"' },
      NON_REPO_CWD
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('blocked')
  })
})

// ---------------------------------------------------------------------------
// git only honours -c BEFORE the subcommand. The tool's schema puts everything
// the model writes into `args`, which spawn places AFTER it, where git reads
// `-c` as an argument to the subcommand and either errors or silently means
// something else (`commit -c <commit>` reuses that commit's message!). So an
// allowed -c must be hoisted, and the hoisting is what makes the allowlist
// worth anything.
// ---------------------------------------------------------------------------
describe('Git tool: -c hoisting', () => {
  it('hoists allowed -c pairs ahead of the subcommand', () => {
    expect(buildArgv('commit', ['-c', 'user.name=x', '-m', 'msg']))
      .toEqual(['-c', 'user.name=x', 'commit', '-m', 'msg'])
  })

  it('leaves a bare -c switch alone (switch -c <branch>)', () => {
    expect(buildArgv('switch', ['-c', 'feature-x']))
      .toEqual(['switch', '-c', 'feature-x'])
  })

  it('hoists both identity pairs in order, preserving the rest', () => {
    expect(buildArgv('commit', ['-c', 'user.name=a b', '-c', 'user.email=c@d', '-m', 'msg']))
      .toEqual(['-c', 'user.name=a b', '-c', 'user.email=c@d', 'commit', '-m', 'msg'])
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

  // The subcommand field's own first word was never checked against the option deny-list or the -c rule
  // (docs/NOW.md backlog, "FORBIDDEN_OPTIONS should also read the subcommand field"): `-c core.sshCommand=...`
  // written as the subcommand reached git ahead of the real subcommand, where git honours it. `--exec-path=`
  // and `--config-env=` are git's own options that name a program folder or a setting to load (found with it).
  it('blocks a forbidden option or a -c setting written as the subcommand itself', async () => {
    const nowhere = path.join(os.tmpdir(), 'cynco-git-no-such-folder', 'evil.sh')
    const calls: Array<[Record<string, string>, string]> = [
      [{ subcommand: '--upload-pack=' + nowhere, args: 'fetch origin' }, 'can execute arbitrary programs'],
      [{ subcommand: '-c core.sshCommand=' + nowhere + ' fetch' }, 'Inline config'],
      [{ subcommand: '-c', args: 'core.sshCommand=' + nowhere + ' fetch origin' }, 'Inline config'],
      [{ subcommand: '--exec-path=' + path.dirname(nowhere), args: 'status' }, 'can execute arbitrary programs'],
      [{ subcommand: 'status', args: '--exec-path=' + path.dirname(nowhere) }, 'can execute arbitrary programs'],
      [{ subcommand: '--config-env=core.sshCommand=PATH', args: 'fetch origin' }, 'can execute arbitrary programs'],
      [{ subcommand: 'fetch', args: '--config-env=core.sshCommand=PATH origin' }, 'can execute arbitrary programs'],
    ]
    const notBlocked: string[] = []
    for (const [input, says] of calls) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      if (!result.isError || !result.output.includes('dangerous git command blocked') || !result.output.includes(says)) {
        notBlocked.push(`${JSON.stringify(input)} -> ${result.output.slice(0, 80)}`)
      }
    }
    expect(notBlocked).toEqual([])
  })

  // Wave 15b (P3-F8): git's option parser takes any unique prefix of a long option (measured on git 2.53: `push --e`,
  // `fetch --upl`, `clone --co` and `ls-remote --upload-p` are each taken as the option, which then asks for its
  // value). In the subcommands that have one of these options, every prefix of it is refused.
  it('blocks an abbreviated forbidden option in the subcommands that have it', async () => {
    const nowhere = path.join(os.tmpdir(), 'cynco-git-no-such-folder', 'evil.sh')
    const calls: Array<Record<string, string>> = [
      { subcommand: 'fetch', args: `--upl=${nowhere} origin` },
      { subcommand: 'ls-remote', args: `--upload-p=${nowhere} x` },
      { subcommand: 'archive', args: `--remote=x --exe=${nowhere} HEAD` },
      { subcommand: 'push', args: `--e=${nowhere} origin main` },
      { subcommand: 'push', args: `--rece=${nowhere} origin main` },
      { subcommand: 'clone', args: `--co=core.sshCommand=${nowhere} x y` },
      { subcommand: 'pull', args: `--upl ${nowhere}` },
      { subcommand: '-C . fetch', args: `--upl=${nowhere} origin` },
    ]
    const notBlocked: string[] = []
    for (const input of calls) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      if (!result.isError || !result.output.includes('dangerous git command blocked') || !result.output.includes('can execute arbitrary programs')) {
        notBlocked.push(`${JSON.stringify(input)} -> ${result.output.slice(0, 80)}`)
      }
    }
    expect(notBlocked).toEqual([])
    // Elsewhere a short option of the same letters is another option: `git add --u` is git's own question.
    for (const input of [{ subcommand: 'add', args: '--u x' }, { subcommand: 'log', args: '--reverse -1' }, { subcommand: 'push', args: '--recurse-submodules=check --dry-run origin main' }]) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      expect(result.output, JSON.stringify(input)).not.toContain('blocked')
    }
  })

  // Wave 15c: the other subcommands of the rule (the check's cheapest surviving mutant removed them unseen), and a
  // command word git does not know, which is an alias (possibly the repository's own: `alias.x = fetch`) or a
  // `git-<word>` program.
  it('blocks an abbreviated forbidden option in send-pack, fetch-pack, remote and submodule, and after an alias', async () => {
    const nowhere = path.join(os.tmpdir(), 'cynco-git-no-such-folder', 'evil.sh')
    const calls: Array<Record<string, string>> = [
      { subcommand: 'send-pack', args: `--rece=${nowhere} x main` },
      { subcommand: 'fetch-pack', args: `--upl=${nowhere} x` },
      { subcommand: 'remote', args: `--upl=${nowhere} show origin` },
      { subcommand: 'submodule', args: `--co=core.sshCommand=${nowhere} update` },
      { subcommand: 'x', args: `--upl=${nowhere} origin` },
      { subcommand: '-C . myfetch', args: `--e=${nowhere} origin` },
      { subcommand: '-c user.name=t sync', args: `--rec=${nowhere}` },
    ]
    const notBlocked: string[] = []
    for (const input of calls) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      if (!result.isError || !result.output.includes('dangerous git command blocked') || !result.output.includes('can execute arbitrary programs')) {
        notBlocked.push(`${JSON.stringify(input)} -> ${result.output.slice(0, 80)}`)
      }
    }
    expect(notBlocked).toEqual([])
    // git's own commands without these options still reach git; so does an alias given none of them.
    for (const input of [{ subcommand: 'add', args: '--u x' }, { subcommand: 'commit', args: '--e --dry-run' }, { subcommand: 'x', args: '--verbose' }]) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      expect(result.output, JSON.stringify(input)).not.toContain('blocked')
    }
  })

  // Wave 19, C2: rebase takes `--exe` and `--ex` for `--exec` (git 2.53: "option `exec' requires a value"), and
  // rebase and difftool take `-x` alone, in a cluster (`-ix`, `-yx`) or with its value glued on. difftool does not
  // abbreviate `--extcmd` ("invalid option: --extc"), so only the whole name is refused there.
  // 19b, C19-5: the other commands git runs (measured on git 2.53, phase3\w19\scratch\c\out-b\gitprobe-b.out).
  it('blocks bisect run, send-email\'s command options and instaweb\'s httpd and browser (19b)', async () => {
    const nowhere = path.join(os.tmpdir(), 'cynco-git-no-such-folder', 'evil.sh')
    const calls: Array<Record<string, string>> = [
      { subcommand: 'bisect', args: `run ${nowhere}` },
      { subcommand: 'bisect run', args: nowhere },
      { subcommand: 'send-email', args: `--to-cmd=${nowhere} x.patch` },
      { subcommand: 'send-email', args: `--cc-cmd ${nowhere} x.patch` },
      { subcommand: 'send-email', args: `--header-cmd=${nowhere} x.patch` },
      { subcommand: 'send-email', args: `--sendmail-cmd ${nowhere} x.patch` },
      { subcommand: 'send-email', args: `--smtp-server=${nowhere} x.patch` },
      { subcommand: 'send-email', args: `--smtp-server ${nowhere} x.patch` },
      { subcommand: 'instaweb', args: `--httpd=${nowhere} --start` },
      { subcommand: 'instaweb', args: `--h ${nowhere} --start` },
      { subcommand: 'instaweb', args: `-d ${nowhere}` },
      { subcommand: 'instaweb', args: `-ld ${nowhere}` },
      { subcommand: 'instaweb', args: `--browser ${nowhere}` },
      { subcommand: 'instaweb', args: `--b=${nowhere}` },
      { subcommand: 'instaweb', args: `-b${nowhere}` },
    ]
    const notBlocked: string[] = []
    for (const input of calls) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      if (!result.isError || !result.output.includes('dangerous git command blocked') || !result.output.includes('can execute arbitrary programs')) {
        notBlocked.push(`${JSON.stringify(input)} -> ${result.output.slice(0, 80)}`)
      }
    }
    expect(notBlocked).toEqual([])
    // bisect's other steps, instaweb's stop and an SMTP server by its name still reach git.
    for (const input of [{ subcommand: 'bisect', args: 'start HEAD HEAD~3' }, { subcommand: 'bisect', args: 'good' },
      { subcommand: 'bisect', args: 'log' }, { subcommand: 'instaweb', args: '--stop' },
      { subcommand: 'send-email', args: '--smtp-server smtp.example.com --dry-run x.patch' },
      { subcommand: 'send-email', args: '--smtp-server=smtp.example.com --dry-run x.patch' }]) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      expect(result.output, JSON.stringify(input)).not.toContain('blocked')
    }
  })

  it('blocks rebase --exec by any prefix and -x of rebase and difftool in any form', async () => {
    const nowhere = path.join(os.tmpdir(), 'cynco-git-no-such-folder', 'evil.sh')
    const calls: Array<Record<string, string>> = [
      { subcommand: 'rebase', args: `--exe ${nowhere} HEAD~1` },
      { subcommand: 'rebase', args: `--ex=${nowhere} HEAD~1` },
      { subcommand: 'rebase', args: `-x ${nowhere} HEAD~1` },
      { subcommand: 'rebase', args: `-ix ${nowhere} HEAD~2` },
      { subcommand: 'rebase', args: `-x${nowhere} HEAD~1` },
      { subcommand: '-C . rebase', args: `--exe=${nowhere}` },
      { subcommand: 'difftool', args: `-x ${nowhere}` },
      { subcommand: 'difftool', args: `-yx ${nowhere}` },
      { subcommand: 'difftool', args: `--extcmd=${nowhere}` },
      // 19b, C19-6: every letter of the cluster classes, so a letter dropped from either lets its form through.
      ...['f', 'k', 'm', 'n', 'q', 'r', 'v'].map(l => ({ subcommand: 'rebase', args: `-${l}x ${nowhere} HEAD~1` })),
      { subcommand: 'difftool', args: `-gx ${nowhere}` },
      { subcommand: 'difftool', args: `-dx ${nowhere}` },
    ]
    const notBlocked: string[] = []
    for (const input of calls) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      if (!result.isError || !result.output.includes('dangerous git command blocked') || !result.output.includes('can execute arbitrary programs')) {
        notBlocked.push(`${JSON.stringify(input)} -> ${result.output.slice(0, 80)}`)
      }
    }
    expect(notBlocked).toEqual([])
    // rebase's and difftool's other options, and an identity setting before a command whose own option starts like a
    // forbidden one (C9: `-c` and `-C` take a value, so the command word stays `commit`), still reach git.
    for (const input of [{ subcommand: 'rebase', args: '--continue' }, { subcommand: 'rebase', args: '--empty=drop main' },
      { subcommand: 'rebase', args: '-Xours main' }, { subcommand: 'difftool', args: '--extc' }, { subcommand: 'difftool', args: '-y HEAD' },
      { subcommand: '-c user.name=t -c user.email=t@t commit', args: '--e --dry-run' }, { subcommand: '-C . commit', args: '--e --dry-run' }]) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      expect(result.output, JSON.stringify(input)).not.toContain('blocked')
    }
  })

  it('still runs identity settings and plain options written as the subcommand', async () => {
    for (const input of [
      { subcommand: '-c user.name=t -c user.email=t@t commit', args: '--allow-empty -m x --dry-run' },
      { subcommand: '--version' },
      { subcommand: '--exec-path' },
    ]) {
      const result = await gitTool.execute(input, NON_REPO_CWD)
      expect(result.output, JSON.stringify(input)).not.toContain('blocked')
    }
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

// F242, slice S5: the exit code of git rides on the result; a guard refusal carries none.
describe('Git exitCode', () => {
  it('is 0 for status, git\'s own status for a failing subcommand, absent for a blocked command', async () => {
    const ok = await gitTool.execute({ subcommand: 'status' }, OWN_REPO)
    expect(ok.isError).toBe(false)
    expect(ok.exitCode).toBe(0)
    const bad = await gitTool.execute({ subcommand: 'rev-parse', args: '--verify no-such-ref-xyz' }, OWN_REPO)
    expect(bad.isError).toBe(true)
    expect(typeof bad.exitCode).toBe('number')
    expect(bad.exitCode).not.toBe(0)
    const blocked = await gitTool.execute({ subcommand: 'push', args: '--force origin main' }, NON_REPO_CWD)
    expect(blocked.output).toContain('dangerous git command blocked')
    expect('exitCode' in blocked).toBe(false)
  })
})
