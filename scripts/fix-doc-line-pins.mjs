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
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { misplacedRefs, identifierOf, onLine } from '../engine/__tests__/guards/packageDocSymbolScan.mjs'

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * Rewrite every `file:line` and `file:A-B` pin in `text` in ONE pass. `map` is keyed
 * `"file:old"` -> new line number. Each token is looked up once and the output is never
 * re-scanned, so a pin rewritten 12->19 cannot be caught again by a 19->25 key (two pins on
 * one line used to collapse to the same number). A range maps both ends; when only one end
 * has a key, the other end moves by the same delta.
 */
export function rewritePins(text, map) {
  if (map.size === 0) return text
  const files = [...new Set([...map.keys()].map((k) => k.slice(0, k.lastIndexOf(':'))))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
  const re = new RegExp(`(?<![\\w./-])(${files.join('|')}):(\\d+)(?:-(\\d+))?(?!\\d)`, 'g')
  return text.replace(re, (whole, file, aStr, bStr) => {
    const a = Number(aStr)
    const na = map.get(`${file}:${a}`)
    if (bStr === undefined) return na === undefined ? whole : `${file}:${na}`
    const b = Number(bStr)
    const nb = map.get(`${file}:${b}`)
    if (na === undefined && nb === undefined) return whole
    const newA = na ?? a + (nb - b)
    const newB = nb ?? b + (na - a)
    return `${file}:${newA}-${newB}`
  })
}

function main() {
  const ROOT = process.cwd()
  const ENGINE = join(ROOT, 'engine')
  const dry = process.argv.includes('--dry')

  const refs = misplacedRefs()
  if (refs.length === 0) { console.log('no misplaced refs'); return 0 }

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
    const text = rewritePins(readFileSync(docPath, 'utf-8'), map)
    if (!dry) writeFileSync(docPath, text, 'utf-8')
  }
  console.log(`${refs.length} refs, ${unresolved} unresolved${dry ? ' (dry run, nothing written)' : ''}`)
  return unresolved ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main())
}
