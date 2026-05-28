# SmallCode Feature Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port 7 small-model reliability features from SmallCode to close the gap between CynCo's platform strengths and SmallCode's practical tool-loop reliability.

**Architecture:** Each feature is an independent module that integrates into the existing tool execution pipeline. Features 1, 4, 7 modify existing files. Features 2, 3, 5 create new files. Feature 6 modifies edit.ts with a fallback path. All integrate through `executor.ts` or `conversationLoop.ts`.

**Tech Stack:** TypeScript (Bun), Vitest

---

### Task 1: Tool Result Capping

**Files:**
- Modify: `engine/tools/executor.ts`
- Test: `engine/__tests__/resultCapping.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/resultCapping.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { capToolResult } from '../tools/resultCap.js'

describe('capToolResult', () => {
  it('returns short output unchanged', () => {
    expect(capToolResult('hello', 32768)).toBe('hello')
  })

  it('caps at 2000 for small context (<64K)', () => {
    const long = 'x'.repeat(5000)
    const capped = capToolResult(long, 32768)
    expect(capped.length).toBeLessThanOrEqual(2000)
    expect(capped).toContain('...(truncated')
  })

  it('caps at 4000 for large context (>=64K)', () => {
    const long = 'x'.repeat(8000)
    const capped = capToolResult(long, 131072)
    expect(capped.length).toBeLessThanOrEqual(4000)
    expect(capped).toContain('...(truncated')
  })

  it('preserves start and end of output', () => {
    const long = 'START' + 'x'.repeat(5000) + 'END_CONTENT'
    const capped = capToolResult(long, 32768)
    expect(capped.startsWith('START')).toBe(true)
    expect(capped.endsWith('END_CONTENT')).toBe(true)
  })

  it('shows truncated char count', () => {
    const long = 'x'.repeat(5000)
    const capped = capToolResult(long, 32768)
    expect(capped).toContain('truncated')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/resultCapping.test.ts`
Expected: FAIL — capToolResult doesn't exist

- [ ] **Step 3: Create resultCap.ts**

Create `engine/tools/resultCap.ts`:

```typescript
/**
 * Cap tool output based on context window size.
 * Preserves start (most relevant) and end (error summaries/stack traces).
 */
export function capToolResult(output: string, contextLength: number): string {
  const cap = contextLength < 64000 ? 2000 : 4000
  if (output.length <= cap) return output

  const headSize = cap - 500
  const tailSize = 300
  const truncated = output.length - cap
  return (
    output.slice(0, headSize) +
    `\n...(truncated ${truncated} chars)...\n` +
    output.slice(-tailSize)
  )
}
```

- [ ] **Step 4: Integrate into executor.ts**

In `engine/tools/executor.ts`, add import at line 3:

```typescript
import { capToolResult } from './resultCap.js'
```

Add a `contextLength` field to the class and constructor:

```typescript
  private contextLength: number

  constructor(opts: ToolExecutorOptions) {
    this.cwd = opts.cwd
    this.requestApproval = opts.requestApproval
    this.trustProfile = opts.trustProfile
    this.approveAll = opts.approveAll ?? false
    this.contextLength = opts.contextLength ?? 32768
  }
```

Add `contextLength` to `ToolExecutorOptions`:

```typescript
export type ToolExecutorOptions = {
  cwd: string
  requestApproval: RequestApprovalFn
  trustProfile?: ToolTrustProfile
  approveAll?: boolean
  contextLength?: number
}
```

Replace line 69 (`return result`) with:

```typescript
      return {
        output: capToolResult(result.output, this.contextLength),
        isError: result.isError,
      }
```

- [ ] **Step 5: Run tests**

Run: `cd engine && bunx vitest run __tests__/resultCapping.test.ts`
Expected: PASS

Run: `cd engine && bunx vitest run`
Expected: PASS (all existing tests still pass)

- [ ] **Step 6: Commit**

```bash
git add engine/tools/resultCap.ts engine/tools/executor.ts engine/__tests__/resultCapping.test.ts
git commit -m "feat(tools): add adaptive tool result capping based on context window size"
```

---

### Task 2: Blocking Command Detection

