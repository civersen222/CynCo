import { resolve } from 'path'
import { existsSync } from 'fs'
import type { ToolImpl } from '../types.js'

/** Locate ripgrep binary: system PATH first, then common install locations. */
function findRg(): string {
  const localAppdata = (process.env.LOCALAPPDATA ?? '').split('\\').join('/')
  const userProfile = (process.env.USERPROFILE ?? '').split('\\').join('/')

  const searchPaths: string[] = []

  // Winget install (most common on Windows)
  if (localAppdata) {
    try {
      const wingetBase = localAppdata + '/Microsoft/WinGet/Packages'
      const fs = require('fs')
      if (fs.existsSync(wingetBase)) {
        const entries = fs.readdirSync(wingetBase) as string[]
        const rgDir = entries.find((e: string) => e.startsWith('BurntSushi.ripgrep'))
        if (rgDir) {
          // Find rg.exe recursively in the package dir
          const pkgDir = wingetBase + '/' + rgDir
          const subEntries = fs.readdirSync(pkgDir) as string[]
          for (const sub of subEntries) {
            const candidate = pkgDir + '/' + sub + '/rg.exe'
            if (fs.existsSync(candidate)) {
              searchPaths.push(candidate)
            }
          }
        }
      }
    } catch {}
  }

  // Scoop install
  if (userProfile) {
    searchPaths.push(userProfile + '/scoop/shims/rg.exe')
  }

  // Chocolatey
  searchPaths.push('C:/ProgramData/chocolatey/bin/rg.exe')

  // Program Files
  searchPaths.push('C:/Program Files/ripgrep/rg.exe')

  for (const p of searchPaths) {
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
