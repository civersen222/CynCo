import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lintGate, gateLineIds, LINE_ID_RE } from '../cynco-gate-lint.mjs'

const GATES = fileURLToPath(new URL('./fixtures/gates/', import.meta.url))
const triple = (dir) => ({
  campaignId: 'c99',
  gatePath: join(GATES, dir, 'gate_c99.py'),
  perturbPath: join(GATES, dir, 'perturb_c99.py'),
  positivePath: join(GATES, dir, 'positive_c99.py'),
})

describe('gateLineIds', () => {
  it('reads the first string-literal argument of every check() call, in order', () => {
    const src = 'def check(line_id, ok, detail):\n    pass\n\ncheck("C9.1.a", x, "d")\ncheck(\'C9.2\', y, "d")\n'
    expect(gateLineIds(src)).toEqual(['C9.1.a', 'C9.2'])
  })
  // A per-seed id is only known at run time and this pass never runs anything,
  // so the literal prefix is what the lint can judge — and it must not choke.
  it('takes the literal prefix of an f-string id template and flags nothing else', () => {
    expect(gateLineIds('check(f"C7.1.{seed}", ok, d)\ncheck(f"C7.2.{a}.{b}", ok, d)\n')).toEqual(['C7.1', 'C7.2'])
  })
  it('ignores a check( that carries no literal id, and names that are not check', () => {
    expect(gateLineIds('check(line_id, ok, d)\nprecheck("C9.1", ok)\nself.check("C9.2", ok)\n')).toEqual([])
  })
  it('LINE_ID_RE accepts the shapes the sealed gates print and rejects the rest', () => {
    for (const id of ['C8.1a.tiers-differ', 'C8.5.palette.Atlas', 'C99.9', 'C10b.2']) expect(LINE_ID_RE.test(id)).toBe(true)
    for (const id of ['C8', 'c8.1', 'C8.1a.', 'C8.1a.has space', '8.1']) expect(LINE_ID_RE.test(id)).toBe(false)
  })
})

describe('lintGate — the good triple', () => {
  it('passes, and reports all nine graded lines in source order', () => {
    const r = lintGate(triple('good'))
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.lineIds).toEqual([
      'C99.1.thing', 'C99.2.other', 'C99.3.thing', 'C99.4.other',
      'C99.5.thing', 'C99.6.other', 'C99.7.thing', 'C99.8.other', 'C99.9',
    ])
  })
  it('lints the gate alone when no shims are given', () => {
    const r = lintGate({ campaignId: 'c99', gatePath: triple('good').gatePath })
    expect(r.ok).toBe(true)
  })
  // The whole point of a STATIC lint is that it costs three file reads and runs
  // nothing: the source it is handed was written by a model.
  it('never executes the gate — it only reads the three files it was given', () => {
    const read = []
    const r = lintGate({ ...triple('good'), io: { readFile: (p) => { read.push(p); return readFileSync(p, 'utf8') } } })
    expect(r.ok).toBe(true)
    expect(read).toHaveLength(3)
  })
})

// Each directory is the good triple with exactly ONE rule broken, so a fixture
// that produces two problems means a rule is entangled with another.
describe('lintGate — one broken rule per fixture', () => {
  const cases = [
    ['bad-duplicate-id', /duplicate gate line id C99\.2\.other/],
    ['bad-no-gate-repo', /never reads CYNCO_GATE_REPO/],
    ['bad-no-regression-line', /no prior-campaign regression line C99\.9/],
    ['bad-no-skip-prior', /C99\.9 regression line does not honour CYNCO_GATE_SKIP_PRIOR/],
    ['bad-no-terminator', /never prints a .*GATE: PASS/],
    ['bad-network-import', /the gate imports socket/],
    ['bad-no-runpy', /perturb shim does not runpy\.run_path/],
    ['bad-header-unknown-id', /header names C99\.42, which is not a gate line id/],
    ['bad-empty-must-fail', /declares no MUST-FAIL discriminator/],
  ]
  for (const [dir, expected] of cases) {
    it(`${dir} → exactly its own problem`, () => {
      const r = lintGate(triple(dir))
      expect(r.ok).toBe(false)
      expect(r.problems).toHaveLength(1)
      expect(r.problems[0]).toMatch(expected)
      expect(r.problems[0].startsWith('lint: ')).toBe(true)
    })
  }
})

