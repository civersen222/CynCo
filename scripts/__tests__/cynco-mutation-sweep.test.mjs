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

  writeFileSync(join(dir, 'pkg', 'rules.py'), source)
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
