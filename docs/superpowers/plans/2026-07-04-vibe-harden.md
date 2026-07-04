# Vibe Harden (PR 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing vibe-loop wiring provably work against today's engine: fix the provider rot bug, add timeouts, cover the controller chain with integration tests, fix the escalation-dialog race, and pass a live end-to-end run.

**Architecture:** The vibe loop is already wired (VibeController in `engine/vibe/controller.ts` ↔ `ConversationLoop` ↔ TUI over WebSocket). This PR fixes two provider-routing rot bugs (vibe sideQuery and wizard.query are Ollama-only while the primary backend is llama-cpp), adds a timeout wrapper inside VibeController, adds real integration tests with a fake loop + scripted sideQuery, serializes the TUI escalation dialogs, and adds a manual E2E script that drives a real engine.

**Tech Stack:** TypeScript (Bun runtime, vitest-on-Node for tests), Python (Textual TUI, pytest).

**Spec:** `docs/superpowers/specs/2026-07-04-vibe-loop-completion-design.md`

**Conventions for the whole plan:**
- Branch: `vibe-harden` (already created off main at 5ae5b21).
- Run all git commands from the repo root `C:\Users\civer\localcode` (bash: `cd /c/Users/civer/localcode`). NEVER run git with cwd inside `engine/` or `tui/` — both contain embedded git repos.
- Engine tests: `npx vitest run <path>` from the repo root. TUI tests: `cd tui && python -m pytest tests/<file> -v` then `cd /c/Users/civer/localcode`.
- `docs/superpowers/` is gitignored — use `git add -f` for plan/spec files.
- Commit messages end with `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.
- Test imports come from `'bun:test'` (vitest aliases it) — EXCEPT `vi` for module mocking, which is not needed in this plan.

---

### Task 1: Provider-aware sideQuery — expose `runSideQuery` and route vibe + wizard through it

**Problem:** `engine/main.ts:404` (vibe controller sideQuery) and `engine/main.ts:860` (wizard.query) both fetch Ollama-only `${config.baseUrl}/api/chat`. With the llama-cpp primary backend (llama-server exposes only OpenAI-compatible `/v1/chat/completions`), every one of these calls fails and silently degrades to catch-block fallbacks. `ConversationLoop` already has a private provider-aware `sideQuery` at `engine/bridge/conversationLoop.ts:1287`. Expose it and use it.

**Files:**
- Modify: `engine/bridge/conversationLoop.ts:1287-1325` (sideQuery + new public wrapper)
- Modify: `engine/main.ts:396-423` (getOrCreateVibeController) and `engine/main.ts:843-896` (wizard.query)
- Test: `engine/__tests__/vibe/sideQueryRouting.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/vibe/sideQueryRouting.test.ts`:

```typescript
// engine/__tests__/vibe/sideQueryRouting.test.ts
// runSideQuery must route through the provider-appropriate endpoint —
// llama-cpp uses OpenAI-compatible /v1/chat/completions, Ollama uses /api/chat.
import { afterEach, describe, expect, it } from 'bun:test'
import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false,
    jsonMode: true, contextLength: 32768, streaming: true,
  }
}

function stubProvider(): Provider {
  return {
    name: 'stub',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {},
  }
}

function makeLoop(configOverrides: Record<string, unknown>) {
  return new ConversationLoop({
    config: {
      baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto',
      temperature: 0.7, maxOutputTokens: 8192, timeout: 120000,
      contextLength: 131072, tools: undefined, noScouts: true,
      ...configOverrides,
    } as any,
    provider: stubProvider(),
    emit: () => {},
  })
}

const realFetch = globalThis.fetch

