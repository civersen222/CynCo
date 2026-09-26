import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Phase 5 Task 3, review I2: GET /api/campaign (engine/dashboard/server.ts)
 * loads scripts/cynco-scoreboard.mjs to pool the campaign boards. That route's
 * rule (getCampaign's doc comment) is that a GET carries NO write path — which
 * is why it reads state.json by hand instead of using CampaignState. The rule
 * was a comment; this makes it a test. CynCo missions edit scripts/, so the
 * module must stay pure: it imports nothing outside the allowed list below
 * (today: nothing at all) and names no write, spawn or network call.
 */
const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '../../..')
const MODULE = join(ROOT, 'scripts', 'cynco-scoreboard.mjs')
const SERVER = join(ROOT, 'engine', 'dashboard', 'server.ts')

/** Pure modules the scoreboard may import. Empty today; adding one is a
 *  reviewed decision, made here, with the reason beside it. */
const ALLOWED_IMPORTS: string[] = []

const src = readFileSync(MODULE, 'utf-8')

describe('scripts/cynco-scoreboard.mjs stays pure (the dashboard route loads it)', () => {
  it('imports only the allowed pure modules', () => {
    const specifiers = [
      ...[...src.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]),
      ...[...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map(m => m[1]),
      ...[...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
      ...[...src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ]
    expect(specifiers.filter(s => !ALLOWED_IMPORTS.includes(s))).toEqual([])
    // No computed dynamic import or require either.
    expect(src).not.toMatch(/\bimport\s*\(\s*[^'"\s]/)
    expect(src).not.toMatch(/\brequire\s*\(/)
  })

  it('names no write, spawn, exec or network call', () => {
    for (const token of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'spawn', 'fetch']) {
      expect({ token, found: src.includes(token) }).toEqual({ token, found: false })
    }
    // `exec` as a call, not RegExp.prototype.exec (`/…/.exec(text)` is pure
    // and the module parses the economics text that way).
    expect(src).not.toMatch(/(?<![.\w])exec(Sync|File|FileSync)?\s*\(/)
  })

  it('the guard itself bites: a planted write is caught', () => {
    const planted = src + "\nimport { writeFileSync } from 'fs'\n"
    const specs = [...planted.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[1])
    expect(specs).toContain('fs')
    expect(planted.includes('writeFileSync')).toBe(true)
  })

  it('the server loads it lazily inside the route, never at module load', () => {
    const server = readFileSync(SERVER, 'utf-8')
    expect(server).not.toMatch(/^\s*import\s[^;]*?from\s*['"][^'"]*scripts\/cynco-scoreboard\.mjs['"]/m)
    expect(server).toMatch(/import\(\s*'\.\.\/\.\.\/scripts\/cynco-scoreboard\.mjs'\s*\)/)
  })
})
