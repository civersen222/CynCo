import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { ToolImpl } from '../types.js'

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
      const count = content.split(edit.old_string).length - 1
      if (count === 0) {
        results.push(`FAIL: ${edit.file_path} — old_string not found`)
        continue
      }
      if (count > 1) {
        results.push(`FAIL: ${edit.file_path} — old_string not unique (${count} occurrences)`)
        continue
      }
      content = content.replace(edit.old_string, edit.new_string)
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
