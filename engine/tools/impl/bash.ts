import { exec } from 'child_process'
import type { ToolImpl } from '../types.js'
import { checkBashSafety } from '../bashSafety.js'
import { diagnoseError } from '../errorDiagnosis.js'
import { parseTestSummary } from '../../bridge/testSummary.js'
import { getShellInfo, autoTranslateEnvPrefix, checkShellDialect, shellPreamble, stripTrailingStderrMerge } from '../shellInfo.js'
import { withToolHint } from '../toolHints.js'

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

    // `NAME=value command` is a parse error in every PowerShell, and the engine
    // has always known the exact replacement — it quoted it back in an error and
    // charged a turn for it. Measured on the Wave 4 run: five of the agent's
    // Bash errors were this, long after the error had already taught it once, so
    // the lesson does not carry across turns and gets paid for repeatedly.
    // Translate it where the translation provably means the same thing; where it
    // would widen the variable's scope autoTranslateEnvPrefix returns null and
    // checkShellDialect still refuses with the instructive message.
    const dialected = autoTranslateEnvPrefix(command, shellInfo) ?? command
    const dialectError = checkShellDialect(dialected, shellInfo)
    if (dialectError) {
      return { output: dialectError, isError: true }
    }

    // Use async exec — execSync blocks the entire event loop (freezes WebSocket)
    const shell = shellInfo.shell

    // F60. A trailing `2>&1` is a request to see stderr, and in PowerShell it is
    // also a request to fail: it leaves `$?` false for any command that wrote to
    // stderr at all, so a successful `git worktree add` came back as an error.
    // Drop it and honour the request on the success path instead.
    const merged = stripTrailingStderrMerge(dialected, shellInfo)

    // The command is reported, diagnosed and hinted on as the model wrote it;
    // only what reaches the shell carries the preamble. See shellPreamble.
    const runnable = shellPreamble(shellInfo) + merged.command

    return new Promise((resolve) => {
      const child = exec(runnable, {
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
            // A bare "timeout after 60000ms" leaves the model unable to tell
            // "my command hangs" from "my budget was too small" — opposite
            // fixes. Measured on the Wave 4 run: it asked for 60s against a
            // ~52s suite, lost the race twice, and got back neither the partial
            // pytest report nor the fact that it may ask for up to 600000ms.
            const partial = failedOutput(stderr, stdout, (err as any).code)
            resolve({
              output: `Error: command timeout after ${timeout}ms. If the command was ` +
                `making progress rather than hanging, retry it with a larger ` +
                `timeout (max 600000ms). Output collected before the kill:\n${partial}`,
              isError: true,
            })
            return
          }
          const rawOutput = failedOutput(stderr, stdout, (err as any).code)
          resolve({ output: formatBashFailure(command, rawOutput), isError: true })
          return
        }
        // F60. Only when a merge was stripped, so the model gets exactly what it
        // asked for and no other run gains SDL/pygame stderr noise it did not.
        const succeeded = merged.stripped
          ? (failedOutput(stderr, stdout, 0).replace(/^Command exited with code 0$/, '(no output)'))
          : (stdout || stderr || '(no output)')
        // Hint on success only. A failing command already has the model's full
        // attention on its own error; adding tool advice there buries the reason
        // it failed under advice it did not ask for.
        resolve({ output: withToolHint(command, succeeded), isError: false })
      })
    })
  },
}
