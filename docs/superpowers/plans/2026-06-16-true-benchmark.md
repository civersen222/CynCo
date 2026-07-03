# True Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully standalone, version-controlled harness that measures the *current, wired* VSM governance layer by running real tasks governed vs ungoverned (`_ABLATION_VSM_DISABLED=1`) with N=3 repeats and reports pass-rate confidence intervals, scored by objective pytest exit codes — replacing the retracted April numbers.

**Architecture:** A new `benchmark/true/` tree with zero dependency on the existing `benchmark/` code. Pure-logic modules (stats, isolation, scoring, task loading, env toggling) are unit-tested under vitest. A driver constructs the real `ConversationLoop` (the system under test) against an isolated temp clone of the CivKings repo, toggling the ablation env var. An orchestrator runs the N×conditions×tasks matrix and writes a committed results JSON. This plan delivers **Layer A** (CivKings self-ablation) completely and shippably; **Layer B** (SWE-bench absolute scorecard) is a delineated follow-up at the end.

**Tech Stack:** TypeScript (Bun runtime), vitest (test runner, `vitest run`), Node `child_process` for git/pytest, the engine's `ConversationLoop` + `loadConfig` + `createProvider('ollama', …)`, Python/pytest (CivKings, headless via `SDL_VIDEODRIVER=dummy`), Ollama model `qwen3.6`.

**Spec:** `docs/superpowers/specs/2026-06-16-true-benchmark-design.md`

---

## File Structure

```
benchmark/true/
  harness/
    types.ts            # shared TaskDef / RunRecord / SuiteResult types
    stats.ts            # wilsonInterval, pairedBootstrapLift  (pure, unit-tested)
    stats.test.ts
    isolate.ts          # cloneRepo, checkoutRef, applyPatch   (git wrappers, unit-tested)
    isolate.test.ts
    scorer.ts           # scorePytest                          (pytest wrapper, unit-tested)
    scorer.test.ts
    ablationEnv.ts      # withAblationEnv                       (pure env toggle, unit-tested)
    ablationEnv.test.ts
    tasks.ts            # loadCivkingsTasks                     (loader, unit-tested)
    tasks.test.ts
    driver.ts           # runTask -> drives real ConversationLoop (integration only)
    orchestrate.ts      # runSuite -> N×conditions×tasks matrix + stats
  tasks/civkings/
    <task-id>/task.json, hidden_test.py, setup.patch?, notes.md
  results/.gitkeep
  run.ts                # CLI entrypoint: bootstrap config/provider, runSuite, write JSON
```

vitest only discovers `engine/__tests__/**`, so **Task 0 extends the include glob** to also pick up `benchmark/true/**/*.test.ts`.

---

## Task 0: Wire benchmark tests into vitest

**Files:**
- Modify: `vitest.config.ts:9` (the `include` array)
- Create: `benchmark/true/harness/smoke.test.ts` (temporary sentinel, deleted in Task 1)

- [ ] **Step 1: Add a sentinel test that proves discovery**

Create `benchmark/true/harness/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('benchmark/true discovery', () => {
  it('is picked up by vitest', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 2: Run it and confirm it is NOT yet discovered**

Run: `npx vitest run benchmark/true/harness/smoke.test.ts`
Expected: error / "No test files found" (the include glob excludes this path).

- [ ] **Step 3: Extend the include glob**

In `vitest.config.ts`, change:

```ts
    include: ['engine/__tests__/**/*.test.ts'],
```
to:
```ts
    include: ['engine/__tests__/**/*.test.ts', 'benchmark/true/**/*.test.ts'],
```

- [ ] **Step 4: Run again, confirm pass**

Run: `npx vitest run benchmark/true/harness/smoke.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts benchmark/true/harness/smoke.test.ts
git commit -m "test: discover benchmark/true tests under vitest"
```

---

## Task 1: Shared types

**Files:**
- Create: `benchmark/true/harness/types.ts`
- Delete: `benchmark/true/harness/smoke.test.ts` (sentinel no longer needed)

- [ ] **Step 1: Write the types module**

Create `benchmark/true/harness/types.ts`:

```ts
export type Condition = 'governed' | 'ungoverned'

export interface TaskDef {
  id: string
  prompt: string
  startRef: string          // git ref to check out in the isolated clone
  setupPatch?: string       // absolute path to a patch applied after checkout (optional)
  hiddenTestPath: string    // absolute path to the scoring pytest file (never shown to the agent)
  hiddenTestName: string    // filename to copy the hidden test to inside the clone, e.g. "hidden_test.py"
  timeoutMs: number
  source: 'mined' | 'authored'
}

export interface RunRecord {
  taskId: string
  condition: Condition
  rep: number               // 1-based repeat index
  passed: boolean
  timedOut: boolean
  turns: number             // count of assistant messages
}

export interface Interval {
  point: number
  lower: number
  upper: number
}

export interface PerTaskResult {
  taskId: string
  governed: Interval        // pass rate over reps, Wilson CI
  ungoverned: Interval
  lift: number              // governed.point - ungoverned.point
}

