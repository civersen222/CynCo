// Record a withheld-mutation-sweep result onto an existing ledger record.
//
// Sweeps run long after the mission (they take ~20 minutes and they are
// authored after reading the landed code), so the driver cannot fill this in.
// Until it is filled in, `mutationSweep` is null = UNMEASURED, which is neither
// pass nor fail — see the header of cynco-ledger.mjs for why `verified` cannot
// stand in for it.
//
// No shebang, on purpose — invoke it with `bun`, never as `./`. This file is
// also imported by engine/__tests__/harness/ledgerSweep.test.ts, and Vite's
// module pipeline strips a `#!...\n` but chokes on a `#!...\r\n`. Since
// core.autocrlf=true is the Git default on Windows, the shebang that used to
// be here made that whole test file fail to PARSE on every fresh clone — and a
// suite that fails collection reports `(0 test)`, so its twelve tests simply
// vanished from a summary line that still read green. Guarded now by
// engine/__tests__/guards/shebangCollection.test.ts.
//
// Usage:
//   bun scripts/cynco-ledger-sweep.mjs --record 33 \
//       --command "python C:/tmp/mutate_ui2.py" --killed 14 --total 15 \
//       --survived 14
//   bun scripts/cynco-ledger-sweep.mjs --mission ui3_brief-1785394368994 ...
//
// --record is 1-based, matching the "record #N" the driver prints.
// --survived takes the surviving rule ids, comma- OR space-separated. Both work
// on purpose: taking only the first token writes a record that UNDERSTATES the
// failure, and a record that reads "1 survivor" when eight survived is worse
// than no record at all. Omit it when none survived. The list must name every
// survivor — exactly `total - killed` ids — or nothing is written.
//
// --kind authored (default) | derived. An AUTHORED sweep is a withheld set
// written per stage against the DoD's own rule ids, so a survivor is a rule the
// mission claimed and failed to pin, and the labeling rule reads it as a failed
// mission. A DERIVED sweep comes from scripts/cynco-mutation-sweep.py, which
// mutates whatever expressions the mission's diff added; a survivor there says
// the delivered tests do not cover a line, which is worth knowing but is not an
// unmet claim. Both count as MEASURED — that is the point, since 151 rows sat
// unlabeled waiting for a sweep nobody was going to hand-author.

import { writeFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { readLedger } from './cynco-ledger-shards.mjs'
// The predicate that actually labels the ledger. Imported, not reimplemented,
// so the line this script prints cannot drift from the line the scorer reads.
import { labelOf } from './cynco-signal-validation.mjs'

export function arg(argv, name) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

// Gather EVERY token after --name up to the next --flag, then split each on
// commas. `--survived a,b` and `--survived a b` must mean the same thing:
// reading only argv[i+1] silently discarded seven of eight survivor ids once,
// and the record it wrote read as measured.
export function argList(argv, name) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const out = []
  for (let j = i + 1; j < argv.length; j++) {
    const tok = argv[j]
    if (tok.startsWith('--')) break
    for (const part of tok.split(',')) {
      const s = part.trim()
      if (s) out.push(s)
    }
  }
  return out
}

// Validate before writing: a malformed sweep record is worse than none, because
// it reads as measured. Exported so the test exercises the shipping predicate
// rather than a restatement of it.
export function sweepProblems(killed, total, survived) {
  const k = Number(killed)
  const t = Number(total)
  const problems = []
  if (!Number.isFinite(k) || k < 0) problems.push(`killed=${killed} is not a count`)
  if (!Number.isFinite(t) || t <= 0) problems.push(`total=${total} is not a positive count`)
  if (k > t) problems.push(`killed (${k}) > total (${t})`)
  // The survivor list is the whole point of recording a partial sweep: a bare
  // "14/15" does not say WHICH rule is unpinned, and that is the actionable
  // part. This one arithmetic check subsumes "gap but nothing named" and "no gap
  // but named": the list length must equal total - killed, exactly. Without it a
  // list of 1 is accepted for a gap of 8, and the record then reads "one rule
  // unpinned" when eight were. A count is checkable; trusting the caller to keep
  // two numbers in agreement is not.
  if (Number.isFinite(k) && Number.isFinite(t) && k <= t && survived.length !== t - k) {
    problems.push(
      `--survived names ${survived.length} id(s) but ${t} - ${k} = ${t - k} mutation(s) survived` +
      (survived.length ? ` (got: ${survived.join(', ')})` : ''),
    )
  }
  // A repeat inflates the list to the right length while naming fewer survivors
  // than there are — the length check alone would pass it.
  const dupes = survived.filter((s, i) => survived.indexOf(s) !== i)
  if (dupes.length) {
    problems.push(`--survived repeats id(s): ${[...new Set(dupes)].join(', ')}`)
  }
  return problems
}

