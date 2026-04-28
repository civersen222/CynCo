import type { ToolImpl } from '../types.js'

const DANGEROUS_PATTERNS = [/push\s+--force/, /reset\s+--hard/, /clean\s+-f/, /branch\s+-D/]

export const gitTool: ToolImpl = {
  name: 'Git',
  description: 'Run git commands. Read-only commands (status, log, diff) auto-approve. Write commands (commit, checkout) require approval. Dangerous commands (push --force, reset --hard) are blocked.',
  inputSchema: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', description: 'Git subcommand: status, log, diff, commit, checkout, branch, etc.' },
      args: { type: 'string', description: 'Additional arguments for the git command' },
    },
    required: ['subcommand'],
  },
  tier: 'approval',
  execute: async (input, cwd) => {
    const sub = input.subcommand as string
    const args = (input.args as string) ?? ''
    const fullCmd = `git ${sub} ${args}`.trim()

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(fullCmd)) {
        return { output: `Error: dangerous git command blocked: ${fullCmd}. This could cause data loss.`, isError: true }
      }
    }

    try {
      const proc = Bun.spawn(['git', sub, ...args.split(/\s+/).filter(Boolean)], {
        cwd, stdout: 'pipe', stderr: 'pipe',
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited
      if (proc.exitCode !== 0) {
        return { output: stderr || `git ${sub} exited with code ${proc.exitCode}`, isError: true }
      }
      return { output: stdout || '(no output)', isError: false }
    } catch (err) {
      return { output: `Git error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  },
}
