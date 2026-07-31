import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

// Regression origin: `scripts/cynco-ledger-sweep.mjs` began `#!/usr/bin/env bun`
// and `engine/__tests__/harness/ledgerSweep.test.ts` imports it. Vite's module
// pipeline strips a `#!...\n` shebang but not a `#!...\r\n` one, so on any
// checkout with CRLF line endings — which is every fresh clone on Windows,
// where `core.autocrlf=true` is the Git default — the import died with
// `SyntaxError: Invalid or unexpected token` and the whole test file reported
// `(0 test)`.
//
// Two things make that worse than an ordinary broken test. First, its tests are
// not counted, so the summary line reads `Tests 3030 passed` and looks green —
// a failed SUITE is easy to read straight past. Second, of all the files to
// lose, that one is the regression suite for the honesty of the mutation-sweep
// numbers, in a project whose claim is rigorous measurement.
//
// It was also invisible from a long-lived working tree: a clone made before
// autocrlf, or on Linux, has LF and passes. The defect lived in the checkout,
// not in the source. So the guard cannot be "the file parses here" — it has to
// be the property that made it conditional at all.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const testsRoot = join(repoRoot, 'engine', '__tests__')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.mjs')) out.push(p)
  }
  return out
}

/**
 * Does `source` open with a shebang?
 *
 * Split out and specified below on literal strings. No file in the repo has a
 * shebang once this guard passes, so the scan below only ever sees negatives —
 * and a detector that is never shown a positive is a detector nothing measures.
 */
function hasShebang(source: string): boolean {
  return source.startsWith('#!')
}

/** Every `.mjs` a test file imports, resolved to an absolute path. */
function mjsImportedByTests(): { module: string; importer: string }[] {
  const found: { module: string; importer: string }[] = []
  for (const file of walk(testsRoot)) {
    const src = readFileSync(file, 'utf-8')
    for (const m of src.matchAll(/from\s+'([^']+\.mjs)'/g)) {
      found.push({ module: resolve(dirname(file), m[1]), importer: file })
    }
  }
  return found
}

describe('a test-imported .mjs must survive collection', () => {
  it('detects a shebang, and only at the start of the file', () => {
    expect(hasShebang('#!/usr/bin/env bun\nexport const x = 1\n')).toBe(true)
    expect(hasShebang('#!/usr/bin/env bun\r\nexport const x = 1\r\n')).toBe(true)
    expect(hasShebang('#!')).toBe(true)
    expect(hasShebang('// a comment\nexport const x = 1\n')).toBe(false)
    expect(hasShebang('')).toBe(false)
    // A `#!` further in is a string or a comment, not an interpreter line.
    expect(hasShebang("const s = '#!/usr/bin/env bun'\n")).toBe(false)
    expect(hasShebang('\n#!/usr/bin/env bun\n')).toBe(false)
    expect(hasShebang('#/usr/bin/env bun\n')).toBe(false)
  })

  it('finds the .mjs modules the test suite imports', () => {
    // Guards the guard: if the scan silently found nothing — a moved directory,
    // a changed quote style — every assertion below would pass vacuously.
    expect(mjsImportedByTests().length).toBeGreaterThan(0)
  })

  it('none of them carries a shebang', () => {
    const offenders: string[] = []
    for (const { module, importer } of mjsImportedByTests()) {
      if (hasShebang(readFileSync(module, 'utf-8'))) {
        offenders.push(
          `${module.slice(repoRoot.length + 1)} (imported by ${importer.slice(repoRoot.length + 1)})`,
        )
      }
    }
    expect(
      offenders,
      'A shebang on a test-imported module fails collection under CRLF, and a failed\n' +
        'suite reports (0 test) rather than a failure. Move the CLI entry point out, or\n' +
        'drop the shebang and invoke with `bun <path>`:\n' + offenders.join('\n'),
    ).toEqual([])
  })
})
