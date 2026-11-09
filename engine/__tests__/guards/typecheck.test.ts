import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * BLOCKING: the engine type-checks clean under the root tsconfig.json.
 *
 * Bun strips types at run time and vitest transforms through esbuild, so
 * until 2026-11-06 nothing ever ran `tsc` over the engine (GLM review finding
 * A1, docs/reviews/2026-11-06-glm5-engineering-review-triage.md). The first
 * strict run found 59 errors and, behind them, eight live defects: an S5 rule
 * that could never fire (W2 read a string, governance wrote a number), a
 * tool-routing branch that could never be reached, a shutdown frame the
 * bridge refused, kill-switch telemetry that always said inactive. A guard
 * test rather than a separate CI step so it runs under `npm test` and
 * `npm run audit:wiring` like every other wire-check.
 *
 * Scope is production code (tsconfig.json `exclude`); the test suite is a
 * second, larger surface to widen to once this one has stayed at zero.
 */
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

describe('typecheck guard', () => {
  it('tsc -p tsconfig.json reports no errors', () => {
    const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
    expect(existsSync(tsc), 'typescript is a devDependency; run npm install').toBe(true)
    const r = spawnSync(process.execPath, [tsc, '-p', join(repoRoot, 'tsconfig.json'), '--pretty', 'false'], {
      cwd: repoRoot, encoding: 'utf-8', timeout: 180_000,
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    expect(r.error, 'tsc did not run').toBeUndefined()
    expect(r.status, `tsc exit ${r.status}; run \`npm run typecheck\`:\n${out.split('\n').slice(0, 40).join('\n')}`).toBe(0)
  }, 200_000)
})
