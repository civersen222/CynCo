import type { ToolImpl } from '../types.js'
import { containedCommand, launcherFaultOf, toolSpawnRefusal, type ContainedSpawn } from '../../containment.js'
import { ownProcessTree } from '../../processTree.js'
import { bashDefaultTimeoutMs } from './bash.js'
import { buildArgv, tokenizeArgs } from '../gitArgv.js'
import { GIT_MAIN_COMMANDS } from '../shellPaths.js'

const DANGEROUS_PATTERNS = [/push\s+(--force\b|-f\b)/, /reset\s+--hard/, /clean\s+-f/, /branch\s+-D/]

// Argument injection: git executes the VALUES of these options as programs,
// so they're blocked outright even though they contain no shell metacharacters.
// `--exec-path=<dir>` makes git run its subcommands from that folder and `--config-env=<key>=<var>` loads a
// setting (core.sshCommand among them) from a variable; `--exec-path` alone only prints the folder.
const FORBIDDEN_OPTIONS = [/^--upload-pack(=|$)/, /^--receive-pack(=|$)/, /^--exec(=|$)/, /^--config(=|$)/, /^--exec-path=/, /^--config-env(=|$)/]

/**
 * git's option parser takes any unique prefix of a subcommand's long option (measured on git 2.53, wave 15b: `push
 * --e`, `fetch --upl`, `clone --co` and `ls-remote --upload-p` are each taken as the option). In a subcommand that
 * has one of these options, a prefix of it, of any length, is refused (`--e=<program>` alone reaches `push --exec`).
 * Elsewhere the same letters are another option's prefix (`add --u` could be `--update` or `--unified`, and git says
 * so; `commit --e` is `--edit`; measured on git 2.53, wave 15c) and are left to git. git's own
 * options before the subcommand (`--exec-path`, `--config-env`) take no prefix. A command word git does not know
 * (`GIT_MAIN_COMMANDS`) is an alias, possibly from the repository's own configuration, which a run can write
 * (`alias.x = fetch`), or a `git-<word>` program: the same rule holds for it (wave 15c).
 */
const ABBREVIATED_SUBCOMMANDS = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'push', 'archive', 'send-pack', 'fetch-pack', 'remote', 'submodule'])
const ABBREVIABLE_OPTIONS = ['upload-pack', 'receive-pack', 'exec', 'config']
function abbreviatedForbidden(token: string): boolean {
  const m = token.match(/^--([a-z][a-z-]*)(?:=|$)/)
  return m !== null && ABBREVIABLE_OPTIONS.some(o => o.startsWith(m[1]))
}
/**
 * The options of rebase and difftool that name a program git runs, in every form git takes (measured on git 2.53,
 * wave 19, C2): rebase's `--exec` by any prefix from `--e` on (`--exe`, `--ex` are taken; `--e` is ambiguous and
 * refused by git, and refused here as well), and `-x` alone, at the end of a cluster of their switches (`-ix`, `-yx`)
 * or with its value glued on (`-xmake`). difftool does not abbreviate `--extcmd` ("invalid option: --extc"). `--exec`
 * itself was already refused by `FORBIDDEN_OPTIONS`; `-x` and the prefixes reached git until wave 19.
 */
const RUN_OPTION: Record<string, RegExp> = {
  rebase: /^(?:-[ifkmnqrv]*x|--e(?:x(?:e(?:c)?)?)?(?:=|$))/,
  difftool: /^(?:-[ygd]*x|--extcmd(?:=|$))/,
  // 19b, C19-5 (measured on git 2.53): send-email runs these by their exact names, and an SMTP server given as a path
  // is started as a sendmail program (by its name it is a server, and passes); instaweb starts its httpd and browser,
  // by any prefix down to `--h` and `--b`, and `-d` / `-b` alone, after its `-l` switch or with the value glued on.
  'send-email': /^(?:--(?:to-cmd|cc-cmd|header-cmd|sendmail-cmd)(?:=|$)|--smtp-server=.*[\\/])/,
  instaweb: /^(?:-l*[db]|--h(?:t(?:t(?:p(?:d)?)?)?)?(?:=|$)|--b(?:r(?:o(?:w(?:s(?:e(?:r)?)?)?)?)?)?(?:=|$))/,
}

/** `git bisect run <cmd>`: git runs the command through its shell (19b, C19-5). */
const RUN_STEP: Record<string, string> = { bisect: 'run' }

/** git's own options that take the next word as their value, before the command word. */
const GIT_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--list-cmds'])
/** The command word of git's argv as the tool builds it: the first word that is neither an option nor an option's value. */
function commandWord(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (GIT_VALUE_OPTIONS.has(t)) { i++; continue }
    if (t.startsWith('-')) continue
    return t
  }
  return null
}

