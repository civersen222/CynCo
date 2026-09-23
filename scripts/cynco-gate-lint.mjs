// scripts/cynco-gate-lint.mjs
// A STATIC check of an authored gate triple — gate, cheat stub (perturb),
// positive shim — before anything runs it. It is regex over the source text and
// never executes Python: a gate written by a model is untrusted code, and the
// point of this pass is to refuse the obvious shapes (no CYNCO_GATE_REPO, ids
// that do not parse, a header naming a line that does not exist, a network
// import) for the price of three file reads instead of two gate runs.
//
// Everything expensive stays in calibrate() (cynco-campaign-calibrate.mjs):
// this says nothing about whether the gate MEASURES anything, only that it has
// the shape the runner and the parser expect.
import { readFileSync } from 'node:fs'
import { parsePerturbHeader } from './cynco-gate-parse.mjs'

// `C8.1a.tiers-differ`, `C8.5.palette.Atlas`, `C8.9` — the id grammar the
// sealed gates already print and cynco-gate-parse.mjs already reads.
export const LINE_ID_RE = /^C\d+[a-z]?\.\d+[a-z]?(\.[A-Za-z0-9_-]+)*$/

// A gate must not reach the network: a bar that depends on a remote is not a
// measurement of the repo, and it turns a refusal into a flake.
const NETWORK_IMPORT = /^[ \t]*(?:import[ \t]+|from[ \t]+)(urllib|requests|socket|http\.client)\b/m

const defaultIo = { readFile: (p) => readFileSync(p, 'utf8') }

/** Source with `#` comments removed, quotes respected.
 * Every rule below asks "does this file DO x", and a comment saying it does is
 * not doing it — a gate whose header explains that it reads CYNCO_GATE_REPO
 * while the path is hardcoded two lines down must still be refused.
 */
function stripComments(source) {
  return String(source ?? '').split(/\r?\n/).map(line => {
    let quote = null
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (quote) {
        if (c === '\\') { i++; continue }
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") { quote = c; continue }
      if (c === '#') return line.slice(0, i)
    }
    return line
  }).join('\n')
}

/** Ids of the graded lines, in source order: the first string-literal argument
 * of every `check(` call. An f-string id built per seed
 * (`check(f"C7.1.{seed}", ...)`) is a TEMPLATE — its literal prefix is taken
 * (`C7.1`) and nothing is flagged for the interpolation, because the id that
 * reaches the output is only known at run time and this pass never runs.
 */
export function gateLineIds(gateSource) {
  const ids = []
  const re = /(?<![A-Za-z0-9_.])check\(\s*(?:f|rf|fr)?(['"])((?:[^'"\\]|\\.)*)\1/g
  let m
  while ((m = re.exec(stripComments(gateSource)))) {
    const raw = m[2]
    const brace = raw.indexOf('{')
    ids.push(brace === -1 ? raw : raw.slice(0, brace).replace(/\.$/, ''))
  }
  return ids
}

/** Static lint of an authored triple.
 * @returns {{ ok: boolean, problems: string[], lineIds: string[] }}
 * Every problem is one rule and is prefixed `lint:` so the authoring mission's
 * --check output reads as a list of orders rather than a stack trace.
 */
export function lintGate({ campaignId, gatePath, perturbPath, positivePath, io = defaultIo }) {
  const problems = []
  const prefix = String(campaignId ?? '').toUpperCase()
  const gateRaw = io.readFile(gatePath)
  const gate = stripComments(gateRaw)
  const lineIds = gateLineIds(gateRaw)

  // 1. Ids parse, carry this campaign's prefix, and are unique.
  if (lineIds.length === 0) problems.push('lint: no graded lines — the gate calls check("<id>", ...) for every fact it measures')
  for (const id of lineIds) {
    if (!LINE_ID_RE.test(id) || !id.startsWith(prefix + '.')) problems.push(`lint: line id "${id}" is not a ${prefix}.<n> id`)
  }
  const seen = new Set()
  for (const id of lineIds) {
    if (seen.has(id)) problems.push(`lint: duplicate gate line id ${id} — two facts graded under one id hide one of them`)
    seen.add(id)
  }

  // 2. The gate measures the archived BASE the runner hands it, not whatever
  // tree it happens to be started in.
  if (!gate.includes('CYNCO_GATE_REPO')) problems.push('lint: the gate never reads CYNCO_GATE_REPO — it would measure its own directory, not the BASE')

  // 3. The prior-campaign regression line. One problem, never two: deleting the
  // block deletes its CYNCO_GATE_SKIP_PRIOR reference with it, and reporting
  // both would read as two unrelated faults. (That the prior gate runs in a
  // FRESH interpreter is a run-time property; it is not statically checkable
  // here, so calibrate() and the c<N>.9 line itself carry it.)
  const regressionId = `${prefix}.9`
  if (!lineIds.some(id => id === regressionId || id.startsWith(regressionId + '.'))) {
    problems.push(`lint: no prior-campaign regression line ${regressionId} — nothing would notice this campaign breaking the last one`)
  } else if (!gate.includes('CYNCO_GATE_SKIP_PRIOR')) {
    problems.push(`lint: the ${regressionId} regression line does not honour CYNCO_GATE_SKIP_PRIOR — the shims could not skip it and would recurse`)
  }

  // 4. The gate prints the terminator the parser reads (cynco-gate-parse.mjs).
  if (!/GATE: (PASS|MISS)/.test(gate)) problems.push('lint: the gate never prints a "GATE: PASS" / "GATE: MISS (n fails)" terminator')

  // 5. The shims run THIS gate in-process and turn the prior chain off.
  const shims = [['perturb', perturbPath], ['positive', positivePath]].filter(([, p]) => p)
  const sources = { gate }
  const headerSource = {}
  for (const [name, path] of shims) {
    const raw = io.readFile(path)
    headerSource[name] = raw
    const src = stripComments(raw)
    sources[name] = src
    if (!/runpy\.run_path\s*\(/.test(src)) problems.push(`lint: the ${name} shim does not runpy.run_path the gate — it must run the real gate, not a copy of it`)
    if (!src.includes('CYNCO_GATE_SKIP_PRIOR')) problems.push(`lint: the ${name} shim does not set CYNCO_GATE_SKIP_PRIOR — it would re-run the prior campaign's gate on every calibration`)
  }

  // 6. No network in any of the three.
  for (const [name, src] of Object.entries(sources)) {
    const net = NETWORK_IMPORT.exec(src)
    if (net) problems.push(`lint: the ${name} imports ${net[1]} — a gate that reaches the network is not measuring the repo`)
  }

  // 7. The header declares a non-empty MUST-FAIL and names only real ids.
  // The header is the one part that lives IN the comments, so it reads the raw
  // source rather than the stripped code.
  if (headerSource.perturb !== undefined) {
    let header = null
    try { header = parsePerturbHeader(headerSource.perturb) } catch (e) { problems.push(`lint: ${e.message}`) }
    if (header) {
      if (header.mustFail.length === 0) problems.push('lint: the perturb declares no MUST-FAIL discriminator — a stub that nothing must survive proves nothing')
      const known = (short) => lineIds.some(id => id === short || id.startsWith(short + '.'))
      for (const short of [...header.expectFlip, ...header.mustFail]) {
        if (!known(short)) problems.push(`lint: the perturb header names ${short}, which is not a gate line id`)
      }
    }
  }

  return { ok: problems.length === 0, problems, lineIds }
}
