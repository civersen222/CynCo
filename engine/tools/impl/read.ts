import { readFileSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { readFile } from 'fs/promises'
import type { ToolImpl } from '../types.js'
import { missingFileHint } from './pathHint.js'

/**
 * Decode a file's bytes, honouring a byte order mark if one is there.
 *
 * A BOM is how a file says how to read it. Decoding everything as UTF-8
 * regardless made Read report the mark as content — `\ufeff` welded to the first
 * token of line 1, which silently defeats every line-start match the model
 * makes — and made a UTF-16LE file come back as NUL-interleaved mojibake.
 *
 * That was not a rare case. Windows PowerShell 5.1 writes UTF-16LE from `>`, so
 * the agent produced such files itself and then could not read them
 * (task-19db3979 recorded one, `test_output.txt`, which git classified as binary
 * and the run eventually deleted). bash.ts now sets the redirection encoding, so
 * new ones are UTF-8 — but files arrive from editors and other tools too, and a
 * mark that is present should be obeyed rather than shown.
 *
 * No mark, no change: plain UTF-8 is every file in the repo and takes the same
 * path it always did.
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString('utf16le')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf-8')
  return buf.toString('utf-8')
}

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
  core: true,
  execute: async (input, cwd) => {
    const filePath = resolve(cwd, input.file_path as string)
    if (!existsSync(filePath)) {
      return { output: missingFileHint(filePath), isError: true }
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
      const content = decodeText(readFileSync(filePath))
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
