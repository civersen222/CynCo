/**
 * Refuse repo-wide git staging.
 *
 * A commit is hard to reverse once it exists, so this is prevention rather than
 * an after-the-fact flag. Motivating incident: a run asked to make a nine-line
 * bugfix swept a 995-line unrelated plan document, an unrelated checklist, and
 * two scratch files whose entire contents were "# delete me" into its commit.
 *
 * Commits go through plain Bash or the Git tool — this predicate handles both
 * and is the only staging-breadth check in the system.
 */

export interface CommitScopeVerdict {
  allowed: boolean
  /** Guidance returned to the model when refused. */
  reason?: string
}

/** Blank out quoted spans so `echo "git add -A"` isn't read as staging. */
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
}

/**
 * Split a shell command string into independent segments on shell separators
 * (`;`, `&&`, `||`, `|`, newline). Call AFTER stripQuoted so separators inside
 * quotes are already blanked and cannot split a segment.
 */
function splitSegments(command: string): string[] {
  return command.split(/;|&&|\|\||[|\n]/).map(s => s.trim()).filter(Boolean)
}

/** `git add` or `git stage` with -A, --all, -u, a bare `.` pathspec, or a bare `*` pathspec. */
const ADD_ALL = /\bgit\s+(?:add|stage)\b[^\n]*?\s(?:-A\b|--all\b|-u\b|\.(?=\s|$|;|&|\))|\*(?=\s|$|;|&|\)))/

/** `git commit` with a combined short flag containing `a` (-a, -am, -a -m). */
const COMMIT_SHORT_ALL = /\bgit\s+commit\b[^\n]*?\s-[A-Za-z]*a[A-Za-z]*\b/
/** `git commit --all`. Kept separate so `--amend` cannot match. */
const COMMIT_LONG_ALL = /\bgit\s+commit\b[^\n]*?\s--all\b/

const ADD_REASON =
  'Repo-wide staging (git add -A / . / -u) is not allowed — it sweeps in files ' +
  'you did not change. Stage the files you actually modified by name, e.g. ' +
  '`git add path/to/file.py path/to/test_file.py`.'

const COMMIT_REASON =
  '`git commit -a` stages every modified file, including ones unrelated to your ' +
  'change. Stage the files you modified by name with `git add <paths>` first, ' +
  'then run `git commit -m "..."`.'

/** Check a single already-stripped segment for violations. */
function checkSegment(segment: string): CommitScopeVerdict {
  if (ADD_ALL.test(segment)) return { allowed: false, reason: ADD_REASON }
  if (COMMIT_SHORT_ALL.test(segment) || COMMIT_LONG_ALL.test(segment)) {
    return { allowed: false, reason: COMMIT_REASON }
  }
  return { allowed: true }
}

/**
 * True-by-default: only an explicitly recognized repo-wide staging form is
 * refused. Anything unrecognized is allowed through.
 *
 * Handles both the `Bash` tool (`{ command }`) and the `Git` tool
 * (`{ subcommand, args }`).
 */
export function checkCommitScope(toolName: string, toolInput: unknown): CommitScopeVerdict {
  let raw: string

  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: unknown })?.command
    if (typeof cmd !== 'string') return { allowed: true }
    raw = cmd
  } else if (toolName === 'Git') {
    const input = toolInput as { subcommand?: unknown; args?: unknown }
    const sub = typeof input?.subcommand === 'string' ? input.subcommand : ''
    const args = typeof input?.args === 'string' ? input.args : ''
    raw = `git ${sub} ${args}`.trim()
  } else {
    return { allowed: true }
  }

  const command = stripQuoted(raw)
  const segments = splitSegments(command)

  for (const segment of segments) {
    const verdict = checkSegment(segment)
    if (!verdict.allowed) return verdict
  }

  return { allowed: true }
}
