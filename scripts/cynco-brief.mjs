// scripts/cynco-brief.mjs
// The deterministic S4 occupant. Every section below maps to a brief-authoring
// rule (feedback_brief_authoring) or a gate-authoring rule; the one rule this
// file enforces structurally is 15: a gate line is COPIED, never restated —
// there is no code path here that paraphrases one.
const wrap = (s) => String(s).replace(/\s+$/, '')

export function sidecarFor(spec) {
  return { assertions: [{ text: 'The KEEP-GREEN set passes (run it before every commit).', command: spec.keepGreen, timeoutMs: 1_800_000 }] }
}

function header(spec, ctx) {
  const state = ctx.prior
    ? `Wave ${ctx.wave - 1} (${ctx.prior.missionId}) ended by ${ctx.prior.exitReason} after ${(ctx.prior.durationS / 3600).toFixed(1)} h with ${ctx.prior.commits.length} commit(s); ${ctx.fails.length} gate line(s) still FAIL.`
    : `Campaign opened at BASE ${ctx.base}; the sealed gate MISSes ${ctx.fails.length} line(s), all by absence.`
  return wrap(`MISSION ${spec.id.toUpperCase()} WAVE ${ctx.wave} — ${spec.title.toUpperCase()}\n(${state} ${spec.budget.hoursPerWave} hours, ${spec.budget.iterations} iterations, Bash cap ${Math.round(spec.budget.bashTimeoutMs / 1000)} s.)`)
}

function fact0(ctx) {
  if (!ctx.prior || ctx.prior.commits.length === 0) return null
  return wrap(`FACT 0 — WHAT IS ALREADY DONE (committed)\n${ctx.prior.commits.map(c => `  ${c.sha} ${c.subject}`).join('\n')}\nGOOD. KEEP IT. Do not rework these. Build on them.`)
}

function step0(ctx) {
  if (!ctx.salvage || ctx.salvage.files.length === 0) return null
  return wrap(`STEP 0 — COMMIT WHAT THE LAST WAVE LEFT ON THE FLOOR (first 15 calls, nothing else in it)

  The previous run ended with uncommitted edits to ${ctx.salvage.files.join(', ')}. They were
  saved as a patch outside the repo. Restore and commit them BEFORE you read anything else;
  a red commit is recoverable and an uncommitted tree is not. Do not run the tests first.
    git apply --3way "${ctx.salvage.patchPath}"
    git add ${ctx.salvage.files.join(' ')}
    git commit -m "wave ${ctx.wave} step 0: restore uncommitted work from wave ${ctx.wave - 1}"
  COMMIT 0. If the patch does not apply cleanly, commit whatever applied and say so in the message.`)
}

function misses(ctx) {
  const lines = ctx.fails.map(f => `  ${f.line}`).join('\n')
  const keep = ctx.passes.length ? `\n\n  Already PASS at BASE and must stay so: ${ctx.passes.map(p => p.id).join(', ')}.` : ''
  return wrap(`THE MISSES (sealed gate at BASE ${ctx.base}, verbatim — the gate grades pixels, drawn
regions pressed at their centres, files on disk, and values the game returns; never a claim)\n\n${lines}${keep}`)
}

function work(spec, ctx) {
  const failing = new Set(ctx.fails.map(f => f.id))
  const items = spec.work.filter(w => w.gateIds.some(g => failing.has(g)))
  const body = items.map(w => `${w.id}. ${w.title}. ${w.text} COMMIT ${w.id}.`).join('\n\n')
  return wrap(`THE WORK (numbered commit points — commit AT each; a commit is the only
backup you have; the full suite is graded after the run, not by you)\n\n${body}`)
}

function ideation(ctx) {
  if (!ctx.ideation) return null
  const h = ctx.ideation.hypotheses.map(x => `  ${x.gateId}: ${x.cause} — first edit ${x.firstEdit}`).join('\n')
  const trap = ctx.ideation.trap ? `\n  Trap named by the advisor: ${ctx.ideation.trap}` : ''
  return wrap(`S4 IDEATION (advisory — the gate lines above bind; this section may be wrong)\n${h}${trap}`)
}

