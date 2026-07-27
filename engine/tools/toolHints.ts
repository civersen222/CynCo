/**
 * Nudge the model back to the purpose-built tool when it reaches for the shell.
 *
 * Watched live during Gilded task L3-3.2b: CynCo read two files with eight
 * `Get-Content ... | Select-Object -Skip N -First M` calls and rewrote
 * `gilded/docket.py` with a series of
 * `python -c "content = open(f).read(); old = '''...'''; ..."` scripts — while
 * `Read`, `Grep`, `Edit`, `MultiEdit` and `ReplaceFunction` were all registered
 * and working. The engine log for that session records zero Edit failures, and it
 * had used Edit correctly in the immediately preceding task. So this is drift,
 * not a tool gap, and it is expensive three ways:
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
function isSourceRewrite(command: string): boolean {
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
    ? 'Note: prefer the Grep tool for searching file contents — it returns matches with line numbers across many files in one call.'
    : 'Note: prefer the Read tool for reading files — it returns the contents with line numbers in a single call, and takes an offset and limit for long files.'
}

/** Prepend a tool hint to output, when there is one to give. */
export function withToolHint(command: string, output: string): string {
  const hint = betterToolHint(command)
  return hint ? `${hint}\n\n${output}` : output
}
