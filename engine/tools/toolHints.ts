/**
 * Nudge the model back to the purpose-built tool when it reaches for the shell.
 *
 * Watched live during Gilded task L3-3.2b: CynCo read two files with eight
 * `Get-Content ... | Select-Object -Skip N -First M` calls and rewrote
 * `gilded/docket.py` with a series of
 * `python -c "content = open(f).read(); old = '''...'''; ..."` scripts — while
 * `Read`, `Grep`, `Edit`, `MultiEdit` and `ReplaceFunction` were all registered
 * and working.
 *
 * The original diagnosis here was "drift, not a tool gap", on the evidence that the
 * engine log recorded zero Edit failures and it had used Edit correctly in the
 * immediately preceding task. That was WRONG, and the correction matters more than
 * the hint does: the read-loop gate had denied Read and could not be made to
 * relent (see readLoopGate.ts and 2fc20d2), so `Get-Content` was the only way left
 * to read a file. The model was routing around an engine fault, not forgetting its
 * tools.
 *
 * The hint still earns its place — the costs below are real whenever a model does
 * reach for the shell to read or rewrite source, and a model can drift here on its
 * own. But it treats a symptom, so if this fires often, suspect the gate first.
 * Three costs, in order of seriousness:
 *
 *  1. A `python -c` string replacement whose target does not match writes the file
 *     back unchanged and exits 0. Silent success is the worst failure mode there
 *     is — the model believes the edit landed and reasons on from there.
 *  2. Eight turns to read what `Read` returns in two. With llama.cpp forcing a
 *     full ~30k-token prefill per turn on this model, wasted turns dominate the
 *     cost of a run.
 *  3. It raises a HIGH-risk Bash approval card for work that should raise a
 *     MEDIUM Edit card, so the approval surface stops describing what is going on.
 *
 * The hint rides along with output the model already asked for, so the correction
 * arrives at the moment of the mistake rather than in a system prompt it has
 * already drifted from. It never changes `isError` and never suppresses output:
 * the command still ran, and the model still gets what it asked for.
 */

/** A leading command that only reads a file out. */
const READ_COMMANDS = /^\s*(?:get-content|gc|cat|head|tail|type)\b/i

/** Pipeline stages that are still just "read part of a file", not real work. */
const SLICING_STAGES = /^\s*(?:select-object|select|out-string|write-output|echo)\b/i

const SEARCH_COMMANDS = /^\s*(?:select-string|sls|grep|findstr|rg)\b/i

/**
 * `$content[724..741] -join "\n"` — slicing a variable that already holds the
 * file. This is the form CynCo reached for most often once it had drifted to the
 * shell, and it is invisible to a check that only looks at the leading command.
 */
