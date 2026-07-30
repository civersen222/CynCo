#!/usr/bin/env bun
// Record a withheld-mutation-sweep result onto an existing ledger record.
//
// Sweeps run long after the mission (they take ~20 minutes and they are
// authored after reading the landed code), so the driver cannot fill this in.
// Until it is filled in, `mutationSweep` is null = UNMEASURED, which is neither
// pass nor fail — see the header of cynco-ledger.mjs for why `verified` cannot
// stand in for it.
//
// Usage:
//   bun scripts/cynco-ledger-sweep.mjs --record 33 \
//       --command "python C:/tmp/mutate_ui2.py" --killed 14 --total 15 \
//       --survived 14
//   bun scripts/cynco-ledger-sweep.mjs --mission ui3_brief-1785394368994 ...
//
// --record is 1-based, matching the "record #N" the driver prints.
// --survived is a comma-separated list of rule ids; omit it when none survived.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const LEDGER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..',
  'benchmark', 'cynco-ledger', 'missions.jsonl')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const recordArg = arg('record')
const missionArg = arg('mission')
const command = arg('command')
const killed = arg('killed')
const total = arg('total')
const survivedArg = arg('survived')
const dryRun = process.argv.includes('--dry-run')

if ((!recordArg && !missionArg) || !command || killed === undefined || total === undefined) {
  console.error('usage: --record N | --mission ID  --command "..." --killed K --total T [--survived a,b] [--dry-run]')
  process.exit(2)
}

const lines = readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean)
const rows = lines.map((l) => JSON.parse(l))

let idx
if (recordArg !== undefined) {
  idx = Number(recordArg) - 1
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) {
    console.error(`--record ${recordArg} out of range (ledger has ${rows.length} records)`)
    process.exit(2)
  }
} else {
  idx = rows.findIndex((r) => r.missionId === missionArg)
  if (idx === -1) {
    console.error(`no record with missionId ${missionArg}`)
    process.exit(2)
  }
}

const k = Number(killed)
const t = Number(total)
const survived = survivedArg ? survivedArg.split(',').map((s) => s.trim()).filter(Boolean) : []

// Validate before writing: a malformed sweep record is worse than none, because
// it reads as measured.
const problems = []
if (!Number.isFinite(k) || k < 0) problems.push(`killed=${killed} is not a count`)
if (!Number.isFinite(t) || t <= 0) problems.push(`total=${total} is not a positive count`)
if (k > t) problems.push(`killed (${k}) > total (${t})`)
// The survivor list is the whole point of recording a partial sweep: a bare
// "14/15" does not say WHICH rule is unpinned, and that is the actionable part.
if (k < t && survived.length === 0) {
  problems.push(`${t - k} mutation(s) survived but --survived names none`)
}
if (k === t && survived.length > 0) {
  problems.push(`killed === total but --survived names ${survived.length}`)
}
if (problems.length) {
  for (const p of problems) console.error(`invalid: ${p}`)
  process.exit(2)
}

const rec = rows[idx]
const before = rec.mutationSweep
rec.mutationSweep = { command, killed: k, total: t, survived }

console.log(`record #${idx + 1}  ${rec.missionId}`)
console.log(`  briefFile : ${rec.briefFile}`)
console.log(`  outcome   : ${rec.outcome}   verified: ${rec.verified}`)
console.log(`  was       : ${JSON.stringify(before ?? null)}`)
console.log(`  now       : ${JSON.stringify(rec.mutationSweep)}`)
console.log(`  accepted  : ${rec.outcome === 'landed' && rec.verified === true && k === t}`)

if (dryRun) {
  console.log('--dry-run: nothing written')
  process.exit(0)
}

const out = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const tmp = LEDGER_PATH + '.tmp'
writeFileSync(tmp, out)
renameSync(tmp, LEDGER_PATH)
console.log(`written → ${LEDGER_PATH}`)
