# engine/tools

## Purpose
Defines every tool the model can call in an agent turn — file I/O, Bash, Git, search, contract/Definition-of-Done bookkeeping, sub-agents — plus the registry, approval/safety/sealing gates, and the `ToolExecutor` that sits between a model's `tool_use` block and the filesystem/shell. The primary caller is `engine/bridge/conversationLoop.ts`; policy layers (`s5/ruleBasedS5.ts`, `vsm/*`, `agents/trustTier.ts`) narrow which tools are offered but never bypass this package's checks. It must never let a call reach a sealed gate instrument, replace a tool's own error output with engine commentary instead of appending to it, or let the model rewrite the harness contract it is measured against. Shaped directly by F34/F35/F37 (withheld/held-out gate handling), F60 (PowerShell `2>&1`), F136 (missing-file "did you mean"), and F142 (Bash timeout ceiling vs default).

## Key files
| File | Role |
|---|---|
| `approvalGate.ts` | Auto-approve policy per trust/tier; download-command detection and unconditional refusal; per-tool risk rating. |
| `askBroker.ts` | `AskBroker` — human question/answer round trip with timeout, used by AskUser. |
| `askUser.ts` | `AskUser` tool: model poses a clarifying question and blocks on the human's answer. |
| `bashSafety.ts` | Heuristic blocklist for destructive/blocking Bash commands — explicitly not a sandbox. |
| `contract.ts` | Definition-of-Done contract tools (`ContractCreate`/`AssertPass`/`AssertFail`/`Status`) and `ContractState`. |
| `contractVerify.ts` | Verifies contract assertions against real repo state (file/commit/command checks); shell dialect + timeout handling. |
| `doomLoop.ts` | `DoomLoopDetector` — flags a tool call repeated with identical input and no workspace change in between. |
| `errorDiagnosis.ts` | Pattern-based classification of Bash stderr, used only when no test-runner summary was parsed. |
| `executor.ts` | `ToolExecutor` — the single call path: sealed check, immutable-path check, download gate, approval, execute, doom-loop, redact/cap. |
| `loadedToolSet.ts` | `LoadedToolSet` — append-only per-session set of tools surfaced to the model. |
| `registry.ts` | `ALL_TOOLS` array and lookup/filter helpers; builds the model-facing tool schema list. |
| `resultCap.ts` | Truncates long tool output to fit the model's context budget. |
| `sealedPaths.ts` | Four-layer defense keeping held-out gate scripts unreachable (reference/enumeration/location/content). |
| `shellInfo.ts` | Detects the real shell (bash/pwsh/PowerShell 5.1) and translates POSIX-isms into its dialect. |
| `toolHints.ts` | Inline nudges appended to output: prefer Read/Edit over shell string-surgery; CodeIndex adoption hints. |
| `toolRouter.ts` | Two-stage tool-category routing to shrink the schema sent to small-context local models. |
| `toolScorer.ts` | `ToolScorer` — per-tool success-rate tracking with probation-based demotion/reinstatement. |
| `types.ts` | `ToolImpl`/`ToolResult` — the contract every tool and the executor share. |
| `impl/applyPatch.ts` | `ApplyPatch` tool: applies a unified diff via `git apply` (optionally `--check` only). |
| `impl/bash.ts` | `Bash` tool: shell execution, safety check, dialect translation, timeout clamp, failure formatting. |
| `impl/codeIndex.ts` | `CodeIndex` tool: vector/symbol search with regex (rg/grep/PowerShell) fallback. |
| `impl/collectAgent.ts` | `CollectAgent` tool: returns a marker object the conversation loop resolves into a sub-agent's result. |
| `impl/edit.ts` | `Edit` tool: exact string replacement, CRLF-aware, with a near-miss window on failure. |
| `impl/git.ts` | `Git` tool: argv-safe wrapper with dangerous-command/argument-injection blocking and post-commit leftover detection. |
| `impl/glob.ts` | `Glob` tool: `Bun.Glob`-based file pattern matching. |
| `impl/grep.ts` | `Grep` tool: ripgrep-backed regex search with a diagnosable silent-failure message. |
| `impl/imageView.ts` | `ImageView` tool: reads an image and returns base64 for vision models. |
| `impl/indexResearch.ts` | `IndexResearch` tool: embeds and stores a research report into the project vector index. |
| `impl/loadTools.ts` | `load_tools` meta-tool: validates requested extended-tool names for the loop to surface. |
| `impl/ls.ts` | `Ls` tool: directory listing with sizes and bounded-depth recursion. |
| `impl/mfl.ts` | `Mfl` tool: read-only MyFantasyLeague API client with a query allowlist and secret redaction. |
| `impl/multiEdit.ts` | `MultiEdit` tool: batched string replacements across files, same CRLF/near-miss handling as Edit. |
| `impl/notebookEdit.ts` | `NotebookEdit` tool: replaces a Jupyter notebook cell's source/type. |
| `impl/pathHint.ts` | `missingFileHint` — "did you mean" + directory listing for a not-found path. |
| `impl/read.ts` | `Read` tool: line-numbered file read with BOM-aware decoding and an image short-circuit. |
| `impl/replaceFunction.ts` | `ReplaceFunction` tool: replaces a whole function/method body by name, with class-qualified disambiguation. |
| `impl/saveLearning.ts` | `SaveLearning` tool: persists a user preference/correction to the global SQLite LearningStore. |
| `impl/skillTools.ts` | `run_skill`/`list_skills` meta-tools: load a skill's body and declared tools, or list the skill index. |
| `impl/spawnAgent.ts` | `SubAgent` tool: returns a marker object the conversation loop resolves into a spawned sub-agent. |
| `impl/webFetch.ts` | `WebFetch` tool: SSRF-guarded URL fetch (blocks loopback/private/link-local, validates every redirect hop). |
| `impl/webSearch.ts` | `WebSearch` tool: multi-engine search with routing, scoring, and de-duplication. |
| `impl/write.ts` | `Write` tool: full-file write with empty-write rejection and a shrink guard against gutting a tracked file. |