const VARIABLE_SLICE = /^\s*\$\w+\s*\[|^\s*\$\w+\s*$/

/** Strip a leading `$var =` so the read command underneath can be recognised. */
function withoutAssignment(statement: string): string {
  return statement.replace(/^\s*\$\w+\s*=\s*/, '')
}

/**
 * Split on `;` outside quotes. PowerShell's statement separator: the read and the
 * slice that consumes it usually arrive as two statements in one call.
 */
function statements(command: string): string[] {
  return splitOutsideQuotes(command, ';')
}

/**
 * Split on pipes that are not inside quotes. A quoted `|` is data, not a
 * pipeline: `grep "a|b" f` is one stage, and treating it as two misreads the
 * command entirely.
 */
function splitOutsideQuotes(command: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null
      current += char
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === separator) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

function pipelineStages(command: string): string[] {
  return splitOutsideQuotes(command, '|')
}

/** Writing somewhere, so the command is doing more than reading a file out. */
const REDIRECTS_OUTPUT = /(?:^|[^>])>{1,2}[^>]/

/**
 * A script that reads a source file and writes it back — string surgery on code.
 * Both halves are required: reading a file in a one-liner is fine, and writing a
 * NEW file is what `Write` is for and not what this is about.
 */
export function isSourceRewrite(command: string): boolean {
  if (!/\b(?:python|python3|py|node|bun)\b/i.test(command)) return false
  const reads = /\.read\(\)|readlines\(|readFileSync/i.test(command)
  const writes = /\.write\(|writelines\(|writeFileSync|open\([^)]*['"][wa]\+?['"]/i.test(command)
  return reads && writes
}

/**
 * A one-line note to prepend to the output, or null when the command is doing
 * real shell work and should be left alone.
 */
export function betterToolHint(command: string): string | null {
  if (isSourceRewrite(command)) {
    return (
      'Note: this rewrites a source file by string replacement. Prefer Edit, MultiEdit or ' +
      'ReplaceFunction — a replacement whose target string does not match writes the file back ' +
      'UNCHANGED and still exits 0, so a failed edit looks exactly like a successful one. Edit ' +
      'reports a miss instead of hiding it.'
    )
  }

  if (REDIRECTS_OUTPUT.test(command)) return null

  let sawRead = false
  let sawSearch = false

  // Every stage of every statement must be reading, slicing or searching. One
  // stage doing real work (piping into python, ForEach-Object, xargs) means the
  // file is input to a job, not something the model is trying to look at.
  for (const statement of statements(command)) {
    if (!statement.trim()) continue
    const stages = pipelineStages(statement)
    for (let i = 0; i < stages.length; i++) {
      const stage = i === 0 ? withoutAssignment(stages[i]) : stages[i]
      if (READ_COMMANDS.test(stage)) {
        sawRead = true
      } else if (SEARCH_COMMANDS.test(stage)) {
        sawSearch = true
      } else if (!SLICING_STAGES.test(stage) && !VARIABLE_SLICE.test(stage)) {
        return null
      }
    }
  }

  if (!sawRead && !sawSearch) return null

  return sawSearch
    ? 'Note: prefer the CodeIndex tool for searching — a semantic query ("where X is decided") returns ranked functions with paths and line numbers in one call. Use the Grep tool only when you need an exact string or regex match.'
    : 'Note: prefer the Read tool for reading files — it returns the contents with line numbers in a single call, and takes an offset and limit for long files.'
}

/** Prepend a tool hint to output, when there is one to give. */
export function withToolHint(command: string, output: string): string {
  const hint = betterToolHint(command)
  return hint ? `${hint}\n\n${output}` : output
}

/*
 * --- CodeIndex adoption -----------------------------------------------------
 *
 * Measured across all 8 redesign campaign missions (ledger toolStats.byName):
 * CodeIndex was called 5 times out of 3,288 tool calls — zero in the last five
 * missions — while the system prompt named it "MANDATORY FIRST STEP" in five
 * places. The exhortation is simply not load-bearing: the model's tool prior
 * (Grep/Read/Bash) wins by turn three and the prompt is never consulted again.
 *
 * The mechanism that HAS moved this model (see the header of this file) is a
 * correction riding on the output of the tool it did choose, arriving at the
 * moment of the mistake. Three such moments, in order of receptiveness:
 *
 *   1. Grep returned nothing — the exact moment the model knows its wording
 *      failed, and a semantic search is the alternative it forgot it had.
 *   2. Grep was given prose, not a regex — the model is already asking a
 *      conceptual question, just of the wrong tool.
 *   3. A long retrieval crawl with the index never consulted — each crawl
 *      turn costs a full prefill, so the tax compounds.
 *
 * Never blocks, never substitutes: the model still gets what it asked for.
 */

const RETRIEVAL_TOOLS = new Set(['Grep', 'Read', 'Glob', 'Ls'])

const CRAWL_NUDGE_EVERY = 15

let retrievalSinceCodeIndex = 0

/** Test seam: the counter is process state, and tests must not share it. */
export function resetCodeIndexNudgeState(): void {
  retrievalSinceCodeIndex = 0
}

/**
 * A Grep pattern that reads like a question rather than a regex: three or more
 * words with no regex metacharacters. Two words ("hold seat") is a legitimate
 * exact-string search and gets no lecture.
 */
export function looksSemantic(pattern: string): boolean {
  if (/[\\[\](){}|^$*+?.]/.test(pattern)) return false
  return pattern.trim().split(/\s+/).length >= 3
}

/**
 * The one-line nudge for this call, or null. Also the counter's bookkeeping:
 * call it for EVERY tool call so a CodeIndex use resets the crawl count.
 */
export function codeIndexAdoptionHint(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): string | null {
  if (toolName === 'CodeIndex') {
    retrievalSinceCodeIndex = 0
    return null
  }
  if (!RETRIEVAL_TOOLS.has(toolName)) return null
  retrievalSinceCodeIndex++
  if (isError) return null

  if (toolName === 'Grep') {
    const pattern = String(input.pattern ?? '')
    if (output.startsWith('No matches found')) {
      return (
        `Note: 0 matches. CodeIndex({ query: ${JSON.stringify(pattern)} }) searches by meaning ` +
        'rather than spelling and often finds what a pattern\u2019s exact wording misses.'
      )
    }
    if (looksSemantic(pattern)) {
      return (
        'Note: this pattern reads like a question, not a regex. ' +
        `CodeIndex({ query: ${JSON.stringify(pattern)} }) returns ranked functions with paths and ` +
        'line numbers in one call; Grep is for exact strings.'
      )
    }
  }

  if (retrievalSinceCodeIndex % CRAWL_NUDGE_EVERY === 0) {
    return (
      `Note: ${retrievalSinceCodeIndex} Grep/Read/Glob calls since your last CodeIndex query. ` +
      'When the question is WHERE something lives or HOW it works, ' +
      'CodeIndex({ query: "..." }) answers in one call what a crawl answers in ten \u2014 ' +
      'and every crawl turn pays a full prompt prefill.'
    )
  }
  return null
}

/** Prepend the CodeIndex nudge to a tool result, when there is one to give. */
export function withCodeIndexNudge(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): string {
  const hint = codeIndexAdoptionHint(toolName, input, output, isError)
  return hint ? `${hint}\n\n${output}` : output
}
