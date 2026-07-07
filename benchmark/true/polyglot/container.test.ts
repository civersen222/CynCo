// benchmark/true/polyglot/container.test.ts
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureImage, startContainer, stopContainer, execInContainer } from './container.js'

const dockerPresent = spawnSync('docker', ['version'], { encoding: 'utf-8' }).status === 0

// Live integration test — same gating style as other docker/live suites.
describe.skipIf(!dockerPresent)('container lifecycle', () => {
  it('builds image, starts, execs a test command in a mounted workdir, stops', () => {
    ensureImage(import.meta.dirname)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-ct-'))
    const work = join(scratch, 'python-demo')
    mkdirSync(work)
    writeFileSync(join(work, 'demo_test.py'), 'def test_ok():\n    assert 1 + 1 == 2\n')
    startContainer(scratch)
    try {
      const ok = execInContainer('python-demo', 'python3 -m pytest -x -q', 60_000)
      expect(ok.code).toBe(0)
      expect(ok.timedOut).toBe(false)
      const fail = execInContainer('python-demo', 'python3 -m pytest -x -q --nonexistent-flag', 60_000)
      expect(fail.code).not.toBe(0)
      expect(fail.output.length).toBeGreaterThan(0)
    } finally {
      stopContainer()
    }
  }, 900_000) // first image build can take many minutes
})
