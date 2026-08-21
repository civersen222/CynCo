import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// This harness decides whether a mission's row in the ledger becomes labeled,
// so the thing under test is the shipping script itself, spawned, against a
// real git repo. A unit test of the AST walker would not have caught the two
// failures that actually matter: reporting a survivor for a mutant that was
// never applied, and reporting 15/15 on a tree that was already red.

const SCRIPT = resolve(import.meta.dirname, '..', 'cynco-mutation-sweep.py')

let python = 'python'
let havePython = false

beforeAll(() => {
  for (const cmd of ['python', 'python3', 'py']) {
    const r = spawnSync(cmd, ['-c', 'import ast,sys;print(sys.version_info[:2])'], { encoding: 'utf-8' })
    if (r.status === 0) { python = cmd; havePython = true; break }
  }
})

/** A git repo with one base commit and one "mission" commit on top. */
function makeRepo({ source, test: testSrc, baseSource = null, baseTest = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'sweeprepo-'))
  const git = (...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')

  mkdirSync(join(dir, 'pkg', 'tests'), { recursive: true })
  writeFileSync(join(dir, 'pkg', '__init__.py'), '')
  writeFileSync(join(dir, 'pkg', 'tests', '__init__.py'), '')
  writeFileSync(join(dir, 'pkg', 'rules.py'), baseSource ?? 'def placeholder():\n    return None\n')
  writeFileSync(join(dir, 'pkg', 'tests', 'test_rules.py'), baseTest ?? 'def test_placeholder():\n    assert True\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD').trim()

  // source: null is a tests-only mission — the case --mutate exists for. The
  // file must be left exactly as the base commit wrote it, or the diff is not
  // tests-only and the test proves nothing.
  if (source !== null) writeFileSync(join(dir, 'pkg', 'rules.py'), source)
  writeFileSync(join(dir, 'pkg', 'tests', 'test_rules.py'), testSrc)
  git('add', '-A')
  git('commit', '-q', '-m', 'mission')
  const head = git('rev-parse', 'HEAD').trim()
  return { dir, base, head }
}

