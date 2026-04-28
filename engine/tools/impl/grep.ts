import { resolve } from 'path'
import { existsSync } from 'fs'
import type { ToolImpl } from '../types.js'

/** Locate ripgrep binary: system PATH first, then common vendored locations. */
function findRg(): string {
  // On Windows, rg may not be on PATH — fall back to vendored copy.
  // Use forward-slash paths (Bun/Node on Windows accepts both).
  const appdata = (process.env.APPDATA ?? '').split('\\').join('/')
  const localAppdata = (process.env.LOCALAPPDATA ?? '').split('\\').join('/')
  const vendoredPaths: string[] = []
  if (appdata) {
    vendoredPaths.push(
      appdata + '/npm/node_modules/cynco/vendor/ripgrep/x64-win32/rg.exe',
    )
  }
  if (localAppdata) {
    // npx cache path: find any matching subfolder
    vendoredPaths.push(
      localAppdata + '/npm-cache/_npx/becf7b9e49303068/node_modules/cynco/vendor/ripgrep/x64-win32/rg.exe',
    )
  }
  for (const p of vendoredPaths) {
    if (existsSync(p)) return p
  }
  return 'rg' // fallback: assume on PATH
}

export const grepTool: ToolImpl = {
  name: 'Grep',
  description: 'Search file contents using regex patterns. Returns matching lines with file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in. Defaults to cwd.' },
      glob: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.ts")' },
      context: { type: 'number', description: 'Lines of context around matches' },
    },
    required: ['pattern'],
  },
  tier: 'auto',
  execute: async (input, cwd) => {
    const dir = resolve(cwd, (input.path as string) ?? '.')
    const pattern = input.pattern as string
    const fileGlob = (input.glob as string) ?? undefined
    const ctx = (input.context as number) ?? 0

    try {
      const rgBin = findRg()
      const args = [rgBin, '--no-heading', '--line-number', '--color', 'never', '--max-count', '250']
      if (ctx > 0) args.push('-C', String(ctx))
      if (fileGlob) args.push('--glob', fileGlob)
      args.push(pattern, dir)

      const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited

      if (proc.exitCode === 1) {
        return { output: 'No matches found', isError: false }
      }
      if (proc.exitCode !== 0 && proc.exitCode !== 1) {
        return { output: `Grep error: ${stderr}`, isError: true }
      }
      const lines = stdout.split('\n').slice(0, 250)
      return { output: lines.join('\n'), isError: false }
    } catch (err) {
      return { output: `Grep error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
