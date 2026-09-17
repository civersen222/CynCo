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
// itself. Used for every check but the narrow `python -c` write idiom, which
// has to be read off raw text (see PYTHON_INLINE below).
const stripQuoted = (c: string) => c.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')

// Split into segments on the shell operators that chain independent commands.
const splitSegments = (c: string) => c.split(/;|&&|\|\||[|\n]/).map(s => s.trim()).filter(Boolean)

// ─── The revert family ─────────────────────────────────────────────────────
// The ban is on the FAMILY, not on the literal forms one run happened to emit.
// The first cut of this file listed the shapes seen in the C8 wave 1 log
// (`git checkout --`, `git checkout HEAD`, `git checkout <sha>`) and every
// other way of writing the same destruction — `git checkout gilded/ui/app.py`,
// `git checkout .`, `git checkout main -- a.py`, `git checkout -f`,
// `git reset HEAD~1 --hard` — classified `other` and ran. A regulator that
// names forms has the variety of the forms; the disturbance has the variety of
// the command (Ashby). So the rule is inverted: a `git checkout` is a revert
// UNLESS it is unambiguously a branch operation.

// Flags that make a checkout a branch operation and nothing else.
const CHECKOUT_BRANCH_FLAGS = /^(?:-b|-B|--track|--orphan|--detach)$/
// `-f`/`--force` on a checkout throws away local modifications by definition.
const CHECKOUT_FORCE_FLAGS = /^(?:-f|--force)$/
// A lone bare argument that is still a revert despite looking like a name:
// `HEAD` and a bare sha are a working-tree restore / detach onto old content.
const CHECKOUT_REVERT_REFS = /^(?:HEAD|[0-9a-f]{7,40})$/i

const isCheckoutRevert = (seg: string): boolean => {
  const m = seg.match(/\bgit\s+checkout\b(.*)$/i)
  if (!m) return false
  const tokens = (m[1] ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.some(t => CHECKOUT_BRANCH_FLAGS.test(t))) return false
  if (tokens.some(t => CHECKOUT_FORCE_FLAGS.test(t))) return true
  // `--` is the pathspec separator: everything after it is a file, so this is
  // a working-tree restore however the left-hand side reads.
  if (tokens.includes('--')) return true
  const bare = tokens.filter(t => !t.startsWith('-'))
  // Exactly one bare token with no path punctuation is a branch name — the one
  // shape that is unambiguously navigation. Everything else (a path, a dot, an
  // empty argument list, two refs) errs toward refusing.
  if (bare.length === 1 && !/[./\\]/.test(bare[0]) && !CHECKOUT_REVERT_REFS.test(bare[0])) return false
  return true
}

// `git restore` and `git clean -f…` are reverts in every form they take.
const REVERT_ALWAYS = /\bgit\s+(?:restore\b|clean\s+-[a-zA-Z]*f)/i

/**
 * A segment that undoes work. `git stash list` / `git stash show` are excluded:
 * they are read-only inspections of the stash, and refusing them teaches the
 * model nothing except that the word "stash" is cursed.
 */
const isRevertSegment = (seg: string): boolean => {
  if (REVERT_ALWAYS.test(seg)) return true
  if (/\bgit\s+stash\b/i.test(seg)) return !/\bgit\s+stash\s+(?:list|show)\b/i.test(seg)
  // `--hard`/`--merge` anywhere in the segment, not only directly after
  // `reset`: `git reset HEAD~1 --hard` discards exactly as much as
  // `git reset --hard HEAD~1`.
  if (/\bgit\s+reset\b/i.test(seg)) return /(?:^|\s)--(?:hard|merge)\b/i.test(seg)
  return isCheckoutRevert(seg)
}

// A segment that commits work.
const COMMIT = /\bgit\s+commit\b/i

// Unambiguous file mutation: a cmdlet/verb whose entire purpose is writing.
// Checked against the STRIPPED segments like every other rule — the earlier
// version scanned raw text and so classified `grep -rn "touch" gilded/` and
// `Get-Content app.py | Select-String "np.write("` as writes, which hid two
// ordinary reads from BOTH the read-loop gate and edit-only denial: a call
// classed `write` is neither denied as inspection nor counted as one.
const WRITE_DIRECT = /\b(?:Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|New-Item|Remove-Item|cp|mv|rm|mkdir|touch|tee)\b/i

// The one signal that must still be read off RAW text: Python's inline
// `open(path,'w')` / `.write(` idiom. `python -c "…open('a.py','w')…"` carries
// its write inside a double-quoted program that itself contains single quotes,
// and stripQuoted's two-pass strip (single, then double) collapses the whole
// span to `""`, erasing the thing we are looking for. Splitting raw text into
// segments is no help either: the inline program has its own `;` separators.
// So the scan is narrowed by position instead — only the raw text from the
// first `python -c` / `python3 -c` onward, which is the program itself.
const PYTHON_INLINE = /\bpython3?\s+-c\b/i
const PYTHON_WRITE = /\bopen\([^)]*,\s*['"]?[wa]|\.write\(/

// A bare `>`/`>>` redirect — ambiguous on its own (see hasRun below). `2>&1`
// (stderr merged into stdout, no file) is excluded by the `(?!&)` lookahead;
// the optional `\s*` allows "> file.txt" as well as ">file.txt".
const WRITE_REDIRECT = /(?:^|\s)>{1,2}(?!&)\s*\S/

// A segment that executes code/tests.
const RUN = /\b(?:python3?|pytest|bun|node|npm|cargo)\b/i

// A segment that only reads/inspects — never mutates anything. The optional
// `$var = ` prefix covers PowerShell assignment (`$lines = Get-Content …`).
const READ = /^(?:\$\w+\s*=\s*)?(?:Get-Content\b|Select-String\b|Get-ChildItem\b|Select-Object\b|ForEach-Object\b|Where-Object\b|Measure-Object\b|cat\b|head\b|tail\b|sed\s+-n\b|grep\b|rg\b|type\b|findstr\b|ls\b|dir\b|wc\b|git\s+(?:show|diff|log|status|blame|ls-files|rev-parse|stash\s+(?:list|show))\b|for\s*\()/i

export function bashEffect(command: string): BashEffect {
  const raw = String(command ?? '')
  const stripped = stripQuoted(raw)
  const segments = splitSegments(stripped)
  if (segments.length === 0) return 'other'

  // Whole-command precedence: revert > commit > write > run > all-read → read > other.
  if (segments.some(isRevertSegment)) return 'revert'
  if (segments.some(seg => COMMIT.test(seg))) return 'commit'
  if (segments.some(seg => WRITE_DIRECT.test(seg))) return 'write'
  const pyInline = raw.match(PYTHON_INLINE)
  if (pyInline && PYTHON_WRITE.test(raw.slice(pyInline.index))) return 'write'
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
