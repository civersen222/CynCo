/**
 * shellInfo.ts — detect the actual shell the Bash tool uses, and its dialect.
 *
 * Windows PowerShell 5.1 does not support `&&` / `||` pipeline-chain
 * operators (PowerShell 7+ does). Local models constantly emit bash-style
 * `a && b`, which 5.1 rejects with a confusing parse error. We:
 *   1. Prefer pwsh.exe (PowerShell 7) when installed,
 *   2. Surface the real dialect in the tool description + system prompt,
 *   3. Pre-flight-reject && / || on 5.1 with an instructive, deterministic
 *      error (one cheap turn instead of a cryptic parse failure).
 *   4. TRANSLATE the POSIX `NAME=value command` env prefix rather than reject it,
 *      wherever the translation provably means the same thing. Instructing costs
 *      a turn every time it happens, and it kept happening — five occurrences on
 *      one run, long after the error had taught the lesson once.
 */
import { execFileSync } from 'child_process'

export type ShellInfo = {
  shell: string           // executable passed to exec()
  displayName: string     // human-readable name for prompts/descriptions
  supportsAndAnd: boolean // whether && / || work in this shell
  isPowerShell: boolean   // `NAME=value command` is a parse error in every PowerShell
  dialectNote: string     // one-line dialect guidance for the system prompt
}

export function classifyShell(platform: string, hasPwsh: boolean): ShellInfo {
  if (platform !== 'win32') {
    return {
      shell: '/bin/bash',
      displayName: 'bash',
      supportsAndAnd: true,
      isPowerShell: false,
      dialectNote: 'Shell is bash. Standard POSIX syntax (&&, ||, pipes) works.',
    }
  }
  if (hasPwsh) {
    return {
      shell: 'pwsh.exe',
      displayName: 'PowerShell 7 (pwsh)',
      supportsAndAnd: true,
      isPowerShell: true,
      dialectNote: 'Shell is PowerShell 7 (pwsh). && and || are supported. Use PowerShell cmdlets, not Unix commands. A POSIX env-var prefix (NAME=value command) is translated for you when the command is the whole remainder; to carry a variable across a sequence, write $env:NAME="value"; yourself.',
    }
  }
  return {
    shell: 'powershell.exe',
    displayName: 'Windows PowerShell 5.1',
    supportsAndAnd: false,
    isPowerShell: true,
    dialectNote: "Shell is Windows PowerShell 5.1 — '&&' and '||' are NOT supported. Sequence commands with ';' (e.g. 'cd proj; python -m pytest') or use 'if ($?) { ... }' for conditional chaining. A POSIX env-var prefix (NAME=value command) is translated for you when the command is the whole remainder; to carry a variable across a sequence, write $env:NAME=\"value\"; yourself.",
  }
}

/**
 * A leading run of `NAME=value` assignments — the POSIX way to set variables for
 * one command, and the first thing anyone reaches for because briefs are written
 * that way. Anchored to the start of a command (string start or after `;`) so an
 * ordinary argument that happens to contain `=` is left alone.
 */
