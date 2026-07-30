import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { ToolImpl } from '../types.js'

/**
 * When old_string is not found, quote back what the file actually says at the
 * place the model was aiming at. Returns null when that place cannot be
 * identified.
 *
 * The anchor is the LONGEST line of old_string that occurs exactly once in the
 * file — not simply the longest line. Measured on the L3-3.3 run: the longest
 * line of both failed old_strings was a regex the model had invented and the
 * file had never contained, so length alone finds nothing.
 *
 * The window starts at the anchor's file line minus the anchor's offset within
 * old_string, so it covers the span the model believed it was matching. A
 * window starting at the anchor would show only the lines it already had right.
 */
export function nearMissWindow(content: string, oldStr: string, maxLines = 14): string | null {
  const fileLines = content.split('\n')
  const trimmedFile = fileLines.map(l => l.trim())
  const oldLines = oldStr.split('\n')

  let anchorOldIdx = -1
  let anchorFileIdx = -1
  let anchorLen = 0
  for (let i = 0; i < oldLines.length; i++) {
    const needle = oldLines[i].trim()
    if (!needle || needle.length <= anchorLen) continue
    let hits = 0
    let where = -1
    for (let j = 0; j < trimmedFile.length && hits < 2; j++) {
      if (trimmedFile[j] === needle) { hits++; where = j }
    }
    if (hits === 1) {
      anchorOldIdx = i
      anchorFileIdx = where
      anchorLen = needle.length
    }
  }
  if (anchorOldIdx < 0) return null

  const start = Math.max(0, anchorFileIdx - anchorOldIdx)
  const end = Math.min(fileLines.length, start + Math.min(maxLines, oldLines.length))
  return fileLines.slice(start, end).map((l, k) => `${start + k + 1}\t${l}`).join('\n')
}

export const editTool: ToolImpl = {
  name: 'Edit',
  description: 'Perform exact string replacements in files. The old_string must be unique in the file unless replace_all is true.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to edit' },
      old_string: { type: 'string', description: 'The exact text to replace' },
      new_string: { type: 'string', description: 'The text to replace it with' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd) => {
    const filePath = resolve(cwd, input.file_path as string)
    const oldStr = String(input.old_string ?? '')
    const newStr = String(input.new_string ?? '')
    const replaceAll = (input.replace_all as boolean) ?? false

    console.log(`[edit] ${filePath}:`)
    console.log(`[edit]   old_string (${oldStr.length} chars): ${oldStr.slice(0, 200)}`)
    console.log(`[edit]   new_string (${newStr.length} chars): ${newStr.slice(0, 200)}`)

    if (!existsSync(filePath)) {
      return { output: `Error: file not found: ${filePath}`, isError: true }
    }

    try {
      let content = readFileSync(filePath, 'utf-8')
      // Normalize line endings for matching — model sends \n but file may have \r\n
      const usesCRLF = content.includes('\r\n')
      if (usesCRLF) {
        content = content.replace(/\r\n/g, '\n')
      }
      const normalizedOld = oldStr.replace(/\r\n/g, '\n')
      const normalizedNew = newStr.replace(/\r\n/g, '\n')
      const occurrences = content.split(normalizedOld).length - 1

      if (occurrences === 0) {
        // A no-match fails cleanly. An LLM-mediated "semantic merge" fallback
        // used to live here; it was disabled because it corrupted files when the
        // local model produced garbled output, and the disabled module has now
        // been removed. Failing cleanly is right — the model retries with a
        // correct old_string, or uses ReplaceFunction for a large span.
        console.log(`[edit] old_string not found in ${filePath} (${oldStr.length} chars) — failing cleanly.`)
        // Failing cleanly is right; sending the model away to Read is not. This
        // message was the read attractor: measured on the L3-3.3 run, a failed
        // Edit whose old_string was 0.67-similar to a real span produced 344
        // Reads and 8 Edits over 370 turns, and the file gained one line. The
        // engine has the answer in `content` at this instant, so it says it.
        const near = nearMissWindow(content, normalizedOld)
        if (near) {
          return {
            output: `Error: old_string not found in ${filePath}. Do NOT re-read the file — here is exactly what it contains at the closest matching location. Compare it to your old_string character by character, then call Edit again using these exact characters:\n${near}\n\nIf the span you want to replace is a whole function, use ReplaceFunction instead.`,
            isError: true,
          }
        }
        return { output: `Error: old_string not found in ${filePath}. The text you provided does not match any content in the file. Re-read the file to get the exact text, then try again with the correct old_string. If the function is large, use ReplaceFunction instead.`, isError: true }
      }
      if (occurrences > 1 && !replaceAll) {
        return { output: `Error: old_string is not unique in ${filePath} (found ${occurrences} times). Use replace_all: true to replace all, or provide more context to make it unique.`, isError: true }
      }

      if (replaceAll) {
        content = content.split(normalizedOld).join(normalizedNew)
      } else {
        content = content.replace(normalizedOld, normalizedNew)
      }

      // Restore CRLF if the original file used it
      if (usesCRLF) {
        content = content.replace(/\n/g, '\r\n')
      }

      writeFileSync(filePath, content)
      return { output: `Edited ${filePath}: replaced ${replaceAll ? occurrences : 1} occurrence(s)`, isError: false }
    } catch (err) {
      return { output: `Error editing ${filePath}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
