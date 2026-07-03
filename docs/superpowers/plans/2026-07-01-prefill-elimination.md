# Prefill Elimination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate per-turn full re-prefill (25-30K tokens) by enabling llama.cpp context checkpoints for Qwen3.6's hybrid DeltaNet architecture and making the engine's prompt strictly append-only.

**Architecture:** Two layers. (1) Serving: new `buildServerArgs()` defaults — `--ctx-checkpoints 64 --checkpoint-min-step 1024 --ubatch-size 2048`, and `--cache-ram` restored to llama.cpp's default. (2) Engine: fix the prompt-prefix mutators (first-turn system extras, governance system-prompt rewrite, tool-prompt determinism) and lock everything with a prefix-stability regression test. Verify end-to-end with `benchAgentic.ts` TTFT slope (>80% drop gate).

**Tech Stack:** TypeScript (Bun runtime), vitest (via `npx vitest run` — `bun test` segfaults on this machine), llama.cpp llama-server, existing benchmark harness in `benchmark/true/`.

**Spec:** `docs/superpowers/specs/2026-07-01-prefill-elimination-design.md`

**Spec amendments (verified against code before planning):**
1. Spec §2.3 (compressor replace-don't-append): `ContextCompressor.compressMessages` (engine/context/compressor.ts:121-126) **already replaces** — returns `[summary, ...recent]`. Task 7 is a locking test only, no code change.
2. New mutator found: `callModel.ts` appends handoff (line 286) and recalled memories (line 322) to the system prompt **on turn 1 only** (`messages.length <= 2`), so turn 2's system prompt differs from turn 1's — invalidating the cache at the earliest byte. Task 5 fixes this with a per-conversation extras cache. This is squarely inside the spec's approved goal (append-only discipline).

**Branch:** create `prefill-elimination` from `grounding-trigger` (the bench tools live there).

```bash
git checkout grounding-trigger && git checkout -b prefill-elimination
```

**Environment notes:**
- Run TS tests with `npx vitest run <file>` from repo root. NEVER `bun test` (segfaults).
- Tasks 1 and 10 need the GPU + model. All other tasks are pure code/tests.
- `engine/` contains an embedded git repo — never run git with cwd inside `engine/`.

---

### Task 1: Baseline TTFT measurement (BEFORE any code changes)

**Files:**
- Create: `benchmark/true/results/prefill-baseline.summary.txt` (copy of run output)

The >80% slope-drop gate in Task 10 needs a baseline captured on **current** flags. Do this before touching any code.

- [ ] **Step 1: Run the agentic bench on current defaults**

Run: `bun benchmark/true/benchAgentic.ts --sessions 2`
Expected: completes 2 sessions × 12 turns; writes `benchmark/true/results/benchagentic-<ts>.summary.txt` containing per-turn TTFT, decode tok/s, and a `ttft slope` line. This boots llama-server itself; allow 15+ minutes.

- [ ] **Step 2: Preserve the baseline**

```bash
cp "$(ls -t benchmark/true/results/benchagentic-*.summary.txt | head -1)" benchmark/true/results/prefill-baseline.summary.txt
```

Record the baseline TTFT slope number (ms per 1K prompt tokens) — Task 10 compares against it.

- [ ] **Step 3: Commit**

```bash
git add -f benchmark/true/results/prefill-baseline.summary.txt
git commit -m "bench: capture prefill TTFT baseline before checkpoint-caching work"
```

---

### Task 2: Serving flags in buildServerArgs

**Files:**
- Modify: `engine/llama/processManager.ts:5-18` (ServerConfig), `:23-67` (buildServerArgs), `:69-82` (ProcessManagerConfig)
- Test: `engine/__tests__/llama/processManager.test.ts`
- Test (update): `engine/__tests__/integration/ultrareviewFixes.test.ts:184-222`

- [ ] **Step 1: Write failing tests**

Append to `engine/__tests__/llama/processManager.test.ts` (inside the top-level `describe('buildServerArgs')` or as a new describe; the file already defines `argValue`):

```ts
describe('buildServerArgs — checkpoint caching (prefill elimination)', () => {
  const base = { modelPath: '/models/qwen.gguf', port: 8081 }

  it('adds checkpoint and ubatch defaults', () => {
    const args = buildServerArgs(base)
    expect(argValue(args, '--ctx-checkpoints')).toBe('64')
    expect(argValue(args, '--checkpoint-min-step')).toBe('1024')
    expect(argValue(args, '--ubatch-size')).toBe('2048')
  })

  it('omits --cache-ram by default so the llama.cpp default applies', () => {
    delete process.env.LOCALCODE_CACHE_RAM
    const args = buildServerArgs(base)
    expect(args).not.toContain('--cache-ram')
  })

  it('honors explicit cacheRam config', () => {
    const args = buildServerArgs({ ...base, cacheRam: 4096 })
    expect(argValue(args, '--cache-ram')).toBe('4096')
  })

  it('honors LOCALCODE_CACHE_RAM env when config unset', () => {
    process.env.LOCALCODE_CACHE_RAM = '2048'
    const args = buildServerArgs(base)
    expect(argValue(args, '--cache-ram')).toBe('2048')
    delete process.env.LOCALCODE_CACHE_RAM
  })

  it('honors config overrides for checkpoint/ubatch flags', () => {
    const args = buildServerArgs({ ...base, ctxCheckpoints: 128, checkpointMinStep: 512, ubatchSize: 1024 })
    expect(argValue(args, '--ctx-checkpoints')).toBe('128')
    expect(argValue(args, '--checkpoint-min-step')).toBe('512')
    expect(argValue(args, '--ubatch-size')).toBe('1024')
  })

  it('honors env overrides for checkpoint/ubatch flags', () => {
    process.env.LOCALCODE_CTX_CHECKPOINTS = '32'
    process.env.LOCALCODE_CHECKPOINT_MIN_STEP = '2048'
    process.env.LOCALCODE_UBATCH_SIZE = '512'
    const args = buildServerArgs(base)
    expect(argValue(args, '--ctx-checkpoints')).toBe('32')
    expect(argValue(args, '--checkpoint-min-step')).toBe('2048')
    expect(argValue(args, '--ubatch-size')).toBe('512')
    delete process.env.LOCALCODE_CTX_CHECKPOINTS
    delete process.env.LOCALCODE_CHECKPOINT_MIN_STEP
    delete process.env.LOCALCODE_UBATCH_SIZE
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run engine/__tests__/llama/processManager.test.ts`
Expected: the 6 new tests FAIL (`--ctx-checkpoints` not found, `--cache-ram` present). Pre-existing tests asserting the old cache-ram `'0'` default (lines ~118-131, ~165-183) still pass for now.

- [ ] **Step 3: Implement**

In `engine/llama/processManager.ts`, add three fields to BOTH `ServerConfig` and `ProcessManagerConfig` (after `reasoningBudget?: number`):

```ts
  ctxCheckpoints?: number
  checkpointMinStep?: number
  ubatchSize?: number
```

In `buildServerArgs`, after the `--batch-size` entry in the initial `args` array (line 30), add:

```ts
    '--ubatch-size', String(config.ubatchSize ?? envInt('LOCALCODE_UBATCH_SIZE') ?? 2048),
```

Add this helper above `buildServerArgs`:

```ts
function envInt(name: string): number | undefined {
  const v = process.env[name]
  return v != null && v !== '' ? parseInt(v, 10) : undefined
}
```

Replace the cache-ram block (lines 50-57) with:

```ts
  // Qwen3.6 is a hybrid Gated DeltaNet + attention model. llama.cpp context
  // checkpoints snapshot recurrent state during prefill so warm turns roll
  // back to the nearest checkpoint instead of re-prefilling from token 0
  // (ggml-org/llama.cpp#21831). This needs the host-memory prompt cache, so
  // --cache-ram is left at the server default unless explicitly overridden.
  // NOTE: prefix reuse also requires the client prompt to be strictly
  // append-only — see engine/__tests__/engine/prefixStability.test.ts.
  const cacheRam = config.cacheRam != null
    ? String(config.cacheRam)
    : process.env.LOCALCODE_CACHE_RAM
  if (cacheRam != null && cacheRam !== '') {
    args.push('--cache-ram', cacheRam)
  }
  args.push('--ctx-checkpoints', String(config.ctxCheckpoints ?? envInt('LOCALCODE_CTX_CHECKPOINTS') ?? 64))
  args.push('--checkpoint-min-step', String(config.checkpointMinStep ?? envInt('LOCALCODE_CHECKPOINT_MIN_STEP') ?? 1024))
```

- [ ] **Step 4: Update pre-existing tests that assert the old default**

Two files assert `--cache-ram` defaults to `'0'` when env is unset. Update them to assert the flag is now **absent** by default:

- `engine/__tests__/llama/processManager.test.ts:118-131` — test `'defaults cache-ram to 0 and reasoning-budget to 256 when env unset'`: change the cache-ram assertions to `expect(args).not.toContain('--cache-ram')`; keep the reasoning-budget `'256'` assertion. Rename the test to `'omits cache-ram and defaults reasoning-budget to 256 when env unset'`.
- Same change in `engine/__tests__/llama/processManager.test.ts:165-183` where `cacheRam: 0` is passed explicitly — passing `cacheRam: 0` must still emit `--cache-ram 0` (explicit override), so that assertion STAYS. Only the env-unset default assertions change.
- `engine/__tests__/integration/ultrareviewFixes.test.ts:214-222` — same transformation: env-unset default now means no `--cache-ram` flag.

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run engine/__tests__/llama/processManager.test.ts engine/__tests__/integration/ultrareviewFixes.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add engine/llama/processManager.ts engine/__tests__/llama/processManager.test.ts engine/__tests__/integration/ultrareviewFixes.test.ts
git commit -m "feat: context checkpoints + ubatch defaults, cache-ram restored to llama.cpp default"
```

---

### Task 3: Config plumbing (profile runtime keys + bootstrap wiring)

**Files:**
- Modify: `engine/config.ts:25-33` (RuntimeConfig), `:122-134` (profile mapping)
- Modify: `engine/bootstrapProvider.ts:88-103` (ProcessManager construction)
- Test: `engine/__tests__/config.test.ts` (existing runtime-mapping test around line 244)

- [ ] **Step 1: Write failing test**

In `engine/__tests__/config.test.ts`, find the existing test that asserts the runtime mapping (it currently checks `specType: 'mtp', specDraftN: 3, cacheRam: 0, reasoningBudget: 256` at ~line 244). Locate how that test provides the profile (it stubs a profile object with snake_case `runtime:` keys). Add the three new keys to the stubbed profile:

```ts
ctx_checkpoints: 128,
checkpoint_min_step: 512,
ubatch_size: 1024,
```

and extend the assertion object with:

```ts
ctxCheckpoints: 128, checkpointMinStep: 512, ubatchSize: 1024,
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/config.test.ts`
Expected: FAIL — new keys come back `undefined`.

- [ ] **Step 3: Implement**

`engine/config.ts` — extend `RuntimeConfig`:

```ts
export type RuntimeConfig = {
  specType?: string
  specDraftN?: number
  gpuLayers?: number
  batchSize?: number
  flashAttn?: boolean
  cacheRam?: number
  reasoningBudget?: number
  ctxCheckpoints?: number
  checkpointMinStep?: number
  ubatchSize?: number
}
```

Extend the profile mapping (after `reasoningBudget: pr.reasoning_budget,` at line 132):

```ts
        ctxCheckpoints: pr.ctx_checkpoints,
        checkpointMinStep: pr.checkpoint_min_step,
        ubatchSize: pr.ubatch_size,
```

`engine/bootstrapProvider.ts` — in the `new ProcessManager({...})` call, after `reasoningBudget: rt?.reasoningBudget,` (line 102), add:

```ts
        ctxCheckpoints: rt?.ctxCheckpoints,
        checkpointMinStep: rt?.checkpointMinStep,
        ubatchSize: rt?.ubatchSize,
```

(Env overrides are handled inside `buildServerArgs` via `envInt`, matching the existing cacheRam/reasoningBudget pattern — do NOT duplicate env parsing here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/config.test.ts engine/__tests__/llama/processManager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/config.ts engine/bootstrapProvider.ts engine/__tests__/config.test.ts
git commit -m "feat: plumb ctx_checkpoints/checkpoint_min_step/ubatch_size through profile runtime config"
```

---

### Task 4: Tool-prompt memoization (byte-identity guarantee)

**Files:**
- Modify: `engine/ollama/simulated.ts:18` (buildSimulatedToolPrompt)
- Test: Create `engine/__tests__/ollama/simulatedMemo.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// engine/__tests__/ollama/simulatedMemo.test.ts
import { describe, expect, it } from 'bun:test'
import { buildSimulatedToolPrompt } from '../../ollama/simulated.js'

const toolA = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
} as any
const toolB = {
  name: 'run_shell',
  description: 'Run a command',
  input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
} as any

describe('buildSimulatedToolPrompt memoization', () => {
  it('returns the identical string instance for an unchanged tool set', () => {
    const p1 = buildSimulatedToolPrompt([toolA, toolB])
    const p2 = buildSimulatedToolPrompt([toolA, toolB])
    expect(p1).toBe(p2) // reference identity — byte-identical prefix guaranteed
  })

  it('rebuilds when the tool set changes, then re-caches', () => {
    const p1 = buildSimulatedToolPrompt([toolA, toolB])
    const p2 = buildSimulatedToolPrompt([toolA])
    expect(p2).not.toBe(p1)
    expect(p2).toContain('read_file')
    expect(p2).not.toContain('run_shell')
    const p3 = buildSimulatedToolPrompt([toolA])
    expect(p3).toBe(p2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/ollama/simulatedMemo.test.ts`
Expected: FAIL on `expect(p1).toBe(p2)` (new string each call).

- [ ] **Step 3: Implement**

In `engine/ollama/simulated.ts`, rename the existing exported function body to a private `buildSimulatedToolPromptUncached(tools: ToolDefinition[]): string` (identical body, drop `export`), and add above it:

```ts
// Memoized: the prompt prefix must be byte-identical across turns for
// llama.cpp checkpoint caching. Single-slot cache keyed on tool names —
// the tool set is stable within a conversation; demotion/routing changes
// legitimately rebuild.
let simPromptKey: string | null = null
let simPromptValue: string | null = null

export function buildSimulatedToolPrompt(tools: ToolDefinition[]): string {
  const key = tools.map(t => t.name).join('\u0000')
  if (key === simPromptKey && simPromptValue !== null) return simPromptValue
  simPromptValue = buildSimulatedToolPromptUncached(tools)
  simPromptKey = key
  return simPromptValue
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/__tests__/ollama/simulatedMemo.test.ts`
Expected: PASS (2 tests). Also run any existing simulated tests: `npx vitest run engine/__tests__ --testNamePattern simulated` — expect no regressions.

- [ ] **Step 5: Commit**

```bash
git add engine/ollama/simulated.ts engine/__tests__/ollama/simulatedMemo.test.ts
git commit -m "feat: memoize simulated tool prompt for byte-identical prompt prefix"
```

---

### Task 5: Session-extras cache (fixes the turn-1-only system mutator)

**Files:**
- Create: `engine/engine/sessionExtras.ts`
- Modify: `engine/engine/callModel.ts:271-332` (steps 7b + 7c)
- Test: Create `engine/__tests__/engine/sessionExtras.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// engine/__tests__/engine/sessionExtras.test.ts
import { beforeEach, describe, expect, it } from 'bun:test'
import { getSessionExtras, resetSessionExtras } from '../../engine/sessionExtras.js'

describe('getSessionExtras', () => {
  beforeEach(() => resetSessionExtras())

  it('computes on first turn and returns the identical value on later turns', async () => {
    let computeCalls = 0
    const compute = async () => { computeCalls++; return '\n\nHANDOFF+MEMORIES' }
    const t1 = await getSessionExtras('fix the bug', true, compute)
    const t2 = await getSessionExtras('fix the bug', false, compute)
    const t3 = await getSessionExtras('fix the bug', false, compute)
    expect(t1).toBe('\n\nHANDOFF+MEMORIES')
    expect(t2).toBe(t1) // byte-identical — prefix stable
    expect(t3).toBe(t1)
    expect(computeCalls).toBe(1)
  })

  it('returns and pins empty string for an unknown mid-conversation key (engine restart)', async () => {
    const t5 = await getSessionExtras('resumed convo', false, async () => 'SHOULD NOT RUN')
    const t6 = await getSessionExtras('resumed convo', false, async () => 'SHOULD NOT RUN')
    expect(t5).toBe('')
    expect(t6).toBe('') // stable from now on
  })

  it('a new conversation recomputes with its own key', async () => {
    await getSessionExtras('convo A', true, async () => 'A-EXTRAS')
    const b = await getSessionExtras('convo B', true, async () => 'B-EXTRAS')
    expect(b).toBe('B-EXTRAS')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/engine/sessionExtras.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the cache module**

```ts
// engine/engine/sessionExtras.ts
// Per-conversation cache for first-turn system-prompt extras (handoff +
// recalled memories). The prompt prefix must be byte-identical across turns
// for llama.cpp checkpoint caching: recomputing OR dropping these sections
// after turn 1 mutates the prefix and forces a full re-prefill every turn.

let cachedKey: string | null = null
let cachedExtras: string | null = null

export function resetSessionExtras(): void {
  cachedKey = null
  cachedExtras = null
}

/**
 * - First turn: computes extras via `compute`, caches them keyed on the
 *   conversation identity (first user message text).
 * - Later turns, same conversation: returns the cached value byte-identically.
 * - Later turns, unknown conversation (engine restarted mid-conversation):
 *   pins '' so the prefix is at least stable from now on.
 */
export async function getSessionExtras(
  key: string,
  isFirstTurn: boolean,
  compute: () => Promise<string>,
): Promise<string> {
  if (cachedKey === key && cachedExtras !== null) return cachedExtras
  cachedExtras = isFirstTurn ? await compute() : ''
  cachedKey = key
  return cachedExtras
}
```

- [ ] **Step 4: Rewire callModel steps 7b/7c**

In `engine/engine/callModel.ts`, replace the whole of steps 7b and 7c (lines 271-332: from `// 7b. Session lifecycle — read ledger on first turn` through the closing `catch` of step 7c) with the block below. The inner logic is the EXISTING code, moved verbatim into the compute closure, with two mechanical changes: appends go to a local `out` string instead of `system`, and the protocol-capture side effects assign to the outer `let`s (they only run on the first turn, preserving current event behavior).

```ts
  // 7b+7c. Session extras (handoff + recalled memories) — computed once per
  // conversation and re-appended byte-identically on every subsequent call so
  // the prompt prefix stays stable for llama.cpp checkpoint caching.
  let sessionContextForProtocol: any = null
  let recalledMemoriesForProtocol: any[] = []
  console.log(`[callModel] Step 7b/7c: session extras (messages=${messages.length})`)
  const { getSessionExtras } = await import('./sessionExtras.js')
  const firstUserMsg = messages.find(m => m.role === 'user')
  const conversationKey = firstUserMsg?.content?.map((b: any) => b.text || '').join(' ') ?? ''
  const extras = await getSessionExtras(conversationKey, messages.length <= 2, async () => {
    let out = ''
    // Handoff (previously step 7b)
    try {
      const { onSessionStart } = await import('../memory/lifecycle.js')
      const os = await import('os')
      const path = await import('path')
      const crypto = await import('crypto')
      const projectHash = crypto.createHash('md5').update(process.cwd()).digest('hex').slice(0, 8)
      const baseDir = path.join(os.homedir(), '.cynco', 'continuity', projectHash)
      const state = await onSessionStart(baseDir, process.cwd().split('/').pop() || 'unknown')
      if (state.recentHandoffs.length > 0) {
        const lastHandoff = state.recentHandoffs[state.recentHandoffs.length - 1]
        const { formatHandoffForPrompt } = await import('../memory/handoff.js')
        out += `\n\n${formatHandoffForPrompt(lastHandoff.handoff)}`
        try {
          const { formatSessionContext } = await import('../bridge/memoryEvents.js')
          const fs = await import('fs')
          let handoffDate = new Date()
          try {
            const stat = fs.statSync(lastHandoff.path)
            handoffDate = stat.mtime
          } catch {}
          const highPriorityThreads = state.ledger.open_threads
            .filter(t => t.priority === 'high' || t.priority === 'medium')
            .slice(0, 5)
          sessionContextForProtocol = formatSessionContext(
            lastHandoff.handoff,
            highPriorityThreads,
            handoffDate,
          )
        } catch {}
      }
    } catch {
      // Lifecycle system unavailable
    }
    // Recalled memories (previously step 7c)
    try {
      const { recallMemories, formatRecalledMemories } = await import('../memory/recall.js')
      const lastUserMsg = messages.filter(m => m.role === 'user').pop()
      const queryText = lastUserMsg?.content?.map((b: any) => b.text || '').join(' ') || ''
      if (queryText) {
        const memories = await recallMemories(queryText, 5)
        const section = formatRecalledMemories(memories)
        if (section) {
          out += '\n\n' + section
        }
        try {
          const { formatRecalledForProtocol } = await import('../bridge/memoryEvents.js')
          recalledMemoriesForProtocol = formatRecalledForProtocol(memories)
        } catch {}
      }
    } catch {
      // Memory system unavailable
    }
    return out
  })
  system += extras
```

IMPORTANT deletions this replaces (verify nothing is left behind):
- The old `let sessionContextForProtocol: any = null` + `if (messages.length <= 2) { ... }` handoff block (old lines 272-309).
- The old `console.log('[callModel] Step 7c: memory recall')` + `let recalledMemoriesForProtocol: any[] = []` + recall block (old lines 311-332). Note the old recall gated on `messages.length <= 2` — the closure only runs on the first turn, so the gate is preserved structurally.
- The `memory_data` yield block (old lines 336-345) stays exactly where it is, unchanged — it reads the two `let`s which are still in scope.

- [ ] **Step 5: Run tests**

Run: `npx vitest run engine/__tests__/engine/sessionExtras.test.ts && npx vitest run engine/__tests__`
Expected: sessionExtras 3/3 PASS; full engine suite green (callModel behavior unchanged for turn 1; turns 2+ now carry identical extras instead of dropping them).

- [ ] **Step 6: Commit**

```bash
git add engine/engine/sessionExtras.ts engine/engine/callModel.ts engine/__tests__/engine/sessionExtras.test.ts
git commit -m "fix: session extras (handoff+memories) stable across turns — was mutating system prompt after turn 1"
```

---

### Task 6: Governance signal as appended message

**Files:**
- Create: `engine/vsm/governanceSignal.ts`
- Modify: `engine/bridge/conversationLoop.ts:1607-1631` and `:1696`
- Test: Create `engine/__tests__/vsm/governanceSignal.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// engine/__tests__/vsm/governanceSignal.test.ts
import { describe, expect, it } from 'bun:test'
import { buildGovernanceSignal } from '../../vsm/governanceSignal.js'

describe('buildGovernanceSignal', () => {
  it('returns null below the stuck threshold', () => {
    expect(buildGovernanceSignal(0)).toBeNull()
    expect(buildGovernanceSignal(2)).toBeNull()
  })

  it('returns a warning at stuck 3-4', () => {
    const s = buildGovernanceSignal(3)!
    expect(s).toContain('## GOVERNANCE SIGNAL (turn 3)')
    expect(s).toContain('WARNING')
    expect(s).not.toContain('CRITICAL')
  })

  it('returns the critical signal at stuck >= 5', () => {
    const s = buildGovernanceSignal(5)!
    expect(s).toContain('## GOVERNANCE SIGNAL — CRITICAL (turn 5)')
    expect(s).toContain('MUST BE DIFFERENT')
  })

  it('is deterministic for the same stuck count', () => {
    expect(buildGovernanceSignal(4)).toBe(buildGovernanceSignal(4))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/vsm/governanceSignal.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the signal builder**

```ts
// engine/vsm/governanceSignal.ts
// Governance stuck-loop signals, delivered as APPENDED conversation messages.
// Previously these were injected by rewriting the system prompt, which
// mutated the prompt prefix and invalidated the llama.cpp checkpoint cache
// on every stuck turn — exactly when long contexts make re-prefill costliest.

export function buildGovernanceSignal(stuck: number): string | null {
  if (stuck < 3) return null
  if (stuck >= 5) {
    return `## GOVERNANCE SIGNAL — CRITICAL (turn ${stuck})\n\n` +
      `CRITICAL: You have been stuck for ${stuck} turns repeating the same actions.\n\n` +
      `You MUST change your approach NOW:\n` +
      `- Do NOT call any tool you have used in the last 5 turns\n` +
      `- Use a DIFFERENT available tool, or change the tool's parameters completely\n` +
      `- If repeated attempts keep failing → try a COMPLETELY different strategy\n` +
      `- If you already have enough information → STOP using tools and produce your final answer\n\n` +
      `YOUR NEXT ACTION MUST BE DIFFERENT FROM YOUR PREVIOUS ACTIONS.`
  }
  return `## GOVERNANCE SIGNAL (turn ${stuck})\n\n` +
    `WARNING: You have been repeating similar actions for ${stuck} turns.\n` +
    `Change your approach: use a different tool or different parameters, or act on what you already know.`
}
```

- [ ] **Step 4: Rewire conversationLoop**

In `engine/bridge/conversationLoop.ts`:

1. Add import near the other vsm imports at the top of the file:

```ts
import { buildGovernanceSignal } from '../vsm/governanceSignal.js'
```

2. Replace lines 1607-1627 (the `// ── Dynamic governance intervention` comment block, `let effectiveSystemPrompt = systemPrompt`, the `currentStuck` read, the inline `signal` ternary, and the `effectiveSystemPrompt = asSystemPrompt([...systemPrompt, signal])` line) with:

```ts
      // ── Dynamic governance intervention (re-evaluated EVERY iteration) ──
      // Delivered as an APPENDED user message, never a system-prompt rewrite:
      // the prompt prefix must stay byte-stable for checkpoint caching.
      const currentStuck = this.governance.getStuckCount()
      const govSignal = buildGovernanceSignal(currentStuck)
      if (govSignal) {
        this.addMessage({ role: 'user', content: [{ type: 'text', text: govSignal }] })
        console.log(`[governance] Stuck signal appended as message (stuck=${currentStuck})`)
      }
      if (currentStuck >= 3) {
```

The `if (currentStuck >= 3) {` opens the brace that previously wrapped the signal construction AND the S5 re-eval block — keep the S5 re-eval block (old lines 1629-1671) inside it unchanged, so brace structure is preserved. Verify braces balance after the edit.

3. At line ~1696, change `systemPrompt: effectiveSystemPrompt,` to `systemPrompt,`.

4. Check whether `asSystemPrompt` is still used elsewhere in the file (it is — lines 758 and 1326) so the import at line 10 STAYS.

- [ ] **Step 5: Run tests**

Run: `npx vitest run engine/__tests__/vsm/governanceSignal.test.ts && npx vitest run engine/__tests__`
Expected: governanceSignal 4/4 PASS; full suite green. If any existing test asserts the system prompt contains the governance signal, update it to assert the signal arrives as a message instead (search: `npx vitest run engine/__tests__ 2>&1 | grep -i govern`).

- [ ] **Step 6: Commit**

```bash
git add engine/vsm/governanceSignal.ts engine/bridge/conversationLoop.ts engine/__tests__/vsm/governanceSignal.test.ts
git commit -m "fix: governance stuck signals appended as messages, not system-prompt rewrites"
```

---

### Task 7: Compressor replacement-semantics locking test (no code change)

**Files:**
- Test: Create `engine/__tests__/context/compressorReplace.test.ts`

Code verification showed `compressMessages` already replaces (spec amendment 1). Lock it so a regression can't silently reintroduce append-alongside bloat.

- [ ] **Step 1: Write the locking test (should pass immediately)**

```ts
// engine/__tests__/context/compressorReplace.test.ts
import { describe, expect, it } from 'bun:test'
import { ContextCompressor } from '../../context/compressor.js'

function msg(role: 'user' | 'assistant', text: string) {
  return { role, content: [{ type: 'text', text }] } as any
}

describe('compressMessages replacement semantics (prefill-elimination lock)', () => {
  it('replaces compressed messages — output is [summary, ...recent], originals gone', () => {
    const c = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5, keepRecent: 2 })
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}`))
    const out = c.compressMessages(messages, 'THE SUMMARY')
    // keepRecent=2 → last 4 messages kept, plus exactly one summary message
    expect(out.length).toBe(5)
    expect(out[0].role).toBe('system')
    expect(out[0].content[0].text).toContain('THE SUMMARY')
    expect(out.slice(1).map((m: any) => m.content[0].text)).toEqual([
      'turn-8', 'turn-9', 'turn-10', 'turn-11',
    ])
    // None of the compressed originals survive
    const allText = JSON.stringify(out)
    expect(allText).not.toContain('turn-0')
    expect(allText).not.toContain('turn-7')
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run engine/__tests__/context/compressorReplace.test.ts`
Expected: PASS immediately (behavior already correct). If it FAILS, stop — the spec amendment was wrong and this becomes a real fix; re-read `compressMessages` before proceeding.

- [ ] **Step 3: Commit**

```bash
git add engine/__tests__/context/compressorReplace.test.ts
git commit -m "test: lock compressor replace-don't-append semantics"
```

---

### Task 8: Prefix-stability regression test

**Files:**
- Test: Create `engine/__tests__/engine/prefixStability.test.ts`

The durability guarantee: simulate a multi-turn conversation through the real prompt-assembly components and assert turn N's serialized prompt is a byte-prefix of turn N+1's.

- [ ] **Step 1: Write the test**

```ts
// engine/__tests__/engine/prefixStability.test.ts
// THE append-only guarantee for llama.cpp checkpoint caching: the serialized
// prompt for turn N must be a byte-prefix of turn N+1. Any feature that
// mutates the system prompt or earlier messages breaks warm-turn TTFT and
// must fail here. Legitimate exception: compaction (rare, accepted).
import { beforeEach, describe, expect, it } from 'bun:test'
import { buildSimulatedToolPrompt } from '../../ollama/simulated.js'
import { getSessionExtras, resetSessionExtras } from '../../engine/sessionExtras.js'
import { buildGovernanceSignal } from '../../vsm/governanceSignal.js'
import { ContextCompressor } from '../../context/compressor.js'

