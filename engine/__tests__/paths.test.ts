import { describe, expect, it, afterEach } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cyncoHome } from '../paths.js'

/**
 * F58 — the test suite wrote into the live `~/.cynco/`.
 *
 * Fifty-odd call sites each computed `join(homedir(), '.cynco', ...)` inline,
 * so there was no seam to redirect. A vitest run left 117 session journals in
 * the directory the running engine reads from. `cyncoHome()` is that seam, and
 * these tests are what make it one.
 */
describe('cyncoHome', () => {
  const original = process.env.CYNCO_HOME
  afterEach(() => {
    if (original === undefined) delete process.env.CYNCO_HOME
    else process.env.CYNCO_HOME = original
  })

  it('defaults to ~/.cynco when CYNCO_HOME is unset', () => {
    delete process.env.CYNCO_HOME
    expect(cyncoHome()).toBe(join(homedir(), '.cynco'))
  })

  it('returns CYNCO_HOME when it is set', () => {
    process.env.CYNCO_HOME = join('C:', 'tmp', 'cynco-test-home')
    expect(cyncoHome()).toBe(join('C:', 'tmp', 'cynco-test-home'))
  })

  it('reads the environment on every call, not once at module load', () => {
    // The whole point of the seam is that a setup file can set CYNCO_HOME
    // before tests run. If the value were captured at import time, module load
    // order would decide whether the redirect took — the redirect would work or
    // not depending on which file imported first, which is not a guarantee.
    delete process.env.CYNCO_HOME
    const before = cyncoHome()
    process.env.CYNCO_HOME = join('C:', 'tmp', 'cynco-second')
    const after = cyncoHome()
    expect(after).not.toBe(before)
    expect(after).toBe(join('C:', 'tmp', 'cynco-second'))
  })

  it('is redirected away from the real ~/.cynco while the suite runs', () => {
    // The guard on F58 itself. `engine/__tests__/setup/cyncoHome.ts` is what
    // makes this true; if that setup file is dropped from vitest.config.ts, or
    // a future consumer computes ~/.cynco without going through the seam, the
    // suite silently resumes writing into the directory the live engine reads.
    // Asserted here, in the suite, so the regression cannot be quiet.
    //
    // Note this reads the ambient environment deliberately — the afterEach
    // above restores whatever the setup file set, so this sees the real thing.
    expect(process.env.CYNCO_HOME).toBeTruthy()
    expect(cyncoHome()).not.toBe(join(homedir(), '.cynco'))
  })

  it('treats an empty CYNCO_HOME as unset rather than as the relative path ""', () => {
    // `process.env.CYNCO_HOME ?? default` would return '' here, and every
    // consumer joins onto it — so `sessions/` would be created relative to the
    // process cwd, silently, in whatever repo the engine happened to be run
    // from. An empty env var is a common accident (`CYNCO_HOME=$UNSET_VAR`).
    process.env.CYNCO_HOME = ''
    expect(cyncoHome()).toBe(join(homedir(), '.cynco'))
  })
})
