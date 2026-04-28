import { execSync } from 'child_process'
import { resolve } from 'path'
import type { ToolImpl } from '../types.js'

export const codeSearchTool: ToolImpl = {
  name: 'CodeSearch',
  description: 'Search for code symbols — function definitions, class declarations, exports, imports. Uses ripgrep with code-aware patterns.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Symbol name or pattern to search for' },
      type: { type: 'string', description: 'Symbol type: function, class, interface, export, import, all (default: all)' },
      path: { type: 'string', description: 'Directory to search. Defaults to cwd.' },
    },
    required: ['query'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const query = input.query as string
    const type = (input.type as string) ?? 'all'
    const dir = resolve(cwd, (input.path as string) ?? '.')

    const patterns: Record<string, string> = {
      function: `(function|const|let|var|def|fn|func)\\s+${query}`,
      class: `(class|struct|interface|type)\\s+${query}`,
      export: `export\\s+(default\\s+)?(function|class|const|let|var|type|interface)\\s+${query}`,
      import: `import.*${query}`,
      all: `(function|const|class|interface|type|export|import|def|fn|func|struct)\\s+.*${query}`,
    }

    const pattern = patterns[type] ?? patterns.all

    try {
      const stdout = execSync(
        `rg --no-heading --line-number --color never -e "${pattern}" "${dir}"`,
        { encoding: 'utf-8', timeout: 15000, maxBuffer: 512 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      const lines = stdout.split('\n').slice(0, 50)
      return { output: lines.join('\n') || 'No matches found', isError: false }
    } catch (err: any) {
      if (err.status === 1) return { output: 'No matches found', isError: false }
      return { output: `Search error: ${err.message?.slice(0, 200)}`, isError: true }
    }
  },
}