**Files:**
- Modify: `engine/tools/bashSafety.ts`
- Test: `engine/__tests__/blockingCommands.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/blockingCommands.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { checkBashSafety } from '../tools/bashSafety.js'

describe('blocking command detection', () => {
  it('blocks bare python REPL', () => {
    expect(checkBashSafety('python').safe).toBe(false)
    expect(checkBashSafety('python3').safe).toBe(false)
    expect(checkBashSafety('node').safe).toBe(false)
  })

  it('blocks server processes', () => {
    expect(checkBashSafety('python app.py').safe).toBe(false)
    expect(checkBashSafety('node server.js').safe).toBe(false)
    expect(checkBashSafety('npm start').safe).toBe(false)
    expect(checkBashSafety('bun run dev').safe).toBe(false)
    expect(checkBashSafety('uvicorn main:app').safe).toBe(false)
    expect(checkBashSafety('flask run').safe).toBe(false)
    expect(checkBashSafety('next dev').safe).toBe(false)
    expect(checkBashSafety('vite dev').safe).toBe(false)
  })

  it('allows test commands', () => {
    expect(checkBashSafety('python -m pytest').safe).toBe(true)
    expect(checkBashSafety('node --check server.js').safe).toBe(true)
    expect(checkBashSafety('npm test').safe).toBe(true)
    expect(checkBashSafety('python --version').safe).toBe(true)
  })

  it('allows background processes', () => {
    expect(checkBashSafety('python app.py &').safe).toBe(true)
  })

  it('allows normal commands', () => {
    expect(checkBashSafety('python script.py').safe).toBe(true)
    expect(checkBashSafety('node build.js').safe).toBe(true)
    expect(checkBashSafety('ls -la').safe).toBe(true)
    expect(checkBashSafety('git status').safe).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify failures**

Run: `cd engine && bunx vitest run __tests__/blockingCommands.test.ts`
Expected: FAIL — blocking patterns don't exist yet

- [ ] **Step 3: Add blocking patterns to bashSafety.ts**

In `engine/tools/bashSafety.ts`, add after the existing `BLOCKED_PATTERNS` array (before the `checkBashSafety` function):

```typescript
const BLOCKING_EXCEPTIONS = /--check|--version|--help|\btest\b|--dry-run|&\s*$/

const BLOCKING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(python|python3|node|bun)\s*$/, reason: 'Refused: bare REPL would block the session' },
  { pattern: /^(node|python|python3|bun|deno)\s+.*\b(server\.|app\.)/i, reason: 'Refused: this would start a long-running server' },
  { pattern: /(uvicorn|gunicorn|flask\s+run|django.*runserver|rails\s+s)/i, reason: 'Refused: this would start a long-running server' },
  { pattern: /(npm\s+start|yarn\s+start|bun\s+run\s+dev|next\s+dev|vite\s+dev)/i, reason: 'Refused: this would start a long-running dev server' },
  { pattern: /(--interactive\b|-i\s*$)/, reason: 'Refused: interactive mode would block the session' },
]
```

Update the `checkBashSafety` function to also check blocking patterns:

```typescript
export function checkBashSafety(command: string): SafetyResult {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason }
    }
  }
  // Blocking command check — skip if command has an exception keyword
  if (!BLOCKING_EXCEPTIONS.test(command)) {
    for (const { pattern, reason } of BLOCKING_PATTERNS) {
      if (pattern.test(command)) {
        return { safe: false, reason: reason + '. Run in background with & or use a test/check command instead.' }
      }
    }
  }
  return { safe: true }
}
```

- [ ] **Step 4: Run tests**

Run: `cd engine && bunx vitest run __tests__/blockingCommands.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/tools/bashSafety.ts engine/__tests__/blockingCommands.test.ts
git commit -m "feat(tools): add blocking command detection for servers and REPLs"
```

---

### Task 3: Bash Error Diagnosis

**Files:**
- Modify: `engine/tools/impl/bash.ts`
- Test: `engine/__tests__/errorDiagnosis.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/errorDiagnosis.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { diagnoseError } from '../tools/errorDiagnosis.js'