export interface SuiteResult {
  model: string
  timestamp: string         // ISO
  repsPerCondition: number
  runs: RunRecord[]
  perTask: PerTaskResult[]
  governedOverall: Interval
  ungovernedOverall: Interval
  liftMean: number
  liftLower: number         // paired-bootstrap CI on mean lift
  liftUpper: number
}
```

- [ ] **Step 2: Delete the sentinel and verify the suite still loads**

```bash
git rm benchmark/true/harness/smoke.test.ts
npx vitest run benchmark/true 2>&1 | tail -5
```
Expected: "No test files found" for `benchmark/true` (no tests yet) — that is fine; the point is no import error.

- [ ] **Step 3: Commit**

```bash
git add benchmark/true/harness/types.ts
git commit -m "feat: shared types for the true benchmark harness"
```

---

## Task 2: Statistics (Wilson interval + paired bootstrap)

**Files:**
- Create: `benchmark/true/harness/stats.ts`
- Test: `benchmark/true/harness/stats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `benchmark/true/harness/stats.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { wilsonInterval, pairedBootstrapLift } from './stats.js'

describe('wilsonInterval', () => {
  it('computes the 95% interval for 8/10', () => {
    const r = wilsonInterval(8, 10)
    expect(r.point).toBeCloseTo(0.8, 5)
    expect(r.lower).toBeCloseTo(0.490, 2)
    expect(r.upper).toBeCloseTo(0.943, 2)
  })

  it('handles n=0 as the maximally-uncertain interval', () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, lower: 0, upper: 1 })
  })

  it('clamps to [0,1] at the extremes', () => {
    const r = wilsonInterval(3, 3)
    expect(r.point).toBe(1)
    expect(r.upper).toBeLessThanOrEqual(1)
    expect(r.lower).toBeGreaterThan(0)
  })
})

describe('pairedBootstrapLift', () => {
  it('returns the exact value when all task lifts are equal (rng-independent)', () => {
    const r = pairedBootstrapLift([0.5, 0.5, 0.5], 100)
    expect(r.meanLift).toBeCloseTo(0.5, 5)
    expect(r.lower).toBeCloseTo(0.5, 5)
    expect(r.upper).toBeCloseTo(0.5, 5)
  })

  it('computes the mean lift correctly', () => {
    const r = pairedBootstrapLift([1, 0, 1, 0], 100)
    expect(r.meanLift).toBeCloseTo(0.5, 5)
  })

  it('uses the injected rng deterministically', () => {
    // rng always returns 0 -> every resample picks index 0 -> mean = lifts[0]
    const r = pairedBootstrapLift([0.2, 0.9], 50, 0.95, () => 0)
    expect(r.lower).toBeCloseTo(0.2, 5)
    expect(r.upper).toBeCloseTo(0.2, 5)
  })

  it('handles the empty case', () => {
    expect(pairedBootstrapLift([], 10)).toEqual({ meanLift: 0, lower: 0, upper: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run benchmark/true/harness/stats.test.ts`
Expected: FAIL — cannot find module `./stats.js`.

- [ ] **Step 3: Write the implementation**

Create `benchmark/true/harness/stats.ts`:

```ts
import type { Interval } from './types.js'

/** Wilson score interval for a binomial proportion. z=1.96 -> 95%. */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { point: 0, lower: 0, upper: 1 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return {
    point: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  }
}

/**
 * Bootstrap CI on the mean of per-task lifts (governed - ungoverned), resampling
 * tasks with replacement. `confidence` is e.g. 0.95. `rng` is injectable for
 * deterministic tests.
 */
export function pairedBootstrapLift(
  perTaskLifts: number[],
  iterations = 10000,
  confidence = 0.95,
  rng: () => number = Math.random,
): { meanLift: number; lower: number; upper: number } {
  const k = perTaskLifts.length
  if (k === 0) return { meanLift: 0, lower: 0, upper: 0 }
  const meanLift = perTaskLifts.reduce((a, b) => a + b, 0) / k
  const means: number[] = []
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < k; j++) sum += perTaskLifts[Math.floor(rng() * k)]
    means.push(sum / k)
  }
  means.sort((a, b) => a - b)
  const alpha = (1 - confidence) / 2
  const lowerIdx = Math.floor(alpha * iterations)
  const upperIdx = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1)
  return { meanLift, lower: means[lowerIdx], upper: means[upperIdx] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run benchmark/true/harness/stats.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/harness/stats.ts benchmark/true/harness/stats.test.ts
git commit -m "feat: Wilson interval + paired-bootstrap lift for the true benchmark"
```

---

## Task 3: Ablation env toggle

**Files:**
- Create: `benchmark/true/harness/ablationEnv.ts`
- Test: `benchmark/true/harness/ablationEnv.test.ts`

The engine reads `process.env._ABLATION_VSM_DISABLED` at `ConversationLoop` construction. This helper guarantees the var is set correctly for the arm and **always cleared afterward**, even on throw.

- [ ] **Step 1: Write the failing test**

Create `benchmark/true/harness/ablationEnv.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { withAblationEnv } from './ablationEnv.js'

const KEY = '_ABLATION_VSM_DISABLED'

describe('withAblationEnv', () => {
  beforeEach(() => { delete process.env[KEY] })

  it('sets the flag to "1" inside the ungoverned arm', async () => {
    let seen: string | undefined
    await withAblationEnv(false, async () => { seen = process.env[KEY] })
    expect(seen).toBe('1')
  })

  it('deletes the flag inside the governed arm', async () => {
    process.env[KEY] = '1'
    let present = true
    await withAblationEnv(true, async () => { present = KEY in process.env })
    expect(present).toBe(false)
  })

  it('clears the flag after an ungoverned arm completes', async () => {
    await withAblationEnv(false, async () => {})
    expect(KEY in process.env).toBe(false)
  })

  it('clears the flag even when the body throws', async () => {
    await expect(
      withAblationEnv(false, async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')
    expect(KEY in process.env).toBe(false)
  })

  it('returns the body result', async () => {
    const r = await withAblationEnv(true, async () => 42)
    expect(r).toBe(42)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run benchmark/true/harness/ablationEnv.test.ts`
Expected: FAIL — cannot find module `./ablationEnv.js`.

- [ ] **Step 3: Write the implementation**

Create `benchmark/true/harness/ablationEnv.ts`:

```ts
const KEY = '_ABLATION_VSM_DISABLED'

/**
 * Run `body` with the VSM ablation flag set for the given arm, restoring the
 * environment afterward. governed=true -> flag deleted; governed=false -> flag='1'.
 */
export async function withAblationEnv<T>(governed: boolean, body: () => Promise<T>): Promise<T> {
  if (governed) delete process.env[KEY]
  else process.env[KEY] = '1'
  try {
    return await body()
  } finally {
    delete process.env[KEY]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run benchmark/true/harness/ablationEnv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/harness/ablationEnv.ts benchmark/true/harness/ablationEnv.test.ts
git commit -m "feat: scoped VSM ablation env toggle for the true benchmark"
```

---

## Task 4: Repo isolation (git clone / checkout / apply)

**Files:**
- Create: `benchmark/true/harness/isolate.ts`
- Test: `benchmark/true/harness/isolate.test.ts`

Each run gets a fresh working copy so governed and ungoverned arms (and the 3 reps) never contaminate each other.

- [ ] **Step 1: Write the failing test**

