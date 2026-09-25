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
import { basename } from 'node:path'
import { parsePerturbHeader } from './cynco-gate-parse.mjs'

// `C8.1a.tiers-differ`, `C8.5.palette.Atlas`, `C8.9` — the id grammar the
// sealed gates already print and cynco-gate-parse.mjs already reads.
export const LINE_ID_RE = /^C\d+[a-z]?\.\d+[a-z]?(\.[A-Za-z0-9_-]+)*$/

// A gate must not reach the network: a bar that depends on a remote is not a
// measurement of the repo, and it turns a refusal into a flake. The leading
// `[\w., \t]*,[ \t]*` is what catches the banned name in a LIST — `import os,
// socket` and `import json, urllib.request as u` are the same import.
const NETWORK_IMPORT = /^[ \t]*(?:import|from)[ \t]+(?:[\w.]+(?:[ \t]+as[ \t]+\w+)?[ \t]*,[ \t]*)*(urllib|requests|socket|http\.client)\b/m

const defaultIo = { readFile: (p) => readFileSync(p, 'utf8') }

/** Source with `#` comments removed, quotes respected.
 * Every rule below asks "does this file DO x", and a comment saying it does is
 * not doing it — a gate whose header explains that it reads CYNCO_GATE_REPO
 * while the path is hardcoded two lines down must still be refused.
 *
 * Quote tracking is LINE-SCOPED: each line starts outside any string, so a `#`
 * inside a multi-line `"""docstring"""` truncates the rest of that one line.
 * The only consequence is a false negative — a name that appears ONLY inside a
 * docstring after a `#` goes unseen — which is not where a gate reads its
 * environment or imports a module.
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
  return gateLineCalls(gateSource).map(c => c.id)
}

/** The 1-based line of a character offset. `stripComments` keeps every line
 * (it truncates, never joins), so an offset into the stripped text lands on the
 * same line number it has in the file. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** `gateLineIds` with the 1-based source line of each `check(` call. */
