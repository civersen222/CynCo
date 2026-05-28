import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { ToolImpl, ToolResult } from '../types.js'
import { attemptSemanticMerge } from '../semanticMerge.js'

// Track which files have been attempted for semantic merge this session
const mergeAttemptedFiles = new Set<string>()

/** Reset merge tracking at the start of each turn. Called from conversation loop. */
export function resetMergeTracking(): void {
  mergeAttemptedFiles.clear()
}

// Side query function — injected by conversation loop
let _sideQuery: ((prompt: string, system?: string) => Promise<string>) | null = null

/** Set the side query function for semantic merge. Called from conversation loop. */
export function setSideQuery(fn: (prompt: string, system?: string) => Promise<string>): void {
  _sideQuery = fn
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
  execute: async (input, cwd) => {
    const filePath = resolve(cwd, input.file_path as string)
    const oldStr = String(input.old_string ?? '')
    const newStr = String(input.new_string ?? '')
    const replaceAll = (input.replace_all as boolean) ?? false

    console.log(`[edit] ${filePath}: old_string=${oldStr.slice(0, 80)}... new_string=${newStr.slice(0, 80)}...`)

    if (!existsSync(filePath)) {
      return { output: `Error: file not found: ${filePath}`, isError: true }
    }

    try {
      let content = readFileSync(filePath, 'utf-8')
      const occurrences = content.split(oldStr).length - 1

      if (occurrences === 0) {
        // Semantic merge fallback: old_str not found, try LLM-powered merge
        if (_sideQuery) {
          const mergePrompt = attemptSemanticMerge(content, oldStr, newStr, filePath, mergeAttemptedFiles)
          if (mergePrompt) {
            try {
              const merged = await _sideQuery(mergePrompt.user, mergePrompt.system)
              if (merged && merged.trim() && merged.trim() !== content.trim()) {
                writeFileSync(filePath, merged.trim())
                return { output: `Edited ${filePath}: applied via semantic merge (exact match failed)`, isError: false }
              }
            } catch (mergeErr) {
              console.log(`[edit] Semantic merge failed: ${mergeErr}`)
            }
          }
        }
        return { output: `Error: old_string not found in ${filePath}`, isError: true }
      }
      if (occurrences > 1 && !replaceAll) {
        return { output: `Error: old_string is not unique in ${filePath} (found ${occurrences} times). Use replace_all: true to replace all, or provide more context to make it unique.`, isError: true }
      }

      if (replaceAll) {
        content = content.split(oldStr).join(newStr)
      } else {
        content = content.replace(oldStr, newStr)
      }

      writeFileSync(filePath, content)
      return { output: `Edited ${filePath}: replaced ${replaceAll ? occurrences : 1} occurrence(s)`, isError: false }
    } catch (err) {
      return { output: `Error editing ${filePath}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
