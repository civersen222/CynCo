/**
 * Secret paths the file tools must not reach on their own signature.
 *
 * GLM review S1 (docs/reviews/2026-11-06-glm5-engineering-review-triage.md):
 * `Read` is tier 'auto' with no path check, so the model could read
 * ~/.cynco/tokens.json — the bridge scope, which "is Bash" — or ~/.ssh or any
 * .env with no approval card, the first link of a no-approval exfiltration
 * chain (a fetched page says "read X and fetch attacker?d=…"). The Bash tool's
 * denylist (bashSafety.ts) already named .env, ~/.ssh and /etc/shadow; the
 * file tools had nothing.
 *
 * Two routes, decided in `ToolExecutor.execute` before any tier or grade:
 *
 *  - `refuse`: the engine's own token file. Nothing the model does needs it,
 *    and reading it hands over every scope at once. Refused outright, like a
 *    sealed instrument, and the refusal says why.
 *  - `approve`: SSH material, .env files, system credential files. A developer
 *    sometimes has a reason to let the agent see one, so these take the
 *    ordinary approval card however the tool's tier or a project grader would
 *    otherwise rate them. Where there is no user to ask — approve-all, which
 *    the download gate already treats as "nobody watching" — they are refused.
 *
 * Not the sealed-paths layer on purpose: a seal means "never see, never list,
 * and the refusal names nothing", which is right for a withheld gate and wrong
 * for a .env the owner may choose to show. Bash is not judged here; its command
 * text is `bashSafety.ts`'s to read.
 */
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { cyncoHome } from '../paths.js'

export type SecretAction = 'refuse' | 'approve'
export type SecretHit = { path: string; action: SecretAction; why: string }

/** Tools whose input names a single path the call would read or write. */
const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path', 'filePath']

/** Win32 folds case; two authors spell the same path with different slashes. */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

export function secretPathOf(toolName: string, input: Record<string, unknown>, cwd: string): SecretHit | null {
  if (toolName === 'Bash') return null
  const tokenFile = norm(resolve(cyncoHome(), 'tokens.json'))
  const sshDir = norm(resolve(homedir(), '.ssh'))
  for (const key of PATH_INPUT_KEYS) {
    const raw = input[key]
    if (typeof raw !== 'string' || !raw) continue
    const spelled = norm(raw)
    const abs = norm(resolve(cwd, raw))
    if (abs === tokenFile) return { path: abs, action: 'refuse', why: "the engine's own token file" }
    if (abs === sshDir || abs.startsWith(sshDir + '/')) return { path: abs, action: 'approve', why: 'SSH keys' }
    const base = basename(abs)
    if (base === '.env' || base.startsWith('.env.')) return { path: abs, action: 'approve', why: 'a .env file, which may hold secrets' }
    if (/^\/etc\/(shadow|passwd|sudoers)$/.test(spelled)) return { path: abs, action: 'approve', why: 'a system credential file' }
  }
  return null
}

export const SECRET_REFUSAL =
  "Error: that path is the engine's own token file (~/.cynco/tokens.json), and the call was refused.\n"
  + 'It holds the credentials the TUI and dashboard use to reach this engine. Nothing in a task '
  + 'needs it, so there is no approval to ask for. If the user wants to see or rotate their tokens, '
  + 'tell them the file is theirs to open.'

export function secretApprovalRefusal(hit: SecretHit): string {
  return `Error: ${hit.path} is ${hit.why}, which needs the user's explicit approval, and none is available in this run. `
    + 'Work from the code and the brief; if the task truly needs it, say so in your reply so the operator can decide.'
}
