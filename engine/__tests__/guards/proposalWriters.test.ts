import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { PROPOSAL_FAMILIES, PROPOSAL_WRITERS } from '../../../scripts/cynco-proposals.mjs'

// Phase 4: one proposal registry. A seat's authority and a campaign's cap
// overrides are the only parameters the campaign may change about itself, and
// every change must pass through `applyProposalDecision` in
// scripts/cynco-proposals.mjs — the one place that refuses identity-targeting
// proposals and asserts identity before an approval. A second writer anywhere
// else is a second door around those checks, and nothing would say so.
//
// The allow-list is the registry's own export, PROPOSAL_WRITERS (file → the
// one method it is confined to, or null for the whole file):
//   - cynco-proposals.mjs          the registry itself (and the seats store)
//   - cynco-campaign-state.mjs     ONLY inside adoptExternalDecisions — the
//                                  monotonic merge of a decision a SECOND
//                                  process already made through the registry.
//                                  Anywhere else in that class is a stray.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const scriptsDir = join(repoRoot, 'scripts')

const ALLOWED: Record<string, string | null> = PROPOSAL_WRITERS

const FIELDS = '(invariantOverrides|ideationAuthority|gateAuthorAuthority)'
// Plain, logical and arithmetic compound assignment; `===`, `==`, `=>`,
// `>=`, `<=` and `!==` are reads and do not match.
const OP = '\\s*(\\?\\?|\\|\\||&&|\\+|-)?=(?![=>])'
const ASSIGN = new RegExp(`\\.${FIELDS}${OP}`)
const BRACKET = new RegExp(`\\[\\s*['"\`]${FIELDS}['"\`]\\s*\\]${OP}`)
const ASSIGN_OBJECT = new RegExp(`Object\\.assign\\(.*\\b${FIELDS}\\b`)
const SEATS = /seats\.json|SEATS_PATH/
const WRITE = /writeFileSync|renameSync/
const SEATS_WINDOW = 8

/** Every writer line in `src`, as [0-based index, text]. */
function writerLines(src: string): [number, string][] {
  const lines = src.split(/\r?\n/)
  const out: [number, string][] = []
  // The seats store path and the write that uses it are rarely on one line
  // (`const path = SEATS_PATH(home)` … `writeFileSync(tmp, …)`), so a write is
  // counted as a seats write when the store is named within SEATS_WINDOW lines
  // of it. A file that merely mentions seats.json in a far-off comment is not.
  const nearSeats = (i: number) => lines.slice(Math.max(0, i - SEATS_WINDOW), i + SEATS_WINDOW + 1).some(x => SEATS.test(x))
  lines.forEach((l, i) => {
    if (ASSIGN.test(l) || BRACKET.test(l) || ASSIGN_OBJECT.test(l)) out.push([i, l.trim()])
    else if (WRITE.test(l) && nearSeats(i)) out.push([i, l.trim()])
  })
  return out
}

/**
 * The [start, end) line range of a class method's body: from its header to
 * the next method header at the same (two-space) indent, or the class's
 * closing brace. null when the method is not there — then nothing is allowed.
 */
