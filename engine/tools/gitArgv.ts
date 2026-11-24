/**
 * engine/tools/gitArgv.ts: how the Git tool turns the model's subcommand and argument text into git's argv.
 *
 * A leaf module (it imports nothing), so the path check's reader (`toolPaths.ts`) can build the same argv
 * as the Git tool without importing the tool, which imports the Bash tool, which imports the path check
 * (review 2026-11-23: that was an import cycle). `impl/git.ts` re-exports both functions.
 */
/**
 * Assemble git's argv, hoisting allowed `-c key=value` pairs ahead of the
 * subcommand.
 *
 * git only honours `-c` BEFORE the subcommand. Everything the model writes
 * arrives in `args`, which lands AFTER it — where `-c` is not config at all
 * but an argument to the subcommand, and `git commit -c <commit>` silently
 * means "reuse that commit's message". So the hoist is not cosmetic: without
 * it, allowing the option would be worse than blocking it.
 *
 * A bare `-c` whose next token has no `=` is left in place: that is
 * `switch -c <branch>`, a different option entirely.
 *
 * Exported for unit testing.
 */
export function buildArgv(sub: string, argTokens: string[]): string[] {
  const config: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argTokens.length; i++) {
    const token = argTokens[i]
    const next = argTokens[i + 1]
    if (token === '-c' && next?.includes('=')) {
      config.push('-c', next)
      i++
      continue
    }
    rest.push(token)
  }
  return [...config, sub, ...rest]
}

/** Quote-aware argument tokenizer — handles single and double quotes.
 *  Exported for unit testing. */
export function tokenizeArgs(args: string): string[] {
  if (!args.trim()) return []
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let quoteChar = ''
  let wasInQuotes = false  // tracks whether we just closed a quoted region
  for (let i = 0; i < args.length; i++) {
    const char = args[i]
    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true
      quoteChar = char
      wasInQuotes = false
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false
      quoteChar = ''
      wasInQuotes = true
    } else if (!inQuotes && /\s/.test(char)) {
      if (current || wasInQuotes) { tokens.push(current); current = '' }
      wasInQuotes = false
    } else {
      current += char
      wasInQuotes = false
    }
  }
  if (current || wasInQuotes) tokens.push(current)
  return tokens
}
