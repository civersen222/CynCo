# Prediction Tracker Redesign + Dashboard-as-UI

> Two independent subsystems in one spec. Predictions can ship first (smaller), dashboard UI second (larger).

## 1. Prediction Tracker Redesign (H1-H8)

### Problem

All 8 hypotheses always show red/negative because they predict outcomes disconnected from actual system behavior. Triggers are rare, evaluation windows don't match recovery timescales, and null baselines are guesses.

### Design: 3 Categories, 8 Hypotheses

#### Governance Effectiveness

**H1 — Stuck Escape**
- Trigger: stuck >= 5 AND C7 restricts tools
- Predict: Edit/Write happens within 3 turns
- Null baseline: empirical from governance DB
- Fires: ~2-5x per task

**H2 — Nudge Response**
- Trigger: governance nudge injected (steering queue message)
- Predict: tool type changes on next call (different from last 3)
- Null baseline: 50%
- Fires: every nudge

**H3 — Contract Completion**
- Trigger: contract auto-created from user message
- Predict: all assertions pass within 20 iterations
- Null baseline: empirical from session history
- Fires: once per task

#### Model Predictability

**H4 — Read-to-Edit**
- Trigger: 3+ consecutive Read calls on same file
- Predict: Edit follows within 2 turns
- Null baseline: empirical
- Fires: frequently during read loops

**H5 — Thinking Efficiency**
- Trigger: thinking tokens > 100 in a turn
- Predict: next tool call is action tool (Edit/Write/Bash), not Read
- Null baseline: 30%
- Validates: reasoning budget cap effectiveness

#### Parameter Tuning

**H6 — Temperature Effect**
- Trigger: temperature lowered for stuck turn
- Predict: model produces different tool than last 3 calls
- Null baseline: 33%
- Fires: when variety control kicks in

**H7 — S4 Reflection ROI**
- Trigger: S4 reflection runs
- Predict: model behavior changes within 3 turns (different tool mix)
- Null baseline: 50%
- Measures: whether 6-second reflection overhead is justified

**H8 — Session Improvement**
- Trigger: session end (clean shutdown)
- Predict: edits-per-minute > rolling average from last 5 sessions
- Null baseline: 50%
- Tracks: cross-session learning

### Implementation

- `engine/vsm/predictionTracker.ts` — rewrite trigger/evaluation logic
- Null baselines bootstrapped from governance DB on startup, not hardcoded
- Wilson score CI for statistical significance (keep existing math)
- Verdict display: "better than null" (green), "need more data" (gray), "worse than null" (red)
- Minimum 10 samples before showing a verdict
- Dashboard rendering unchanged (table format works)

---

## 2. Dashboard-as-UI: Tabbed Architecture

### Problem

The dashboard is monitoring-only. The user wants to send prompts and see tool output in the same interface, alongside governance metrics.

### Design: 4 Tabs

#### [Chat] Tab — Primary Interaction

- **Message input** at bottom, sends `{ type: "user.message", text, cwd }` over existing WebSocket
- **CWD selector** at top (text input with last-used paths dropdown)
- **Workflow commands** via input prefix: `/plan`, `/tdd`, `/debug`, `/cancel`
- **Message rendering:**
  - User messages: left-aligned, muted color
  - Thinking tokens: muted italic block, collapsed by default, click to expand
  - Tool calls: inline collapsed rows — `✓ Edit game.py +25 lines [2ms] ▼` — click to expand full input/output
  - Model text: normal weight, left-aligned
  - Errors: red background row
- **Events consumed:** `stream.token`, `stream.thinking` (new), `tool.start`, `tool.complete`, `message.complete`, `approval.request`
- **New event:** `stream.thinking` — emitted for thinking/reasoning tokens so chat can display them separately from text output

#### [Governance] Tab — Current Dashboard

All existing panels moved here unchanged:
- Context Utilization + tok/s badge
- Governance Health
- S5 Decision Log (now populated)
- Variety Control, GBNF Grammar, Best-of-N, Training Data
- Tool Activity "The Brain"
- Prediction Tracker (H1-H8 redesigned)
- Active Contract

#### [History] Tab — Session Analytics

- Session selector dropdown (existing)
- Per-session metrics chart (existing)
- Session transcript viewer: read-only replay of past conversations from JSONL session files
- Aggregate stats: total tasks, avg completion time, success rate trend across last 20 sessions

#### [Config] Tab — Parameters

All existing controls moved here unchanged:
- Engine Config sliders (temperature, context length, timeout)
- System Controls toggles (tool routing, contract enforcement, VSM governance)
- Kill Switch / Trust Decay / S4 Reflection sliders
- Advanced Governance Parameters accordion

### Architecture

- Single `index.html` file — tab switching via JS, no framework
- Chat input reuses existing WebSocket connection (already bidirectional)
- All existing event handlers still work — Chat tab adds new render paths
- TUI continues to work independently — dashboard is alternative UI, not replacement
- Thinking token visibility requires engine change: emit `{ type: "stream.thinking", text }` for reasoning tokens (currently suppressed in conversationLoop.ts)

### File Changes

- `engine/dashboard/index.html` — add tab system, Chat tab with message rendering, reorganize existing panels into Governance/History/Config tabs
- `engine/bridge/conversationLoop.ts` — emit `stream.thinking` events for reasoning tokens
- `engine/bridge/protocol.ts` — add `stream.thinking` event type
- `engine/vsm/predictionTracker.ts` — rewrite H1-H8 with new triggers/evaluations
- `engine/dashboard/server.ts` — add `/api/session-transcript/:id` endpoint for History tab

### Success Criteria

- User can send messages from the browser and see full tool output + thinking
- Governance, predictions, history, config accessible via tabs without page reload
- All 8 predictions fire frequently and show meaningful verdicts within a single task
- Existing TUI still works unchanged