const SHELL_METACHAR = /[;&|`$(){}]/

// The only inline config the agent has a legitimate reason to set. Every other
// key stays blocked, because git executes the values of several of them
// (core.sshCommand, core.pager, credential.helper, alias.*) as programs.
//
// Blocking ALL of `-c` was the previous rule, and it made the correct action
// impossible: three consecutive missions were briefed to commit as
// `git -c user.name=... -c user.email=... commit` and all three shipped commits
// stamped with the repo's placeholder identity, because this tool refused the
// only spelling that works. A guard that forbids the right thing does not
// prevent the wrong thing; it mandates it.
const ALLOWED_CONFIG_KEYS = new Set(['user.name', 'user.email'])

// buildArgv and tokenizeArgs live in a leaf module so toolPaths.ts can use them without an import cycle.
export { buildArgv, tokenizeArgs }

/**
 * Returns the portion of `args` that lies OUTSIDE quoted regions.
 * Used to check shell metacharacters only on the unquoted parts —
 * metacharacters inside quotes are inert when args are passed via
 * array-based Bun.spawn.
 */
function unquotedParts(args: string): string {
  let result = ''
  let inQuotes = false
  let quoteChar = ''
  for (let i = 0; i < args.length; i++) {
    const char = args[i]
    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true
      quoteChar = char
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false
      quoteChar = ''
    } else if (!inQuotes) {
      result += char
    }
  }
  return result
}

/**
 * Paths git tracks that are still modified in the working tree.
 *
 * `--porcelain` codes are two columns, index then worktree. A path is a leftover
 * when the worktree column is non-blank (`M`, `D`, `T`) — its index column may be
 * anything, since partially staging a file and committing leaves the rest behind
 * just the same. `??` is untracked and excluded by the same rule that excludes it
 * from a commit's scope: git has never seen it, so it cannot be a hole in what
 * was just delivered.
 *
 * Returns [] on any failure. This runs after a commit that already succeeded;
 * a diagnostic that can turn a success into an error is worse than no diagnostic.
 */
async function trackedModificationsRemaining(cwd: string, signal?: AbortSignal): Promise<string[]> {
  // F242: started like the tool's own git (contained in an unattended run); a refusal or a
  // launcher that could not run is "failure", so [].
  if (toolSpawnRefusal()) return []
  try {
    const c = containedCommand({ file: 'git', args: ['status', '--porcelain'] }, { cwd, extraEnv: GIT_TOOL_ENV })
    const r = await runOwned(c, signal)
    if (r.ended !== null) return []
    if (c.viaLauncher && launcherFaultOf(r.exitCode, r.stderr, c.seal)) return []
    if (r.exitCode !== 0) return []
    return r.stdout.split('\n')
      .filter(l => l.length > 3 && l.slice(0, 2) !== '??' && l[1] !== ' ')
      .map(l => l.slice(3).trim())
  } catch {
    return []
  }
}

/**
 * What the tool's git is given on top of the tool environment, so that nothing it starts waits on
 * a person: no credential prompt, and `:` as the editor (git runs no program for it), so a commit
 * with no message is refused at once instead of waiting on an editor that never closes.
 */
const GIT_TOOL_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: ':',
  GIT_SEQUENCE_EDITOR: ':',
  GCM_INTERACTIVE: 'never',
}

/** How long a stopped or timed-out git may keep its pipes before the call returns anyway. */
const STOP_GRACE_MS = 2000

/**
 * Runs `c` with its tree owned from the start (F201, F210): the turn's Stop and the cap
 * (`bashDefaultTimeoutMs`, what a Bash call gets unasked) kill git and whatever it started (a hook,
 * a filter, a credential helper). `ended` says which of the two ended it, or null.
 */
async function runOwned(c: ContainedSpawn, signal?: AbortSignal, capMs = bashDefaultTimeoutMs())
  : Promise<{ stdout: string; stderr: string; exitCode: number | null; ended: 'stopped' | 'timeout' | null }> {
  if (signal?.aborted) return { stdout: '', stderr: '', exitCode: null, ended: 'stopped' }
  const proc = Bun.spawn([c.file, ...c.args], { cwd: c.cwd, env: c.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  // The process, not its pid: a walked tree is never killed by the number once git's exit was handled (F255).
  const tree = ownProcessTree(proc)
  let ended: 'stopped' | 'timeout' | null = null
  let giveUp: () => void = () => {}
  const gaveUp = new Promise<void>(resolve => { giveUp = resolve })
  const killFor = (why: 'stopped' | 'timeout'): void => {
    if (ended !== null) return
    ended = why
    void tree.kill()
    setTimeout(giveUp, STOP_GRACE_MS)
  }
  const onAbort = (): void => killFor('stopped')
  const deadline = setTimeout(() => killFor('timeout'), capMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const read = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const r = await Promise.race([read, gaveUp.then(() => null)])
    if (r === null) return { stdout: '', stderr: '', exitCode: null, ended }
    return { stdout: r[0], stderr: r[1], exitCode: proc.exitCode, ended }
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', onAbort)
    // A git that ended on its own gives its handle back; one that was killed has none left.
    if (ended === null) tree.release()
  }
}

export const gitTool: ToolImpl = {
  name: 'Git',
  description: 'Run git commands. Read-only commands (status, log, diff) auto-approve. Write commands (commit, checkout) require approval. Dangerous commands (push --force, reset --hard) are blocked. To commit under a specific identity, put the config in args: subcommand "commit", args \'-c user.name=NAME -c user.email=EMAIL -m "message"\' — user.name and user.email are the only -c keys allowed, and they are moved ahead of the subcommand for you.',
  inputSchema: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', description: 'Git subcommand: status, log, diff, commit, checkout, branch, etc.' },
      args: { type: 'string', description: 'Additional arguments for the git command' },
    },
    required: ['subcommand'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd, signal) => {
    const rawSub = input.subcommand as string
    const args = (input.args as string) ?? ''
    const fullCmd = `git ${rawSub} ${args}`.trim()

    // A model that writes subcommand:"status --porcelain" means exactly what
    // subcommand:"status", args:"--porcelain" means. Git does not agree: the
    // whole string arrives as one argv element and it answers
    //   git: 'status --porcelain' is not a git command
    // which reads like a broken repo rather than a malformed call. Split here
    // so both spellings run. Every guard below still evaluates `rawSub`, the
    // unsplit string, so nothing moves from the strict check to the lax one.
    const subTokens = tokenizeArgs(rawSub)
    const sub = subTokens[0] ?? rawSub
    const argTokens = [...subTokens.slice(1), ...tokenizeArgs(args)]

    // Check dangerous patterns against BOTH raw form and normalized tokenized form
    // so that quoted --force (e.g. '"--force"') is also caught.
    const tokenizedCmd = [sub, ...argTokens].join(' ')
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(fullCmd) || pattern.test(tokenizedCmd)) {
        return { output: `Error: dangerous git command blocked: ${fullCmd}. This could cause data loss.`, isError: true }
      }
    }

    // Metachar guard: check the subcommand field as SUBMITTED — the whole
    // unsplit string, with no quote exemption — so folding extra words into it
    // cannot buy the laxer treatment `args` gets. For `args` only the UNQUOTED
    // regions are checked; metacharacters inside quotes are inert when passed
    // via array-based spawn.
    if (SHELL_METACHAR.test(rawSub) || SHELL_METACHAR.test(unquotedParts(args))) {
      return { output: `Error: dangerous git command blocked: ${fullCmd}. Shell metacharacters not allowed.`, isError: true }
    }

    // Argument-injection guard: per-token check for options whose values git
    // would execute as programs. The subcommand field's own first word is checked
    // as well: buildArgv puts it first in git's argv, where git reads `-c` and its
    // other options as its own (it was not checked until 2026-11-24, so
    // subcommand `-c core.sshCommand=...` reached git); argTokens already carries
    // anything else split off the subcommand field.
    const checked = [sub, ...argTokens]
    const word = commandWord(checked)
    const abbreviates = checked.some(t => ABBREVIATED_SUBCOMMANDS.has(t.toLowerCase())) || (word !== null && !GIT_MAIN_COMMANDS.has(word))
    const runOption = word !== null && Object.prototype.hasOwnProperty.call(RUN_OPTION, word.toLowerCase()) ? RUN_OPTION[word.toLowerCase()] : null
    const afterWord = word === null ? checked.length : checked.indexOf(word) + 1
    const step = word !== null && Object.prototype.hasOwnProperty.call(RUN_STEP, word.toLowerCase()) ? RUN_STEP[word.toLowerCase()] : null
    if (step !== null && checked[afterWord]?.toLowerCase() === step) {
      return { output: `Error: dangerous git command blocked: ${fullCmd}. git ${word} ${step} can execute arbitrary programs.`, isError: true }
    }
    for (let i = 0; i < checked.length; i++) {
      const token = checked[i]
      if (FORBIDDEN_OPTIONS.some((p) => p.test(token)) || (abbreviates && abbreviatedForbidden(token)) || (runOption !== null && i >= afterWord && runOption.test(token))
        || (word?.toLowerCase() === 'send-email' && i >= afterWord && token === '--smtp-server' && /[\\/]/.test(checked[i + 1] ?? ''))) {
        return { output: `Error: dangerous git command blocked: ${fullCmd}. Option ${token.split('=')[0]} can execute arbitrary programs.`, isError: true }
      }
      // Config-style `-c name=value` injects settings like core.sshCommand.
      // Bare -c without a key=value next token stays allowed (switch -c <branch>).
      // Identity keys are allowlisted; the comparison is on the WHOLE key so
      // `user.namex` cannot ride in on `user.name`'s prefix, and it is
      // case-folded because git config key lookup is case-insensitive.
      if (token === '-c' && checked[i + 1]?.includes('=')) {
        const key = checked[i + 1].slice(0, checked[i + 1].indexOf('=')).toLowerCase()
        if (!ALLOWED_CONFIG_KEYS.has(key)) {
          return { output: `Error: dangerous git command blocked: ${fullCmd}. Inline config (-c ${key}=...) not allowed; only ${[...ALLOWED_CONFIG_KEYS].join(', ')} may be set this way.`, isError: true }
        }
      }
    }

    // F242: this is the run's own git, so in an unattended run it starts through the containment
    // (low integrity on Windows, the sandbox as home) and keeps the repository's own hooks and
    // settings; it gets no harnessGitEnv. A run whose launcher cannot run starts nothing.
    const refusal = toolSpawnRefusal()
    if (refusal) return { output: refusal, isError: true }

    try {
      const c = containedCommand({ file: 'git', args: buildArgv(sub, argTokens) }, { cwd, extraEnv: GIT_TOOL_ENV })
      const { stdout, stderr, exitCode, ended } = await runOwned(c, signal)
      if (ended !== null) {
        const partial = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n') || '(nothing)'
        return {
          output: ended === 'stopped'
            ? `git ${sub} stopped: the turn was stopped, and git and what it started were ended. Output so far:\n${partial}`
            : `git ${sub} timeout after ${bashDefaultTimeoutMs()}ms: git and what it started (a hook, a filter, a credential helper) were ended. Output so far:\n${partial}`,
          isError: true,
          // Started and ended without a status, as Bash's Stop and timeout (types.ts).
          exitCode: null,
        }
      }
      // The launcher's own sealed 197: git did not run, so no exit code (a refusal made before a
      // process ran). Its sealed 198 (git ended with no status) and Bun's EPERM line came from a
      // process that ran: they carry the status (review of slice S5).
      const fault = c.viaLauncher ? launcherFaultOf(exitCode, stderr, c.seal) : null
      if (fault) return fault.ran ? { output: fault.text, isError: true, exitCode: fault.exitCode } : { output: fault.text, isError: true }
      if (exitCode !== 0) {
        // Both streams, because git does not put its diagnostics where you would
        // expect. A `git commit` with nothing staged exits 1 with stderr EMPTY and
        // the entire explanation ("nothing added to commit but untracked files
        // present") on stdout. Reporting stderr alone showed the agent nothing but
        // "exited with code 1", and it had to spend a turn running `git status` to
        // learn what any human would have read off the failure itself.
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        return { output: detail || `git ${sub} exited with code ${exitCode}`, isError: true, exitCode }
      }
      // A commit is a claim that the work has been delivered, and the workspace
      // is not the delivery. Watched live: a run staged exactly the two files
      // its contract named, committed, and stopped — while a third tracked file
      // holding the whole foundation of the feature stayed modified in the tree.
      // HEAD did not import. The harness, the test suite and diffClean were all
      // green, because every one of them reads the working tree.
      //
      // git already knows; nobody asked it at the moment the answer mattered.
      // Reported, never blocked: unrelated dirt is legitimate work-in-progress
      // and only the agent can tell which is which. Untracked files are excluded
      // — a file git has never seen cannot be a gap in what was just delivered.
      if (sub === 'commit') {
        const left = await trackedModificationsRemaining(cwd, signal)
        if (left.length > 0) {
          return {
            output: `${stdout || '(no output)'}\n\n[git] ${left.length} tracked file(s) still modified and NOT in this commit:\n` +
              left.map(p => `  ${p}`).join('\n') +
              `\nIf the committed code depends on any of them, HEAD is broken even though the working tree works.`,
            isError: false,
            exitCode: 0,
          }
        }
      }
      return { output: stdout || '(no output)', isError: false, exitCode: 0 }
    } catch (err) {
      return { output: `Git error: ${err instanceof Error ? err.message : String(err)}`, isError: true, exitCode: null }
    }
  },
}
