/**
 * The single source of truth for reading test-runner output.
 *
 * Two partial parsers used to exist: benignToolResult.ts could tell whether a
 * suite ran but not how it did, and bestOfN/sampler.ts could count but had to
 * be told the framework and had no hard-error guard. Both now delegate here.
 *
 * Conservative by design, inherited from benignToolResult: a result is a real
 * summary ONLY when a recognized runner was invoked, the output carries
 * pass/fail counts, and no hard-error marker is present. Collection errors,
 * broken imports and usage errors return null — they are faults, not results.
 */

/**
 * Anchored at `^` — these are matched against a command HEAD, never against a
 * whole line. See detectFramework for why.
 */
const FRAMEWORK_PATTERNS: { framework: string; re: RegExp }[] = [
  { framework: 'pytest', re: /^(pytest|py\.test|python[0-9.]*\s+-m\s+(pytest|unittest))\b/i },
  { framework: 'vitest', re: /^vitest\b/i },
  { framework: 'jest', re: /^jest\b/i },
  { framework: 'bun', re: /^bun\s+test\b/i },
  { framework: 'mocha', re: /^mocha\b/i },
  { framework: 'go', re: /^go\s+test\b/i },
  { framework: 'cargo', re: /^cargo\s+test\b/i },
  { framework: 'rspec', re: /^rspec\b/i },
  { framework: 'phpunit', re: /^phpunit\b/i },
  { framework: 'ctest', re: /^ctest\b/i },
  { framework: 'gradle', re: /^gradle\s+test\b/i },
  { framework: 'maven', re: /^mvn\s+test\b/i },
  { framework: 'npm', re: /^(npm|yarn|pnpm)\s+(run\s+)?test\b/i },
]

/** Leading env assignments and wrapper runners, stripped to reach the real head. */
const RUNNER_PREFIX = /^(?:\w+=\S*\s+)*(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|poetry\s+run|uv\s+run|pipenv\s+run)\s+)*/i

/**
 * Split a shell line into the commands it runs, each reduced to the head that
 * names the program.
 *
 * Quoted text goes first, because it is data rather than a command, and env
 * assignments and wrapper runners go next, because the program they wrap is
 * the one that matters.
 */
function commandHeads(command: string): string[] {
  return command
    .replace(/"[^"]*"|'[^']*'/g, ' ')
    .split(/&&|\|\||[;|\n]/)
    .map(seg => seg.trim().replace(RUNNER_PREFIX, ''))
}

/**
 * Hard-error markers: the command did NOT cleanly run a suite. These are
 * genuine faults, so they must not be reported as results even if a stray
 * pass/fail count appears elsewhere in the output.
 */
const HARD_ERROR =
  /errors? during collection|Interrupted:\s|INTERNALERROR|usage:\s*pytest|unrecognized arguments|no tests ran|command not found|No such file|not recognized as|ENOENT|ModuleNotFoundError:|cannot import name/i

export type TestSummary = { framework: string; passed: number; total: number }

/**
 * Framework name if the command INVOKES a recognized test runner, else null.
 *
 * Matched at command position, for the same reason classifyCheckCommand is —
 * and this one is the expensive half. Measured against the live engine on
 * 2026-08-01, when the match was a substring of the whole line:
 *
 *   echo "pytest suite: 452 passed"        -> {pytest, 452/452}
 *   rg -n pytest docs/brief.md             -> {pytest, 3066/3066}
 *   git commit -m "vitest: 3066 passed"    -> {vitest, 3066/3066}
 *
 * The third needs no quoted number of its own: git echoes the subject back.
 * None of the three ran a test. `testsPass` is 2.0 of a 3.6 denominator, and a
 * large invented total also wins the widest-run comparison in
 * assessTestsPass, so one of these displaces the real run that was there.
 *
 * The middle one is the one that matters most: grepping a brief for the word
 * "pytest" is something an honest run does, and the brief supplies the number.
 * This was reachable by accident, not only by gaming.
 *
 * Every segment is checked, not just the last — a runner in the middle of a
 * `&&` chain really did run and its output really is in the buffer. That is
 * the opposite of classifyCheckCommand, which reads an exit status and so can
 * only speak for the segment that status belongs to.
 */
export function detectFramework(command: string): string | null {
  if (typeof command !== 'string') return null
  for (const seg of commandHeads(command)) {
    for (const { framework, re } of FRAMEWORK_PATTERNS) {
      if (re.test(seg)) return framework
    }
  }
  return null
}

const TYPECHECK_HEAD = /^(?:tsc|mypy|pyright|flow\s+check)\b/i
const BUILD_HEAD = /^(?:make|cargo\s+build|go\s+build|tsup|vite\s+build|webpack|rollup|esbuild)\b/i