function methodRange(src: string, method: string): [number, number] | null {
  const lines = src.split(/\r?\n/)
  const header = new RegExp(`^\\s*${method}\\s*\\([^)]*\\)\\s*\\{`)
  const start = lines.findIndex(l => header.test(l))
  if (start === -1) return null
  const next = /^ {2}(async\s+|static\s+|get\s+|set\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{|^\}/
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (next.test(lines[i])) { end = i; break }
  return [start, end]
}

/** Writer lines outside what ALLOWED permits, as `file:line: text`. */
function strayWriters(files: { name: string; src: string }[], allowed: Record<string, string | null> = ALLOWED): string[] {
  const out: string[] = []
  for (const { name, src } of files) {
    const scope = allowed[name]
    if (scope === null) continue
    const range = scope === undefined ? null : methodRange(src, scope)
    for (const [i, text] of writerLines(src)) {
      if (range && i >= range[0] && i < range[1]) continue
      out.push(`${name}:${i + 1}: ${text}`)
    }
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
      'if (s.gateAuthorAuthority >= 0.5 || s.ideationAuthority <= 0 || s.ideationAuthority !== 1) return',
      "writeFileSync(join(home, 'retained', 'seats.json'), '{}')",
    ].join('\n')
    expect(strayWriters([{ name: 'x.mjs', src }])).toHaveLength(3)
  })
  it('flags compound, bracket and Object.assign writes', () => {
    const src = [
      's.ideationAuthority ??= 1',
      's.gateAuthorAuthority ||= 0.5',
      's.gateAuthorAuthority &&= 0.5',
      's.ideationAuthority += 0.1',
      's.ideationAuthority -= 0.1',
      "s['ideationAuthority'] = 1",
      's["gateAuthorAuthority"] ??= 1',
      'Object.assign(s, { invariantOverrides: { editGapCap: 999 } })',
    ].join('\n')
    expect(strayWriters([{ name: 'x.mjs', src }])).toHaveLength(8)
  })
  it('flags a write a few lines below the seats path, and not one far from a mere mention', () => {
    const near = "const p = SEATS_PATH(home)\nconst tmp = p + '.tmp'\nwriteFileSync(tmp, '{}')\nrenameSync(tmp, p)\n"
    expect(strayWriters([{ name: 'x.mjs', src: near }])).toHaveLength(2)
    const far = '// the store is seats.json\n' + '\n'.repeat(40) + "writeFileSync('other.json', '{}')\n"
    expect(strayWriters([{ name: 'x.mjs', src: far }])).toEqual([])
  })
  it('a whole-file writer is never stray', () => {
    expect(strayWriters([{ name: 'cynco-proposals.mjs', src: 's.ideationAuthority = 1' }])).toEqual([])
  })
  it('a method-scoped writer is allowed inside that method only', () => {
    const src = [
      'export class CampaignState {',
      '  save() {',
      '    this.state.ideationAuthority = 1',
      '  }',
      '  adoptExternalDecisions() {',
      '    if (x) {',
      '      this.state.ideationAuthority = Math.max(a, b)',
      '    }',
      '  }',
      '  appendWave(record) {',
      '    this.state.gateAuthorAuthority = 1',
      '  }',
      '}',
    ].join('\n')
    expect(strayWriters([{ name: 'cynco-campaign-state.mjs', src }])).toEqual([
      'cynco-campaign-state.mjs:3: this.state.ideationAuthority = 1',
      'cynco-campaign-state.mjs:11: this.state.gateAuthorAuthority = 1',
    ])
    // With the method gone, nothing in the file is allowed.
    expect(strayWriters([{ name: 'cynco-campaign-state.mjs', src: src.replace('adoptExternalDecisions', 'merge') }])).toHaveLength(3)
  })
})

describe('only the proposal registry writes authority, overrides and seats.json', () => {
  it('the allow-list is the registry\'s own export', () => {
    expect(ALLOWED).toEqual({ 'cynco-proposals.mjs': null, 'cynco-campaign-state.mjs': 'adoptExternalDecisions' })
  })
  it('no script writes outside the allowed file or method', () => {
    const files = readdirSync(scriptsDir)
      .filter(n => n.endsWith('.mjs'))
      .map(name => ({ name, src: readFileSync(join(scriptsDir, name), 'utf-8') }))
    expect(files.length).toBeGreaterThan(20)
    expect(strayWriters(files)).toEqual([])
  })
  it('the campaign-state merge is where that file\'s writes are', () => {
    const src = readFileSync(join(scriptsDir, 'cynco-campaign-state.mjs'), 'utf-8')
    const range = methodRange(src, 'adoptExternalDecisions')
    expect(range).not.toBeNull()
    const writes = writerLines(src)
    expect(writes.length).toBeGreaterThanOrEqual(3)
    for (const [i] of writes) expect(i >= range![0] && i < range![1]).toBe(true)
  })
  it('the registry itself is where the writes are', () => {
    const src = readFileSync(join(scriptsDir, 'cynco-proposals.mjs'), 'utf-8')
    expect(writerLines(src).length).toBeGreaterThanOrEqual(4)
  })
  // PROPOSAL_FAMILIES is the registry's declared surface: every family it
  // names must be one applyProposalDecision actually handles.
  it('applyProposalDecision handles every family the registry declares', () => {
    const src = readFileSync(join(scriptsDir, 'cynco-proposals.mjs'), 'utf-8')
    const start = src.indexOf('export function applyProposalDecision')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}', start))
    expect(PROPOSAL_FAMILIES.length).toBe(4)
    for (const f of PROPOSAL_FAMILIES) expect(body).toContain(`'${f}'`)
  })
})
