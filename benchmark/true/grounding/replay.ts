/**
 * Retrospective validation of the grounding probe.
 *
 * Builds the concept table from the REAL civkings source at the task's green ref
 * (03b4032), then runs the probe against the REAL diff each deepdive run
 * produced, and reports how well "probe flags the edit as ungrounded" predicts
 * "the run failed the happiness assertion". No model, no test execution — pure
 * static replay over already-captured evidence.
 *
 * Usage: bun benchmark/true/grounding/replay.ts <deepdive-json> [civkingsRepo] [ref]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { buildConceptTable, probeEdit } from './groundingProbe.js'

const jsonPath = process.argv[2]
const civ = process.argv[3] ?? 'C:\\Users\\civer\\civkings'
const ref = process.argv[4] ?? '03b4032'
if (!jsonPath) {
  console.error('usage: bun replay.ts <deepdive-json> [civkingsRepo] [ref]')
  process.exit(1)
}

// Load every *.py file at the green ref and build the collision table.
const pyFiles = execFileSync('git', ['-C', civ, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf-8' })
  .split('\n')
  .filter((p) => p.endsWith('.py'))
const files = pyFiles.map((path) => ({
  path,
  content: execFileSync('git', ['-C', civ, 'show', `${ref}:${path}`], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }),
}))
const table = buildConceptTable(files)
console.log(`concept-collision table (${table.size} multi-source concepts):`)
for (const [c, info] of table) console.log(`  ${c.padEnd(16)} -> authoritative '${info.systemSource}'  (plain fields in ${info.plainFields.join(', ')})`)

const data = JSON.parse(readFileSync(jsonPath, 'utf-8'))
const HAPPY = 'test_low_happiness_reduces_effective_production'

let tp = 0, fp = 0, tn = 0, fn = 0
console.log('\nrun             | happyLink | probe        | flaggedConcepts')
for (const r of data.runs) {
  const added = r.diff.split('\n').filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).map((l: string) => l.slice(1))
  const findings = probeEdit(added, table)
  const flaggedUngrounded = findings.length > 0
  const happyFailed = r.perTest[HAPPY] !== 'PASSED'
  // "positive" = probe predicts failure (ungrounded)
  if (flaggedUngrounded && happyFailed) tp++
  else if (flaggedUngrounded && !happyFailed) fp++
  else if (!flaggedUngrounded && !happyFailed) tn++
  else fn++
  console.log(
    `${(r.arm + ' rep' + r.rep).padEnd(15)} | ${(r.perTest[HAPPY] ?? '-').padEnd(9)} | ` +
    `${(flaggedUngrounded ? 'UNGROUNDED' : 'grounded').padEnd(12)} | ${findings.map((f) => f.concept).join(',') || '-'}`,
  )
}

console.log('\nconfusion matrix (positive = probe predicts FAIL):')
console.log(`  true-positive  (flagged & failed)  : ${tp}`)
console.log(`  false-positive (flagged & passed)  : ${fp}`)
console.log(`  true-negative  (clean & passed)    : ${tn}`)
console.log(`  false-negative (clean & failed)    : ${fn}`)
const prec = tp + fp > 0 ? tp / (tp + fp) : 0
const rec = tp + fn > 0 ? tp / (tp + fn) : 0
console.log(`  precision ${(prec * 100).toFixed(0)}%  recall ${(rec * 100).toFixed(0)}%`)
