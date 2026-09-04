/**
 * Every engine package with three or more source files carries a CLAUDE.md:
 * purpose, key files, the important types/functions with file:line refs, and
 * gotchas — the form Quartermaster keeps per package. A doc that names a file
 * or line that no longer exists is worse than none, so this guard checks every
 * `name.ts:NNN` reference resolves to a real file with at least that many
 * lines, and that the root AGENTS.md links every package doc.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const ENGINE = join(process.cwd(), 'engine')
const MIN_SOURCE_FILES = 3
const SKIP = new Set(['__tests__', 'cybernetics-core']) // cybernetics-core carries its own README

function sourceCount(dir: string): number {
  return readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')).length
}

const packages = readdirSync(ENGINE)
  .filter(d => !SKIP.has(d) && statSync(join(ENGINE, d)).isDirectory() && sourceCount(join(ENGINE, d)) >= MIN_SOURCE_FILES)
  .sort()

describe('per-package CLAUDE.md', () => {
  it(`covers every engine package with >= ${MIN_SOURCE_FILES} source files`, () => {
    const missing = packages.filter(p => !existsSync(join(ENGINE, p, 'CLAUDE.md')))
    expect(missing, `packages without CLAUDE.md: ${missing.join(', ')}`).toEqual([])
  })

  for (const p of packages) {
    const doc = join(ENGINE, p, 'CLAUDE.md')
    it.skipIf(!existsSync(doc))(`${p}/CLAUDE.md: every file:line reference resolves`, () => {
      const text = readFileSync(doc, 'utf-8')
      const refs = [...text.matchAll(/`?([A-Za-z0-9_./-]+\.ts):(\d+)`?/g)]
      expect(refs.length, 'a package doc with no file:line refs is prose, not a map').toBeGreaterThan(0)
      const bad: string[] = []
      for (const [, file, line] of refs) {
        const path = file.includes('/') ? join(process.cwd(), file) : join(ENGINE, p, file)
        if (!existsSync(path)) { bad.push(`${file}:${line} (missing file)`); continue }
        const lines = readFileSync(path, 'utf-8').split('\n').length
        if (Number(line) > lines) bad.push(`${file}:${line} (file has ${lines} lines)`)
      }
      expect(bad, `stale refs: ${bad.join(', ')}`).toEqual([])
      for (const section of ['## Purpose', '## Key files', '## Gotchas']) expect(text).toContain(section)
    })
  }

  it('root AGENTS.md links every package doc', () => {
    const root = join(process.cwd(), 'AGENTS.md')
    expect(existsSync(root)).toBe(true)
    const text = readFileSync(root, 'utf-8')
    const unlinked = packages.filter(p => !text.includes(`engine/${p}/CLAUDE.md`))
    expect(unlinked, `AGENTS.md does not link: ${unlinked.join(', ')}`).toEqual([])
  })
})
