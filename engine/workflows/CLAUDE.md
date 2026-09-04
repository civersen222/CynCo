# engine/workflows

## Purpose
Defines `WorkflowEngine`, the phase state machine that drives LocalCode's built-in guided workflows (`/tdd`, `/debug`, `/review`, `/plan`, `/brainstorm`, `/critique`, `/research`). The conversation loop (`engine/bridge/conversationLoop.ts`) owns one `WorkflowEngine` instance per session and consults it every turn to pick the system-prompt override, restrict the active tool set to the current phase's `allowedTools`, and decide when to auto-advance to the next phase via a gate check. `engine/skills/workflowSkill.ts` maps `run_skill` invocations of the 7 built-in skill names onto the same workflow definitions so a skill-triggered workflow drives this engine instead of being flattened into prose. This package must never let a phase's tool restriction leak past its own turn — `getAllowedTools()` is read fresh every iteration, not cached — and must never advance past `maxTurns` without forcing a transition (see Gotchas).

## Key files
| File | Role |
|---|---|
| `engine.ts` | `WorkflowEngine` class: phase state, gate evaluation, tool/prompt overrides, turn counting. |
| `index.ts` | Barrel: re-exports the engine, types, all 7 workflow definitions, and the `WORKFLOWS` command-name lookup table. |
| `types.ts` | Shared types: `Phase`, `WorkflowDefinition`, `WorkflowState`, `GateType`. |

## Important types & functions
- **`WorkflowEngine`** (`engine.ts:9`) — the state machine class; holds `_state: WorkflowState | null` and an optional event callback. Instantiated once per session by `conversationLoop.ts`.
- **`WorkflowEvent`** (`engine.ts:3`) — union of `workflow.started` / `phase_changed` / `completed` / `cancelled` events emitted through the constructor callback.
- **`GateType`** (`types.ts:5`) — union of the four gate kinds a phase can declare: `tool_output` (regex match against a named tool's output), `user_confirm` (never auto-satisfied), `model_done` (satisfied when the model ends its turn), `auto` (always satisfied).
- **`Phase`** (`types.ts:11`) — one phase: `instruction` text injected into the system prompt, optional `allowedTools` restriction, a `gate`, valid `transitions`, and an optional `maxTurns`.
- **`WorkflowDefinition`** (`types.ts:20`) — a named set of phases plus `initialPhase`; this is what `WORKFLOWS` and the skill catalogue hold.
- **`WORKFLOWS`** (`index.ts:23`) — `Record<slashCommand, WorkflowDefinition>` used by the conversation loop to resolve `/tdd`, `/plan`, etc.
- **`getWorkflow`** (`index.ts:34`) — looks up a `WorkflowDefinition` by slash command; called wherever a user-typed command needs to start a workflow.

## Data flow
1. A workflow starts via `WorkflowEngine.start()` (`engine.ts:25`), called from `conversationLoop.ts`'s `startWorkflow()` — either directly for a slash command, or indirectly when `run_skill` resolves a workflow-backed skill through `getWorkflowForSkill()` in `engine/skills/workflowSkill.ts:41`.
2. Each loop iteration, `conversationLoop.ts` calls `getSystemPromptOverride()` (`engine.ts:34`) to prepend the current phase's instruction to the system prompt, and `getAllowedTools()` (`engine.ts:41`) to filter the tool set offered to the model down to that phase's `allowedTools`.
3. After a tool call, `checkGate()` (`engine.ts:70`) is called with the tool name/output (for `tool_output` gates) — it also force-returns `true` if the phase's `turnCount` has reached `maxTurns`.
4. After the model ends its turn, `checkGate()` is called again with `stopReason` (for `model_done`/`auto` gates); `incrementTurn()` (`engine.ts:90`) bumps the per-phase turn counter on every iteration.
5. When a gate is satisfied and the phase has exactly one non-`done` transition, `conversationLoop.ts` calls `advance()` (`engine.ts:45`), which validates the transition against `phase.transitions`, resets `turnCount` to 0, and emits `workflow.phase_changed`.
6. Advancing to the literal target `'done'` clears `_state` and emits `workflow.completed`; `cancel()` (`engine.ts:92`) does the same without requiring a `'done'` transition.

## Gotchas
- `turnCount` is reset to 0 on every `advance()` (`engine.ts:65`, comment: "Reset per-phase turn counter so maxTurns applies to each phase independently") — `maxTurns` is per-phase, not cumulative across the whole workflow. Pinned by `engine/__tests__/workflows/turnCount.test.ts`, which explicitly checks a stale pre-reset counter would have force-advanced early.
- `checkGate()` force-advances (returns `true`) whenever `turnCount >= maxTurns`, regardless of the phase's declared gate type — including `user_confirm`, which otherwise never auto-satisfies. This is how a read-only planning phase gets kicked into execution even if the model never explicitly signals done. Pinned by `engine/__tests__/workflows/turnCount.test.ts` ("maxTurns enforcement in phase2 uses its own per-phase count after reset").
- `advance()` only accepts a target already listed in the current phase's `transitions`, or the literal string `'done'`; every other target throws `Invalid transition` (`engine.ts:57`). Pinned by `engine/__tests__/workflows/engine.test.ts` ("rejects invalid transitions").
- `getAllowedTools()` returns `null` (no restriction) when a phase has no `allowedTools`, not an empty array — callers must treat `null` and `[]` differently. Pinned by `engine/__tests__/workflows/engine.test.ts` ("returns null for allowed tools when phase has no restriction").
- `run_skill` only starts a workflow "when idle so a run_skill mid-workflow can't clobber an active workflow" (`engine/bridge/conversationLoop.ts:3110`) — a second `run_skill` call for a workflow skill while one is already active is a no-op, not a restart.
- The workflow's internal `name` field and its skill/slash-command key can diverge — `workflowSkill.ts` notes "the planning workflow's internal `.name` is 'planning' but its skill/slash is 'plan'" (`engine/skills/workflowSkill.ts:28`).