## Important types & functions
- **`ToolImpl`** (`types.ts:29`) — the contract every tool exports: name, description, input schema, approval tier, core/extended flag, `execute`. Implemented by every file under `impl/`.
- **`ALL_TOOLS`** (`registry.ts:34`) — the flat tool registry every lookup/filter function in this file reads.
- **`getToolByName`** (`registry.ts:57`) — registry lookup used by `ToolExecutor`, `approvalGate.ts`, and `load_tools` to resolve a call by name.
- **`ToolExecutor`** (`executor.ts:114`) — turns `(toolName, input)` into a `ToolResult`: sealed check, immutable-path check, download gate, approval, execute, doom-loop check, redaction/cap.
- **`bashTool`** (`engine/tools/impl/bash.ts:129`) — the Bash implementation: safety check, shell-dialect translation, timeout clamp, failure formatting.
- **`bashMaxTimeoutMs`** (`engine/tools/impl/bash.ts:91`) — the hard ceiling any Bash timeout is clamped to, env-raisable up to `HARD_MAX_BASH_TIMEOUT_MS`.
- **`bashDefaultTimeoutMs`** (`engine/tools/impl/bash.ts:121`) — the timeout a Bash call gets when the model doesn't ask for one.
- **`codeIndexTool`** (`engine/tools/impl/codeIndex.ts:67`) — semantic/symbol code search; falls back to `regexFallback` when the vector index returns nothing.
- **`verifyAssertion`** (`contractVerify.ts:169`) — checks a contract assertion against actual repo state; the ground truth behind `ContractAssertPass`.
- **`checkBashSafety`** (`bashSafety.ts:39`) — best-effort blocklist for destructive/blocking commands; explicitly not a sandbox.
- **`ContractState`** (`contract.ts:90`) — Definition-of-Done state machine backing the four Contract* tools; distinguishes unreplaceable `harness` contracts from `auto` ones.
- **`callTouchesSealed`** (`sealedPaths.ts:180`) — refuses any call whose path or Bash text names a withheld gate instrument, its basename, or its gates directory.
- **`shouldAutoApprove`** (`approvalGate.ts:18`) — decides whether a call skips the human approval prompt, given trust profile / approve-all / tool tier.
- **`DoomLoopDetector`** (`doomLoop.ts:11`) — flags a tool call repeated 3+ times with identical input and no intervening workspace change.