Create `benchmark/true/harness/isolate.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneRepo, checkoutRef, applyPatch } from './isolate.js'

let srcRepo: string
let firstSha: string

beforeAll(() => {
  // Build a tiny throwaway git repo with two commits.
  srcRepo = mkdtempSync(join(tmpdir(), 'truebench-src-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', srcRepo, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(srcRepo, 'a.txt'), 'one')
  git('add', '.'); git('commit', '-q', '-m', 'first')
  firstSha = execFileSync('git', ['-C', srcRepo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  writeFileSync(join(srcRepo, 'a.txt'), 'two')
  git('add', '.'); git('commit', '-q', '-m', 'second')
})

afterAll(() => { rmSync(srcRepo, { recursive: true, force: true }) })

describe('isolate', () => {
  it('clones into a fresh dir with the working tree present', () => {
    const dest = mkdtempSync(join(tmpdir(), 'truebench-dst-'))
    cloneRepo(srcRepo, dest)
    expect(existsSync(join(dest, 'a.txt'))).toBe(true)
    expect(readFileSync(join(dest, 'a.txt'), 'utf-8')).toBe('two')
    rmSync(dest, { recursive: true, force: true })
  })

  it('checks out an earlier ref', () => {
    const dest = mkdtempSync(join(tmpdir(), 'truebench-dst-'))
    cloneRepo(srcRepo, dest)
    checkoutRef(dest, firstSha)
    expect(readFileSync(join(dest, 'a.txt'), 'utf-8')).toBe('one')
    rmSync(dest, { recursive: true, force: true })
  })

  it('applies a patch to the working tree', () => {
    const dest = mkdtempSync(join(tmpdir(), 'truebench-dst-'))
    cloneRepo(srcRepo, dest)
    const patch = mkdtempSync(join(tmpdir(), 'truebench-patch-'))
    const patchFile = join(patch, 'p.patch')
    // patch that changes a.txt from "two" to "three"
    writeFileSync(
      patchFile,
      ['diff --git a/a.txt b/a.txt',
       'index 0000000..0000000 100644',
       '--- a/a.txt',
       '+++ b/a.txt',
       '@@ -1 +1 @@',
       '-two',
       '\\ No newline at end of file',
       '+three',
       '\\ No newline at end of file',
       ''].join('\n'),
    )
    applyPatch(dest, patchFile)
    expect(readFileSync(join(dest, 'a.txt'), 'utf-8')).toBe('three')
    rmSync(dest, { recursive: true, force: true })
    rmSync(patch, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run benchmark/true/harness/isolate.test.ts`
Expected: FAIL — cannot find module `./isolate.js`.

- [ ] **Step 3: Write the implementation**

Create `benchmark/true/harness/isolate.ts`:

```ts
import { execFileSync } from 'node:child_process'

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

/** Clone `srcRepo` into `destDir` (must be empty/new) with a real working tree. */
export function cloneRepo(srcRepo: string, destDir: string): void {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', srcRepo, destDir], { stdio: 'pipe' })
}

/** Detach-checkout the given ref inside an existing clone. */
export function checkoutRef(dir: string, ref: string): void {
  git(dir, ['checkout', '--quiet', ref])
}

/** Apply a patch file to the working tree of an existing clone. */
export function applyPatch(dir: string, patchFile: string): void {
  git(dir, ['apply', patchFile])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run benchmark/true/harness/isolate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/harness/isolate.ts benchmark/true/harness/isolate.test.ts
git commit -m "feat: git-based repo isolation for per-run benchmark clones"
```

---

## Task 5: Pytest scorer

**Files:**
- Create: `benchmark/true/harness/scorer.ts`
- Test: `benchmark/true/harness/scorer.test.ts`

The hidden test is copied into the clone **only at scoring time** so the agent cannot target it. Pass = pytest exit 0. Runs headless via `SDL_VIDEODRIVER=dummy`.

- [ ] **Step 1: Write the failing test**

Create `benchmark/true/harness/scorer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scorePytest } from './scorer.js'

describe('scorePytest', () => {
  it('passes when the injected test passes against the workdir code', () => {
    const work = mkdtempSync(join(tmpdir(), 'truebench-work-'))
    writeFileSync(join(work, 'mod.py'), 'def add(a, b):\n    return a + b\n')
    const hidden = mkdtempSync(join(tmpdir(), 'truebench-hidden-'))
    const hiddenTest = join(hidden, 'hidden_test.py')
    writeFileSync(hiddenTest, 'from mod import add\n\ndef test_add():\n    assert add(2, 3) == 5\n')

    const r = scorePytest(work, hiddenTest, 'hidden_test.py')
    expect(r.passed).toBe(true)
    rmSync(work, { recursive: true, force: true })
    rmSync(hidden, { recursive: true, force: true })
  })

  it('fails when the code does not satisfy the injected test', () => {
    const work = mkdtempSync(join(tmpdir(), 'truebench-work-'))
    writeFileSync(join(work, 'mod.py'), 'def add(a, b):\n    return a - b\n')
    const hidden = mkdtempSync(join(tmpdir(), 'truebench-hidden-'))
    const hiddenTest = join(hidden, 'hidden_test.py')
    writeFileSync(hiddenTest, 'from mod import add\n\ndef test_add():\n    assert add(2, 3) == 5\n')

    const r = scorePytest(work, hiddenTest, 'hidden_test.py')
    expect(r.passed).toBe(false)
    rmSync(work, { recursive: true, force: true })
    rmSync(hidden, { recursive: true, force: true })
  })

  it('cleans up the injected test file from the workdir after scoring', () => {
    const work = mkdtempSync(join(tmpdir(), 'truebench-work-'))
    writeFileSync(join(work, 'mod.py'), 'def add(a, b):\n    return a + b\n')
    const hidden = mkdtempSync(join(tmpdir(), 'truebench-hidden-'))
    const hiddenTest = join(hidden, 'hidden_test.py')
    writeFileSync(hiddenTest, 'from mod import add\n\ndef test_add():\n    assert add(2, 3) == 5\n')

    scorePytest(work, hiddenTest, 'hidden_test.py')
    expect(existsSync(join(work, 'hidden_test.py'))).toBe(false)
    rmSync(work, { recursive: true, force: true })
    rmSync(hidden, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run benchmark/true/harness/scorer.test.ts`
Expected: FAIL — cannot find module `./scorer.js`.

- [ ] **Step 3: Write the implementation**

