import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

/**
 * A malformed --run-task file must be rejected BEFORE the model is loaded.
 *
 * Measured 2026-07-30: a task file missing `triggerId` was accepted by
 * `bun engine/main.ts --run-task`, which then ran bootstrapProvider(), started
 * llama-server, loaded a 27B model into VRAM, printed "[localcode] Context
 * budget: 65536 tokens", and only then reached runOneShotTask() — where
 * readTaskFile() threw "Task file missing required field: triggerId". The whole
 * cost of a model load was paid to discover a typo in a JSON file.
 *
 * This test does not assert on wall-clock time, which would be flaky. It
 * asserts on the ORDER, which is the actual property: the rejection message is
 * present and the bootstrap's own log line is not. If the preflight is ever
 * moved back below bootstrapProvider(), "Context budget" reappears and this
 * goes red.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'

describe('one-shot task-file preflight', () => {
  it('rejects a task file missing a required field without loading a model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-preflight-'))
    try {
      const p = join(dir, 'task.json')
      // Every required field except triggerId.
      writeFileSync(p, JSON.stringify({
        missionId: 'm', prompt: 'p', context: 'c',
        allowedTools: [], timeoutMs: 1000, outcomePath: join(dir, 'out.json'),
      }), 'utf-8')

      const r = spawnSync(BUN, ['engine/main.ts', '--run-task', p], {
        cwd: REPO, encoding: 'utf-8', timeout: 60000,
        env: { ...process.env, LOCALCODE_TRAJECTORY_ENABLED: 'false' },
      })
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`

      expect(r.status).toBe(1)
      expect(out).toContain('Task file missing required field: triggerId')
      // bootstrapProvider() prints this immediately after the model is up.
      expect(out).not.toContain('Context budget')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 70000)
})
