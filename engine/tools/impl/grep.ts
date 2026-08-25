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

/**
 * What a failed ripgrep run should look like to the model.
 *
 * This used to be `Grep error: ${stderr}`, which is exactly right when ripgrep
 * complains and says nothing at all when it doesn't. Measured on Gilded
 * I4d2b3g: five calls in a row came back as the literal string "Grep error: "
 * with nothing after it. The run could not tell a bad pattern from a ripgrep
 * that never ran, so it rewrote the pattern four times, tripped the circuit
 * breaker, and abandoned the tool.
 *
 * So when ripgrep is silent, say what the tool itself knows — how it ended, and
 * what was run — and say plainly that the pattern is not the suspect. That last
 * part is the load-bearing half: the failure mode here is not a missing detail,
 * it is a model correctly concluding that the only thing it controls must be at
 * fault.
 */
export function grepFailure(
  argv: string[],
  exitCode: number | null,
  signalCode: string | null,
  stderr: string,
): string {
  const said = stderr.trim()
  if (said) return `Grep error: ${said}`
  const how = signalCode ? `killed by ${signalCode}` : `exit code ${exitCode}`
  return `Grep error: ripgrep ended with ${how} and wrote nothing to stderr. `
    + `A search that reports no error is not the pattern — the pattern was never `
    + `judged. Suspect the environment, and reproduce by hand: ${argv.join(' ')}`
}

export const grepTool: ToolImpl = {
  name: 'Grep',
  description: 'Search file contents using regex patterns. Returns matching lines with file paths and line numbers. Use ONLY when you need an exact string or regex match; for conceptual questions ("where is combat resolved") call CodeIndex first.',
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
  core: true,
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
        return {
          output: grepFailure(args, proc.exitCode, proc.signalCode ?? null, stderr),
          isError: true,
        }
      }
      const lines = stdout.split('\n').slice(0, 250)
      return { output: lines.join('\n'), isError: false }
    } catch (err) {
      return { output: `Grep error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
