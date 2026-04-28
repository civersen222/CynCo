import { exec } from 'child_process'
import type { ToolImpl } from '../types.js'
import { checkBashSafety } from '../bashSafety.js'

export const bashTool: ToolImpl = {
  name: 'Bash',
  description: 'Execute a shell command and return its output. The working directory persists between calls. On Windows, uses PowerShell.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000, max: 600000)' },
    },
    required: ['command'],
  },
  tier: 'approval',
  execute: async (input, cwd) => {
    const command = input.command as string
    const timeout = Math.min((input.timeout as number) ?? 120000, 600000)

    const safety = checkBashSafety(command)
    if (!safety.safe) {
      return { output: `Blocked: ${safety.reason}`, isError: true }
    }

    // Use async exec — execSync blocks the entire event loop (freezes WebSocket)
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'powershell.exe' : '/bin/bash'

    return new Promise((resolve) => {
      const child = exec(command, {
        cwd,
        encoding: 'utf-8',
        timeout,
        env: process.env,
        maxBuffer: 2 * 1024 * 1024, // 2MB
        shell,
      }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed || (err as any).signal === 'SIGTERM') {
            resolve({ output: `Error: command timeout after ${timeout}ms`, isError: true })
            return
          }
          const output = stderr || stdout || `Command exited with code ${(err as any).code}`
          resolve({ output, isError: true })
          return
        }
        resolve({ output: stdout || stderr || '(no output)', isError: false })
      })
    })
  },
}
