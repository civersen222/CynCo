/**
 * The jlens sidecar (`jlens/jlens_service`) is Python and its tests are pytest files beside it
 * (`jlens/tests`). Until 2026-11-24 nothing ran them but a person: not `npx vitest run`, not CI. This runs
 * them inside the suite, the way doorman-python.test.mjs runs `scripts/doorman`.
 *
 * pytest runs from `jlens/`, so `jlens_service` and the tests' `conftest` are importable as they are when a
 * person runs `python -m pytest tests` there. The tests that need torch skip themselves without it (their
 * conftest says so); the server's own tests bind port 0 only. No bytecode and no pytest cache are written
 * into the checkout.
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
if (!python) console.warn('[jlens-python] SKIPPED: no Python 3 with pytest on PATH; run `python -m pytest tests -q` in jlens/ where there is one.')

describe.skipIf(!python)('jlens/tests (pytest)', () => {
  it('every pytest file of the jlens sidecar passes', () => {
    const r = spawnSync(python, ['-m', 'pytest', 'tests', '-q', '-p', 'no:cacheprovider', '-rs'], {
      // stdin is the null device, not whatever this worker holds: a pytest case that starts a child of its
      // own hands that child pytest's standard input unless it names one.
      cwd: join(process.cwd(), 'jlens'), encoding: 'utf-8', windowsHide: true, timeout: 170_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    expect(r.status, out.slice(-4000)).toBe(0)
    expect(out).toMatch(/\d+ passed/)
  }, 180_000)
})
