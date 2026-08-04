import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { ToolImpl } from '../types.js'
import { nearMissWindow } from './edit.js'

type EditOp = { file_path: string; old_string: string; new_string: string }

export const multiEditTool: ToolImpl = {
  name: 'MultiEdit',
  description: 'Apply multiple string replacements across one or more files in a single operation. Each edit must have a unique old_string in its target file.',
  inputSchema: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        description: 'Array of edit operations',
        items: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    required: ['edits'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd) => {
    const edits = input.edits as EditOp[]
    const results: string[] = []

    for (const edit of edits) {
      const filePath = resolve(cwd, edit.file_path)
      if (!existsSync(filePath)) {
        results.push(`FAIL: ${edit.file_path} — file not found`)
        continue
      }
      let content = readFileSync(filePath, 'utf-8')
      // Match on LF and restore on write, exactly as Edit does. Without this a
      // multi-line old_string can never match a CRLF file: the model sends \n
      // and the file holds \r\n. Measured on three consecutive civkings waves,
      // where every MultiEdit missed and the same anchors then applied through
      // Edit. Single-line anchors hid it — they carry no newline.
      const usesCRLF = content.includes('\r\n')
      if (usesCRLF) {
        content = content.replace(/\r\n/g, '\n')
      }
      const oldStr = edit.old_string.replace(/\r\n/g, '\n')
      const newStr = edit.new_string.replace(/\r\n/g, '\n')

      const count = content.split(oldStr).length - 1
      if (count === 0) {
        // The engine is holding the file at this instant, so it quotes what is
        // actually there instead of sending the model back to Read.
        const near = nearMissWindow(content, oldStr)
        results.push(near
          ? `FAIL: ${edit.file_path} — old_string not found. Do NOT re-read the file; here is what it contains at the closest matching location. Compare character by character, then retry with these exact characters:\n${near}`
          : `FAIL: ${edit.file_path} — old_string not found`)
        continue
      }
      if (count > 1) {
        results.push(`FAIL: ${edit.file_path} — old_string not unique (${count} occurrences)`)
        continue
      }
      content = content.replace(oldStr, newStr)
      if (usesCRLF) {
        content = content.replace(/\n/g, '\r\n')
      }
      writeFileSync(filePath, content)
      results.push(`OK: ${edit.file_path}`)
    }

    const failures = results.filter(r => r.startsWith('FAIL'))
    return {
      output: results.join('\n'),
      isError: failures.length > 0,
    }
  },
}
