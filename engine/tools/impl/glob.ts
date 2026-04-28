import { resolve } from 'path'
import type { ToolImpl } from '../types.js'

export const globTool: ToolImpl = {
  name: 'Glob',
  description: 'Fast file pattern matching. Supports glob patterns like "**/*.ts" or "src/**/*.py". Returns matching file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match files against' },
      path: { type: 'string', description: 'Directory to search in. Defaults to cwd.' },
    },
    required: ['pattern'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const dir = resolve(cwd, (input.path as string) ?? cwd)
    const pattern = input.pattern as string
    try {
      const glob = new Bun.Glob(pattern)
      const matches: string[] = []
      for await (const path of glob.scan({ cwd: dir, absolute: false })) {
        matches.push(path)
        if (matches.length >= 500) break
      }
      matches.sort()
      if (matches.length === 0) {
        return { output: 'No files found', isError: false }
      }
      return { output: matches.join('\n'), isError: false }
    } catch (err) {
      return { output: `Glob error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
