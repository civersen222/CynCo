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
import { misplacedRefs, identifierOf, onLine, LINE_SLACK, BASELINE_PATH } from './packageDocSymbolScan.mjs'

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

  // M1 (Phase 4 final review): the length check above passes a ref that points
  // at the wrong line. For the doc's own `Sym` (`file.ts:N`) form, the symbol
  // must be on (or within LINE_SLACK of) line N. Pre-existing misplaced refs
  // are a ratchet baseline, like the empty-catch one: none may be added, and a
  // fixed one must leave the baseline.
  it('symbol refs: the named symbol is on the named line (ratchet)', () => {
    const baseline: string[] = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
    const now = misplacedRefs()
    const added = now.filter(r => !baseline.includes(r))
    expect(added, `symbol not on its line (±${LINE_SLACK}) — fix the line number:\n${added.join('\n')}`).toEqual([])
    const fixed = baseline.filter(r => !now.includes(r))
    expect(fixed, `ratchet down — regenerate with \`bun engine/__tests__/guards/packageDocSymbolScan.mjs --write\`:\n${fixed.join('\n')}`).toEqual([])
  })

  it('symbol-ref scan: identifier extraction and line slack', () => {
    expect(identifierOf('ConversationLoop.handleUserMessage')).toBe('handleUserMessage')
    expect(identifierOf('enforced = isEnforced(isS5EnforcementEnabled(), authority)')).toBe('isEnforced')
    expect(identifierOf('listProfiles()')).toBe('listProfiles')
    const lines = ['a', 'b', 'export function foo() {', 'c', 'd', 'e', 'f']
    expect(onLine(lines, 3, 'foo')).toBe(true)
    expect(onLine(lines, 5, 'foo')).toBe(true)
    expect(onLine(lines, 6, 'foo')).toBe(false)
    expect(onLine(['const foobar = 1'], 1, 'foo')).toBe(false)
  })

  it('root AGENTS.md links every package doc', () => {
    const root = join(process.cwd(), 'AGENTS.md')
    expect(existsSync(root)).toBe(true)
    const text = readFileSync(root, 'utf-8')
    const unlinked = packages.filter(p => !text.includes(`engine/${p}/CLAUDE.md`))
    expect(unlinked, `AGENTS.md does not link: ${unlinked.join(', ')}`).toEqual([])
  })
})
