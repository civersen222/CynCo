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
  dialectNote: string     // one-line dialect guidance for the system prompt
}

export function classifyShell(platform: string, hasPwsh: boolean): ShellInfo {
  if (platform !== 'win32') {
    return {
      shell: '/bin/bash',
      displayName: 'bash',
      supportsAndAnd: true,
      dialectNote: 'Shell is bash. Standard POSIX syntax (&&, ||, pipes) works.',
    }
  }
  if (hasPwsh) {
    return {
      shell: 'pwsh.exe',
      displayName: 'PowerShell 7 (pwsh)',
      supportsAndAnd: true,
      dialectNote: 'Shell is PowerShell 7 (pwsh). && and || are supported. Use PowerShell cmdlets, not Unix commands.',
    }
  }
  return {
    shell: 'powershell.exe',
    displayName: 'Windows PowerShell 5.1',
    supportsAndAnd: false,
    dialectNote: "Shell is Windows PowerShell 5.1 — '&&' and '||' are NOT supported. Sequence commands with ';' (e.g. 'cd proj; python -m pytest') or use 'if ($?) { ... }' for conditional chaining.",
  }
}

/** Returns an instructive error if the command uses operators the shell rejects, else null. */
export function checkShellDialect(command: string, info: ShellInfo): string | null {
  if (info.supportsAndAnd) return null
  if (/&&|\|\|/.test(command)) {
    return "Error: this system's shell is Windows PowerShell 5.1, which does not support '&&' or '||'. Rewrite the command using ';' to sequence steps (e.g. 'cd proj; python -m pytest') or 'if ($?) { ... }' for conditional execution."
  }
  return null
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
