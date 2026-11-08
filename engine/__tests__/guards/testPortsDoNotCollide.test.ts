import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * GLM review T7 (docs/reviews/2026-11-06-glm5-engineering-review-triage.md).
 *
 * `vitest.config.ts` sets no `pool`/`fileParallelism`, so test files run in
 * parallel workers. A test that binds a literal port therefore shares that
 * port with every other file that picked the same number, and the bridge and
 * dashboard servers both *walk* to the next free port when theirs is taken —
 * so the loser does not fail loudly, it connects its client to a number the
 * server is no longer on and waits out a 5 s timeout. The hand-kept registry
 * in comments ("19171-19173 so parallel workers never collide") slipped twice:
 * 19171 in `bridge/server.test.ts` and `dashboard/security.test.ts`, 19191 in
 * `dashboard/dashboardCommand.test.ts` and `dashboard/server.test.ts`.
 *
 * The cure is `port: 0` and reading the bound port back (`getPort()` /
 * `server.port`); the few tests that must name a port (the port-walking
 * tests, which squat a number on purpose) may keep one, as long as no other
 * file names the same one. This guard pins that: every literal port in the
 * 19xxx test range belongs to at most one file.
 */

const TESTS = join(process.cwd(), 'engine', '__tests__')
const TEST_PORT = /\b19\d{3}\b/g

/** Code only: a port named in a comment binds nothing. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...testFiles(p))
    else if (name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('test ports are not shared between files (T7)', () => {
  it('every literal 19xxx port appears in at most one test file', () => {
    const owners = new Map<string, Set<string>>()
    for (const file of testFiles(TESTS)) {
      const text = withoutComments(readFileSync(file, 'utf-8'))
      for (const m of text.matchAll(TEST_PORT)) {
        const port = m[0]
        if (!owners.has(port)) owners.set(port, new Set())
        owners.get(port)!.add(relative(process.cwd(), file).replace(/\\/g, '/'))
      }
    }
    const shared = [...owners.entries()]
      .filter(([, files]) => files.size > 1)
      .map(([port, files]) => `${port}: ${[...files].sort().join(', ')}`)
      .sort()
    expect(
      shared,
      'these ports are bound by more than one test file; use `port: 0` and read the bound port back, ' +
        'or pick a number no other file uses:\n' + shared.join('\n'),
    ).toEqual([])
  })
})
