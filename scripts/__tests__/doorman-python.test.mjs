/**
 * The doorman's services are Python (standard library only) and their tests are pytest files beside
 * them (`scripts/doorman/test_*.py`). Nothing ran them but a person: not `npx vitest run`, not CI.
 * This runs them inside the suite, so the watcher, the doorman and the NAS watchdog are covered by
 * the same command as the engine.
 *
 * No Python 3 or no pytest on this machine: skipped, and it says so.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

function findPytest() {
  for (const exe of ['python3', 'python']) {
    const r = spawnSync(exe, ['-m', 'pytest', '--version'], { encoding: 'utf-8', windowsHide: true })
    if (r.status === 0) return exe
  }
  return null
}

const python = findPytest()
if (!python) console.warn('[doorman-python] SKIPPED: no Python 3 with pytest on PATH; run `python -m pytest scripts/doorman -q` where there is one.')

describe.skipIf(!python)('scripts/doorman (pytest)', () => {
  it('every pytest file beside the doorman passes', () => {
    const r = spawnSync(python, ['-m', 'pytest', join(process.cwd(), 'scripts', 'doorman'), '-q', '-p', 'no:cacheprovider'], { encoding: 'utf-8', windowsHide: true, timeout: 110_000 })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    expect(r.status, out.slice(-4000)).toBe(0)
    expect(out).toMatch(/\d+ passed/)
  }, 120_000)
})