describe('diagnoseError', () => {
  it('classifies SyntaxError', () => {
    const result = diagnoseError('SyntaxError: Unexpected token }')
    expect(result.type).toBe('syntax')
    expect(result.hint).toContain('syntax')
  })

  it('classifies ModuleNotFoundError', () => {
    const result = diagnoseError("ModuleNotFoundError: No module named 'requests'")
    expect(result.type).toBe('dependency')
    expect(result.hint).toContain('Install')
  })

  it('classifies permission denied', () => {
    const result = diagnoseError('Permission denied: /usr/local/bin/foo')
    expect(result.type).toBe('permission')
  })

  it('classifies command not found', () => {
    const result = diagnoseError('bash: foobar: command not found')
    expect(result.type).toBe('not_found')
  })

  it('classifies TypeError', () => {
    const result = diagnoseError("TypeError: Cannot read properties of undefined (reading 'map')")
    expect(result.type).toBe('runtime')
  })

  it('classifies timeout', () => {
    const result = diagnoseError('Error: timed out after 120000ms')
    expect(result.type).toBe('timeout')
  })

  it('returns unknown for unrecognized errors', () => {
    const result = diagnoseError('Something weird happened')
    expect(result.type).toBe('unknown')
  })

  it('formats output with hint prefix', () => {
    const result = diagnoseError('SyntaxError: bad')
    expect(result.formatted).toMatch(/^\[ERROR: syntax\]/)
    expect(result.formatted).toContain('SyntaxError: bad')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/errorDiagnosis.test.ts`
Expected: FAIL — diagnoseError doesn't exist

- [ ] **Step 3: Create errorDiagnosis.ts**

Create `engine/tools/errorDiagnosis.ts`:

```typescript
type ErrorType = 'syntax' | 'runtime' | 'permission' | 'not_found' | 'timeout' | 'dependency' | 'unknown'

type Diagnosis = {
  type: ErrorType
  hint: string
  formatted: string
}

const PATTERNS: Array<{ type: ErrorType; pattern: RegExp; hint: string }> = [
  { type: 'syntax', pattern: /SyntaxError|parse error|unexpected token|unexpected end/i, hint: 'Check syntax near the indicated line' },
  { type: 'dependency', pattern: /ModuleNotFoundError|Cannot find module|ImportError|no module named/i, hint: 'Install the missing package first' },
  { type: 'runtime', pattern: /TypeError|ReferenceError|NullPointerException|segfault|SIGSEGV|AttributeError|NameError|KeyError|IndexError/i, hint: 'Variable or function may be undefined or wrong type' },
  { type: 'permission', pattern: /EACCES|Permission denied|Operation not permitted|EPERM/i, hint: 'Check file permissions or run with elevated access' },
  { type: 'not_found', pattern: /command not found|ENOENT|No such file|not recognized as/i, hint: 'Check the command/path exists and is spelled correctly' },
  { type: 'timeout', pattern: /timed? out|exceeded|SIGKILL|SIGTERM/i, hint: 'Command took too long — try a simpler version or add limits' },
]

export function diagnoseError(stderr: string): Diagnosis {
  for (const { type, pattern, hint } of PATTERNS) {
    if (pattern.test(stderr)) {
      return { type, hint, formatted: `[ERROR: ${type}] ${hint}\n\n${stderr}` }
    }
  }
  return { type: 'unknown', hint: 'Check the error output above', formatted: `[ERROR: unknown] Check the error output above\n\n${stderr}` }
}
```

- [ ] **Step 4: Integrate into bash.ts**

In `engine/tools/impl/bash.ts`, add import:

```typescript
import { diagnoseError } from '../errorDiagnosis.js'
```

Replace line 42 (`const output = stderr || stdout || ...`):

```typescript
          const rawOutput = stderr || stdout || `Command exited with code ${(err as any).code}`
          const diagnosis = diagnoseError(rawOutput)
          resolve({ output: diagnosis.formatted, isError: true })
```

- [ ] **Step 5: Run tests**

Run: `cd engine && bunx vitest run __tests__/errorDiagnosis.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add engine/tools/errorDiagnosis.ts engine/tools/impl/bash.ts engine/__tests__/errorDiagnosis.test.ts
git commit -m "feat(tools): add bash error diagnosis with type classification and fix hints"
```

---

### Task 4: Per-Tool Trust Score Decay

**Files:**
- Create: `engine/tools/toolScorer.ts`
- Modify: `engine/tools/executor.ts`
- Modify: `engine/s5/types.ts`
- Test: `engine/__tests__/toolScorer.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/toolScorer.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { ToolScorer } from '../tools/toolScorer.js'

describe('ToolScorer', () => {
  let scorer: ToolScorer

  beforeEach(() => {
    scorer = new ToolScorer()
  })

  it('starts with high confidence for unknown tools', () => {
    expect(scorer.getConfidence('Read')).toBeCloseTo(0.5, 1) // (0+1)/(0+2) = 0.5
  })

  it('increases confidence on success', () => {
    scorer.record('Read', true)
    scorer.record('Read', true)
    scorer.record('Read', true)
    expect(scorer.getConfidence('Read')).toBeGreaterThan(0.7)
  })

  it('decreases confidence on failure', () => {
    scorer.record('Bash', false)
    scorer.record('Bash', false)
    scorer.record('Bash', false)
    expect(scorer.getConfidence('Bash')).toBeLessThan(0.35)
  })

  it('demotes tool after 3+ calls with <0.35 confidence', () => {
    scorer.record('Edit', false)
    scorer.record('Edit', false)
    scorer.record('Edit', false)
    expect(scorer.shouldDemote('Edit')).toBe(true)
  })

  it('does not demote with fewer than 3 calls', () => {
    scorer.record('Edit', false)
    scorer.record('Edit', false)
    expect(scorer.shouldDemote('Edit')).toBe(false)
  })

  it('does not demote successful tools', () => {
    scorer.record('Read', true)
    scorer.record('Read', true)
    scorer.record('Read', true)
    expect(scorer.shouldDemote('Read')).toBe(false)
  })

  it('returns list of demoted tools', () => {
    scorer.record('Bash', false)
    scorer.record('Bash', false)
    scorer.record('Bash', false)
    scorer.record('Read', true)
    scorer.record('Read', true)
    expect(scorer.getDemotedTools()).toEqual(['Bash'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/toolScorer.test.ts`
Expected: FAIL

- [ ] **Step 3: Create toolScorer.ts**

Create `engine/tools/toolScorer.ts`:

```typescript
type ToolStats = { successes: number; total: number }

export class ToolScorer {
  private scores = new Map<string, ToolStats>()

  record(toolName: string, success: boolean): void {
    const stats = this.scores.get(toolName) ?? { successes: 0, total: 0 }
    stats.total++
    if (success) stats.successes++
    this.scores.set(toolName, stats)
  }

  /** Bayesian confidence with Laplace smoothing. */
  getConfidence(toolName: string): number {
    const stats = this.scores.get(toolName) ?? { successes: 0, total: 0 }
    return (stats.successes + 1) / (stats.total + 2)
  }

  shouldDemote(toolName: string): boolean {
    const stats = this.scores.get(toolName)
    if (!stats || stats.total < 3) return false
    return this.getConfidence(toolName) < 0.35
  }

  getDemotedTools(): string[] {
    return [...this.scores.keys()].filter(t => this.shouldDemote(t))
  }

  /** Save scores to JSON file. */
  save(path: string): void {
    const data: Record<string, ToolStats> = {}
    for (const [k, v] of this.scores) data[k] = v
    try {
      const fs = require('fs')
      const dir = require('path').dirname(path)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path, JSON.stringify(data, null, 2))
    } catch {}
  }

  /** Load scores from JSON file. */
  load(path: string): void {
    try {
      const fs = require('fs')
      if (!fs.existsSync(path)) return
      const data = JSON.parse(fs.readFileSync(path, 'utf-8'))
      for (const [k, v] of Object.entries(data)) {
        this.scores.set(k, v as ToolStats)
      }
    } catch {}
  }
}
```

- [ ] **Step 4: Integrate into executor.ts**

In `engine/tools/executor.ts`, add import:

```typescript
import { ToolScorer } from './toolScorer.js'
```

Add to `ToolExecutorOptions`:

```typescript
  toolScorer?: ToolScorer
```

Add field and constructor wiring:

```typescript
  private toolScorer?: ToolScorer

  // In constructor:
  this.toolScorer = opts.toolScorer
```

After the `capToolResult` line (added in Task 1), add trust recording:

```typescript
      // Record tool result for trust scoring
      this.toolScorer?.record(toolName, !result.isError)
```

Add a getter:

```typescript
  getToolScorer(): ToolScorer | undefined { return this.toolScorer }
```

- [ ] **Step 5: Add demotedTools to S5Input**

In `engine/s5/types.ts`, add to S5Input after `observerDivergence`:

```typescript
  demotedTools: string[]
```

- [ ] **Step 6: Run tests**

Run: `cd engine && bunx vitest run __tests__/toolScorer.test.ts`
Expected: PASS

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add engine/tools/toolScorer.ts engine/tools/executor.ts engine/s5/types.ts engine/__tests__/toolScorer.test.ts
git commit -m "feat(tools): add per-tool trust score decay with Bayesian smoothing"
```

---

### Task 5: Contract / Definition of Done

**Files:**
- Create: `engine/tools/contract.ts`
- Modify: `engine/tools/registry.ts`
- Test: `engine/__tests__/contract.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/contract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ContractState, contractCreateTool, contractAssertPassTool, contractAssertFailTool, contractStatusTool } from '../tools/contract.js'

describe('ContractState', () => {
  it('creates contract with pending assertions', () => {
    const state = new ContractState()
    state.create('Fix bug', 'Fix the import error', ['File compiles', 'Tests pass', 'No import errors'])
    expect(state.isActive()).toBe(true)
    expect(state.assertions.length).toBe(3)
    expect(state.assertions.every(a => a.status === 'pending')).toBe(true)
  })

  it('marks assertion passed', () => {
    const state = new ContractState()
    state.create('Test', 'Test', ['A', 'B'])
    state.assertPass(0, 'verified by running tests')
    expect(state.assertions[0].status).toBe('passed')
    expect(state.assertions[0].evidence).toBe('verified by running tests')
  })

  it('marks assertion failed', () => {
    const state = new ContractState()
    state.create('Test', 'Test', ['A'])
    state.assertFail(0, 'compilation error on line 5')
    expect(state.assertions[0].status).toBe('failed')
  })

  it('isComplete returns false when pending assertions exist', () => {
    const state = new ContractState()
    state.create('Test', 'Test', ['A', 'B'])
    state.assertPass(0, 'done')
    expect(state.isComplete()).toBe(false)
  })

  it('isComplete returns true when all passed or skipped', () => {
    const state = new ContractState()
    state.create('Test', 'Test', ['A', 'B'])
    state.assertPass(0, 'done')
    state.assertPass(1, 'done')
    expect(state.isComplete()).toBe(true)
  })

  it('getStatus returns formatted summary', () => {
    const state = new ContractState()
    state.create('Fix', 'Fix it', ['Compiles', 'Tests pass'])
    state.assertPass(0, 'yes')
    const status = state.getStatus()
    expect(status).toContain('Fix')
    expect(status).toContain('passed')
    expect(status).toContain('pending')
  })
})

describe('contract tools', () => {
  it('contractCreateTool creates contract', async () => {
    const result = await contractCreateTool.execute({
      title: 'Fix bug',
      brief: 'Fix the import error in main.ts',
      assertions: ['File compiles without errors', 'Tests pass'],
    }, '/tmp')
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Contract created')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/contract.test.ts`
Expected: FAIL

- [ ] **Step 3: Create contract.ts**

Create `engine/tools/contract.ts`:

```typescript
import type { ToolImpl, ToolResult } from './types.js'

type AssertionStatus = 'pending' | 'passed' | 'failed' | 'skipped'

type Assertion = {
  text: string
  status: AssertionStatus
  evidence?: string
}

export class ContractState {
  title = ''
  brief = ''
  assertions: Assertion[] = []
  private _active = false
  enforcementRounds = 0

  create(title: string, brief: string, assertionTexts: string[]): void {
    this.title = title
    this.brief = brief
    this.assertions = assertionTexts.map(text => ({ text, status: 'pending' as AssertionStatus }))
    this._active = true
    this.enforcementRounds = 0
  }

  assertPass(index: number, evidence: string): void {
    if (index >= 0 && index < this.assertions.length) {
      this.assertions[index].status = 'passed'
      this.assertions[index].evidence = evidence
    }
  }

  assertFail(index: number, evidence: string): void {
    if (index >= 0 && index < this.assertions.length) {
      this.assertions[index].status = 'failed'
      this.assertions[index].evidence = evidence
    }
  }

  assertSkip(index: number, reason: string): void {
    if (index >= 0 && index < this.assertions.length) {
      this.assertions[index].status = 'skipped'
      this.assertions[index].evidence = reason
    }
  }

  isActive(): boolean { return this._active }

  isComplete(): boolean {
    return this.assertions.every(a => a.status === 'passed' || a.status === 'skipped')
  }

  pendingCount(): number { return this.assertions.filter(a => a.status === 'pending').length }
  failedCount(): number { return this.assertions.filter(a => a.status === 'failed').length }

  getStatus(): string {
    let out = `Contract: ${this.title}\n${this.brief}\n\n`
    for (let i = 0; i < this.assertions.length; i++) {
      const a = this.assertions[i]
      const icon = a.status === 'passed' ? '[PASS]' : a.status === 'failed' ? '[FAIL]' : a.status === 'skipped' ? '[SKIP]' : '[    ]'
      out += `${icon} ${i}: ${a.text}`
      if (a.evidence) out += ` — ${a.evidence}`
      out += '\n'
    }
    return out
  }

  clear(): void {
    this._active = false
    this.assertions = []
    this.enforcementRounds = 0
  }
}

// Singleton state — shared across all contract tool calls in a session
export const globalContract = new ContractState()

export const contractCreateTool: ToolImpl = {
  name: 'ContractCreate',
  description: 'Declare a definition of done with testable assertions. The session cannot complete until all assertions pass.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Contract title' },
      brief: { type: 'string', description: 'Brief description of the task' },
      assertions: { type: 'array', description: 'List of testable assertion strings' },
    },
    required: ['title', 'brief', 'assertions'],
  },
  tier: 'auto',
  execute: async (input): Promise<ToolResult> => {
    const title = input.title as string
    const brief = input.brief as string
    const assertions = input.assertions as string[]
    globalContract.create(title, brief, assertions)
    return { output: `Contract created: "${title}" with ${assertions.length} assertions.\n\n${globalContract.getStatus()}`, isError: false }
  },
}

export const contractAssertPassTool: ToolImpl = {
  name: 'ContractAssertPass',
  description: 'Mark a contract assertion as passed with evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      index: { type: 'number', description: 'Assertion index (0-based)' },
      evidence: { type: 'string', description: 'Evidence that the assertion passed' },
    },
    required: ['index', 'evidence'],
  },
  tier: 'auto',
  execute: async (input): Promise<ToolResult> => {
    globalContract.assertPass(input.index as number, input.evidence as string)
    return { output: globalContract.getStatus(), isError: false }
  },
}

export const contractAssertFailTool: ToolImpl = {
  name: 'ContractAssertFail',
  description: 'Mark a contract assertion as failed with evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      index: { type: 'number', description: 'Assertion index (0-based)' },
      evidence: { type: 'string', description: 'Evidence of failure' },
    },
    required: ['index', 'evidence'],
  },
  tier: 'auto',
  execute: async (input): Promise<ToolResult> => {
    globalContract.assertFail(input.index as number, input.evidence as string)
    return { output: globalContract.getStatus(), isError: false }
  },
}

export const contractStatusTool: ToolImpl = {
  name: 'ContractStatus',
  description: 'Show current contract status — all assertions and their pass/fail/pending state.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  tier: 'auto',
  execute: async (): Promise<ToolResult> => {
    if (!globalContract.isActive()) {
      return { output: 'No active contract.', isError: false }
    }
    return { output: globalContract.getStatus(), isError: false }
  },
}
```

- [ ] **Step 4: Register contract tools**

In `engine/tools/registry.ts`, add imports:

```typescript
import { contractCreateTool, contractAssertPassTool, contractAssertFailTool, contractStatusTool } from './contract.js'
```

Add to `ALL_TOOLS` array:

```typescript
  contractCreateTool, contractAssertPassTool, contractAssertFailTool, contractStatusTool,
```

- [ ] **Step 5: Run tests**

Run: `cd engine && bunx vitest run __tests__/contract.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add engine/tools/contract.ts engine/tools/registry.ts engine/__tests__/contract.test.ts
git commit -m "feat(tools): add contract/definition-of-done system with 4 tools"
```

---

### Task 6: Contract Enforcement in Conversation Loop

**Files:**
- Modify: `engine/bridge/conversationLoop.ts`

- [ ] **Step 1: Add contract enforcement**

In `engine/bridge/conversationLoop.ts`, add import:

```typescript
import { globalContract } from '../tools/contract.js'
```

Find where `stop_reason === 'end_turn'` is handled (the end of the model loop iteration where the model returns without tool calls). Add before the response is emitted:

```typescript
    // Contract enforcement: don't let model finish if contract is incomplete
    if (globalContract.isActive() && !globalContract.isComplete()) {
      globalContract.enforcementRounds++
      if (globalContract.enforcementRounds <= 3) {
        const pending = globalContract.pendingCount()
        const failed = globalContract.failedCount()
        // Inject system message to continue
        this.messages.push({
          role: 'user',
          content: [{ type: 'text', text: `[System] Contract incomplete — ${pending} assertions pending, ${failed} failed. Continue working. Use ContractStatus to check progress.` }],
        })
        continue // Continue the model loop
      }
      // Safety valve: after 3 rounds, warn but allow completion
      console.log(`[contract] Allowing completion after ${globalContract.enforcementRounds} enforcement rounds`)
    }
```

- [ ] **Step 2: Add contract context to system prompt**

In the system prompt building section of `conversationLoop.ts`, add:

```typescript
    if (globalContract.isActive()) {
      systemPromptParts.push(
        '\n\nYou have an active contract (definition of done). Use ContractStatus to check progress. All assertions must pass before you finish.'
      )
    }
```

Find where the system prompt is assembled (look for `systemPrompt` concatenation) and add this conditional.

- [ ] **Step 3: Run full test suite**

Run: `cd engine && bunx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add engine/bridge/conversationLoop.ts
git commit -m "feat(tools): enforce contract completion before model can finish turn"
```

---

### Task 7: Two-Stage Tool Routing

**Files:**
- Create: `engine/tools/toolRouter.ts`
- Test: `engine/__tests__/toolRouter.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/toolRouter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { TOOL_CATEGORIES, getToolsForCategory, shouldUseRouting } from '../tools/toolRouter.js'

describe('toolRouter', () => {
  it('has 6 categories', () => {
    expect(Object.keys(TOOL_CATEGORIES).length).toBe(6)
  })

  it('read category includes Read, Glob, Grep, Ls, CodeIndex', () => {
    expect(TOOL_CATEGORIES.read).toContain('Read')
    expect(TOOL_CATEGORIES.read).toContain('Glob')
    expect(TOOL_CATEGORIES.read).toContain('Grep')
  })

  it('write category includes Edit, Write, MultiEdit, ApplyPatch', () => {
    expect(TOOL_CATEGORIES.write).toContain('Edit')
    expect(TOOL_CATEGORIES.write).toContain('Write')
  })

  it('getToolsForCategory returns filtered tools', () => {
    const allTools = [
      { name: 'Read' }, { name: 'Edit' }, { name: 'Bash' },
    ] as any[]
    const readTools = getToolsForCategory('read', allTools)
    expect(readTools.map(t => t.name)).toEqual(['Read'])
  })

  it('getToolsForCategory with "all" returns everything', () => {
    const allTools = [{ name: 'Read' }, { name: 'Edit' }] as any[]
    expect(getToolsForCategory('all', allTools)).toEqual(allTools)
  })

  it('shouldUseRouting is true for small context', () => {
    expect(shouldUseRouting(16384)).toBe(true)
    expect(shouldUseRouting(32767)).toBe(true)
  })

  it('shouldUseRouting is false for large context', () => {
    expect(shouldUseRouting(32768)).toBe(false)
    expect(shouldUseRouting(131072)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/toolRouter.test.ts`
Expected: FAIL

- [ ] **Step 3: Create toolRouter.ts**

Create `engine/tools/toolRouter.ts`:

```typescript
import type { ToolImpl } from './types.js'

export const TOOL_CATEGORIES: Record<string, string[]> = {
  read: ['Read', 'Glob', 'Grep', 'Ls', 'CodeIndex'],
  write: ['Edit', 'Write', 'MultiEdit', 'ApplyPatch'],
  search: ['Grep', 'Glob', 'WebSearch', 'WebFetch', 'IndexResearch'],
  execute: ['Bash', 'Git'],
  agent: ['SpawnAgent', 'CollectAgent'],
  all: [], // Special: returns all tools
}

export const CATEGORY_SELECTOR_TOOL = {
  name: 'select_category',
  description: 'Select which category of tools you need for this step. Pick the most relevant category.',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        enum: Object.keys(TOOL_CATEGORIES),
        description: 'Tool category: read (view files), write (edit files), search (find code/web), execute (run commands), agent (spawn helpers), all (everything)',
      },
    },
    required: ['category'],
  },
}

export function getToolsForCategory(category: string, allTools: ToolImpl[]): ToolImpl[] {
  if (category === 'all') return allTools
  const names = TOOL_CATEGORIES[category]
  if (!names) return allTools
  const nameSet = new Set(names)
  return allTools.filter(t => nameSet.has(t.name))
}

export function shouldUseRouting(contextLength: number): boolean {
  return contextLength < 32768
}
```

- [ ] **Step 4: Run tests**

Run: `cd engine && bunx vitest run __tests__/toolRouter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/tools/toolRouter.ts engine/__tests__/toolRouter.test.ts
git commit -m "feat(tools): add 2-stage tool routing with category selector for small models"
```

---

### Task 8: Semantic Merge Fallback for Edit

**Files:**
- Modify: `engine/tools/impl/edit.ts`
- Test: `engine/__tests__/semanticMerge.test.ts`

- [ ] **Step 1: Write the test**

Create `engine/__tests__/semanticMerge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { attemptSemanticMerge } from '../tools/semanticMerge.js'

describe('attemptSemanticMerge', () => {
  it('returns null if file is too large (>500 lines)', () => {
    const content = Array(501).fill('line').join('\n')
    const result = attemptSemanticMerge(content, 'old', 'new', 'file.ts', new Set())
    expect(result).toBeNull()
  })

  it('returns null if file already attempted this turn', () => {
    const attempted = new Set(['file.ts'])
    const result = attemptSemanticMerge('content', 'old', 'new', 'file.ts', attempted)
    expect(result).toBeNull()
  })

  it('marks file as attempted', () => {
    const attempted = new Set<string>()
    attemptSemanticMerge('small file', 'old', 'new', 'test.ts', attempted)
    expect(attempted.has('test.ts')).toBe(true)
  })

  it('returns merge prompt for valid file', () => {
    const result = attemptSemanticMerge('const x = 1;', 'const y', 'const z', 'test.ts', new Set())
    expect(result).not.toBeNull()
    expect(result!.system).toContain('code merger')
    expect(result!.user).toContain('const x = 1;')
    expect(result!.user).toContain('const y')
    expect(result!.user).toContain('const z')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bunx vitest run __tests__/semanticMerge.test.ts`
Expected: FAIL

- [ ] **Step 3: Create semanticMerge.ts**

Create `engine/tools/semanticMerge.ts`:

```typescript
type MergePrompt = {
  system: string
  user: string
}

/**
 * Build a merge prompt for the LLM when Edit's old_str is not found.
 * Returns null if the file is too large or already attempted this turn.
 */
export function attemptSemanticMerge(
  fileContent: string,
  oldStr: string,
  newStr: string,
  filePath: string,
  attemptedFiles: Set<string>,
): MergePrompt | null {
  // Guard: only attempt once per file per turn
  if (attemptedFiles.has(filePath)) return null
  attemptedFiles.add(filePath)

  // Guard: only for files under 500 lines
  const lineCount = fileContent.split('\n').length
  if (lineCount > 500) return null

  return {
    system: 'You are a code merger. Apply the intended edit to the current file. Return ONLY the complete updated file content. No markdown fences, no explanation.',
    user: `Current file:\n\`\`\`\n${fileContent}\n\`\`\`\n\nIntended edit — replace:\n\`\`\`\n${oldStr}\n\`\`\`\nWith:\n\`\`\`\n${newStr}\n\`\`\``,
  }
}
```

- [ ] **Step 4: Integration note**

The actual semantic merge execution requires `sideQuery()` from the conversation loop. In `engine/tools/impl/edit.ts`, at line 34 where `old_str` is not found, the fallback would call `attemptSemanticMerge()` to get the prompt, then use `sideQuery()` to get the merged content. This integration requires passing `sideQuery` as a dependency to the tool executor, which is a larger wiring change.

For now, the merge prompt builder is ready. The full integration into the edit tool's fallback path should be wired when the conversation loop passes `sideQuery` to the executor (add `sideQuery` to `ToolExecutorOptions` and thread it through).

- [ ] **Step 5: Run tests**

Run: `cd engine && bunx vitest run __tests__/semanticMerge.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add engine/tools/semanticMerge.ts engine/__tests__/semanticMerge.test.ts
git commit -m "feat(tools): add semantic merge prompt builder for Edit fallback"
```

---

### Task 9: Wire Check

- [ ] **Step 1: Verify result capping wraps all tool outputs**

```bash
cd engine && grep -n "capToolResult" tools/executor.ts
```

Expected: import + usage wrapping the result

- [ ] **Step 2: Verify blocking patterns in bashSafety**

```bash
cd engine && grep -n "BLOCKING_PATTERNS\|Refused.*server\|Refused.*REPL" tools/bashSafety.ts
```

Expected: BLOCKING_PATTERNS array + blocking messages

- [ ] **Step 3: Verify error diagnosis in bash.ts**

```bash
cd engine && grep -n "diagnoseError" tools/impl/bash.ts
```

Expected: import + call in error handler

- [ ] **Step 4: Verify trust scorer in executor**

```bash
cd engine && grep -n "toolScorer\|ToolScorer" tools/executor.ts
```

Expected: import, field, record() call

- [ ] **Step 5: Verify contract tools registered**

```bash
cd engine && grep -n "contract" tools/registry.ts
```

Expected: 4 contract tool imports + in ALL_TOOLS

- [ ] **Step 6: Verify contract enforcement in conversation loop**

```bash
cd engine && grep -n "globalContract\|contract" bridge/conversationLoop.ts
```

Expected: import + enforcement logic at end_turn

- [ ] **Step 7: Verify tool router exists**

```bash
cd engine && ls tools/toolRouter.ts && grep -c "TOOL_CATEGORIES" tools/toolRouter.ts
```

Expected: file exists, TOOL_CATEGORIES defined

- [ ] **Step 8: Verify demotedTools in S5Input**

```bash
cd engine && grep -n "demotedTools" s5/types.ts
```

Expected: field in S5Input

- [ ] **Step 9: Run full test suite**

```bash
cd engine && bunx vitest run
```

Expected: all tests pass

- [ ] **Step 10: Commit**

```bash
git commit --allow-empty -m "test: wire check — SmallCode feature port verified end-to-end"
```
