# engine/bridge

## Purpose
This package is the CynCo engine's spine: `ConversationLoop` drives the user-message → model-call → tool-execution → governance cycle, `protocol.ts` defines the WebSocket wire contract with the Python TUI, and `server.ts` is the loopback-only WebSocket transport that carries it. Everything else in the directory is a small, independently-tested pure-function helper the loop calls into — nudge text, contract auto-creation, tool-floor restoration, commit pressure, iteration budgets — kept separate so each rule can be pinned by its own unit test instead of living only inside a 4,300-line class. It must never let a browser speak to the bridge socket, never silently drop a refused command frame, never let `processing` get stuck `true` after a throw, and never treat "engine measured nothing" as "engine measured zero". Failure-log entries that shaped it: F15, F16, F32, F33, F37, F40, F41, F43, F52, F59, F89, F92, F110, F131 (see `docs/cynco-failure-log.md`).

## Key files
| File | Role |
|---|---|
| `conversationLoop.ts` | Core `ConversationLoop` class: the whole message→model→tool→governance cycle. |
| `protocol.ts` | Wire types for `EngineEvent`/`TUICommand`, plus `serializeEvent`/`parseCommand`. |
| `server.ts` | `LocalCodeWSServer` — loopback WebSocket transport with origin/token/single-client checks. |
| `contractAutoCreate.ts` | Intent-classifies a user message into contract assertions; applies harness contracts; computes sealed/read-only gate paths. |
| `commandSchema.ts` | Per-`TUICommand`-variant shape validator, shared by the bridge and dashboard sockets. |
| `testSummary.ts` | Single source of truth for parsing test-runner output (framework, pass/fail counts). |
| `configHandlers.ts` | Handlers for `config.*`/`profile.*` TUI commands. |
| `commitPressure.ts` | Notices for a run that is working and not committing. |
| `toolFloor.ts` | Restores tools contract enforcement needs after any narrowing layer removed them. |
| `guardianRules.ts` | Vibe-mode risk classification (`safe`/`risky`/`dangerous`) for tool calls. |
| `iterationBudget.ts` | Stateless 70%/90% notices telling the model its iteration budget is running out. |
| `s5Restriction.ts` | Scopes S5's pre-loop tool restriction to the single iteration it was decided for. |
| `nudgeDecision.ts` | Decides whether to nudge a model that ended its turn without calling a tool. |
| `enforcementNudge.ts` | Phase-aware contract-enforcement nudge text (authoring phases get different wording). |
| `commitScope.ts` | Refuses repo-wide `git add -A` / `git commit -a` staging. |
| `benignToolResult.ts` | Distinguishes a red test suite / failed verification check from a genuine tool fault. |
| `toolErrorLog.ts` | Formats one reconstructable log line per tool error (command, classification, redacted payload). |
| `contextHygiene.ts` | Prunes redundant Read+DENIED exchange pairs from context. |
| `contextFloor.ts` | Floors the guessed prompt-token estimate with the server's last measured count. |
| `summaryInjection.ts` | Decides when to inject a "summarize what you did" follow-up message. |
| `memoryEvents.ts` | Pure formatters for `memory.recalled`/`memory.written` protocol events. |
| `sideQuery.ts` | Request/response shaping for the non-tool side query (compaction summaries). |
| `steeringQueue.ts` | `SteeringQueue` — priority-interrupt and follow-up queues for the model loop. |
| `tokenTotals.ts` | Session-lifetime measured token totals (prefill/cache/decode), never chars/4 estimates. |
| `finalizeGuard.ts` | `runWithFinalize` — guarantees a finalizer runs exactly once regardless of exit path. |
| `capabilities.ts` | Measures what this build can actually enforce (sealed gates, S5 advisory-only) rather than declaring it. |

