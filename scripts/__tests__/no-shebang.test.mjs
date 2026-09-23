// Guard (F148): no shebang line in any scripts/*.mjs.
//
// vitest's hashbang stripping leaves a token V8 rejects when the shebang line
// ends in CRLF, so on a fresh Windows checkout (core.autocrlf=true) every suite
// that imports the module fails to load with a bare
// `SyntaxError: Invalid or unexpected token` — six suites did after the Phase 1
// merge. esbuild and node both accept the file; only the vitest transform
// breaks, and only on line 1. The scripts are always run with an explicit
// interpreter (`bun scripts/...`, `node scripts/...`), so the shebang buys
// nothing and costs the test suite. Bisected in docs/cynco-failure-log.md F148.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('..', import.meta.url))

describe('scripts/*.mjs carry no shebang (F148)', () => {
  it('no module under scripts/ starts with #!', () => {
    const offenders = readdirSync(scripts).filter(f => f.endsWith('.mjs'))
      .filter(f => readFileSync(join(scripts, f), 'utf8').startsWith('#!'))
    expect(offenders, 'run them as `bun scripts/<name>.mjs`; a shebang + CRLF breaks vitest on Windows').toEqual([])
  })
})
