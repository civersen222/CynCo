# engine/agents

## Purpose
Implements sub-agents — bounded, forked conversation loops that the main loop dispatches for scouting, research, or specialist work while enforcing their own trust tier and resource limits. `bridge/conversationLoop.ts` and the `SubAgent` tool (`tools/impl/spawnAgent.ts`) are the two callers; `S2Coordinator` gates scheduling (GPU load) and kills/escalates agents that overrun their turn budget. A sub-agent must never report success with empty output — `subAgent.ts` treats zero collected text as a failure even if the loop completed cleanly, "a silent scout must not report success" since the parent acts on the output.

## Key files
| File | Role |
|---|---|
| `advisorRouter.ts` | VSM S2–S5 advisor definitions; decides which advisors fire and formats their advice into a prompt block |
| `prism.ts` | PRISM persona rules (role identity, no superlatives) and prompt assembly for agent personas |
| `queue.ts` | `AgentTask` type and `AgentQueue` — FIFO pending/completed task bookkeeping |
| `runner.ts` | `SubAgentRunner` — pulls tasks off an `AgentQueue` and executes them via an injected run function. No production caller since 2026-11-06: the loop's constructor held a stub that returned a canned string and was never read (GLM review A2); real sub-agents go through `tools/impl/spawnAgent.ts` → `subAgent.ts`. Wire or remove is a `docs/NOW.md` backlog item. |
| `s2Coordinator.ts` | `S2Coordinator` — GPU-based schedule decisions, algedonic (stuck/failure) handling, agent lifecycle and kill enforcement |
| `subAgent.ts` | `SubAgent` — the actual forked model loop: builds prompt, streams model output, executes tools, returns a result |
| `trustTier.ts` | `getToolsForTier` — maps a trust tier to the allowed tool set |
| `types.ts` | Shared types (`SubAgentConfig`, `SubAgentStatus`, `SubAgentResult`, S2 decision types) and config/decision factory functions |
| `vocabulary.ts` | Per-persona domain vocabulary clusters injected into agent prompts |

## Important types & functions
- **`getActiveAdvisors`** (`advisorRouter.ts:169`) — filters the VSM advisor list by each advisor's `shouldFire(state)` condition; called by `runAdvisors`.
- **`runAdvisors`** (`advisorRouter.ts:226`) — queries the model (via injected `askModel`) for every firing advisor and returns a formatted guidance block; called from the main conversation loop, not from within sub-agents.
- **`buildAgentPrompt`** (`prism.ts:76`) — assembles a persona prompt with role first (primacy) and task instruction last (recency), per PRISM rules; called by `SubAgent.run`.
- **`AgentQueue`** (`queue.ts:9`) — FIFO task store with `enqueue`/`dequeue`/`complete`/`fail`; backs `SubAgentRunner`.
- **`SubAgentRunner`** (`runner.ts:10`) — `submit`/`processNext`/`processAll` wrapper around `AgentQueue` and an injected `runFn`.
- **`S2Coordinator`** (`s2Coordinator.ts:30`) — `requestSchedule` (GPU-threshold run/queue decision), `handleAlgedonic` (turn-budget-based absorb/escalate/kill), `registerAgent`/`completeAgent`/`killAgent`/`drainQueue`; used by `conversationLoop.ts`.
- **`SubAgent`** (`subAgent.ts:64`) — the forked loop itself; `run()` is the entry point called by `conversationLoop.ts` after `S2Coordinator.requestSchedule`/`registerAgent`.
- **`getToolsForTier`** (`trustTier.ts:34`) — returns the `ToolImpl[]` a sub-agent is offered and may call: the read-only set for every tier, plus `WebSearch` and `WebFetch` for `specialist` (the researcher) where its third argument, a `ParentToolAuthority`, vouches for them. `full` is not built and runs on the read-only set.
- **`ParentToolAuthority`** (`trustTier.ts:14`) — what the run that starts a sub-agent may itself do unasked: its hard tool pin and its executor's `runsUnasked`. The loop passes it at the `SubAgent` interception; scouts, which are read-only, pass none.
- **`makeSubAgentConfig`** (`types.ts:108`) — factory that fills in `SubAgentConfig` defaults (tool list, maxIterations, maxTokenBudget) per trust tier; called by `spawnAgent.ts` and `conversationLoop.ts`.
- **`makeS2Decision`** (`types.ts:132`) — stamps an `S2Decision` with a timestamp; used throughout `s2Coordinator.ts`.
- **`getVocabulary`** / **`formatVocabularyPrompt`** (`vocabulary.ts:296`, `vocabulary.ts:305`) — look up a persona's domain-term clusters and render them as a prompt line; called by `SubAgent.run`.