const TOOLS = [
  { name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_shell', description: 'Run', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
] as any

const BASE_SYSTEM = 'You are CynCo, a local coding assistant.'

function msg(role: 'user' | 'assistant' | 'system', text: string) {
  return { role, content: [{ type: 'text', text }] } as any
}

/** Mirrors callModel assembly: sim tool prompt + base system + session extras. */
async function assembleSystem(messages: any[]): Promise<string> {
  const simPrompt = buildSimulatedToolPrompt(TOOLS)
  let system = simPrompt + '\n\n' + BASE_SYSTEM
  const firstUser = messages.find((m: any) => m.role === 'user')
  const key = firstUser?.content?.map((b: any) => b.text || '').join(' ') ?? ''
  system += await getSessionExtras(key, messages.length <= 2, async () => '\n\n## Recalled Memories\n- prior work on the parser')
  return system
}

function serialize(system: string, messages: any[]): string {
  return system + '\u0000' + messages.map(m => JSON.stringify(m)).join('\u0000')
}

describe('prompt prefix stability across turns', () => {
  beforeEach(() => resetSessionExtras())

  it('turn N serialization is a byte-prefix of turn N+1 across 6 turns incl. a stuck-governance event', async () => {
    const messages: any[] = [msg('user', 'fix the parser bug')]
    const serialized: string[] = []

    for (let turn = 0; turn < 6; turn++) {
      // Governance signal fires as an APPENDED message at stuck >= 3
      const stuck = turn // escalates: null, null, null, warn, warn, critical
      const signal = buildGovernanceSignal(stuck)
      if (signal) messages.push(msg('user', signal))

      const system = await assembleSystem(messages)
      serialized.push(serialize(system, messages))

      // Model "responds" and a tool result lands — pure appends
      messages.push(msg('assistant', `turn ${turn}: reading file`))
      messages.push(msg('user', `[tool result ${turn}] contents...`))
    }

    for (let i = 1; i < serialized.length; i++) {
      expect(serialized[i].startsWith(serialized[i - 1])).toBe(true)
    }
  })

  it('compaction may break the prefix ONCE, then stability resumes', async () => {
    const compressor = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5, keepRecent: 2 })
    let messages: any[] = [msg('user', 'long running task')]
    for (let i = 0; i < 11; i++) messages.push(msg(i % 2 === 0 ? 'assistant' : 'user', `filler-${i}`))

    const before = serialize(await assembleSystem(messages), messages)

    // Compaction event — legitimate one-time prefix break
    messages = compressor.compressMessages(messages, 'compact summary')
    const afterCompaction = serialize(await assembleSystem(messages), messages)
    expect(afterCompaction.startsWith(before)).toBe(false) // break is expected

    // Post-compaction turns must be append-only again
    const post: string[] = [afterCompaction]
    for (let turn = 0; turn < 3; turn++) {
      messages.push(msg('assistant', `post-compact turn ${turn}`))
      messages.push(msg('user', `[tool result] ok`))
      post.push(serialize(await assembleSystem(messages), messages))
    }
    for (let i = 1; i < post.length; i++) {
      expect(post[i].startsWith(post[i - 1])).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run engine/__tests__/engine/prefixStability.test.ts`
Expected: PASS — Tasks 4-6 made the components stable. If the first test FAILS, one of the fixed components is still mutating: diff `serialized[i-1]` against `serialized[i]` at the first divergent byte to find it.

- [ ] **Step 3: Commit**

```bash
git add engine/__tests__/engine/prefixStability.test.ts
git commit -m "test: prompt prefix byte-stability regression guard for checkpoint caching"
```

---

### Task 9: Serving doc update

**Files:**
- Modify: `docs/serving/rtx-5090-qwen3.6-27b.md`

- [ ] **Step 1: Rewrite the stale guidance**

Update the doc to match the new reality:
1. In the "TL;DR" launch-args block: remove `--cache-ram 0`; add `--ubatch-size 2048`, `--ctx-checkpoints 64`, `--checkpoint-min-step 1024`.
2. In the flag table: change the `--cache-ram` row — new guidance: "leave at llama.cpp default; the host-memory prompt cache is required for checkpoint rollback. `LOCALCODE_CACHE_RAM` still overrides." Add three new rows:

```markdown
| `--ubatch-size` | `2048` | `LOCALCODE_UBATCH_SIZE` | `ubatch_size` | Physical prefill batch. llama.cpp default is 512; 2048 is the biggest single prefill-speed knob (~1-2 GB extra compute buffer). |
| `--ctx-checkpoints` | `64` | `LOCALCODE_CTX_CHECKPOINTS` | `ctx_checkpoints` | Recurrent-state snapshots during prefill. Qwen3.6 is hybrid DeltaNet — checkpoints (not `--swa-full`) enable prefix-cache rollback (llama.cpp #21831). ~75 MiB each. |
| `--checkpoint-min-step` | `1024` | `LOCALCODE_CHECKPOINT_MIN_STEP` | `checkpoint_min_step` | Minimum token spacing between checkpoints. |
```

3. Replace the "Keep 0 for Qwen3.6 (SWA)" cache-ram note with the corrected architecture story: hybrid Gated DeltaNet + attention, checkpoints restore prefix caching, **client prompts must be append-only** (enforced by `engine/__tests__/engine/prefixStability.test.ts`), and `--swa-full` must NOT be used on this model (does not work for hybrids and balloons VRAM).
4. Update the profile `runtime:` example block with the three new keys.
5. In VRAM budget section: add checkpoint budget line (~2-2.5 GB at 64 checkpoints) and ubatch compute buffer (~1-2 GB).

- [ ] **Step 2: Commit**

```bash
git add docs/serving/rtx-5090-qwen3.6-27b.md
git commit -m "docs: serving recipe — checkpoint caching recipe replaces stale cache-ram-0 guidance"
```

---

### Task 10: End-to-end verification (GATES — all must pass before merge)

**Files:**
- Modify: `docs/serving/rtx-5090-qwen3.6-27b.md` (record A/B winner)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: green. (Baseline: the suite was green before this work; any failure is ours.)

- [ ] **Step 2: Warm-turn TTFT slope (THE gate)**

Run: `bun benchmark/true/benchAgentic.ts --sessions 2`
Compare the reported TTFT slope against `benchmark/true/results/prefill-baseline.summary.txt` (Task 1).
Expected: **new slope < 20% of baseline slope** (>80% drop). Also sanity-check absolute warm-turn TTFT is roughly flat as prompt grows.
If NOT met: check llama-server logs for "forcing full prompt re-processing"; if present, the prompt is still mutating somewhere (bisect with the prefix-stability serializer) or checkpoints aren't engaging on the dense 27B (spec failure path: keep engine work, revert Task 2's flag defaults, present measurements to the user).

- [ ] **Step 3: Streaming tool-call health**

Run: `bun benchmark/true/streamToolcallProbe.ts`
Expected: all PASS, zero DROP, exit code 0.

- [ ] **Step 4: Spec-draft A/B (decode)**

```bash
LOCALCODE_SPEC_DRAFT_N=2 bun benchmark/true/benchAgentic.ts --sessions 1
LOCALCODE_SPEC_DRAFT_N=3 bun benchmark/true/benchAgentic.ts --sessions 1
```

Compare median decode tok/s. Record the winner in the serving doc's `--spec-draft-n-max` row (external benchmark says n=2 wins 1.73x on this dense 27B; verify locally). Commit the doc change.

- [ ] **Step 5: VRAM check**

Run: `nvidia-smi --query-gpu=memory.used,memory.total --format=csv` while llama-server is loaded (during a bench run).
Expected: used + ~2.5 GB headroom < 32 GB. If OOM or tight: reduce `--ctx-checkpoints` default (64 → 32) and re-run Step 2.

- [ ] **Step 6: Live CynCo session (verify-before-moving-on)**

Launch the TUI (`cd tui && python -m localcode_tui.app`), run one real task (e.g., "read engine/config.ts and summarize the env vars"), confirm: normal streaming, tool calls work, second turn responds visibly faster than cold, no errors in the engine log files.

- [ ] **Step 7: WIRE CHECK (BLOCKING — every new symbol must be imported/called)**

```bash
grep -rn "ctxCheckpoints" engine/ --include="*.ts" | grep -v __tests__   # expect: processManager (def+use), config.ts, bootstrapProvider
grep -rn "checkpointMinStep" engine/ --include="*.ts" | grep -v __tests__
grep -rn "ubatchSize" engine/ --include="*.ts" | grep -v __tests__
grep -rn "ctx_checkpoints\|checkpoint_min_step\|ubatch_size" engine/config.ts
grep -rn "getSessionExtras" engine/ --include="*.ts" | grep -v __tests__  # expect: sessionExtras.ts (def), callModel.ts (use)
grep -rn "buildGovernanceSignal" engine/ --include="*.ts" | grep -v __tests__  # expect: governanceSignal.ts (def), conversationLoop.ts (use)
grep -rn "effectiveSystemPrompt" engine/bridge/conversationLoop.ts  # expect: NO matches (removed)
grep -rn "LOCALCODE_CTX_CHECKPOINTS\|LOCALCODE_CHECKPOINT_MIN_STEP\|LOCALCODE_UBATCH_SIZE" engine/ --include="*.ts" | grep -v __tests__  # expect: processManager envInt calls
```

Every symbol must show BOTH a definition and at least one real (non-test) use. Any orphan = unwired feature = BLOCKING failure.

- [ ] **Step 8: Final commit**

```bash
git add -A -- docs/serving benchmark/true/results
git commit -m "verify: prefill elimination gates — TTFT slope, probe, suite, spec-draft A/B, VRAM, live session"
```

---

## Self-review (completed at plan time)

- **Spec coverage:** §1 serving → Tasks 2-3; §2 mutators → Tasks 4-6 (+ amendment: Task 5 covers the newly found extras mutator; Task 7 downgraded to lock-test per verified code); §3 prefix test → Task 8; §4 verification incl. spec-draft A/B → Tasks 1, 10; doc update → Task 9. Failure path → Task 10 Step 2.
- **Placeholder scan:** none; all steps carry complete code or exact commands.
- **Type consistency:** `ctxCheckpoints`/`checkpointMinStep`/`ubatchSize` used identically in ServerConfig, ProcessManagerConfig, RuntimeConfig, bootstrapProvider; snake_case profile keys match config.ts mapping; `getSessionExtras(key, isFirstTurn, compute)` signature identical in module, callModel, and both test files; `buildGovernanceSignal(stuck): string | null` consistent.
