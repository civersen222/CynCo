# Session Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three defects surfaced by the CynCo session scorecard (session-1783021353309): sub-agents reporting success with zero output, the model writing bash-dialect commands (`&&`/`||`) that Windows PowerShell 5.1 rejects, and narration nudges that fire 5+ times without changing model behavior.

**Architecture:** Three independent fixes in the CynCo engine. (1) `SubAgent.run()` gates `success` on non-empty collected output. (2) A new `shellInfo.ts` module detects the actual shell (pwsh → powershell.exe → bash), feeds a dialect note into the Bash tool description + system prompt, and pre-flights `&&`/`||` with a deterministic instructive error on PowerShell 5.1. (3) A pure `applyNudgeTemperature()` control signal deterministically cools sampling after 2+ consecutive nudges — behavior change instead of more words, and no message mutation (prompt prefix stays byte-stable).

**Tech Stack:** TypeScript (Bun runtime, vitest-on-Node test harness via `npx vitest run` from repo root; test files import from `'bun:test'` which vitest aliases).

**Branch:** `session-quality-fixes` off `main` (8a22e47). Verify `git branch --show-current` before EVERY commit — an external process on this machine switches branches mid-work. Commits end with `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.

**Constraints (non-negotiable):**
- NEVER mutate or strip existing conversation messages — the prompt prefix must stay byte-identical across turns (llama.cpp checkpoint cache; enforced by `engine/__tests__/prefixStability.test.ts`).
- `engine/` contains an embedded git repo — never run git with cwd inside `engine/`. Run all git from repo root.
- Run tests from repo root: `npx vitest run <file>` (running from a subdirectory finds no tests).

---

### Task 1: SubAgent silent-success fix

A sub-agent that streams zero text currently returns `success: true, output: '(no output)'` — the parent agent treats a dead scout as a successful one. Empty output must mean failure.

**Files:**
- Modify: `engine/agents/subAgent.ts:380-401`
- Test (new): `engine/__tests__/agents/subAgent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/agents/subAgent.test.ts`. Mock `localCallModel` (the only external call in the loop) via `vi.mock` — precedent: `engine/__tests__/bootstrapProvider.test.ts`. The mocked stream yields nothing → the loop collects no text, no tool calls, breaks after turn 1.

```typescript
// engine/__tests__/agents/subAgent.test.ts
// NOTE: import vi from 'vitest' (not 'bun:test') — precedent: bootstrapProvider.test.ts
import { describe, expect, it, vi } from 'vitest'

// Streams are configured per-test via this holder. vi.hoisted is required:
// vi.mock factories are hoisted above top-level `let` declarations.
const state = vi.hoisted(() => ({ streamEvents: [] as any[] }))

vi.mock('../../engine/callModel.js', () => ({
  localCallModel: () => (async function* () {
    for (const e of state.streamEvents) yield e
  })(),
}))

import { SubAgent } from '../../agents/subAgent.js'
import { makeSubAgentConfig } from '../../agents/types.js'

function makeAgent() {
  return new SubAgent({
    config: makeSubAgentConfig({ task: 'find the auth module', persona: 'scout', maxIterations: 3 }),
    provider: {} as any,
    emit: () => {},
    cwd: process.cwd(),
    model: 'test-model',
  })
}

function textEvents(text: string): any[] {
  return [
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
    { type: 'stream_event', event: { type: 'content_block_stop' } },
  ]
}

