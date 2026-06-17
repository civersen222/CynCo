import { spawnSync } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface ScoreResult {
  passed: boolean
  output: string
}

/**
 * Copy the hidden test into `workdir`, run pytest on just that file headlessly,
 * remove it, and report pass (exit 0) / fail. The hidden test never exists in the
 * workdir while the agent is running.
 */
export function scorePytest(workdir: string, hiddenTestPath: string, hiddenTestName: string): ScoreResult {
  const dest = join(workdir, hiddenTestName)
  copyFileSync(hiddenTestPath, dest)
  try {
    const res = spawnSync('python', ['-m', 'pytest', hiddenTestName, '-q'], {
      cwd: workdir,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy' },
      encoding: 'utf-8',
      timeout: 120_000,
    })
    // A spawn-level error (e.g. python not on PATH) is an infra failure, not an
    // agent failure — surface it loudly rather than silently scoring it as a miss.
    if (res.error) throw res.error
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
    return { passed: res.status === 0, output }
  } finally {
    rmSync(dest, { force: true })
  }
}
