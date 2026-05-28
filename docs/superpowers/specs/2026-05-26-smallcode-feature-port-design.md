# SmallCode Feature Port — Small Model Reliability

**Date:** 2026-05-26
**Status:** Approved
**Scope:** Port 7 high/medium-impact features from SmallCode to close the small-model reliability gap

## Problem

SmallCode (1,467 stars, 8 days old) is purpose-built for small models (8B-35B). CynCo has superior governance, guided UX, sub-agents, and research — but lacks the small-model reliability features that make SmallCode's tool loop actually work. If the model can't reliably call tools, none of our platform advantages matter.

## Features to Port

### 1. Tool Result Capping

Truncate tool output based on context window size to prevent context blowout from large file reads or verbose bash output.

**Algorithm:**
```
cap = contextLength < 64000 ? 2000 : 4000
if output.length > cap:
  output = output.slice(0, cap - 500) + "\n...(truncated " + (output.length - cap) + " chars)...\n" + output.slice(-300)
```

Preserves start (most relevant) and end (often has error summaries/stack traces).

**Where:** `engine/tools/executor.ts` — wrap return value after every tool execution, before returning to conversation loop.

**What doesn't change:** Tools that return structured data (like Glob returning file lists) are still capped — the model doesn't need 500 file paths.

### 2. Two-Stage Tool Routing

For small context models, send a lightweight category selector tool first. Model picks a category, then gets only relevant tool schemas. Halves schema token overhead (~2000 tokens saved per turn).

**Categories:**
| Category | Tools |
|----------|-------|
| `read` | Read, Glob, Grep, Ls, CodeIndex |
| `write` | Edit, Write, MultiEdit, ApplyPatch |
| `search` | Grep, Glob, WebSearch, WebFetch, IndexResearch |
| `execute` | Bash, Git |
| `agent` | SpawnAgent, CollectAgent |
| `all` | All tools (bypass routing) |

**Activation:** Only when `contextLength < 32768`. Larger contexts get all tools (current behavior).

**Flow:**
1. Build `select_category` tool with enum of category names
2. Call model with ONLY this one tool
3. Model returns category choice
4. Re-call model with conversation + only tools from that category
5. Proceed with normal tool execution

**Bypass:** If S5 has already restricted tools (via governance), skip routing — S5 takes priority.

**Where:** New file `engine/tools/toolRouter.ts`. Called from `engine/bridge/conversationLoop.ts` before the model call when context is small.

### 3. Per-Tool Trust Score Decay

Track per-tool success rates with Bayesian smoothing. Demote consistently failing tools instead of hard-killing the whole session (which is what the algedonic kill switch does).

**Algorithm:**
```typescript
confidence = (successes + 1) / (totalCalls + 2)  // Laplace smoothing
shouldDemote(tool): boolean = totalCalls >= 3 && confidence < 0.35
```

**Behavior:**
- Demoted tools are excluded from the tool schema for the rest of the session
- S5 rule C2 (exclude failing tool after 3 failures) is the hard version of this — trust decay is the soft version that kicks in earlier
- Trust scores persist to `~/.cynco/training/tool-scores.json` across sessions
- On session start, load scores; tools that were demoted in 3+ recent sessions get a starting penalty

