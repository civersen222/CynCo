import { exec } from 'child_process'
import { resolve } from 'path'
import type { ToolImpl } from '../types.js'

export const codeSearchTool: ToolImpl = {
  name: 'CodeSearch',
  description: 'Search for code symbols — function definitions, class declarations, exports, imports. Works with or without ripgrep.',
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

    // Try ripgrep first, fall back to PowerShell Select-String on Windows, grep on Unix
    const isWindows = process.platform === 'win32'
    const rgCmd = `rg --no-heading --line-number --color never -e "${pattern}" "${dir}"`
    const fallbackCmd = isWindows
      ? `powershell -Command "Get-ChildItem -Path '${dir}' -Recurse -Include *.py,*.ts,*.js,*.tsx,*.jsx,*.rs,*.go,*.java,*.c,*.cpp | Select-String -Pattern '${query}' | Select-Object -First 50 | ForEach-Object { $_.ToString() }"`
      : `grep -rn "${query}" "${dir}" --include="*.py" --include="*.ts" --include="*.js" | head -50`

    return new Promise((resolve) => {
      // Try rg first
      exec(rgCmd, { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 512 * 1024 }, (err, stdout) => {
        if (!err && stdout.trim()) {
          const lines = stdout.split('\n').slice(0, 50)
          resolve({ output: lines.join('\n'), isError: false })
          return
        }

        // rg failed or not found — try fallback
        exec(fallbackCmd, { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 512 * 1024, shell: isWindows ? 'powershell.exe' : '/bin/bash' }, (err2, stdout2) => {
          if (err2 || !stdout2.trim()) {
            resolve({ output: 'No matches found', isError: false })
            return
          }
          const lines = stdout2.split('\n').slice(0, 50)
          resolve({ output: lines.join('\n'), isError: false })
        })
      })
    })
  },
}
