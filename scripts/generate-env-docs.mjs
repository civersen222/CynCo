#!/usr/bin/env bun
/**
 * Write the full LOCALCODE_* inventory into README.md, between the markers.
 *
 *   bun scripts/generate-env-docs.mjs          # rewrite the block
 *   bun scripts/generate-env-docs.mjs --check  # exit 1 if the block is stale
 *
 * The README's configuration table used to be maintained by hand and had drifted
 * from the code it described — a documented default of `ollama` against a coded
 * default of `llama-cpp`, a "required" variable that had not been required in
 * months, and 23 of 62 variables listed. The hand-written table above the block
 * survives, because a curated shortlist with real prose is worth having; what
 * moved into the generator is the part a machine can check.
 *
 * `engine/__tests__/guards/configTableMatchesTheCode.test.ts` makes the same
 * comparison in-process, so a variable added without regenerating fails the
 * suite. `--check` is here for a pre-commit hook or CI step that would rather
 * not boot vitest.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { renderInventory, readmeInventory, repoRoot, BEGIN, END } from '../engine/__tests__/guards/envVarScan.mjs'

const check = process.argv.includes('--check')
const readmePath = join(repoRoot, 'README.md')
const current = readmeInventory()
const wanted = renderInventory()

if (current === null) {
  console.error(`README.md has no generated block. Add these two markers where the table belongs:\n  ${BEGIN}\n  ${END}`)
  process.exit(1)
}

if (current === wanted) {
  console.log('README env inventory is current.')
  process.exit(0)
}

if (check) {
  console.error('README env inventory is stale. Run: bun scripts/generate-env-docs.mjs')
  process.exit(1)
}

// Read and write through the same string form so a CRLF checkout is not
// rewritten wholesale into LF, which would bury the real change in a diff of
// every line in the file.
const raw = readFileSync(readmePath, 'utf-8')
const crlf = raw.includes('\r\n')
const lf = crlf ? raw.split('\r\n').join('\n') : raw
const next = lf.replace(current, wanted)
writeFileSync(readmePath, crlf ? next.split('\n').join('\r\n') : next, 'utf-8')
console.log(`README env inventory regenerated (${wanted.split('\n').filter(l => l.startsWith('| `LOCALCODE')).length} variables).`)