function gateLineCalls(gateSource) {
  const calls = []
  const src = stripComments(gateSource)
  const re = /(?<![A-Za-z0-9_.])check\(\s*(?:f|rf|fr)?(['"])((?:[^'"\\]|\\.)*)\1/g
  let m
  while ((m = re.exec(src))) {
    const raw = m[2]
    const brace = raw.indexOf('{')
    calls.push({ id: brace === -1 ? raw : raw.slice(0, brace).replace(/\.$/, ''), line: lineAt(src, m.index) })
  }
  return calls
}

/** Static lint of an authored triple.
 * @returns {{ ok: boolean, problems: string[], at: { file: string, line: number, problem: string }[], lineIds: string[] }}
 * Every problem is one rule and is prefixed `lint:` so the authoring mission's
 * --check output reads as a list of orders rather than a stack trace.
 *
 * Where a rule reads a specific line — the offending `check(` call, the header
 * line, the network import, the `runpy.run_path` of a shim that never set
 * CYNCO_GATE_SKIP_PRIOR — the problem ends ` (<file basename>:<line>)` and
 * `at` carries the same `{ file, line, problem }`. `problems` stays a list of
 * strings so every consumer that prints or joins it keeps working; a rule about
 * something ABSENT from the whole file (no CYNCO_GATE_REPO, no terminator)
 * names no line, because there is none.
 */
export function lintGate({ campaignId, gatePath, perturbPath, positivePath, io = defaultIo }) {
  const problems = []
  const at = []
  const push = (text, path, line) => {
    if (path == null || !line) { problems.push(text); return }
    const file = basename(String(path))
    const problem = `${text} (${file}:${line})`
    problems.push(problem)
    at.push({ file, line, problem })
  }
  // Only the leading `c` is uppercased, and the comparison is case-insensitive:
  // a campaign id may carry a letter suffix (`c10b`, allowed by LINE_ID_RE's
  // `C\d+[a-z]?`), and `toUpperCase()` turned that into `C10B`, which no gate
  // line can ever start with.
  const prefix = String(campaignId ?? '').replace(/^c/i, 'C')
  const lower = prefix.toLowerCase()
  const hasPrefix = (id) => id.toLowerCase().startsWith(lower + '.')
  const gateRaw = io.readFile(gatePath)
  const gate = stripComments(gateRaw)
  const calls = gateLineCalls(gateRaw)
  const lineIds = calls.map(c => c.id)

  // 1. Ids parse, carry this campaign's prefix, and are unique.
  if (lineIds.length === 0) problems.push('lint: no graded lines — the gate calls check("<id>", ...) for every fact it measures')
  for (const { id, line } of calls) {
    if (!LINE_ID_RE.test(id) || !hasPrefix(id)) push(`lint: line id "${id}" is not a ${prefix}.<n> id`, gatePath, line)
  }
  const seen = new Set()
  for (const { id, line } of calls) {
    if (seen.has(id)) push(`lint: duplicate gate line id ${id} — two facts graded under one id hide one of them`, gatePath, line)
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
  const regressionLower = regressionId.toLowerCase()
  const regressionCall = calls.find(({ id }) => id.toLowerCase() === regressionLower || id.toLowerCase().startsWith(regressionLower + '.'))
  if (!regressionCall) {
    problems.push(`lint: no prior-campaign regression line ${regressionId} — nothing would notice this campaign breaking the last one`)
  } else if (!gate.includes('CYNCO_GATE_SKIP_PRIOR')) {
    push(`lint: the ${regressionId} regression line does not honour CYNCO_GATE_SKIP_PRIOR — the shims could not skip it and would recurse`, gatePath, regressionCall.line)
  }

  // 4. The gate prints the terminator the parser reads (cynco-gate-parse.mjs).
  if (!/GATE: (PASS|MISS)/.test(gate)) problems.push('lint: the gate never prints a "GATE: PASS" / "GATE: MISS (n fails)" terminator')

  // 5. The shims run THIS gate in-process and turn the prior chain off.
  const shims = [['perturb', perturbPath], ['positive', positivePath]].filter(([, p]) => p)
  const sources = { gate }
  const paths = { gate: gatePath }
  const headerSource = {}
  for (const [name, path] of shims) {
    const raw = io.readFile(path)
    headerSource[name] = raw
    const src = stripComments(raw)
    sources[name] = src
    paths[name] = path
    const run = /runpy\.run_path\s*\(/.exec(src)
    if (!run) problems.push(`lint: the ${name} shim does not runpy.run_path the gate — it must run the real gate, not a copy of it`)
    // The line named is the run_path call: that is where the gate starts with
    // the prior chain still on, and where the setting belongs before it.
    if (!src.includes('CYNCO_GATE_SKIP_PRIOR')) push(`lint: the ${name} shim does not set CYNCO_GATE_SKIP_PRIOR — it would re-run the prior campaign's gate on every calibration`, path, run ? lineAt(src, run.index) : null)
  }

  // 6. No network in any of the three.
  for (const [name, src] of Object.entries(sources)) {
    const net = NETWORK_IMPORT.exec(src)
    // NETWORK_IMPORT's `^[ \t]*` may start on the line itself, never before it.
    if (net) push(`lint: the ${name} imports ${net[1]} — a gate that reaches the network is not measuring the repo`, paths[name], lineAt(src, net.index))
  }

  // 7. The header declares a non-empty MUST-FAIL and names only real ids.
  // The header is the one part that lives IN the comments, so it reads the raw
  // source rather than the stripped code.
  if (headerSource.perturb !== undefined) {
    let header = null
    try { header = parsePerturbHeader(headerSource.perturb) } catch (e) { problems.push(`lint: ${e.message}`) }
    if (header) {
      const rawLines = String(headerSource.perturb).split(/\r?\n/)
      // The header line a key lives on — the same shape parsePerturbHeader reads.
      const headerLine = (key) => rawLines.findIndex(l => new RegExp(`^#[^\\S\\r\\n]*${key}:`).test(l)) + 1 || null
      if (header.mustFail.length === 0) push('lint: the perturb declares no MUST-FAIL discriminator — a stub that nothing must survive proves nothing', perturbPath, headerLine('MUST-FAIL'))
      const known = (short) => lineIds.some(id => id === short || id.startsWith(short + '.'))
      for (const [key, shorts] of [['EXPECT-FLIP', header.expectFlip], ['MUST-FAIL', header.mustFail]]) {
        for (const short of shorts) {
          if (!known(short)) push(`lint: the perturb header names ${short}, which is not a gate line id`, perturbPath, headerLine(key))
        }
      }
    }
  }

  return { ok: problems.length === 0, problems, at, lineIds }
}
