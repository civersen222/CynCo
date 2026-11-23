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

/**
 * Whether this engine may adopt the pre-rename state folder, `~/.localcode`, as its home.
 *
 * Only an engine on the default home may, and only when that home is not there yet: the
 * one-time move to `~/.cynco`. A home redirected with `CYNCO_HOME` is how a second engine, a
 * test engine or a campaign is kept out of the live state, and it is somebody's scratch space.
 * On 2026-11-17 a scratch engine whose `CYNCO_HOME` named a folder that did not exist yet was
 * handed the owner's `~/.localcode` by this move, and the start-up session clean-up then
 * deleted the 53 journals in it that were older than thirty days (F241). `env` is the seam.
 */
export function shouldAdoptLegacyHome(opts: { legacyExists: boolean; homeExists: boolean; env?: Record<string, string | undefined> }): boolean {
  const override = (opts.env ?? process.env).CYNCO_HOME
  if (override !== undefined && override !== '') return false
  return opts.legacyExists && !opts.homeExists
}

/**
 * Where the liveness daemon's missions live: `CYNCO_MISSIONS_DIR` (empty =
 * unset) or `<cyncoHome()>/missions`. The daemon loads `<id>/mission.json`
 * from here and the dashboard's `/api/away` tails `<id>/runs.jsonl`; both
 * call this, so the two cannot drift apart (PR #190 review).
 */
export function missionsDir(): string {
  const override = process.env.CYNCO_MISSIONS_DIR
  if (override !== undefined && override !== '') return override
  return join(cyncoHome(), 'missions')
}

/**
 * The parent of every run's sandbox, `<root>/<run id>/{home,tmp,scratch}` (engine/containment.ts, F242).
 * `LOCALCODE_SANDBOX_ROOT` (empty = unset) or `C:/cynco-sandbox`. Never created by the engine, the daemon,
 * a dispatch or a test: a root that does not exist is a refusal, which is also what makes this
 * Windows-shaped default safe on another system. Read on every call.
 */
export function sandboxRoot(env: Record<string, string | undefined> = process.env): string {
  const v = env.LOCALCODE_SANDBOX_ROOT
  return v && v.trim() ? v : 'C:/cynco-sandbox'
}
