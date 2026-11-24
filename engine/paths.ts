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
import { isAbsolute, join, win32 } from 'node:path'

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

/**
 * Where the tool-call audit of unattended runs is written: `LOCALCODE_AUDIT_DIR`
 * (empty = unset, as `cyncoHome` reads its own key), else `C:/cynco-audit` on
 * Windows and NOTHING on any other system. There is no default elsewhere on
 * purpose: only Windows integrity labels keep a contained run out of the
 * folder, so on another system choosing it is a deliberate act, and a literal
 * `C:/` path there would be a relative folder in the working directory. A null
 * answer makes every unattended run refuse with a one-line instruction
 * (`engine/audit/toolAudit.ts`, code `audit-dir-unset`). The folder is created
 * by `scripts/cynco-containment-setup.ps1 -Apply` and by nothing else (F242).
 */
export function auditDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = env.LOCALCODE_AUDIT_DIR
  if (override !== undefined && override !== '') return override
  return platform === 'win32' ? 'C:/cynco-audit' : null
}

/**
 * The folder that holds the models: one sub-folder per model, and the embedding GGUF in its root.
 * `LOCALCODE_MODELS_DIR` (empty = unset) or `<home>/models`.
 *
 * It has a key of its own because the models are assets, not state. `CYNCO_HOME` moves both together
 * (F161), and on 2026-11-22 a mission deleted the home folder with the models in it (F242). The folder
 * may be read-only to the engine's account: nothing in the engine writes there. Never point it at a
 * junction (F161).
 *
 * Read on every call, and it never throws: the containment record and the integrity check compare
 * what this returns, so a bad value has to reach them as a value. `home` changes only the default;
 * a script that reads another home's layout (`scripts/cynco-smoke-campaign.mjs`) passes it.
 */
export function modelsDir(home: string = cyncoHome()): string {
  const override = process.env.LOCALCODE_MODELS_DIR
  if (override !== undefined && override !== '') return override
  return join(home, 'models')
}

/**
 * modelsDir() for a process that is about to load a model from it: the same answer, except that a
 * relative `LOCALCODE_MODELS_DIR` throws. A relative value would be resolved against the working
 * folder of whichever process reads it, and the engine, the embedding server and a dispatch do not
 * share one. The default is not judged, so a relative `CYNCO_HOME` behaves as it always has.
 */
export function requireModelsDir(home: string = cyncoHome(), platform: NodeJS.Platform = process.platform): string {
  const dir = modelsDir(home)
  if (dir === join(home, 'models')) return dir
  const absolute = platform === 'win32' ? win32.isAbsolute(dir) : isAbsolute(dir)
  if (!absolute) {
    throw new Error(
      `LOCALCODE_MODELS_DIR is "${dir}", which is not an absolute path. It would be resolved against the working folder of whichever process reads it. Set it to the full path of the models folder.`,
    )
  }
  // On Windows `\models` is absolute to node but lies on whichever drive the reading process is on, and a
  // share carries no integrity labels: only `X:\...` names one folder for every process (review 2026-11-23).
  if (platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(dir)) {
    throw new Error(
      `LOCALCODE_MODELS_DIR is "${dir}", which is not a full path below a drive letter (X:\\...). A path without a drive is resolved against the current drive of whichever process reads it, and a network share cannot be protected. Set it to the full path of the models folder on a local drive.`,
    )
  }
  return dir
}

/**
 * Where the integrity latch, the manifests, the models hash record and unsent pages live.
 * Outside the home folder on purpose (F242): on 2026-11-22 every record of the run lived in the
 * folder the run deleted. Never created by a run; scripts/cynco-containment-setup.ps1 creates it.
 * `setTo` is the variable's value when it is set and not blank, else null.
 * The return type is named because the README inventory scanner takes a braced
 * return type for the function's body and would miss the read below.
 */
type GuardDirSource = { dir: string; setTo: string | null }

export function guardDirSource(env: Record<string, string | undefined> = process.env): GuardDirSource {
  const v = env.LOCALCODE_GUARD_DIR
  if (v === undefined || v.trim() === '') return { dir: 'C:/cynco-guard', setTo: null }
  return { dir: v, setTo: v }
}

export function guardDir(env: Record<string, string | undefined> = process.env): string {
  return guardDirSource(env).dir
}
