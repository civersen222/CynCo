import { exec } from 'child_process'
import type { ToolImpl } from '../types.js'
import { checkBashSafety } from '../bashSafety.js'
import { diagnoseError } from '../errorDiagnosis.js'
import { parseTestSummary } from '../../bridge/testSummary.js'
import { getShellInfo, checkShellDialect } from '../shellInfo.js'

/**
 * Decide what a non-zero exit should look like to the model.
 *
 * diagnoseError() pattern-matches the output text, so a test runner that
 * reports failing tests — which exits non-zero and whose tracebacks legitimately
 * contain AttributeError / KeyError / TypeError — used to come back headed with
 * "[ERROR: runtime] Variable or function may be undefined or wrong type".
 * Models read that banner, conclude the harness itself is broken, and burn
 * turns chasing a runtime error that does not exist.
 *
 * So: when parseTestSummary() can read a real pass/fail result out of the
 * output, return it verbatim. The suite ran; its own report says what failed,
 * far more precisely than the banner could. parseTestSummary is conservative —
 * collection errors, broken imports and usage errors return null, so a pytest
 * command that never ran a suite is still diagnosed.
 *
 * isError is unaffected: a non-zero exit remains an error result.
 */
export function formatBashFailure(command: string, rawOutput: string): string {
  if (parseTestSummary(command, rawOutput)) return rawOutput
  return diagnoseError(rawOutput).formatted
}

/**
 * Assemble what a failed command reports back.
 *
 * This used to be `stderr || stdout`, which loses the part that matters. pytest
 * writes its report to stdout, while pygame/SDL, libpng, plugin warnings and
 * deprecation notices all write to stderr — so a single line of unrelated noise
 * on stderr replaced the entire test report, and the model was left to reason
 * about a failure it could not see. Show both, stdout first, since that is where
 * a test runner puts its verdict.
 */
export function failedOutput(stderr: string, stdout: string, code: unknown): string {
  const parts = [stdout, stderr].filter(s => s && s.trim().length > 0)
  if (parts.length === 0) return `Command exited with code ${code}`
  return parts.join('\n')
}

export const bashTool: ToolImpl = {
  name: 'Bash',
  description: `Execute a shell command and return its output. The working directory persists between calls. ${getShellInfo().dialectNote}`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000, max: 600000)' },
    },
    required: ['command'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd) => {
    const command = input.command as string
    const timeout = Math.min((input.timeout as number) ?? 120000, 600000)

    const safety = checkBashSafety(command)
    if (!safety.safe) {
      return { output: `Blocked: ${safety.reason}`, isError: true }
    }

    const shellInfo = getShellInfo()
    const dialectError = checkShellDialect(command, shellInfo)
    if (dialectError) {
      return { output: dialectError, isError: true }
    }

    // Use async exec — execSync blocks the entire event loop (freezes WebSocket)
    const shell = shellInfo.shell

    return new Promise((resolve) => {
      const child = exec(command, {
        cwd,
        encoding: 'utf-8',
        timeout,
        // Force UTF-8 for Python subprocesses on Windows — the default
        // cp1252 codec crashes any script that reads/prints files
        // containing non-ASCII (emoji in game code, etc.)
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        maxBuffer: 2 * 1024 * 1024, // 2MB
        shell,
      }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed || (err as any).signal === 'SIGTERM') {
            resolve({ output: `Error: command timeout after ${timeout}ms`, isError: true })
            return
          }
          const rawOutput = failedOutput(stderr, stdout, (err as any).code)
          resolve({ output: formatBashFailure(command, rawOutput), isError: true })
          return
        }
        resolve({ output: stdout || stderr || '(no output)', isError: false })
      })
    })
  },
}
