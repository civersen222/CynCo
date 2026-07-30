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

/** The class a Python `def` at `defIndent` sits inside, or null at module level. */
function enclosingClass(lines: string[], defIdx: number, defIndent: number): string | null {
  for (let i = defIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trimStart()
    if (trimmed === '') continue
    const lineIndent = lines[i].length - trimmed.length
    if (lineIndent >= defIndent) continue
    // The first thing at a shallower indent decides it: a `class` encloses the
    // def, anything else (a module-level def, an assignment) means it does not.
    const m = /^class\s+([A-Za-z_]\w*)/.exec(trimmed)
    return m ? m[1] : null
  }
  return null
}

function label(cls: string | null, name: string, idx: number): string {
  return `${cls ? `${cls}.${name}` : name} (line ${idx + 1})`
}

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

    if (ext === 'py') {
      // A method name is only unique within its class. Collect EVERY def that
      // could be meant, tagged with the class that encloses it, so a qualified
      // name can select and an ambiguous one can be refused. Taking the first
      // match instead silently rewrites a function the model never named and
      // reports success -- the model then debugs the damage as if it were the
      // code it wrote.
      const [wantClass, wantName] = funcName.includes('.')
        ? [funcName.slice(0, funcName.lastIndexOf('.')), funcName.slice(funcName.lastIndexOf('.') + 1)]
        : [null, funcName]

      const candidates: { idx: number; indent: number; cls: string | null }[] = []
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart()
        if (!trimmed.startsWith(`def ${wantName}(`) && !trimmed.startsWith(`def ${wantName} (`)) continue
        const defIndent = lines[i].length - trimmed.length
        candidates.push({ idx: i, indent: defIndent, cls: enclosingClass(lines, i, defIndent) })
      }

      const matches = wantClass === null ? candidates : candidates.filter(c => c.cls === wantClass)

      if (matches.length === 0) {
        const near = candidates.length
          ? ` Found "${wantName}" in: ${candidates.map(c => label(c.cls, wantName, c.idx)).join(', ')}.`
          : ''
        return { output: `Error: function "${funcName}" not found in ${filePath}.${near}`, isError: true }
      }
      if (matches.length > 1) {
        return {
          output:
            `Error: "${funcName}" is ambiguous in ${filePath} — it matches ` +
            `${matches.map(c => label(c.cls, wantName, c.idx)).join(', ')}. ` +
            `Nothing was changed. Re-run with the qualified name (e.g. "${label(matches[0].cls, wantName, matches[0].idx).split(' ')[0]}").`,
          isError: true,
        }
      }
      startIdx = matches[0].idx
      indent = matches[0].indent
    } else if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trimStart()
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
      // Python: the body is the indented run after the def. Blank lines and
      // comments that trail the body belong to whatever comes NEXT -- the PEP 8
      // separator before the following def, or that def's own leading comment --
      // so the replaced range must end at the last line that is unambiguously
      // body. Sweeping them in deleted the blank lines on every call and could
      // silently delete a neighbouring comment while reporting success.
      let lastBody = startIdx
      for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim() === '') continue
        const lineIndent = line.length - line.trimStart().length
        if (lineIndent <= indent) break
        lastBody = i
      }
      endIdx = lastBody + 1
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
