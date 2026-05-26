/**
 * Best-effort heuristic warning for dangerous bash commands.
 * NOT a sandbox — trivially bypassed (string splitting, base64, etc.).
 * The real protection is Bash tier='approval' so the user sees every command.
 */

type SafetyResult = { safe: boolean; reason?: string }

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(cat|less|more|head|tail|nano|vim?|code)\b.*\.env\b/, reason: 'Access to .env files is blocked — may contain secrets' },
  { pattern: />>?\s*\.env/, reason: 'Writing to .env files is blocked' },
  { pattern: /~\/\.ssh\//, reason: 'Access to SSH keys is blocked' },
  { pattern: /\/etc\/(shadow|passwd|sudoers)/, reason: 'Access to system credential files is blocked' },
  { pattern: /\brm\s+-rf\s+[\/~]/, reason: 'Destructive rm -rf on root or home is blocked' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem format commands are blocked' },
  { pattern: /\b(env|printenv)\b/, reason: 'Commands that dump all environment variables are blocked — may expose secrets' },
  { pattern: /echo\s+\$[A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)/, reason: 'Echoing secret environment variables is blocked' },
  { pattern: /curl.*\|\s*(?:bash|sh)\b/, reason: 'Piping remote scripts to shell is blocked' },
  { pattern: /\bdd\b.*\bof=\/dev\//, reason: 'Direct disk write commands are blocked' },
]

const BLOCKING_EXCEPTIONS = /--check|--version|--help|\btest\b|--dry-run|&\s*$/

const BLOCKING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(python|python3|node|bun)\s*$/, reason: 'Refused: bare REPL would block the session' },
  { pattern: /^(node|python|python3|bun|deno)\s+.*\b(server\.|app\.)/i, reason: 'Refused: this would start a long-running server' },
  { pattern: /(uvicorn|gunicorn|flask\s+run|django.*runserver|rails\s+s)/i, reason: 'Refused: this would start a long-running server' },
  { pattern: /(npm\s+start|yarn\s+start|bun\s+run\s+dev|next\s+dev|vite\s+dev)/i, reason: 'Refused: this would start a long-running dev server' },
  { pattern: /(--interactive\b|-i\s*$)/, reason: 'Refused: interactive mode would block the session' },
]

export function checkBashSafety(command: string): SafetyResult {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason }
    }
  }
  if (!BLOCKING_EXCEPTIONS.test(command)) {
    for (const { pattern, reason } of BLOCKING_PATTERNS) {
      if (pattern.test(command)) return { safe: false, reason: reason + '. Run in background with & or use a test/check command instead.' }
    }
  }
  return { safe: true }
}