describe('runSideQuery provider routing', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  it('llama-cpp: hits /v1/chat/completions with max_tokens and system message', async () => {
    let calledUrl = ''
    let body: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      calledUrl = String(url)
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 })
    }) as any

    const loop = makeLoop({ provider: 'llama-cpp', port: 8099 })
    const out = await loop.runSideQuery('ping', { maxTokens: 321, system: 'be terse' })

    expect(calledUrl).toBe('http://127.0.0.1:8099/v1/chat/completions')
    expect(body.max_tokens).toBe(321)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' })
    expect(body.messages[1].content).toContain('ping')
    expect(out).toBe('pong')
  })

  it('ollama: hits /api/chat with num_predict, falls back to message.thinking', async () => {
    let calledUrl = ''
    let body: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      calledUrl = String(url)
      body = JSON.parse(init.body)
      // Gemma4 pattern: empty content, answer in thinking
      return new Response(JSON.stringify({ message: { content: '', thinking: 'from-thinking' } }), { status: 200 })
    }) as any

    const loop = makeLoop({ provider: 'ollama' })
    const out = await loop.runSideQuery('ping', { maxTokens: 555 })

    expect(calledUrl).toBe('http://localhost:11434/api/chat')
    expect(body.options.num_predict).toBe(555)
    expect(out).toBe('from-thinking')
  })

  it('defaults maxTokens to 300 for satellite callers', async () => {
    let body: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 })
    }) as any

    const loop = makeLoop({ provider: 'ollama' })
    await loop.runSideQuery('ping')
    expect(body.options.num_predict).toBe(300)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/vibe/sideQueryRouting.test.ts`
Expected: FAIL — `loop.runSideQuery is not a function`

- [ ] **Step 3: Implement `runSideQuery` in ConversationLoop**

In `engine/bridge/conversationLoop.ts`, replace the private `sideQuery` (currently lines 1287-1325) with:

```typescript
  /**
   * Public provider-aware side query for satellite components
   * (vibe controller, wizard). Routes through the SAME backend as the
   * main model so llama-cpp users don't hit Ollama-only endpoints.
   */
  runSideQuery(prompt: string, opts?: { maxTokens?: number; system?: string }): Promise<string> {
    return this.sideQuery(prompt, opts?.maxTokens ?? 300, opts?.system)
  }

  private async sideQuery(prompt: string, maxTokens = 200, system?: string): Promise<string> {
    // Route through the SAME backend as the main model to avoid loading
    // a second model in Ollama when using llama-cpp provider.
    const providerUrl = this.config.provider === 'llama-cpp'
      ? `http://127.0.0.1:${this.config.port ?? 8081}`
      : (this.config.baseUrl || 'http://localhost:11434')

    if (this.config.provider === 'llama-cpp') {
      // llama-server: use OpenAI-compatible chat endpoint
      const resp = await fetch(`${providerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: '/no_think\n' + prompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
      })
      const data: any = await resp.json()
      return data.choices?.[0]?.message?.content ?? ''
    }

    // Ollama: use native API with think:false
    const resp = await fetch(`${providerUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        options: { num_predict: maxTokens, temperature: 0.3 },
        think: false,
        stream: false,
      }),
    })
    const data: any = await resp.json()
    // Gemma4 puts everything in message.thinking with empty content — fall back
    return data.message?.content || data.message?.thinking || ''
  }
```

Note: internal callers of `this.sideQuery(prompt)` keep the 200-token default — unchanged behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/vibe/sideQueryRouting.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Route the vibe controller through it**

In `engine/main.ts`, inside `getOrCreateVibeController()` (lines ~396-423), replace the whole `sideQuery:` property (the `async (prompt) => { fetch(...) }` block, lines ~404-418) with:

```typescript
      sideQuery: async (prompt: string) => loop.runSideQuery(prompt, { maxTokens: 300 }),
```

- [ ] **Step 6: Route wizard.query through it**

In `engine/main.ts`, `case 'wizard.query'` (lines ~843-896): replace the `fetch` + response parsing (from `const resp = await fetch(...)` through `const text = rawContent || (data.message?.thinking ?? '')`) with:

```typescript
        const text = await loop.runSideQuery(prompt, {
          maxTokens: prompt.length > 500 && systemPrompt.includes('HTML') ? 16384 : 4096,
          system: systemPrompt || undefined,
        })
```

Keep the surrounding try/catch, timing log, and `wizard.response` emissions exactly as they are. Delete the now-unused comment block about Ollama native `/api/chat`.

- [ ] **Step 7: Typecheck and run the vibe + bridge test suites**

Run: `npx tsc --noEmit -p . 2>/dev/null || bunx tsc --noEmit` (if no tsconfig check script exists, skip) and `npx vitest run engine/__tests__/vibe/ engine/__tests__/bridge/`
Expected: PASS, no regressions

- [ ] **Step 8: Commit**

```bash
cd /c/Users/civer/localcode
git add engine/bridge/conversationLoop.ts engine/main.ts engine/__tests__/vibe/sideQueryRouting.test.ts
git commit -m "fix: route vibe + wizard sideQuery through provider-aware endpoint

Both were hardcoded to Ollama /api/chat and silently failed on the
llama-cpp primary backend, degrading every vibe question/analogy/
verification and wizard query to catch-block fallbacks.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: sideQuery timeout in VibeController

**Problem:** No timeout on any `sideQuery` call in `engine/vibe/controller.ts` — a hung model call hangs the vibe loop forever. Every call site already has a try/catch fallback (fallback question, generic analogy, etc.), so a timeout rejection degrades gracefully; it just needs to actually fire.

**Files:**
- Modify: `engine/vibe/controller.ts:41-65` (options + constructor)
- Modify: `engine/main.ts` (pass `timeoutMs` in getOrCreateVibeController)
- Test: `engine/__tests__/vibe/controllerIntegration.test.ts` (created here, extended in Task 3)

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/vibe/controllerIntegration.test.ts` with the shared harness (Task 3 adds more tests to this file):

```typescript
// engine/__tests__/vibe/controllerIntegration.test.ts
// Integration tests for the VibeController chain with a fake ConversationLoop
// and a scripted sideQuery — no model, no network.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { VibeController } from '../../vibe/controller.js'
import type { ConversationLoop } from '../../bridge/conversationLoop.js'

