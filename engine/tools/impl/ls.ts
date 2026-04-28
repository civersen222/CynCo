import { readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import type { ToolImpl } from '../types.js'

export const lsTool: ToolImpl = {
  name: 'Ls',
  description: 'List directory contents with file sizes and types. Useful for understanding project structure.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list. Defaults to cwd.' },
      recursive: { type: 'boolean', description: 'List recursively (max 3 levels deep). Default: false.' },
    },
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const dir = resolve(cwd, (input.path as string) ?? '.')
    const recursive = (input.recursive as boolean) ?? false
    try {
      const lines: string[] = []
      listDir(dir, '', lines, recursive ? 3 : 0)
      return { output: lines.join('\n'), isError: false }
    } catch (err) {
      return { output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}

function listDir(dir: string, indent: string, lines: string[], maxDepth: number): void {
  const entries = readdirSync(dir).sort()
  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.gitignore') continue
    const full = join(dir, entry)
    try {
      const stat = statSync(full)
      if (stat.isDirectory()) {
        lines.push(`${indent}${entry}/`)
        if (maxDepth > 0) listDir(full, indent + '  ', lines, maxDepth - 1)
      } else {
        const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}K`
        lines.push(`${indent}${entry} (${size})`)
      }
    } catch {}
  }
}
