import { readFileSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { readFile } from 'fs/promises'
import type { ToolImpl } from '../types.js'

export const readTool: ToolImpl = {
  name: 'Read',
  description: 'Read a file from the local filesystem. Returns file contents with line numbers. Can read text files, and returns base64 for binary/image files.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based). Optional.' },
      limit: { type: 'number', description: 'Number of lines to read. Default: 2000.' },
    },
    required: ['file_path'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const filePath = resolve(cwd, input.file_path as string)
    if (!existsSync(filePath)) {
      return { output: `Error: file not found: ${filePath}`, isError: true }
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { output: `Error: ${filePath} is a directory, not a file. Use Glob or Bash ls.`, isError: true }
    }

    const ext = filePath.toLowerCase().split('.').pop() ?? ''
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico']
    if (imageExts.includes(ext)) {
      const buf = await readFile(filePath)
      return { output: `[Image file: ${filePath}, ${buf.length} bytes, base64 available for vision models]`, isError: false }
    }

    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')
      const offset = Math.max(0, ((input.offset as number) ?? 1) - 1)
      const limit = (input.limit as number) ?? 2000
      const slice = lines.slice(offset, offset + limit)
      const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n')
      return { output: numbered, isError: false }
    } catch (err) {
      return { output: `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
