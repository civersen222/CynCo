import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import type { ToolImpl } from '../types.js'

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
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, content)
      return { output: `File written: ${filePath} (${content.length} bytes)`, isError: false }
    } catch (err) {
      return { output: `Error writing ${filePath}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