function sweep({ dir, base, head }, extra = []) {
  const r = spawnSync(python, [SCRIPT, '--repo', dir, '--base', base, '--head', head, '--json', ...extra],
    { encoding: 'utf-8', timeout: 180_000 })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

/** The final --json line, or null if the run never got far enough to emit one. */
function parseJson(out) {
  const line = out.trim().split('\n').reverse().find(l => l.trim().startsWith('{'))
  return line ? JSON.parse(line) : null
}

describe.runIf(!process.env.CI)('cynco-mutation-sweep', () => {
  it('kills every mutation when the delivered test owns the rule', () => {
    if (!havePython) return
    const repo = makeRepo({
      source: 'def fee(gold):\n    if gold > 100:\n        return 10\n    return 1\n',
      test: [
        'from pkg.rules import fee',
        'def test_band():',
        '    assert fee(101) == 10',
        '    assert fee(100) == 1',
        '    assert fee(0) == 1',
        '',
      ].join('\n'),
    })
    try {
      const { status, out } = sweep(repo)
      const j = parseJson(out)
      expect(j, out).not.toBeNull()
      expect(j.total).toBeGreaterThan(0)
      expect(j.survived, out).toEqual([])
      expect(j.killed).toBe(j.total)
      expect(status).toBe(0)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('names the survivor when the test only checks the happy path', () => {
    if (!havePython) return
    // The boundary is never asserted, so `>` vs `>=` is invisible to this test.
    const repo = makeRepo({
      source: 'def fee(gold):\n    if gold > 100:\n        return 10\n    return 1\n',
      test: 'from pkg.rules import fee\ndef test_high():\n    assert fee(500) == 10\n',
    })
    try {
      const { status, out } = sweep(repo)
      const j = parseJson(out)
      expect(j, out).not.toBeNull()
      expect(j.survived.length, out).toBeGreaterThan(0)
      expect(j.survived.some(s => s.includes('rules.py') && s.includes('cmp->')), out).toBe(true)
      // A survivor is a finding, not a crash: exit 1, and the id is citable.
      expect(status).toBe(1)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('only mutates lines the mission added, not the whole file', () => {
    if (!havePython) return
    // `old_toll` is untouched by the mission and its assertion is weak. If the
    // sweep mutated it, it would report a survivor that belongs to nobody.
    const untouched = 'def old_toll(n):\n    if n > 5:\n        return 2\n    return 0\n'
    const repo = makeRepo({
      baseSource: untouched,
      baseTest: 'from pkg.rules import old_toll\ndef test_old():\n    assert old_toll(99) == 2\n',
      source: untouched + '\ndef fee(gold):\n    return 10 if gold > 100 else 1\n',
      test: [
        'from pkg.rules import old_toll, fee',
        'def test_old():',
        '    assert old_toll(99) == 2',
        'def test_band():',
        '    assert fee(101) == 10',
        '    assert fee(100) == 1',
        '',
      ].join('\n'),
    })
    try {
      const { out } = sweep(repo)
      const j = parseJson(out)
      expect(j, out).not.toBeNull()
      expect(j.survived, out).toEqual([])
      // Every mutation id must sit on a line the mission introduced.
      const lines = [...out.matchAll(/pkg\/rules\.py:(\d+):/g)].map(m => Number(m[1]))
      expect(lines.length).toBeGreaterThan(0)
      for (const ln of lines) expect(ln, `line ${ln} is base code`).toBeGreaterThan(5)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('refuses to report a sweep when the unmutated tree is already red', () => {
    if (!havePython) return
    const repo = makeRepo({
      source: 'def fee(gold):\n    if gold > 100:\n        return 10\n    return 1\n',
      test: 'from pkg.rules import fee\ndef test_wrong():\n    assert fee(500) == 999\n',
    })
    try {
      const { status, out } = sweep(repo)
      // 2 = UNMEASURED. Not 0, and not a fabricated "everything died".
      expect(status, out).toBe(2)
      expect(out).toMatch(/already red/)
      expect(parseJson(out)).toBeNull()
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('calls a mission that delivered no tests UNMEASURED, not passing', () => {
    if (!havePython) return
    const repo = makeRepo({
      source: 'def fee(gold):\n    if gold > 100:\n        return 10\n    return 1\n',
      test: 'def test_placeholder():\n    assert True\n',   // identical to base
    })
    try {
      const { status, out } = sweep(repo)
      expect(status, out).toBe(2)
      expect(out).toMatch(/no test files/)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('is deterministic — the same commit yields the same ids twice', () => {
    if (!havePython) return
    const repo = makeRepo({
      source: 'def fee(gold):\n    if gold > 100 and gold < 500:\n        return 10\n    return 1\n',
      test: 'from pkg.rules import fee\ndef test_high():\n    assert fee(200) == 10\n',
    })
    try {
      const a = parseJson(sweep(repo).out)
      const b = parseJson(sweep(repo).out)
      expect(a).not.toBeNull()
      expect(b).toEqual(a)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('prints a ledger-sweep command whose counts match its own JSON', () => {
    if (!havePython) return
    const repo = makeRepo({
      source: 'def fee(gold):\n    if gold > 100:\n        return 10\n    return 1\n',
      test: 'from pkg.rules import fee\ndef test_high():\n    assert fee(500) == 10\n',
    })
    try {
      const { out } = sweep(repo)
      const j = parseJson(out)
      expect(out).toContain(`--killed ${j.killed} --total ${j.total}`)
      // cynco-ledger-sweep.mjs rejects a survivor list whose length is not
      // total - killed, so the two must agree or the printed command is unusable.
      expect(j.survived.length).toBe(j.total - j.killed)
      if (j.survived.length) expect(out).toContain(`--survived ${j.survived.join(',')}`)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)
})

/**
 * A mission whose whole job is "make the suite measure the rules" delivers
 * tests and touches no source. Its diff therefore contains nothing to mutate,
 * and the sweep — correctly, on its own terms — reported UNMEASURED and the
 * row landed unlabeled. That is the exact outcome this tool was written to
 * stop, and it hit Stage 12, which passed a 13-perturbation gate and still
 * could not be scored.
 *
 * --mutate names the source the delivered tests CLAIM to own and mutates all of
 * it. The claim is a human's, so the result is recorded as `authored`.
 */
describe.runIf(!process.env.CI)('cynco-mutation-sweep --mutate (tests-only missions)', () => {
  const RULES = [
    'def fee(gold):',
    '    if gold > 100:',
    '        return 10',
    '    return 1',
    '',
    'def toll(n):',
    '    if n > 5:',
    '        return 2',
    '    return 0',
    '',
  ].join('\n')

  /** A mission that changed only pkg/tests/test_rules.py. */
  const testsOnly = (testSrc) => makeRepo({
    baseSource: RULES,
    baseTest: 'def test_placeholder():\n    assert True\n',
    source: null,
    test: testSrc,
  })

  const OWNS_BOTH = [
    'from pkg.rules import fee, toll',
    'def test_fee_band():',
    '    assert fee(101) == 10',
    '    assert fee(100) == 1',
    '    assert fee(0) == 1',
    'def test_toll_band():',
    '    assert toll(6) == 2',
    '    assert toll(5) == 0',
    '    assert toll(0) == 0',
    '',
  ].join('\n')

  it('without --mutate a tests-only mission is UNMEASURED, and says how to fix that', () => {
    if (!havePython) return
    const repo = testsOnly(OWNS_BOTH)
    try {
      const { status, out } = sweep(repo)
      expect(status, out).toBe(2)
      expect(out).toMatch(/no non-test \.py source/)
      // The message has to name the escape or the operator is back to hand-
      // authoring, which is the thing nobody was going to do.
      expect(out).toMatch(/--mutate/)
      expect(parseJson(out)).toBeNull()
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('with --mutate it measures the mission the diff could not', () => {
    if (!havePython) return
    const repo = testsOnly(OWNS_BOTH)
    try {
      const { status, out } = sweep(repo, ['--mutate', 'pkg/rules.py'])
      const j = parseJson(out)
      expect(j, out).not.toBeNull()
      expect(j.total, out).toBeGreaterThan(0)
      expect(j.survived, out).toEqual([])
      expect(status).toBe(0)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('--mutate covers the whole file, not just the (empty) added lines', () => {
    if (!havePython) return
    // Only `fee` is pinned. `toll`'s boundary is never asserted, so if the
    // sweep is really reading the whole file, `toll` must produce a survivor.
    const repo = testsOnly([
      'from pkg.rules import fee, toll',
      'def test_fee_band():',
      '    assert fee(101) == 10',
      '    assert fee(100) == 1',
      '    assert fee(0) == 1',
      'def test_toll_smoke():',
      '    assert toll(99) == 2',
      '',
    ].join('\n'))
    try {
      const { status, out } = sweep(repo, ['--mutate', 'pkg/rules.py'])
      const j = parseJson(out)
      expect(j, out).not.toBeNull()
      expect(j.survived.length, out).toBeGreaterThan(0)
      // Named at a line in the base file — proof it did not restrict to the diff.
      expect(j.survived.some(s => s.startsWith('pkg/rules.py:')), out).toBe(true)
      expect(status).toBe(1)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('still records as derived — naming a file is not naming a rule', () => {
    if (!havePython) return
    const repo = testsOnly(OWNS_BOTH)
    try {
      const { out } = sweep(repo, ['--mutate', 'pkg/rules.py'])
      const j = parseJson(out)
      // An `authored` survivor FAILS the mission under the labeling rule. The
      // mutation set here is machine-enumerated over an entire file, so a
      // survivor is a coverage gap over lines the mission may never have
      // claimed. Defaulting to authored would fail missions for them.
      expect(j.kind, out).toBe('derived')
      expect(out).toContain('--kind derived')
      // ...but the operator is told the choice exists, or nobody ever records
      // an authored sweep and the stronger reading is dead.
      expect(out).toMatch(/--kind authored only if/)
      // The command it prints must reproduce the run, --mutate included, or the
      // ledger records a command that measures something else.
      expect(j.command).toContain('--mutate "pkg/rules.py"')
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('a diff-derived run is still recorded as derived', () => {
    if (!havePython) return
    const repo = makeRepo({
      source: 'def fee(gold):\n    if gold > 100:\n        return 10\n    return 1\n',
      test: 'from pkg.rules import fee\ndef test_band():\n    assert fee(101) == 10\n    assert fee(100) == 1\n',
    })
    try {
      const { out } = sweep(repo)
      const j = parseJson(out)
      expect(j.kind, out).toBe('derived')
      expect(out).toContain('--kind derived')
      expect(j.command).not.toContain('--mutate')
      // The authored note belongs only to a run where a human chose the files.
      expect(out).not.toMatch(/--kind authored only if/)
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('refuses to mutate a test file', () => {
    if (!havePython) return
    const repo = testsOnly(OWNS_BOTH)
    try {
      const { status, out } = sweep(repo, ['--mutate', 'pkg/tests/test_rules.py'])
      // Mutating the tests asks whether the game notices a broken test, which
      // is the question backwards. 2, not a cheerful N/N.
      expect(status, out).toBe(2)
      expect(out).toMatch(/test file/)
      expect(parseJson(out)).toBeNull()
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)

  it('refuses a --mutate path that does not exist rather than sweeping what is left', () => {
    if (!havePython) return
    const repo = testsOnly(OWNS_BOTH)
    try {
      const { status, out } = sweep(repo, ['--mutate', 'pkg/rules.py pkg/typo.py'])
      // A typo'd path used to be skipped in silence, so the run would report a
      // clean sweep over the files that happened to spell correctly — measured-
      // looking, and wrong about what was measured.
      expect(status, out).toBe(2)
      expect(out).toMatch(/pkg\/typo\.py/)
      expect(parseJson(out)).toBeNull()
    } finally { rmSync(repo.dir, { recursive: true, force: true }) }
  }, 180_000)
})
