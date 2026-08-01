/**
 * Where CynCo keeps its state on disk.
 *
 * F58. Fifty-odd call sites each spelled `join(homedir(), '.cynco', ...)` out
 * inline, which meant there was nowhere to stand to redirect them. A vitest run
 * left 117 session journals in the same directory the running engine reads
 * from — the test suite and the live daemon sharing one mutable directory.
 *
 * This is the seam. It is deliberately the only one: a second way to compute
 * the same path is a second way for a redirect to miss.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The root of CynCo's state directory, `~/.cynco` unless `CYNCO_HOME` says
 * otherwise.
 *
 * Read from the environment on every call, not captured at module load. Bun
 * caches `os.homedir()` at startup, and a value captured at import time would
 * make the redirect depend on module load order — it would work or not
 * depending on which consumer imported first, which is not a guarantee.
 *
 * An empty `CYNCO_HOME` is treated as unset. `??` alone would return `''`, and
 * every consumer joins onto this, so `sessions/` would be created relative to
 * the process cwd — in whatever repo the engine happened to be launched from,
 * silently. `CYNCO_HOME=$SOME_UNSET_VAR` is an ordinary accident.
 */
export function cyncoHome(): string {
  const override = process.env.CYNCO_HOME
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.cynco')
}
