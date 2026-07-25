# Training Reward Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CynCo's coding-trajectory reward label mean something, and capture real conversation content for it to label.

**Architecture:** One shared test-output parser replaces two partial ones. The recorder gains an end-of-task message snapshot (the training corpus) alongside its existing per-tool-call JSONL (telemetry). A `try/finally` wrapper around `handleUserMessage` gives a single task boundary across its six-plus exits, where components are measured — or marked `unknown` rather than assumed — and the reward is normalized to its ceiling so it stops saturating.

**Tech Stack:** TypeScript on Bun, vitest (the only gate — there is no root `tsconfig.json`, so Bun strips types without checking and a type error reaches runtime).

**Spec:** `docs/superpowers/specs/2026-07-25-training-reward-grounding-design.md`

**Branch:** `training-reward-grounding` (already created, spec committed at `4a907f5`)

---

## Baseline you must not regress

```
bunx vitest run
```
Expected today: `8 failed | 2266 passed | 35 skipped`.

The 8 pre-existing failures are 7 × `engine/__tests__/skills/workflowParity.test.ts:115` and 1 × `benchmark/true/polyglot/exercise.test.ts:61`. **Do not fix them.** The gate is that the failure count does not grow.

## Conventions

- New tests go in `engine/__tests__/**/*.test.ts` — the vitest `include` glob only picks up `engine/__tests__/`, `engine/vsm/`, `engine/tools/`, `benchmark/true/`.
- Import from `vitest` in new test files. (`bun:test` also works — `vitest.config.ts` aliases it to a shim — but new code should use `vitest` directly.)
- Imports of local modules use the `.js` extension even for `.ts` sources (ESM/NodeNext style used throughout `engine/`).
- `docs/superpowers/` is gitignored; commit plan/spec files with `git add -f`.

## File structure

| File | Responsibility |
|---|---|
| `engine/bridge/testSummary.ts` (new) | The only place that parses test-runner output. Runner detection, hard-error rejection, pass/total counts. |
| `engine/bridge/benignToolResult.ts` (modify) | Thin boolean wrapper over `testSummary`. Behavior unchanged. |
| `engine/bestOfN/sampler.ts` (modify) | `parseTestOutput` delegates to `testSummary`. |
| `engine/training/messageSnapshot.ts` (new) | Pure sanitizer: truncate, redact, cap a `Message[]` for persistence. |
| `engine/training/trajectoryRecorder.ts` (modify) | Gains `endTask(messages)` writing `<taskId>.messages.json`. |
| `engine/training/gitFacts.ts` (new) | Shells out to git; returns plain facts. Isolated so everything above it stays pure. |
| `engine/training/taskOutcome.ts` (new) | Pure `buildComponents(input)` → measured-or-`unknown` components. |
| `engine/training/rewardLabeler.ts` (modify) | Normalized reward; `ComponentValue`; `labelerVersion: 2`. |
| `engine/bridge/conversationLoop.ts` (modify) | `try/finally` task boundary; real `testsTotal`; observation buffer. |
| `engine/training/datasetBuilder.ts` (modify) | Eligibility, real messages, keep negatives, delete `backfillRewards`. |
| `engine/training/runTraining.ts` (modify) | Three-condition readiness gate; drop the `backfill` stage. |
| `engine/dashboard/server.ts` (modify) | Report usable/negative/avg instead of a single count against 300. |

---

## Task 1: One test-output parser

**Files:**
- Create: `engine/bridge/testSummary.ts`
- Create: `engine/__tests__/bridge/testSummary.test.ts`
- Modify: `engine/bridge/benignToolResult.ts` (replace body, keep export signature)
- Modify: `engine/bestOfN/sampler.ts:16-58`
- Unchanged (proof of behavior preservation): `engine/__tests__/bridge/benignToolResult.test.ts`

Two partial parsers exist: `benignToolResult.ts` detects a runner and rejects hard errors but returns only a boolean; `sampler.ts:16` returns counts but must be handed a framework label and has no hard-error guard. Neither can answer "what fraction passed."

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/bridge/testSummary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { detectFramework, parseTestSummary } from '../../bridge/testSummary.js'

describe('detectFramework', () => {
  it('recognizes a pytest invocation', () => {
    expect(detectFramework('GILDED_NARRATE=0 python -m pytest gilded/ -q')).toBe('pytest')
  })

  it('recognizes vitest, jest, cargo and go', () => {
    expect(detectFramework('bunx vitest run')).toBe('vitest')
    expect(detectFramework('npx jest --ci')).toBe('jest')
    expect(detectFramework('cargo test --all')).toBe('cargo')
    expect(detectFramework('go test ./...')).toBe('go')
  })

  it('returns null for a non-test command', () => {
    expect(detectFramework('git status --porcelain')).toBeNull()
    expect(detectFramework('ls -la')).toBeNull()
  })
})