Create `benchmark/true/harness/scorer.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface ScoreResult {
  passed: boolean
  output: string
}

/**
 * Copy the hidden test into `workdir`, run pytest on just that file headlessly,
 * remove it, and report pass (exit 0) / fail. The hidden test never exists in the
 * workdir while the agent is running.
 */
export function scorePytest(workdir: string, hiddenTestPath: string, hiddenTestName: string): ScoreResult {
  const dest = join(workdir, hiddenTestName)
  copyFileSync(hiddenTestPath, dest)
  try {
    const res = spawnSync('python', ['-m', 'pytest', hiddenTestName, '-q'], {
      cwd: workdir,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy' },
      encoding: 'utf-8',
      timeout: 120_000,
    })
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
    return { passed: res.status === 0, output }
  } finally {
    rmSync(dest, { force: true })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run benchmark/true/harness/scorer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/harness/scorer.ts benchmark/true/harness/scorer.test.ts
git commit -m "feat: hidden-test pytest scorer for the true benchmark"
```

---

## Task 6: Task loader

**Files:**
- Create: `benchmark/true/harness/tasks.ts`
- Test: `benchmark/true/harness/tasks.test.ts`

Loads each `tasks/civkings/<id>/task.json` into a `TaskDef` with absolute paths resolved.

- [ ] **Step 1: Write the failing test**

Create `benchmark/true/harness/tasks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCivkingsTasks } from './tasks.js'

describe('loadCivkingsTasks', () => {
  it('loads task dirs into TaskDefs with resolved absolute paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'truebench-tasks-'))
    const t1 = join(root, 'alpha')
    mkdirSync(t1)
    writeFileSync(join(t1, 'task.json'), JSON.stringify({
      id: 'alpha',
      prompt: 'Do the thing',
      start_ref: '03b4032',
      hidden_test: 'hidden_test.py',
      timeout_ms: 600000,
      source: 'authored',
    }))
    writeFileSync(join(t1, 'hidden_test.py'), 'def test_x():\n    assert True\n')

    const tasks = loadCivkingsTasks(root)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('alpha')
    expect(tasks[0].prompt).toBe('Do the thing')
    expect(tasks[0].startRef).toBe('03b4032')
    expect(tasks[0].hiddenTestName).toBe('hidden_test.py')
    expect(tasks[0].hiddenTestPath).toBe(join(t1, 'hidden_test.py'))
    expect(tasks[0].timeoutMs).toBe(600000)
    expect(tasks[0].setupPatch).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves an optional setup_patch to an absolute path', () => {
    const root = mkdtempSync(join(tmpdir(), 'truebench-tasks-'))
    const t1 = join(root, 'beta')
    mkdirSync(t1)
    writeFileSync(join(t1, 'task.json'), JSON.stringify({
      id: 'beta', prompt: 'p', start_ref: 'HEAD',
      hidden_test: 'hidden_test.py', setup_patch: 'setup.patch',
      timeout_ms: 1000, source: 'mined',
    }))
    writeFileSync(join(t1, 'hidden_test.py'), 'def test_y():\n    assert True\n')
    writeFileSync(join(t1, 'setup.patch'), '')

    const tasks = loadCivkingsTasks(root)
    expect(tasks[0].setupPatch).toBe(join(t1, 'setup.patch'))
    rmSync(root, { recursive: true, force: true })
  })

  it('returns an empty list for an empty tasks dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'truebench-tasks-'))
    expect(loadCivkingsTasks(root)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run benchmark/true/harness/tasks.test.ts`
Expected: FAIL — cannot find module `./tasks.js`.

- [ ] **Step 3: Write the implementation**

Create `benchmark/true/harness/tasks.ts`:

```ts
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskDef } from './types.js'

interface RawTask {
  id: string
  prompt: string
  start_ref: string
  hidden_test: string
  setup_patch?: string
  timeout_ms: number
  source: 'mined' | 'authored'
}

/** Load every `<dir>/<id>/task.json` into a TaskDef with absolute paths resolved. */
export function loadCivkingsTasks(tasksDir: string): TaskDef[] {
  if (!existsSync(tasksDir)) return []
  const out: TaskDef[] = []
  for (const entry of readdirSync(tasksDir)) {
    const dir = join(tasksDir, entry)
    if (!statSync(dir).isDirectory()) continue
    const jsonPath = join(dir, 'task.json')
    if (!existsSync(jsonPath)) continue
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as RawTask
    out.push({
      id: raw.id,
      prompt: raw.prompt,
      startRef: raw.start_ref,
      hiddenTestPath: join(dir, raw.hidden_test),
      hiddenTestName: raw.hidden_test,
      setupPatch: raw.setup_patch ? join(dir, raw.setup_patch) : undefined,
      timeoutMs: raw.timeout_ms,
      source: raw.source,
    })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run benchmark/true/harness/tasks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/harness/tasks.ts benchmark/true/harness/tasks.test.ts
git commit -m "feat: CivKings task loader for the true benchmark"
```

---

## Task 7: Engine driver

**Files:**
- Create: `benchmark/true/harness/driver.ts`

Drives the real `ConversationLoop` against an isolated clone, under the correct ablation arm, with a timeout. No unit test here — the body invokes a live model and is non-deterministic; it is exercised by the end-to-end smoke in Task 9. The pure pieces it composes (`withAblationEnv`) are already unit-tested.

- [ ] **Step 1: Write the driver**

Create `benchmark/true/harness/driver.ts`:

```ts
import type { Provider } from '../../../engine/provider.js'
import type { Message } from '../../../engine/types.js'
import { ConversationLoop } from '../../../engine/bridge/conversationLoop.js'
import { S5Orchestrator } from '../../../engine/s5/orchestrator.js'
import { RuleBasedS5 } from '../../../engine/s5/ruleBasedS5.js'
import { withAblationEnv } from './ablationEnv.js'

export interface DriveResult {
  messages: Message[]
  timedOut: boolean
}

/**
 * Run a single task to completion in `cwd` under the given arm. Mirrors the
 * loop construction used by engine/main.ts --run-ablation (approveAll, noScouts,
 * silent emitter), but with cwd pointed at the isolated clone.
 */
export async function runTask(opts: {
  prompt: string
  cwd: string
  governed: boolean
  config: any
  provider: Provider
  timeoutMs: number
}): Promise<DriveResult> {
  return withAblationEnv(opts.governed, async () => {
    const s5 = new S5Orchestrator(new RuleBasedS5())
    const loop = new ConversationLoop({
      config: { ...opts.config, approveAll: true, noScouts: true },
      provider: opts.provider,
      emit: () => {},
      cwd: opts.cwd,
      s5,
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; loop.abort() }, opts.timeoutMs)
    try {
      await loop.handleUserMessage(opts.prompt)
    } finally {
      clearTimeout(timer)
    }
    return { messages: loop.getMessages(), timedOut }
  })
}

/** Count of assistant messages — used as the secondary `turns` metric. */
export function countTurns(messages: Message[]): number {
  return messages.filter((m) => m.role === 'assistant').length
}
```

