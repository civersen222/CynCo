import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * The README's "Local tokens" section counts the dashboard's send allowlist in
 * words: "an allowlist of nine frame types and fifteen slash commands". The
 * code is the allowlist (`DASHBOARD_ALLOWED_TYPES` / `DASHBOARD_ALLOWED_SLASH`
 * in `engine/dashboard/server.ts`); the sentence is a claim about it, and
 * drifted to "nine" after `project.open` and `ui.action` made it eleven (GLM
 * review S9, docs/reviews/2026-11-06-glm5-engineering-review-triage.md).
 *
 * A security paragraph that understates what a browser may send is worse than
 * none, so the number is pinned to the set it describes.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8')
const server = readFileSync(join(repoRoot, 'engine', 'dashboard', 'server.ts'), 'utf-8')

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
}

/** Number of quoted entries in `const <name>: ReadonlySet<unknown> = new Set([ ... ])`. */
function setSize(name: string): number {
  const m = server.match(new RegExp(`const ${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  if (!m) throw new Error(`${name} not found in engine/dashboard/server.ts — the guard is stale`)
  const body = m[1]!.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  return (body.match(/'[^']+'/g) ?? []).length
}

describe('the README counts the dashboard send allowlist the code enforces', () => {
  const claim = readme.match(/allowlist of (\w+) frame types and (\w+) slash commands/)

  it('the README still makes the claim', () => {
    expect(claim, 'no "allowlist of N frame types and M slash commands" sentence in README.md — reword this guard with it').not.toBeNull()
  })

  it('frame types', () => {
    const said = WORDS[claim![1]!]
    expect(said, `"${claim![1]}" is not a number word this guard knows`).toBeDefined()
    expect(said).toBe(setSize('DASHBOARD_ALLOWED_TYPES'))
  })

  it('slash commands', () => {
    const said = WORDS[claim![2]!]
    expect(said, `"${claim![2]}" is not a number word this guard knows`).toBeDefined()
    expect(said).toBe(setSize('DASHBOARD_ALLOWED_SLASH'))
  })
})
