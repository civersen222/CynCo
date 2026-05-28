import { execSync } from 'child_process'
import type { CandidateResult, TestInfo } from './types.js'

export function selectWinner(candidates: CandidateResult[]): CandidateResult | null {
  const valid = candidates.filter((c) => c.patch.trim().length > 0)
  if (valid.length === 0) return null

  valid.sort((a, b) => {
    if (b.passRate !== a.passRate) return b.passRate - a.passRate
    return a.totalTurns - b.totalTurns
  })

  return valid[0]
}

export function parseTestOutput(
  output: string,
  framework: string
): { passed: number; total: number } {
  switch (framework) {
    case 'pytest': {
      const passedMatch = output.match(/(\d+) passed/)
      const failedMatch = output.match(/(\d+) failed/)
      const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0
      const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0
      return { passed, total: passed + failed }
    }
    case 'jest': {
      const passedMatch = output.match(/(\d+) passed/)
      const totalMatch = output.match(/(\d+) total/)
      const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0
      const total = totalMatch ? parseInt(totalMatch[1], 10) : passed
      return { passed, total }
    }
    case 'bun': {
      const passMatch = output.match(/(\d+) pass/)
      const failMatch = output.match(/(\d+) fail/)
      const passed = passMatch ? parseInt(passMatch[1], 10) : 0
      const failed = failMatch ? parseInt(failMatch[1], 10) : 0
      return { passed, total: passed + failed }
    }
    case 'cargo': {
      const passedMatch = output.match(/(\d+) passed/)
      const failedMatch = output.match(/(\d+) failed/)
      const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0
      const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0
      return { passed, total: passed + failed }
    }
    case 'go': {
      const lines = output.split('\n')
      const passed = lines.filter((l) => /^ok\s/.test(l)).length
      const failed = lines.filter((l) => /^FAIL\s/.test(l)).length
      return { passed, total: passed + failed }
    }
    default:
      return { passed: 0, total: 0 }
  }
}

export function runTests(
  cwd: string,
  testInfo: TestInfo
): { passed: number; total: number; output: string } {
  let output = ''
  try {
    const result = execSync(testInfo.command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    output = result.toString()
  } catch (err: unknown) {
    // Non-zero exit (tests failed) — parse anyway
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = e.stdout ? e.stdout.toString() : ''
    const stderr = e.stderr ? e.stderr.toString() : ''
    output = stdout + stderr
  }
  const { passed, total } = parseTestOutput(output, testInfo.framework)
  return { passed, total, output }
}

export function applyPatch(repoRoot: string, patch: string): boolean {
  if (!patch.trim()) return false

  const input = Buffer.from(patch)

  try {
    execSync('git apply --check -', {
      cwd: repoRoot,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    return false
  }

  try {
    execSync('git apply -', {
      cwd: repoRoot,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}