describe('SubAgent silent-success', () => {
  it('reports failure when the model streams zero output', async () => {
    state.streamEvents = [] // model produces nothing at all
    const agent = makeAgent()
    const result = await agent.run()
    expect(result.success).toBe(false)
    expect(result.output).toBe('(no output)')
    expect(agent.status.state).toBe('failed')
  })

  it('reports failure when the model streams only whitespace', async () => {
    state.streamEvents = textEvents('   \n  ')
    const agent = makeAgent()
    const result = await agent.run()
    expect(result.success).toBe(false)
    expect(agent.status.state).toBe('failed')
  })

  it('reports success when the model streams real text', async () => {
    state.streamEvents = textEvents('The auth module is in src/auth.ts')
    const agent = makeAgent()
    const result = await agent.run()
    expect(result.success).toBe(true)
    expect(result.output).toBe('The auth module is in src/auth.ts')
    expect(agent.status.state).toBe('completed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (repo root): `npx vitest run engine/__tests__/agents/subAgent.test.ts`
Expected: first two tests FAIL (`success` is `true`, state is `'completed'`); third test PASSES.

If the mock import order fails (SubAgent pulled in before mock applies), the `vi.mock` call is hoisted by vitest — it must be at top level before the imports, exactly as shown.

- [ ] **Step 3: Implement the fix**

In `engine/agents/subAgent.ts`, replace lines 380-392 (the final-state + result build):

Old:
```typescript
      // 8. Determine final state
      if (this.aborted) {
        this._status.state = 'killed'
      } else {
        this._status.state = 'completed'
      }
      this._status.endTime = Date.now()

      // 9. Build result
      const result: SubAgentResult = {
        agentId: this.config.id,
        success: !this.aborted,
        output: collectedText || '(no output)',
```

New:
```typescript
      // 8. Determine final state. Zero collected output is a failure even if
      // the loop ran to completion — a silent scout must not report success
      // (parents act on the output; '(no output)' with success:true is a lie).
      const producedOutput = collectedText.trim().length > 0
      if (this.aborted) {
        this._status.state = 'killed'
      } else if (!producedOutput) {
        this._status.state = 'failed'
      } else {
        this._status.state = 'completed'
      }
      this._status.endTime = Date.now()

      // 9. Build result
      const result: SubAgentResult = {
        agentId: this.config.id,
        success: !this.aborted && producedOutput,
        output: collectedText || '(no output)',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/agents/subAgent.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # MUST print session-quality-fixes
git add engine/agents/subAgent.ts engine/__tests__/agents/subAgent.test.ts
git commit -m "$(cat <<'EOF'
fix: sub-agent with zero output reports failure, not silent success

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shell dialect awareness for the Bash tool

CynCo's Bash tool runs `powershell.exe` on Windows. PowerShell 5.1 does NOT support `&&`/`||`; the model used them twice and got confusing parse errors. Fix three ways: prefer `pwsh.exe` (PowerShell 7 supports `&&`/`||`) when installed; on 5.1, pre-flight-reject `&&`/`||` with a deterministic instructive error; and state the actual shell + dialect in the tool description and system prompt.

**Files:**
- Create: `engine/tools/shellInfo.ts`
- Test (new): `engine/__tests__/tools/shellInfo.test.ts`
- Modify: `engine/tools/impl/bash.ts` (lines 8, 22-29)
- Modify: `engine/engine/systemPromptText.ts:230-254` (`assembleBasePrompt`)
- Modify test: `engine/__tests__/engine/systemPromptText.test.ts` (add shell-line assertion)

- [ ] **Step 1: Write the failing test for shellInfo**

Create `engine/__tests__/tools/shellInfo.test.ts`:

```typescript
// engine/__tests__/tools/shellInfo.test.ts
import { describe, expect, it } from 'bun:test'
import { classifyShell, checkShellDialect, getShellInfo } from '../../tools/shellInfo.js'

describe('classifyShell', () => {
  it('non-Windows → /bin/bash, && supported', () => {
    const info = classifyShell('linux', false)
    expect(info.shell).toBe('/bin/bash')
    expect(info.supportsAndAnd).toBe(true)
    expect(info.dialectNote).toMatch(/bash/i)
  })

  it('Windows with pwsh → pwsh.exe, && supported', () => {
    const info = classifyShell('win32', true)
    expect(info.shell).toBe('pwsh.exe')
    expect(info.supportsAndAnd).toBe(true)
  })

  it('Windows without pwsh → powershell.exe, && NOT supported, note explains it', () => {
    const info = classifyShell('win32', false)
    expect(info.shell).toBe('powershell.exe')
    expect(info.supportsAndAnd).toBe(false)
    expect(info.dialectNote).toContain('&&')
    expect(info.dialectNote).toContain(';')
  })
})

describe('checkShellDialect', () => {
  const ps51 = classifyShell('win32', false)
  const pwsh = classifyShell('win32', true)
  const bash = classifyShell('linux', false)

  it('rejects && on PowerShell 5.1 with an instructive error', () => {
    const err = checkShellDialect('cd proj && python -m pytest', ps51)
    expect(err).toBeTruthy()
    expect(err).toContain('PowerShell 5.1')
    expect(err).toContain(';')
  })

  it('rejects || on PowerShell 5.1', () => {
    expect(checkShellDialect('run || echo failed', ps51)).toBeTruthy()
  })

  it('allows ; sequencing on PowerShell 5.1', () => {
    expect(checkShellDialect('cd proj; python -m pytest', ps51)).toBeNull()
  })

  it('allows && on pwsh and bash', () => {
    expect(checkShellDialect('a && b', pwsh)).toBeNull()
    expect(checkShellDialect('a && b', bash)).toBeNull()
  })
})

describe('getShellInfo', () => {
  it('returns a stable cached value for this platform', () => {
    const a = getShellInfo()
    const b = getShellInfo()
    expect(a).toBe(b)
    expect(typeof a.shell).toBe('string')
    expect(typeof a.dialectNote).toBe('string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/tools/shellInfo.test.ts`
Expected: FAIL — `Cannot find module '../../tools/shellInfo.js'`.

- [ ] **Step 3: Implement shellInfo.ts**

Create `engine/tools/shellInfo.ts`:

```typescript
/**
 * shellInfo.ts — detect the actual shell the Bash tool uses, and its dialect.
 *
 * Windows PowerShell 5.1 does not support `&&` / `||` pipeline-chain
 * operators (PowerShell 7+ does). Local models constantly emit bash-style
 * `a && b`, which 5.1 rejects with a confusing parse error. We:
 *   1. Prefer pwsh.exe (PowerShell 7) when installed,
 *   2. Surface the real dialect in the tool description + system prompt,
 *   3. Pre-flight-reject && / || on 5.1 with an instructive, deterministic
 *      error (one cheap turn instead of a cryptic parse failure).
 */
import { execFileSync } from 'child_process'

export type ShellInfo = {
  shell: string           // executable passed to exec()
  displayName: string     // human-readable name for prompts/descriptions
  supportsAndAnd: boolean // whether && / || work in this shell
  dialectNote: string     // one-line dialect guidance for the system prompt
}

export function classifyShell(platform: string, hasPwsh: boolean): ShellInfo {
  if (platform !== 'win32') {
    return {
      shell: '/bin/bash',
      displayName: 'bash',
      supportsAndAnd: true,
      dialectNote: 'Shell is bash. Standard POSIX syntax (&&, ||, pipes) works.',
    }
  }
  if (hasPwsh) {
    return {
      shell: 'pwsh.exe',
      displayName: 'PowerShell 7 (pwsh)',
      supportsAndAnd: true,
      dialectNote: 'Shell is PowerShell 7 (pwsh). && and || are supported. Use PowerShell cmdlets, not Unix commands.',
    }
  }
  return {
    shell: 'powershell.exe',
    displayName: 'Windows PowerShell 5.1',
    supportsAndAnd: false,
    dialectNote: "Shell is Windows PowerShell 5.1 — '&&' and '||' are NOT supported. Sequence commands with ';' (e.g. 'cd proj; python -m pytest') or use 'if ($?) { ... }' for conditional chaining.",
  }
}

/** Returns an instructive error if the command uses operators the shell rejects, else null. */
export function checkShellDialect(command: string, info: ShellInfo): string | null {
  if (info.supportsAndAnd) return null
  if (/&&|\|\|/.test(command)) {
    return "Error: this system's shell is Windows PowerShell 5.1, which does not support '&&' or '||'. Rewrite the command using ';' to sequence steps (e.g. 'cd proj; python -m pytest') or 'if ($?) { ... }' for conditional execution."
  }
  return null
}

function detectPwsh(): boolean {
  try {
    execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let cached: ShellInfo | null = null

/** Detect once per process; the shell cannot change mid-session (and the
 *  system prompt that mentions it must stay byte-stable anyway). */
export function getShellInfo(): ShellInfo {
  if (!cached) cached = classifyShell(process.platform, process.platform === 'win32' && detectPwsh())
  return cached
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/tools/shellInfo.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Wire into bash.ts**

In `engine/tools/impl/bash.ts`:

Replace line 1-4 imports block addition and line 8 description, lines 22-29. Full new file top (through the shell selection):

```typescript
import { exec } from 'child_process'
import type { ToolImpl } from '../types.js'
import { checkBashSafety } from '../bashSafety.js'
import { diagnoseError } from '../errorDiagnosis.js'
import { getShellInfo, checkShellDialect } from '../shellInfo.js'

export const bashTool: ToolImpl = {
  name: 'Bash',
  description: `Execute a shell command and return its output. The working directory persists between calls. ${getShellInfo().dialectNote}`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000, max: 600000)' },
    },
    required: ['command'],
  },
  tier: 'approval',
  execute: async (input, cwd) => {
    const command = input.command as string
    const timeout = Math.min((input.timeout as number) ?? 120000, 600000)

    const safety = checkBashSafety(command)
    if (!safety.safe) {
      return { output: `Blocked: ${safety.reason}`, isError: true }
    }

    const shellInfo = getShellInfo()
    const dialectError = checkShellDialect(command, shellInfo)
    if (dialectError) {
      return { output: dialectError, isError: true }
    }

    // Use async exec — execSync blocks the entire event loop (freezes WebSocket)
    const shell = shellInfo.shell
```

(The old `const isWindows = ...` / `const shell = isWindows ? ...` two lines are replaced by `const shell = shellInfo.shell`; everything from `return new Promise(...)` down is unchanged.)

- [ ] **Step 6: Add the shell line to the system prompt**

In `engine/engine/systemPromptText.ts`, add the import at the top:

```typescript
import { getShellInfo } from '../tools/shellInfo.js'
```

And in `assembleBasePrompt` (line ~252), change the final entry:

Old:
```typescript
    `Working directory: ${cwd}`,
  ]
```

New:
```typescript
    `Working directory: ${cwd}`,
    `Shell: ${getShellInfo().dialectNote}`,
  ]
```

(Static per process → prompt prefix stays byte-stable across turns.)

- [ ] **Step 7: Add assembleBasePrompt shell assertion**

In `engine/__tests__/engine/systemPromptText.test.ts`, inside `describe('assembleBasePrompt', ...)` add:

```typescript
  it('states the actual shell and its dialect', () => {
    const joined = result.join('\n')
    expect(joined).toMatch(/Shell: .*[Ss]hell is /)
  })
```

- [ ] **Step 8: Run affected suites**

Run: `npx vitest run engine/__tests__/tools/shellInfo.test.ts engine/__tests__/engine/systemPromptText.test.ts engine/__tests__/prefixStability.test.ts`
Expected: ALL PASS. Also grep for other tests asserting the old Bash description text: `grep -rn "uses PowerShell" engine/__tests__` — update any that assert the old literal.

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # MUST print session-quality-fixes
git add engine/tools/shellInfo.ts engine/tools/impl/bash.ts engine/engine/systemPromptText.ts engine/__tests__/tools/shellInfo.test.ts engine/__tests__/engine/systemPromptText.test.ts
git commit -m "$(cat <<'EOF'
fix: shell-dialect awareness — prefer pwsh, reject &&/|| on PS5.1 with instructive error

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Nudge cooling — narration suppression that changes behavior

Scorecard evidence: 5+ "stop narrating, call a tool" nudges fired with zero behavior change. Words don't break the narration attractor; sampling temperature can. After 2+ consecutive nudges, deterministically cool temperature by 0.2 (clamped to the governance floor). No message mutation → prefix stability preserved (nudges are already appended messages, which is allowed).

**Files:**
- Modify: `engine/vsm/controlSignals.ts` (add `applyNudgeTemperature`)
- Modify test: `engine/__tests__/vsm/controlSignals.test.ts`
- Modify: `engine/bridge/conversationLoop.ts` (~line 1604, after the variety-control block, before `const _savedTemperature`)

- [ ] **Step 1: Write the failing test**

Append to `engine/__tests__/vsm/controlSignals.test.ts` (it already imports from `'../../vsm/controlSignals.js'` and resets params in `beforeEach`). Update the import line to include the new function:

```typescript
import { computeControlSignals, applyNudgeTemperature } from '../../vsm/controlSignals.js'
```

Add:

```typescript
describe('applyNudgeTemperature', () => {
  it('does nothing at 0 or 1 consecutive nudges', () => {
    expect(applyNudgeTemperature(0.7, 0)).toBe(0.7)
    expect(applyNudgeTemperature(0.7, 1)).toBe(0.7)
  })

  it('cools by 0.2 at 2+ consecutive nudges', () => {
    expect(applyNudgeTemperature(0.7, 2)).toBeCloseTo(0.5, 5)
    expect(applyNudgeTemperature(0.7, 5)).toBeCloseTo(0.5, 5)
  })

  it('clamps to the governance temperature floor', () => {
    // default variety.temperature_floor is 0.3
    expect(applyNudgeTemperature(0.4, 3)).toBeCloseTo(0.3, 5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/__tests__/vsm/controlSignals.test.ts`
Expected: FAIL — `applyNudgeTemperature` is not exported.

- [ ] **Step 3: Implement applyNudgeTemperature**

Append to `engine/vsm/controlSignals.ts`:

```typescript
/**
 * Nudge cooling. After repeated no-tool-call nudges the model is stuck in a
 * narration attractor; stronger wording alone does not break it (2026-07-01
 * session: 5 escalating nudges, zero behavior change). Deterministically
 * lower sampling temperature instead so the tool-call token paths dominate.
 */
export function applyNudgeTemperature(temperature: number, consecutiveNudges: number): number {
  if (consecutiveNudges < 2) return temperature
  const floor = getParam('variety.temperature_floor')
  return Math.max(floor, temperature - 0.2)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/__tests__/vsm/controlSignals.test.ts`
Expected: ALL PASS (existing 8 + new 3).

- [ ] **Step 5: Wire into conversationLoop**

In `engine/bridge/conversationLoop.ts`:

1. Add `applyNudgeTemperature` to the existing import from `'../vsm/controlSignals.js'` (find it with `grep -n "controlSignals" engine/bridge/conversationLoop.ts`; if controlSignals is only reached via governance, add a new import line near the other vsm imports):

```typescript
import { applyNudgeTemperature } from '../vsm/controlSignals.js'
```

2. Immediately after the variety-control block (after the closing `}` at line ~1604, BEFORE `const _savedTemperature = this.config.temperature`), insert:

```typescript
      // Nudge cooling: after 2+ consecutive no-tool-call nudges, lower the
      // temperature deterministically — wording alone doesn't break the
      // narration attractor. Applies even when variety control is disabled.
      const cooled = applyNudgeTemperature(effectiveTemperature, this.consecutiveNudges)
      if (cooled !== effectiveTemperature) {
        console.log(`[control] Nudge cooling: temp ${effectiveTemperature.toFixed(2)} → ${cooled.toFixed(2)} after ${this.consecutiveNudges} consecutive nudges`)
        effectiveTemperature = cooled
      }
```

Note: `consecutiveNudges` increments at line ~1979 after each no-tool-call turn and resets to 0 when tools are used (line ~2136), so the cooling naturally engages on the call AFTER the second nudge and disengages once the model acts.

- [ ] **Step 6: Run the loop-adjacent suites**

Run: `npx vitest run engine/__tests__/prefixStability.test.ts engine/__tests__/vsm/controlSignals.test.ts`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # MUST print session-quality-fixes
git add engine/vsm/controlSignals.ts engine/__tests__/vsm/controlSignals.test.ts engine/bridge/conversationLoop.ts
git commit -m "$(cat <<'EOF'
fix: cool temperature after 2+ narration nudges — behavior change, not more words

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire check + full verification (BLOCKING)

- [ ] **Step 1: Wire check — every new symbol is imported and used**

```bash
grep -rn "applyNudgeTemperature" engine/ --include="*.ts" | grep -v __tests__
grep -rn "getShellInfo\|checkShellDialect\|classifyShell" engine/ --include="*.ts" | grep -v __tests__
grep -rn "producedOutput" engine/agents/subAgent.ts
```

Expected:
- `applyNudgeTemperature`: defined in `vsm/controlSignals.ts`, called in `bridge/conversationLoop.ts`.
- `getShellInfo`: defined in `tools/shellInfo.ts`, called in `tools/impl/bash.ts` AND `engine/systemPromptText.ts`. `checkShellDialect`: called in `bash.ts`. `classifyShell`: called by `getShellInfo` (same file) + tests.
- `producedOutput`: used in both the state branch and the `success:` field.

Any symbol defined but never imported elsewhere (outside tests, except `classifyShell` which is the pure core of `getShellInfo`) = FAIL, fix before proceeding.

- [ ] **Step 2: Full engine test suite**

Run (repo root): `npx vitest run`
Expected: everything passes (baseline before this work: 0 failures on main). Any new failure = fix before proceeding.

- [ ] **Step 3: Commit any wire-check fixes**

Only if Step 1/2 required changes; same commit conventions.
