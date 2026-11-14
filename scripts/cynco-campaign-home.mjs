// scripts/cynco-campaign-home.mjs — where a campaign lives.
//
// A campaign spec names its repository (`repo`, required since the first spec)
// and, optionally, the rest of its home:
//
//   briefsDir      the folder the runner writes each wave's brief into
//   campaignLog    the markdown log every verdict is appended to
//   heldoutFamily  the folder under ~/.cynco/heldout/ its sealed instruments live in
//   roadmap        the roadmap whose line the runner moves (sealed → running → done)
//   suiteTarget    what the pytest suite gate and the calibration's suite
//                  baseline run (null: the repository has no pytest suite)
//
// Every key that is absent takes today's CivKings value, so the specs written
// before these keys existed (docs/civkings-redesign-briefs/c8..c11) load and run
// exactly as they did. The runner, the gate author and the dashboard all read
// a campaign's home through `campaignHome`: one spelling of the defaults.
//
// Pure apart from the injectable `exists`, and free of engine imports: the
// dashboard loads it lazily, as it loads the scoreboard.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

/** Today's home, the CivKings campaigns' — every key's default. */
export const CIVKINGS_HOME = Object.freeze({
  repo: 'C:/Users/civer/civkings',
  briefsDir: 'docs/civkings-redesign-briefs',
  heldoutFamily: 'civkings-redesign',
  suiteTarget: 'gilded/tests',
})

/** The optional home keys a spec may carry (`repo` is a required spec key). */
export const HOME_KEYS = ['briefsDir', 'campaignLog', 'heldoutFamily', 'roadmap', 'suiteTarget']

/**
 * A path as the runner uses it: `~/` (or `~\`) is the user's home directory,
 * backslashes become forward slashes, and a relative path stays relative — the
 * runner and the dashboard both resolve it against the localcode checkout they
 * run from, as they always resolved `docs/civkings-redesign-briefs`.
 */
export function expandPath(p) {
  return String(p).replace(/^~(?=[\\/]|$)/, homedir()).replace(/\\/g, '/')
}

/**
 * The campaign's home with every default filled in. `roadmap` is null when the
 * campaign has none: `roadmap: null` says so; an absent key means
 * `<briefsDir>/roadmap.json` when that file exists (today's CivKings roadmap)
 * and none otherwise; a named path is used as named, existing or not (the
 * runner then logs that it could not read it, as it always has).
 * `defaulted` lists the keys that took a default, for the dashboard and logs.
 */
export function campaignHome(spec, { exists = existsSync } = {}) {
  const s = spec ?? {}
  const briefsDir = expandPath(s.briefsDir ?? CIVKINGS_HOME.briefsDir)
  const derivedRoadmap = `${briefsDir}/roadmap.json`
  const roadmap = s.roadmap === null ? null
    : s.roadmap !== undefined ? expandPath(s.roadmap)
      : exists(derivedRoadmap) ? derivedRoadmap : null
  return {
    repo: s.repo !== undefined && s.repo !== null ? expandPath(s.repo) : CIVKINGS_HOME.repo,
    briefsDir,
    campaignLog: expandPath(s.campaignLog ?? `${briefsDir}/campaign-log.md`),
    heldoutFamily: s.heldoutFamily ?? CIVKINGS_HOME.heldoutFamily,
    roadmap,
    suiteTarget: s.suiteTarget === undefined ? CIVKINGS_HOME.suiteTarget : s.suiteTarget,
    defaulted: HOME_KEYS.filter(k => s[k] === undefined),
  }
}

/**
 * What is wrong with a spec's home keys, as sentences (empty when nothing is).
 * Shape only — whether the folders exist is the runner's question at write time.
 */
export function homeProblems(spec) {
  const problems = []
  const s = spec ?? {}
  for (const k of ['briefsDir', 'campaignLog']) {
    if (s[k] !== undefined && (typeof s[k] !== 'string' || !s[k].trim())) problems.push(`campaign spec ${k} must be a non-empty path`)
  }
  if (s.heldoutFamily !== undefined && (typeof s.heldoutFamily !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.heldoutFamily))) {
    problems.push('campaign spec heldoutFamily must be one folder name under ~/.cynco/heldout/ (letters, digits, . _ -)')
  }
  if (s.roadmap !== undefined && s.roadmap !== null && (typeof s.roadmap !== 'string' || !s.roadmap.trim())) {
    problems.push('campaign spec roadmap must be a non-empty path, or null for no roadmap')
  }
  if (s.suiteTarget !== undefined && s.suiteTarget !== null) {
    if (typeof s.suiteTarget !== 'string' || !s.suiteTarget.trim()) problems.push('campaign spec suiteTarget must be a non-empty pytest target, or null for a repository with no pytest suite')
    else if (/\s/.test(s.suiteTarget)) problems.push('campaign spec suiteTarget contains whitespace — it travels in the suite gate\'s env prefix')
    else if (/[*?]/.test(s.suiteTarget)) problems.push('campaign spec suiteTarget contains a wildcard — the check must name files (F146)')
  }
  // Without a pytest suite the default marker check (the suite gate) cannot
  // run, so the spec has to say what the driver runs when the marker lands.
  if (s.suiteTarget === null && (typeof s.markerCheck !== 'string' || !s.markerCheck.trim())) {
    problems.push('campaign spec suiteTarget is null (no pytest suite), so it must name its own markerCheck')
  }
  return problems
}

/** Where a CivKings spec lives: the fallback for a campaign whose state.json predates `specPath`. */
export const legacySpecPath = (id) => `${CIVKINGS_HOME.briefsDir}/${id}.campaign.json`
