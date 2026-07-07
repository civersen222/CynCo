// benchmark/true/polyglot/orchestrate.ts
// The pass@2 protocol for one exercise: stage → try 1 → verdict → (retry into
// the SAME session → verdict) → record. All impure boundaries (model session,
// docker exec, source pristine check) are injected so this sequencing is unit
// tested; run.ts supplies the real implementations.
import { rmSync } from 'node:fs'
import { LANGUAGES, type Exercise, type ExerciseRecord } from './types.js'
import { buildPrompt, buildRetryPrompt, injectTests, removeTests, stageWorkdir } from './exercise.js'
import { isEnvFailure, type ExecResult } from './container.js'
import type { TryResult } from './runLoop.js'

export interface RunExerciseDeps {
  /** Fresh model session for this exercise (both tries share it — aider pass@2). */
  makeSession: (workdir: string) => { sendTry(prompt: string, timeoutMs: number): Promise<TryResult> }
  /** Run a test command inside the container at /bench/<workdirName>. */
  exec: (workdirName: string, command: string, timeoutMs: number) => ExecResult
  /** Verify the exercises source repo is untouched — called before EVERY verdict. */
  assertSourcePristine: () => void
  scratchRoot: string
  log: (m: string) => void
  tryTimeoutMs: number
  testTimeoutMs: number
}

export async function runExercise(ex: Exercise, deps: RunExerciseDeps): Promise<ExerciseRecord> {
  const start = Date.now()
  const workdirName = `${ex.language}-${ex.name}`
  const workdir = stageWorkdir(ex, deps.scratchRoot)
  const session = deps.makeSession(workdir)
  const testCommand = LANGUAGES[ex.language].testCommand

  const tryDurationsMs: number[] = []
  let testDurationMs = 0
  let error: string | undefined
  let envFailure = false

  const runVerdict = (): ExecResult => {
    // The agent could have written into the exercises repo (host tools are
    // unsandboxed) — a tainted source would poison the pristine inject.
    deps.assertSourcePristine()
    injectTests(ex, workdir)
    const res = deps.exec(workdirName, testCommand, deps.testTimeoutMs)
    removeTests(ex, workdir)
    testDurationMs += res.durationMs
    // Spec: container death is fatal (fail fast, --resume continues after restart).
    if (/No such container/i.test(res.output)) {
      throw new Error('polyglot-bench container died mid-run — restart and re-run with --resume')
    }
    if (isEnvFailure(res)) envFailure = true
    return res
  }

  const finish = (passed: boolean, passedTry: 1 | 2 | null): ExerciseRecord => {
    rmSync(workdir, { recursive: true, force: true })
    return {
      language: ex.language, exercise: ex.name, passed, passedTry,
      durationMs: Date.now() - start, tryDurationsMs, testDurationMs,
      ...(error ? { error } : {}), ...(envFailure ? { envFailure: true } : {}),
    }
  }

  // Try 1: aider's exercise prompt. A timed-out try still gets its verdict —
  // partial edits are tested, same as an aborted aider attempt.
  deps.log(`[polyglot] ${ex.language}/${ex.name} try 1...`)
  const t1 = Date.now()
  const try1 = await session.sendTry(buildPrompt(ex), deps.tryTimeoutMs)
  tryDurationsMs.push(Date.now() - t1)
  if (try1.error) error = try1.error
  const test1 = runVerdict()
  if (test1.code === 0) return finish(true, 1)

  // Try 2: test output into the SAME session (aider pass@2).
  deps.log(`[polyglot] ${ex.language}/${ex.name} try 2 (tests failed)...`)
  const t2 = Date.now()
  const try2 = await session.sendTry(buildRetryPrompt(ex.solutionFiles, test1.output), deps.tryTimeoutMs)
  tryDurationsMs.push(Date.now() - t2)
  if (try2.error) error = [error, try2.error].filter(Boolean).join(' | ')
  const test2 = runVerdict()
  if (test2.code === 0) return finish(true, 2)
  return finish(false, null)
}
