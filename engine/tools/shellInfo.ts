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
      dialectNote: 'Shell is PowerShell 7 (pwsh). && and || are supported. Use PowerShell cmdlets, not Unix commands. Set an environment variable with $env:NAME="value"; — the POSIX prefix form NAME=value command is a parse error.',
    }
  }
  return {
    shell: 'powershell.exe',
    displayName: 'Windows PowerShell 5.1',
    supportsAndAnd: false,
    isPowerShell: true,
    dialectNote: "Shell is Windows PowerShell 5.1 — '&&' and '||' are NOT supported. Sequence commands with ';' (e.g. 'cd proj; python -m pytest') or use 'if ($?) { ... }' for conditional chaining. Set an environment variable with $env:NAME=\"value\"; — the POSIX prefix form NAME=value command is a parse error.",
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
  const sets = prefix[1]
    .trim()
    .split(/\s+/)
    .map(pair => {
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1).replace(/^["']|["']$/g, '')
      return `$env:${name}="${value}"`
    })
  return `${sets.join('; ')}; ${command.slice(prefix.index + prefix[0].length)}`
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
