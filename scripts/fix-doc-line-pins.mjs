#!/usr/bin/env bun
// scripts/fix-doc-line-pins.mjs
// Repoint stale `file.ts:NNN` symbol references in the per-package CLAUDE.md files.
//
// The guard engine/__tests__/guards/packageDocs.test.ts checks that the symbol a doc names
// is on (or within LINE_SLACK of) the line it cites. Any edit that adds lines above a cited
// symbol breaks every pin below it. This script takes the guard's own list of misplaced refs,
// finds each symbol's current line (nearest occurrence to the old pin, same identifier rules
// as the guard), and rewrites the pin in the doc. Run from the repo root:
//
//   bun scripts/fix-doc-line-pins.mjs          # rewrite the docs
//   bun scripts/fix-doc-line-pins.mjs --dry    # only report
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { misplacedRefs, identifierOf, onLine } from '../engine/__tests__/guards/packageDocSymbolScan.mjs'

const ROOT = process.cwd()
const ENGINE = join(ROOT, 'engine')
const dry = process.argv.includes('--dry')

const refs = misplacedRefs()
if (refs.length === 0) { console.log('no misplaced refs'); process.exit(0) }

const edits = new Map() // docPath -> Map<"file:old", new>
let unresolved = 0
for (const ref of refs) {
  const m = /^(.+?\/CLAUDE\.md): (.+) @ (.+?):(\d+)$/.exec(ref)
  if (!m) { console.log(`cannot parse: ${ref}`); unresolved++; continue }
  const [, doc, sym, file, oldStr] = m
  const old = Number(oldStr)
  const pkgDir = join(ENGINE, doc.replace(/\/CLAUDE\.md$/, ''))
  const target = file.includes('/') ? join(ROOT, file) : join(pkgDir, file)
  if (!existsSync(target)) { console.log(`missing file for ${ref}`); unresolved++; continue }
  const lines = readFileSync(target, 'utf-8').split('\n')
  const ident = identifierOf(sym)
  let best = null
  for (let n = 1; n <= lines.length; n++) {
    if (!onLine(lines, n, ident)) continue
    // onLine tolerates slack; pick the line where the identifier itself appears
    if (!lines[n - 1].includes(ident)) continue
    if (best === null || Math.abs(n - old) < Math.abs(best - old)) best = n
  }
  if (best === null) { console.log(`symbol not found: ${ref}`); unresolved++; continue }
  const docPath = join(pkgDir, 'CLAUDE.md')
  if (!edits.has(docPath)) edits.set(docPath, new Map())
  const key = `${file}:${old}`
  const prev = edits.get(docPath).get(key)
  if (prev !== undefined && prev !== best) console.log(`conflict in ${doc}: ${key} -> ${prev} and ${best} (${sym}); keeping ${prev}`)
  else edits.get(docPath).set(key, best)
  console.log(`${doc}: ${sym} ${file}:${old} -> :${best}`)
}

for (const [docPath, map] of edits) {
  let text = readFileSync(docPath, 'utf-8')
  for (const [key, line] of map) {
    const [file, old] = key.split(':')
    const re = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:${old}(?!\\d)`, 'g')
    text = text.replace(re, `${file}:${line}`)
  }
  if (!dry) writeFileSync(docPath, text, 'utf-8')
}
console.log(`${refs.length} refs, ${unresolved} unresolved${dry ? ' (dry run, nothing written)' : ''}`)
process.exit(unresolved ? 1 : 0)
