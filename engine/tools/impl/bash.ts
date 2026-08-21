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
 *
 * The both-empty case is the one that used to say least and needed to say most.
 * Measured on Gilded I4d2b3g: every Bash call in the run came back as the bare
 * line `Command exited with code 66` — no stream, no signal, no shell named.
 * `python --version` failed that way, and so did `Write-Host "hello"`, but the
 * model could not see that they had failed for the same reason, so it read the
 * fault as its own and rewrote the command eight times. A command that prints
 * nothing is the one failure the model cannot reason about unaided, so `context`
 * carries what the tool knows (which shell, which signal) and the text says
 * outright that the command it wrote is not the suspect.
 */
export function failedOutput(
  stderr: string,
  stdout: string,
  code: unknown,
  context?: string,
  whenSilent?: string,
): string {
  const parts = [stdout, stderr].filter(s => s && s.trim().length > 0)
  if (parts.length === 0) {
    if (whenSilent !== undefined) return whenSilent
    const where = context ? ` [${context}]` : ''
    // Kept under 300 characters on purpose: the circuit breaker quotes the
    // original error back through `.slice(0, 300)`, and this text matters most
    // in exactly the case that trips the breaker.
    return `Command exited with code ${code}, no output on either stream${where}. `
      + `Nothing printed at all usually means the shell or environment failed to run it, `
      + `not that the command was wrong. Rewording will not help; if a trivial `
      + `command fails the same way, the shell is at fault.`
  }
  return parts.join('\n')
}

/** The ceiling on any Bash budget, however it arrives. */
export const MAX_BASH_TIMEOUT_MS = 600_000

/**
 * The budget a command gets when the model does not ask for one.
 *
 * Two minutes is right for a shell session and wrong for a mission: the Stage
 * 11I run lost five `python -m pytest gilded/tests` calls to it, because that
 * suite takes 135 seconds, and "bring the suite back to 16 failures" was half
 * of what the run was graded on. It never once saw the number.
 *
 * CYNCO_CHECK_TIMEOUT_MS is the fallback because it is the SAME COMMAND seen
 * from the other side: `scripts/dispatch-mission.sh` already exports it so the
 * driver's copy of the held-out gate can finish, and that gate wraps the suite
 * the model is running here. An operator who raised one meant both. Leaving
 * this capped while that one is raised is the Wave 9d finding
 * (`commandTimeoutMs`, contractVerify.ts:283) one layer down — the cap lifted
 * where the operator can see it and left in place where the work happens.
 *
 * A value that would mean "wait forever" — 0, negative, unparseable — is
 * ignored rather than obeyed, since `exec` drops the timeout entirely for
 * those and a hang with no deadline is the failure the cap exists to prevent.
 */
export function bashDefaultTimeoutMs(): number {
  for (const name of ['CYNCO_BASH_TIMEOUT_MS', 'CYNCO_CHECK_TIMEOUT_MS']) {
    const raw = Number(process.env[name])
    if (Number.isFinite(raw) && raw > 0) return Math.min(raw, MAX_BASH_TIMEOUT_MS)
  }
  return 120_000
}

export const bashTool: ToolImpl = {
  name: 'Bash',
  description: `Execute a shell command and return its output. The working directory persists between calls. ${getShellInfo().dialectNote}`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: {
        type: 'number',
        // A getter, not a constant, so the number the model is told matches the
        // number it gets. A schema that advertises 120000 while the floor is
        // 300000 makes the model ration a budget it has — the mirror of the
        // Stage 11C finding, where a 3-second check described as "a few
        // minutes" was run twice in 911 tool calls.
        get description() {
          return `Timeout in milliseconds (default: ${bashDefaultTimeoutMs()}, max: ${MAX_BASH_TIMEOUT_MS})`
        },
      },
    },
    required: ['command'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd) => {
    const command = input.command as string
    const timeout = Math.min((input.timeout as number) ?? bashDefaultTimeoutMs(), MAX_BASH_TIMEOUT_MS)

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
            const partial = failedOutput(stderr, stdout, (err as any).code, undefined, '(nothing)')
            resolve({
              output: `Error: command timeout after ${timeout}ms. If the command was ` +
                `making progress rather than hanging, retry it with a larger ` +
                `timeout (max ${MAX_BASH_TIMEOUT_MS}ms). Output collected before the kill:\n${partial}`,
              isError: true,
            })
            return
          }
          const rawOutput = failedOutput(stderr, stdout, (err as any).code,
            `shell=${shell}, signal=${(err as any).signal ?? 'none'}`)
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