## Data flow
1. The conversation loop calls `ToolExecutor.execute(toolName, input)` for a model's `tool_use` block.
2. `getToolByName` (registry.ts) resolves the `ToolImpl`; an unknown name returns an error result immediately.
3. `callTouchesSealed` (sealedPaths.ts) refuses the call outright if it names a withheld gate instrument.
4. `immutableTargetOf` refuses a write to a declared brief/gate path (readable, never writable).
5. A download command (`isDownloadCommand`) is refused under approve-all, or forced through interactive approval.
6. `shouldAutoApprove` decides tier/trust; if not auto, `requestApproval` blocks on the human/UI before proceeding.
7. `tool.execute(input, cwd)` runs the tool's own implementation (e.g. `bashTool`, `editTool`, `codeIndexTool`).
8. A successful workspace-mutating call clears `DoomLoopDetector` state; a failed repeat is checked via `doomLoop.check`.
9. Output is redacted (`redactSealed`), capped (`capToolResult`), and given a CodeIndex-adoption nudge before returning as the final `ToolResult`; `arbiterVerdict` passes through unchanged.
10. `toolScorer.record` logs success/failure for later demotion/probation decisions.

## Gotchas
- `bashSafety.ts` is explicitly "NOT a sandbox — trivially bypassed... The real protection is Bash tier='approval'" — pinned by `bashSafety.test.ts`.
- `Bash` is deliberately absent from `executor.ts`'s `WORKSPACE_MUTATING_TOOLS` even though the shell can write files — a named, accepted blind spot (finding (f)), not an oversight.
- Downloads never ride on approve-all, including the mission driver's — even unattended runs get a refusal naming the staging path (`approvalGate.ts`), pinned by `approvalGate.test.ts`.
- The sealed-gate refusal (F37) is four layers (reference/enumeration/location/content); read-only alone was insufficient because a command can read gate content while spelling no sealed name. Pinned by `sealedPaths.test.ts`.
- A withheld contract assertion's `command` must never appear in a failure message (F34) — naming it would leak every mutation anchor to the model being graded on defeating them.
- A verification command that is killed by its timeout is `unmeasured`, never `contradicted` (F35) — a timeout must not be recorded as a "no". Pinned in `contractVerify.ts`'s own tests.
- `arbiterVerdict: true` marks an honest "not yet" from a declared arbiter so the doom-loop breaker does not fire on a run correctly re-asking the same graded question.
- Windows PowerShell 5.1 has no `&&`/`||`, and a trailing `2>&1` makes a successful command look failed (F60) — `bash.ts` strips it and reports both streams instead. Pinned by `shellInfo.test.ts` and `bash.test.ts`.
- Bash timeouts have two ceilings, not one: `bashDefaultTimeoutMs` (what a call gets unasked) and `bashMaxTimeoutMs` (hard clamp on any override) — F142 was an operator raising one env var while a separate constant still capped it.
- `Write` refuses to shrink a git-tracked file below half its size unless the file is untracked; delete-then-write is the deliberate escape hatch. Pinned by `writeShrinkGuard.test.ts`.
- `Edit`/`MultiEdit` normalize CRLF to LF before matching and restore CRLF on write — without it a multi-line `old_string` never matches a CRLF file. Pinned by `edit.test.ts`, `editNearMiss.test.ts`, `multiEdit.test.ts`.