describe('parseTestSummary', () => {
  it('parses a red pytest run into real counts', () => {
    const out = '=== short test summary info ===\nFAILED gilded/tests/test_realm.py::test_x\n46 failed, 208 passed in 19.42s'
    expect(parseTestSummary('python -m pytest gilded/ -q', out)).toEqual({
      framework: 'pytest', passed: 208, total: 254,
    })
  })

  it('parses an all-green pytest run', () => {
    expect(parseTestSummary('python -m pytest gilded/ -q', '354 passed in 21.0s')).toEqual({
      framework: 'pytest', passed: 354, total: 354,
    })
  })

  it('parses a vitest summary', () => {
    const out = ' Test Files  2 failed | 293 passed (300)\n      Tests  8 failed | 2266 passed | 35 skipped (2309)'
    const r = parseTestSummary('bunx vitest run', out)!
    expect(r.passed).toBe(2266)
    expect(r.total).toBe(2274)
  })

  it('parses a cargo summary', () => {
    const out = 'test result: FAILED. 3 passed; 1 failed; 0 ignored'
    expect(parseTestSummary('cargo test', out)).toEqual({
      framework: 'cargo', passed: 3, total: 4,
    })
  })

  it('returns null on a collection error despite a stray count in the output', () => {
    const out = "ImportError: cannot import name 'opinion_matrix'\n" +
      '!!!!!!! Interrupted: 3 errors during collection !!!!!!!\n3 errors in 0.32s\n12 passed'
    expect(parseTestSummary('python -m pytest gilded/ -q', out)).toBeNull()
  })

  it('returns null when the command is not a test runner', () => {
    expect(parseTestSummary('git status', '5 passed')).toBeNull()
  })

  it('returns null when a runner ran but produced no summary', () => {
    expect(parseTestSummary('python -m pytest gilded/ -q', 'collecting ...')).toBeNull()
  })

  it('returns null rather than 0/0 when counts are absent', () => {
    expect(parseTestSummary('python -m pytest', 'no tests ran in 0.01s')).toBeNull()
  })

  it('accepts a bare framework name as well as a command', () => {
    expect(parseTestSummary('pytest', '10 passed')).toEqual({
      framework: 'pytest', passed: 10, total: 10,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/bridge/testSummary.test.ts`
Expected: FAIL — `Failed to resolve import "../../bridge/testSummary.js"`

- [ ] **Step 3: Write the implementation**

Create `engine/bridge/testSummary.ts`:

```ts
/**
 * The single source of truth for reading test-runner output.
 *
 * Two partial parsers used to exist: benignToolResult.ts could tell whether a
 * suite ran but not how it did, and bestOfN/sampler.ts could count but had to
 * be told the framework and had no hard-error guard. Both now delegate here.
 *
 * Conservative by design, inherited from benignToolResult: a result is a real
 * summary ONLY when a recognized runner was invoked, the output carries
 * pass/fail counts, and no hard-error marker is present. Collection errors,
 * broken imports and usage errors return null — they are faults, not results.
 */

const FRAMEWORK_PATTERNS: { framework: string; re: RegExp }[] = [
  { framework: 'pytest', re: /\b(pytest|py\.test|python[0-9.]*\s+-m\s+(pytest|unittest))\b/i },
  { framework: 'vitest', re: /\bvitest\b/i },
  { framework: 'jest', re: /\bjest\b/i },
  { framework: 'bun', re: /\bbun\s+test\b/i },
  { framework: 'mocha', re: /\bmocha\b/i },
  { framework: 'go', re: /\bgo\s+test\b/i },
  { framework: 'cargo', re: /\bcargo\s+test\b/i },
  { framework: 'rspec', re: /\brspec\b/i },
  { framework: 'phpunit', re: /\bphpunit\b/i },
  { framework: 'ctest', re: /\bctest\b/i },
  { framework: 'gradle', re: /\bgradle\s+test\b/i },
  { framework: 'maven', re: /\bmvn\s+test\b/i },
  { framework: 'npm', re: /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/i },
]

/**
 * Hard-error markers: the command did NOT cleanly run a suite. These are
 * genuine faults, so they must not be reported as results even if a stray
 * pass/fail count appears elsewhere in the output.
 */
const HARD_ERROR =
  /errors? during collection|Interrupted:\s|INTERNALERROR|usage:\s*pytest|unrecognized arguments|no tests ran|command not found|No such file|not recognized as|ENOENT|ModuleNotFoundError:|cannot import name/i

export type TestSummary = { framework: string; passed: number; total: number }

/** Framework name if the command invokes a recognized test runner, else null. */
export function detectFramework(command: string): string | null {
  if (typeof command !== 'string') return null
  for (const { framework, re } of FRAMEWORK_PATTERNS) {
    if (re.test(command)) return framework
  }
  return null
}

function num(output: string, re: RegExp): number | null {
  const m = output.match(re)
  return m ? parseInt(m[1], 10) : null
}

function countsFor(framework: string, output: string): { passed: number; total: number } | null {
  switch (framework) {
    case 'go': {
      const lines = output.split('\n')
      const passed = lines.filter(l => /^ok\s/.test(l)).length
      const failed = lines.filter(l => /^(FAIL|--- FAIL)/.test(l)).length
      return passed + failed > 0 ? { passed, total: passed + failed } : null
    }
    case 'cargo': {
      const passed = num(output, /(\d+)\s+passed/i)
      const failed = num(output, /(\d+)\s+failed/i)
      if (passed === null && failed === null) return null
      return { passed: passed ?? 0, total: (passed ?? 0) + (failed ?? 0) }
    }
    case 'jest': {
      const passed = num(output, /(\d+)\s+passed/i)
      const total = num(output, /(\d+)\s+total/i)
      if (passed === null) return null
      return { passed, total: total ?? passed }
    }
    case 'bun': {
      const passed = num(output, /(\d+)\s+pass\b/i)
      const failed = num(output, /(\d+)\s+fail\b/i)
      if (passed === null && failed === null) return null
      return { passed: passed ?? 0, total: (passed ?? 0) + (failed ?? 0) }
    }
    default: {
      // pytest / vitest / mocha / rspec and friends all report "N passed",
      // "N failed". vitest prints the Tests line last, so a trailing match wins.
      const passed = num(output, /(\d+)\s+passed/i)
      const failed = num(output, /(\d+)\s+failed/i)
      if (passed === null && failed === null) return null
      return { passed: passed ?? 0, total: (passed ?? 0) + (failed ?? 0) }
    }
  }
}

/**
 * Parse real pass/total counts out of test-runner output.
 *
 * `commandOrFramework` accepts either a shell command (detection is applied)
 * or a bare framework name already known to the caller.
 * Returns null when there is no trustworthy result.
 */
export function parseTestSummary(commandOrFramework: string, output: string): TestSummary | null {
  const known = FRAMEWORK_PATTERNS.some(f => f.framework === commandOrFramework)
  const framework = known ? commandOrFramework : detectFramework(commandOrFramework)
  if (!framework) return null

  const o = output ?? ''
  if (HARD_ERROR.test(o)) return null

  const counts = countsFor(framework, o)
  if (!counts || counts.total === 0) return null

  return { framework, passed: counts.passed, total: counts.total }
}
```

**Note on the vitest case:** vitest prints `Test Files  2 failed | 293 passed (300)` *before* `Tests  8 failed | 2266 passed`. A first-match regex would read the file counts. `String.match` returns the first match, so use the last one — replace the `default` branch's `num` calls with a last-match helper:

```ts
function lastNum(output: string, re: RegExp): number | null {
  const all = [...output.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))]
  return all.length > 0 ? parseInt(all[all.length - 1][1], 10) : null
}
```

Use `lastNum` in the `default` branch only (pytest prints one summary; vitest prints two and the last is the test-level one). Leave `num` in the other branches.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/bridge/testSummary.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Make `benignToolResult` delegate**

Replace the body of `engine/bridge/benignToolResult.ts` (keep the header comment, which documents the S4_DET2 incident, and keep the exported signature exactly):

```ts
import { parseTestSummary } from './testSummary.js'

/**
 * True when a non-zero Bash result is a test runner reporting failing tests
 * (expected TDD signal) rather than a genuine command/tool failure.
 */
export function isBenignTestFailure(toolName: string, toolInput: unknown, output: string): boolean {
  if (toolName !== 'Bash') return false
  const command = (toolInput as { command?: unknown })?.command
  if (typeof command !== 'string') return false
  return parseTestSummary(command, output ?? '') !== null
}
```

Delete the now-unused `TEST_RUNNER`, `RAN_WITH_RESULTS` and `HARD_ERROR` constants from this file.

- [ ] **Step 6: Prove behavior is preserved**

Run: `bunx vitest run engine/__tests__/bridge/benignToolResult.test.ts`
Expected: PASS — 9 tests, **file unmodified**. If any test fails, the refactor changed behavior; fix `testSummary.ts` rather than the test.

- [ ] **Step 7: Make `sampler.parseTestOutput` delegate**

In `engine/bestOfN/sampler.ts`, replace lines 16-58 (the whole `parseTestOutput` function) with:

```ts
import { parseTestSummary } from '../bridge/testSummary.js'

export function parseTestOutput(
  output: string,
  framework: string
): { passed: number; total: number } {
  const summary = parseTestSummary(framework, output)
  return summary ? { passed: summary.passed, total: summary.total } : { passed: 0, total: 0 }
}
```

Add the import at the top of the file alongside the existing imports.

- [ ] **Step 8: Run the full suite**

Run: `bunx vitest run`
Expected: `8 failed | 2276 passed | 35 skipped` (the 10 new tests added; failure count unchanged at 8)

- [ ] **Step 9: Commit**

```bash
git add engine/bridge/testSummary.ts engine/bridge/benignToolResult.ts engine/bestOfN/sampler.ts engine/__tests__/bridge/testSummary.test.ts
git commit -m "refactor(bridge): one test-output parser, three consumers

benignToolResult could tell whether a suite ran but not how it did; sampler
could count but had to be told the framework and had no hard-error guard.
Neither could answer 'what fraction passed' — which is what the reward label
needs. Both now delegate to testSummary.ts. benignToolResult's 9 tests pass
unmodified, proving the refactor is behavior-preserving."
```

---

## Task 2: Message snapshot sanitizer

**Files:**
- Create: `engine/training/messageSnapshot.ts`
- Create: `engine/__tests__/training/messageSnapshot.test.ts`

Pure functions only — no I/O. The recorder (Task 3) calls this before writing.

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/training/messageSnapshot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sanitizeMessages, RESULT_CAP_BYTES } from '../../training/messageSnapshot.js'
import type { Message } from '../../types.js'

function toolUse(id: string, name: string, input: Record<string, unknown>): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
}

function toolResult(id: string, text: string): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
}

describe('sanitizeMessages', () => {
  it('leaves ordinary text and small results untouched', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'add a test' }] },
      toolUse('t1', 'Read', { file_path: 'src/app.ts' }),
      toolResult('t1', 'export const x = 1'),
    ]
    const out = sanitizeMessages(msgs)
    expect(out.messages).toEqual(msgs)
    expect(out.truncatedMessages).toBe(0)
  })

  it('truncates a tool result over the cap with an elision marker', () => {
    const big = 'x'.repeat(RESULT_CAP_BYTES + 5000)
    const out = sanitizeMessages([toolUse('t1', 'Read', { file_path: 'big.txt' }), toolResult('t1', big)])
    const block = (out.messages[1].content as any[])[0]
    expect(block.content.length).toBeLessThan(big.length)
    expect(block.content).toContain('bytes elided')
    expect(block.content.startsWith('xxx')).toBe(true)
    expect(block.content.endsWith('xxx')).toBe(true)
  })

  it('redacts a result whose tool input points at a sensitive path', () => {
    const out = sanitizeMessages([
      toolUse('t1', 'Read', { file_path: '/repo/.env' }),
      toolResult('t1', 'OPENAI_API_KEY=sk-realsecret'),
    ])
    const block = (out.messages[1].content as any[])[0]
    expect(block.content).toBe('[redacted: sensitive path]')
    expect(JSON.stringify(out.messages)).not.toContain('sk-realsecret')
  })

  it('redacts credentials, secrets, .pem and id_rsa paths', () => {
    for (const p of ['/a/credentials.json', '/a/secrets.yml', '/a/key.pem', '/home/u/.ssh/id_rsa']) {
      const out = sanitizeMessages([toolUse('t1', 'Read', { file_path: p }), toolResult('t1', 'SECRETVALUE')])
      expect(JSON.stringify(out.messages)).not.toContain('SECRETVALUE')
    }
  })

  it('redacts a sensitive path given as a Bash command argument', () => {
    const out = sanitizeMessages([
      toolUse('t1', 'Bash', { command: 'cat .env' }),
      toolResult('t1', 'TOKEN=ghp_realsecret'),
    ])
    const block = (out.messages[1].content as any[])[0]
    expect(block.content).toBe('[redacted: sensitive path]')
  })

  it('drops oldest non-system messages when the whole snapshot exceeds the file cap', () => {
    const filler = (i: number): Message => ({ role: 'user', content: [{ type: 'text', text: `${i}:` + 'y'.repeat(50_000) }] })
    const msgs: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
      ...Array.from({ length: 60 }, (_, i) => filler(i)),
    ]
    const out = sanitizeMessages(msgs, { fileCapBytes: 500_000 })
    expect(out.truncatedMessages).toBeGreaterThan(0)
    expect(JSON.stringify(out.messages).length).toBeLessThanOrEqual(500_000)
    // The system message survives regardless of age
    expect(out.messages[0].role).toBe('system')
    // The most recent message survives
    expect(JSON.stringify(out.messages)).toContain('59:')
  })

  it('handles a tool_result whose content is a block array, not a string', () => {
    const msgs: Message[] = [
      toolUse('t1', 'Read', { file_path: '/repo/.env' }),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'SECRETVALUE' }] }] },
    ]
    const out = sanitizeMessages(msgs)
    expect(JSON.stringify(out.messages)).not.toContain('SECRETVALUE')
  })

  it('does not mutate the input array', () => {
    const msgs: Message[] = [toolUse('t1', 'Read', { file_path: '/repo/.env' }), toolResult('t1', 'SECRETVALUE')]
    const before = JSON.stringify(msgs)
    sanitizeMessages(msgs)
    expect(JSON.stringify(msgs)).toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/training/messageSnapshot.test.ts`
Expected: FAIL — `Failed to resolve import "../../training/messageSnapshot.js"`

- [ ] **Step 3: Write the implementation**

Create `engine/training/messageSnapshot.ts`:

```ts
/**
 * Prepare a conversation for persistence as training data.
 *
 * The snapshot is the training corpus, so it holds verbatim repo source and
 * anything else the agent read. Three policies apply at write time:
 *   - truncate individual tool results (one Read of a large file would
 *     otherwise dominate the example and balloon the corpus)
 *   - redact results whose originating tool touched a sensitive path
 *   - cap the whole snapshot, dropping oldest non-system messages
 *
 * Pure: no I/O, no mutation of the input.
 */

import type { Message, ContentBlock } from '../types.js'

export const RESULT_CAP_BYTES = 4096
export const FILE_CAP_BYTES = 2 * 1024 * 1024

const SENSITIVE =
  /(^|[\/\\.])(\.env|env\.local)([\/\\.]|$)|credentials|secrets?\b|\.pem\b|id_rsa|\.p12\b|\.pfx\b/i

export type SanitizeOptions = {
  resultCapBytes?: number
  fileCapBytes?: number
}

export type SanitizeResult = {
  messages: Message[]
  truncatedMessages: number
}

/** Any string in a tool input that looks like a sensitive path or file. */
function inputTouchesSensitive(input: unknown): boolean {
  if (input === null || input === undefined) return false
  if (typeof input === 'string') return SENSITIVE.test(input)
  if (Array.isArray(input)) return input.some(inputTouchesSensitive)
  if (typeof input === 'object') return Object.values(input as Record<string, unknown>).some(inputTouchesSensitive)
  return false
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text
  const half = Math.floor(cap / 2)
  const elided = text.length - half * 2
  return `${text.slice(0, half)}\n…[${elided} bytes elided]…\n${text.slice(-half)}`
}

function blockText(content: ContentBlock[] | string): string {
  if (typeof content === 'string') return content
  return content.map(b => ('text' in b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('')
}

/**
 * Sanitize a conversation for persistence. Returns a deep-copied array; the
 * input is never mutated.
 */
export function sanitizeMessages(messages: Message[], opts: SanitizeOptions = {}): SanitizeResult {
  const resultCap = opts.resultCapBytes ?? RESULT_CAP_BYTES
  const fileCap = opts.fileCapBytes ?? FILE_CAP_BYTES

  // Map tool_use_id → whether that call touched a sensitive path.
  const sensitiveCalls = new Set<string>()
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && inputTouchesSensitive(b.input)) sensitiveCalls.add(b.id)
    }
  }

  const cleaned: Message[] = messages.map(m => ({
    role: m.role,
    content: m.content.map((b): ContentBlock => {
      if (b.type !== 'tool_result') return { ...b }
      if (sensitiveCalls.has(b.tool_use_id)) {
        return { ...b, content: '[redacted: sensitive path]' }
      }
      return { ...b, content: truncate(blockText(b.content), resultCap) }
    }),
  }))

  // Whole-file cap: drop oldest non-system messages until it fits.
  let truncatedMessages = 0
  const kept = [...cleaned]
  while (JSON.stringify(kept).length > fileCap && kept.length > 1) {
    const idx = kept.findIndex(m => m.role !== 'system')
    if (idx === -1 || idx === kept.length - 1) break
    kept.splice(idx, 1)
    truncatedMessages++
  }

  return { messages: kept, truncatedMessages }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/training/messageSnapshot.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add engine/training/messageSnapshot.ts engine/__tests__/training/messageSnapshot.test.ts
git commit -m "feat(training): message snapshot sanitizer

Truncates oversized tool results, redacts results from calls that touched
.env/credentials/keys, and caps the whole snapshot by dropping oldest
non-system messages. Pure and non-mutating so the recorder stays simple."
```

---

## Task 3: Recorder writes the corpus

**Files:**
- Modify: `engine/training/trajectoryRecorder.ts`
- Modify: `engine/__tests__/training/trajectoryRecorder.test.ts` (extend; do not rewrite)

- [ ] **Step 1: Write the failing test**

Append to `engine/__tests__/training/trajectoryRecorder.test.ts` (keep every existing test):

```ts
// ─── endTask / message snapshot ───────────────────────────────────

describe('endTask', () => {
  it('writes a schemaVersion 2 snapshot with real message content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-snap-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-snap', 'qwen3.6:27b')
    const path = r.endTask([
      { role: 'user', content: [{ type: 'text', text: 'add a test for parseFoo' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I will add it.' }] },
    ])

    expect(path).toBe(join(dir, 'task-snap.messages.json'))
    const snap = JSON.parse(readFileSync(path!, 'utf-8'))
    expect(snap.schemaVersion).toBe(2)
    expect(snap.taskId).toBe('task-snap')
    expect(snap.model).toBe('qwen3.6:27b')
    expect(typeof snap.startedAt).toBe('string')
    expect(typeof snap.endedAt).toBe('string')
    expect(snap.messages[0].content[0].text).toBe('add a test for parseFoo')
  })

  it('applies the sanitizer — a .env read is redacted in the snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-redact-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-redact', 'm')
    const path = r.endTask([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/repo/.env' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'KEY=sk-secret' }] },
    ])
    expect(readFileSync(path!, 'utf-8')).not.toContain('sk-secret')
  })

  it('is a no-op when called twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-twice-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-twice', 'm')
    expect(r.endTask([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).not.toBeNull()
    expect(r.endTask([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBeNull()
  })

  it('writes no snapshot when the conversation is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-empty-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-empty', 'm')
    expect(r.endTask([])).toBeNull()
    expect(existsSync(join(dir, 'task-empty.messages.json'))).toBe(false)
  })

  it('clears the active task so a later recordTurn does not write into it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-clear-'))
    const r = new TrajectoryRecorder(dir)
    r.startTask('task-clear', 'm')
    r.endTask([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(r.taskId).toBeNull()
  })
})
```

Ensure the test file's imports include `existsSync` from `fs` and the `Message` type is available; add to the existing import lines at the top:

```ts
import { mkdtempSync, readFileSync, existsSync } from 'fs'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/training/trajectoryRecorder.test.ts`
Expected: FAIL — `r.endTask is not a function`

- [ ] **Step 3: Write the implementation**

In `engine/training/trajectoryRecorder.ts`:

Add imports at the top:

```ts
import { writeFileSync } from 'fs'
import { sanitizeMessages } from './messageSnapshot.js'
import type { Message } from '../types.js'
```

Add a `_startedAt` field next to the other private fields:

```ts
  private _startedAt: string = ''
```

Set it in `startTask` (alongside the existing assignments):

```ts
    this._startedAt = new Date().toISOString()
```

Add the method after `recordTurn`:

```ts
  /**
   * Close the task and persist the conversation as training corpus.
   *
   * Returns the snapshot path, or null when there is nothing worth keeping
   * (no active task, or an empty conversation). Clears the active task, so a
   * second call is a no-op and a late recordTurn cannot write into a finished
   * task.
   */
  endTask(messages: Message[], meta?: { endedAt?: string }): string | null {
    const taskId = this._taskId
    if (!taskId) return null
    this._taskId = null

    if (!Array.isArray(messages) || messages.length === 0) return null

    const { messages: cleaned, truncatedMessages } = sanitizeMessages(messages)

    const snapshot = {
      schemaVersion: 2,
      taskId,
      model: this._model,
      adapterId: this._adapterId,
      startedAt: this._startedAt,
      endedAt: meta?.endedAt ?? new Date().toISOString(),
      truncatedMessages,
      messages: cleaned,
    }

    const filePath = join(this.baseDir, `${taskId}.messages.json`)
    try {
      writeFileSync(filePath, JSON.stringify(snapshot) + '\n', 'utf-8')
      return filePath
    } catch (e) {
      console.error(`[trajectory] Snapshot write failed (task=${taskId}): ${e}`)
      return null
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/training/trajectoryRecorder.test.ts`
Expected: PASS — existing tests plus 5 new

- [ ] **Step 5: Run the full suite**

Run: `bunx vitest run`
Expected: `8 failed`, passed count up by the new tests

- [ ] **Step 6: Commit**

```bash
git add engine/training/trajectoryRecorder.ts engine/__tests__/training/trajectoryRecorder.test.ts
git commit -m "feat(training): endTask writes the real conversation as corpus

The recorder stored sha256(args).slice(0,12) and nothing else, so every SFT
target was a synthesized 'Tool sequence: Read(ok, 12ms) -> ...' string. endTask
persists the actual messages, sanitized, as <taskId>.messages.json."
```

---

## Task 4: Git facts

**Files:**
- Create: `engine/training/gitFacts.ts`
- Create: `engine/__tests__/training/gitFacts.test.ts`

The only module in this stack that shells out. Isolated so `taskOutcome` (Task 5) stays pure and fully testable.

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/training/gitFacts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectGitFacts, isTestPath } from '../../training/gitFacts.js'

describe('isTestPath', () => {
  it('recognizes common test layouts', () => {
    expect(isTestPath('engine/__tests__/foo.test.ts')).toBe(true)
    expect(isTestPath('src/foo.spec.tsx')).toBe(true)
    expect(isTestPath('gilded/tests/test_realm.py')).toBe(true)
    expect(isTestPath('pkg/thing_test.go')).toBe(true)
    expect(isTestPath('test/helper.rb')).toBe(true)
  })

  it('does not flag product code', () => {
    expect(isTestPath('engine/bridge/conversationLoop.ts')).toBe(false)
    expect(isTestPath('gilded/society/characters.py')).toBe(false)
    expect(isTestPath('src/latest.ts')).toBe(false)
  })
})

describe('collectGitFacts', () => {
  let repo: string
  let baseSha: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitfacts-'))
    const run = (c: string) => execSync(c, { cwd: repo, stdio: 'pipe' })
    run('git init -q')
    run('git config user.email t@t.t')
    run('git config user.name t')
    mkdirSync(join(repo, 'tests'), { recursive: true })
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1\n')
    writeFileSync(join(repo, 'tests', 'app.test.ts'), 'it("a", () => {})\nit("b", () => {})\nit("c", () => {})\n')
    run('git add -A')
    run('git commit -q -m base')
    baseSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
  })

  it('reports added and deleted line counts per changed file', () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1\nexport const b = 2\n')
    const facts = collectGitFacts(repo, baseSha)!
    const app = facts.changed.find(c => c.path === 'app.ts')!
    expect(app.added).toBe(1)
    expect(app.deleted).toBe(0)
  })

  it('reports outright deletions', () => {
    rmSync(join(repo, 'tests', 'app.test.ts'))
    const facts = collectGitFacts(repo, baseSha)!
    expect(facts.removed).toContain('tests/app.test.ts')
  })

  it('reports dirty working-tree paths', () => {
    writeFileSync(join(repo, 'scratch.txt'), 'junk\n')
    const facts = collectGitFacts(repo, baseSha)!
    expect(facts.dirty).toContain('scratch.txt')
  })

  it('returns null outside a git repo', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'notgit-'))
    expect(collectGitFacts(notRepo, null)).toBeNull()
  })

  it('returns null when the base sha is unknown', () => {
    expect(collectGitFacts(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/training/gitFacts.test.ts`
Expected: FAIL — `Failed to resolve import "../../training/gitFacts.js"`

- [ ] **Step 3: Write the implementation**

Create `engine/training/gitFacts.ts`:

```ts
/**
 * Objective facts about what a task changed on disk.
 *
 * The only module in the reward stack that shells out; taskOutcome.ts stays
 * pure by consuming this structure rather than running git itself.
 */

import { execSync } from 'child_process'

export type ChangedFile = { path: string; added: number; deleted: number }

export type GitFacts = {
  changed: ChangedFile[]
  removed: string[]
  dirty: string[]
}

const TEST_PATH =
  /(^|[\/\\])(tests?|__tests__|spec)[\/\\]|(^|[\/\\])test_[^\/\\]+\.py$|[._](test|spec)\.[jt]sx?$|_test\.(go|py|rb)$/i

/** True when a repo-relative path is a test file by any common convention. */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 })
    .toString()
}

/**
 * Collect changes between `baseSha` and the current working tree.
 * Returns null when cwd is not a git repo or baseSha is not resolvable —
 * callers must degrade to `unknown` rather than guessing.
 */
export function collectGitFacts(cwd: string, baseSha: string | null): GitFacts | null {
  try {
    git(cwd, 'rev-parse --is-inside-work-tree')
  } catch {
    return null
  }

  const range = baseSha ?? 'HEAD'
  try {
    git(cwd, `rev-parse --verify --quiet ${range}^{commit}`)
  } catch {
    return null
  }

  try {
    const changed: ChangedFile[] = []
    for (const line of git(cwd, `diff --numstat ${range}`).split('\n')) {
      const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      changed.push({
        path: m[3].replace(/\\/g, '/'),
        added: m[1] === '-' ? 0 : parseInt(m[1], 10),
        deleted: m[2] === '-' ? 0 : parseInt(m[2], 10),
      })
    }

    const removed = git(cwd, `diff --name-only --diff-filter=D ${range}`)
      .split('\n').map(l => l.trim().replace(/\\/g, '/')).filter(Boolean)

    const dirty = git(cwd, 'status --porcelain')
      .split('\n')
      .map(l => l.slice(3).trim().replace(/\\/g, '/'))
      .filter(Boolean)

    return { changed, removed, dirty }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/training/gitFacts.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add engine/training/gitFacts.ts engine/__tests__/training/gitFacts.test.ts
git commit -m "feat(training): git facts collector

Isolates every shell-out in the reward stack so component measurement stays
pure. Returns null rather than guessing when git is unavailable."
```

---

## Task 5: Measure components, or say unknown

**Files:**
- Create: `engine/training/taskOutcome.ts`
- Create: `engine/__tests__/training/taskOutcome.test.ts`
- Modify: `engine/training/rewardLabeler.ts` (the `RewardComponents` type only — the reward maths is Task 6)

Today `datasetBuilder.ts:303-310` hardcodes `typecheckPass: 1`, `buildPass: 1` and `testsUnmodified: 1`. The last permanently disables the only safety check in the reward function. This task makes every component either measured or explicitly `unknown`.

- [ ] **Step 1: Widen the component type**

In `engine/training/rewardLabeler.ts`, replace the `RewardComponents` type:

```ts
/** A component value that could not be observed. Excluded from the reward denominator. */
export type ComponentValue = number | 'unknown'

export type RewardComponents = {
  testsPass: ComponentValue      // 0-1 ratio
  typecheckPass: ComponentValue  // 0 | 1
  buildPass: ComponentValue      // 0 | 1
  diffClean: ComponentValue      // 0 | 1
  taskCompleted: ComponentValue  // 0 | 1
  stuckTurns: number
  iterFraction: number           // turns / 500
  userSatisfaction: -1 | 0 | 1
  testsUnmodified: 0 | 1         // 0 = agent weakened tests = reward hacking. Never 'unknown'.
}
```

- [ ] **Step 2: Write the failing test**

Create `engine/__tests__/training/taskOutcome.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildComponents } from '../../training/taskOutcome.js'
import type { TaskOutcomeInput } from '../../training/taskOutcome.js'

function base(overrides: Partial<TaskOutcomeInput> = {}): TaskOutcomeInput {
  return {
    testObservations: [],
    commandObservations: [],
    contract: null,
    git: null,
    trackedModifiedFiles: [],
    stuckTurns: 0,
    turns: 10,
    ...overrides,
  }
}

describe('buildComponents — testsPass', () => {
  it('uses the last test observation as the ratio', () => {
    const c = buildComponents(base({
      testObservations: [{ passed: 1, total: 10 }, { passed: 9, total: 10 }],
    }))
    expect(c.testsPass).toBe(0.9)
  })

  it('is unknown when no test runner was observed', () => {
    expect(buildComponents(base()).testsPass).toBe('unknown')
  })
})

describe('buildComponents — taskCompleted (decision D3)', () => {
  it('is 1 when the contract is complete AND a green test run corroborates it', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0 },
      testObservations: [{ passed: 10, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(1)
  })

  it('is UNKNOWN when the contract claims complete but no test ever ran', () => {
    // The S4_DET regression: agent reported "25/25 passed" with the suite never run.
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0 },
      testObservations: [],
    }))
    expect(c.taskCompleted).toBe('unknown')
  })

  it('is 0 when the contract has failed assertions', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: false, failed: 2 },
      testObservations: [{ passed: 10, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('is 0 when the contract is complete but tests are red', () => {
    const c = buildComponents(base({
      contract: { active: true, complete: true, failed: 0 },
      testObservations: [{ passed: 4, total: 10 }],
    }))
    expect(c.taskCompleted).toBe(0)
  })

  it('is unknown with no contract and no observation', () => {
    expect(buildComponents(base()).taskCompleted).toBe('unknown')
  })
})

