/**
 * Point the test suite's CynCo state directory at a temp dir.
 *
 * F58. A full vitest run left 117 session journals in `~/.cynco/sessions` —
 * the same directory the running engine reads from to resume work. The suite
 * and the live daemon were sharing one mutable directory, so a test run was
 * writing into production state.
 *
 * This runs before every test file. It must come before any module that
 * computes a path at import time; `cyncoHome()` reads the environment on every
 * call precisely so that ordering cannot decide whether the redirect took.
 *
 * Not deleted here: a test may still hold a database in it. The home is made
 * with `tmpdir()`, which setup/suiteRunFolder.ts has pointed at the run's own
 * folder, so it goes with that folder after a run in which no test failed, and
 * stays with it, as the evidence, after one that failed. The path is printed by
 * the guard test.
 *
 * Only a home inside the temp folder is kept (the one this worker made for an
 * earlier file, or one a test made there). A CYNCO_HOME from anywhere else,
 * the launching shell's included (a scratch engine's home exported in the
 * terminal), is replaced and said on stderr: kept, the suite wrote into it,
 * F58's shape again (wave 15, found by P5).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

/**
 * The home a test file runs with. `current` is CYNCO_HOME as the file finds it, `temp` the temp folder (the
 * run's own folder under the global setup). `replaced` names an inherited home that was not used.
 */
export function suiteHome(current: string | undefined, temp: string,
  make: (temp: string) => string = (t) => mkdtempSync(join(t, 'cynco-test-home-'))): { home: string; replaced: string | null } {
  if (current) {
    // path.relative compares without case on Windows; '' is the temp folder itself, '..' leads out of it.
    const rel = relative(temp, current)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return { home: current, replaced: null }
  }
  return { home: make(temp), replaced: current ? current : null }
}

const chosen = suiteHome(process.env.CYNCO_HOME, tmpdir())
if (chosen.replaced !== null) {
  console.error(`[suite] CYNCO_HOME ${chosen.replaced} is not inside this run's temp folder, so the suite does not use it; its home is ${chosen.home}`)
}
process.env.CYNCO_HOME = chosen.home