// ─── Harness ────────────────────────────────────────────────────

/** Fake ConversationLoop recording every call the controller makes. */
function fakeLoop(overrides: Record<string, any> = {}) {
  const calls = {
    handleUserMessage: [] as string[],
    setApproveAll: [] as boolean[],
    verifications: [] as boolean[],
  }
  const loop = {
    setApproveAll: (v: boolean) => { calls.setApproveAll.push(v) },
    handleUserMessage: async (text: string) => { calls.handleUserMessage.push(text) },
    getGovernanceReport: () => ({ stuckTurns: 0 }),
    buildHandoff: () => ({ files_modified: ['hello.py'] }),
    reportVerification: (passed: boolean) => { calls.verifications.push(passed) },
    ...overrides,
  }
  return { loop: loop as unknown as ConversationLoop, calls }
}

/** Scripted sideQuery dispatching on prompt markers used by controller.ts. */
function scriptedSideQuery(overrides: Record<string, string | ((p: string) => string)> = {}) {
  const calls: string[] = []
  const fn = async (prompt: string): Promise<string> => {
    calls.push(prompt)
    for (const [marker, reply] of Object.entries(overrides)) {
      if (prompt.includes(marker)) return typeof reply === 'function' ? reply(prompt) : reply
    }
    if (prompt.includes('Answer YES or NO')) return 'NO'          // shouldResearch
    if (prompt.includes('Verify 3 levels')) return 'PASS'          // goal verification
    if (prompt.includes('relatable analogy')) return 'Think of it like a new door on your house.'
    if (prompt.includes('next step')) return 'Add a lock to the door.'
    if (prompt.includes('got stuck')) return 'problem: The build hit a wall\ntried1: A\ntried2: B\nproposal: Try again'
    if (prompt.includes('clarifying question')) return 'READY'
    return 'READY'
  }
  return { fn, calls }
}

// Controller writes .cynco-plan.md / .cynco-state.md into process.cwd() and
// scanProject() walks it — every test MUST run inside an empty temp dir.
const prevCwd = process.cwd()
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-int-'))
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
})

// ─── Timeout ────────────────────────────────────────────────────