describe('lintGate — rules with no fixture of their own', () => {
  const src = (over = {}) => ({
    gate: 'CYNCO_GATE_REPO CYNCO_GATE_SKIP_PRIOR\ncheck("C99.1.a", x, d)\ncheck("C99.9", x, d)\nprint("GATE: PASS")\n',
    perturb: '# EXPECT-FLIP: C99.1\n# MUST-FAIL: C99.9\nimport runpy\nos.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"\nrunpy.run_path(GATE)\n',
    positive: 'import runpy\nos.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"\nrunpy.run_path(GATE)\n',
    ...over,
  })
  const lint = (over) => {
    const files = src(over)
    return lintGate({ campaignId: 'c99', gatePath: 'g', perturbPath: 'p', positivePath: 'q', io: { readFile: (k) => files[{ g: 'gate', p: 'perturb', q: 'positive' }[k]] } })
  }
  it('accepts the minimal well-formed triple', () => { expect(lint().problems).toEqual([]) })
  it('refuses an id that does not parse or belongs to another campaign', () => {
    expect(lint({ gate: src().gate.replace('"C99.1.a"', '"C8.1.a"') }).problems[0]).toMatch(/line id "C8\.1\.a" is not a C99\.<n> id/)
    expect(lint({ gate: src().gate.replace('"C99.1.a"', '"C99.1.has space"') }).problems[0]).toMatch(/is not a C99\.<n> id/)
  })
  it('refuses a gate that grades nothing', () => {
    expect(lint({ gate: 'CYNCO_GATE_REPO CYNCO_GATE_SKIP_PRIOR\nprint("GATE: PASS")\n' }).problems.join('\n')).toMatch(/no graded lines/)
  })
  it('refuses a shim that leaves the prior chain on, and names which shim', () => {
    expect(lint({ positive: 'import runpy\nrunpy.run_path(GATE)\n' }).problems).toEqual([
      'lint: the positive shim does not set CYNCO_GATE_SKIP_PRIOR — it would re-run the prior campaign\'s gate on every calibration',
    ])
  })
  it('refuses a network import in a shim, not only in the gate', () => {
    expect(lint({ positive: 'import requests\n' + src().positive }).problems[0]).toMatch(/the positive imports requests/)
  })
  // A banned name reached through a LIST is the same import. `import os,
  // socket` was invisible to the first regex, which only looked at the first
  // name on the line.
  it('refuses a banned module that arrives after a comma', () => {
    expect(lint({ gate: 'import os, socket\n' + src().gate }).problems[0]).toMatch(/the gate imports socket/)
    expect(lint({ gate: 'import json, urllib.request as u\n' + src().gate }).problems[0]).toMatch(/the gate imports urllib/)
    expect(lint({ gate: 'import os, sys, json\n' + src().gate }).problems).toEqual([])
  })
  // A campaign id may carry a letter suffix (LINE_ID_RE allows `C\d+[a-z]?`).
  // Uppercasing the whole id turned `c10b` into `C10B`, which no gate line can
  // start with, so every line of a lettered campaign was refused.
  it('accepts a lettered campaign id and names it in the gate form', () => {
    const files = {
      gate: 'CYNCO_GATE_REPO CYNCO_GATE_SKIP_PRIOR\ncheck("C10b.1.x", ok, d)\ncheck("C10b.9", ok, d)\nprint("GATE: PASS")\n',
      perturb: '# EXPECT-FLIP: C10b.1\n# MUST-FAIL: C10b.9\nimport runpy\nos.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"\nrunpy.run_path(GATE)\n',
      positive: src().positive,
    }
    const at = (id) => lintGate({ campaignId: id, gatePath: 'g', perturbPath: 'p', positivePath: 'q', io: { readFile: (k) => files[{ g: 'gate', p: 'perturb', q: 'positive' }[k]] } })
    expect(at('c10b').problems).toEqual([])
    expect(at('C10b').problems).toEqual([])
    expect(at('c11').problems[0]).toMatch(/line id "C10b\.1\.x" is not a C11\.<n> id/)
  })
  it('reports a perturb with no header as a lint problem rather than throwing', () => {
    expect(lint({ perturb: 'import runpy\nos.environ["CYNCO_GATE_SKIP_PRIOR"]\nrunpy.run_path(GATE)\n' }).problems[0]).toMatch(/^lint: perturb header is missing a "# EXPECT-FLIP:" line/)
  })
  it('refuses an EXPECT-FLIP id the gate never grades, not just a MUST-FAIL one', () => {
    expect(lint({ perturb: src().perturb.replace('C99.1\n', 'C99.7\n') }).problems[0]).toMatch(/header names C99\.7/)
  })
})
