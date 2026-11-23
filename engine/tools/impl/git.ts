import type { ToolImpl } from '../types.js'
import { containedCommand, launcherFaultOf, toolSpawnRefusal, type ContainedSpawn } from '../../containment.js'
import { ownProcessTree } from '../../processTree.js'
import { bashDefaultTimeoutMs } from './bash.js'

const DANGEROUS_PATTERNS = [/push\s+(--force\b|-f\b)/, /reset\s+--hard/, /clean\s+-f/, /branch\s+-D/]

// Argument injection: git executes the VALUES of these options as programs,
// so they're blocked outright even though they contain no shell metacharacters.
const FORBIDDEN_OPTIONS = [/^--upload-pack(=|$)/, /^--receive-pack(=|$)/, /^--exec(=|$)/, /^--config(=|$)/]

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

/**
 * Assemble git's argv, hoisting allowed `-c key=value` pairs ahead of the
 * subcommand.
 *
 * git only honours `-c` BEFORE the subcommand. Everything the model writes
 * arrives in `args`, which lands AFTER it — where `-c` is not config at all
 * but an argument to the subcommand, and `git commit -c <commit>` silently
 * means "reuse that commit's message". So the hoist is not cosmetic: without
 * it, allowing the option would be worse than blocking it.
 *
 * A bare `-c` whose next token has no `=` is left in place: that is
 * `switch -c <branch>`, a different option entirely.
 *
 * Exported for unit testing.
 */
export function buildArgv(sub: string, argTokens: string[]): string[] {
  const config: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argTokens.length; i++) {
    const token = argTokens[i]
    const next = argTokens[i + 1]
    if (token === '-c' && next?.includes('=')) {
      config.push('-c', next)
      i++
      continue
    }
    rest.push(token)
  }
  return [...config, sub, ...rest]
}

/** Quote-aware argument tokenizer — handles single and double quotes.
 *  Exported for unit testing. */
export function tokenizeArgs(args: string): string[] {
  if (!args.trim()) return []
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let quoteChar = ''
  let wasInQuotes = false  // tracks whether we just closed a quoted region
  for (let i = 0; i < args.length; i++) {
    const char = args[i]
    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true
      quoteChar = char
      wasInQuotes = false
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false
      quoteChar = ''
      wasInQuotes = true
    } else if (!inQuotes && /\s/.test(char)) {
      if (current || wasInQuotes) { tokens.push(current); current = '' }
      wasInQuotes = false
    } else {
      current += char
      wasInQuotes = false
    }
  }
  if (current || wasInQuotes) tokens.push(current)
  return tokens
}

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
    if (c.viaLauncher && launcherFaultOf(r.exitCode, r.stderr)) return []
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
  const tree = ownProcessTree(proc.pid)
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
    // would execute as programs. argTokens already carries anything split off
    // the subcommand field, so those tokens are checked too.
    for (let i = 0; i < argTokens.length; i++) {
      const token = argTokens[i]
      if (FORBIDDEN_OPTIONS.some((p) => p.test(token))) {
        return { output: `Error: dangerous git command blocked: ${fullCmd}. Option ${token.split('=')[0]} can execute arbitrary programs.`, isError: true }
      }
      // Config-style `-c name=value` injects settings like core.sshCommand.
      // Bare -c without a key=value next token stays allowed (switch -c <branch>).
      // Identity keys are allowlisted; the comparison is on the WHOLE key so
      // `user.namex` cannot ride in on `user.name`'s prefix, and it is
      // case-folded because git config key lookup is case-insensitive.
      if (token === '-c' && argTokens[i + 1]?.includes('=')) {
        const key = argTokens[i + 1].slice(0, argTokens[i + 1].indexOf('=')).toLowerCase()
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
        }
      }
      // 197 / 198 from the launcher with its named line: git did not run (or ended with no status).
      const fault = c.viaLauncher ? launcherFaultOf(exitCode, stderr) : null
      if (fault) return { output: fault.text, isError: true }
      if (exitCode !== 0) {
        // Both streams, because git does not put its diagnostics where you would
        // expect. A `git commit` with nothing staged exits 1 with stderr EMPTY and
        // the entire explanation ("nothing added to commit but untracked files
        // present") on stdout. Reporting stderr alone showed the agent nothing but
        // "exited with code 1", and it had to spend a turn running `git status` to
        // learn what any human would have read off the failure itself.
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        return { output: detail || `git ${sub} exited with code ${exitCode}`, isError: true }
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
          }
        }
      }
      return { output: stdout || '(no output)', isError: false }
    } catch (err) {
      return { output: `Git error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
