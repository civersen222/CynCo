import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

// Phase 4: one proposal registry. A seat's authority and a campaign's cap
// overrides are the only parameters the campaign may change about itself, and
// every change must pass through `applyProposalDecision` in
// scripts/cynco-proposals.mjs — the one place that refuses identity-targeting
// proposals and asserts identity before an approval. A second writer anywhere
// else is a second door around those checks, and nothing would say so.
//
// Two files are allowed:
//   - cynco-proposals.mjs          the registry itself (and the seats store)
//   - cynco-campaign-state.mjs     adoptExternalDecisions' monotonic merge of a
//                                  decision a SECOND process already made
//                                  through the registry

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const scriptsDir = join(repoRoot, 'scripts')

const ALLOWED = new Set(['cynco-proposals.mjs', 'cynco-campaign-state.mjs'])

const ASSIGN = /\.(invariantOverrides|ideationAuthority|gateAuthorAuthority)\s*=(?![=>])/
const SEATS = /seats\.json|SEATS_PATH/
const WRITE = /writeFileSync|renameSync/
const SEATS_WINDOW = 8

/** Every line in `src` that assigns a registry field or writes the seats store. */
function writerLines(src: string): string[] {
  const lines = src.split(/\r?\n/)
  const out: string[] = []
  // The seats store path and the write that uses it are rarely on one line
  // (`const path = SEATS_PATH(home)` … `writeFileSync(tmp, …)`), so a write is
  // counted as a seats write when the store is named within SEATS_WINDOW lines
  // of it. A file that merely mentions seats.json in a far-off comment is not.
  const nearSeats = (i: number) => lines.slice(Math.max(0, i - SEATS_WINDOW), i + SEATS_WINDOW + 1).some(x => SEATS.test(x))
  lines.forEach((l, i) => {
    if (ASSIGN.test(l)) out.push(`${i + 1}: ${l.trim()}`)
    else if (WRITE.test(l) && nearSeats(i)) out.push(`${i + 1}: ${l.trim()}`)
  })
  return out
}

/** The files (by basename) outside ALLOWED that contain a writer line. */
function strayWriters(files: { name: string; src: string }[]): string[] {
  const out: string[] = []
  for (const { name, src } of files) {
    if (ALLOWED.has(name)) continue
    for (const l of writerLines(src)) out.push(`${name}:${l}`)
  }
  return out
}

describe('the matcher', () => {
  it('flags a stray authority assignment outside the registry', () => {
    const fixture = [{ name: 'cynco-rogue.mjs', src: 'export function promote(s) {\n  s.ideationAuthority = 1\n}\n' }]
    expect(strayWriters(fixture)).toEqual(['cynco-rogue.mjs:2: s.ideationAuthority = 1'])
  })
  it('flags every registry field and a seats.json writer, and nothing that only reads', () => {
    const src = [
      'this.state.gateAuthorAuthority = 0.5',
      's.invariantOverrides = {}',
      'if (s.ideationAuthority === 0) return',
      'const a = s.gateAuthorAuthority ?? 0',
      "writeFileSync(join(home, 'retained', 'seats.json'), '{}')",
    ].join('\n')
    expect(strayWriters([{ name: 'x.mjs', src }])).toHaveLength(3)
  })
  it('flags a write a few lines below the seats path, and not one far from a mere mention', () => {
    const near = "const p = SEATS_PATH(home)\nconst tmp = p + '.tmp'\nwriteFileSync(tmp, '{}')\nrenameSync(tmp, p)\n"
    expect(strayWriters([{ name: 'x.mjs', src: near }])).toHaveLength(2)
    const far = '// the store is seats.json\n' + '\n'.repeat(40) + "writeFileSync('other.json', '{}')\n"
    expect(strayWriters([{ name: 'x.mjs', src: far }])).toEqual([])
  })
  it('the same lines inside an allowed file are not stray', () => {
    expect(strayWriters([{ name: 'cynco-proposals.mjs', src: 's.ideationAuthority = 1' }])).toEqual([])
  })
})

describe('only the proposal registry writes authority, overrides and seats.json', () => {
  it('no script outside cynco-proposals.mjs and cynco-campaign-state.mjs does', () => {
    const files = readdirSync(scriptsDir)
      .filter(n => n.endsWith('.mjs'))
      .map(name => ({ name, src: readFileSync(join(scriptsDir, name), 'utf-8') }))
    expect(files.length).toBeGreaterThan(20)
    expect(strayWriters(files)).toEqual([])
  })
  it('the registry itself is where the writes are', () => {
    const src = readFileSync(join(scriptsDir, 'cynco-proposals.mjs'), 'utf-8')
    expect(writerLines(src).length).toBeGreaterThanOrEqual(4)
  })
})