const ENV_PREFIX = /(?:^|;)\s*((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)(?=\S)/

/**
 * Rewrite a POSIX env prefix into this shell's dialect, or return the command
 * unchanged when there is nothing to rewrite.
 *
 * `NAME=value command` means the same thing in every shell that has a way to
 * say it, so this is a translation and not a guess — which is what makes it
 * safe to apply to a command the engine runs on its own behalf (a harness
 * contract check) rather than only quoting back at the model.
 */
export function translateEnvPrefix(command: string, info: ShellInfo): string {
  if (!info.isPowerShell) return command
  const prefix = ENV_PREFIX.exec(command)
  if (!prefix) return command
  // A `;` inside a string argument is not a command separator, so the thing that
  // looks like a prefix after it is just words. `git commit -m "fix; VAR=1 broke"`
  // matched here and came back requoted into a different command. That reaches
  // further than the auto-translation: checkShellDialect compares this result to
  // the original and, when they differ, REFUSES the command and quotes the
  // mangled form back as the fix — so a valid commit message with a semicolon in
  // it was blocked, with advice that would have broken it.
  if (endsInsideQuote(command.slice(0, prefix.index))) return command
  const sets = prefix[1]
    .trim()
    .split(/\s+/)
    .map(pair => {
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1).replace(/^["']|["']$/g, '')
      return `$env:${name}="${value}"`
    })
  // ENV_PREFIX anchors on `^` OR `;`, so in `cd proj; FOO=1 pytest` the match
  // begins at the semicolon — and slicing from the match's start threw the `cd`
  // away. Keep the head. This is a silent wrong answer if left in:
  // verifyAssertion runs what this returns, so a contract that changed directory
  // first would have been measured somewhere else and the verdict believed.
  const head = command.slice(0, prefix.index)
  const tail = command.slice(prefix.index + prefix[0].length)
  return `${head}${head ? '; ' : ''}${sets.join('; ')}; ${tail}`
}

/**
 * True when `text` ends part-way through a quoted string.
 *
 * Tracks which quote is open rather than counting quote characters, because an
 * apostrophe inside a double-quoted string is an ordinary letter. Counting is
 * the mistake stripTrailingStderrMerge's comment records: a parity check there
 * made `git commit -m "don't break it"` look unbalanced and withdrew the fix
 * from exactly the commands models write.
 */
function endsInsideQuote(text: string): boolean {
  let open: string | null = null
  for (const ch of text) {
    if (open) {
      if (ch === open) open = null
    } else if (ch === '"' || ch === "'") {
      open = ch
    }
  }
  return open !== null
}

/**
 * The translation to apply automatically on the model's behalf, or null when
 * there isn't one that provably means the same thing.
 *
 * POSIX `NAME=value cmd` scopes the variable to a single command; `$env:NAME=...;
 * cmd` scopes it to the rest of the shell. Those agree exactly when nothing runs
 * AFTER the prefixed command — because every Bash call spawns a fresh shell that
 * exits when the command does, so a widened scope has nothing left to leak into.
 *
 * The rule used to be "the prefix must be at position 0", which is stricter than
 * that argument requires and refused `cd proj; FOO=1 pytest` — the shape mission
 * briefs are actually written in, and 21 of mission 11N's 177 errors. Everything
 * before the prefix is carried through verbatim by translateEnvPrefix and runs
 * before the assignment either way, so a head is harmless; only a TAIL can be
 * handed a variable it was scoped away from. Refusals here fall through to the
 * instructive error in `checkShellDialect`, so the cost of refusing is a turn.
 */
export function autoTranslateEnvPrefix(command: string, info: ShellInfo): string | null {
  if (!info.isPowerShell) return null
  const prefix = ENV_PREFIX.exec(command)
  if (!prefix) return null
  // ENV_PREFIX anchors on any `;`, including one inside a string argument, so
  // `git commit -m "fix; VAR=1 broke"` matches inside the message. That was
  // unreachable while the prefix had to come first; now it has to be refused, or
  // bash.ts executes a command with different words and different quoting than
  // the model wrote. If the head ends mid-string, the `;` we matched on is not a
  // command separator at all.
  if (endsInsideQuote(command.slice(0, prefix.index))) return null
  // Note the offset: prefix.index, not 0. prefix[0] starts at the `;`, so the
  // old `command.slice(prefix[0].length)` was only ever correct because index
  // was pinned to 0 — on `cd proj; FOO=1 python` it would have cut the tail to
  // "RATE=0 python" and tested the wrong text for a following command.
  const tail = command.slice(prefix.index + prefix[0].length)
  if (/;|&&|\|\|/.test(tail)) return null
  return translateEnvPrefix(command, info)
}

/**
 * A trailing `2>&1`, which means something different in PowerShell than the
 * model thinks, and turns a successful command into a reported failure.
 *
 * In bash `2>&1` points one file descriptor at another. In PowerShell it merges
 * the ERROR STREAM into the success pipeline as ErrorRecord objects, and a
 * native command that wrote a single byte to stderr therefore leaves `$?` false
 * — so `powershell.exe -Command` exits 1. Measured: `git worktree add --detach
 * <p> HEAD 2>&1` creates the worktree, git exits 0, PowerShell exits 1, because
 * git writes "Preparing worktree" to stderr on an ordinary success. bash.ts
 * keys isError off the exit status, so the model is sent to repair work that
 * was never broken. It is the universal bash idiom, so it is everywhere: 165 of
 * 782 Bash calls in the trajectory corpus end in one.
 *
 * Removing it is a TRANSLATION and not a guess — the same argument as
 * autoTranslateEnvPrefix. exec() captures both streams separately no matter what
 * the command says, and bash.ts reports both, so a trailing merge asks for
 * something it receives regardless. The caller must honour that by showing
 * stderr on the success path when this returns stripped, or the fix trades a
 * false failure for a silent truncation.
 *
 * Only a TRAILING merge. `cmd 2>&1 | Select-String x` routes stderr into the
 * next command, which is a real statement about the pipeline and means what it
 * says; stripping it would change the program rather than its plumbing.
 *
 * The `$` anchor is the whole guard, and it is sufficient. This carried a quote
 * parity check as well, meant to spare a `2>&1` written inside a string such as
 * `python -c "print(1) 2>&1"` — but that command ends in a quote, so the anchor
 * had already refused it, and no mutation against the parity check could be
 * killed. A token inside a string cannot end the command, because the string
 * that opened before it must close after it. What the check did do was decline
 * to fix `git commit -m "don't break it" 2>&1`, where a lone apostrophe made
 * the count odd, so it removed the fix from exactly the commands models write.
 */
export function stripTrailingStderrMerge(
  command: string,
  info: ShellInfo,
): { command: string; stripped: boolean } {
  if (!info.isPowerShell) return { command, stripped: false }
  const trimmed = command.replace(/\s+$/, '')
  const m = /\s*2>&1$/.exec(trimmed)
  if (!m) return { command, stripped: false }
  return { command: trimmed.slice(0, m.index).replace(/\s+$/, ''), stripped: true }
}

/**
 * Shell settings the engine applies before every command it runs on the model's
 * behalf. Empty for every shell that does not need one.
 *
 * Windows PowerShell 5.1 implements `>` as Out-File, whose default encoding is
 * UTF-16LE. Measured on this machine: `'hello' > f` writes `ff fe 68 00 65 00`.
 * So the ordinary habit of `command > out.txt` and then reading out.txt gives
 * back a file git calls binary and every text tool reads as nonsense — and the
 * agent has no way to see why, because it wrote the file itself.
 *
 * Setting Out-File's default parameter moves redirection to UTF-8. This is a
 * shell setting, not a rewrite: nothing the model wrote changes meaning, only
 * the bytes redirection emits. It is the same act as the PYTHONUTF8 injection
 * bash.ts already performs, for the same reason.
 *
 * 5.1 has no BOM-less UTF-8 — `utf8NoBOM` arrives in PowerShell 6 — so the mark
 * survives, and Read strips it. Only powershell.exe is touched: pwsh is not
 * installed here and so cannot be measured, and an unmeasured shell gets the
 * unchanged path rather than a guess.
 */
export function shellPreamble(info: ShellInfo): string {
  if (info.shell !== 'powershell.exe') return ''
  return `$PSDefaultParameterValues['Out-File:Encoding']='utf8'; `
}

/** Returns an instructive error if the command uses operators the shell rejects, else null. */
export function checkShellDialect(command: string, info: ShellInfo): string | null {
  if (info.isPowerShell) {
    const translated = translateEnvPrefix(command, info)
    if (translated !== command) {
      return `Error: this system's shell is ${info.displayName}, where 'NAME=value command' is a parse error. Set each variable first, then run the command: '${translated}'`
    }
  }
  if (info.supportsAndAnd) return null
  if (/&&|\|\|/.test(command)) {
    return "Error: this system's shell is Windows PowerShell 5.1, which does not support '&&' or '||'. Rewrite the command using ';' to sequence steps (e.g. 'cd proj; python -m pytest') or 'if ($?) { ... }' for conditional execution."
  }
  return null
}

/**
 * PowerShell script that parses a command and reports the first thing wrong
 * with it. The command arrives through the environment so no quoting of the
 * caller's text is needed anywhere.
 *
 * Two questions, in order:
 *   1. does it parse?
 *   2. does every command name it invokes exist on this machine?
 *
 * The second is the one that matters. Gilded L4.1d's contract read
 * `... exits 0: python C:/tmp/bite41d.py  (every mutation in the L4.1 set ...)`
 * — a trailing parenthetical of prose I wrote to explain the check. That
 * PARSES: PowerShell reads `(...)` as a sub-expression and `every mutation ...`
 * as a call to a command named `every`. It fails at resolution, which no parse
 * check can see. So the check has to ask whether the names resolve.
 */
const PS_VALIDATE = `
$errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($env:LOCALCODE_VALIDATE_CMD, [ref]$null, [ref]$errs)
if ($errs.Count -gt 0) { Write-Output ("does not parse: " + $errs[0].Message); exit 1 }
$names = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) |
  ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Select-Object -Unique
foreach ($n in $names) {
  if (-not (Get-Command $n -ErrorAction SilentlyContinue)) { Write-Output ("unknown command: " + $n); exit 1 }
}
exit 0
`

/** A command name that carries a path or an extension. */
const QUALIFIED_NAME = /[\\/]|\.[A-Za-z0-9]+$/

/**
 * Check that a harness verification command could actually run, and return an
 * instructive error if it could not.
 *
 * Only BARE names are held to the resolution standard. A name carrying a path
 * or an extension (`./scripts/check.sh`, `build/run.exe`) may legitimately not
 * exist yet — the task may be about to create it, and resolution is relative to
 * a working directory this function cannot know. A bare word that resolves to
 * nothing is not a command on this machine and never will be by accident.
 *
 * Returns null when nothing is wrong, INCLUDING when the check could not be
 * run at all. An unavailable validator must not manufacture a verdict.
 */
export function validateVerificationCommand(command: string, info: ShellInfo = getShellInfo()): string | null {
  // Judge what will actually run. verifyAssertion translates the POSIX env
  // prefix before executing it, so `GILDED_NARRATE=0 python -m pytest` is a
  // perfectly good assertion even though the raw string is a parse error in
  // PowerShell — every L4.1 contract has carried one. Holding the raw text to
  // the dialect standard would refuse contracts the engine runs without
  // trouble. `&&` has no translation, so it still fails here.
  const runnable = translateEnvPrefix(command, info)
  const dialect = checkShellDialect(runnable, info)
  if (dialect) return dialect
  try {
    if (info.isPowerShell) {
      execFileSync(info.shell, ['-NoProfile', '-NonInteractive', '-Command', PS_VALIDATE], {
        env: { ...process.env, LOCALCODE_VALIDATE_CMD: runnable },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15_000,
      })
      return null
    }
    execFileSync(info.shell, ['-n'], { input: command, stdio: ['pipe', 'ignore', 'pipe'], timeout: 15_000 })
    return null
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: unknown }
    const detail = String(e.stdout ?? '').trim() || String(e.stderr ?? '').trim()
    if (!detail) return null
    const unknown = /^unknown command: (.+)$/m.exec(detail)
    // A qualified name may not exist yet; only a bare word is decidable here.
    if (unknown && QUALIFIED_NAME.test(unknown[1])) return null
    return `Verification command cannot run as written — ${detail}. ` +
      'A verification assertion must contain the command and nothing else; ' +
      'explanation of what it proves belongs in the brief, not after the command.'
  }
}

function detectPwsh(): boolean {
  try {
    execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let cached: ShellInfo | null = null

/** Detect once per process; the shell cannot change mid-session (and the
 *  system prompt that mentions it must stay byte-stable anyway). */
export function getShellInfo(): ShellInfo {
  if (!cached) cached = classifyShell(process.platform, process.platform === 'win32' && detectPwsh())
  return cached
}
