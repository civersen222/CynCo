/**
 * ReplaceFunction tool — replaces an entire function/method body by name.
 *
 * Unlike Edit (which requires exact old_string matching), this tool finds
 * a function by its signature line and replaces everything from the def/function
 * line to the end of its body. This handles the case where the model knows
 * WHAT function to replace but can't hold the exact 50-line old_string in memory.
 *
 * Supports: Python (def), TypeScript/JavaScript (function, const =, class method)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { ToolImpl } from '../types.js'

export const replaceFunctionTool: ToolImpl = {
  name: 'ReplaceFunction',
  description: 'Replace an entire function or method by name. Finds the function by its def/function line and replaces the whole body. Use this instead of Edit when replacing large function blocks.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file' },
      function_name: { type: 'string', description: 'Name of the function/method to replace (e.g., "create_sample_game" or "MyClass.my_method")' },
      new_body: { type: 'string', description: 'The complete new function including the def/function line and body' },
    },
    required: ['file_path', 'function_name', 'new_body'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd) => {
    const filePath = resolve(cwd, input.file_path as string)
    const funcName = input.function_name as string
    const newBody = input.new_body as string

    if (!existsSync(filePath)) {
      return { output: `Error: file not found: ${filePath}`, isError: true }
    }

    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''

    // Find the function start line
    let startIdx = -1
    let indent = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trimStart()

      // Python: def funcName( or class.method
      if (ext === 'py') {
        if (trimmed.startsWith(`def ${funcName}(`) || trimmed.startsWith(`def ${funcName} (`)) {
          startIdx = i
          indent = line.length - trimmed.length
          break
        }
        // Check for method: "def method_name(" with any indentation
        if (funcName.includes('.')) {
          const methodName = funcName.split('.').pop()
          if (trimmed.startsWith(`def ${methodName}(`)) {
            startIdx = i
            indent = line.length - trimmed.length
            break
          }
        }
      }

      // TypeScript/JavaScript
      if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
        if (trimmed.startsWith(`function ${funcName}(`) ||
            trimmed.startsWith(`export function ${funcName}(`) ||
            trimmed.startsWith(`async function ${funcName}(`) ||
            trimmed.startsWith(`export async function ${funcName}(`) ||
            trimmed.includes(`${funcName} = (`) ||
            trimmed.includes(`${funcName} = function`) ||
            trimmed.includes(`${funcName}(`)) {
          startIdx = i
          indent = line.length - trimmed.length
          break
        }
      }
    }

    if (startIdx === -1) {
      return { output: `Error: function "${funcName}" not found in ${filePath}`, isError: true }
    }

    // Find the function end
    let endIdx = startIdx + 1

    if (ext === 'py') {
      // Python: function ends when we hit a line at same or lower indentation
      // (that isn't blank or a comment)
      for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim() === '' || line.trim().startsWith('#')) {
          endIdx = i + 1
          continue
        }
        const lineIndent = line.length - line.trimStart().length
        if (lineIndent <= indent && line.trim() !== '') {
          endIdx = i
          break
        }
        endIdx = i + 1
      }
    } else {
      // JS/TS: function ends at matching closing brace
      let braceDepth = 0
      let foundOpen = false
      for (let i = startIdx; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') { braceDepth++; foundOpen = true }
          if (ch === '}') braceDepth--
        }
        if (foundOpen && braceDepth <= 0) {
          endIdx = i + 1
          break
        }
        endIdx = i + 1
      }
    }

    // Replace
    const before = lines.slice(0, startIdx)
    const after = lines.slice(endIdx)
    const newContent = [...before, newBody, ...after].join('\n')

    writeFileSync(filePath, newContent)

    const oldLineCount = endIdx - startIdx
    const newLineCount = newBody.split('\n').length
    return {
      output: `Replaced function "${funcName}" in ${filePath}: ${oldLineCount} lines → ${newLineCount} lines (at line ${startIdx + 1})`,
      isError: false,
    }
  },
}
