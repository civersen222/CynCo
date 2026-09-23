// scripts/cynco-gate-parse.mjs
// The sealed gates print one `id: PASS|FAIL detail` line per graded fact and a
// `GATE: PASS` / `GATE: MISS (n fails)` terminator (gate_c8.py:70-73, :332).
// This is the only parser of that format outside the gates themselves (gate_c8.py:322).
const GATE_LINE = /^([A-Za-z0-9_.\-]+): (PASS|FAIL)(.*)$/
const TERMINATOR = /^GATE: (PASS|MISS)(?: \((\d+) fails?\))?/
const ERROR_LINE = /Traceback|Error:|FABRICATED/

export function parseGateOutput(text) {
  const out = { fails: [], passes: [], terminator: null, failCount: null, errors: [], priorRegressions: null }
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.startsWith('  [')) continue // prior-chain echo: "  [c7] GATE: PASS"
    const t = TERMINATOR.exec(line)
    if (t) { out.terminator = t[1]; out.failCount = t[2] !== undefined ? Number(t[2]) : (t[1] === 'PASS' ? 0 : null); continue }
    const m = GATE_LINE.exec(line)
    if (m) {
      const entry = { id: m[1], line }
      ;(m[2] === 'FAIL' ? out.fails : out.passes).push(entry)
      const prior = /^(\d+) prior-campaign regressions/.exec(m[3].trim())
      if (m[1].endsWith('.9') && prior) out.priorRegressions = Number(prior[1])
      continue
    }
    if (ERROR_LINE.test(line)) out.errors.push(line)
  }
  return out
}

export function parsePerturbHeader(text) {
  const pick = (key) => {
    const m = new RegExp(`^#\\s*${key}:\\s*(.*)$`, 'm').exec(String(text ?? ''))
    if (!m) throw new Error(`perturb header is missing a "# ${key}:" line — the runner cannot calibrate what the stub did not declare`)
    return m[1].trim().split(/\s+/).filter(Boolean)
  }
  return { expectFlip: pick('EXPECT-FLIP'), mustFail: pick('MUST-FAIL') }
}

// Rule 11 (feedback_gate_authoring): the BASE must fail the bar by absence with
// zero gate errors, and a cheat stub must flip only the lines it declared while
// every discriminator stays red. A prefix match ("C8.1b") covers the full id
// ("C8.1b.tiers-differ") so headers can stay short.
export function compareCalibration({ base, perturbed, header }) {
  const problems = []
  if (base.terminator !== 'MISS') problems.push(`BASE must MISS the gate; terminator was ${base.terminator}`)
  if (base.errors.length) problems.push(`BASE run printed ${base.errors.length} error line(s): ${base.errors[0]}`)
  if (perturbed.errors.length) problems.push(`perturbed run printed ${perturbed.errors.length} error line(s): ${perturbed.errors[0]}`)
  const matches = (id, short) => id === short || id.startsWith(short + '.')
  const baseFail = new Set(base.fails.map(f => f.id))
  const pertFail = new Set(perturbed.fails.map(f => f.id))
  for (const short of header.mustFail) {
    const ids = [...baseFail].filter(id => matches(id, short))
    if (ids.length === 0) problems.push(`MUST-FAIL ${short} does not name a BASE failure`)
    for (const id of ids) if (!pertFail.has(id)) problems.push(`discriminator ${id} went green under the cheat stub`)
  }
  for (const id of baseFail) {
    if (!pertFail.has(id) && !header.expectFlip.some(s => matches(id, s))) problems.push(`${id} flipped to PASS under the cheat stub but was not declared in EXPECT-FLIP`)
  }
  return { ok: problems.length === 0, problems }
}