describe('buildComponents — typecheck and build', () => {
  it('are unknown when no such command ran', () => {
    const c = buildComponents(base())
    expect(c.typecheckPass).toBe('unknown')
    expect(c.buildPass).toBe('unknown')
  })

  it('reflect the observed exit status', () => {
    const c = buildComponents(base({
      commandObservations: [{ kind: 'typecheck', ok: true }, { kind: 'build', ok: false }],
    }))
    expect(c.typecheckPass).toBe(1)
    expect(c.buildPass).toBe(0)
  })
})

describe('buildComponents — diffClean', () => {
  it('is unknown without git', () => {
    expect(buildComponents(base()).diffClean).toBe('unknown')
  })

  it('is 1 when every dirty path was tracked as agent-modified', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['src/a.ts'] },
      trackedModifiedFiles: ['/repo/src/a.ts'],
    }))
    expect(c.diffClean).toBe(1)
  })

  it('is 0 when an untracked stray file is dirty', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: [], dirty: ['src/a.ts', 'scratch.txt'] },
      trackedModifiedFiles: ['/repo/src/a.ts'],
    }))
    expect(c.diffClean).toBe(0)
  })
})

describe('buildComponents — testsUnmodified safety gate', () => {
  it('is 1 when only tests were ADDED (legitimate TDD)', () => {
    const c = buildComponents(base({
      git: {
        changed: [{ path: 'tests/a.test.ts', added: 40, deleted: 0 }, { path: 'src/a.ts', added: 10, deleted: 2 }],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(1)
  })

  it('is 0 when a test file is deleted outright', () => {
    const c = buildComponents(base({
      git: { changed: [], removed: ['tests/a.test.ts'], dirty: [] },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('is 0 when tests lose more lines than they gain while product code changed', () => {
    // The characters.py 378->148 gutting shape.
    const c = buildComponents(base({
      git: {
        changed: [{ path: 'tests/a.test.ts', added: 2, deleted: 230 }, { path: 'src/a.ts', added: 5, deleted: 1 }],
        removed: [], dirty: [],
      },
    }))
    expect(c.testsUnmodified).toBe(0)
  })

  it('is 1 when tests shrink but no product code changed (a pure test refactor)', () => {
    const c = buildComponents(base({
      git: { changed: [{ path: 'tests/a.test.ts', added: 2, deleted: 30 }], removed: [], dirty: [] },
    }))
    expect(c.testsUnmodified).toBe(1)
  })

  it('is 1 (not unknown) when git is unavailable — a gate must not degrade', () => {
    expect(buildComponents(base()).testsUnmodified).toBe(1)
  })
})

describe('buildComponents — telemetry passthrough', () => {
  it('carries stuckTurns and derives iterFraction from turns/500', () => {
    const c = buildComponents(base({ stuckTurns: 4, turns: 250 }))
    expect(c.stuckTurns).toBe(4)
    expect(c.iterFraction).toBe(0.5)
    expect(c.userSatisfaction).toBe(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/training/taskOutcome.test.ts`
Expected: FAIL — `Failed to resolve import "../../training/taskOutcome.js"`

- [ ] **Step 4: Write the implementation**

Create `engine/training/taskOutcome.ts`:

```ts
/**
 * Turn observations from a finished task into reward components.
 *
 * The rule this module exists to enforce: a component is either MEASURED from
 * something that actually happened, or it is 'unknown' and leaves the reward
 * denominator. It is never assumed. The previous offline labeler hardcoded
 * typecheckPass/buildPass/testsUnmodified to 1, which permanently disabled the
 * only safety check in the reward function.
 *
 * Pure — git access is the caller's job (see gitFacts.ts).
 */

import { isTestPath, type GitFacts } from './gitFacts.js'
import type { RewardComponents } from './rewardLabeler.js'

export type TestObservation = { passed: number; total: number }
export type CommandObservation = { kind: 'typecheck' | 'build'; ok: boolean }
export type ContractFacts = { active: boolean; complete: boolean; failed: number }

export type TaskOutcomeInput = {
  testObservations: TestObservation[]
  commandObservations: CommandObservation[]
  contract: ContractFacts | null
  git: GitFacts | null
  trackedModifiedFiles: string[]
  stuckTurns: number
  turns: number
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** A dirty path counts as agent-modified if any tracked path resolves to it. */
function wasTracked(dirtyPath: string, tracked: string[]): boolean {
  const d = normalize(dirtyPath)
  return tracked.some(t => {
    const n = normalize(t)
    return n === d || n.endsWith(`/${d}`) || d.endsWith(`/${n}`)
  })
}

function lastObservation(obs: TestObservation[]): TestObservation | null {
  for (let i = obs.length - 1; i >= 0; i--) {
    if (obs[i].total > 0) return obs[i]
  }
  return null
}

/**
 * The anti-reward-hacking gate, scoped to WEAKENING rather than touching.
 *
 * CynCo does TDD, so writing tests is frequently the assigned job — a gate that
 * fired on any test-file edit would hard-fail every legitimate red-green task,
 * which is almost certainly why it was previously hardcoded to 1. It fires on:
 *   - a test file deleted outright, or
 *   - test files losing more lines than they gain while product code also changed.
 * Adding tests is free. Gutting a suite to make it pass is -1.0.
 */
function assessTestsUnmodified(git: GitFacts | null): 0 | 1 {
  if (!git) return 1
  if (git.removed.some(isTestPath)) return 0

  const testChanges = git.changed.filter(c => isTestPath(c.path))
  if (testChanges.length === 0) return 1

  const net = testChanges.reduce((sum, c) => sum + c.added - c.deleted, 0)
  const productChanged = git.changed.some(c => !isTestPath(c.path))

  return net < 0 && productChanged ? 0 : 1
}

export function buildComponents(input: TaskOutcomeInput): RewardComponents {
  const lastTest = lastObservation(input.testObservations)
  const testsPass = lastTest ? lastTest.passed / lastTest.total : 'unknown'
  const greenRun = lastTest !== null && lastTest.passed === lastTest.total

  let taskCompleted: RewardComponents['taskCompleted']
  if (input.contract && (input.contract.failed > 0 || (input.contract.active && !input.contract.complete))) {
    taskCompleted = 0
  } else if (input.contract?.complete) {
    // Contract assertions are agent-attested, so completion needs corroboration
    // from a real test run before it counts as 1 (decision D3).
    taskCompleted = lastTest === null ? 'unknown' : greenRun ? 1 : 0
  } else {
    taskCompleted = 'unknown'
  }

  const typecheck = input.commandObservations.filter(o => o.kind === 'typecheck')
  const build = input.commandObservations.filter(o => o.kind === 'build')

  let diffClean: RewardComponents['diffClean'] = 'unknown'
  if (input.git) {
    diffClean = input.git.dirty.every(p => wasTracked(p, input.trackedModifiedFiles)) ? 1 : 0
  }

  return {
    testsPass,
    typecheckPass: typecheck.length === 0 ? 'unknown' : typecheck.every(o => o.ok) ? 1 : 0,
    buildPass: build.length === 0 ? 'unknown' : build.every(o => o.ok) ? 1 : 0,
    diffClean,
    taskCompleted,
    stuckTurns: input.stuckTurns,
    iterFraction: input.turns / 500,
    userSatisfaction: 0,
    testsUnmodified: assessTestsUnmodified(input.git),
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/training/taskOutcome.test.ts`
Expected: PASS — 17 tests

- [ ] **Step 6: Commit**

```bash
git add engine/training/taskOutcome.ts engine/training/rewardLabeler.ts engine/__tests__/training/taskOutcome.test.ts
git commit -m "feat(training): measure reward components or mark them unknown

Replaces the hardcoded typecheckPass/buildPass/testsUnmodified assumptions. A
contract marked complete with no observed test run now yields taskCompleted
'unknown' rather than 1 — the S4_DET 'claimed 25/25 passed' shape. The safety
gate fires on test WEAKENING (deletion, or net line loss alongside product
changes) so legitimate TDD is not punished."
```

---

## Task 6: Un-saturate the reward

**Files:**
- Modify: `engine/training/rewardLabeler.ts:42-88`
- Modify: `engine/__tests__/training/rewardLabeler.test.ts` (extend; existing assertions should survive)

The weights sum to 2.8 and the result clips to 1.0, so the non-test components alone (1.8) exceed the ceiling before `testsPass` is consulted. Proof from the live data: `testsPass` ranges 0.4286–1.0 across the 147 labeled tasks and every one scored exactly 1.0.

**Note:** the existing assertions in `rewardLabeler.test.ts` were written against non-saturated bases and should continue to pass under normalization. If one fails, read it carefully before changing it — it may be catching a real regression.

- [ ] **Step 1: Write the failing test**

Append to `engine/__tests__/training/rewardLabeler.test.ts`:

```ts
// ─── Normalization (2026-07-25) ───────────────────────────────────

describe('computeReward — normalization', () => {
  const withTests = (testsPass: number): RewardComponents => ({
    testsPass,
    typecheckPass: 1,
    buildPass: 1,
    diffClean: 1,
    taskCompleted: 1,
    stuckTurns: 0,
    iterFraction: 0,
    userSatisfaction: 0,
    testsUnmodified: 1,
  })

  it('is strictly monotonic in testsPass even with every other component perfect', () => {
    // THE bug: weights summed to 2.8 and clipped to 1.0, so 0.43 and 1.0 tied.
    const low = computeReward(withTests(0.4286))
    const high = computeReward(withTests(1.0))
    expect(low).toBeLessThan(high)
    expect(high - low).toBeGreaterThan(0.15)
  })

  it('does not reach the ceiling on non-test components alone', () => {
    const noTests = computeReward({ ...withTests(0), testsPass: 0 })
    expect(noTests).toBeLessThan(1.0)
  })

  it('excludes unknown components from the denominator', () => {
    // Only testsPass is known, so the base is exactly testsPass.
    const r = computeReward({
      testsPass: 0.5,
      typecheckPass: 'unknown',
      buildPass: 'unknown',
      diffClean: 'unknown',
      taskCompleted: 'unknown',
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    })
    expect(r).toBeCloseTo(0.5, 6)
  })

  it('an unknown component neither helps nor hurts relative to being absent', () => {
    const known = computeReward({ ...withTests(0.5), typecheckPass: 1, buildPass: 1, diffClean: 1, taskCompleted: 1 })
    const unknown = computeReward({
      ...withTests(0.5), typecheckPass: 'unknown', buildPass: 'unknown', diffClean: 'unknown', taskCompleted: 'unknown',
    })
    expect(known).toBeGreaterThan(unknown) // real passes raise the score
    expect(unknown).toBeCloseTo(0.5, 6)    // unknowns leave it at testsPass alone
  })

  it('scores 0 when nothing at all could be measured', () => {
    const r = computeReward({
      testsPass: 'unknown',
      typecheckPass: 'unknown',
      buildPass: 'unknown',
      diffClean: 'unknown',
      taskCompleted: 'unknown',
      stuckTurns: 0,
      iterFraction: 0,
      userSatisfaction: 0,
      testsUnmodified: 1,
    })
    expect(r).toBe(0)
  })

  it('still returns -1.0 when the safety gate trips', () => {
    expect(computeReward({ ...withTests(1.0), testsUnmodified: 0 })).toBe(-1.0)
  })
})

describe('finalizeTask — labelerVersion', () => {
  it('stamps labelerVersion 2 on every record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reward-ver-'))
    const r = finalizeTask('task-ver', 5, {
      testsPass: 1, typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 'unknown', taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    }, dir)
    expect(r.labelerVersion).toBe(2)
    const parsed = JSON.parse(readFileSync(join(dir, 'task-ver.reward.json'), 'utf-8'))
    expect(parsed.labelerVersion).toBe(2)
  })

  it('flags a record with no measurable positive component as degenerate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reward-degen-'))
    const r = finalizeTask('task-degen', 2, {
      testsPass: 'unknown', typecheckPass: 'unknown', buildPass: 'unknown',
      diffClean: 'unknown', taskCompleted: 'unknown',
      stuckTurns: 0, iterFraction: 0, userSatisfaction: 0, testsUnmodified: 1,
    }, dir)
    expect(r.degenerate).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/training/rewardLabeler.test.ts`
Expected: FAIL — the monotonicity test fails (both values are 1.0), and `labelerVersion` is undefined.

- [ ] **Step 3: Write the implementation**

In `engine/training/rewardLabeler.ts`, replace `computeReward` and extend `TaskReward`:

```ts
export type TaskReward = {
  taskId: string
  turns: number
  components: RewardComponents
  reward: number
  labelerVersion: number
  degenerate?: boolean
}

/**
 * Weights for the positive components. The reward is their weighted MEAN over
 * the components that could actually be measured, so it cannot saturate.
 *
 * Before 2026-07-25 these were summed (total 2.8) and the result clipped to
 * 1.0, which meant the non-test components alone (1.8) hit the ceiling and
 * every testsPass value between 0.43 and 1.0 collapsed to the same score.
 */
const POSITIVE_WEIGHTS: { key: keyof RewardComponents; weight: number }[] = [
  { key: 'testsPass', weight: 1.0 },
  { key: 'typecheckPass', weight: 0.5 },
  { key: 'buildPass', weight: 0.3 },
  { key: 'diffClean', weight: 0.2 },
  { key: 'taskCompleted', weight: 0.5 },
]

/** Weighted mean of the measurable positive components, in [0,1]. */
export function positiveBase(c: RewardComponents): { base: number; known: number } {
  let num = 0
  let den = 0
  for (const { key, weight } of POSITIVE_WEIGHTS) {
    const v = c[key]
    if (typeof v !== 'number' || Number.isNaN(v)) continue
    num += weight * v
    den += weight
  }
  return { base: den > 0 ? num / den : 0, known: den }
}

/**
 * Compute a scalar reward in [-1, 1] from task outcome components.
 *
 * Anti-reward-hacking gate: testsUnmodified == 0 -> reward = -1.0 immediately.
 */
export function computeReward(c: RewardComponents): number {
  // Anti-reward-hacking gate — must check first
  if (c.testsUnmodified === 0) {
    return -1.0
  }

  const { base } = positiveBase(c)

  let r =
    base -
    0.05 * Math.min(c.stuckTurns, 10) -
    0.1 * c.iterFraction +
    0.3 * Math.max(0, c.userSatisfaction)

  // Clip to [-1, 1]
  if (r < -1.0) r = -1.0
  if (r > 1.0) r = 1.0

  return r
}
```

And in `finalizeTask`, build the record with the new fields:

```ts
  const reward = computeReward(components)
  const { known } = positiveBase(components)

  const result: TaskReward = {
    taskId,
    turns,
    components,
    reward,
    labelerVersion: 2,
    ...(known === 0 ? { degenerate: true } : {}),
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/training/rewardLabeler.test.ts`
Expected: PASS — all existing tests plus 8 new

- [ ] **Step 5: Fix the stale comment**

In `engine/__tests__/training/rewardLabeler.test.ts`, the first test carries the comment
`// 1.0 + 0.5 + 0.3 + 0.2 + 0.5 + 0.3 = 2.8 → clipped to 1.0`. Replace it with
`// base 1.0 (all components perfect) + 0.3 satisfaction → clipped to 1.0`.

- [ ] **Step 6: Run the full suite**

Run: `bunx vitest run`
Expected: `8 failed`, passed count up

- [ ] **Step 7: Commit**

```bash
git add engine/training/rewardLabeler.ts engine/__tests__/training/rewardLabeler.test.ts
git commit -m "fix(training): normalize the reward to its ceiling

Weights summed to 2.8 and clipped to 1.0, so the non-test components alone
reached the ceiling and testsPass values from 0.43 to 1.0 all scored exactly
1.0 — the direct cause of 147/147 examples labeled 1.0. The reward is now the
weighted MEAN over measurable components; unknowns leave the denominator."
```

---

## Task 7: One task boundary in the live engine

**Files:**
- Modify: `engine/bridge/conversationLoop.ts` (`:675` wrapper, `:3262-3291` telemetry, new private helpers)
- Create: `engine/__tests__/bridge/finalizeTrajectory.test.ts`

`finalizeTask` has never had a non-test caller — every label ever written was an offline guess. This task gives it one.

`handleUserMessage` (`:675`) has at least six exits: the `:678` guard, in-loop returns near `:1795`/`:2000`/`:2391`/`:2473`, the max-iterations fall-through at `:2606-2608`, and thrown exceptions. **Do not enumerate them.** Wrap instead — this is the standing lesson that when a path becomes terminal you must audit every *other* exit that now diverges; a `finally` makes divergence impossible.

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/bridge/finalizeTrajectory.test.ts`. This tests the extracted helper rather than booting a whole loop:

```ts
import { describe, it, expect } from 'vitest'
import { runWithFinalize } from '../../bridge/finalizeGuard.js'

describe('runWithFinalize', () => {
  it('finalizes after normal completion', async () => {
    let calls = 0
    await runWithFinalize(async () => { /* work */ }, () => { calls++ })
    expect(calls).toBe(1)
  })

  it('finalizes after an early return', async () => {
    let calls = 0
    await runWithFinalize(async () => { return }, () => { calls++ })
    expect(calls).toBe(1)
  })

  it('finalizes after a thrown exception, and rethrows', async () => {
    let calls = 0
    await expect(
      runWithFinalize(async () => { throw new Error('boom') }, () => { calls++ })
    ).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })

  it('finalizes exactly once even if the body is long-running', async () => {
    let calls = 0
    await runWithFinalize(async () => { await new Promise(r => setTimeout(r, 5)) }, () => { calls++ })
    expect(calls).toBe(1)
  })

  it('never lets a finalizer failure escape into the session', async () => {
    await expect(
      runWithFinalize(async () => { /* ok */ }, () => { throw new Error('labeler exploded') })
    ).resolves.toBeUndefined()
  })

  it('preserves the body error when the finalizer also throws', async () => {
    await expect(
      runWithFinalize(async () => { throw new Error('body') }, () => { throw new Error('finalizer') })
    ).rejects.toThrow('body')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/bridge/finalizeTrajectory.test.ts`
Expected: FAIL — `Failed to resolve import "../../bridge/finalizeGuard.js"`

- [ ] **Step 3: Write the guard**

Create `engine/bridge/finalizeGuard.ts`:

```ts
/**
 * Run a body and guarantee a finalizer runs exactly once afterwards, whatever
 * exit the body takes.
 *
 * handleUserMessage has at least six exits (an early guard return, four in-loop
 * returns, the max-iterations fall-through, and thrown exceptions). Hooking
 * each one individually is how divergence gets introduced: a later edit adds a
 * seventh exit and silently skips the hook. The finalizer's own failures are
 * swallowed — a labeling bug must never break a user's session.
 */
export async function runWithFinalize(
  body: () => Promise<void>,
  finalize: () => void,
): Promise<void> {
  try {
    await body()
  } finally {
    try {
      finalize()
    } catch (e) {
      console.error(`[trajectory] finalize failed: ${e}`)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/bridge/finalizeTrajectory.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Wire the loop**

In `engine/bridge/conversationLoop.ts`:

**5a.** Add imports near the other bridge imports:

```ts
import { runWithFinalize } from './finalizeGuard.js'
import { parseTestSummary } from './testSummary.js'
```

**5b.** Add private fields next to the other loop state:

```ts
  private taskTestObservations: { passed: number; total: number }[] = []
  private taskCommandObservations: { kind: 'typecheck' | 'build'; ok: boolean }[] = []
  private taskGitBaseSha: string | null = null
```

**5c.** Rename the existing `async handleUserMessage(text, opts?)` at `:675` to
`private async runUserMessage(text: string, opts?: { contract?: HarnessContractSpec }): Promise<void>`
— the body is unchanged. Immediately above it, add the new public wrapper:

```ts
  async handleUserMessage(text: string, opts?: { contract?: HarnessContractSpec }): Promise<void> {
    return runWithFinalize(
      () => this.runUserMessage(text, opts),
      () => this.finalizeTrajectory(),
    )
  }
```

**5d.** In `runUserMessage`, at the trajectory-start block (`:723-731`), reset the per-task buffers and capture the git base commit. Replace that block with:

```ts
    // Start trajectory recording for this task
    try {
      const { getTrajectoryRecorder } = require('../training/trajectoryRecorder.js')
      const { randomUUID } = require('crypto')
      const recorder = getTrajectoryRecorder()
      if (recorder) {
        recorder.startTask(`task-${randomUUID().slice(0, 8)}`, this.config.model ?? 'unknown')
        this.taskTestObservations = []
        this.taskCommandObservations = []
        this.taskGitBaseSha = this.readGitHead()
      }
    } catch {}
```

**5e.** Replace the telemetry block at `:3262-3291`. The `testsTotal: 0` / `testsFailing: 0` literals become real values, and observations are buffered for the labeler:

```ts
    // Record trajectory turn for future training
    try {
      const { getTrajectoryRecorder } = require('../training/trajectoryRecorder.js')
      const recorder = getTrajectoryRecorder()
      if (recorder) {
        const { createHash } = require('crypto')
        const elapsed = Date.now() - toolStartMs
        const inputHash = createHash('sha256').update(JSON.stringify(toolInput)).digest('hex').slice(0, 12)

        const command = toolName === 'Bash' ? (toolInput as { command?: unknown })?.command : undefined
        let testsTotal = 0
        let testsFailing = 0
        if (typeof command === 'string') {
          const summary = parseTestSummary(command, result.output ?? '')
          if (summary) {
            testsTotal = summary.total
            testsFailing = summary.total - summary.passed
            this.taskTestObservations.push({ passed: summary.passed, total: summary.total })
          }
          const kind = classifyCheckCommand(command)
          if (kind) this.taskCommandObservations.push({ kind, ok: !result.isError })
        }

        recorder.recordTurn({
          toolCalls: [{ name: toolName, inputHash, success: !result.isError, latencyMs: elapsed }],
          stateFeatures: {
            filesTouched: this.fileTracker.getModifiedFiles().length,
            diffSize: 0,
            testsTotal,
            testsFailing,
            toolsUsed: [toolName],
            contextPct: 0,
          },
          rewardComponents: {
            toolSuccessRate: result.isError ? 0 : 1,
            stuckTurns: 0,
            varietyEntropy: 0,
          },
        })
        this.emit({
          type: 'trajectory.turn',
          taskId: recorder.taskId ?? null,
          turnIdx: recorder.turnIdx ?? 0,
        })
      }
    } catch {}
```

**5f.** Add the private helpers as methods on the class (place them near `getFileTracker()` at `:2719`):

```ts
  private readGitHead(): string | null {
    try {
      const { execSync } = require('child_process')
      return execSync('git rev-parse HEAD', {
        cwd: this.executor['cwd'],
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim()
    } catch {
      return null
    }
  }

  /**
   * Close the task: persist the conversation as training corpus, then label it.
   * Called from handleUserMessage's finally, so it runs on every exit path.
   * Idempotent — endTask clears the recorder's active task.
   */
  private finalizeTrajectory(): void {
    const { getTrajectoryRecorder } = require('../training/trajectoryRecorder.js')
    const recorder = getTrajectoryRecorder()
    if (!recorder || !recorder.taskId) return

    const taskId = recorder.taskId
    const turns = recorder.turnIdx ?? 0

    const snapshot = recorder.endTask(this.getMessages())
    if (!snapshot) return

    const { collectGitFacts } = require('../training/gitFacts.js')
    const { buildComponents } = require('../training/taskOutcome.js')
    const { finalizeTask } = require('../training/rewardLabeler.js')

    const components = buildComponents({
      testObservations: this.taskTestObservations,
      commandObservations: this.taskCommandObservations,
      contract: globalContract.isActive()
        ? { active: true, complete: globalContract.isComplete(), failed: globalContract.failedCount() }
        : null,
      git: collectGitFacts(this.executor['cwd'], this.taskGitBaseSha),
      trackedModifiedFiles: this.fileTracker.getModifiedFiles(),
      stuckTurns: 0,
      turns,
    })

    const reward = finalizeTask(taskId, turns, components)
    console.log(`[trajectory] Labeled ${taskId}: reward ${reward.reward.toFixed(3)} (${turns} turns)`)
  }
```

**5g.** Add the command classifier as a module-level function in `engine/bridge/testSummary.ts` (it belongs with command recognition):

```ts
/** Recognize typecheck/build commands so their exit status can be measured. */
export function classifyCheckCommand(command: string): 'typecheck' | 'build' | null {
  if (/\b(tsc|mypy|pyright|flow\s+check)\b/i.test(command)) return 'typecheck'
  if (/\b(bun\s+build|npm\s+run\s+build|yarn\s+build|pnpm\s+build|cargo\s+build|go\s+build|make\b)/i.test(command)) return 'build'
  return null
}
```

Import it in `conversationLoop.ts` alongside `parseTestSummary`.

- [ ] **Step 6: Run the full suite**

Run: `bunx vitest run`
Expected: `8 failed`, passed count up by 6. If any conversationLoop test now fails, the rename in 5c missed a call site — grep for `handleUserMessage` and confirm only the wrapper is public.

- [ ] **Step 7: Commit**

```bash
git add engine/bridge/conversationLoop.ts engine/bridge/finalizeGuard.ts engine/bridge/testSummary.ts engine/__tests__/bridge/finalizeTrajectory.test.ts
git commit -m "feat(bridge): call finalizeTask from the live engine

finalizeTask has never had a non-test caller, so every reward label ever
written was an offline guess. handleUserMessage becomes a thin wrapper whose
finally closes the task across all six-plus exits. Trajectory telemetry also
stops writing literal testsTotal: 0 and records real counts."
```

---

## Task 8: Eligibility, real messages, keep the negatives

**Files:**
- Modify: `engine/training/datasetBuilder.ts` (whole file — `backfillRewards` at `:253-318` is deleted)
- Create: `engine/__tests__/training/datasetBuilder.test.ts`

Three separate defects live in this file. `buildSFTDataset` (`:106-145`) synthesizes the assistant
target as `Tool sequence: Read(ok, 12ms) → Edit(ok, 40ms)` — a string the model can never produce
and must never learn. `buildDPODataset` silently yields nothing because every reward is `1.0`.
`backfillRewards` (`:253-318`) is the machine that manufactured all 147 bad labels; it is the only
caller of `finalizeTask` outside tests today, and Task 7 gave `finalizeTask` a real caller, so it
can go.

The 147 legacy rows are excluded **structurally** — by `labelerVersion` and by the absence of a
message snapshot — not by deleting anything from `~/.cynco`.

**Snapshot loading is optional.** A snapshot is capped at 2 MB and the dashboard polls
`/api/training` on a timer; parsing 300 of them per poll would be hundreds of megabytes of churn.
Eligibility only needs to know a snapshot *exists*, so `loadTrajectories` takes
`{ loadSnapshots: false }` and callers that need message content ask for it.

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/training/datasetBuilder.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadTrajectories,
  buildDatasets,
  summarizeCorpus,
  exportDatasets,
  toChatML,
  isUsable,
} from '../../training/datasetBuilder.js'

let root: string
let trajDir: string
let rewDir: string
let outDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsb-'))
  trajDir = join(root, 'trajectories')
  rewDir = join(root, 'rewards')
  outDir = join(root, 'datasets')
  mkdirSync(trajDir, { recursive: true })
  mkdirSync(rewDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function turnLine(taskId: string, idx: number, model: string) {
  return JSON.stringify({
    task_id: taskId,
    turn_idx: idx,
    ts: '2026-07-25T00:00:00.000Z',
    model,
    tool_calls: [{ name: 'Edit', inputHash: 'abc123def456', success: true, latencyMs: 12 }],
    state_features: {
      filesTouched: 1, diffSize: 4, testsTotal: 10,
      testsFailing: 0, toolsUsed: ['Edit'], contextPct: 0,
    },
    reward_components: { toolSuccessRate: 1, stuckTurns: 0, varietyEntropy: 0 },
  })
}

type SeedOpts = {
  taskId: string
  reward: number
  labelerVersion?: number
  snapshot?: boolean
  degenerate?: boolean
  model?: string
  userText?: string
}

function seed(o: SeedOpts) {
  const model = o.model ?? 'qwen3.6'
  writeFileSync(join(trajDir, `${o.taskId}.jsonl`), turnLine(o.taskId, 0, model) + '\n')

  const rec: Record<string, unknown> = {
    taskId: o.taskId,
    turns: 1,
    components: { testsPass: 0.8, typecheckPass: 'unknown' },
    reward: o.reward,
  }
  if (o.labelerVersion !== undefined) rec.labelerVersion = o.labelerVersion
  if (o.degenerate) rec.degenerate = true
  writeFileSync(join(rewDir, `${o.taskId}.reward.json`), JSON.stringify(rec))

  if (o.snapshot) {
    writeFileSync(join(trajDir, `${o.taskId}.messages.json`), JSON.stringify({
      schemaVersion: 2,
      taskId: o.taskId,
      model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: o.userText ?? 'Fix the failing realm test' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the file first.' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'export const a = 1' }] },
      ],
    }))
  }
}

describe('loadTrajectories — snapshots', () => {
  it('attaches the snapshot when one exists', () => {
    seed({ taskId: 'task-a', reward: 0.8, labelerVersion: 2, snapshot: true })
    const [t] = loadTrajectories(trajDir, rewDir)
    expect(t.hasSnapshot).toBe(true)
    expect(t.snapshot!.messages).toHaveLength(3)
  })

  it('reports hasSnapshot without parsing when loadSnapshots is false', () => {
    seed({ taskId: 'task-a', reward: 0.8, labelerVersion: 2, snapshot: true })
    const [t] = loadTrajectories(trajDir, rewDir, { loadSnapshots: false })
    expect(t.hasSnapshot).toBe(true)
    expect(t.snapshot).toBeNull()
  })

  it('leaves hasSnapshot false when there is no snapshot', () => {
    seed({ taskId: 'task-a', reward: 0.8, labelerVersion: 2 })
    const [t] = loadTrajectories(trajDir, rewDir)
    expect(t.hasSnapshot).toBe(false)
    expect(t.snapshot).toBeNull()
  })
})

describe('isUsable — eligibility', () => {
  it('excludes a legacy v1 reward file even with a snapshot', () => {
    seed({ taskId: 'legacy', reward: 1.0, snapshot: true })
    expect(isUsable(loadTrajectories(trajDir, rewDir)[0])).toBe(false)
  })

  it('excludes a v2 reward with no snapshot', () => {
    seed({ taskId: 'nosnap', reward: 0.9, labelerVersion: 2 })
    expect(isUsable(loadTrajectories(trajDir, rewDir)[0])).toBe(false)
  })

  it('excludes a degenerate record', () => {
    seed({ taskId: 'degen', reward: 0.0, labelerVersion: 2, snapshot: true, degenerate: true })
    expect(isUsable(loadTrajectories(trajDir, rewDir)[0])).toBe(false)
  })

  it('accepts a v2 reward with a snapshot', () => {
    seed({ taskId: 'good', reward: 0.82, labelerVersion: 2, snapshot: true })
    expect(isUsable(loadTrajectories(trajDir, rewDir)[0])).toBe(true)
  })
})

describe('toChatML', () => {
  it('renders tool calls and results as tagged text', () => {
    const out = toChatML([
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'contents' }] },
    ])
    expect(out).toHaveLength(3)
    expect(out[1].content).toContain('<tool name="Read">')
    expect(out[1].content).toContain('a.ts')
    expect(out[2].content).toBe('<tool_result>contents</tool_result>')
  })

  it('drops messages that render to nothing', () => {
    expect(toChatML([
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'zzz' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('marks an errored tool result', () => {
    const out = toChatML([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }] },
    ])
    expect(out[0].content).toContain('error="true"')
  })
})

describe('buildDatasets — SFT', () => {
  it('emits the real conversation, never a synthesized tool sequence', () => {
    seed({ taskId: 'good', reward: 0.82, labelerVersion: 2, snapshot: true, userText: 'Fix the realm test' })
    const { sft } = buildDatasets(loadTrajectories(trajDir, rewDir))
    expect(sft).toHaveLength(1)
    const parsed = JSON.parse(sft[0])
    expect(parsed.messages[0]).toEqual({ role: 'user', content: 'Fix the realm test' })
    expect(sft[0]).not.toContain('Tool sequence')
  })

  it('excludes legacy and snapshot-less rows from SFT', () => {
    seed({ taskId: 'legacy', reward: 1.0, snapshot: true })
    seed({ taskId: 'nosnap', reward: 0.9, labelerVersion: 2 })
    seed({ taskId: 'good', reward: 0.82, labelerVersion: 2, snapshot: true })
    const { sft } = buildDatasets(loadTrajectories(trajDir, rewDir))
    expect(sft).toHaveLength(1)
  })
})

describe('buildDatasets — DPO keeps the negatives', () => {
  it('pairs a high-reward run against a low-reward run of the same model', () => {
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true, userText: 'good run' })
    seed({ taskId: 'lose', reward: 0.12, labelerVersion: 2, snapshot: true, userText: 'bad run' })
    const { dpo } = buildDatasets(loadTrajectories(trajDir, rewDir))
    expect(dpo).toHaveLength(1)
    const pair = JSON.parse(dpo[0])
    expect(pair.chosen[0].content).toBe('good run')
    expect(pair.rejected[0].content).toBe('bad run')
  })

  it('does not pair across models', () => {
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true, model: 'a' })
    seed({ taskId: 'lose', reward: 0.12, labelerVersion: 2, snapshot: true, model: 'b' })
    expect(buildDatasets(loadTrajectories(trajDir, rewDir)).dpo).toHaveLength(0)
  })
})

describe('summarizeCorpus', () => {
  it('counts usable, negative and legacy separately', () => {
    seed({ taskId: 'legacy1', reward: 1.0, snapshot: true })
    seed({ taskId: 'legacy2', reward: 1.0, snapshot: true })
    seed({ taskId: 'win', reward: 0.85, labelerVersion: 2, snapshot: true })
    seed({ taskId: 'lose', reward: 0.12, labelerVersion: 2, snapshot: true })
    const stats = summarizeCorpus(loadTrajectories(trajDir, rewDir, { loadSnapshots: false }))
    expect(stats.totalTasks).toBe(4)
    expect(stats.usableExamples).toBe(2)
    expect(stats.negativeExamples).toBe(1)
    expect(stats.legacyExcluded).toBe(2)
    expect(stats.avgReward).toBeCloseTo(0.485, 3)
  })

  it('averages only usable rows, so the 147 saturated legacy rows cannot hide a regression', () => {
    seed({ taskId: 'legacy', reward: 1.0, snapshot: true })
    seed({ taskId: 'lose', reward: 0.1, labelerVersion: 2, snapshot: true })
    expect(summarizeCorpus(loadTrajectories(trajDir, rewDir)).avgReward).toBeCloseTo(0.1, 6)
  })
})

describe('exportDatasets', () => {
  it('always rewrites sft.jsonl so a stale corpus cannot linger', () => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'sft.jsonl'), '{"messages":[]}\n')
    seed({ taskId: 'legacy', reward: 1.0, snapshot: true })
    const stats = exportDatasets(outDir, trajDir, rewDir)
    expect(stats.sftExamples).toBe(0)
    expect(readFileSync(join(outDir, 'sft.jsonl'), 'utf-8')).toBe('')
  })

  it('writes stats.json with the new fields', () => {
    seed({ taskId: 'good', reward: 0.82, labelerVersion: 2, snapshot: true })
    exportDatasets(outDir, trajDir, rewDir)
    const stats = JSON.parse(readFileSync(join(outDir, 'stats.json'), 'utf-8'))
    expect(stats.usableExamples).toBe(1)
    expect(stats.negativeExamples).toBe(0)
    expect(stats.legacyExcluded).toBe(0)
    expect(existsSync(join(outDir, 'sft.jsonl'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/training/datasetBuilder.test.ts`
Expected: FAIL — `buildDatasets is not a function`, `summarizeCorpus is not a function`,
`toChatML is not a function`, `isUsable is not a function`

- [ ] **Step 3: Write the implementation**

Replace the header comment and imports at `engine/training/datasetBuilder.ts:1-16` with:

```ts
/**
 * DatasetBuilder — converts trajectory + reward data into training datasets.
 *
 * Reads trajectory JSONL turn logs, their reward files and their message
 * snapshots, filters by eligibility and reward, and outputs ChatML records for
 * Unsloth SFT and (chosen, rejected) pairs for DPO.
 *
 * Eligibility (see isUsable): a v2+ reward label AND a captured conversation.
 * Everything recorded before 2026-07-25 fails both and is excluded here rather
 * than deleted from ~/.cynco.
 *
 * Output formats:
 *   SFT:  { messages: [{ role, content }] }  — one per trajectory
 *   DPO:  { chosen: [{ role, content }], rejected: [{ role, content }] }
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { TaskReward } from './rewardLabeler.js'
import type { Message, ContentBlock } from '../types.js'
```

Replace the `TrajectoryWithReward` type and `DatasetStats` (`:36-49`) with:

```ts
export type TrajectorySnapshot = {
  schemaVersion: number
  taskId: string
  model?: string
  adapterId?: string | null
  startedAt?: string
  endedAt?: string
  truncatedMessages?: number
  messages: Message[]
}

export type TrajectoryWithReward = {
  taskId: string
  turns: TurnRecord[]
  reward: TaskReward | null
  /** A snapshot file exists on disk. Cheap — existsSync only. */
  hasSnapshot: boolean
  /** Parsed snapshot; null when loadSnapshots was false or parsing failed. */
  snapshot: TrajectorySnapshot | null
}

/** Corpus shape — computable without reading any message content. */
export type CorpusStats = {
  totalTasks: number
  tasksWithRewards: number
  usableExamples: number
  negativeExamples: number
  legacyExcluded: number
  avgReward: number
  rewardDistribution: { bucket: string; count: number }[]
}

export type DatasetStats = CorpusStats & {
  sftExamples: number
  dpoPairs: number
}

/** Labels written before the grounded labeler landed are not training data. */
export const MIN_LABELER_VERSION = 2
export const SFT_MIN_REWARD = 0.7
export const DPO_MAX_REWARD = 0.3
```

Replace `loadTrajectories` (`:53-97`) with:

```ts
/**
 * Load all trajectories with their rewards, and optionally their message
 * snapshots, from disk.
 *
 * Snapshots run to 2 MB. Callers that only need counts (the dashboard, which
 * polls) pass loadSnapshots: false and rely on hasSnapshot.
 */
export function loadTrajectories(
  trajectoryDir?: string,
  rewardDir?: string,
  opts: { loadSnapshots?: boolean } = {},
): TrajectoryWithReward[] {
  const loadSnapshots = opts.loadSnapshots !== false
  const trajDir = trajectoryDir ?? join(homedir(), '.cynco', 'trajectories')
  const rewDir = rewardDir ?? join(homedir(), '.cynco', 'rewards')

  if (!existsSync(trajDir)) return []

  const files = readdirSync(trajDir).filter(f => f.endsWith('.jsonl'))
  const results: TrajectoryWithReward[] = []

  for (const file of files) {
    const taskId = file.replace('.jsonl', '')
    const lines = readFileSync(join(trajDir, file), 'utf-8')
      .trim()
      .split('\n')
      .filter(l => l.trim())

    const turns: TurnRecord[] = []
    for (const line of lines) {
      try {
        turns.push(JSON.parse(line))
      } catch {}
    }

    if (turns.length === 0) continue

    let reward: TaskReward | null = null
    const rewardPath = join(rewDir, `${taskId}.reward.json`)
    if (existsSync(rewardPath)) {
      try {
        reward = JSON.parse(readFileSync(rewardPath, 'utf-8'))
      } catch {}
    }

    const snapPath = join(trajDir, `${taskId}.messages.json`)
    const hasSnapshot = existsSync(snapPath)
    let snapshot: TrajectorySnapshot | null = null
    if (hasSnapshot && loadSnapshots) {
      try {
        const parsed = JSON.parse(readFileSync(snapPath, 'utf-8'))
        if (parsed && Array.isArray(parsed.messages)) snapshot = parsed
      } catch {}
    }

    results.push({ taskId, turns, reward, hasSnapshot, snapshot })
  }

  return results
}

/**
 * Eligible as training data: labeled by the grounded labeler, not degenerate,
 * and with the real conversation on disk. A reward label without a
 * conversation is untrainable — there is no text to learn.
 */
export function isUsable(t: TrajectoryWithReward): boolean {
  if (!t.reward) return false
  if ((t.reward.labelerVersion ?? 1) < MIN_LABELER_VERSION) return false
  if (t.reward.degenerate) return false
  return t.hasSnapshot
}

/** Labeled by the pre-grounding labeler — reported, never exported. */
export function isLegacy(t: TrajectoryWithReward): boolean {
  return t.reward !== null && (t.reward.labelerVersion ?? 1) < MIN_LABELER_VERSION
}
```

Replace `buildSFTDataset` and `buildDPODataset` (`:99-194`) with the ChatML flattener and the two
builders:

```ts
function blockToText(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
    case 'thinking':
    case 'connector_text':
      return b.text
    case 'tool_use':
      return `<tool name="${b.name}">${JSON.stringify(b.input)}</tool>`
    case 'tool_result': {
      const body = typeof b.content === 'string' ? b.content : b.content.map(blockToText).join('')
      return `<tool_result${b.is_error ? ' error="true"' : ''}>${body}</tool_result>`
    }
    default:
      return ''
  }
}

/**
 * Flatten engine messages (content blocks) into the { role, content: string }
 * pairs a chat template expects. Tool calls and results survive as tagged
 * text so the tool-use structure is still learnable.
 */
export function toChatML(messages: Message[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = []
  for (const m of messages) {
    const text = m.content.map(blockToText).filter(Boolean).join('\n')
    if (!text.trim()) continue
    out.push({ role: m.role, content: text })
  }
  return out
}

/**
 * Build SFT examples from the captured conversations of high-reward,
 * eligible trajectories.
 */
export function buildSFTDataset(
  trajectories: TrajectoryWithReward[],
  rewardThreshold = SFT_MIN_REWARD,
): string[] {
  const examples: string[] = []

  for (const traj of trajectories) {
    if (!isUsable(traj) || !traj.snapshot) continue
    if (traj.reward!.reward < rewardThreshold) continue

    const messages = toChatML(traj.snapshot.messages)
    if (messages.length < 2) continue

    examples.push(JSON.stringify({ messages }))
  }

  return examples
}

/**
 * Build DPO pairs from real conversations. Low-reward trajectories are never
 * dropped: a failed run is the most valuable row in the corpus because a pair
 * needs one of each, and there were zero of these before 2026-07-25.
 */
export function buildDPODataset(
  trajectories: TrajectoryWithReward[],
  chosenMinReward = SFT_MIN_REWARD,
  rejectedMaxReward = DPO_MAX_REWARD,
): string[] {
  const pairs: string[] = []

  // Group by model — a pair is only meaningful within one policy.
  const byModel = new Map<string, TrajectoryWithReward[]>()
  for (const t of trajectories) {
    if (!isUsable(t) || !t.snapshot) continue
    const model = t.snapshot.model ?? t.turns[0]?.model ?? 'unknown'
    if (!byModel.has(model)) byModel.set(model, [])
    byModel.get(model)!.push(t)
  }

  for (const [, group] of byModel) {
    const chosen = group.filter(t => t.reward!.reward >= chosenMinReward)
    const rejected = group.filter(t => t.reward!.reward <= rejectedMaxReward)

    for (const c of chosen) {
      for (const r of rejected) {
        pairs.push(JSON.stringify({
          chosen: toChatML(c.snapshot!.messages),
          rejected: toChatML(r.snapshot!.messages),
        }))
      }
    }
  }

  return pairs
}
```

Replace `exportDatasets` (`:196-246`) with the split summarize/build/export trio:

```ts
/**
 * Corpus statistics. Reads no message content, so it is safe to call on a
 * dashboard poll with loadSnapshots: false.
 *
 * avgReward covers usable rows only. Averaging over the legacy rows would
 * fold in 147 saturated 1.0s and mask exactly the regression the gate checks.
 */
export function summarizeCorpus(trajectories: TrajectoryWithReward[]): CorpusStats {
  const withRewards = trajectories.filter(t => t.reward !== null)
  const usable = trajectories.filter(isUsable)
  const rewards = usable.map(t => t.reward!.reward)
  const avgReward = rewards.length > 0 ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0

  return {
    totalTasks: trajectories.length,
    tasksWithRewards: withRewards.length,
    usableExamples: usable.length,
    negativeExamples: rewards.filter(r => r < DPO_MAX_REWARD).length,
    legacyExcluded: trajectories.filter(isLegacy).length,
    avgReward,
    rewardDistribution: [
      { bucket: 'excellent (>= 0.8)', count: rewards.filter(r => r >= 0.8).length },
      { bucket: 'good (0.5-0.8)', count: rewards.filter(r => r >= 0.5 && r < 0.8).length },
      { bucket: 'poor (0.0-0.5)', count: rewards.filter(r => r >= 0 && r < 0.5).length },
      { bucket: 'negative (< 0)', count: rewards.filter(r => r < 0).length },
    ],
  }
}

/** Build both datasets in memory. Requires snapshots to have been loaded. */
export function buildDatasets(
  trajectories: TrajectoryWithReward[],
): { sft: string[]; dpo: string[]; stats: DatasetStats } {
  const sft = buildSFTDataset(trajectories)
  const dpo = buildDPODataset(trajectories)
  return {
    sft,
    dpo,
    stats: { ...summarizeCorpus(trajectories), sftExamples: sft.length, dpoPairs: dpo.length },
  }
}

/**
 * Export datasets to disk for Unsloth consumption.
 *
 * Both files are rewritten unconditionally, including when empty — otherwise
 * a stale sft.jsonl from a previous labeler survives and every consumer that
 * counts its lines reports a corpus that no longer exists.
 */
export function exportDatasets(
  outputDir?: string,
  trajectoryDir?: string,
  rewardDir?: string,
): DatasetStats {
  const outDir = outputDir ?? join(homedir(), '.cynco', 'datasets')
  mkdirSync(outDir, { recursive: true })

  const trajectories = loadTrajectories(trajectoryDir, rewardDir)
  const { sft, dpo, stats } = buildDatasets(trajectories)

  writeFileSync(join(outDir, 'sft.jsonl'), sft.length > 0 ? sft.join('\n') + '\n' : '')
  writeFileSync(join(outDir, 'dpo.jsonl'), dpo.length > 0 ? dpo.join('\n') + '\n' : '')
  writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2) + '\n')

  console.log(
    `[dataset] ${stats.sftExamples} SFT, ${stats.dpoPairs} DPO pairs, ` +
    `${stats.usableExamples} usable / ${stats.negativeExamples} negative, ` +
    `${stats.legacyExcluded} legacy excluded, avg reward ${stats.avgReward.toFixed(3)}`,
  )

  return stats
}
```

Finally, **delete `backfillRewards` entirely** — everything from the
`/** Backfill rewards for trajectories that don't have them. ... */` comment to the end of the
file. The dead `ranTests` local goes with it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/training/datasetBuilder.test.ts`
Expected: PASS — 16 tests

- [ ] **Step 5: Confirm the deletion has no orphans**

Run: `bunx vitest run 2>&1 | grep -E "backfillRewards|Test Files|  Tests "`
Expected: no `backfillRewards` line. `runTraining.ts` still imports it at `:16` — that file is a
CLI entry, not imported by any test, so vitest stays green while `bun engine/training/runTraining.ts`
would now throw. Task 9 fixes it; do not stop here.

- [ ] **Step 6: Commit**

```bash
git add engine/training/datasetBuilder.ts engine/__tests__/training/datasetBuilder.test.ts
git commit -m "feat(training): real conversations in, synthetic labels out

buildSFTDataset emitted 'Tool sequence: Read(ok, 12ms) -> ...' — a string the
model can never produce. It now emits the captured conversation. Eligibility
requires labelerVersion >= 2 AND a snapshot, which structurally excludes the
147 legacy rows without deleting anything from ~/.cynco. Low-reward runs are
kept: DPO needs pairs and there were zero. backfillRewards, which manufactured
every bad label, is deleted."
```

---

## Task 9: A readiness gate that can say no

**Files:**
- Modify: `engine/training/datasetBuilder.ts` (append `evaluateReadiness`)
- Modify: `engine/training/runTraining.ts` (delete `stageBackfill`, gate `stageTrain`, rewrite `stageStats`)
- Modify: `engine/dashboard/server.ts:202-238`
- Modify: `engine/dashboard/index.html:559-575` and `:1500-1516`
- Modify: `engine/__tests__/training/datasetBuilder.test.ts` (append a describe block)

Today the only abort is `runTraining.ts:72` — `if (lines < 10)`. 147 rows sails through it, and the
dashboard's "progress to training" bar fills toward a hardcoded 300 counting lines in `sft.jsonl`.
Volume is not readiness. Three conditions replace it, and each is reported separately so a
failure names itself.

- [ ] **Step 1: Write the failing test**

Add `evaluateReadiness` to the import list at the top of
`engine/__tests__/training/datasetBuilder.test.ts`, then append:

```ts
describe('evaluateReadiness', () => {
  const base = {
    totalTasks: 0, tasksWithRewards: 0, legacyExcluded: 0, rewardDistribution: [],
  }

  it('passes when all three conditions hold', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 150, negativeExamples: 20, avgReward: 0.62 })
    expect(r.ready).toBe(true)
    expect(r.conditions.every(c => c.ok)).toBe(true)
  })

  it('fails on volume alone', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 149, negativeExamples: 20, avgReward: 0.62 })
    expect(r.ready).toBe(false)
    expect(r.conditions.find(c => c.name === 'usable examples')!.ok).toBe(false)
  })

  it('fails without negatives, because DPO needs pairs', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 400, negativeExamples: 19, avgReward: 0.62 })
    expect(r.ready).toBe(false)
    expect(r.conditions.find(c => c.name === 'negative examples')!.ok).toBe(false)
  })

  it('fails on a saturated mean — the 147-rows-all-1.0 regression', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 400, negativeExamples: 40, avgReward: 0.95 })
    expect(r.ready).toBe(false)
    expect(r.conditions.find(c => c.name === 'avg reward')!.ok).toBe(false)
  })

  it('reports every condition, passing or not', () => {
    const r = evaluateReadiness({ ...base, usableExamples: 0, negativeExamples: 0, avgReward: 0 })
    expect(r.conditions).toHaveLength(3)
    expect(r.conditions.map(c => c.name)).toEqual(['usable examples', 'negative examples', 'avg reward'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run engine/__tests__/training/datasetBuilder.test.ts`
Expected: FAIL — `evaluateReadiness is not a function`

- [ ] **Step 3: Add the gate to `datasetBuilder.ts`**

Append at the end of `engine/training/datasetBuilder.ts`:

```ts
export const GATE_MIN_USABLE = 150
export const GATE_MIN_NEGATIVE = 20
export const GATE_MAX_AVG_REWARD = 0.9

export type ReadinessCondition = { name: string; ok: boolean; actual: number; required: string }
export type Readiness = { ready: boolean; conditions: ReadinessCondition[] }

/**
 * Training readiness. All three must hold:
 *
 *  - usable examples — volume, but of examples that carry information
 *  - negative examples — without them DPO has nothing to pair and SFT only
 *    ever sees success, which is how a model learns that its failure modes
 *    are excellent work
 *  - avg reward below 0.9 — a saturated mean means the labeler regressed;
 *    the pre-2026-07-25 corpus scored 1.0 on all 147 rows
 */
export function evaluateReadiness(stats: CorpusStats): Readiness {
  const conditions: ReadinessCondition[] = [
    {
      name: 'usable examples',
      ok: stats.usableExamples >= GATE_MIN_USABLE,
      actual: stats.usableExamples,
      required: `>= ${GATE_MIN_USABLE}`,
    },
    {
      name: 'negative examples',
      ok: stats.negativeExamples >= GATE_MIN_NEGATIVE,
      actual: stats.negativeExamples,
      required: `>= ${GATE_MIN_NEGATIVE}`,
    },
    {
      name: 'avg reward',
      ok: stats.avgReward < GATE_MAX_AVG_REWARD,
      actual: stats.avgReward,
      required: `< ${GATE_MAX_AVG_REWARD}`,
    },
  ]
  return { ready: conditions.every(c => c.ok), conditions }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run engine/__tests__/training/datasetBuilder.test.ts`
Expected: PASS — 21 tests

- [ ] **Step 5: Rewrite `runTraining.ts`**

**5a.** Replace the header comment and import (`:1-16`):

```ts
/**
 * Training Pipeline Orchestrator — build dataset → gate → train → convert →
 * promote.
 *
 * There is no backfill stage. Rewards are written by the live engine at task
 * end (see conversationLoop.finalizeTrajectory); the offline heuristic that
 * used to manufacture them was deleted on 2026-07-25.
 *
 * Usage:
 *   bun run engine/training/runTraining.ts --stage stats
 *   bun run engine/training/runTraining.ts --stage dataset
 *   bun run engine/training/runTraining.ts --stage sft
 *   bun run engine/training/runTraining.ts --stage full
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  evaluateReadiness,
  exportDatasets,
  loadTrajectories,
  summarizeCorpus,
  type DatasetStats,
} from './datasetBuilder.js'
```

**5b.** Delete `stageBackfill` entirely (`:28-35`, including the `// ─── Stage: Backfill Rewards ───`
banner).

**5c.** Replace `stageDataset` (`:39-53`) so it reports the new fields:

```ts
function stageDataset(): DatasetStats {
  log('Stage: Build training datasets')
  const stats = exportDatasets(DATASET_DIR, TRAJECTORY_DIR, REWARD_DIR)

  log(`Total tasks: ${stats.totalTasks}`)
  log(`Tasks with rewards: ${stats.tasksWithRewards}`)
  log(`Usable examples: ${stats.usableExamples}`)
  log(`Negative examples: ${stats.negativeExamples}`)
  log(`Legacy excluded (labeler v1): ${stats.legacyExcluded}`)
  log(`SFT examples: ${stats.sftExamples}`)
  log(`DPO pairs: ${stats.dpoPairs}`)
  log(`Average reward: ${stats.avgReward.toFixed(3)}`)
  for (const b of stats.rewardDistribution) {
    log(`  ${b.bucket}: ${b.count}`)
  }

  return stats
}
```

**5d.** Replace the data check in `stageTrain` (`:62-79`) with the three-condition gate:

```ts
  const statsPath = join(DATASET_DIR, 'stats.json')
  const dataPath = join(DATASET_DIR, 'sft.jsonl')
  if (!existsSync(dataPath) || !existsSync(statsPath)) {
    log(`ERROR: No dataset at ${DATASET_DIR}. Run --stage dataset first.`)
    process.exit(1)
  }

  const stats: DatasetStats = JSON.parse(readFileSync(statsPath, 'utf-8'))
  const readiness = evaluateReadiness(stats)

  log('Readiness:')
  for (const c of readiness.conditions) {
    log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.actual} (need ${c.required})`)
  }

  if (!readiness.ready) {
    log('Corpus is not ready. Volume is not readiness — a corpus with no failures')
    log('teaches the model that its failure modes are excellent work.')
    if (!dryRun) {
      log('Aborting training.')
      return
    }
    log('Continuing anyway because --dry-run was passed (no weights are updated).')
  }

  log(`SFT dataset: ${stats.sftExamples} examples`)
```

**5e.** Replace `stageStats` (`:133-165`) with the read-only summary:

```ts
function stageStats(): void {
  const trajectories = loadTrajectories(TRAJECTORY_DIR, REWARD_DIR, { loadSnapshots: false })
  const stats = summarizeCorpus(trajectories)
  const totalTurns = trajectories.reduce((sum, t) => sum + t.turns.length, 0)
  const readiness = evaluateReadiness(stats)

  log('=== Training Data Status ===')
  log(`Trajectory files: ${stats.totalTasks}`)
  log(`Total turns: ${totalTurns}`)
  log(`Tasks with rewards: ${stats.tasksWithRewards}`)
  log(`Usable examples: ${stats.usableExamples}`)
  log(`Negative examples: ${stats.negativeExamples}`)
  log(`Legacy excluded (labeler v1): ${stats.legacyExcluded}`)
  log(`Average reward (usable only): ${stats.avgReward.toFixed(3)}`)

  log('Readiness:')
  for (const c of readiness.conditions) {
    log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.actual} (need ${c.required})`)
  }
  log(`Ready for SFT: ${readiness.ready ? 'YES' : 'NO'}`)

  const sftPath = join(DATASET_DIR, 'sft.jsonl')
  const dpoPath = join(DATASET_DIR, 'dpo.jsonl')
  if (existsSync(sftPath)) {
    const body = readFileSync(sftPath, 'utf-8').trim()
    log(`SFT dataset on disk: ${body ? body.split('\n').length : 0} examples`)
  }
  if (existsSync(dpoPath)) {
    const body = readFileSync(dpoPath, 'utf-8').trim()
    log(`DPO dataset on disk: ${body ? body.split('\n').length : 0} pairs`)
  }
}
```

**5f.** Replace the switch (`:177-205`) so no stage calls backfill:

```ts
switch (stage) {
  case 'stats':
    stageStats()
    break
  case 'dataset':
    stageDataset()
    break
  case 'sft':
    stageTrain(base, version, dryRun)
    break
  case 'promote':
    stagePromote(version, base)
    break
  case 'full':
    stageDataset()
    stageTrain(base, version, dryRun)
    stagePromote(version, base)
    break
  default:
    log(`Unknown stage: ${stage}`)
    log('Available stages: stats, dataset, sft, promote, full')
    process.exit(1)
}
```

- [ ] **Step 6: Verify the CLI runs and refuses**

Run: `bun engine/training/runTraining.ts --stage stats`
Expected: it prints the three conditions, all FAIL (the live corpus has 302 legacy trajectories and
zero v2 labels), and `Ready for SFT: NO`. It must not throw — a throw means a `backfillRewards`
import survived. **Do not run `--stage dataset`, `--stage sft` or `--stage full`.**

- [ ] **Step 7: Update the dashboard API**

Replace `engine/dashboard/server.ts:202-238`:

```ts
            case '/api/training': {
              try {
                const {
                  loadTrajectories, summarizeCorpus, evaluateReadiness, GATE_MIN_USABLE,
                } = require('../training/datasetBuilder.js')
                const { homedir } = require('os')
                const { join } = require('path')
                const trajDir = join(homedir(), '.cynco', 'trajectories')
                const rewDir = join(homedir(), '.cynco', 'rewards')

                // loadSnapshots: false — this endpoint is polled and a snapshot
                // runs to 2 MB. Eligibility only needs the file to exist.
                const trajectories = loadTrajectories(trajDir, rewDir, { loadSnapshots: false })
                const stats = summarizeCorpus(trajectories)
                const readiness = evaluateReadiness(stats)
                const totalTurns = trajectories.reduce(
                  (sum: number, t: { turns: unknown[] }) => sum + t.turns.length, 0,
                )

                return jsonResponse({
                  tasks: stats.totalTasks,
                  turns: totalTurns,
                  rewards: stats.tasksWithRewards,
                  usableExamples: stats.usableExamples,
                  negativeExamples: stats.negativeExamples,
                  legacyExcluded: stats.legacyExcluded,
                  avgReward: stats.avgReward,
                  targetExamples: GATE_MIN_USABLE,
                  readyForSFT: readiness.ready,
                  conditions: readiness.conditions,
                  progress: Math.min(1, stats.usableExamples / GATE_MIN_USABLE),
                })
              } catch {
                return jsonResponse({
                  tasks: 0, turns: 0, rewards: 0, usableExamples: 0, negativeExamples: 0,
                  legacyExcluded: 0, avgReward: 0, targetExamples: 150, readyForSFT: false,
                  conditions: [], progress: 0,
                })
              }
            }
```

- [ ] **Step 8: Update the dashboard panel**

Replace `engine/dashboard/index.html:559-575`:

```html
    <!-- Training Data Pipeline -->
    <div class="sub-panel" id="panelTraining">
      <div class="sub-panel-title">Training Data</div>
      <div class="sub-row"><span class="sub-label">Recording</span><span class="sub-value gray" id="trajStatus">inactive</span></div>
      <div class="sub-row"><span class="sub-label">Tasks</span><span class="sub-value" id="trainTasks">0</span></div>
      <div class="sub-row"><span class="sub-label">Turns</span><span class="sub-value" id="trainTurns">0</span></div>
      <div class="sub-row"><span class="sub-label">Usable Examples</span><span class="sub-value" id="trainUsable">0</span></div>
      <div class="sub-row"><span class="sub-label">Negatives</span><span class="sub-value" id="trainNegative">0</span></div>
      <div class="sub-row"><span class="sub-label">Avg Reward</span><span class="sub-value" id="trainAvgReward">—</span></div>
      <div class="sub-row"><span class="sub-label">Legacy Excluded</span><span class="sub-value gray" id="trainLegacy">0</span></div>
      <div style="margin-top:6px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#808080;margin-bottom:2px">
          <span>Usable examples toward gate</span>
          <span id="trainTarget">0 / 150</span>
        </div>
        <div style="background:#1e1e1e;border-radius:3px;height:8px;overflow:hidden">
          <div id="trainProgressBar" style="background:#4caf50;height:100%;width:0%;transition:width 0.3s;border-radius:3px"></div>
        </div>
        <div id="trainConditions" style="font-size:11px;color:#808080;margin-top:4px"></div>
      </div>
    </div>
```

Replace the render block at `engine/dashboard/index.html:1500-1516`:

```js
  // Training data stats from /api/training
  if (state.trainingData) {
    var td = state.trainingData;
    var tasksEl = document.getElementById('trainTasks');
    var turnsEl = document.getElementById('trainTurns');
    var usableEl = document.getElementById('trainUsable');
    var negEl = document.getElementById('trainNegative');
    var avgEl = document.getElementById('trainAvgReward');
    var legacyEl = document.getElementById('trainLegacy');
    var targetEl = document.getElementById('trainTarget');
    var barEl = document.getElementById('trainProgressBar');
    var condEl = document.getElementById('trainConditions');
    if (tasksEl) tasksEl.textContent = String(td.tasks || 0);
    if (turnsEl) turnsEl.textContent = String(td.turns || 0);
    if (usableEl) {
      usableEl.textContent = String(td.usableExamples || 0);
      usableEl.className = 'sub-value ' + (td.readyForSFT ? 'green' : 'yellow');
    }
    if (negEl) negEl.textContent = String(td.negativeExamples || 0);
    if (avgEl) avgEl.textContent = (td.usableExamples ? Number(td.avgReward || 0).toFixed(3) : '—');
    if (legacyEl) legacyEl.textContent = String(td.legacyExcluded || 0);
    if (targetEl) targetEl.textContent = (td.usableExamples || 0) + ' / ' + (td.targetExamples || 150);
    if (barEl) barEl.style.width = Math.min(100, (td.progress || 0) * 100).toFixed(1) + '%';
    if (condEl) {
      condEl.innerHTML = (td.conditions || []).map(function(c) {
        return '<div>' + (c.ok ? '✔' : '✘') + ' ' + c.name + ': ' + c.actual + ' (need ' + c.required + ')</div>';
      }).join('');
    }
  }
```

- [ ] **Step 9: Run the full suite**

Run: `bunx vitest run`
Expected: `8 failed`, passed count up by 5

- [ ] **Step 10: Commit**

```bash
git add engine/training/datasetBuilder.ts engine/training/runTraining.ts engine/dashboard/server.ts engine/dashboard/index.html engine/__tests__/training/datasetBuilder.test.ts
git commit -m "feat(training): a readiness gate that can say no

The only abort was 'fewer than 10 lines', and the dashboard bar filled toward
a hardcoded 300 by counting lines in sft.jsonl. Readiness is now three
conditions — usable volume, at least 20 negatives, and a mean below 0.9 —
each reported separately so a failure names itself. The backfill stage is
gone with the function behind it."
```

---

## Task 10: Wire check and live verification

**Files:** none modified — this task is evidence.

Every previous task could pass its unit tests while remaining unreachable from a real session. That
is exactly how the pipeline got here: `finalizeTask` had tests and no callers for months.

- [ ] **Step 1: Prove every new symbol has a live caller**

For each symbol run `grep -rn --include=*.ts <symbol> engine/ | grep -v __tests__` and check the
result against this table:

| Symbol | Expected live callers |
|---|---|
| `parseTestSummary` | `bridge/benignToolResult.ts`, `bestOfN/sampler.ts`, `bridge/conversationLoop.ts` |
| `classifyCheckCommand` | `bridge/conversationLoop.ts` |
| `sanitizeMessages` | `training/trajectoryRecorder.ts` |
| `endTask` | `bridge/conversationLoop.ts` (in `finalizeTrajectory`) |
| `runWithFinalize` | `bridge/conversationLoop.ts` (in `handleUserMessage`) |
| `collectGitFacts` | `bridge/conversationLoop.ts` |
| `buildComponents` | `bridge/conversationLoop.ts` |
| `finalizeTask` | `bridge/conversationLoop.ts` — **the headline fix; it had zero before** |
| `evaluateReadiness` | `training/runTraining.ts`, `dashboard/server.ts` |
| `summarizeCorpus` | `training/datasetBuilder.ts`, `training/runTraining.ts`, `dashboard/server.ts` |

- [ ] **Step 2: Prove the dead paths are gone**

```bash
grep -rn --include=*.ts --include=*.html "backfillRewards\|ranTests\|stageBackfill" engine/
```
Expected: **no output at all.** Not even in tests.

```bash
grep -rn --include=*.ts "Tool sequence" engine/
```
Expected: no output — the synthesized SFT target is gone.

```bash
grep -n "testsTotal: 0\|toolSuccessRate: 1.0" engine/bridge/conversationLoop.ts
```
Expected: no output — the hardcoded telemetry literals are gone.

- [ ] **Step 3: Run the full suite one more time**

Run: `bunx vitest run 2>&1 | grep -E "❯|FAIL|Test Files|  Tests "`

Expected: `8 failed` — the same 8 as the baseline recorded at the top of this plan. If a ninth
appears, fix it; if one of the 8 disappears, check you did not "helpfully" repair a pre-existing
failure that is out of scope.

- [ ] **Step 4: Live-verify in a scratch repo**

The engine runs with `LOCALCODE_APPROVE_ALL=true`. Launched from `localcode` it will happily edit
its own source, so the `cwd` **must** be the scratch repo.

```bash
mkdir -p /c/tmp/reward_scratch && cd /c/tmp/reward_scratch
git init -q && git config user.email t@t && git config user.name t
cat > adder.py <<'EOF'
def add(a, b):
    return a - b
EOF
cat > test_adder.py <<'EOF'
from adder import add

def test_add():
    assert add(2, 3) == 5

def test_add_zero():
    assert add(4, 0) == 4
EOF
git add -A && git commit -qm "seed"
```

Write `/c/tmp/reward_scratch/task.json`:

```json
{
  "missionId": "reward-verify",
  "cwd": "C:/tmp/reward_scratch",
  "prompt": "Run `python -m pytest -q`. One test fails. Fix adder.py so both pass, then run pytest again to confirm.",
  "allowedTools": ["Read", "Edit", "Write", "Bash"],
  "timeoutMs": 600000,
  "outcomePath": "C:/tmp/reward_scratch/outcome.json"
}
```

Run from a spare port so the live daemon's dashboard is untouched:

```bash
cd /c/Users/civer/localcode && LOCALCODE_WS_PORT=9177 LOCALCODE_APPROVE_ALL=true \
  LOCALCODE_S5_ENFORCE=false bun engine/main.ts --run-task /c/tmp/reward_scratch/task.json
```

- [ ] **Step 5: Confirm on disk — five checks**

```bash
ls -t ~/.cynco/trajectories/*.messages.json | head -1
ls -t ~/.cynco/rewards/*.reward.json | head -1 | xargs cat | python -m json.tool
```

1. A `messages.json` exists and its `messages` array contains the **real prompt text**, not a hash.
2. The matching `~/.cynco/rewards/<taskId>.reward.json` has `"labelerVersion": 2`.
3. At least one component is `"unknown"` — proof the labeler stopped inventing values.
4. `reward` is **not** exactly `1.0`.
5. `components.testsPass` reflects the observed pytest run (`1` after the fix; a fraction if the
   agent's last run was still red) — not the tool success rate.

If check 3 shows every component measured, that is fine — it means the scratch task exercised all
of them. If check 4 shows exactly `1.0` while the transcript contains a real test failure, the
labeler is still saturating: stop and re-open Task 6.

- [ ] **Step 6: Confirm the gate still refuses**

Run: `bun engine/training/runTraining.ts --stage stats`
Expected: `Usable examples: 1` (the scratch run), `Negative examples: 0`, `Ready for SFT: NO`.
One real example is the entire point — the corpus now has a first row that means something.

- [ ] **Step 7: Report, commit nothing**

This task produces no code. Report the five check results, the failing-test count, and the
readiness output.

---

## Done means

- `bunx vitest run` shows the same 8 pre-existing failures and no new ones.
- `backfillRewards`, `ranTests` and `Tool sequence` have zero references in `engine/`.
- A real session writes a `messages.json` with real text and a `reward.json` with
  `labelerVersion: 2`, at least one `unknown`, and a reward that is not `1.0`.
- `--stage stats` refuses, naming which of the three conditions failed.
- **No training stage has been run.** The eval harness comes first — see the spec's
  "Sequencing — eval harness before training".

---
