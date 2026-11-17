// scripts/fix-doc-line-pins.mjs
// Repoint stale `file.ts:NNN` symbol references in the per-package CLAUDE.md files.
//
// The guard engine/__tests__/guards/packageDocs.test.ts checks that the symbol a doc names
// is on (or within LINE_SLACK of) the line it cites. Any edit that adds lines above a cited
// symbol breaks every pin below it. This script takes the guard's own list of misplaced refs,
// leaves alone the ones in the guard's baseline, finds each other symbol's current line (its
// definition; the occurrence nearest the old pin only when the file defines no such name) and
// rewrites the pin in the doc. Run from the repo root:
//
//   bun scripts/fix-doc-line-pins.mjs          # rewrite the docs
//   bun scripts/fix-doc-line-pins.mjs --dry    # only report
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { misplacedRefs, identifierOf, BASELINE_PATH } from '../engine/__tests__/guards/packageDocSymbolScan.mjs'

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

/**
 * How strong a claim one line makes to being where `ident` is defined: 3 an exported
 * declaration, 2 any other declaration, 1 a class member (a modifier before the name, or a
 * bare `name(...) {` that opens a body and is not a call taking a callback), 0 a use.
 */
function definitionRank(text, ident) {
  const id = escapeRe(ident)
  const decl = `(?:async\\s+)?(?:function\\*?|const|let|var|class|abstract\\s+class|type|interface|enum)\\s+${id}(?![\\w$])`
  if (new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:declare\\s+)?${decl}`).test(text)) return 3
  if (new RegExp(`^\\s*(?:declare\\s+)?${decl}`).test(text)) return 2
  const modifier = '(?:public|private|protected|static|readonly|async|override|abstract|get|set)'
  if (new RegExp(`^\\s*(?:${modifier}\\s+)+\\*?${id}(?![\\w$])`).test(text)) return 1
  if (new RegExp(`^\\s*${id}\\s*[(<].*\\{\\s*$`).test(text) && !/=>\s*\{\s*$/.test(text)) return 1
  return 0
}

/**
 * The line a pin for `ident` should name, in a file given as its lines; null when the name
 * is nowhere in it. The definition wins over any use, and among lines of equal standing the
 * one nearest the old pin wins. Nearest-occurrence alone was wrong after a large shift: with
 * 44 lines gone from bash.ts it moved a pin from 139 to a use at 148, past the definition
 * at 95 (2026-11-11).
 */
export function choosePinLine(lines, ident, old) {
  const word = new RegExp(`(^|[^\\w$])${escapeRe(ident)}([^\\w$]|$)`)
  let best = null
  let bestRank = -1
  for (let n = 1; n <= lines.length; n++) {
    const text = lines[n - 1]
    if (!word.test(text)) continue
    const rank = definitionRank(text, ident)
    if (rank > bestRank || (rank === bestRank && Math.abs(n - old) < Math.abs(best - old))) {
      best = n
      bestRank = rank
    }
  }
  return best
}

/**
 * A ref in the guard's baseline is one the guard already allows to be off. Moving it puts
 * it on another line that may be just as wrong (three were, 2026-11-11) and makes the
 * ratchet read it as fixed. It is reported and left where it is.
 */
export function splitBaselined(refs, baseline) {
  const allowed = new Set(baseline)
  return { todo: refs.filter((r) => !allowed.has(r)), skipped: refs.filter((r) => allowed.has(r)) }
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
  } catch (e) {
    console.log(`no baseline read from ${BASELINE_PATH} (${e instanceof Error ? e.message : String(e)}); every misplaced ref is treated as new`)
    return []
  }
}

function main() {
  const ROOT = process.cwd()
  const ENGINE = join(ROOT, 'engine')
  const dry = process.argv.includes('--dry')

  const { todo: refs, skipped } = splitBaselined(misplacedRefs(), readBaseline())
  for (const ref of skipped) console.log(`left alone (in the guard's baseline): ${ref}`)
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
    const best = choosePinLine(lines, identifierOf(sym), old)
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
