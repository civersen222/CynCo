import { writeFileSync, mkdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { resolve, dirname } from 'path'
import type { ToolImpl } from '../types.js'

// A file under this size is a stub; rewriting it wholesale loses nothing worth a refusal.
const SUBSTANTIAL_BYTES = 1000
// Below this fraction of what is already there, the write is a truncation, not a revision.
const SHRINK_FLOOR = 0.5

/**
 * Does git, in this working tree, already know about `path`?
 *
 * The shrink guard protects HISTORY, and a file git has never seen has none.
 * The Stage 11I run lost nine Write calls to the guard, every one of them
 * `probe.py` — the single scratch file every mission brief mandates and the
 * only name the hygiene gate whitelists. The refusal told it to "delete the
 * file first, then write", which for an untracked file recovers nothing and
 * leaves no trace: a Read and a retry charged for a ceremony.
 *
 * Worse, it pushed toward Edit, and a probe edited rather than rewritten
 * accumulates its old measurement beside the new one until it prints a
 * confident number for something it is no longer measuring.
 *
 * `ls-files` answers all three states in one call: a line of output means
 * tracked, empty output with a clean exit means untracked inside a repo, and a
 * non-zero exit means no repo or no git. Only the middle case lifts the guard —
 * unknown means protect, which is what keeps the guard on outside a repository.
 *
 * Staged counts as tracked. `git add` is the model saying this is work, and
 * from that moment the content is recoverable from the index.
 */
function gitKnowsFile(path: string): boolean | null {
  try {
    const out = execFileSync('git', ['-C', dirname(path), 'ls-files', '--', path], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out.trim().length > 0
  } catch {
    return null
  }
}

/** Bytes currently on disk at `path`, or null if there is nothing there to lose. */
function existingSize(path: string): number | null {
  try {
    const st = statSync(path)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

export const writeTool: ToolImpl = {
  name: 'Write',
  description: "Write content to a file, creating it if it doesn't exist. Overwrites existing files. Creates parent directories automatically.",
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to write' },
      content: { type: 'string', description: 'The content to write to the file' },
    },
    required: ['file_path', 'content'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd) => {
    const filePath = resolve(cwd, input.file_path as string)
    // Coerce to string — local models sometimes pass non-string content (null, number, object)
    const raw = input.content
    const content = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
    // Reject empty writes — 0-byte files are never what the model intended
    if (content.trim().length === 0) {
      return {
        output: `ERROR: Cannot write empty file to ${filePath}. You must provide actual content in the 'content' field. Generate the full file content and try again.`,
        isError: true,
      }
    }
    // Reject writes that gut a file that already exists. A whole test suite has
    // been replaced by four cases in a single Write; the advisory hint fired and
    // the model wrote anyway. Deleting the file first is the escape hatch, so a
    // deliberate truncation stays possible and leaves a trace in the transcript.
    const before = existingSize(filePath)
    const after = Buffer.byteLength(content)
    if (before !== null && before >= SUBSTANTIAL_BYTES && after < before * SHRINK_FLOOR
        && gitKnowsFile(filePath) !== false) {
      return {
        output:
          `ERROR: Refusing to write ${filePath} — this would cut it from ${before} bytes to ${after}, ` +
          `discarding ${before - after} bytes you have not shown you meant to lose. ` +
          `Read the file and use Edit or MultiEdit to change the parts you mean to change. ` +
          `If you really do intend to replace the whole file with something much smaller, delete it first, then write.`,
        isError: true,
      }
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, content)
      return { output: `File written: ${filePath} (${content.length} bytes)`, isError: false }
    } catch (err) {
      return { output: `Error writing ${filePath}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
