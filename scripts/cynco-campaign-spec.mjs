// scripts/cynco-campaign-spec.mjs
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const REQUIRED = ['id', 'title', 'repo', 'base', 'gate', 'perturb', 'suiteBaseline', 'marker', 'keepGreen', 'budget', 'invariants', 'posiwid', 'allow', 'deny', 'measures', 'work', 'rules']
const NUM = (o, k, path) => { if (typeof o?.[k] !== 'number' || !(o[k] > 0)) throw new Error(`campaign spec ${path}.${k} must be a positive number`) }

export function loadCampaignSpec(path) {
  let spec
  try { spec = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`campaign spec ${path} is not valid JSON — ${e.message}`) }
  for (const k of REQUIRED) if (spec[k] === undefined || spec[k] === null || spec[k] === '') throw new Error(`campaign spec is missing "${k}"`)
  for (const k of ['hoursPerWave', 'iterations', 'bashTimeoutMs', 'waves']) NUM(spec.budget, k, 'budget')
  for (const k of ['editGapCap', 'commitGapCap']) NUM(spec.invariants, k, 'invariants')
  for (const k of ['revertBan', 'codeIndexFirst']) if (typeof spec.invariants[k] !== 'boolean') throw new Error(`campaign spec invariants.${k} must be a boolean`)
  NUM(spec.posiwid, 'sourceEditShare', 'posiwid'); NUM(spec.posiwid, 'commitEvery', 'posiwid')
  if (/[*?]/.test(spec.keepGreen)) throw new Error('campaign spec keepGreen contains a wildcard — the check must name files (F146)')
  if (!Array.isArray(spec.work) || spec.work.length === 0) throw new Error('campaign spec work must be a non-empty array')
  const seen = new Set()
  for (const w of spec.work) {
    for (const k of ['id', 'title', 'gateIds', 'text']) if (w[k] === undefined) throw new Error(`campaign spec work item is missing "${k}"`)
    for (const g of w.gateIds) { if (seen.has(g)) throw new Error(`campaign spec gateId ${g} appears in two work items`); seen.add(g) }
  }
  if (!Array.isArray(spec.allow?.newFiles) || !Array.isArray(spec.allow?.edit)) throw new Error('campaign spec allow.newFiles and allow.edit must be arrays')
  // claimedSurvivors (cynco-campaign.mjs) matches a sweep survivor by the
  // prefix before the first `*`. An entry that STARTS with a glob has an empty
  // prefix and claims nothing, so a survivor inside it reads as unclaimed and
  // the campaign PASSes clean over it. Refuse the entry instead.
  for (const [k, entries] of [['newFiles', spec.allow.newFiles], ['edit', spec.allow.edit]]) {
    for (const e of entries) {
      if (/^\*/.test(String(e).trim().split(/\s+/)[0] ?? '')) throw new Error(`campaign spec allow.${k} entry "${e}" starts with a glob — name the directory it lives in (a survivor is claimed by path prefix)`)
    }
  }
  // Optional: the mutation sweep's mutant cap (cynco-mutation-sweep.py --max,
  // default 25) and the branch `--sync` opens the PR against.
  if (spec.sweep !== undefined) {
    if (typeof spec.sweep !== 'object' || spec.sweep === null) throw new Error('campaign spec sweep must be an object')
    if (spec.sweep.max !== undefined && (!Number.isInteger(spec.sweep.max) || spec.sweep.max <= 0)) throw new Error('campaign spec sweep.max must be a positive integer')
  }
  if (spec.prBase !== undefined && (typeof spec.prBase !== 'string' || !spec.prBase)) throw new Error('campaign spec prBase must be a non-empty string')
  // Optional: the positive shim (Rule 14 — calibrate runs it and requires
  // `GATE: PASS`), and the provenance of the gate itself. `positive` stays
  // optional because the hand-authored c8 spec has none and must keep loading;
  // the seal verb requires one for every gate CynCo writes.
  if (spec.positive !== undefined && (typeof spec.positive !== 'string' || !spec.positive)) throw new Error('campaign spec positive must be a non-empty string')
  if (spec.author !== undefined && spec.author !== 'cynco' && spec.author !== 'human') throw new Error(`campaign spec author must be "cynco" or "human"; got ${JSON.stringify(spec.author)}`)
  spec.author = spec.author ?? 'human'
  if (spec.authorMissionId !== undefined && spec.authorMissionId !== null && typeof spec.authorMissionId !== 'string') throw new Error('campaign spec authorMissionId must be a string or null')
  spec.authorMissionId = spec.authorMissionId ?? null
  spec.ideation = spec.ideation ?? { enabled: true }
  return spec
}

const defaultIo = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
  gitHasCommit: (repo, sha) => spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8' }).status === 0,
}

/** S5 identity: the invariants no wave, proposal, or generated brief may violate.
 * Note: spec.suiteBaseline is not required to exist here — it is CREATED by
 * calibration (a later task). Only its location under ~/.cynco/heldout/ is
 * an identity invariant; gate and perturb must already exist (they are
 * authored ahead of time and sealed).
 */
export function checkIdentity(spec, io = defaultIo) {
  const problems = []
  const norm = (p) => String(p).replace(/\\/g, '/')
  const underHeldout = (p) => {
    const n = norm(p)
    // Accept an absolute path containing /.cynco/heldout/ or a ~/-prefixed
    // form (~/.cynco/heldout/...), normalising backslashes either way.
    return /\/\.cynco\/heldout\//.test(n) || /^~\/\.cynco\/heldout\//.test(n)
  }
  // The positive shim is an instrument too: it names every graded fact and how
  // to make it true, which is the answer key. Sealed on the same terms as the
  // gate whenever the spec declares one.
  for (const k of ['gate', 'perturb', ...(spec.positive ? ['positive'] : [])]) {
    if (!underHeldout(spec[k])) problems.push(`${k} must live under ~/.cynco/heldout/ (sealed); got ${spec[k]}`)
    if (!io.exists(spec[k])) problems.push(`${k} does not exist: ${spec[k]}`)
  }
  if (!underHeldout(spec.suiteBaseline)) problems.push(`suiteBaseline must live under ~/.cynco/heldout/ (sealed); got ${spec.suiteBaseline}`)
  if (!io.gitHasCommit(spec.repo, spec.base)) problems.push(`base ${spec.base} is not a commit in ${spec.repo}`)
  if (spec.keepGreen.includes(spec.marker)) problems.push('keepGreen must not contain the marker')
  const forbidden = [basename(norm(spec.gate)), basename(norm(spec.perturb)), ...(spec.positive ? [basename(norm(spec.positive))] : []), 'heldout']
  // EVERY field the brief prints, not just the prose ones: the KEEP-GREEN
  // command, the allow/deny lists and the title all reach the worker verbatim
  // through cynco-brief.mjs, and naming the sealed gate in any of them is the
  // same leak as naming it in `measures`.
  const visible = [spec.title, spec.keepGreen, spec.measures, ...spec.work.map(w => w.text), ...spec.work.map(w => w.title),
    ...spec.rules, ...spec.allow.newFiles, ...spec.allow.edit, ...spec.deny, spec.assets?.text ?? '']
  for (const text of visible) for (const f of forbidden) {
    if (String(text).includes(f)) problems.push(`brief-visible text names the sealed instrument "${f}" — sealedPaths would refuse the run`)
  }
  return { ok: problems.length === 0, problems }
}