- [ ] **Step 2: Type-check the driver compiles against the engine API**

Run: `npx tsc --noEmit -p . 2>&1 | grep -i "benchmark/true/harness/driver" || echo "driver: no type errors"`
Expected: `driver: no type errors`. (If `Message.role` differs, open `engine/types.ts` and align `countTurns`.)

- [ ] **Step 3: Commit**

```bash
git add benchmark/true/harness/driver.ts
git commit -m "feat: ConversationLoop driver for the true benchmark"
```

---

## Task 8: Orchestrator

**Files:**
- Create: `benchmark/true/harness/orchestrate.ts`
- Test: `benchmark/true/harness/orchestrate.test.ts`

Runs the N×conditions×tasks matrix. To keep it unit-testable without a live model, the **run-one-task** step is injected as a function (`RunOne`); the orchestrator owns only isolation lifecycle, scoring aggregation, and statistics.

- [ ] **Step 1: Write the failing test**

Create `benchmark/true/harness/orchestrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './orchestrate.js'
import type { TaskDef } from './types.js'

function fakeTask(id: string): TaskDef {
  return {
    id, prompt: 'p', startRef: 'HEAD', hiddenTestPath: '/x/hidden_test.py',
    hiddenTestName: 'hidden_test.py', timeoutMs: 1000, source: 'authored',
  }
}

describe('runSuite', () => {
  it('runs N reps per condition per task and aggregates a deterministic lift', async () => {
    const tasks = [fakeTask('alpha'), fakeTask('beta')]
    // Injected runner: governed always passes, ungoverned always fails. lift = 1.0.
    const result = await runSuite({
      tasks,
      reps: 3,
      model: 'fake-model',
      runOne: async ({ condition }) => ({ passed: condition === 'governed', timedOut: false, turns: 2 }),
      bootstrapRng: () => 0,
    })

    expect(result.runs).toHaveLength(2 * 2 * 3) // tasks * conditions * reps
    expect(result.repsPerCondition).toBe(3)
    expect(result.governedOverall.point).toBe(1)
    expect(result.ungovernedOverall.point).toBe(0)
    expect(result.liftMean).toBeCloseTo(1, 5)
    for (const pt of result.perTask) {
      expect(pt.governed.point).toBe(1)
      expect(pt.ungoverned.point).toBe(0)
      expect(pt.lift).toBe(1)
    }
  })

  it('reports zero lift when both arms behave identically', async () => {
    const result = await runSuite({
      tasks: [fakeTask('alpha')],
      reps: 2,
      model: 'fake-model',
      runOne: async () => ({ passed: true, timedOut: false, turns: 1 }),
      bootstrapRng: () => 0,
    })
    expect(result.liftMean).toBe(0)
    expect(result.governedOverall.point).toBe(1)
    expect(result.ungovernedOverall.point).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run benchmark/true/harness/orchestrate.test.ts`
Expected: FAIL — cannot find module `./orchestrate.js`.

- [ ] **Step 3: Write the implementation**

Create `benchmark/true/harness/orchestrate.ts`:

```ts
import type { Condition, RunRecord, PerTaskResult, SuiteResult, TaskDef } from './types.js'
import { wilsonInterval, pairedBootstrapLift } from './stats.js'

export interface RunOneArgs {
  task: TaskDef
  condition: Condition
  rep: number
}

export type RunOne = (args: RunOneArgs) => Promise<{ passed: boolean; timedOut: boolean; turns: number }>

const CONDITIONS: Condition[] = ['governed', 'ungoverned']

/**
 * Run the full matrix. `runOne` performs one isolated task run (clone -> drive ->
 * score); it is injected so the orchestrator's aggregation is unit-testable
 * without a live model.
 */
export async function runSuite(opts: {
  tasks: TaskDef[]
  reps: number
  model: string
  runOne: RunOne
  bootstrapRng?: () => number
}): Promise<SuiteResult> {
  const runs: RunRecord[] = []
  for (const task of opts.tasks) {
    for (const condition of CONDITIONS) {
      for (let rep = 1; rep <= opts.reps; rep++) {
        const r = await opts.runOne({ task, condition, rep })
        runs.push({ taskId: task.id, condition, rep, passed: r.passed, timedOut: r.timedOut, turns: r.turns })
      }
    }
  }

  const perTask: PerTaskResult[] = opts.tasks.map((task) => {
    const g = runs.filter((x) => x.taskId === task.id && x.condition === 'governed')
    const u = runs.filter((x) => x.taskId === task.id && x.condition === 'ungoverned')
    const governed = wilsonInterval(g.filter((x) => x.passed).length, g.length)
    const ungoverned = wilsonInterval(u.filter((x) => x.passed).length, u.length)
    return { taskId: task.id, governed, ungoverned, lift: governed.point - ungoverned.point }
  })

  const gAll = runs.filter((x) => x.condition === 'governed')
  const uAll = runs.filter((x) => x.condition === 'ungoverned')
  const governedOverall = wilsonInterval(gAll.filter((x) => x.passed).length, gAll.length)
  const ungovernedOverall = wilsonInterval(uAll.filter((x) => x.passed).length, uAll.length)

  const boot = pairedBootstrapLift(perTask.map((p) => p.lift), 10000, 0.95, opts.bootstrapRng)

  return {
    model: opts.model,
    timestamp: new Date().toISOString(),
    repsPerCondition: opts.reps,
    runs,
    perTask,
    governedOverall,
    ungovernedOverall,
    liftMean: boot.meanLift,
    liftLower: boot.lower,
    liftUpper: boot.upper,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run benchmark/true/harness/orchestrate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/harness/orchestrate.ts benchmark/true/harness/orchestrate.test.ts
git commit -m "feat: N-rep ablation orchestrator with Wilson + bootstrap aggregation"
```

---

## Task 9: CLI entrypoint + real `runOne` wiring

**Files:**
- Create: `benchmark/true/run.ts`
- Create: `benchmark/true/results/.gitkeep`

Wires the real isolation → driver → scorer pipeline into a `runOne`, builds the Ollama config/provider exactly as `engine/main.ts` does, runs the suite, and writes a committed results JSON.

