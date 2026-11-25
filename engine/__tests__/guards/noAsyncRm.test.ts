/**
 * No production file of the engine or the scripts deletes a tree with Node's asynchronous `fs.rm` or with
 * rimraf (F242; NOW.md, "What it does not cover": the asynchronous `fs.rm` can delete through a junction on
 * EPERM, and F5 measured only the synchronous form).
 *
 * The harness removes sandboxes and trees a contained run wrote with the listing-based walk that never
 * enters a link (`removeTreeNoFollow`, engine/containment.ts), and elsewhere with the synchronous
 * `rmSync`. A call of `fs.rm`, `fs.promises.rm` or `fs/promises`' `rm`, or an import of rimraf, would be
 * the unmeasured form; this guard fails on the first one, in any production file under engine/ or
 * scripts/ (the tests are not read: they name these forms as attack text for the path check).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** Each form, with the words a failure names it by. */
export const ASYNC_RM_FORMS: Array<{ re: RegExp; what: string }> = [
  { re: /\bfs\.rm\s*\(/, what: 'fs.rm(' },
  { re: /\bpromises\.rm\s*\(/, what: 'fs.promises.rm(' },
  { re: /\bfsp\.rm\s*\(/, what: 'fsp.rm(' },
  { re: /import\s*\{[^}]*\brm\b[^}]*\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/, what: 'an import of rm from fs or fs/promises' },
  { re: /require\(\s*['"](?:node:)?fs\/promises['"]\s*\)\s*\.rm\b/, what: "require('fs/promises').rm" },
  { re: /(?:from\s*|require\(\s*|import\(\s*)['"]rimraf['"]/, what: 'rimraf' },
]

/** The forms `text` uses, by name. */
export function asyncRmUses(text: string): string[] {
  return ASYNC_RM_FORMS.filter(f => f.re.test(text)).map(f => f.what)
}

const SOURCE = /\.(ts|mts|cts|mjs|cjs|js)$/
const SKIP_DIR = new Set(['node_modules', '__tests__', 'tests', 'dist', '.git'])

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) productionFiles(p, out) }
    else if (SOURCE.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) out.push(p)
  }
  return out
}

describe('no asynchronous fs.rm and no rimraf in the engine or the scripts (F242)', () => {
  it('the reader names each form, and passes the synchronous ones and the path check\'s attack tables', () => {
    expect(asyncRmUses("await fs.rm(dir, { recursive: true })")).toEqual(['fs.rm('])
    expect(asyncRmUses("await fs.promises.rm(dir, { recursive: true })")).toEqual(['fs.promises.rm('])
    expect(asyncRmUses("import { rm, mkdir } from 'node:fs/promises'")).toEqual(['an import of rm from fs or fs/promises'])
    expect(asyncRmUses("import { rm as remove } from 'fs'")).toEqual(['an import of rm from fs or fs/promises'])
    expect(asyncRmUses("await require('fs/promises').rm(p)")).toEqual(["require('fs/promises').rm"])
    expect(asyncRmUses("import { rimraf } from 'rimraf'")).toEqual(['rimraf'])
    expect(asyncRmUses("const r = require('rimraf')")).toEqual(['rimraf'])
    expect(asyncRmUses("rmSync(dir, { recursive: true }); fs.rmSync(x); rmdirSync(y)")).toEqual([])
    expect(asyncRmUses("import { rmSync, rmdirSync } from 'node:fs'")).toEqual([])
    expect(asyncRmUses("const DELETE_VERBS = new Set(['rm', 'rimraf']); const re = /\\brimraf(?:\\.sync|Sync)?\\s*\\(/g")).toEqual([])
  })

  it('no production file under engine/ or scripts/ uses one', () => {
    const files = [...productionFiles(join(ROOT, 'engine')), ...productionFiles(join(ROOT, 'scripts'))]
    expect(files.length).toBeGreaterThan(300)
    const found = files.flatMap(f => asyncRmUses(readFileSync(f, 'utf8')).map(w => `${relative(ROOT, f).replace(/\\/g, '/')}: ${w}`))
    expect(found, 'remove a run-written tree with the no-follow walk or rmSync, never the asynchronous fs.rm or rimraf').toEqual([])
  })
})
