// scripts/cynco-ideation.mjs
//
// The advisory S4 occupant: reads the sealed gate's FAIL lines and the brief
// the worker is about to receive, and proposes (cause, file-to-edit-first)
// hypotheses plus one trap to avoid. It never edits code (read-only
// allowedTools) and never commands the brief directly — the deterministic
// generator holds `brief` authority at 1.0 until ideation EARNS a higher
// score via `promotionProposal`'s evidence-gated Fisher test.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeTaskFile } from '../engine/daemon/taskFile.js'
import { heterarchy } from '../engine/cybernetics-core/src/index.js'
import { fisherExact } from './cynco-signal-validation.mjs'

export const IDEATION_TIMEOUT_MS = 1_200_000
export const IDEATION_MIN_WAVES = 8
export const IDEATION_MAX_AUTHORITY = 0.5

export function ideationPrompt({ spec, fails, prior, briefText }) {
  const context = [
    `You are the advisory S4 seat for CivKings campaign ${spec.id}. You read the code; you do not edit it.`,
    prior ? `Last wave: ${prior.exitReason}, ${prior.commits?.length ?? 0} commits, ${prior.toolStats?.maxCallsWithoutSourceEdit ?? '?'} calls without a source edit.` : 'First wave of the campaign.',
    'The sealed gate still fails these lines (verbatim; you cannot run the gate):',
    ...fails.map(f => `  ${f.line}`),
    '--- the brief the worker will receive ---', briefText,
  ].join('\n')
  const prompt = [
    'For each FAIL line, name the most likely cause in the code and the ONE file a worker should edit first. Name one trap (a plausible wrong turn). Do not edit any file; do not run tests.',
    'The sealed gate still fails these lines (verbatim; you cannot run the gate):',
    ...fails.map(f => `  ${f.line}`),
    'Answer with exactly one fenced json block, at most 1500 bytes, in this shape:',
    '```json',
    '{ "summary": "<one line>", "recommendations": [',
    '  { "actionType": "hypothesis", "summary": "<gate id exactly as printed>", "detail": "<cause> | firstEdit: <repo-relative path>" },',
    '  { "actionType": "trap", "summary": "trap", "detail": "<one wrong turn to avoid>" } ] }',
    '```',
  ].join('\n')
  return { prompt, context }
}

export function parseIdeation(outcome) {
  if (!outcome?.ok || !Array.isArray(outcome.recommendations)) return null
  const hypotheses = []
  let trap = null
  for (const r of outcome.recommendations) {
    if (r.actionType === 'hypothesis') {
      const m = /^(.*?)\s*\|\s*firstEdit:\s*(\S+)\s*$/.exec(String(r.detail ?? ''))
      hypotheses.push({ gateId: String(r.summary).trim(), cause: m ? m[1].trim() : String(r.detail).trim(), firstEdit: m ? m[2].replace(/\\/g, '/') : null })
    } else if (r.actionType === 'trap') trap = String(r.detail).trim()
  }
  if (hypotheses.length === 0) return null
  return { hypotheses, order: hypotheses.map(h => h.gateId), trap }
}

export async function runIdeation({ spec, fails, prior, briefText, stateDir, repoRoot = process.cwd(), io }) {
  const t0 = Date.now()
  const dir = join(stateDir, 'ideation'); mkdirSync(dir, { recursive: true })
  const stamp = Date.now()
  const taskPath = join(dir, `task-wave-${stamp}.json`)
  const outcomePath = join(dir, `outcome-wave-${stamp}.json`)
  const { prompt, context } = ideationPrompt({ spec, fails, prior, briefText })
  writeTaskFile(taskPath, { missionId: `campaign-${spec.id}`, triggerId: `wave-${stamp}`, prompt, context, allowedTools: ['Read', 'Grep', 'Glob', 'CodeIndex'], timeoutMs: IDEATION_TIMEOUT_MS, outcomePath })
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CYNCO_NTFY_')) env[k] = v
  env.LOCALCODE_APPROVE_ALL = 'true'
  const code = await (io?.runTask ?? runTask)(repoRoot, taskPath, env, spec.repo)
  try {
    const outcome = JSON.parse(readFileSync(outcomePath, 'utf8'))
    return { ideation: parseIdeation(outcome), taskPath, outcomePath, durationMs: Date.now() - t0, exitCode: code }
  } catch (e) { return { ideation: null, taskPath, outcomePath, durationMs: Date.now() - t0, exitCode: code, error: String(e) } }
}

