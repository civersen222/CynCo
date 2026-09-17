/**
 * Classify a shell command by EFFECT, not by tool name.
 *
 * C8 wave 1: the read-loop gate denied 19 Read/Grep calls and the run answered
 * with 233 read-shaped Bash calls (`Get-Content … for ($l=…)`, `Select-String`,
 * `git show base:file`). The regulator classified by tool name and the
 * disturbance changed channel. This is the one definition of what a Bash call
 * DOES; the ledger loads the same vectors so both sides agree by construction.
 */
export type BashEffect = 'read' | 'write' | 'run' | 'commit' | 'revert' | 'other'

// Strip quoted spans so text INSIDE quotes (e.g. an echoed string that
// happens to contain "git checkout --") can never masquerade as the command
// itself. Used for REVERT/COMMIT/RUN/redirect/READ — every check except
// WRITE_DIRECT (see below).
const stripQuoted = (c: string) => c.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')

// Split into segments on the shell operators that chain independent commands.
const splitSegments = (c: string) => c.split(/;|&&|\|\||[|\n]/).map(s => s.trim()).filter(Boolean)

// A segment that undoes work: git checkout of a path/ref, restore, stash,
// hard reset, or clean. NOT `git checkout -b` (branch creation).
const REVERT = /\bgit\s+(?:checkout\s+(?:--|HEAD\b|[0-9a-f]{7,40}\b)|restore\b|stash\b|reset\s+--hard\b|clean\s+-[a-zA-Z]*f)/

// A segment that commits work.
const COMMIT = /\bgit\s+commit\b/

// Unambiguous file mutation: a cmdlet/verb whose entire purpose is writing,
// or Python's `open(path, 'w'|'a')` / `.write(` idiom. This is checked
// against the RAW (unstripped) command, not the quote-stripped one:
// `python -c "…open('a.py','w').write(…)…"` carries its write signal inside
// a double-quoted code string that itself contains single quotes, so
// stripQuoted's two-pass strip (single, then double) collapses the whole
// quoted span to `""` and would erase the very thing we're looking for.
// None of the read/other vectors contain these tokens as decoy text inside
// quotes, so scanning raw text here is safe.
const WRITE_DIRECT = /\b(?:Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|New-Item|Remove-Item|cp|mv|rm|mkdir|touch|tee)\b|\bopen\([^)]*,\s*['"]?[wa]|\.write\(/

// A bare `>`/`>>` redirect — ambiguous on its own (see hasRun below). `2>&1`
// (stderr merged into stdout, no file) is excluded by the `(?!&)` lookahead;
// the optional `\s*` allows "> file.txt" as well as ">file.txt".
const WRITE_REDIRECT = /(?:^|\s)>{1,2}(?!&)\s*\S/

// A segment that executes code/tests.
const RUN = /\b(?:python3?|pytest|bun|node|npm|cargo)\b/

// A segment that only reads/inspects — never mutates anything. The optional
// `$var = ` prefix covers PowerShell assignment (`$lines = Get-Content …`).
const READ = /^(?:\$\w+\s*=\s*)?(?:Get-Content\b|Select-String\b|Get-ChildItem\b|Select-Object\b|ForEach-Object\b|Where-Object\b|Measure-Object\b|cat\b|head\b|tail\b|sed\s+-n\b|grep\b|rg\b|type\b|findstr\b|ls\b|dir\b|wc\b|git\s+(?:show|diff|log|status|blame|ls-files|rev-parse)\b|for\s*\()/i

export function bashEffect(command: string): BashEffect {
  const raw = String(command ?? '')
  const stripped = stripQuoted(raw)
  const segments = splitSegments(stripped)
  if (segments.length === 0) return 'other'

  // Whole-command precedence: revert > commit > write > run > all-read → read > other.
  if (segments.some(seg => REVERT.test(seg))) return 'revert'
  if (segments.some(seg => COMMIT.test(seg))) return 'commit'
  if (WRITE_DIRECT.test(raw)) return 'write'
  const hasRun = segments.some(seg => RUN.test(seg))
  if (hasRun) return 'run'
  // A redirect counts as `write` only when no segment is a `run`: a pytest
  // invocation piped to a file (`pytest … > out.txt 2>&1`) is a test run
  // whose output happens to be captured, not a write — the run already
  // returned above, so reaching here means nothing in the command runs.
  if (segments.some(seg => WRITE_REDIRECT.test(seg))) return 'write'
  if (segments.some(seg => READ.test(seg))) return 'read'
  return 'other'
}

export const isRevert = (command: string): boolean => bashEffect(command) === 'revert'
