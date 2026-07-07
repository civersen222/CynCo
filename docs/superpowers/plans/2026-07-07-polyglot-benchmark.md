# Aider-Polyglot Benchmark Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `benchmark/true/polyglot/` — a chunked (≤1h `--budget` increments), aider-comparable polyglot benchmark harness that drives CynCo as-shipped on the host and runs hidden tests in a Docker Linux container.

**Architecture:** Per spec `docs/superpowers/specs/2026-07-06-polyglot-benchmark-design.md`. Host orchestrator stages an isolated workdir per exercise (no `.meta/`, no test files), drives one `ConversationLoop` per exercise (try 2 continues the same loop), injects pristine unskipped tests, `docker exec`s the language test command in a long-lived `polyglot-bench` container, appends one JSONL record per exercise, and stops cleanly when the time budget can't fit another exercise.

**Tech Stack:** Bun/TypeScript (engine harness), vitest (unit tests), Docker (Ubuntu 24.04 image with python/node/go/rust/JDK/cmake toolchains).

**Branch:** `polyglot-benchmark` (already checked out; spec committed).

---

## Context an engineer needs

- **Engine bootstrap pattern** (copy it, don't invent): `benchmark/true/run.ts` does
  `loadConfig()` from `engine/config.js`, then `bootstrapProvider(config)` from
  `engine/bootstrapProvider.js` → `{ provider }`. `benchmark/true/harness/driver.ts`
  shows loop construction: `new ConversationLoop({ config: { ...config, approveAll: true, noScouts: true }, provider, emit: () => {}, cwd, s5 })`
  with `s5 = new S5Orchestrator(new RuleBasedS5())`, timeout via `loop.abort()`.
- **Exercises repo:** `benchmark/polyglot-exercises/` — a NESTED git repo, not tracked
  by localcode. Layout: `<lang>/exercises/practice/<name>/` with `.meta/config.json`
  (`files.solution[]`, `files.test[]`, `files.example[]` — example = reference
  solution, NEVER expose), `.docs/introduction.md` (37 exercises), `.docs/instructions.md`,
  `.docs/instructions.append.md`. Counts: cpp 26, go 39, java 47, javascript 49,
  python 34, rust 30 = 225.
- **The exercises repo working tree is DIRTY** from the retired 2025 adapter run:
  modified stubs AND test files, plus untracked junk (`.localcode-debug.json`,
  `__pycache__`, `simple_test.py`, ...). Task 1 restores it; `assertPristine()`
  guards every future run.
- **Skip mechanisms** (aider unskips these; we must too, at test-inject time):
  - JavaScript: `xtest(` → `test(`, `xit(` → `it(`, `xdescribe(` → `describe(`
  - Java: delete lines whose trimmed form starts with `@Disabled`
  - Rust: no file edit; run `cargo test -- --include-ignored`
  - C++: no file edit; configure with `-DEXERCISM_RUN_ALL_TESTS=1`
  - Go, Python: nothing needed
- **Windows quirks:** files copied to the scratch dir lose the exec bit → Java runs
  `bash gradlew test`, not `./gradlew test`. Docker Desktop mounts `C:\Users\...`
  paths fine.
- **Test conventions:** vitest (`npm test` = `vitest run`), test files colocated as
  `*.test.ts` (see `benchmark/true/harness/*.test.ts`). Spec says
  `__tests__/` but the repo convention is colocated `.test.ts` — follow repo
  convention (colocated).
- **Vitest runs on Node** (commit cf75f8e) — do not use Bun-only APIs
  (`Bun.spawnSync`, `import.meta.dir`) in modules imported by tests. Use
  `node:child_process` `spawnSync` and `import.meta.dirname`.
- `benchmark/true/polyglot/**` is NOT gitignored (verified with `git check-ignore`);
  plain `git add` works. `docs/superpowers/**` needs `git add -f`.

## File structure

```
benchmark/true/polyglot/
├── types.ts          # Exercise, ExerciseRecord, Language, LANGUAGES test commands
├── exercise.ts       # discovery, assertPristine, staging, inject/remove, unskip, prompts
├── exercise.test.ts
├── records.ts        # JSONL append/load, resume filtering, budget fit
├── records.test.ts
├── report.ts         # chunk summary, per-language table, leaderboard comparison
├── report.test.ts
├── container.ts      # docker image/container lifecycle + exec
├── container.test.ts # gated: skipped unless docker present
├── runLoop.ts        # ExerciseSession: one ConversationLoop, two tries
├── run.ts            # CLI orchestrator (chunk loop) — thin, wiring only
├── Dockerfile        # polyglot-bench image
└── README.md         # reproduction instructions
```

`runLoop.ts` and `run.ts` have no unit tests (they require a live model/provider);
they are exercised by `--smoke`. Everything with logic lives in the tested modules.

---

### Task 1: Preflight — pristine exercises repo, retire old adapter

The old adapter (`benchmark/polyglot-adapter.ts`, gitignored, disqualified per spec
Background section) polluted `benchmark/polyglot-exercises/` with a stale run:
modified stub + test files, untracked artifacts. The spec (approved) retires the
adapter and its artifacts. Evidence: `git -C benchmark/polyglot-exercises status --short`
shows 14+ modified files and `.localcode-debug.json` / `simple_test.py` /
`__pycache__` junk.

**Files:**
- Delete: `benchmark/polyglot-adapter.ts` (gitignored — fs delete only)
- Delete: `benchmark/polyglot-results.jsonl` (if present; stale gemma4 run)
- Restore: `benchmark/polyglot-exercises/` working tree

- [ ] **Step 1: Show the evidence, then restore**

```bash
git -C benchmark/polyglot-exercises status --short | head -30   # evidence: stale-run damage
git -C benchmark/polyglot-exercises checkout -- .
git -C benchmark/polyglot-exercises clean -fdx
git -C benchmark/polyglot-exercises status --short              # expect: empty
```

- [ ] **Step 2: Delete the retired adapter and stale results**

```bash
rm -f benchmark/polyglot-adapter.ts benchmark/polyglot-results.jsonl
```

- [ ] **Step 3: Verify localcode tree unaffected**

Run: `git status --short` (from repo root)
Expected: no changes (everything touched was gitignored / in the nested repo). No commit for this task.

---

### Task 2: types.ts + exercise discovery + pristine guard

**Files:**
- Create: `benchmark/true/polyglot/types.ts`
- Create: `benchmark/true/polyglot/exercise.ts`
- Test: `benchmark/true/polyglot/exercise.test.ts`

- [ ] **Step 1: Write types.ts** (no test — pure declarations)

```ts
// benchmark/true/polyglot/types.ts
export type Language = 'cpp' | 'go' | 'java' | 'javascript' | 'python' | 'rust'

export const LANGUAGES: Record<Language, { testCommand: string }> = {
  // Commands run inside the Linux container via `bash -lc`, cwd = the exercise workdir.
  // Java uses `bash gradlew` because the exec bit is lost copying from Windows.
  python: { testCommand: 'python3 -m pytest -x -q' },
  javascript: { testCommand: 'npm install --no-audit --no-fund --silent && npm test' },
  go: { testCommand: 'go test ./...' },
  rust: { testCommand: 'cargo test -- --include-ignored' },
  java: { testCommand: 'bash gradlew test' },
  cpp: {
    testCommand:
      'cmake -DEXERCISM_RUN_ALL_TESTS=1 -B build -S . && cmake --build build -j && cd build && ctest --output-on-failure',
  },
}

export interface Exercise {
  language: Language
  name: string
  dir: string // absolute path into benchmark/polyglot-exercises
  solutionFiles: string[] // relative paths from .meta/config.json files.solution
  testFiles: string[] // relative paths from .meta/config.json files.test
}

/** One JSONL line per exercise — the spec's durable record. */
export interface ExerciseRecord {
  language: string
  exercise: string
  passed: boolean
  passedTry: 1 | 2 | null
  durationMs: number
  tryDurationsMs: number[]
  testDurationMs: number
  error?: string
  envFailure?: boolean
}
```

- [ ] **Step 2: Write failing tests for discovery + assertPristine**

```ts
// benchmark/true/polyglot/exercise.test.ts
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverExercises, assertPristine } from './exercise.js'

const REAL_ROOT = join(import.meta.dirname, '..', '..', 'polyglot-exercises')

// Builds a minimal fake exercises repo: one python exercise "demo".
function makeFakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'polyglot-fake-'))
  const ex = join(root, 'python', 'exercises', 'practice', 'demo')
  mkdirSync(join(ex, '.meta'), { recursive: true })
  mkdirSync(join(ex, '.docs'), { recursive: true })
  writeFileSync(
    join(ex, '.meta', 'config.json'),
    JSON.stringify({ files: { solution: ['demo.py'], test: ['demo_test.py'], example: ['.meta/example.py'] } }),
  )
  writeFileSync(join(ex, '.meta', 'example.py'), 'SECRET = 42\n')
  writeFileSync(join(ex, '.docs', 'instructions.md'), 'Implement demo.\n')
  writeFileSync(join(ex, 'demo.py'), 'def demo():\n    pass\n')
  writeFileSync(join(ex, 'demo_test.py'), 'def test_demo():\n    assert True\n')
  return root
}

describe('discoverExercises', () => {
  it('finds exercises with solution/test file lists from .meta/config.json', () => {
    const root = makeFakeRoot()
    const found = discoverExercises(root)
    expect(found).toHaveLength(1)
    expect(found[0].language).toBe('python')
    expect(found[0].name).toBe('demo')
    expect(found[0].solutionFiles).toEqual(['demo.py'])
    expect(found[0].testFiles).toEqual(['demo_test.py'])
  })

  it('filters by language and exercise name', () => {
    const root = makeFakeRoot()
    expect(discoverExercises(root, { lang: 'go' })).toHaveLength(0)
    expect(discoverExercises(root, { exercise: 'demo' })).toHaveLength(1)
    expect(discoverExercises(root, { exercise: 'nope' })).toHaveLength(0)
  })
})

// Gated on the real nested repo being present (it is not tracked by localcode).
describe.skipIf(!existsSync(REAL_ROOT))('discoverExercises against real repo', () => {
  it("matches aider's published per-language split (225 total)", () => {
    const found = discoverExercises(REAL_ROOT)
    const byLang: Record<string, number> = {}
    for (const e of found) byLang[e.language] = (byLang[e.language] ?? 0) + 1
    expect(byLang).toEqual({ cpp: 26, go: 39, java: 47, javascript: 49, python: 34, rust: 30 })
    expect(found).toHaveLength(225)
  })
})

describe.skipIf(!existsSync(REAL_ROOT))('assertPristine', () => {
  it('passes on a clean exercises repo', () => {
    expect(() => assertPristine(REAL_ROOT)).not.toThrow()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run benchmark/true/polyglot/exercise.test.ts`
Expected: FAIL — cannot resolve `./exercise.js`

- [ ] **Step 4: Implement discovery + assertPristine**

```ts
// benchmark/true/polyglot/exercise.ts
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { LANGUAGES, type Exercise, type Language } from './types.js'

/**
 * Discover exercises from an aider polyglot-benchmark checkout.
 * Layout: <root>/<lang>/exercises/practice/<name>/.meta/config.json
 */
export function discoverExercises(
  root: string,
  filter?: { lang?: string; exercise?: string },
): Exercise[] {
  const out: Exercise[] = []
  for (const lang of Object.keys(LANGUAGES) as Language[]) {
    if (filter?.lang && lang !== filter.lang) continue
    const practice = join(root, lang, 'exercises', 'practice')
    if (!existsSync(practice)) continue
    for (const name of readdirSync(practice).sort()) {
      if (filter?.exercise && name !== filter.exercise) continue
      const dir = join(practice, name)
      const configPath = join(dir, '.meta', 'config.json')
      if (!existsSync(configPath)) continue
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      out.push({
        language: lang,
        name,
        dir,
        solutionFiles: config.files.solution,
        testFiles: config.files.test,
      })
    }
  }
  return out
}

/**
 * Validity guard: a dirty exercises repo means stubs or hidden tests were
 * mutated (the retired 2025 adapter did exactly that) — results would be
 * unattributable. Refuse to run.
 */
export function assertPristine(root: string): void {
  const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf-8' }).trim()
  if (status) {
    throw new Error(
      `exercises repo is not pristine — refusing to run.\n` +
        `Fix with: git -C "${root}" checkout -- . && git -C "${root}" clean -fdx\n${status}`,
    )
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run benchmark/true/polyglot/exercise.test.ts`
Expected: PASS (real-repo suites run too, since Task 1 restored pristine state)

- [ ] **Step 6: Commit**

```bash
git add benchmark/true/polyglot/types.ts benchmark/true/polyglot/exercise.ts benchmark/true/polyglot/exercise.test.ts
git commit -m "feat(polyglot): exercise discovery + pristine-repo guard"
```

---

### Task 3: Workdir staging (anti-cheat exclusions)

**Files:**
- Modify: `benchmark/true/polyglot/exercise.ts`
- Test: `benchmark/true/polyglot/exercise.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `exercise.test.ts` (reuse `makeFakeRoot` from Task 2):

```ts
import { readFileSync as readFs } from 'node:fs'
import { stageWorkdir } from './exercise.js'

describe('stageWorkdir', () => {
  it('copies stubs and docs but NEVER .meta or test files', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    expect(existsSync(join(workdir, 'demo.py'))).toBe(true)
    expect(existsSync(join(workdir, '.docs', 'instructions.md'))).toBe(true)
    expect(existsSync(join(workdir, '.meta'))).toBe(false) // reference solutions
    expect(existsSync(join(workdir, 'demo_test.py'))).toBe(false) // hidden tests
  })

  it('re-staging wipes leftovers from a previous stage', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    writeFileSync(join(workdir, 'leftover.txt'), 'junk')
    const again = stageWorkdir(ex, scratch)
    expect(again).toBe(workdir)
    expect(existsSync(join(workdir, 'leftover.txt'))).toBe(false)
  })

  it('excludes nested test files (java-style src/test/... paths)', () => {
    const root = makeFakeRoot()
    const ex = join(root, 'java', 'exercises', 'practice', 'jdemo')
    mkdirSync(join(ex, '.meta'), { recursive: true })
    mkdirSync(join(ex, 'src', 'main', 'java'), { recursive: true })
    mkdirSync(join(ex, 'src', 'test', 'java'), { recursive: true })
    writeFileSync(
      join(ex, '.meta', 'config.json'),
      JSON.stringify({
        files: {
          solution: ['src/main/java/JDemo.java'],
          test: ['src/test/java/JDemoTest.java'],
          example: ['.meta/Ref.java'],
        },
      }),
    )
    writeFileSync(join(ex, 'src', 'main', 'java', 'JDemo.java'), 'class JDemo {}\n')
    writeFileSync(join(ex, 'src', 'test', 'java', 'JDemoTest.java'), 'class JDemoTest {}\n')
    const [jex] = discoverExercises(root, { lang: 'java' })
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(jex, scratch)
    expect(existsSync(join(workdir, 'src', 'main', 'java', 'JDemo.java'))).toBe(true)
    expect(existsSync(join(workdir, 'src', 'test', 'java', 'JDemoTest.java'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run benchmark/true/polyglot/exercise.test.ts`
Expected: FAIL — `stageWorkdir` is not exported

- [ ] **Step 3: Implement stageWorkdir**

Add to `exercise.ts`:

```ts
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { relative, sep } from 'node:path'

/**
 * Stage an isolated agent workdir under scratchRoot: full exercise dir MINUS
 * `.meta/` (contains reference solutions — CynCo has Read/Grep and would find
 * them) and MINUS the hidden test files (injected only between tries).
 * Always starts from a wiped directory so retries can't inherit state.
 */
export function stageWorkdir(ex: Exercise, scratchRoot: string): string {
  const workdir = join(scratchRoot, `${ex.language}-${ex.name}`)
  rmSync(workdir, { recursive: true, force: true })
  mkdirSync(workdir, { recursive: true })
  const excluded = new Set(ex.testFiles.map((f) => f.split('/').join(sep)))
  cpSync(ex.dir, workdir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(ex.dir, src)
      if (rel === '') return true
      if (rel === '.meta' || rel.startsWith(`.meta${sep}`)) return false
      if (excluded.has(rel)) return false
      return true
    },
  })
  return workdir
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run benchmark/true/polyglot/exercise.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/polyglot/exercise.ts benchmark/true/polyglot/exercise.test.ts
git commit -m "feat(polyglot): anti-cheat workdir staging (no .meta, no tests)"
```

---

### Task 4: Test inject/remove + unskip transforms

**Files:**
- Modify: `benchmark/true/polyglot/exercise.ts`
- Test: `benchmark/true/polyglot/exercise.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `exercise.test.ts`:

```ts
import { injectTests, removeTests, unskip } from './exercise.js'

describe('unskip', () => {
  it('enables skipped javascript tests (xtest/xit/xdescribe)', () => {
    const src = "xtest('a', () => {})\nxit('b', () => {})\nxdescribe('c', () => {})\ntest('d', () => {})\n"
    expect(unskip('javascript', src)).toBe(
      "test('a', () => {})\nit('b', () => {})\ndescribe('c', () => {})\ntest('d', () => {})\n",
    )
  })

  it('strips java @Disabled annotation lines but keeps the import', () => {
    const src = 'import org.junit.jupiter.api.Disabled;\nclass T {\n    @Disabled("Remove to run test")\n    @Test\n    void x() {}\n}\n'
    const out = unskip('java', src)
    expect(out).toContain('import org.junit.jupiter.api.Disabled;')
    expect(out).not.toContain('@Disabled(')
    expect(out).toContain('@Test')
  })

  it('leaves other languages untouched', () => {
    const src = '#[ignore]\nfn t() {}\n'
    expect(unskip('rust', src)).toBe(src)
  })
})

describe('injectTests / removeTests', () => {
  it('round-trips: inject writes unskipped pristine tests, remove deletes them', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    injectTests(ex, workdir)
    expect(readFs(join(workdir, 'demo_test.py'), 'utf-8')).toContain('def test_demo')
    removeTests(ex, workdir)
    expect(existsSync(join(workdir, 'demo_test.py'))).toBe(false)
  })

  it('clobbers an agent-created file that collides with a test name', () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-scratch-'))
    const workdir = stageWorkdir(ex, scratch)
    writeFileSync(join(workdir, 'demo_test.py'), 'def test_demo():\n    pass  # tampered\n')
    injectTests(ex, workdir)
    const content = readFs(join(workdir, 'demo_test.py'), 'utf-8')
    expect(content).not.toContain('tampered')
    expect(content).toContain('assert True')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run benchmark/true/polyglot/exercise.test.ts`
Expected: FAIL — `injectTests` not exported

- [ ] **Step 3: Implement**

Add to `exercise.ts` (`dirname` added to the `node:path` import):

```ts
import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Enable the tests aider enables. Exercism ships most tests skipped
 * (JS `xtest`, Java `@Disabled`); rust/cpp are handled by test-command flags.
 */
export function unskip(language: Language, src: string): string {
  if (language === 'javascript') {
    return src
      .replace(/\bxtest\(/g, 'test(')
      .replace(/\bxit\(/g, 'it(')
      .replace(/\bxdescribe\(/g, 'describe(')
  }
  if (language === 'java') {
    return src
      .split('\n')
      .filter((line) => !line.trim().startsWith('@Disabled'))
      .join('\n')
  }
  return src
}

/**
 * Copy pristine test files from the exercises repo into the workdir,
 * unskipped. ALWAYS overwrites, so an agent-created file with a test's
 * name is clobbered by the pristine copy (anti-tamper).
 */
export function injectTests(ex: Exercise, workdir: string): void {
  for (const rel of ex.testFiles) {
    const pristine = readFileSync(join(ex.dir, rel), 'utf-8')
    const dest = join(workdir, rel.split('/').join(sep))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, unskip(ex.language, pristine))
  }
}

/** Delete injected test files so they are unreadable while the agent runs. */
export function removeTests(ex: Exercise, workdir: string): void {
  for (const rel of ex.testFiles) {
    rmSync(join(workdir, rel.split('/').join(sep)), { force: true })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run benchmark/true/polyglot/exercise.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/polyglot/exercise.ts benchmark/true/polyglot/exercise.test.ts
git commit -m "feat(polyglot): pristine test inject/remove with aider unskip transforms"
```

---

### Task 5: Prompt assembly (aider wording)

**Files:**
- Modify: `benchmark/true/polyglot/exercise.ts`
- Test: `benchmark/true/polyglot/exercise.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `exercise.test.ts`:

```ts
import { buildPrompt, buildRetryPrompt } from './exercise.js'

describe('buildPrompt', () => {
  it("assembles docs + aider's instruction wording with the solution file list", () => {
    const root = makeFakeRoot()
    const [ex] = discoverExercises(root)
    const p = buildPrompt(ex)
    expect(p).toContain('Implement demo.')
    expect(p).toContain('Use the above instructions to modify the supplied files: demo.py')
    expect(p).toContain("Don't change the names of existing functions or classes")
    expect(p).toContain("Only use standard libraries, don't suggest installing any packages.")
  })

  it('includes introduction.md and instructions.append.md when present', () => {
    const root = makeFakeRoot()
    const docs = join(root, 'python', 'exercises', 'practice', 'demo', '.docs')
    writeFileSync(join(docs, 'introduction.md'), 'INTRO TEXT\n')
    writeFileSync(join(docs, 'instructions.append.md'), 'APPEND TEXT\n')
    const [ex] = discoverExercises(root)
    const p = buildPrompt(ex)
    expect(p.indexOf('INTRO TEXT')).toBeGreaterThanOrEqual(0)
    expect(p.indexOf('INTRO TEXT')).toBeLessThan(p.indexOf('Implement demo.'))
    expect(p.indexOf('APPEND TEXT')).toBeGreaterThan(p.indexOf('Implement demo.'))
  })
})

describe('buildRetryPrompt', () => {
  it("feeds truncated test output with aider's retry wording", () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    const p = buildRetryPrompt(['demo.py'], output)
    expect(p).toContain('line 0')
    expect(p).not.toContain('line 299') // truncated
    expect(p).toContain('See the testing errors above.')
    expect(p).toContain('The tests are correct.')
    expect(p).toContain('Fix the code in demo.py to resolve the errors.')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run benchmark/true/polyglot/exercise.test.ts`
Expected: FAIL — `buildPrompt` not exported

- [ ] **Step 3: Implement**

Add to `exercise.ts`:

```ts
/**
 * Aider's exercise prompt: .docs/introduction.md (if any) + instructions.md +
 * instructions.append.md (if any), followed by aider's exact instruction
 * wording. This is the ONLY harness-supplied instruction text (as-shipped rule).
 */
export function buildPrompt(ex: Exercise): string {
  const docs = join(ex.dir, '.docs')
  const parts: string[] = []
  for (const f of ['introduction.md', 'instructions.md', 'instructions.append.md']) {
    const p = join(docs, f)
    if (existsSync(p)) parts.push(readFileSync(p, 'utf-8'))
  }
  const fileList = ex.solutionFiles.join(', ')
  return `${parts.join('\n\n')}

Use the above instructions to modify the supplied files: ${fileList}
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard libraries, don't suggest installing any packages.`
}

const MAX_ERROR_LINES = 100

/** Aider's try-2 message: test output + "the tests are correct" wording. */
export function buildRetryPrompt(solutionFiles: string[], testOutput: string): string {
  const truncated = testOutput.split('\n').slice(0, MAX_ERROR_LINES).join('\n')
  return `${truncated}

####

See the testing errors above.
The tests are correct.
Fix the code in ${solutionFiles.join(', ')} to resolve the errors.`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run benchmark/true/polyglot/exercise.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/polyglot/exercise.ts benchmark/true/polyglot/exercise.test.ts
git commit -m "feat(polyglot): aider-parity prompt assembly (try 1 + retry)"
```

---

### Task 6: records.ts — durable JSONL + resume + budget fit

**Files:**
- Create: `benchmark/true/polyglot/records.ts`
- Test: `benchmark/true/polyglot/records.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// benchmark/true/polyglot/records.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendRecord, loadRecords, completedKeys, fitsInBudget, WORST_CASE_MS } from './records.js'
import type { ExerciseRecord } from './types.js'

const rec = (over: Partial<ExerciseRecord> = {}): ExerciseRecord => ({
  language: 'python', exercise: 'bowling', passed: true, passedTry: 1,
  durationMs: 1000, tryDurationsMs: [1000], testDurationMs: 200, ...over,
})

describe('appendRecord / loadRecords', () => {
  it('appends one JSON line per record and loads them back', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'polyglot-rec-')), 'out.jsonl')
    appendRecord(path, rec())
    appendRecord(path, rec({ exercise: 'connect', passed: false, passedTry: null }))
    const raw = readFileSync(path, 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(2)
    const loaded = loadRecords(path)
    expect(loaded).toHaveLength(2)
    expect(loaded[1].passedTry).toBeNull()
  })

  it('loadRecords returns [] for a missing file (fresh run)', () => {
    expect(loadRecords(join(tmpdir(), 'does-not-exist.jsonl'))).toEqual([])
  })
})

describe('completedKeys (resume filtering)', () => {
  it('keys records as language/exercise', () => {
    const done = completedKeys([rec(), rec({ language: 'go', exercise: 'zebra' })])
    expect(done.has('python/bowling')).toBe(true)
    expect(done.has('go/zebra')).toBe(true)
    expect(done.has('go/bowling')).toBe(false)
  })
})

describe('fitsInBudget', () => {
  it('always fits the first exercise of a chunk (budget >= worst case)', () => {
    expect(fitsInBudget(0, 60 * 60_000)).toBe(true)
  })
  it('stops before an exercise that could overrun the budget', () => {
    const budget = 60 * 60_000
    expect(fitsInBudget(budget - WORST_CASE_MS, budget)).toBe(true)
    expect(fitsInBudget(budget - WORST_CASE_MS + 1, budget)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run benchmark/true/polyglot/records.test.ts`
Expected: FAIL — cannot resolve `./records.js`

- [ ] **Step 3: Implement**

```ts
// benchmark/true/polyglot/records.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExerciseRecord } from './types.js'

/** Durable per-exercise result: appended immediately, never rewritten. */
export function appendRecord(path: string, record: ExerciseRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + '\n')
}

export function loadRecords(path: string): ExerciseRecord[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

export function completedKeys(records: ExerciseRecord[]): Set<string> {
  return new Set(records.map((r) => `${r.language}/${r.exercise}`))
}

/**
 * Conservative per-exercise ceiling: 2 tries x 8 min model + 2 x 5 min tests.
 * The chunk scheduler refuses to start an exercise that could overrun the
 * budget, so a chunk may end early but never runs long.
 */
export const WORST_CASE_MS = 2 * 8 * 60_000 + 2 * 5 * 60_000 // 26 min

export function fitsInBudget(elapsedMs: number, budgetMs: number, worstCaseMs = WORST_CASE_MS): boolean {
  return elapsedMs + worstCaseMs <= budgetMs
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run benchmark/true/polyglot/records.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/polyglot/records.ts benchmark/true/polyglot/records.test.ts
git commit -m "feat(polyglot): durable JSONL records, resume keys, budget scheduler"
```

---

### Task 7: report.ts — chunk summary + leaderboard comparison

**Files:**
- Create: `benchmark/true/polyglot/report.ts`
- Test: `benchmark/true/polyglot/report.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// benchmark/true/polyglot/report.test.ts
import { describe, it, expect } from 'vitest'
import { summarize, formatReport } from './report.js'
import type { ExerciseRecord } from './types.js'

const rec = (over: Partial<ExerciseRecord>): ExerciseRecord => ({
  language: 'python', exercise: 'x', passed: false, passedTry: null,
  durationMs: 1000, tryDurationsMs: [1000], testDurationMs: 100, ...over,
})

describe('summarize', () => {
  it('computes pass@1, pass@2, per-language breakdown, env failures, timeouts', () => {
    const records = [
      rec({ exercise: 'a', passed: true, passedTry: 1 }),
      rec({ exercise: 'b', passed: true, passedTry: 2 }),
      rec({ exercise: 'c' }),
      rec({ language: 'go', exercise: 'd', envFailure: true }),
      rec({ language: 'go', exercise: 'e', error: 'try timeout' }),
    ]
    const s = summarize(records)
    expect(s.total).toBe(5)
    expect(s.passed).toBe(2) // pass@2 headline
    expect(s.passedTry1).toBe(1) // pass@1
    expect(s.envFailures).toBe(1)
    expect(s.byLanguage.python).toEqual({ total: 3, passed: 2 })
    expect(s.byLanguage.go).toEqual({ total: 2, passed: 0 })
  })
})

describe('formatReport', () => {
  it('shows progress out of 225 and running pass@2', () => {
    const out = formatReport(summarize([rec({ passed: true, passedTry: 1 })]), 'test-model')
    expect(out).toContain('1/225')
    expect(out).toContain('pass@2')
    expect(out).toContain('test-model')
    expect(out).not.toContain('Leaderboard') // not complete yet
  })

  it('adds the leaderboard comparison once all 225 are recorded', () => {
    const records = Array.from({ length: 225 }, (_, i) =>
      rec({ exercise: `e${i}`, passed: i < 90, passedTry: i < 90 ? 1 : null }),
    )
    const out = formatReport(summarize(records), 'test-model')
    expect(out).toContain('Leaderboard')
    expect(out).toContain('40.0%')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run benchmark/true/polyglot/report.test.ts`
Expected: FAIL — cannot resolve `./report.js`

- [ ] **Step 3: Implement**

```ts
// benchmark/true/polyglot/report.ts
import type { ExerciseRecord } from './types.js'

export const TOTAL_EXERCISES = 225

export interface Summary {
  total: number
  passed: number // pass@2 (headline)
  passedTry1: number // pass@1
  envFailures: number
  timeouts: number
  byLanguage: Record<string, { total: number; passed: number }>
}

export function summarize(records: ExerciseRecord[]): Summary {
  const s: Summary = { total: 0, passed: 0, passedTry1: 0, envFailures: 0, timeouts: 0, byLanguage: {} }
  for (const r of records) {
    s.total++
    if (r.passed) s.passed++
    if (r.passedTry === 1) s.passedTry1++
    if (r.envFailure) s.envFailures++
    if (r.error?.includes('timeout')) s.timeouts++
    const lang = (s.byLanguage[r.language] ??= { total: 0, passed: 0 })
    lang.total++
    if (r.passed) lang.passed++
  }
  return s
}

// Aider leaderboard reference points (polyglot, pass@2).
const LEADERBOARD: Array<[string, number]> = [
  ['gemma-3-27b-it (aider)', 4.9],
  ['Qwen3-32B (aider)', 45.8],
  ['GPT-4o (aider)', 73.7],
]

const pct = (n: number, d: number) => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1))

export function formatReport(s: Summary, model: string): string {
  const lines: string[] = []
  lines.push(`Polyglot progress — model: ${model}`)
  lines.push(`  recorded: ${s.total}/${TOTAL_EXERCISES}`)
  lines.push(`  pass@2: ${s.passed}/${s.total} (${pct(s.passed, s.total)}%)   pass@1: ${s.passedTry1}/${s.total} (${pct(s.passedTry1, s.total)}%)`)
  lines.push(`  env failures: ${s.envFailures}   timeouts: ${s.timeouts}`)
  for (const [lang, v] of Object.entries(s.byLanguage).sort()) {
    lines.push(`  ${lang.padEnd(12)} ${v.passed}/${v.total} (${pct(v.passed, v.total)}%)`)
  }
  if (s.total >= TOTAL_EXERCISES) {
    lines.push('')
    lines.push('Leaderboard comparison (pass@2):')
    for (const [name, score] of LEADERBOARD) lines.push(`  ${name.padEnd(28)} ${score}%`)
    lines.push(`  ${`${model} (CynCo)`.padEnd(28)} ${pct(s.passed, s.total)}%`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run benchmark/true/polyglot/report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/polyglot/report.ts benchmark/true/polyglot/report.test.ts
git commit -m "feat(polyglot): summary + leaderboard report"
```

---

### Task 8: Dockerfile + container.ts

**Files:**
- Create: `benchmark/true/polyglot/Dockerfile`
- Create: `benchmark/true/polyglot/container.ts`
- Test: `benchmark/true/polyglot/container.test.ts` (gated on docker)

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# benchmark/true/polyglot/Dockerfile
# Test-toolchain image for the aider polyglot benchmark. The agent never runs
# in here — only the hidden-test commands do. Toolchain versions are whatever
# Ubuntu 24.04 / NodeSource 22 / rustup pin below resolve to; record the
# actual versions in the README when the image is built.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git bash \
    python3 python3-pytest \
    golang-go \
    openjdk-21-jdk-headless \
    cmake g++ make \
    && rm -rf /var/lib/apt/lists/*
# Node 22 (exercism JS needs jest 29 -> node >= 18)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
# Rust via rustup, pinned for reproducibility
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain 1.83.0 --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /bench
CMD ["sleep", "infinity"]
```

- [ ] **Step 2: Write the gated failing test**

```ts
// benchmark/true/polyglot/container.test.ts
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureImage, startContainer, stopContainer, execInContainer } from './container.js'

const dockerPresent = spawnSync('docker', ['version'], { encoding: 'utf-8' }).status === 0

// Live integration test — same gating style as other docker/live suites.
describe.skipIf(!dockerPresent)('container lifecycle', () => {
  it('builds image, starts, execs a test command in a mounted workdir, stops', () => {
    ensureImage(import.meta.dirname)
    const scratch = mkdtempSync(join(tmpdir(), 'polyglot-ct-'))
    const work = join(scratch, 'python-demo')
    mkdirSync(work)
    writeFileSync(join(work, 'demo_test.py'), 'def test_ok():\n    assert 1 + 1 == 2\n')
    startContainer(scratch)
    try {
      const ok = execInContainer('python-demo', 'python3 -m pytest -x -q', 60_000)
      expect(ok.code).toBe(0)
      expect(ok.timedOut).toBe(false)
      const fail = execInContainer('python-demo', 'python3 -m pytest -x -q --nonexistent-flag', 60_000)
      expect(fail.code).not.toBe(0)
      expect(fail.output.length).toBeGreaterThan(0)
    } finally {
      stopContainer()
    }
  }, 900_000) // first image build can take many minutes
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run benchmark/true/polyglot/container.test.ts`
Expected: FAIL — cannot resolve `./container.js` (docker is present on this machine)

- [ ] **Step 4: Implement container.ts**

```ts
// benchmark/true/polyglot/container.ts
import { spawnSync } from 'node:child_process'

const IMAGE = 'polyglot-bench'
const NAME = 'polyglot-bench-run'
// Named volumes: warm toolchain caches persist across chunks/containers.
const CACHE_VOLUMES = [
  'polyglot-gradle:/root/.gradle',
  'polyglot-cargo:/root/.cargo/registry',
  'polyglot-go:/root/go',
  'polyglot-npm:/root/.npm',
]

function docker(args: string[], timeoutMs?: number) {
  return spawnSync('docker', args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
}

/** Build the polyglot-bench image if it doesn't exist yet. */
export function ensureImage(dockerfileDir: string): void {
  if (docker(['image', 'inspect', IMAGE]).status === 0) return
  console.log(`[polyglot] building ${IMAGE} image (one-time, several minutes)...`)
  const res = spawnSync('docker', ['build', '-t', IMAGE, dockerfileDir], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`docker build failed (exit ${res.status})`)
}

/** Start one long-lived container with the scratch root mounted at /bench. */
export function startContainer(scratchRoot: string): void {
  docker(['rm', '-f', NAME]) // ignore result: may not exist
  const args = ['run', '-d', '--name', NAME, '-v', `${scratchRoot}:/bench`]
  for (const vol of CACHE_VOLUMES) args.push('-v', vol)
  args.push(IMAGE)
  const res = docker(args, 120_000)
  if (res.status !== 0) {
    throw new Error(`failed to start ${NAME}: ${res.stderr || res.stdout}`)
  }
}

export function stopContainer(): void {
  docker(['rm', '-f', NAME])
}

export interface ExecResult {
  code: number
  output: string // stdout + stderr interleaved-ish (stdout first)
  timedOut: boolean
  durationMs: number
}

/** Run a test command inside /bench/<workdirName> with a hard timeout. */
export function execInContainer(workdirName: string, command: string, timeoutMs: number): ExecResult {
  const start = Date.now()
  const res = docker(
    ['exec', '-w', `/bench/${workdirName}`, NAME, 'bash', '-lc', command],
    timeoutMs,
  )
  const timedOut = res.error?.name === 'Error' && /ETIMEDOUT/.test(String((res.error as any).code ?? res.error.message))
  return {
    code: res.status ?? -1,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    timedOut: timedOut || (res.status === null && !!res.error),
    durationMs: Date.now() - start,
  }
}

/**
 * Environmental-failure taxonomy (spec): infra problems, not model failures.
 * Still counted as failures in the headline; flagged for --resume re-runs.
 */
export function isEnvFailure(res: ExecResult): boolean {
  if (res.timedOut) return true
  if ([125, 126, 127].includes(res.code)) return true // docker/daemon/toolchain-missing
  if (/command not found|No such container|error during connect/i.test(res.output)) return true
  return false
}
```

- [ ] **Step 5: Run the gated test to verify it passes**

Run: `npx vitest run benchmark/true/polyglot/container.test.ts`
Expected: PASS (builds the image on first run — allow up to 15 min; the 900s test timeout covers it)

- [ ] **Step 6: Commit**

```bash
git add benchmark/true/polyglot/Dockerfile benchmark/true/polyglot/container.ts benchmark/true/polyglot/container.test.ts
git commit -m "feat(polyglot): docker test-toolchain image + container lifecycle"
```

---

### Task 9: runLoop.ts — ExerciseSession (same-loop retry)

No unit test (requires a live provider); exercised by `--smoke`. Keep it tiny and
identical in shape to `benchmark/true/harness/driver.ts`.

**Files:**
- Create: `benchmark/true/polyglot/runLoop.ts`

- [ ] **Step 1: Implement**

```ts
// benchmark/true/polyglot/runLoop.ts
import type { Provider } from '../../../engine/provider.js'
import { ConversationLoop } from '../../../engine/bridge/conversationLoop.js'
import { S5Orchestrator } from '../../../engine/s5/orchestrator.js'
import { RuleBasedS5 } from '../../../engine/s5/ruleBasedS5.js'

export interface TryResult {
  timedOut: boolean
  error?: string
}

/**
 * One ConversationLoop per exercise, kept alive across both tries so the
 * try-2 error feedback lands in the SAME conversation (aider's pass@2
 * protocol). Loop construction mirrors benchmark/true/harness/driver.ts:
 * approveAll, noScouts, silent emitter, S5 governance active (as-shipped).
 */
export class ExerciseSession {
  private loop: ConversationLoop

  constructor(opts: { config: any; provider: Provider; cwd: string }) {
    const s5 = new S5Orchestrator(new RuleBasedS5())
    this.loop = new ConversationLoop({
      config: { ...opts.config, approveAll: true, noScouts: true },
      provider: opts.provider,
      emit: () => {},
      cwd: opts.cwd,
      s5,
    })
  }

  /** Send one try. A timeout aborts the loop but keeps the session usable-enough to record. */
  async sendTry(prompt: string, timeoutMs: number): Promise<TryResult> {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.loop.abort()
    }, timeoutMs)
    try {
      await this.loop.handleUserMessage(prompt)
    } catch (err) {
      return { timedOut, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
    return timedOut ? { timedOut, error: 'try timeout' } : { timedOut: false }
  }
}
```

- [ ] **Step 2: Typecheck it compiles against the real engine**

Run: `bun -e "await import('./benchmark/true/polyglot/runLoop.ts'); console.log('OK')"`
Expected: prints `OK` — proves the engine imports (ConversationLoop, S5Orchestrator, RuleBasedS5, Provider) resolve against the real engine layout

- [ ] **Step 3: Commit**

```bash
git add benchmark/true/polyglot/runLoop.ts
git commit -m "feat(polyglot): ExerciseSession — same-loop pass@2 retry"
```

---

### Task 10: run.ts — chunked CLI orchestrator

Thin wiring over the tested modules. No unit test; validated by `--smoke`.

**Files:**
- Create: `benchmark/true/polyglot/run.ts`

- [ ] **Step 1: Implement**

```ts
// benchmark/true/polyglot/run.ts
// CLI: bun benchmark/true/polyglot/run.ts [--lang go] [--exercise bowling]
//        [--smoke] [--resume] [--budget 60] [--out path.jsonl]
// Chunked execution: runs until the time budget can't fit another exercise
// (conservative worst case), then reports and exits. Re-run with --resume
// to continue. All state lives in the JSONL.
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../../engine/config.js'
import { bootstrapProvider } from '../../../engine/bootstrapProvider.js'
import { LANGUAGES, type Exercise, type ExerciseRecord, type Language } from './types.js'
import {
  assertPristine, buildPrompt, buildRetryPrompt, discoverExercises,
  injectTests, removeTests, stageWorkdir,
} from './exercise.js'
import { appendRecord, completedKeys, fitsInBudget, loadRecords } from './records.js'
import { ensureImage, execInContainer, isEnvFailure, startContainer, stopContainer } from './container.js'
import { ExerciseSession } from './runLoop.js'
import { formatReport, summarize } from './report.js'

const TRY_TIMEOUT_MS = 8 * 60_000
const TEST_TIMEOUT_MS = 5 * 60_000

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name: string) => process.argv.includes(name)

async function main() {
  const exercisesRoot = join(import.meta.dirname, '..', '..', 'polyglot-exercises')
  const resultsDir = join(import.meta.dirname, '..', 'results')
  const smoke = flag('--smoke')
  const budgetMs = parseInt(arg('--budget', '60'), 10) * 60_000
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    console.error('[polyglot] invalid --budget'); process.exit(1)
  }

  const config = loadConfig()
  if (!config.model) {
    console.error('[polyglot] no model configured (set LOCALCODE_MODEL) — refusing to write unattributable evidence')
    process.exit(1)
  }
  const modelSlug = config.model.replace(/[^a-zA-Z0-9._-]/g, '-')
  const outPath = arg('--out', join(resultsDir, `polyglot${smoke ? '-smoke' : ''}-${modelSlug}.jsonl`))
  const logPath = join(resultsDir, `polyglot-${Date.now()}.log`)
  mkdirSync(resultsDir, { recursive: true })
  const log = (msg: string) => { console.log(msg); appendFileSync(logPath, msg + '\n') }

  // Validity gate: mutated stubs/tests would invalidate every result.
  assertPristine(exercisesRoot)

  let exercises = discoverExercises(exercisesRoot, {
    lang: arg('--lang', '') || undefined,
    exercise: arg('--exercise', '') || undefined,
  })
  if (smoke) {
    // 1 exercise per language (alphabetically first) — the pre-flight gate.
    const seen = new Set<Language>()
    exercises = exercises.filter((e) => (seen.has(e.language) ? false : (seen.add(e.language), true)))
  }
  const prior = flag('--resume') ? loadRecords(outPath) : []
  const done = completedKeys(prior)
  const todo = exercises.filter((e) => !done.has(`${e.language}/${e.name}`))
  if (todo.length === 0) { log('[polyglot] nothing to do — all selected exercises recorded'); return }
  log(`[polyglot] ${todo.length} exercise(s) queued (${done.size} already recorded), model=${config.model}, budget=${budgetMs / 60_000}min`)

  const { provider } = await bootstrapProvider(config)

  const scratchRoot = join(tmpdir(), 'cynco-polyglot')
  mkdirSync(scratchRoot, { recursive: true })
  ensureImage(import.meta.dirname)
  startContainer(scratchRoot)

  const chunkStart = Date.now()
  let ranThisChunk = 0
  try {
    for (const ex of todo) {
      if (!fitsInBudget(Date.now() - chunkStart, budgetMs)) {
        log(`[polyglot] budget reached — stopping chunk cleanly (${ranThisChunk} exercise(s) this chunk)`)
        break
      }
      const rec = await runExercise(ex, config, provider, log)
      appendRecord(outPath, rec)
      ranThisChunk++
      log(`[polyglot] ${rec.passed ? 'PASS' : 'FAIL'}${rec.envFailure ? ' (env)' : ''} ${ex.language}/${ex.name} try=${rec.passedTry ?? '-'} ${(rec.durationMs / 1000).toFixed(0)}s`)
    }
  } finally {
    stopContainer()
  }

  const all = loadRecords(outPath)
  log('')
  log(formatReport(summarize(all), config.model))
  const remaining = exercises.length - all.length
  if (remaining > 0) {
    log(`\n[polyglot] ${remaining} exercise(s) remaining — continue with:`)
    log(`  bun benchmark/true/polyglot/run.ts --resume --budget ${budgetMs / 60_000}${smoke ? ' --smoke' : ''}`)
  }
  log(`[polyglot] results: ${outPath}`)
  log(`[polyglot] log: ${logPath}`)
}

async function runExercise(
  ex: Exercise,
  config: any,
  provider: any,
  log: (m: string) => void,
): Promise<ExerciseRecord> {
  const start = Date.now()
  const scratchRoot = join(tmpdir(), 'cynco-polyglot')
  const workdirName = `${ex.language}-${ex.name}`
  const workdir = stageWorkdir(ex, scratchRoot)
  const session = new ExerciseSession({ config, provider, cwd: workdir })
  const testCommand = LANGUAGES[ex.language].testCommand

  const tryDurationsMs: number[] = []
  let testDurationMs = 0
  let error: string | undefined
  let envFailure = false

  const runTests = () => {
    injectTests(ex, workdir)
    const res = execInContainer(workdirName, testCommand, TEST_TIMEOUT_MS)
    removeTests(ex, workdir)
    testDurationMs += res.durationMs
    // Spec: container death is fatal (fail fast, --resume continues after restart).
    if (/No such container/i.test(res.output)) {
      throw new Error('polyglot-bench container died mid-run — restart and re-run with --resume')
    }
    if (isEnvFailure(res)) envFailure = true
    return res
  }

  const finish = (passed: boolean, passedTry: 1 | 2 | null): ExerciseRecord => {
    rmSync(workdir, { recursive: true, force: true })
    return {
      language: ex.language, exercise: ex.name, passed, passedTry,
      durationMs: Date.now() - start, tryDurationsMs, testDurationMs,
      ...(error ? { error } : {}), ...(envFailure ? { envFailure: true } : {}),
    }
  }

  // Try 1: aider's exercise prompt.
  log(`[polyglot] ${ex.language}/${ex.name} try 1...`)
  const t1 = Date.now()
  const try1 = await session.sendTry(buildPrompt(ex), TRY_TIMEOUT_MS)
  tryDurationsMs.push(Date.now() - t1)
  if (try1.error) error = try1.error
  const test1 = runTests()
  if (test1.code === 0) return finish(true, 1)

  // Try 2: test output into the SAME loop (aider pass@2).
  log(`[polyglot] ${ex.language}/${ex.name} try 2 (tests failed)...`)
  const t2 = Date.now()
  const try2 = await session.sendTry(buildRetryPrompt(ex.solutionFiles, test1.output), TRY_TIMEOUT_MS)
  tryDurationsMs.push(Date.now() - t2)
  if (try2.error) error = [error, try2.error].filter(Boolean).join(' | ')
  const test2 = runTests()
  if (test2.code === 0) return finish(true, 2)
  return finish(false, null)
}

main().catch((err) => {
  console.error('[polyglot] fatal:', err)
  stopContainer()
  process.exit(1)
})
```

- [ ] **Step 2: Verify it compiles and fails fast without a model**

Run: `LOCALCODE_MODEL= bun benchmark/true/polyglot/run.ts 2>&1 | head -3`
Expected: `[polyglot] no model configured ...` and exit 1 (proves imports resolve and the guard works — no provider or docker touched)

- [ ] **Step 3: Commit**

```bash
git add benchmark/true/polyglot/run.ts
git commit -m "feat(polyglot): chunked CLI orchestrator (--budget, --resume, --smoke)"
```

---

### Task 11: README.md (reproduction instructions)

**Files:**
- Create: `benchmark/true/polyglot/README.md`

- [ ] **Step 1: Write the README**

Content must cover, concretely (no placeholders):
- What this measures: aider polyglot, 225 exercises, pass@2 protocol, headline number definition, envFailure taxonomy (counted in headline, listed separately).
- Anti-cheat guarantees (the 4 from the spec: no `.meta`, tests only between tries + overwrite-clobber, as-shipped config, raw data in git).
- Requirements: Docker Desktop, Bun, exercises checkout at `benchmark/polyglot-exercises` (aider `polyglot-benchmark` repo URL + the pinned commit — read it with `git -C benchmark/polyglot-exercises rev-parse HEAD` and paste the actual SHA).
- How to run: image build (automatic), `--smoke` first, then chunked full run: `bun benchmark/true/polyglot/run.ts --resume --budget 60` repeated until 225/225; interrupt-safe.
- Where results land (`benchmark/true/results/polyglot-<model>.jsonl` + logs) and the JSONL record schema (copy the `ExerciseRecord` fields).
- Toolchain versions: after the image is built, run `docker run --rm polyglot-bench bash -lc "python3 --version && node --version && go version && rustc --version && java --version | head -1 && cmake --version | head -1 && g++ --version | head -1"` and paste the actual output.

- [ ] **Step 2: Commit**

```bash
git add benchmark/true/polyglot/README.md
git commit -m "docs(polyglot): reproduction instructions"
```

---

### Task 12: Wire check (BLOCKING) + full suite

**Files:** none new — verification only.

- [ ] **Step 1: Grep every new exported symbol and verify it is imported/called somewhere real**

For each symbol, `grep -rn <symbol> benchmark/true/polyglot/` must show at least one
NON-definition, NON-test usage (run.ts wiring counts; container.test.ts counts only
for the container lifecycle fns it exists to gate):

`discoverExercises, assertPristine, stageWorkdir, injectTests, removeTests, unskip,
buildPrompt, buildRetryPrompt, appendRecord, loadRecords, completedKeys,
fitsInBudget, WORST_CASE_MS, summarize, formatReport, TOTAL_EXERCISES, ensureImage,
startContainer, stopContainer, execInContainer, isEnvFailure, ExerciseSession,
LANGUAGES, Exercise, ExerciseRecord, Language`

Any symbol used only by its own tests = unwired → wire it into run.ts or delete it.
(`unskip` is used by `injectTests` — internal use counts.)

- [ ] **Step 2: Full vitest suite**

Run: `npm test`
Expected: all suites pass (including the pre-existing 1736); no new failures. The
docker-gated container test runs (docker is present) — allow its build time.

- [ ] **Step 3: Confirm results dir + gitignore behavior**

```bash
git check-ignore -v benchmark/true/polyglot/run.ts && echo "PROBLEM: ignored" || echo OK
git status --short   # only intended files
```

- [ ] **Step 4: Commit anything outstanding**

```bash
git status --short
# if clean, done; otherwise add + commit with an accurate message
```

---

## After implementation (execution plan — from the spec, not part of this coding plan)

1. `--smoke` (6 exercises, one per language, ~1h budget) against the real model —
   iterate on the image until all 6 produce valid results (pass/fail fine;
   envFailure not).
2. Chunked full run: user triggers `bun benchmark/true/polyglot/run.ts --resume --budget 60`
   repeatedly (~20-40 chunks). Each chunk ends with a progress report.
3. At 225/225: final report, publish JSONL + README, update the Reddit draft.

## Self-review notes

- Spec coverage: discovery/staging/inject/prompt (exercise.ts, Tasks 2-5), JSONL +
  resume + budget (Task 6), reporting incl. leaderboard (Task 7), container (Task 8),
  same-loop retry (Task 9), CLI with --lang/--exercise/--resume/--smoke/--budget
  (Task 10), README (Task 11), wire check (Task 12), old-adapter retirement +
  pristine restore (Task 1). Unit-test list from the spec all present; spec's
  `__tests__/` dir replaced by the repo's colocated `.test.ts` convention.
- Types consistent across tasks: `Exercise`/`ExerciseRecord` defined once in
  types.ts; run.ts uses only symbols defined in earlier tasks.
- Known judgment calls (documented for reviewers): `bash gradlew` (Windows exec
  bit), unskip transforms applied at inject time (aider parity), envFailure
  heuristic = timeout / exit 125-127 / connect-or-toolchain markers.