function runTask(repoRoot, taskPath, env, cwd) {
  return new Promise((res) => {
    const child = spawn('bun', [resolve(repoRoot, 'engine', 'main.ts'), '--run-task', taskPath], { cwd, env, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { try { child.kill() } catch {} res(null) }, IDEATION_TIMEOUT_MS + 60_000)
    child.on('exit', (c) => { clearTimeout(timer); res(c) })
    child.on('error', () => { clearTimeout(timer); res(null) })
  })
}

/**
 * Did the wave's FIRST commit touch the file the advisor named?
 *
 * Which hypothesis counts is not arbitrary: the brief lists the FAIL lines in
 * the gate's own order and the work items follow it, so the hypothesis the
 * worker could plausibly have acted on first is the one for the FIRST FAIL id
 * in the wave's context — `fails`. When the advisor said nothing about that
 * line (or the caller has no fails to hand), the first hypothesis carrying a
 * `firstEdit` is used instead. `hypotheses` are ordered as the model wrote
 * them, and a gate id is matched by prefix ("C8.1b" covers
 * "C8.1b.tiers-differ"), the same rule the calibration comparison uses.
 *
 * This is the numerator of the promotion evidence — see `promotionProposal` —
 * so it must not be a lottery over whichever hypothesis happened to be listed
 * first.
 */
export function measureFollowed(ideation, firstCommitFiles, fails = []) {
  if (!ideation) return null
  const firstFail = fails[0]?.id ?? null
  const matches = (a, b) => a === b || a.startsWith(b + '.') || b.startsWith(a + '.')
  const pick = (firstFail && ideation.hypotheses.find(h => h.firstEdit && matches(String(h.gateId), firstFail)))
    || ideation.hypotheses.find(h => h.firstEdit)
  if (!pick) return false
  return firstCommitFiles.map(f => f.replace(/\\/g, '/')).includes(pick.firstEdit)
}

// McCulloch: authority is contextual and SCORED. The deterministic generator
// holds the brief at 1.0; the model occupant starts at 0 and earns it (below).
export function authorityRegistry(state) {
  const reg = new heterarchy.CommandRegistry()
  reg.register('generator', 'brief', 1.0)
  reg.register('ideation', 'brief', state.ideationAuthority ?? 0)
  return reg
}

// An autopoiesis Proposal, data-shaped (cybernetics-core ProposalDetail
// `Parameter`), approved by the owner over ntfy — identity changes keep a human
// in the S5 loop. Same bar the S5 rules failed: Fisher exact on followed × landed.
export function promotionProposal(waves, currentAuthority, alpha = 0.05) {
  if (currentAuthority >= IDEATION_MAX_AUTHORITY) return null
  const ideated = waves.filter(w => w.s4?.ideation && typeof w.s4.followed === 'boolean' && typeof w.outcome?.landed === 'boolean')
  if (ideated.length < IDEATION_MIN_WAVES) return null
  const a = ideated.filter(w => w.s4.followed && w.outcome.landed).length
  const b = ideated.filter(w => w.s4.followed && !w.outcome.landed).length
  const c = ideated.filter(w => !w.s4.followed && w.outcome.landed).length
  const d = ideated.filter(w => !w.s4.followed && !w.outcome.landed).length
  const p = fisherExact(a, b, c, d)
  if (!(p < alpha) || a / Math.max(a + b, 1) <= c / Math.max(c + d, 1)) return null
  return { type: 'Parameter', name: 'ideation/brief', newValue: IDEATION_MAX_AUTHORITY, bounds: { min: 0, max: IDEATION_MAX_AUTHORITY },
           status: 'pending', evidence: { followedLanded: a, followedMissed: b, notFollowedLanded: c, notFollowedMissed: d, p } }
}

// ── The cap loop: a denial that never changes the next call is noise ──
//
// Same shape and same bar as the ideation promotion: a data-shaped Parameter
// proposal the owner approves (`--approve-proposal invariants/<cap>`). Only the
// two caps are tunable; the revert ban is an identity invariant the campaign
// recursion spec places beyond any proposal.
export const CAP_PROPOSAL_FACTOR = 1.5
export const CAP_BY_INVARIANT = { 'edit-gap': 'editGapCap', 'commit-gap': 'commitGapCap' }

export function effectiveInvariants(spec, state) {
  const out = { ...spec.invariants }
  for (const [k, v] of Object.entries(state?.invariantOverrides ?? {})) if (k === 'editGapCap' || k === 'commitGapCap') out[k] = v
  return out
}

export function capProposal(denialAnalysis, spec, state) {
  if (!denialAnalysis?.invariants) return null
  if ((state?.proposals ?? []).some(p => p.status === 'pending')) return null
  const current = effectiveInvariants(spec, state)
  for (const r of denialAnalysis.invariants) {
    const cap = CAP_BY_INVARIANT[r.invariant]
    if (!cap || r.verdict !== 'INERT') continue
    const min = spec.invariants[cap], max = spec.invariants[cap] * 2
    const newValue = Math.min(max, Math.round(current[cap] * CAP_PROPOSAL_FACTOR))
    if (newValue <= current[cap]) continue
    return { type: 'Parameter', name: `invariants/${cap}`, newValue, bounds: { min, max }, status: 'pending', evidence: r }
  }
  return null
}