- [ ] **Step 1: Write the entrypoint**

Create `benchmark/true/run.ts`:

```ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../engine/config.js'
import { createProvider } from '../../engine/providers/factory.js'
import { loadCivkingsTasks } from './harness/tasks.js'
import { cloneRepo, checkoutRef, applyPatch } from './harness/isolate.js'
import { runTask, countTurns } from './harness/driver.js'
import { scorePytest } from './harness/scorer.js'
import { runSuite, type RunOneArgs } from './harness/orchestrate.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const civkingsRepo = arg('--civkings', 'C:\\Users\\civer\\civkings')
  const tasksDir = arg('--tasks', join(import.meta.dirname, 'tasks', 'civkings'))
  const reps = parseInt(arg('--reps', '3'), 10)

  const config = loadConfig()
  const ctx = config.contextLength ?? 32768
  const provider = createProvider('ollama', config.baseUrl, config.apiKey, ctx)

  const tasks = loadCivkingsTasks(tasksDir)
  if (tasks.length === 0) { console.error(`[true-bench] no tasks in ${tasksDir}`); process.exit(1) }
  console.log(`[true-bench] ${tasks.length} task(s), reps=${reps}, model=${config.model}`)

  const runOne = async ({ task, condition, rep }: RunOneArgs) => {
    const work = mkdtempSync(join(tmpdir(), `truebench-${task.id}-`))
    try {
      cloneRepo(civkingsRepo, work)
      checkoutRef(work, task.startRef)
      if (task.setupPatch) applyPatch(work, task.setupPatch)
      console.log(`[true-bench] ${task.id} ${condition} rep ${rep}...`)
      const driven = await runTask({
        prompt: task.prompt, cwd: work, governed: condition === 'governed',
        config, provider, timeoutMs: task.timeoutMs,
      })
      const score = scorePytest(work, task.hiddenTestPath, task.hiddenTestName)
      return { passed: score.passed, timedOut: driven.timedOut, turns: countTurns(driven.messages) }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  const result = await runSuite({ tasks, reps, model: config.model ?? 'unknown', runOne })

  const outDir = join(import.meta.dirname, 'results')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `true-ablation-${Date.now()}.json`)
  writeFileSync(outFile, JSON.stringify(result, null, 2))

  console.log('\n=== TRUE BENCHMARK (Layer A: CivKings self-ablation) ===')
  console.log(`model: ${result.model}  reps/condition: ${result.repsPerCondition}`)
  console.log(`governed   pass: ${(result.governedOverall.point * 100).toFixed(1)}% ` +
    `[${(result.governedOverall.lower * 100).toFixed(1)}, ${(result.governedOverall.upper * 100).toFixed(1)}]`)
  console.log(`ungoverned pass: ${(result.ungovernedOverall.point * 100).toFixed(1)}% ` +
    `[${(result.ungovernedOverall.lower * 100).toFixed(1)}, ${(result.ungovernedOverall.upper * 100).toFixed(1)}]`)
  console.log(`lift (governed-ungoverned): ${(result.liftMean * 100).toFixed(1)}% ` +
    `[${(result.liftLower * 100).toFixed(1)}, ${(result.liftUpper * 100).toFixed(1)}]`)
  const verdict = result.liftLower > 0 ? 'GOVERNANCE HELPS (CI excludes 0)'
    : result.liftUpper < 0 ? 'GOVERNANCE HURTS (CI excludes 0)'
    : 'INCONCLUSIVE (CI includes 0)'
  console.log(`verdict: ${verdict}`)
  console.log(`results: ${outFile}`)

  const pm = (globalThis as any).__llamaProcessManager
  if (pm) { try { await pm.stop() } catch {} }
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Create the results dir keep-file**

```bash
mkdir -p benchmark/true/results
printf '' > benchmark/true/results/.gitkeep
```

- [ ] **Step 3: Type-check the entrypoint**

Run: `npx tsc --noEmit -p . 2>&1 | grep -i "benchmark/true/run.ts" || echo "run.ts: no type errors"`
Expected: `run.ts: no type errors`. (If `createProvider`'s signature differs, align with `engine/main.ts:136`.)

- [ ] **Step 4: End-to-end smoke with the trivial seed task (built next in Task 10)**

Deferred to Task 10 Step 6 (needs at least one real task). For now confirm the CLI errors cleanly on an empty tasks dir:

Run: `LOCALCODE_MODEL=qwen3.6 npx bun benchmark/true/run.ts --tasks /tmp/does-not-exist`
Expected: prints `[true-bench] no tasks in ...` and exits non-zero.

- [ ] **Step 5: Commit**

```bash
git add benchmark/true/run.ts benchmark/true/results/.gitkeep
git commit -m "feat: true-benchmark CLI entrypoint with real isolation+scoring pipeline"
```

---

## Task 10: First CivKings task (authored seed) + end-to-end validation

**Files:**
- Create: `benchmark/true/tasks/civkings/trade-route-tick/task.json`
- Create: `benchmark/true/tasks/civkings/trade-route-tick/setup.patch`
- Create: `benchmark/true/tasks/civkings/trade-route-tick/hidden_test.py`
- Create: `benchmark/true/tasks/civkings/trade-route-tick/notes.md`

This authored seed proves the whole pipeline end-to-end before authoring the rest. It targets the already-tested trade-route economy (CivKings `test_economy_systems.py` has `TestTradeRoutes::test_trade_route_tick`), so we know the feature is real and verifiable.

- [ ] **Step 1: Identify the real symbol under test**

Run: `cd /c/Users/civer/civkings && SDL_VIDEODRIVER=dummy python -m pytest test_economy_systems.py::TestTradeRoutes::test_trade_route_tick -q`
Expected: PASS (1 passed) — confirms the baseline feature exists at `03b4032`.

- [ ] **Step 2: Derive the hidden test from the existing real test**

Open `/c/Users/civer/civkings/test_economy_systems.py`, copy the `test_trade_route_tick` test body and its imports into a standalone file. Create `benchmark/true/tasks/civkings/trade-route-tick/hidden_test.py` containing exactly that single test (imports + one `def test_trade_route_tick()` asserting the per-tick trade income behavior). It must pass against unmodified CivKings and fail when the tick logic is removed.

- [ ] **Step 3: Build the setup.patch that removes the implementation**

In a scratch clone of CivKings, delete/neutralize the trade-route tick income body (the loop that credits gold per active route each turn) so the hidden test fails, then capture the diff:

```bash
cd /tmp && rm -rf ck && git clone --no-hardlinks /c/Users/civer/civkings ck && cd ck
git checkout 03b4032
# edit the trade-route tick function to a no-op stub (return early before crediting gold)
git diff > /c/Users/civer/localcode/benchmark/true/tasks/civkings/trade-route-tick/setup.patch
```

Verify the patch makes the hidden test fail:

```bash
cp /c/Users/civer/localcode/benchmark/true/tasks/civkings/trade-route-tick/hidden_test.py /tmp/ck/
cd /tmp/ck && SDL_VIDEODRIVER=dummy python -m pytest hidden_test.py -q
```
Expected: FAIL (the stub removed the income).

- [ ] **Step 4: Write task.json**

Create `benchmark/true/tasks/civkings/trade-route-tick/task.json`:

```json
{
  "id": "trade-route-tick",
  "prompt": "In this CivKings game, active trade routes are supposed to generate gold income for a city every turn, but right now they produce nothing. Find where trade routes are processed each turn and make each active route credit its city the expected per-tick gold income.",
  "start_ref": "03b4032",
  "setup_patch": "setup.patch",
  "hidden_test": "hidden_test.py",
  "timeout_ms": 900000,
  "source": "authored"
}
```

- [ ] **Step 5: Write notes.md (provenance)**

Create `benchmark/true/tasks/civkings/trade-route-tick/notes.md`:

```markdown
# trade-route-tick

