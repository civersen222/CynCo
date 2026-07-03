import { spawnSync } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface ScoreResult {
  score: number
  passed: boolean
  passedCount: number
  total: number
  output: string
}

/**
 * Parse pytest's terminal summary line into a continuous score. pytest prints a
 * line like `3 passed, 2 failed in 0.10s`; we extract the passed/failed/error
 * counts and return the passing fraction. Errors count toward the total (a test
 * that errored did not pass). Malformed/empty output yields a 0/0 -> score 0.
 */
export function parsePytestScore(output: string): { score: number; passedCount: number; total: number } {
  const num = (re: RegExp): number => {
    const m = output.match(re)
    return m ? parseInt(m[1], 10) : 0
  }
  const passedCount = num(/(\d+) passed/)
  const failed = num(/(\d+) failed/)
  const errors = num(/(\d+) errors?/)
  const total = passedCount + failed + errors
  const score = total > 0 ? passedCount / total : 0
  return { score, passedCount, total }
}

/**
 * Copy the hidden test into `workdir`, run pytest on just that file headlessly,
 * remove it, and report pass (exit 0) / fail. The hidden test never exists in the
 * workdir while the agent is running.
 */
export function scorePytest(
  workdir: string,
  hiddenTestPath: string,
  hiddenTestName: string,
  scorerTimeoutMs = 120_000,
  pythonBin = 'python',
): ScoreResult {
  const dest = join(workdir, hiddenTestName)
  copyFileSync(hiddenTestPath, dest)
  try {
    const res = spawnSync(pythonBin, ['-m', 'pytest', hiddenTestName, '-q'], {
      cwd: workdir,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy' },
      encoding: 'utf-8',
      timeout: scorerTimeoutMs,
    })
    if (res.error) {
      // A pytest run that blows the timeout means the agent's code hangs (infinite
      // loop / blocking call). That's an AGENT failure: score it 0 and let the
      // suite continue — one hung agent must not abort a multi-task run. Genuine
      // spawn errors (e.g. python not on PATH) are infra failures and still
      // surface loudly rather than being silently scored as a miss.
      if ((res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        return {
          score: 0,
          passed: false,
          passedCount: 0,
          total: 0,
          output: `pytest exceeded ${scorerTimeoutMs}ms — agent code hung: ${res.error.message}`,
        }
      }
      throw res.error
    }
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
    const { score, passedCount, total } = parsePytestScore(output)
    // `passed` stays a strict binary flag (everything passed) for the
    // green/reference gate; `score` carries the continuous fraction.
    return { score, passed: score === 1 && total > 0, passedCount, total, output }
  } finally {
    rmSync(dest, { force: true })
  }
}
