import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
// @ts-expect-error — plain .mjs helper, shared with scripts/generate-env-docs.mjs
import { scanEnvVars, renderInventory, readmeInventory, repoRoot, BEGIN, END } from './envVarScan.mjs'

/**
 * The configuration section of the README must describe the code that is here.
 *
 * It did not. Three separate contradictions, each of which sent a new user
 * somewhere the engine would not follow:
 *
 *  - `LOCALCODE_PROVIDER` was documented as defaulting to `ollama`. `config.ts`
 *    coalesced to `llama-cpp`, and read no profile at all, so the Ollama Quick
 *    Start — which sets no environment anywhere — started the llama.cpp direct
 *    provider and looked for a GGUF that nothing had downloaded.
 *  - `LOCALCODE_MODEL` was marked *required*. It resolves from the profile, and
 *    since the bundled-profile fix it resolves on a fresh clone with no
 *    environment at all.
 *  - "All config via environment variables. No config files required." The
 *    engine loads a YAML profile between the environment and the built-in
 *    defaults, and for most fields that profile is where the value comes from.
 *
 * And the table listed 23 of the 65 variables the engine reads.
 *
 * The response is not a better-maintained table. A hand-written statement of a
 * machine-checkable fact decays the moment someone adds a variable in a hurry,
 * and nothing in the suite notices. So the shortlist stays — curated prose is
 * worth having — and everything a machine can check is checked here:
 *
 *  1. The generated inventory in the README is current (test 2).
 *  2. Nothing in the shortlist has been deleted from the code (test 3).
 *  3. Every default the shortlist states matches the value the engine would
 *     actually use, resolved through the same layers the engine resolves
 *     through: profile first, built-in fallback second (test 4).
 *
 * (3) is the check that would have caught the original finding.
 */

type ScanEntry = { defaults: string[]; profileKeys: string[]; files: string[] }

const vars: Record<string, ScanEntry> = scanEnvVars()
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8').split('\r\n').join('\n')

/** The profile a fresh clone gets, read off disk — not through `loadProfile`, */
/** which would return whatever the developer running the suite has in ~/.cynco. */
const shipped = parseYaml(
  readFileSync(join(repoRoot, 'engine', 'profiles', 'templates', 'default.yaml'), 'utf-8'),
) as Record<string, unknown>

/** Rows of the hand-written shortlist: `| \`NAME\` | default | purpose |`. */
function curatedRows(): { name: string; def: string }[] {
  const start = readme.indexOf('| Variable | Default | Purpose |')
  if (start === -1) return []
  const end = readme.indexOf('### Full inventory', start)
  const block = readme.slice(start, end === -1 ? undefined : end)
  return [...block.matchAll(/^\|\s*`(LOCALCODE_[A-Z0-9_]+)`\s*\|([^|]*)\|/gm)]
    .map(m => ({ name: m[1]!, def: m[2]!.trim() }))
}

/**
 * What the engine would use for this variable with nothing set — resolved the
 * way `config.ts` resolves it: the shipped profile's value if it names one,
 * otherwise the built-in literal.
 *
 * Returns null when the scan derived neither, which means "not checkable here",
 * not "no default". Asserting against a value nobody measured is the habit that
 * produced the finding.
 */
function effectiveDefault(name: string): string | null {
  const entry = vars[name]
  if (!entry) return null
  for (const key of entry.profileKeys) {
    if (shipped[key] != null) return String(shipped[key])
  }
  return entry.defaults.length === 1 ? entry.defaults[0]! : null
}

describe('the README configuration section describes this code', () => {
  it('the scan finds the variables it is supposed to find', () => {
    // Guards the guard. Every assertion below is over `vars` or over rows keyed
    // by it; a scanner that silently returned {} would make all of them pass.
    expect(Object.keys(vars).length).toBeGreaterThan(40)
    expect(Object.keys(vars)).toContain('LOCALCODE_MODEL')
    expect(vars['LOCALCODE_PROVIDER']!.defaults).toEqual(['llama-cpp'])
    // Read through a helper (`envInt('...')`), not `process.env.X`. If the
    // scanner loses this shape it reports three documented variables as
    // nonexistent and fails the next test on its own blind spot.
    expect(Object.keys(vars)).toContain('LOCALCODE_UBATCH_SIZE')
  })

  it('the generated inventory in README.md is current', () => {
    const current = readmeInventory()
    expect(
      current,
      `README.md is missing the generated block. Put these markers where the inventory belongs:\n${BEGIN}\n${END}`,
    ).not.toBeNull()
    expect(
      current,
      'the README env inventory is stale — a variable was added, removed, or its default changed ' +
        'without the docs following. Run: bun scripts/generate-env-docs.mjs',
    ).toBe(renderInventory())
  })

  it('every variable in the shortlist still exists in the code', () => {
    const rows = curatedRows()
    expect(rows.length, 'the shortlist table moved or changed shape').toBeGreaterThan(10)
    const phantom = rows.filter(r => vars[r.name] == null).map(r => r.name)
    expect(
      phantom,
      `documented but never read by the engine: ${phantom.join(', ')}. A row for a variable that ` +
        'does nothing is worse than no row — it sends a user to set something and wait for an ' +
        'effect that cannot arrive.',
    ).toEqual([])
  })

  it('every default the shortlist states is the default the engine would use', () => {
    const rows = curatedRows()
    const wrong: string[] = []
    for (const { name, def } of rows) {
      const effective = effectiveDefault(name)
      if (effective === null) continue // not derivable — see effectiveDefault
      if (!def.includes(effective)) wrong.push(`${name}: README says "${def}", code resolves to "${effective}"`)
    }
    expect(
      wrong,
      'the configuration table contradicts the code:\n  ' + wrong.join('\n  '),
    ).toEqual([])

    // Non-vacuity: `continue` above skips anything not derivable, so a scan that
    // derived nothing would leave `wrong` empty and pass. Several of these rows
    // must actually have been compared.
    const compared = rows.filter(r => effectiveDefault(r.name) !== null).length
    expect(compared, 'no shortlist row had a derivable default, so nothing was compared').toBeGreaterThan(5)
  })

  it('the section does not claim configuration is environment-only', () => {
    // The engine loads YAML profiles. It always did; the claim was never true,
    // and it is the reason a user who hit an unexpected model had nowhere to
    // look. Removing the claim is not enough — the precedence has to be stated,
    // or the next reader infers environment-only from the table's shape.
    expect(readme).not.toContain('No config files required')
    const section = readme.slice(readme.indexOf('## Configuration'), readme.indexOf('### Full inventory'))
    expect(section).toContain('.cynco/profiles/')
    expect(section).toContain('LOCALCODE_PROFILE')
  })
})