- Source: authored (derived from existing real test
  `test_economy_systems.py::TestTradeRoutes::test_trade_route_tick`).
- Start ref: 03b4032 (known-green CivKings HEAD on 2026-06-16).
- setup.patch stubs the per-tick trade income so there is real work to do.
- hidden_test.py is the standalone copy of the real test; pass = exit 0.
- Difficulty: single-subsystem (economy), multi-file lookup (city + trade route).
```

- [ ] **Step 6: End-to-end smoke — run ONE task, both arms, N=1**

Run: `LOCALCODE_MODEL=qwen3.6 npx bun benchmark/true/run.ts --tasks benchmark/true/tasks/civkings --reps 1`
Expected: completes; prints governed/ungoverned pass lines and a verdict; writes a JSON under `benchmark/true/results/`. (Pass/fail value may be either — the point is the pipeline runs clone→drive→score→stats end-to-end without error.)

- [ ] **Step 7: Commit task + first committed result**

```bash
git add benchmark/true/tasks/civkings/trade-route-tick/ benchmark/true/results/
git commit -m "feat: first CivKings ablation task (trade-route-tick) + e2e smoke result"
```

---

## Task 11: Author the remaining CivKings tasks (reach ~12)

**Files (per task, repeat the Task 10 pattern):**
- Create: `benchmark/true/tasks/civkings/<id>/task.json`, `hidden_test.py`, `setup.patch?`, `notes.md`

Mix per the spec: **mine git history where commits already ship a matching test** (use the parent commit as `start_ref`, the child's test as hidden test, no setup.patch needed), and **author the rest**.

- [ ] **Step 1: Inventory minable history**

Run: `cd /c/Users/civer/civkings && git log --oneline -40 | cat` then, for promising fix commits, `git show --stat <sha> | cat` to find commits that added/modified a `test_*.py` alongside a source change. Record candidates (sha, test id) in a scratch list.

- [ ] **Step 2: For each MINED task, create the dir**

For a chosen commit `<sha>` whose child adds `test_foo`:
- `start_ref` = `<sha>^` (parent), `source` = `mined`, no `setup.patch`.
- `hidden_test.py` = the test file (or extracted test) from `<sha>`.
- Verify: clone, checkout `<sha>^`, copy hidden test, `SDL_VIDEODRIVER=dummy pytest hidden_test.py -q` → must FAIL (feature absent at parent).
- `prompt` = a natural-language restatement of the commit's intent (from its message), never naming the test.
- Write `task.json` (schema as Task 10 Step 4) and `notes.md` citing the source sha.

- [ ] **Step 3: For each AUTHORED task, repeat Task 10's pattern**

Pick distinct subsystems for breadth (combat, dynasty, city growth, AI). For each: write `hidden_test.py`, build a `setup.patch` that removes the target, verify the patch makes the test fail, write `task.json` + `notes.md` (`source: authored`).

- [ ] **Step 4: Validate every task fails-at-start and passes-with-gold**

For EACH task dir, run this gate (clone → start state → hidden test must FAIL; then apply the real gold fix → must PASS). For mined tasks the gold is `git checkout <sha> -- <changed source files>`; for authored, manually reverse the setup.patch:

```bash
# fails at start:
cd /tmp && rm -rf ckv && git clone --no-hardlinks /c/Users/civer/civkings ckv && cd ckv
git checkout <start_ref>; git apply <setup.patch if any>
cp <task>/hidden_test.py .; SDL_VIDEODRIVER=dummy python -m pytest hidden_test.py -q   # expect FAIL
# passes with the real fix applied:
git checkout <child_sha> -- <source files>   # or reverse the setup.patch
SDL_VIDEODRIVER=dummy python -m pytest hidden_test.py -q                                # expect PASS
```
Expected: FAIL then PASS for every task. Any task that doesn't satisfy both is broken — fix or drop it.

- [ ] **Step 5: Commit the task suite**

```bash
git add benchmark/true/tasks/civkings/
git commit -m "feat: full CivKings ablation task suite (~12 tasks, mined + authored)"
```

---

## Task 12: Full run + regenerate BENCHMARKS.md with real numbers

**Files:**
- Modify: `docs/BENCHMARKS.md` (§3 and §4)
- Create: `benchmark/true/results/true-ablation-<ts>.json` (committed)

- [ ] **Step 1: Run the full benchmark (N=3, all tasks)**

Run: `LOCALCODE_MODEL=qwen3.6 npx bun benchmark/true/run.ts --reps 3`
Expected: completes over all tasks (slow — this is the headline run); prints governed/ungoverned/lift with CIs and a verdict; writes a results JSON.

- [ ] **Step 2: Confirm the result file is committed (not gitignored)**

Run: `git check-ignore benchmark/true/results/*.json || echo "results are tracked"`
Expected: `results are tracked`. (If ignored, add `!benchmark/true/results/` to `.gitignore` — the whole point is version-controlled evidence.)

- [ ] **Step 3: Replace BENCHMARKS.md §3 with the real Layer A result**

Rewrite `docs/BENCHMARKS.md` §3 (currently "Current Results: None That Can Be Trusted") to report the actual governed pass %, ungoverned pass %, and lift with their CIs and the verdict, citing the committed results filename and the model. State N, task count, and that scoring is hidden-test pytest exit codes. Keep the honesty: if the lift CI includes 0, say "inconclusive" plainly.

- [ ] **Step 4: Update §4 ("What We Can Honestly Say Today")**

Replace the "UNKNOWN/unmeasured" language with the measured finding (helps / inconclusive / hurts), now that it IS measured. Keep §6 (H1–H8) and §7 caveats intact.

- [ ] **Step 5: Commit**

```bash
git add docs/BENCHMARKS.md benchmark/true/results/
git commit -m "docs: report real Layer A ablation numbers with CIs in BENCHMARKS.md"
```

---

## Task 13: Integration verification + wire-check (BLOCKING)

**Files:** none created — this task only verifies.

Per project standards: prove every new symbol is actually imported/called/used, and the whole pipeline is wired end-to-end.

- [ ] **Step 1: Wire-check every new exported symbol is consumed**

Run each grep; every symbol must appear in at least one NON-definition site:

```bash
for sym in wilsonInterval pairedBootstrapLift withAblationEnv cloneRepo checkoutRef applyPatch scorePytest loadCivkingsTasks runTask countTurns runSuite; do
  echo "=== $sym ==="; grep -rn "$sym" benchmark/true --include=*.ts | grep -v "export function $sym\|export async function $sym"
done
```
Expected: each symbol shows at least one call/import site. `runSuite`/`runOne` wired in `run.ts`; stats wired in `orchestrate.ts`; isolate/scorer/driver wired in `run.ts`'s `runOne`.

- [ ] **Step 2: Confirm the driver actually toggles governance**

Run: `grep -n "_ABLATION_VSM_DISABLED" benchmark/true/harness/ablationEnv.ts && grep -rn "process.env\['_ABLATION_VSM_DISABLED'\]\|_ABLATION_VSM_DISABLED" engine/vsm/cyberneticsGovernance.ts | head`
Expected: the harness sets the exact env key the engine reads at construction — proving the A/B is real, not cosmetic.

- [ ] **Step 3: Run the entire new test suite green**

Run: `npx vitest run benchmark/true`
Expected: all stats/ablationEnv/isolate/scorer/tasks/orchestrate tests pass.

- [ ] **Step 4: Run the full existing suite to prove no regression**

Run: `npm test 2>&1 | tail -15`
Expected: existing engine tests still pass (the only product change is the vitest include glob; harness lives outside engine).

- [ ] **Step 5: Confirm committed evidence exists**

Run: `git ls-files benchmark/true/results/ | grep -c '\.json$'`
Expected: ≥ 1 — at least one tracked results file (the falsifiability requirement the old data failed).

- [ ] **Step 6: Commit (if any fixes were needed)**

```bash
git add -A && git commit -m "test: wire-check + integration verification for the true benchmark" || echo "nothing to fix"
```

---

## Layer B (follow-up plan — SWE-bench-lite absolute scorecard)

**Not built in this plan.** Layer B reuses this harness's `runSuite`/driver/stats but needs per-repo upstream environment provisioning (astropy, django, sympy at pinned `base_commit`), which is the classic SWE-bench infra cost and the main feasibility risk. It will get its own plan once Layer A proves out. Sketch of its tasks:

1. SWE-bench loader: parse `benchmark/swebench-lite-50.json` (`instance_id`, `base_commit`, `FAIL_TO_PASS`, `PASS_TO_PASS`, gold `patch`) into a task type.
2. Per-repo env provisioner: clone upstream repo at `base_commit`, build its venv/deps (or use the official SWE-bench Docker harness for scoring).
3. SWE-bench scorer: apply agent diff → apply gold test patch → run `FAIL_TO_PASS` (must pass) + `PASS_TO_PASS` (must stay passing).
4. Governed-only run, N=1 × 50; binomial Wilson CI on pass rate.
5. BENCHMARKS.md: add absolute pass rate next to PUBLISHED leaderboard numbers, explicitly labeled apples-to-oranges (context, not head-to-head).

---

## Self-Review

**1. Spec coverage:**
- Layer A self-ablation lift → Tasks 8–12. ✓
- N=3 + Wilson + paired bootstrap → Tasks 2, 8, 12. ✓
- Hidden-test injection / anti-gaming → Task 5 + Task 10. ✓
- Fresh temp clone per run → Tasks 4, 9. ✓
- Governance toggle via `_ABLATION_VSM_DISABLED` → Tasks 3, 7, 13. ✓
- Mix of mined + authored CivKings tasks → Tasks 10, 11. ✓
- Standalone, zero reuse of `benchmark/` → all Layer A files under `benchmark/true/`, imports only from `engine/` (system under test) + node/vitest. ✓
- Version-controlled tasks AND results → Tasks 9, 12, 13 (Step 5 / Step 2 / Step 5). ✓
- Headless pytest (`SDL_VIDEODRIVER=dummy`) → Task 5 scorer + Task 10 verification. ✓
- qwen3.6 model → Tasks 9, 10, 12. ✓
- Frontier ref = published numbers → Layer B follow-up. ✓ (correctly deferred per spec)
- Layer B env-cost flagged, ships second → Layer B section. ✓

**2. Placeholder scan:** No "TBD"/"implement later". Task 11 is necessarily templated (N near-identical task dirs) but gives the exact create+verify procedure and a concrete FAIL-then-PASS gate per task rather than hand-waving. Task 10 Steps 2–3 reference real, named CivKings tests/functions verified to exist.

**3. Type consistency:** `TaskDef` fields (`startRef`, `hiddenTestPath`, `hiddenTestName`, `setupPatch`, `timeoutMs`, `source`) are defined in Task 1 and consumed identically in Tasks 6, 9. `RunOne`/`RunOneArgs` defined in Task 8 and used in Task 9. `SuiteResult`/`Interval` fields used consistently in Tasks 8, 9, 12. `scorePytest(workdir, hiddenTestPath, hiddenTestName)` signature matches its Task 5 definition and the Task 9 call site. `runTask({prompt,cwd,governed,config,provider,timeoutMs})` matches Task 7 def and Task 9 call. `wilsonInterval`/`pairedBootstrapLift` signatures match across Tasks 2 and 8.