**Integration with governance:** Trust scores feed into S5Input as a new field `demotedTools: string[]`. S5 can use this for decision-making but trust decay enforces independently (it's faster than waiting for S5).

**Where:** New file `engine/tools/toolScorer.ts`. Integrated into `engine/tools/executor.ts` (recording) and tool filtering in `engine/bridge/conversationLoop.ts` (exclusion).

### 4. Error Diagnosis for Bash

When a bash command fails (exit code != 0), classify the error type and prepend a structured hint so the model gets actionable guidance instead of raw stderr.

**Error classification (regex on stderr):**
| Type | Patterns | Fix hint |
|------|----------|----------|
| `syntax` | SyntaxError, parse error, unexpected token | "Check syntax near the indicated line" |
| `runtime` | TypeError, ReferenceError, NullPointerException, segfault | "Variable or function may be undefined or wrong type" |
| `permission` | EACCES, Permission denied, Operation not permitted | "Run with elevated permissions or check file ownership" |
| `not_found` | command not found, ENOENT, No such file | "Check the command/path exists and is spelled correctly" |
| `timeout` | timed out, exceeded, SIGKILL | "Command took too long — try a simpler version or add limits" |
| `dependency` | ModuleNotFoundError, Cannot find module, ImportError | "Install the missing package first" |
| `unknown` | (fallback) | "Check the error output above" |

**Format:** `[ERROR: {type}] {hint}\n\n{original output}`

No LLM call — pure regex classification + static hints. Fast and deterministic.

**Where:** `engine/tools/impl/bash.ts` — wrap the execution result when exit code != 0.

### 5. Contracts / Definition of Done

4 new tools that let the model declare testable success criteria upfront and track them. The conversation loop enforces: the model cannot finish until all assertions pass.

**Tools:**
- `ContractCreate` — `{ title: string, brief: string, assertions: string[] }` — declares the contract
- `ContractAssertPass` — `{ index: number, evidence: string }` — marks assertion passed
- `ContractAssertFail` — `{ index: number, evidence: string }` — marks assertion failed
- `ContractStatus` — returns current state of all assertions

**State:** `ContractState` holds title, brief, and assertions array. Each assertion has status: `pending | passed | failed | skipped`.

**Enforcement:** In `conversationLoop.ts`, when the model returns with `stop_reason = end_turn`:
1. Check if a contract exists
2. If any assertions are `pending` or `failed`, inject system message: "Contract incomplete — {N} assertions pending, {M} failed. Continue working." and continue the loop.
3. If all assertions are `passed` or `skipped`, allow the response through.
4. Safety valve: after 3 enforcement rounds, warn but allow completion (prevent infinite loops).

**System prompt integration:** When a contract is active, append to system prompt: "You have an active contract. Check /contract_status before finishing. All assertions must pass."

**Where:** New file `engine/tools/contract.ts` (tools + state). Register in `engine/tools/registry.ts`. Enforcement in `engine/bridge/conversationLoop.ts`.

### 6. Semantic Merge Fallback

When the Edit tool's `old_str` is not found in the target file, instead of immediately returning an error, attempt an LLM-powered merge of the intended change into the current file content.

**Flow:**
1. Edit tool: `old_str` not found in file
2. Read current file content (already available from the Edit attempt)
3. Side query to model: system prompt = "You are a code merger. Apply the intended edit to the current file. Return ONLY the complete updated file content, nothing else." user prompt = "Current file:\n```\n{content}\n```\n\nIntended edit — replace:\n```\n{old_str}\n```\nWith:\n```\n{new_str}\n```"
4. If side query returns valid content (non-empty, different from original), write it
5. Return success with note: "(applied via semantic merge — exact match failed)"

**Guards:**
- Only attempt once per file per turn (prevent merge loops)
- Only attempt if file is under 500 lines (large files = too much context for side query)
- If the merged content is identical to the original, return the original error
- Requires access to `sideQuery()` from conversation loop (passed as dependency)

**Where:** `engine/tools/impl/edit.ts` — fallback path when string match fails. Needs `sideQuery` function injected as a dependency.

### 7. Blocking Command Detection

Refuse to execute bash commands that would start long-running server processes or interactive programs that would hang the session.

**Blocked patterns:**
```
Server processes:
  /^(node|python|python3|bun|deno)\s+.*\b(server\.|app\.)/i
  /(uvicorn|gunicorn|flask\s+run|django.*runserver|rails\s+s|npm\s+start|yarn\s+start|bun\s+run\s+dev|next\s+dev|vite\s+dev)/i

Interactive programs:
  /^(python|python3|node|bun)\s*$/  (bare REPL)
  /(--interactive|-i\s*$)/
```

**Exceptions:** Allow if command contains `--check`, `--version`, `--help`, `test`, `--dry-run`, or ends with `&` (background).

**Response:** "Refused: this would start a long-running process that blocks the session. To test a server, run it in the background with & or use a test/check command instead."

**Where:** `engine/tools/bashSafety.ts` — add patterns to existing dangerous command checks.

## Files Changed

| File | Change |
|------|--------|
| `engine/tools/executor.ts` | Add result capping after tool execution, integrate trust scorer |
| `engine/tools/toolRouter.ts` | **New:** 2-stage category routing |
| `engine/tools/toolScorer.ts` | **New:** Per-tool trust score with Bayesian smoothing |
| `engine/tools/contract.ts` | **New:** Contract tools + state |
| `engine/tools/impl/bash.ts` | Add error diagnosis wrapper |
| `engine/tools/impl/edit.ts` | Add semantic merge fallback |
| `engine/tools/bashSafety.ts` | Add blocking command patterns |
| `engine/tools/registry.ts` | Register 4 contract tools |
| `engine/bridge/conversationLoop.ts` | Integrate routing, contract enforcement, trust decay exclusion |
| `engine/s5/types.ts` | Add `demotedTools: string[]` to S5Input |

## Testing

Each feature is independently testable:
- **Result capping:** Unit test with long/short outputs and different context sizes
- **Tool routing:** Unit test category mapping + integration test with mock model
- **Trust decay:** Unit test Bayesian scoring + persistence
- **Error diagnosis:** Unit test regex classification against real error strings
- **Contracts:** Unit test state machine + integration test enforcement loop
- **Semantic merge:** Integration test with real Edit failure → side query → merge
- **Blocking detection:** Unit test pattern matching against known server commands

## Wire Check

- [ ] Result capping wraps ALL tool outputs in executor.ts
- [ ] Tool routing activates only when contextLength < 32768
- [ ] Trust scores persist to ~/.cynco/training/tool-scores.json
- [ ] Error diagnosis prepends hint on bash exit code != 0
- [ ] Contract tools registered in registry.ts and appear in tool list
- [ ] Contract enforcement fires on stop_reason = end_turn when contract active
- [ ] Semantic merge only attempts once per file per turn
- [ ] Blocking patterns in bashSafety.ts refuse server commands
- [ ] demotedTools appears in S5Input
- [ ] All new tools accessible from model (appear in tool schema)
