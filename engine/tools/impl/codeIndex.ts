import { exec } from 'child_process'
import type { ToolImpl } from '../types.js'
import { ProjectIndexer } from '../../index/indexer.js'

let indexer: ProjectIndexer | null = null

/** Fallback: regex search via ripgrep or PowerShell when vector index returns nothing. */
function regexFallback(query: string, cwd: string): Promise<string> {
  const isWindows = process.platform === 'win32'
  const rgCmd = `rg --no-heading --line-number --color never -e "${query}" "${cwd}" --type-add "code:*.{py,ts,js,tsx,jsx,rs,go,java,c,cpp,rb}" -t code`
  const psCmd = `powershell -Command "Get-ChildItem -Path '${cwd}' -Recurse -Include *.py,*.ts,*.js,*.tsx,*.jsx | Select-String -Pattern '${query}' | Select-Object -First 30 | ForEach-Object { $_.ToString() }"`
  const fallbackCmd = isWindows ? psCmd : `grep -rn "${query}" "${cwd}" --include="*.py" --include="*.ts" --include="*.js" | head -30`

  return new Promise((resolve) => {
    exec(rgCmd, { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        resolve(stdout.split('\n').slice(0, 30).join('\n'))
        return
      }
      // rg not found — try fallback
      exec(fallbackCmd, { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 512 * 1024, shell: isWindows ? 'powershell.exe' : '/bin/bash' }, (err2, stdout2) => {
        resolve(stdout2?.trim() || '')
      })
    })
  })
}

export const codeIndexTool: ToolImpl = {
  name: 'CodeIndex',
  description: 'Search the codebase — tries semantic vector search first, falls back to regex pattern matching. Returns relevant functions, classes, and code blocks. Use this BEFORE Read to find the right files.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for — natural language ("combat system") or exact patterns ("def resolve_combat")' },
      top_k: { type: 'number', description: 'Number of results to return (default: 5, max: 20)' },
    },
    required: ['query'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const query = input.query as string
    const topK = Math.min(Math.max((input.top_k as number) ?? 5, 1), 20)

    // Try vector index first
    if (!indexer) {
      try { indexer = new ProjectIndexer(cwd) } catch {}
    }

    if (indexer) {
      try {
        const results = await indexer.query({ query, topK })
        if (results.length > 0) {
          return { output: indexer.formatResults(results), isError: false }
        }
      } catch {}
    }

    // Vector search returned nothing — fall back to regex
    console.log(`[CodeIndex] Vector search empty for "${query.slice(0, 40)}" — falling back to regex`)
    const regexResults = await regexFallback(query, cwd)
    if (regexResults) {
      return { output: `[regex fallback]\n${regexResults}`, isError: false }
    }

    return { output: `No results for "${query}". Try a different search term, or run /analyze to rebuild the index.`, isError: false }
  },
}
