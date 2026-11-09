# engine/memory

## Purpose
Durable memory for a CynCo/LocalCode engine session: continuity between sessions (ledger + handoffs), a
promotable playbook of learnings (SQLite `LearningStore`), and per-turn thinking/uncertainty capture for
replay and training. Called from `engine/bridge/conversationLoop.ts` (session start/end, recall injection),
`engine/main.ts` (session-end promotion), `engine/daemon/missionRunner.ts` (handoff + thinking capture during
unattended missions), `engine/tools/impl/saveLearning.ts` (the `save_learning` tool), and `engine/tools/contract.ts`
(records contract verdicts for the promotion gate). It must never promote a session's learnings on default-pass
evidence — `promotionGate.ts`'s header documents the prior bug at length: the old gate derived outcome `'viable'`
for any session that had not visibly stalled or dropped tool success below 50%, so a session that did nothing at
all still had its learnings written into long-term memory, mislabeled "ledger-verified" when nothing read a ledger.
It also must never lose or tear a write on crash (`atomicWrite.ts`) and must never block a turn on the network
(`recall.ts`'s embedding lookup has a deadline and falls back to lexical scoring).

## Key files
| File | Role |
|---|---|
| `atomicWrite.ts` | Crash-safe file write: temp file + fsync + rename, used by every persisted-memory writer. |
| `handoff.ts` | Build, serialize/deserialize (YAML-like), and read/write a `Handoff` — the "previous session context" record. |
| `learningStore.ts` | SQLite-backed store of learnings: save/recall/promote/demote, generative-agents-style ranking. |
| `ledger.ts` | Read/write the per-project continuity `Ledger` JSON file and append bounded session history. |
| `lifecycle.ts` | Session start/end orchestration: loads ledger + recent handoffs, writes a handoff and updates the ledger on exit. |
| `promotionGate.ts` | The evidence-based gate deciding whether a session's learnings may be promoted. |
| `recall.ts` | Query the `LearningStore` for relevant learnings and format them for the system prompt. |
| `thinkingRecorder.ts` | Per-turn JSONL persistence of full thinking text + entropy digests, for replay and training. |
| `types.ts` | Shared types: `Handoff`, `Ledger`, `LedgerEntry`, `Learning`, `LearningType`. |
| `uncertaintyTracker.ts` | Per-token Shannon entropy tracking over top-k logprobs, digested per turn per stream. |

## Important types & functions
- **`writeFileAtomic`** (`atomicWrite.ts:9`) — writes a temp sibling, fsyncs it, renames over the target; every writer in this package (ledger, handoff, learning store paths) goes through it so a crash never leaves a torn file.
- **`handoffFromContract`** (`handoff.ts:18`) — turns a `ContractSnapshot`'s passed/failed/pending assertions into a `Handoff`'s `what_was_done`/`what_failed`/`next_steps`; called from `conversationLoop.ts` on session end.
- **`LearningStore`** (`learningStore.ts:114`) — SQLite class with `save`, `promote`, `markHelpful`, `markHarmful`, `demote`, `recall`, `allIncludingInvalidated`, `idsForSession`. `save` treats a duplicate `(type, content)` as reinforcement (bumps `helpful`) rather than inserting a new row.
- **`LearningStore.recall`** (`learningStore.ts:178`) — generative-agents ranking: weighted sum of recency (exponential half-life decay), importance, and relevance (cosine over an optional query embedding, else lexical token overlap), plus a bonus for promoted rows; excludes invalidated rows.
- **`promoteSessionLearnings`** (`learningStore.ts:244`) — promotes every learning saved during a session id, but only when `decision.promote` is true; the decision comes from `promotionGate.ts` so the judgement has exactly one home.
- **`promotionDecision`** (`promotionGate.ts:98`) — the gate itself: requires outcome `'viable'`, at least one contract, all contracts resolved (no failed/pending assertions), and at least one passed assertion (all-skipped does not count as evidence).
- **`recallMemories`** (`recall.ts:18`) — reads the `LearningStore`, optionally embeds the query with a short deadline (falls back to lexical on timeout or embed-server failure), returns `[]` if no db exists yet.
- **`onSessionStart`** / **`onSessionEnd`** (`lifecycle.ts:14`, `lifecycle.ts:39`) — load the ledger plus the last 5 handoff files at start; write a new handoff and update `ledger.current_focus`/`session_history` at end.
- **`ThinkingRecorder`** (`thinkingRecorder.ts:32`) — buffers thinking-delta text per turn, appends one JSONL record on `finalizeTurn` (skipped if empty and no entropy), with static `readTurns`/`readTurn`/`listSessions`/`aggregateSession` for replay and mission-ledger digests.
- **`UncertaintyTracker`** (`uncertaintyTracker.ts:11`) — per-stream (`thinking`/`output`/`tool`) Shannon entropy series over renormalized top-k logprobs; `digest()` reduces a turn's series to mean/max/spike-count, spike defined as `H > mean + 2σ`.

## Data flow
1. **Session start** — `conversationLoop.ts` calls `onSessionStart` (`lifecycle.ts:14`), which reads the ledger (`ledger.ts:19`) and the 5 most recent handoffs (`handoff.ts:137`); it then calls `recallMemories` (`recall.ts:18`) against the `LearningStore` and formats results with `formatRecalledMemories` (`recall.ts:54`) into the system prompt.
2. **During the session** — a learning is saved via `LearningStore.save` (`learningStore.ts:124`, reached through `saveLearning.ts`'s tool implementation or directly); each turn's thinking text and per-stream entropy (`UncertaintyTracker`, `uncertaintyTracker.ts:11`) are appended via `ThinkingRecorder.finalizeTurn` (`thinkingRecorder.ts:55`); `tools/contract.ts` records each finished contract's verdict into `sessionContracts` (`promotionGate.ts:81`) via `verdictOf` (`promotionGate.ts:41`).
3. **Session end** — `main.ts`/`conversationLoop.ts` build a `Handoff` with `handoffFromContract` (`handoff.ts:18`), call `onSessionEnd` (`lifecycle.ts:39`) to write it (`writeHandoff`, `handoff.ts:124`, via `writeFileAtomic`) and update the ledger (`writeLedger`, `ledger.ts:28`).
4. **Promotion** — `promotionDecision` (`promotionGate.ts:98`) evaluates the session's recorded contract verdicts plus outcome; `promoteSessionLearnings` (`learningStore.ts:244`) promotes (`LearningStore.promote`, `learningStore.ts:153`) every learning tied to that session id only if the decision says yes.
5. **Recall/reinforcement in later sessions** — `LearningStore.recall` (`learningStore.ts:178`) scores and returns top-k learnings; a helpful one is reinforced via `markHelpful` (`learningStore.ts:159`), a misleading one is `demote`d (`learningStore.ts:169`) — never deleted.

## Gotchas
- Demote-don't-delete: `demote(id)` sets `invalidated_at` rather than removing the row — "Demote-don't-delete: mark invalid rather than removing the row" (`learningStore.ts:168`). Pinned by `engine/__tests__/memory/learningStorePromote.test.ts` ("demote sets invalidated_at (demote-dont-delete) and hides from active reads").
- Saving a duplicate `(type, content)` is reinforcement, not a new row — "a duplicate (type, content) is reinforcement, not a new row" (`learningStore.ts:126`). Pinned by `learningStorePromote.test.ts` ("duplicate (type, content) save bumps helpful instead of inserting a new row").
- The promotion gate takes a `decision: { promote: boolean }`, not an outcome string, precisely because passing the outcome directly let `'viable'` (the default verdict for a do-nothing session) promote everything — see the header block in `promotionGate.ts:1-27` and the comment on `promoteSessionLearnings` (`learningStore.ts:232-240`). Pinned by `engine/__tests__/memory/promotionWiring.test.ts`.
- A complete contract with every assertion `skipped` still counts as "resolved" by `isComplete()`, but the gate does not treat it as evidence — "Every assertion skipped is a complete contract that verified nothing" (`promotionGate.ts:126`) — it requires at least one `passed` assertion.
- `recall.ts` must never block a turn on the network: the embedding lookup runs under `embedWithDeadline` and silently falls back to lexical scoring on timeout or failure (`recall.ts:27-35`); a missing db returns `[]` rather than throwing (`recall.ts:23`).
- `ThinkingRecorder` files land at `~/.cynco/sessions/<sessionId>.thinking.jsonl` and are swept by the same session GC that matches `*.jsonl` — "GC: gcOldSessions already sweeps *.jsonl in the sessions dir, which matches *.thinking.jsonl — locked in by a test in gcOldSessions.test.ts" (`thinkingRecorder.ts:5-6`).
- `finalizeTurn` writes nothing for a turn with empty buffered text and no entropy (`thinkingRecorder.ts:58`), so an all-tool-call turn with no thinking text can be a silent no-op record.
