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
 * Deliberately NOT deleted at exit: when a test fails over on-disk state, the
 * directory it wrote is the evidence. The path is printed by the guard test.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.CYNCO_HOME) {
  process.env.CYNCO_HOME = mkdtempSync(join(tmpdir(), 'cynco-test-home-'))
}
