// A grader's containment for tests that run a REAL gate through `runSync` (F242).
//
// Every grader and calibration run now starts inside a containment of its own
// (`contained: { own }` in scripts/cynco-spawn.mjs). In the suite that containment
// cannot be made: the suite's sandbox root does not exist, and on Windows vitest's
// Node has no launcher. A test that runs a real gate mocks the two life-cycle calls
// with this module, so its gate runs under a TEST context over folders of its own:
// the child gets the sandbox overlay (home, temp, scratch) and, on Windows, the
// test switch `lowil` (honoured only for a test context) stands in for the launcher.
//
//   vi.mock('../../engine/containment.js', async (importOriginal) =>
//     (await import('./fixtures/graderContainment.mjs')).graderContainmentModule(await importOriginal()))
//   beforeAll(() => graderContainment.start()); afterAll(() => graderContainment.stop())
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = { roots: [], calls: [], switchBefore: undefined, started: false }

export const graderContainment = {
  /** What each establish was asked, in order. */
  calls: state.calls,
  start() {
    state.started = true
    state.switchBefore = process.env.LOCALCODE_CONTAINMENT_OFF
    if (process.platform === 'win32') process.env.LOCALCODE_CONTAINMENT_OFF = 'lowil'
  },
  stop() {
    if (state.switchBefore === undefined) delete process.env.LOCALCODE_CONTAINMENT_OFF
    else process.env.LOCALCODE_CONTAINMENT_OFF = state.switchBefore
    for (const r of state.roots.splice(0)) rmSync(r, { recursive: true, force: true })
    state.started = false
  },
}

/** The real module with `establishContainment` and `releaseContainment` replaced. */
export function graderContainmentModule(actual) {
  return {
    ...actual,
    establishContainment(a) {
      state.calls.push(a)
      if (!state.started) return { ok: false, reason: 'graderContainment.start() was not called' }
      const root = mkdtempSync(join(tmpdir(), 'cynco-grader-test-'))
      state.roots.push(root)
      const sandbox = { root, home: join(root, 'home'), tmp: join(root, 'tmp'), scratch: join(root, 'scratch') }
      for (const d of [sandbox.home, sandbox.tmp, sandbox.scratch]) mkdirSync(d)
      const containment = actual.testContainment({
        kind: a.kind, missionCwd: a.missionCwd, extraRoots: a.extraRoots ?? [], sandbox, home: tmpdir(),
        folders: { state: root, models: root, guard: root, audit: null },
      })
      return { ok: true, containment, ms: 0 }
    },
    releaseContainment() {
      return { relabelled: true, note: '' }
    },
  }
}
