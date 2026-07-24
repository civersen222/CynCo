/**
 * Refuse repo-wide git staging.
 *
 * A commit is hard to reverse once it exists, so this is prevention rather than
 * an after-the-fact flag. Motivating incident: a run asked to make a nine-line
 * bugfix swept a 995-line unrelated plan document, an unrelated checklist, and
 * two scratch files whose entire contents were "# delete me" into its commit.
 *
 * Commits go through plain Bash — engine/systemPromptText.ts:87 routes the model
 * around the Git tool, and bashSafety.ts has no git patterns — so this predicate
 * is the only staging-breadth check in the system.
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

/** `git add` with -A, --all, -u, or a bare `.` pathspec. */
const ADD_ALL = /\bgit\s+add\b[^\n]*?\s(?:-A\b|--all\b|-u\b|\.(?=\s|$|;|&|\)))/

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

/**
 * True-by-default: only an explicitly recognized repo-wide staging form is
 * refused. Anything unrecognized is allowed through.
 */
export function checkCommitScope(toolName: string, toolInput: unknown): CommitScopeVerdict {
  if (toolName !== 'Bash') return { allowed: true }
  const raw = (toolInput as { command?: unknown })?.command
  if (typeof raw !== 'string') return { allowed: true }

  const command = stripQuoted(raw)
  if (ADD_ALL.test(command)) return { allowed: false, reason: ADD_REASON }
  if (COMMIT_SHORT_ALL.test(command) || COMMIT_LONG_ALL.test(command)) {
    return { allowed: false, reason: COMMIT_REASON }
  }
  return { allowed: true }
}