## Important types & functions
- **`ConversationLoop`** (`conversationLoop.ts:247`) — the class; owns the message array, governance, contract state, and the model loop for one engine session.
- **`ConversationLoop.handleUserMessage`** (`conversationLoop.ts:879`) — public entry point; guards re-entrancy, wraps `runUserMessage` in `runWithFinalize` so `processing` always clears and the trajectory always finalizes.
- **`ConversationLoop.runUserMessage`** (`conversationLoop.ts:902`) — per-message setup: pushes the user message, applies/auto-creates the contract, sets sealed/read-only gate paths, then calls into the model loop.
- **`ConversationLoop.runModelLoop`** (`conversationLoop.ts:1956`) — the iteration loop: stuck-loop tiers, iteration-budget notices, model call, tool dispatch, contract enforcement rounds, `message.complete`.
- **`ConversationLoop.executeOneTool`** (`conversationLoop.ts:3536`) — executes one tool call: malformed-input repair ladder, allowedTools/S5/governance refusal checks, commit-pressure accounting, `toolCallsTotal` increment, `tool.start`/`tool.complete` emission.
- **`ConversationLoop.toolCallCount`** (`conversationLoop.ts:633`) — getter exposing `toolCallsTotal`; the dashboard's iteration-budget gauge.
- **`EngineEvent`** (`protocol.ts:490`) — discriminated union of every engine→TUI event type (`session.ready`, `tool.start`, `message.complete`, etc.).
- **`TUICommand`** (`protocol.ts:681`) — discriminated union of every TUI→engine command type.
- **`parseCommandResult`** (`protocol.ts:732`) — parses and shape-validates a command frame, returning the refusal reason rather than swallowing it (F32).
- **`maybeAutoCreateContract`** (`contractAutoCreate.ts:197`) — intent-classifies a user message into a DoD contract when no incomplete contract is already active.
- **`applyHarnessContract`** (`contractAutoCreate.ts:339`) — installs a mission-driver-supplied contract, refusing one with an unrunnable verification command.
- **`LocalCodeWSServer`** (`server.ts:23`) — the bridge's WebSocket server: loopback-only, token-gated, single-client, refuses any request carrying an `Origin` header.
- **`applyToolFloor`** (`toolFloor.ts:80`) — restores `Bash`/`ContractAssertPass`/`ContractAssertFail`/`ContractStatus` (and a file-mutation tool, if the contract needs one) whenever any upstream narrowing layer dropped them during active enforcement.

## Data flow
1. A `user.message` frame arrives on the bridge socket, is shape-checked by `parseCommandResult` (`protocol.ts:732`, via `validateCommand` in `commandSchema.ts`), and dispatched to `ConversationLoop.handleUserMessage` (`conversationLoop.ts:879`).
2. `handleUserMessage` guards re-entrancy and calls `runUserMessage` (`conversationLoop.ts:902`) inside `runWithFinalize` (`finalizeGuard.ts:12`) so the trajectory finalizer always runs.
3. `runUserMessage` pushes the message, applies a harness contract or auto-creates one via `maybeAutoCreateContract` (`contractAutoCreate.ts:197`), sets sealed/read-only gate paths, and hands off to `runModelLoop` (`conversationLoop.ts:1956`).
4. `runModelLoop` iterates: it checks stuck-loop tiers, injects iteration-budget notices (`iterationBudget.ts:29`) and commit-pressure notices (`commitPressure.ts`), then calls the model via `localCallModel` (`../engine/callModel.js`).
5. Each tool call the model emits is dispatched through `executeOneTool` (`conversationLoop.ts:3536`), which runs the malformed-input repair ladder, the allowedTools/S5-restriction/governance refusal checks, executes the tool, and reports the outcome to `this.governance.onToolResult`.
6. When the model stops without further tool calls, contract enforcement rounds (via `enforcementNudgeText`, `enforcementNudge.ts:19`) may re-enter the loop up to a bounded count; otherwise the loop emits `message.complete` (`conversationLoop.ts:2996` et al.) and `governance.session_fidelity`, and control returns up through `runWithFinalize`'s `finalize` callback (`finalizeTrajectory`, `conversationLoop.ts:3426`).