/** `npm run <script>` and friends — the script name carries the meaning. */
const SCRIPT_RUN = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/i
const TYPECHECK_SCRIPT = /^(?:typecheck|type-check|types|tsc|check-types)$/i
const BUILD_SCRIPT = /^build(?::[\w.-]+)?$/i

/**
 * Recognize typecheck/build commands so their exit status can be measured.
 *
 * Matched at COMMAND POSITION, not anywhere in the string. A substring match
 * made `git commit -m "make build work"` report a passing build and `rg tsc`
 * report a passing typecheck — inventing a measurement out of a commit message
 * is the precise failure this pipeline exists to undo. Quoted text is stripped
 * first for the same reason: it is data, not a command.
 *
 * The caller records the result as the line's exit status, so this classifies
 * only when that status is actually the check's. `;`, `|` and `||` all let a
 * line exit 0 with a failed check inside it — `npx tsc --noEmit || true` was
 * scoring typecheckPass, worth 0.5 of a 3.6 denominator — and with `&&` the
 * status belongs to the last segment, so a check earlier in the chain is not
 * what the caller would be recording.
 *
 * `&&` can still produce a false NEGATIVE: an earlier segment fails, the line
 * exits non-zero, and the check is marked failed without having run. That
 * direction only loses signal. The other direction invents one.
 *
 * Errs toward null. An unrecognized check leaves the component 'unknown',
 * which costs a little reward signal; a misrecognized one poisons a label.
 */
export function classifyCheckCommand(command: string): 'typecheck' | 'build' | null {
  if (typeof command !== 'string') return null
  if (/[;|]/.test(command.replace(/"[^"]*"|'[^']*'/g, ' '))) return null
  const heads = commandHeads(command)
  const seg = heads[heads.length - 1]
  if (TYPECHECK_HEAD.test(seg)) return 'typecheck'
  if (BUILD_HEAD.test(seg)) return 'build'
  const m = seg.match(SCRIPT_RUN)
  if (m) {
    if (TYPECHECK_SCRIPT.test(m[1])) return 'typecheck'
    if (BUILD_SCRIPT.test(m[1])) return 'build'
  }
  return null
}

function num(output: string, re: RegExp): number | null {
  const m = output.match(re)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Returns the last match rather than the first. Used in the default branch
 * because vitest prints "Test Files  N failed | N passed" before
 * "Tests  N failed | N passed" — a first-match regex reads file counts.
 */
function lastNum(output: string, re: RegExp): number | null {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
  const all = [...output.matchAll(new RegExp(re.source, flags))]
  return all.length > 0 ? parseInt(all[all.length - 1][1], 10) : null
}

function countsFor(framework: string, output: string): { passed: number; total: number } | null {
  switch (framework) {
    case 'go': {
      const lines = output.split('\n')
      const passed = lines.filter(l => /^ok\s/.test(l)).length
      const failed = lines.filter(l => /^(FAIL|--- FAIL)/.test(l)).length
      return passed + failed > 0 ? { passed, total: passed + failed } : null
    }
    case 'cargo': {
      const passed = num(output, /(\d+)\s+passed/i)
      const failed = num(output, /(\d+)\s+failed/i)
      if (passed === null && failed === null) return null
      return { passed: passed ?? 0, total: (passed ?? 0) + (failed ?? 0) }
    }
    case 'jest': {
      const passed = num(output, /(\d+)\s+passed/i)
      const total = num(output, /(\d+)\s+total/i)
      if (passed === null) return null
      return { passed, total: total ?? passed }
    }
    case 'bun': {
      const passed = num(output, /(\d+)\s+pass\b/i)
      const failed = num(output, /(\d+)\s+fail\b/i)
      if (passed === null && failed === null) return null
      return { passed: passed ?? 0, total: (passed ?? 0) + (failed ?? 0) }
    }
    default: {
      // pytest / vitest / mocha / rspec and friends all report "N passed",
      // "N failed". vitest prints the Tests line last, so the last match wins.
      const passed = lastNum(output, /(\d+)\s+passed/i)
      const failed = lastNum(output, /(\d+)\s+failed/i)
      if (passed === null && failed === null) return null
      return { passed: passed ?? 0, total: (passed ?? 0) + (failed ?? 0) }
    }
  }
}

/**
 * Parse real pass/total counts out of test-runner output.
 *
 * `commandOrFramework` accepts either a shell command (detection is applied)
 * or a bare framework name already known to the caller.
 * Returns null when there is no trustworthy result.
 */
export function parseTestSummary(commandOrFramework: string, output: string): TestSummary | null {
  const known = FRAMEWORK_PATTERNS.some(f => f.framework === commandOrFramework)
  const framework = known ? commandOrFramework : detectFramework(commandOrFramework)
  if (!framework) return null

  const o = output ?? ''
  if (HARD_ERROR.test(o)) return null

  const counts = countsFor(framework, o)
  if (!counts || counts.total === 0) return null

  return { framework, passed: counts.passed, total: counts.total }
}