// `dir` exists so the write path can be exercised against a throwaway ledger.
// It was untested until the split, because the only way to run it was to write
// to the real one — which is how a rewrite that dropped rows would have been
// found by losing them.
export function main(argv, dir = undefined) {
  const recordArg = arg(argv, 'record')
  const missionArg = arg(argv, 'mission')
  const command = arg(argv, 'command')
  const killed = arg(argv, 'killed')
  const total = arg(argv, 'total')
  const survived = argList(argv, 'survived') ?? []
  const dryRun = argv.includes('--dry-run')
  // 'authored' = a withheld set written per stage against the DoD's own rule
  // ids, so a survivor is a rule the mission claimed and did not pin — that
  // fails the mission. 'derived' = scripts/cynco-mutation-sweep.py mutating
  // whatever expressions the diff added, so a survivor is a coverage finding
  // instead. Both make the row MEASURED; only the first can fail it. Absent
  // means authored, which is what all 42 pre-existing sweeps are.
  const kind = arg(argv, 'kind') ?? 'authored'
  if (kind !== 'authored' && kind !== 'derived') {
    console.error(`--kind must be 'authored' or 'derived', got ${kind}`)
    return 2
  }

  if ((!recordArg && !missionArg) || !command || killed === undefined || total === undefined) {
    console.error('usage: --record N | --mission ID  --command "..." --killed K --total T [--survived a,b] [--kind authored|derived] [--dry-run]')
    return 2
  }

  // Across every shard, in record order, so `--record N` keeps meaning the Nth
  // mission ever run rather than the Nth in whichever file it happens to sit.
  const rows = dir === undefined ? readLedger() : readLedger(dir)

  let idx
  if (recordArg !== undefined) {
    idx = Number(recordArg) - 1
    if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) {
      console.error(`--record ${recordArg} out of range (ledger has ${rows.length} records)`)
      return 2
    }
  } else {
    idx = rows.findIndex((r) => r.missionId === missionArg)
    if (idx === -1) {
      console.error(`no record with missionId ${missionArg}`)
      return 2
    }
  }

  const problems = sweepProblems(killed, total, survived)
  if (problems.length) {
    for (const p of problems) console.error(`invalid: ${p}`)
    return 2
  }

  const k = Number(killed)
  const t = Number(total)
  const rec = rows[idx]
  const before = rec.mutationSweep
  rec.mutationSweep = kind === 'derived'
    ? { kind, command, killed: k, total: t, survived }
    : { command, killed: k, total: t, survived }

  console.log(`record #${idx + 1}  ${rec.missionId}`)
  console.log(`  briefFile : ${rec.briefFile}`)
  console.log(`  outcome   : ${rec.outcome}   verified: ${rec.verified}`)
  console.log(`  was       : ${JSON.stringify(before ?? null)}`)
  console.log(`  now       : ${JSON.stringify(rec.mutationSweep)}`)
  // Delegate to the scorer's own predicate instead of restating it here. This
  // line used to compute `killed === total` itself, which predates --kind: it
  // printed `accepted: false` for a derived sweep with survivors even though
  // labelOf() reads that same row as a success, because a derived survivor is a
  // coverage finding and not a rule the DoD claimed to own. A status line that
  // disagrees with the thing that actually scores the ledger is worse than no
  // status line — it invites re-running a sweep that already landed.
  const label = labelOf(rec)
  console.log(`  accepted  : ${label === null ? 'unlabeled' : label}`)

  if (dryRun) {
    console.log('--dry-run: nothing written')
    return 0
  }

  // Rewrite only the shard the edited record lives in. Rewriting all of them
  // would rewrite ~60 MB to change one field, and every byte rewritten is a
  // byte that can come back different.
  const shard = rec.__shard
  const out = rows.filter((r) => r.__shard === shard)
    .map((r) => JSON.stringify(r)).join('\n') + '\n'
  const tmp = shard + '.tmp'
  writeFileSync(tmp, out)
  renameSync(tmp, shard)
  console.log(`written → ${shard}`)
  return 0
}

// Only run the CLI when invoked as a script. Under vitest argv[1] is the test
// runner, so importing this module for its predicates must not touch the ledger.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv))
}
