import { ContainmentRefusal, toolExec, toolSpawnRefusal, containmentHint } from '../../containment.js'
import type { ToolImpl } from '../types.js'
import { overranBuffer, ownProcessTree } from '../../processTree.js'
import { checkBashSafety } from '../bashSafety.js'
import { bashJudgedAlready, checkProtectedPaths } from '../protectedPaths.js'
import { endsInNativeProgram, nativeTailStart } from '../shellPaths.js'
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
/** How long a killed command's pipes get to close before the call returns without them. */
const STOP_GRACE_MS = 2000

/**
 * Appended on a line of its own (so a comment at the end of the command cannot swallow it) to a PowerShell
 * command whose last element is a native program. A success stays 0. A failure is the program's own code
 * when it set one; otherwise 1, as before: a bare `; exit $LASTEXITCODE` answered 0 for a program that does
 * not exist (measured 2026-11-24). A program that exits 0 while `$?` is false (Windows PowerShell 5.1 with its
 * stderr redirected) reads 1, as before.
 */
export const NATIVE_EXIT_SUFFIX = '\nif ($?) { exit 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }'

/**
 * Put in front of the command's last statement when it stands after a `;` or a line break (`nativeTailStart`), so
 * a last program that cannot start reads 1, never a code an earlier program of the same command left (wave 15b;
 * until then `cmd /c exit 3; no-such-program` read 3). Where the start cannot be placed, that limit remains.
 */
export const NATIVE_EXIT_RESET = '$global:LASTEXITCODE = 0; '

/**
 * The longest text the tool hands a Windows shell on one command line. Measured 2026-11-25 with the real tool
 * (phase3\w19\scratch\c\out\longcmd-before.out): a 32,041-character command ran whole, and from 32,741 characters on
 * the spawn threw `ENAMETOOLONG` (the call threw instead of answering). The launcher of a contained run gets a long
 * command by file but starts the shell with it on one command line too.
 */
export const MAX_WINDOWS_COMMAND_CHARS = 32_000

/**
 * The longest command that may start one of Git's POSIX shells. Measured 2026-11-25 (longcmd2/3-before.out): Git's
 * `bin\bash.exe`, `usr\bin\bash.exe` and `usr\bin\sh.exe` ran a `-c` text of 8,150 characters whole and one of 8,200
 * with its end cut off, exiting 0 with no error (a one-line `echo START; : ...; echo END` printed START alone); the
 * same text run from a file ran whole, and an msys program that is not a shell got an argument of 16,001 whole.
 */
export const MAX_POSIX_SHELL_COMMAND_CHARS = 8_000

