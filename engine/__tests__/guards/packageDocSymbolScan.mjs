// Symbol-on-line scan for the per-package CLAUDE.md docs (Phase 4 final
// review, M1). packageDocs.test.ts already checks that every `file.ts:N` ref
// names a real file with at least N lines — which a ref pointing at the wrong
// line passes. This scan checks the doc's own `Sym` (`file.ts:N`) form (also
// **`Sym`** (`file.ts:N`)): the last identifier of `Sym` (before any call
// parens) must appear within LINE_SLACK lines of N, allowing for decorators,
// JSDoc-free export lines and a signature wrapped over two lines. Bare refs
// (no symbol in front) are left to the length check.
//
//   bun engine/__tests__/guards/packageDocSymbolScan.mjs --write
//
// regenerates packageDocSymbolBaseline.json (the ratchet's allowance) — only
// after fixing refs, never to admit a new wrong one.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..', '..', '..')
const ENGINE = join(ROOT, 'engine')
const SKIP = new Set(['__tests__', 'cybernetics-core'])
export const LINE_SLACK = 2
export const BASELINE_PATH = join(here, 'packageDocSymbolBaseline.json')

/** `Sym` (`file.ts:N`) and **`Sym`** (`file.ts:N`), an optional `-M` range end. */
const SYMBOL_REF = /`([^`\n]+)`\*{0,2}\s*\(`([A-Za-z0-9_./-]+\.ts):(\d+)(?:-\d+)?`/g

/** The identifier a ref must find on its line: the last one before any call parens. */
export function identifierOf(sym) {
  const ids = sym.split('(')[0].match(/[A-Za-z_$][\w$]*/g)
  return ids ? ids[ids.length - 1] : null
}

/** Does `ident` appear on line `n` (1-based) of `lines`, give or take LINE_SLACK? */
export function onLine(lines, n, ident) {
  const word = new RegExp(`(^|[^\\w$])${ident.replace(/\$/g, '\\$')}([^\\w$]|$)`)
  for (let i = Math.max(1, n - LINE_SLACK); i <= Math.min(lines.length, n + LINE_SLACK); i++) {
    if (word.test(lines[i - 1])) return true
  }
  return false
}

function packages() {
  return readdirSync(ENGINE)
    .filter(d => !SKIP.has(d) && statSync(join(ENGINE, d)).isDirectory() && existsSync(join(ENGINE, d, 'CLAUDE.md')))
    .sort()
}

/** Every symbol ref whose symbol is not on (or near) its line, as `<pkg>/CLAUDE.md: Sym @ file.ts:N`. */
export function misplacedRefs() {
  const out = []
  for (const p of packages()) {
    const text = readFileSync(join(ENGINE, p, 'CLAUDE.md'), 'utf-8')
    for (const [, sym, file, line] of text.matchAll(SYMBOL_REF)) {
      const ident = identifierOf(sym)
      if (!ident) continue
      const path = file.includes('/') ? join(ROOT, file) : join(ENGINE, p, file)
      // A missing file is packageDocs.test.ts's finding, not this one.
      if (!existsSync(path)) continue
      const lines = readFileSync(path, 'utf-8').split('\n')
      if (!onLine(lines, Number(line), ident)) out.push(`${p}/CLAUDE.md: ${sym} @ ${file}:${line}`)
    }
  }
  return [...new Set(out)].sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv.includes('--write')) {
  const refs = misplacedRefs()
  writeFileSync(BASELINE_PATH, JSON.stringify(refs, null, 2) + '\n')
  console.log(`Baseline written: ${refs.length} misplaced symbol refs`)
}
