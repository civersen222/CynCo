// benchmark/true/polyglot/orchestrate.test.ts
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExercise, type RunExerciseDeps } from './orchestrate.js'
import { discoverExercises } from './exercise.js'
import type { ExecResult } from './container.js'
import type { Exercise } from './types.js'

function makeFakeExercise(): Exercise {
  const root = mkdtempSync(join(tmpdir(), 'polyglot-orch-'))
  const ex = join(root, 'python', 'exercises', 'practice', 'demo')
  mkdirSync(join(ex, '.meta'), { recursive: true })
  mkdirSync(join(ex, '.docs'), { recursive: true })
  writeFileSync(
    join(ex, '.meta', 'config.json'),
    JSON.stringify({ files: { solution: ['demo.py'], test: ['demo_test.py'], example: ['.meta/example.py'] } }),
  )
  writeFileSync(join(ex, '.docs', 'instructions.md'), 'Implement demo.\n')
  writeFileSync(join(ex, 'demo.py'), 'def demo():\n    pass\n')
  writeFileSync(join(ex, 'demo_test.py'), 'def test_demo():\n    assert True\n')
  return discoverExercises(root)[0]
}

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0, output: 'all green', timedOut: false, durationMs: 50, ...over,
})
const failed = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 1, output: 'FAILED test_demo - assert False', timedOut: false, durationMs: 60, ...over,
})

interface Calls {
  prompts: string[]
  execWorkdirs: string[]
  testFilePresentAtExec: boolean[]
  pristineChecks: number
  workdir?: string
}

function makeDeps(execResults: ExecResult[], calls: Calls, tryResults: Array<{ timedOut: boolean; error?: string }> = []): RunExerciseDeps {
  let execIdx = 0
  let tryIdx = 0
  return {
    makeSession: (workdir) => {
      calls.workdir = workdir
      return {
        sendTry: async (prompt) => {
          calls.prompts.push(prompt)
          return tryResults[tryIdx++] ?? { timedOut: false }
        },
      }
    },
    exec: (workdirName) => {
      calls.execWorkdirs.push(workdirName)
      // anti-cheat window: the pristine test file must exist exactly now
      calls.testFilePresentAtExec.push(existsSync(join(calls.workdir!, 'demo_test.py')))
      return execResults[execIdx++]
    },
    assertSourcePristine: () => { calls.pristineChecks++ },
    scratchRoot: mkdtempSync(join(tmpdir(), 'polyglot-orch-scratch-')),
    log: () => {},
    tryTimeoutMs: 1000,
    testTimeoutMs: 1000,
  }
}

const newCalls = (): Calls => ({ prompts: [], execWorkdirs: [], testFilePresentAtExec: [], pristineChecks: 0 })

describe('runExercise', () => {
  it('pass on try 1: one prompt, one verdict, record shape', async () => {
    const ex = makeFakeExercise()
    const calls = newCalls()
    const rec = await runExercise(ex, makeDeps([ok()], calls))
    expect(rec).toMatchObject({ language: 'python', exercise: 'demo', passed: true, passedTry: 1 })
    expect(rec.tryDurationsMs).toHaveLength(1)
    expect(rec.testDurationMs).toBe(50)
    expect(rec.error).toBeUndefined()
    expect(rec.envFailure).toBeUndefined()
    expect(calls.prompts).toHaveLength(1)
    expect(calls.prompts[0]).toContain('Implement demo.')
    expect(calls.execWorkdirs).toEqual(['python-demo'])
  })

  it('tests exist in the workdir ONLY during the verdict (anti-cheat window)', async () => {
    const ex = makeFakeExercise()
    const calls = newCalls()
    await runExercise(ex, makeDeps([failed(), ok()], calls))
    expect(calls.testFilePresentAtExec).toEqual([true, true]) // injected at exec time
    // workdir is deleted at finish; before that removeTests ran — verified by
    // the exercise.test.ts round-trip; here we assert the workdir is gone.
    expect(existsSync(calls.workdir!)).toBe(false)
  })

  it('fail try 1 → retry with test output into the SAME session → pass try 2', async () => {
    const ex = makeFakeExercise()
    const calls = newCalls()
    const rec = await runExercise(ex, makeDeps([failed(), ok()], calls))
    expect(rec.passed).toBe(true)
    expect(rec.passedTry).toBe(2)
    expect(rec.tryDurationsMs).toHaveLength(2)
    expect(rec.testDurationMs).toBe(110)
    expect(calls.prompts).toHaveLength(2)
    expect(calls.prompts[1]).toContain('FAILED test_demo')
    expect(calls.prompts[1]).toContain("The tests are correct, don't try and change them.")
  })

  it('fail both tries → passed false, passedTry null', async () => {
    const ex = makeFakeExercise()
    const rec = await runExercise(ex, makeDeps([failed(), failed()], newCalls()))
    expect(rec.passed).toBe(false)
    expect(rec.passedTry).toBeNull()
  })

  it('flags envFailure from the taxonomy but still records the failure', async () => {
    const ex = makeFakeExercise()
    const rec = await runExercise(ex, makeDeps([failed({ code: 125 }), failed({ code: -1, output: '' })], newCalls()))
    expect(rec.passed).toBe(false)
    expect(rec.envFailure).toBe(true)
  })

  it('container death is fatal, not a recorded failure', async () => {
    const ex = makeFakeExercise()
    await expect(
      runExercise(ex, makeDeps([failed({ output: 'Error: No such container: polyglot-bench-run' })], newCalls())),
    ).rejects.toThrow(/container died/)
  })

  it('a timed-out try records the error but still gets its verdict', async () => {
    const ex = makeFakeExercise()
    const calls = newCalls()
    const rec = await runExercise(ex, makeDeps([ok()], calls, [{ timedOut: true, error: 'try timeout' }]))
    expect(rec.passed).toBe(true) // partial edits tested, same as aborted aider attempt
    expect(rec.error).toBe('try timeout')
    expect(calls.execWorkdirs).toHaveLength(1)
  })

  it('joins errors from both tries', async () => {
    const ex = makeFakeExercise()
    const rec = await runExercise(
      ex,
      makeDeps([failed(), failed()], newCalls(), [{ timedOut: false, error: 'boom1' }, { timedOut: false, error: 'boom2' }]),
    )
    expect(rec.error).toBe('boom1 | boom2')
  })

  it('re-asserts source pristineness before every verdict', async () => {
    const ex = makeFakeExercise()
    const calls = newCalls()
    await runExercise(ex, makeDeps([failed(), failed()], calls))
    expect(calls.pristineChecks).toBe(2)
  })
})