describe('sideQuery timeout', () => {
  it('falls back to the generic question instead of hanging forever', async () => {
    const events: any[] = []
    const { loop } = fakeLoop()
    const hangingSideQuery = () => new Promise<string>(() => { /* never resolves */ })
    const ctrl = new VibeController({
      emit: (e) => events.push(e),
      sideQuery: hangingSideQuery,
      loop,
      timeoutMs: 50,
    })

    await ctrl.start('new')                    // empty dir: no sideQuery needed
    events.length = 0
    const started = Date.now()
    await ctrl.handleAnswer('q-1', 'B')        // short pick → generateQuestion → hang → timeout
    expect(Date.now() - started).toBeLessThan(2000)

    const fallback = events.find(e => e.type === 'vibe.question')
    expect(fallback).toBeDefined()
    expect(fallback.text).toContain('Can you tell me more')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/vibe/controllerIntegration.test.ts`
Expected: FAIL — the test times out (vitest default 5s) or hangs, because nothing rejects the hanging promise. (If vitest reports a timeout rather than an assertion failure, that IS the expected failure mode.)

- [ ] **Step 3: Implement the timeout wrapper**

In `engine/vibe/controller.ts`:

Add to `VibeControllerOptions` (line ~41):

```typescript
export type VibeControllerOptions = {
  emit: (event: VibeEvent | Record<string, unknown>) => void
  sideQuery: (prompt: string) => Promise<string>
  loop: ConversationLoop
  /** Max wait for any single sideQuery before rejecting into the call site's fallback. Default 120s. */
  timeoutMs?: number
}
```

Add this module-level helper above the class:

```typescript
/** Reject a sideQuery that exceeds ms — call sites all have catch fallbacks. */
async function sideQueryWithTimeout(
  fn: (prompt: string) => Promise<string>,
  prompt: string,
  ms: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(prompt),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sideQuery timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
```

In the constructor (line ~60), replace `this.sideQuery = opts.sideQuery` with:

```typescript
    const timeoutMs = opts.timeoutMs ?? 120_000
    this.sideQuery = (prompt) => sideQueryWithTimeout(opts.sideQuery, prompt, timeoutMs)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/vibe/controllerIntegration.test.ts`
Expected: PASS

- [ ] **Step 5: Pass the configured timeout from main.ts**

In `engine/main.ts` `getOrCreateVibeController()`, add after the `loop,` line of the `new VibeController({...})` options:

```typescript
      timeoutMs: config.timeout,
```

- [ ] **Step 6: Commit**

```bash
cd /c/Users/civer/localcode
git add engine/vibe/controller.ts engine/main.ts engine/__tests__/vibe/controllerIntegration.test.ts
git commit -m "fix: timeout on vibe sideQuery — degrade to fallbacks instead of hanging

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Controller-chain integration tests (fake loop + scripted sideQuery)

**Problem:** The only engine-side vibe integration test is 13 lines. Nothing covers start → Q&A → build delegation → report → escalation. These tests use the Task 2 harness — no model, no network, CI-safe.

**Files:**
- Modify: `engine/__tests__/vibe/controllerIntegration.test.ts` (extend)

- [ ] **Step 1: Add the integration tests**

Append to `engine/__tests__/vibe/controllerIntegration.test.ts`:

```typescript
// ─── Full chain ─────────────────────────────────────────────────

describe('VibeController chain', () => {
  it('start in an empty dir transitions idle→understand and asks the opening question', async () => {
    const events: any[] = []
    const { loop } = fakeLoop()
    const { fn } = scriptedSideQuery()
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')

    const transition = events.find(e => e.type === 'vibe.state_changed')
    expect(transition).toMatchObject({ fromState: 'idle', to: 'understand' })
    const q = events.find(e => e.type === 'vibe.question')
    expect(q.text).toContain('What would you like to build')
    expect(ctrl.state).toBe('understand')
  })

  it('a substantive answer triggers BUILD: delegation, handoff files, verification, report', async () => {
    const events: any[] = []
    const { loop, calls } = fakeLoop()
    const { fn } = scriptedSideQuery()
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')
    await ctrl.handleAnswer('q-1', 'Build a hello world python script that prints hello')

    // BUILD delegated exactly once, with the build-prompt contract
    expect(calls.handleUserMessage).toHaveLength(1)
    expect(calls.handleUserMessage[0]).toContain('Build the following')
    // Approvals: on for the session, re-asserted for build, off after
    expect(calls.setApproveAll[calls.setApproveAll.length - 1]).toBe(false)
    expect(calls.setApproveAll).toContain(true)
    // Goal verification passed → pleasure signal
    expect(calls.verifications).toEqual([true])
    // State machine reached build then report
    const states = events.filter(e => e.type === 'vibe.state_changed').map(e => e.to)
    expect(states).toContain('build')
    expect(states).toContain('report')
    // Report carries buildHandoff().files_modified — the uncertain contract
    const report = events.find(e => e.type === 'vibe.task_complete')
    expect(report.filesChanged).toEqual(['hello.py'])
    expect(report.analogy).toContain('Think of it like')
    expect(report.suggestion).toBe('Add a lock to the door.')
    // State file persisted for cross-session continuity
    expect(fs.existsSync(path.join(tmpDir, '.cynco-state.md'))).toBe(true)
  })

  it('short picks continue Q&A with confidence updates until READY', async () => {
    const events: any[] = []
    const { loop, calls } = fakeLoop()
    let questionCalls = 0
    const { fn } = scriptedSideQuery({
      'clarifying question': () => {
        questionCalls++
        return questionCalls === 1
          ? 'What color should it be?\nA) Red\nB) Blue'
          : 'READY'
      },
    })
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')
    await ctrl.handleAnswer('q-1', 'A')   // short pick → LLM question comes back

    const q = events.find(e => e.type === 'vibe.question' && e.text.includes('What color'))
    expect(q).toBeDefined()
    expect(q.options).toEqual(['Red', 'Blue', 'Something else (type below)'])
    expect(events.some(e => e.type === 'vibe.confidence_update')).toBe(true)
    expect(calls.handleUserMessage).toHaveLength(0)   // still understanding

    await ctrl.handleAnswer(q.questionId, 'B')        // → READY → build
    expect(calls.handleUserMessage).toHaveLength(1)
  })

  it('stuck governance escalates; escalation_response fix re-builds', async () => {
    const events: any[] = []
    const { loop, calls } = fakeLoop({ getGovernanceReport: () => ({ stuckTurns: 3 }) })
    const { fn } = scriptedSideQuery()
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')
    await ctrl.handleAnswer('q-1', 'Build a hello world python script that prints hello')

    const esc = events.find(e => e.type === 'vibe.escalation')
    expect(esc).toBeDefined()
    expect(esc.problem).toBe('The build hit a wall')
    expect(esc.tried).toEqual(['A', 'B'])
    expect(esc.requestId).toMatch(/^esc-/)
    expect(events.some(e => e.type === 'vibe.task_complete')).toBe(false)

    const buildsBefore = calls.handleUserMessage.length
    await ctrl.handleEscalationResponse(esc.requestId, 'fix')
    expect(calls.handleUserMessage.length).toBeGreaterThan(buildsBefore)
  })

  it('verification FAIL steers a fix build and reports a pain signal', async () => {
    const events: any[] = []
    const { loop, calls } = fakeLoop()
    const { fn } = scriptedSideQuery({ 'Verify 3 levels': 'FAIL: hello.py never prints' })
    const ctrl = new VibeController({ emit: (e) => events.push(e), sideQuery: fn, loop })

    await ctrl.start('new')
    await ctrl.handleAnswer('q-1', 'Build a hello world python script that prints hello')

    expect(calls.verifications).toEqual([false])
    // Build + steered fix build
    expect(calls.handleUserMessage).toHaveLength(2)
    expect(calls.handleUserMessage[1]).toContain('VERIFICATION FAILED')
  })
})
```

Note for the implementer: `scriptedSideQuery` and `fakeLoop` come from Task 2's harness in the same file. `fs`, `path`, `tmpDir` are already imported/defined there.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run engine/__tests__/vibe/controllerIntegration.test.ts`
Expected: PASS. **If any test fails, that is a real product bug this task exists to catch** — apply superpowers:systematic-debugging, fix minimally in `engine/vibe/controller.ts` (or wherever the root cause is), and record what rotted in the commit message. Do NOT weaken assertions to make tests pass; the assertions encode the spec.

- [ ] **Step 3: Run the full vibe suite**

Run: `npx vitest run engine/__tests__/vibe/`
Expected: PASS (sideQueryRouting + controllerIntegration + confidence + engine)

- [ ] **Step 4: Commit**

```bash
cd /c/Users/civer/localcode
git add engine/__tests__/vibe/controllerIntegration.test.ts
git commit -m "test: vibe controller chain integration coverage (Q&A, build, report, escalation)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: vibeMode suppression regression test (real loop, gated)

**Problem:** `stream.token` suppression in vibe mode (`conversationLoop.ts:1726`) has no test — it silently rotted once already. Design intent (amended spec): `stream.token` is suppressed; `tool.start`/`tool.complete` intentionally still flow (the TUI renders them as activity lines + worker animation).

**Files:**
- Test: `engine/__tests__/vibe/vibeModeSuppression.test.ts` (new)

- [ ] **Step 1: Write the test**

Create `engine/__tests__/vibe/vibeModeSuppression.test.ts`. The harness (defaultConfig/mockProvider/textResponse) is copied from `engine/__tests__/tools/conversationLoop.test.ts:12-66` — same CYNCO_INTEGRATION gate, because real ConversationLoop message handling touches the filesystem:

```typescript
// engine/__tests__/vibe/vibeModeSuppression.test.ts
// Regression guard: in vibe mode the raw token stream is suppressed
// (the TUI shows plain-language reports instead), but the loop still
// completes messages normally. Gated like other real-loop tests:
//   CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vibe/vibeModeSuppression.test.ts
import { describe, expect, it } from 'bun:test'

const SKIP = !process.env.CYNCO_INTEGRATION

import { ConversationLoop } from '../../bridge/conversationLoop.js'
import type { Provider, ModelCapabilities, CompletionRequest } from '../../provider.js'
import type { StreamEvent } from '../../types.js'
import type { LocalCodeConfig } from '../../config.js'

function defaultConfig(): LocalCodeConfig {
  return {
    baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto',
    temperature: 0.7, maxOutputTokens: 8192, timeout: 120000,
    contextLength: 131072, tools: undefined, noScouts: true,
  }
}

function defaultCapabilities(): ModelCapabilities {
  return {
    tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false,
    jsonMode: true, contextLength: 32768, streaming: true,
  }
}

function mockProvider(responses: Array<() => Generator<StreamEvent>>): Provider {
  let callIdx = 0
  return {
    name: 'mock',
    async healthCheck() { return true },
    async listModels() { return [] },
    async probeCapabilities(): Promise<ModelCapabilities> { return defaultCapabilities() },
    async complete() { throw new Error('not implemented') },
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const gen = responses[callIdx++]
      if (gen) yield* gen()
    },
  }
}

function* textResponse(text: string): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

// Read of a nonexistent file: executes without approval, emits
// tool.start + tool.complete (isError) — same pattern as
// engine/__tests__/tools/conversationLoop.test.ts:315.
function* readToolUse(): Generator<StreamEvent> {
  yield { type: 'message_start', message: { id: 'msg1', model: 'test', usage: { input_tokens: 10, output_tokens: 0 } } } as any
  yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } as any
  yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"C:/nonexistent-vibe-test.txt"}' } } as any
  yield { type: 'content_block_stop', index: 0 } as any
  yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } as any
  yield { type: 'message_stop' } as any
}

describe('vibe mode event suppression', () => {
  it.skipIf(SKIP)('suppresses stream.token but still completes the message', async () => {
    const events: any[] = []
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider: mockProvider([() => textResponse('Built it.')]),
      emit: (e) => events.push(e),
    })
    loop.setVibeMode(true)
    await loop.handleUserMessage('build something')

    expect(events.some(e => e.type === 'stream.token')).toBe(false)
    expect(events.some(e => e.type === 'message.complete')).toBe(true)
  })

  it.skipIf(SKIP)('tool.start/tool.complete still flow in vibe mode (TUI activity lines)', async () => {
    // Amended spec: tool events intentionally reach the TUI in vibe mode —
    // app.py:228-263 renders them as plain-language activity + worker animation.
    const events: any[] = []
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider: mockProvider([() => readToolUse(), () => textResponse('Done.')]),
      emit: (e) => events.push(e),
    })
    loop.setVibeMode(true)
    await loop.handleUserMessage('build something')

    expect(events.some(e => e.type === 'tool.start' && e.toolName === 'Read')).toBe(true)
    expect(events.some(e => e.type === 'tool.complete' && e.toolName === 'Read')).toBe(true)
    expect(events.some(e => e.type === 'stream.token')).toBe(false)
  })

  it.skipIf(SKIP)('normal mode still streams tokens (control)', async () => {
    const events: any[] = []
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider: mockProvider([() => textResponse('Hello!')]),
      emit: (e) => events.push(e),
    })
    await loop.handleUserMessage('hi')

    expect(events.some(e => e.type === 'stream.token')).toBe(true)
  })

  it('setVibeMode toggles the isVibeMode getter', () => {
    const loop = new ConversationLoop({
      config: defaultConfig(),
      provider: mockProvider([]),
      emit: () => {},
    })
    expect(loop.isVibeMode).toBe(false)
    loop.setVibeMode(true)
    expect(loop.isVibeMode).toBe(true)
  })
})
```

- [ ] **Step 2: Run gated and ungated**

Run: `npx vitest run engine/__tests__/vibe/vibeModeSuppression.test.ts`
Expected: PASS (3 skipped, 1 passed)

Run: `CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vibe/vibeModeSuppression.test.ts`
Expected: PASS (4 passed). If the suppression assertion fails, the guard at `conversationLoop.ts:1726` has rotted — restore `if (!this.vibeMode)` around the `stream.token` emit. If the tool-event assertions fail, someone gated tool.start/tool.complete on vibeMode — remove that gate (the TUI needs them for activity lines).

- [ ] **Step 3: Commit**

```bash
cd /c/Users/civer/localcode
git add engine/__tests__/vibe/vibeModeSuppression.test.ts
git commit -m "test: regression guard for vibe-mode stream.token suppression

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Serialize TUI escalation dialogs

