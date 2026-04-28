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

export function checkBashSafety(command: string): SafetyResult {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason }
    }
  }
  return { safe: true }
}