## Data flow
1. The `SubAgent` tool (`tools/impl/spawnAgent.ts`) validates a `persona`/`task` request and calls `makeSubAgentConfig` (`types.ts`) to build a `SubAgentConfig`; it returns a JSON payload rather than running the agent itself. `conversationLoop.ts` also builds scout configs directly via `makeSubAgentConfig` for orientation/exploration scouting.
2. `conversationLoop.ts` calls `S2Coordinator.requestSchedule(config.id)` to get a run/queue decision based on polled GPU utilization, then constructs a `SubAgent` and calls `S2Coordinator.registerAgent(agent.status, agent)` so S2 can kill it later.
3. `SubAgent.run()` builds the system prompt from `prism.buildAgentPrompt` plus `vocabulary.formatVocabularyPrompt`, resolves the allowed tool set via `trustTier.getToolsForTier`, and drives a bounded loop (`maxIterations`) calling `localCallModel`, executing tool calls through its own `ToolExecutor`, and reporting turn/token updates to the injected `s2.updateAgentTurn` callback.
4. On repeated tool failures `SubAgent` calls `s2.handleAlgedonic`, which `S2Coordinator.handleAlgedonic` resolves into absorb/escalate/kill based on the agent's turn-budget ratio; a `kill` decision invokes the registered `instance.kill()`.
5. `SubAgent.run()` returns a `SubAgentResult` (success only if not aborted and output is non-empty); the caller calls `S2Coordinator.completeAgent(config.id)` to free the slot and (elsewhere) `S2Coordinator.drainQueue()` promotes any queued agents.

## Gotchas
- Zero collected output is treated as failure even after a clean loop exit — `subAgent.ts` comment: "a silent scout must not report success (parents act on the output; '(no output)' with success:true is a lie)"; pinned by `SubAgent silent-success` tests in `engine/__tests__/agents/subAgent.test.ts`.
- **A sub-agent approves its own calls** (`approveAll` on its own `ToolExecutor`): it has nobody to ask. That is sound only because of what it is given, so anything a tier adds to the read-only set goes through `ParentToolAuthority`: a tool is handed on when the parent run is not pinned away from it and its executor would run it without a question (`ToolExecutor.runsUnasked`; false for every tool in a project chat, where one grade decides each call). With no parent given, nothing is added: a caller that forgets gets a researcher without the web, which shows. Pinned by `agents/trustTier.test.ts` and `agents/subAgent.test.ts` (owner's decision sheet of 2026-11-17, row 22).
- **What a web-reading agent hands back is data.** `SubAgent.run` wraps its output in the untrusted-content lines (`tools/untrusted.ts`) once a `WebSearch` or `WebFetch` it ran has answered, so a page cannot put an instruction to the parent in the researcher's mouth. An agent that only read the repository hands back its words as they are.
- `types.ts` holds the one list per tier (`READONLY_TOOLS`, `SPECIALIST_TOOLS`); `getToolsForTier` builds from them, so the `allowedTools` a config carries and the tools the agent can call agree for the tiers that are built. The `full` list in `makeSubAgentConfig` (Write, Edit, Bash) describes a tier nothing runs.
- Malformed tool-call JSON is never executed with an empty `{}` fallback — `subAgent.ts` runs it through the P1.8 repair ladder (`repairToolCall`/`isMalformedInput`) and returns an `is_error` tool_result instead; pinned by the `SubAgent P1.8 repair-ladder parity` tests in `subAgent.test.ts`.
- `S2Coordinator.handleAlgedonic` kills at turn ratio ≥ 0.9, escalates at ≥ 0.8, otherwise absorbs — enforcement (`instance.kill()`) only happens if the agent was registered with a `kill()`-bearing instance; pinned by `S2 agent kill enforcement` tests in `engine/__tests__/agents/s2Kill.test.ts`.
- `S2Coordinator.drainQueue` stops promoting queued agents as soon as one `requestSchedule` call returns `queue` — it does not skip ahead to check later agents in the queue.
- Stop reaches a sub-agent (F210): `SubAgentOptions.signal` is the turn that started it, and both construction sites in `conversationLoop.ts` pass the turn's signal. When it aborts the agent is killed; `kill()` (also S2's) aborts the agent's own controller, which cancels its model call and is handed to every tool it runs, so a kill lands inside a model call or a tool and not at the next stream event. `ConversationLoop.abort()` also kills every background agent in `runningAgents`, whose own turn has ended. A killed agent reports `success: false` and state `killed`, never `failed`. Pinned by `engine/__tests__/agents/subAgentStop.test.ts` and `engine/__tests__/bridge/abortIsATurnEnd.test.ts`.