**Problem:** `tui/localcode_tui/app.py:434-450` (`_handle_vibe_escalation`) fires `asyncio.ensure_future` per event with `push_screen_wait` — two rapid escalations push two modal dialogs concurrently and the responses can interleave. Serialize with an `asyncio.Lock`.

**Files:**
- Modify: `tui/localcode_tui/app.py` (`__init__` + `_handle_vibe_escalation`)
- Test: `tui/tests/test_vibe_integration.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tui/tests/test_vibe_integration.py` (match the file's existing import style at the top; add `import asyncio` if absent). Before writing, confirm the attribute that stores `request_id` on `EscalationDialog` by reading `tui/localcode_tui/widgets/escalation_dialog.py` — the test below assumes `dialog.request_id`; adjust the attribute read if it differs:

```python
def test_escalation_dialogs_are_serialized(monkeypatch):
    """Two rapid vibe.escalation events must show dialogs one at a time, in order."""
    import asyncio
    from localcode_tui.app import LocalCodeApp
    from localcode_tui.protocol import VibeEscalationEvent

    app = LocalCodeApp.__new__(LocalCodeApp)  # bypass full Textual init
    app._vibe_escalation_lock = asyncio.Lock()

    active = {"count": 0, "max": 0}
    shown = []
    sent = []

    async def fake_push_screen_wait(dialog):
        active["count"] += 1
        active["max"] = max(active["max"], active["count"])
        await asyncio.sleep(0.01)  # simulate the user thinking
        active["count"] -= 1
        shown.append(dialog.request_id)
        return "skip"

    monkeypatch.setattr(app, "push_screen_wait", fake_push_screen_wait, raising=False)
    monkeypatch.setattr(app, "send_command", lambda cmd: sent.append(cmd), raising=False)

    async def run():
        e1 = VibeEscalationEvent(problem="p1", tried=[], proposal="", request_id="r1")
        e2 = VibeEscalationEvent(problem="p2", tried=[], proposal="", request_id="r2")
        app._handle_vibe_escalation(e1)
        app._handle_vibe_escalation(e2)
        await asyncio.sleep(0.2)

    asyncio.run(run())

    assert active["max"] == 1, "two escalation dialogs were on screen at once"
    assert shown == ["r1", "r2"]
    assert [c.request_id for c in sent] == ["r1", "r2"]
```

Note: if `VibeEscalationEvent` construction requires different field names, read the dataclass in `tui/localcode_tui/protocol.py` and match it — `app.py:436-441` uses `event.problem/tried/proposal/request_id`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tui && python -m pytest tests/test_vibe_integration.py::test_escalation_dialogs_are_serialized -v && cd /c/Users/civer/localcode`
Expected: FAIL — `active["max"] == 2` (both dialogs pushed concurrently)

- [ ] **Step 3: Implement the lock**

In `tui/localcode_tui/app.py`:

(a) In `LocalCodeApp.__init__`, add alongside the other attribute initializations:

```python
        self._vibe_escalation_lock = asyncio.Lock()
```

(b) Replace `_handle_vibe_escalation` (lines ~434-450) with:

```python
    def _handle_vibe_escalation(self, event: VibeEscalationEvent) -> None:
        async def handle():
            # Serialize dialogs — concurrent push_screen_wait calls race
            async with self._vibe_escalation_lock:
                from .widgets.escalation_dialog import EscalationDialog
                dialog = EscalationDialog(
                    problem=event.problem,
                    tried=event.tried,
                    proposal=event.proposal,
                    request_id=event.request_id,
                )
                action = await self.push_screen_wait(dialog)
                from .protocol import VibeEscalationResponseCommand
                cmd = VibeEscalationResponseCommand(
                    request_id=event.request_id,
                    action=action or "skip",
                )
                self.send_command(cmd)
        asyncio.ensure_future(handle())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tui && python -m pytest tests/test_vibe_integration.py -v && cd /c/Users/civer/localcode`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
cd /c/Users/civer/localcode
git add tui/localcode_tui/app.py tui/tests/test_vibe_integration.py
git commit -m "fix: serialize vibe escalation dialogs — concurrent push_screen_wait raced

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Live E2E script

**Problem:** Nothing exercises the real chain (WS protocol → main.ts routing → controller → real model → real build). This script plays the TUI role against a freshly spawned headless engine in a temp directory. It is a manual smoke tool, not CI.

**Files:**
- Create: `scripts/vibe-e2e.ts`

- [ ] **Step 1: Write the script**

Create `scripts/vibe-e2e.ts`:

```typescript
// scripts/vibe-e2e.ts — manual E2E smoke test for the vibe loop.
//
// Spawns a headless engine in a temp directory, connects as a fake TUI over
// WebSocket, drives: vibe.start → answer → BUILD → vibe.task_complete, then
// verifies the requested file actually exists on disk.
//
// Usage:   bun scripts/vibe-e2e.ts
// Env:     inherits your normal engine env (LOCALCODE_MODEL, provider config).
//          LOCALCODE_WS_PORT is forced to 9260 to avoid clashing with a dev engine.
// Requires: the model backend (llama-server or Ollama) reachable per your config.
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const WS_PORT = 9260
const TASK = 'Create a file named hello.txt containing exactly the text: hello world'
const STARTUP_TIMEOUT_MS = 3 * 60_000   // model load can take a while
const TASK_TIMEOUT_MS = 15 * 60_000

const repoRoot = resolve(import.meta.dir, '..')
const workDir = mkdtempSync(join(tmpdir(), 'vibe-e2e-'))
console.log(`[e2e] Workdir: ${workDir}`)

const engine = Bun.spawn(['bun', join(repoRoot, 'engine', 'main.ts')], {
  cwd: workDir,
  env: { ...process.env, LOCALCODE_WS_PORT: String(WS_PORT) },
  stdout: 'inherit',
  stderr: 'inherit',
})

function cleanup() {
  try { engine.kill() } catch {}
}

function fail(msg: string): never {
  console.error(`\n[e2e] FAIL: ${msg}`)
  cleanup()
  process.exit(1)
}

async function connect(): Promise<WebSocket> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`)
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res()
        ws.onerror = () => rej(new Error('connect failed'))
      })
      return ws
    } catch {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  fail('engine WS never came up')
}

const ws = await connect()
console.log('[e2e] Connected — starting vibe loop')

let answeredDirective = false
const done = new Promise<void>((res) => {
  ws.onmessage = (msg) => {
    let event: any
    try { event = JSON.parse(String(msg.data)) } catch { return }
    if (typeof event?.type !== 'string' || !event.type.startsWith('vibe.')) return
    const preview = event.text ?? event.problem ?? event.analogy ?? ''
    console.log(`[e2e] <- ${event.type}${preview ? `: ${String(preview).slice(0, 100)}` : ''}`)

    if (event.type === 'vibe.question' && !answeredDirective) {
      answeredDirective = true
      ws.send(JSON.stringify({ type: 'vibe.answer', questionId: event.questionId, answer: TASK }))
      console.log('[e2e] -> vibe.answer (substantive directive — should go straight to BUILD)')
    } else if (event.type === 'vibe.question') {
      ws.send(JSON.stringify({ type: 'vibe.answer', questionId: event.questionId, answer: 'A' }))
      console.log('[e2e] -> vibe.answer (A)')
    } else if (event.type === 'vibe.escalation') {
      fail(`escalated: ${event.problem}`)
    } else if (event.type === 'vibe.task_complete') {
      res()
    }
  }
})

ws.send(JSON.stringify({ type: 'vibe.start', mode: 'new', description: TASK }))
console.log('[e2e] -> vibe.start')

const timer = setTimeout(
  () => fail(`no vibe.task_complete within ${TASK_TIMEOUT_MS / 60_000} min`),
  TASK_TIMEOUT_MS,
)
await done
clearTimeout(timer)

const target = join(workDir, 'hello.txt')
if (!existsSync(target)) fail(`vibe.task_complete arrived but hello.txt was not created in ${workDir}`)
const content = readFileSync(target, 'utf-8')
if (!content.toLowerCase().includes('hello world')) {
  fail(`hello.txt content wrong: "${content.slice(0, 100)}"`)
}

console.log('\n[e2e] PASS — vibe loop built the file end-to-end')
cleanup()
try { rmSync(workDir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
process.exit(0)
```

- [ ] **Step 2: Syntax check only (no live run yet)**

Run: `bun build --no-bundle scripts/vibe-e2e.ts > /dev/null 2>&1 || bun -e "await import('./scripts/vibe-e2e.ts')" --dry-run 2>&1 | head -5`
If neither works cleanly, a plain `bun scripts/vibe-e2e.ts` started and immediately Ctrl-C'd (or reviewing for syntax with `npx tsc --noEmit scripts/vibe-e2e.ts`) is acceptable — the real validation is Task 7.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/civer/localcode
git add scripts/vibe-e2e.ts
git commit -m "feat: manual E2E smoke script driving the vibe loop over WebSocket

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Live E2E run — fix whatever the last 70 commits broke

**This task is exploratory by design.** The controller (this session's main agent, NOT a subagent) runs it, because it needs the real model, real ports, and judgment.

- [ ] **Step 1: Pre-flight**

- Verify the model backend is up per the user's config (llama-server default `http://127.0.0.1:8081/health` — beware: the dndai project sometimes steals :8081).
- Verify no zombie engines: check nothing is listening on 9260 (`netstat -ano | grep 9260`). Kill stale `bun` engine processes if found — never reuse them.

- [ ] **Step 2: Run**

Run: `bun scripts/vibe-e2e.ts` (in background; expect several minutes — model load + Q&A sideQueries + build turns).

- [ ] **Step 3: Diagnose and fix failures**

Expected failure classes and where to look:
- WS never up → engine crash on boot: read engine stdout (inherited).
- No `vibe.question` after start → controller/start path; check `[vibe]` log lines.
- sideQuery errors → Task 1 regression or backend port mismatch (`config.port`).
- Build runs but no `vibe.task_complete` → `executeBuild`/`generateCompletionReport`; check `getGovernanceReport().stuckTurns` and verification sideQuery.
- `hello.txt` missing despite task_complete → buildHandoff contract or the model built in the wrong cwd (check `setCwd` interactions).

Apply superpowers:systematic-debugging for every failure: root cause first, minimal fix, add a regression test to `engine/__tests__/vibe/` when the bug is testable without a model, commit each fix separately.

- [ ] **Step 4: Re-run until PASS**

Exit criterion: `[e2e] PASS — vibe loop built the file end-to-end`.

- [ ] **Step 5: Commit any fixes**

```bash
cd /c/Users/civer/localcode
git add <fixed files>
git commit -m "fix: <root cause found by live vibe E2E>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Wire check + full suites

- [ ] **Step 1: Wire check (BLOCKING)**

Every new symbol must be imported/called somewhere real:

```bash
cd /c/Users/civer/localcode
grep -rn "runSideQuery" engine --include="*.ts" | grep -v __tests__
# expect: definition in bridge/conversationLoop.ts + calls in main.ts (vibe + wizard)
grep -rn "timeoutMs" engine/vibe engine/main.ts
# expect: option in vibe/controller.ts + passed in main.ts
grep -rn "_vibe_escalation_lock" tui/localcode_tui
# expect: init in app.py __init__ + use in _handle_vibe_escalation
grep -rn "sideQueryWithTimeout" engine/vibe
# expect: definition + call in controller.ts constructor
```

If any symbol is defined but never called outside tests, STOP — wire it or remove it before proceeding.

- [ ] **Step 2: Full engine suite**

Run: `npx vitest run`
Expected: 0 failures (skips OK)

- [ ] **Step 3: Gated vibe integration**

Run: `CYNCO_INTEGRATION=1 npx vitest run engine/__tests__/vibe/`
Expected: 0 failures

- [ ] **Step 4: Full TUI suite**

Run: `cd tui && python -m pytest tests/ && cd /c/Users/civer/localcode`
Expected: 0 failures

- [ ] **Step 5: Commit the plan checkboxes and any stragglers**

```bash
cd /c/Users/civer/localcode
git add -f docs/superpowers/plans/2026-07-04-vibe-harden.md
git add -u
git commit -m "docs: check off vibe-harden plan tasks

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## After all tasks

Finish via superpowers:finishing-a-development-branch with the user's standing GitHub web flow: push `vibe-harden` → `gh pr create` → merge on GitHub → `git checkout main && git pull`. Then PR 2 (`vibe-modes`) branches from the updated main.