## Gotchas
- The bridge socket refuses ANY request carrying an `Origin` header before upgrade — "A page cannot suppress Origin on a WebSocket handshake; the Python client never sends it" (`server.ts`); this is pinned by `serverBinding.test.ts` and `serverAuth.test.ts`.
- A refused command frame is sent back down the socket, not just logged — a driver once waited out a 13-minute timeout against a validator that had refused instantly (F32); pinned by `refusalReachesTheSender.test.ts`.
- `processing` must clear on every exit path of `handleUserMessage`, not just the happy one, or the session is bricked silently for every later message (see comment at `conversationLoop.ts:886`).
- `iterationBudgetNotice` and `commitPressureNotice` are deliberately stateless pure functions of the iteration/call count — "so it fires exactly once per threshold with no flags to get out of sync" (`iterationBudget.ts`, `commitPressure.ts`); pinned by `iterationBudget.test.ts`, `commitPressure.test.ts`, `commitPressureWiring.test.ts`.
- `commitPressureDue` matches on "crossed the threshold", not `=== period`, because tool calls can arrive in batches and would step straight over an exact-match check (`commitPressure.ts`).
- The pre-loop S5 tool restriction (`s5Restriction.ts`) applies ONLY on the iteration it was decided for (`iterationIndex === 0`); a stale reading taken before the task started must not hold for 70 turns (F-finding (j)); pinned by `s5RestrictionLifetime.test.ts`.
- `applyToolFloor` restores `Bash`/`ContractAssertPass`/`ContractAssertFail`/`ContractStatus` whenever enforcement is active, because eight independent layers can narrow the offered tool set and none of them knows enforcement needs those tools; `Bash` alone never satisfies the file-mutation floor — pinned by `toolFloor.test.ts`, `toolFloorTaskAchievable.test.ts`.
- `isBenignTestFailure`/`isDeclaredVerificationCheck` (`benignToolResult.ts`) exist because a red pytest run or a "no" from a verification command both surface as `isError=true`, and counting either as a tool fault previously HALTed a run mid-repair; pinned by `benignToolResult.test.ts`.
- `checkCommitScope` (`commitScope.ts`) refuses `git add -A`/`-u`/`.`/`*` and `git commit -a`/`--all`, but is true-by-default for anything unrecognized; pinned by `commitScope.test.ts`.
- `UNPRODUCTIVE_NUDGE_LIMIT = 3` in `nudgeDecision.ts` is the backstop when both "model says done" and "contract complete" fail at once — the counter must be cleared by ANY tool call, not only a file mutation, or a long measurement phase burns the whole budget before real work starts; pinned by `nudgeDecision.test.ts`, `nudgeMeasurementPhase.test.ts`.
- `promptTokensWithFloor` (`contextFloor.ts`) treats the server's last reported `prompt_tokens` as a FLOOR, not a correction factor, and discards it once the conversation has shrunk (compaction, read-loop prune, best-of-N rollback) rather than trusting a stale measurement.
- The side query (`sideQuery.ts`) must send `enable_thinking: false` (not `/no_think` or `reasoning_effort: 'none'`, both rejected/ignored by this server's template) or compaction summaries come back empty/truncated (F92); pinned by `sideQuerySummary.test.ts`.
- `contractAutoCreate`'s change/create/delete verb detection is intentionally proximity- and sentence-scoped, not message-wide — a bare filename mention anywhere used to manufacture an unsatisfiable "file was modified" assertion; pinned by `contractAutoCreate.test.ts`.
- `withheldGatePaths` seals a held-out gate as unreadable/unlistable/unrunnable, not merely read-only — read-only still let a run `cat` and learn from a gate it was being scored against (F37).
- `governanceCapabilities` (`capabilities.ts`) MEASURES what a build can enforce by probing a fabricated sealed path, rather than declaring capabilities as a hardcoded list — a correct-looking build had shipped without its guarantee actually wired in (F41).