function pacing(spec, ctx) {
  const inv = spec.invariants
  const digest = ctx.prior ? (() => {
    const t = ctx.prior.toolStats ?? {}
    const d = ctx.prior.invariants
    const ci = t.byName?.CodeIndex ?? 0
    // invariants.denials is a windowed snapshot (last 50, since plan 2's fix
    // wave) — the true total lives in denialCount; fall back to the window's
    // length only when a run predates that field.
    const denyCount = d?.denialCount ?? d?.denials?.length ?? 0
    const byInvariant = d?.denialsByInvariant
      ? ` (${Object.entries(d.denialsByInvariant).map(([k, v]) => `${k} ${v}`).join(', ')})`
      : ''
    const relents = d?.terminalRelents?.length
      ? `; the engine stopped enforcing ${d.terminalRelents.join(', ')} after repeated relents`
      : ''
    return `\n\nTRACK RECORD (measured, wave ${ctx.wave - 1}): wave ${ctx.wave - 1} went ${t.maxCallsWithoutSourceEdit ?? '?'} calls without a source edit and ${t.maxCallsWithoutCommit ?? '?'} without a commit; ` +
      `${t.byClass?.inspect ?? '?'} inspect calls against ${t.byClass?.sourceEdit ?? '?'} source edits; CodeIndex ${ci} of ${t.total ?? '?'} calls` +
      (d ? `; the engine denied ${denyCount} call(s)${byInvariant} (${d.revertRefusals ?? 0} revert refusals), ${d.codeIndexAssisted ?? 0} Greps were CodeIndex-assisted${relents}` : '') +
      (ctx.prior.posiwid ? `; POSIWID: ${ctx.prior.posiwid.verdict} (dominant behaviour ${ctx.prior.posiwid.dominantObserved})` : '') + '.'
  })() : ''
  return wrap(`PACING (enforced by the engine, not advice)
- ${inv.editGapCap} tool calls without a source edit and the engine narrows you to edit-only tools
  until you make one. Write the hypothesis into a commit message on the smallest edit that tests it.
- ${inv.commitGapCap} calls without a commit and the same narrowing applies until you commit.
- Reverting is refused: git checkout --, git restore, git stash, git reset --hard, git clean. A
  targeted Edit on top of the last commit is the only way back. Salvage lives under C:\\tmp.
- An identifier-shaped Grep returns CodeIndex's definition card first; use it.
- Probes live under C:\\tmp, never in the repo. No scratch snapshots.${digest}`)
}

function rules(spec) {
  const allow = `- NO downloads. New files inside the repo ONLY: ${spec.allow.newFiles.join(', ')}.\n- You may change: ${spec.allow.edit.join(', ')}. NOT ${spec.deny.join(', NOT ')}.`
  return wrap(`RULES\n${allow}\n${spec.rules.map(r => `- ${r}`).join('\n')}`)
}

function doneWhen(spec) {
  return wrap(`DONE WHEN\nThe KEEP-GREEN set passes, every miss above is fixed by the definitions in HOW THE GATE
MEASURES, and the tree is clean. Then make a final commit whose message contains exactly this marker:\n\n${spec.marker}`)
}

export function generateBrief(spec, ctx) {
  const sections = [
    header(spec, ctx),
    `Repo: ${spec.repo.replace(/\//g, '\\')}`,
    wrap(`BASE: ${ctx.base}. KEEP-GREEN set, run before EVERY commit:\n${spec.keepGreen}`),
    spec.assets ? wrap(spec.assets.text) : null,
    fact0(ctx),
    step0(ctx),
    misses(ctx),
    wrap(spec.measures),
    work(spec, ctx),
    ideation(ctx),
    pacing(spec, ctx),
    rules(spec),
    doneWhen(spec),
  ].filter(Boolean)
  return sections.join('\n\n') + '\n'
}