/** A POSIX shell named as a program word: `bash`, `sh` (with `.exe`, a path, quoted), never `.sh`, `ssh`, `--shell`. */
const POSIX_SHELL_WORD = /(?:^|[\s;|&(){}'"`\\/=])(?:bash|sh|zsh|dash|ksh)(?:\.exe)?(?=$|[\s'";|&)])/i

/**
 * Why a command must not be started because Windows would cut it or cannot carry it, or null (wave 19). `runnable`
 * is what reaches the shell (the preamble and the exit-code lines included). Nothing is refused off Windows.
 */
export function longCommandRefusal(command: string, runnable: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null
  if (runnable.length > MAX_WINDOWS_COMMAND_CHARS) {
    return `Error: the command is ${command.length} characters long, longer than one Windows command line carries ` +
      `(about ${MAX_WINDOWS_COMMAND_CHARS.toLocaleString('en-US')} characters with the shell's own words), so nothing was started. ` +
      'Write long content to a file with the Write tool, and run a long program from a file.'
  }
  if (command.length > MAX_POSIX_SHELL_COMMAND_CHARS && POSIX_SHELL_WORD.test(command)) {
    return `Error: this command starts a POSIX shell (bash or sh) and is ${command.length} characters long. Git's bash and sh run only ` +
      `the first 8,190 or so characters of a -c text and exit 0 without an error, so nothing was started. ` +
      'Write the script to a file with the Write tool and run it as bash <file>.'
  }
  return null
}

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

/** The ceiling on any Bash budget when no operator has raised it. */
export const MAX_BASH_TIMEOUT_MS = 600_000

/** Nothing an operator sets can make one command wait longer than this. */
export const HARD_MAX_BASH_TIMEOUT_MS = 3_600_000

/**
 * The ceiling that applies right now.
 *
 * F142: the civkings suite takes 22 minutes. The wave-13 dispatch exported
 * CYNCO_BASH_TIMEOUT_MS=1500000, the launch banner printed it, the brief
 * promised the model 1500s -- and every call was still clamped to 600000 here,
 * because the env var could only move the DEFAULT under a fixed ceiling. The
 * operator who raises the variable above the ceiling meant the ceiling. An hour
 * stays the hard stop: a hang with no deadline is the failure the cap exists
 * to prevent, and no single command in this project should run that long.
 */
export function bashMaxTimeoutMs(): number {
  for (const name of ['CYNCO_BASH_TIMEOUT_MS', 'CYNCO_CHECK_TIMEOUT_MS']) {
    const raw = Number(process.env[name])
    if (Number.isFinite(raw) && raw > 0) {
      return Math.min(Math.max(raw, MAX_BASH_TIMEOUT_MS), HARD_MAX_BASH_TIMEOUT_MS)
    }
  }
  return MAX_BASH_TIMEOUT_MS
}

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
    if (Number.isFinite(raw) && raw > 0) return Math.min(raw, bashMaxTimeoutMs())
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
          return `Timeout in milliseconds (default: ${bashDefaultTimeoutMs()}, max: ${bashMaxTimeoutMs()})`
        },
      },
    },
    required: ['command'],
  },
  tier: 'approval',
  core: true,
  execute: async (input, cwd, signal) => {
    const command = input.command as string
    // A call that reaches here after the Stop (a batch still unwinding) is not started.
    if (signal?.aborted) {
      return { output: 'Error: command stopped before it started — the turn was stopped.', isError: true }
    }
    const timeout = Math.min((input.timeout as number) ?? bashDefaultTimeoutMs(), bashMaxTimeoutMs())

    const safety = checkBashSafety(command)
    if (!safety.safe) {
      return { output: `Blocked: ${safety.reason}`, isError: true }
    }

    // F242, layer 2: asked here as well as in ToolExecutor.execute, so a refused command is never run
    // whoever called the tool. Judged on the model's own text, before any translation.
    // The executor's own reading of this very input is not repeated (`bashJudgedAlready`).
    const guard = bashJudgedAlready(input, cwd) ? null : checkProtectedPaths('Bash', input, cwd)
    if (guard?.kind === 'refuse') return { output: guard.text, isError: true }

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
    // The translation turned an inert single-quoted value into code (`X='$(...)' cmd` became
    // `$env:X="$(...)"; cmd`) until 2026-11-24, when it began keeping a single-quoted value a literal
    // (`shellInfo.ts`, `psValue`). A translated command is still judged as the shell will run it, whatever the
    // executor already said about the model's text (review 2026-11-23, fourth).
    if (dialected !== command) {
      const again = checkProtectedPaths('Bash', { command: dialected }, cwd)
      if (again.kind === 'refuse') return { output: again.text, isError: true }
    }
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
    // N130: under `powershell -Command` a native program's failing code reached the model as 1 (pytest's 5,
    // git's 128 and `cmd /c exit 3` alike, measured 2026-11-24). When the command ends in a native program
    // (`endsInNativeProgram`, the scan's reading), its own code is carried; a cmdlet last is left as it was.
    // `$LASTEXITCODE` is set to 0 where the last statement starts (`nativeTailStart`), so a last program that cannot
    // start reads 1, not a code an earlier program of the command left (wave 15b).
    const native = shellInfo.isPowerShell && endsInNativeProgram(merged.command)
    const tailAt = native ? nativeTailStart(merged.command) : null
    const body = tailAt === null ? merged.command
      : merged.command.slice(0, tailAt) + NATIVE_EXIT_RESET + merged.command.slice(tailAt)
    const runnable = shellPreamble(shellInfo) + body + (native ? NATIVE_EXIT_SUFFIX : '')

    // Wave 19: a command Windows cannot carry on one command line threw here, and one that starts Git's bash or sh
    // with more than about 8,190 characters ran cut short, exit 0. Neither is started; nothing ran, so no exit code.
    const tooLong = longCommandRefusal(dialected, runnable)
    if (tooLong) return { output: tooLong, isError: true }

    const refusal = toolSpawnRefusal()
    if (refusal) return { output: refusal, isError: true }

    return new Promise((resolve) => {
      // Stop (F201) and the timeout (F210). The loop used to give up on a
      // stopped turn and leave the command running to its own end, and the
      // timeout was exec's own, which ends the shell and nothing the shell
      // started. Both now kill the tree the command owns (`ownProcessTree`,
      // taken the moment the shell exists); exec's callback then reports what
      // was collected.
      const startedAt = Date.now()
      let ended: 'stopped' | 'timeout' | null = null
      let answered = false
      let grace: ReturnType<typeof setTimeout> | undefined
      const stoppedResult = (partial: string) => ({
        output: `Error: command stopped after ${Date.now() - startedAt}ms — the turn was stopped, and the ` +
          `command and the processes it started were killed. Output collected before the kill:\n${partial}`,
        isError: true,
        exitCode: null,
      })
      // A bare "timeout after 60000ms" leaves the model unable to tell
      // "my command hangs" from "my budget was too small" — opposite
      // fixes. Measured on the Wave 4 run: it asked for 60s against a
      // ~52s suite, lost the race twice, and got back neither the partial
      // pytest report nor the fact that it may ask for up to 600000ms.
      const timeoutResult = (partial: string) => ({
        output: `Error: command timeout after ${timeout}ms. If the command was ` +
          `making progress rather than hanging, retry it with a larger ` +
          `timeout (max ${MAX_BASH_TIMEOUT_MS}ms). Output collected before the kill:\n${partial}${containmentHint('timeout', partial)}`,
        isError: true,
        exitCode: null,
      })
      const killFor = (why: 'stopped' | 'timeout') => {
        if (ended || answered) return
        ended = why
        void tree.kill().then(() => {
          if (answered) return
          child.kill()
          // exec answers when the pipes close. A survivor holding one must not hold the turn.
          grace = setTimeout(() => resolve(why === 'stopped' ? stoppedResult('(nothing)') : timeoutResult('(nothing)')), STOP_GRACE_MS)
        })
      }
      const onAbort = () => killFor('stopped')
      // A spawn that fails before any process exists throws here (`ENAMETOOLONG` past the limit above, measured):
      // it is an answer, never a throw out of the tool. Nothing ran, so there is no exit code.
      let child: ReturnType<typeof toolExec>
      try {
        child = toolExec(runnable, {
        cwd,
        encoding: 'utf-8',
        // No `timeout` here: exec's kills the shell alone. `deadline` below is the timeout.
        // UTF-8 forced for Python, harness-only keys dropped, sandbox overlay in a contained run: see toolEnv (engine/containment.ts).
        maxBuffer: 2 * 1024 * 1024, // 2MB
        shell,
      }, (err, stdout, stderr) => {
        signal?.removeEventListener('abort', onAbort)
        clearTimeout(deadline)
        answered = true
        if (grace) clearTimeout(grace)
        // A command that ended on its own gives its handle back; one that was killed has none left. On an output
        // overrun exec has ended the shell alone (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, `killed` unset: measured),
        // so what the shell started is ended with it (wave 19, from the harness-children builder). Only a Job Object
        // can: a walked tree is found from its root, which exec has already ended and reaped, so the walk finds nothing
        // and its signal could reach a pid that was reused meanwhile; that tree is released (C19-8, wave 19b).
        if (overranBuffer(err) && tree.kind === 'job') void tree.kill()
        else tree.release()
        // Before the plain-failure branch: a killed child reports an error
        // too. A command that finished cleanly as the kill landed keeps its
        // real result.
        if (ended && err) {
          const partial = failedOutput(stderr, stdout, (err as any).code, undefined, '(nothing)')
          resolve(ended === 'stopped' ? stoppedResult(partial) : timeoutResult(partial))
          return
        }
        if (err) {
          // A launcher fault (engine/containment.ts). Only the launcher's own sealed 197 means the
          // shell never started; that one carries no exit code, so it is read as a refusal made
          // before a process ran. Its sealed 198, and Bun's EPERM line under a shell that ran, came
          // from a command that did run: they carry the status, so the command cannot end its own
          // run as a harness fault (review of slice S5).
          const fault: unknown = err
          if (fault instanceof ContainmentRefusal) {
            if (!fault.ran) { resolve({ output: fault.message, isError: true }); return }
            if (fault.code === 'ECHILDGONE') { resolve({ output: fault.message, isError: true, exitCode: null }); return }
            const base = failedOutput(stderr, stdout, fault.exitCode ?? 1, `shell=${shell}`)
            resolve({ output: formatBashFailure(command, base + containmentHint('failure', base)), isError: true, exitCode: fault.exitCode })
            return
          }
          const base = failedOutput(stderr, stdout, (err as any).code,
            `shell=${shell}, signal=${(err as any).signal ?? 'none'}`)
          const rawOutput = base + containmentHint('failure', base)
          resolve({
            output: formatBashFailure(command, rawOutput), isError: true,
            // The shell's status; a string code (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) is no status.
            exitCode: typeof (err as any).code === 'number' ? (err as any).code : null,
          })
          return
        }
        // F60. Only when a merge was stripped, so the model gets exactly what it
        // asked for and no other run gains SDL/pygame stderr noise it did not.
        // A silent success says `(no output)`, as it does without the merge: it
        // is passed as `whenSilent`, because failedOutput's own silent text says
        // the shell failed (F66), and a `.replace` of the bare line it returned
        // before F66 let that text through on every quiet `git add -A 2>&1`.
        const succeeded = merged.stripped
          ? failedOutput(stderr, stdout, 0, undefined, '(no output)')
          : (stdout || stderr || '(no output)')
        // Hint on success only. A failing command already has the model's full
        // attention on its own error; adding tool advice there buries the reason
        // it failed under advice it did not ask for.
        resolve({ output: withToolHint(command, succeeded) + containmentHint('success', String(stderr ?? '')), isError: false, exitCode: 0 })
      })
      } catch (e) {
        // The containment's own refusal before anything started (`refuseBeforeSpawn`): its own text, so the executor
        // raises it as the fault it is, as in the callback above (C19-4).
        if (e instanceof ContainmentRefusal) { resolve({ output: e.message, isError: true }); return }
        const code = (e as NodeJS.ErrnoException)?.code
        resolve({
          output: code === 'ENAMETOOLONG' || code === 'E2BIG'
            ? `Error: the command is ${command.length} characters long, longer than one command line carries (${code}), so nothing was started. ` +
              'Write long content to a file with the Write tool, and run a long program from a file.'
            : `Error: the shell could not be started (${(e as Error)?.message ?? String(e)}), so nothing was run.`,
          isError: true,
        })
        return
      }
      const tree = ownProcessTree(child.pid)
      const deadline = setTimeout(() => killFor('timeout'), timeout)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  },
}

/** The environment a tool child runs with is built in one place: `toolEnv` (engine/containment.ts). */
export { toolEnv as bashToolEnv } from '../../containment.js'
