# V1→V2 Bridge — Decision Journals, Provider Interface, Training Pipeline

## Summary

CynCo v1 has recursive sub-agents generating governance decisions at every VSM level. This design adds the infrastructure to capture those decisions as training data, clean up the provider interface for future LoRA adapter support, and commit to a concrete training pipeline triggered by session count thresholds.

**Goal:** Collect per-system (S1-S5) decision data during the v1 audit so that v2 can fine-tune one LoRA adapter per VSM level from real governance traces.

**Architecture:** Parallel decision journals (separate from audit logs) write structured (input, decision, outcome) triples in real-time, already in training format. Provider interface gets optional adapter methods. Training pipeline triggers automatically at 50/100/200 session thresholds.

**Prerequisites:** Recursive sub-agents (built — `docs/superpowers/specs/2026-04-29-recursive-subagents-design.md`).

---

## Decisions

- **D-01:** One fine-tuned LoRA adapter per VSM level (S1-S5), same base model, adapter swap at inference time. Backend TBD (Ollama for now, vLLM/llama.cpp when LoRA hot-swap needed).
- **D-02:** Decision journals are separate from audit logs — different schema, different lifecycle, different consumers. Audit answers "what happened?" Training answers "given this situation, what should the system do?"
- **D-03:** No post-processing needed — each JSONL line is already a (input, decision, outcome) triple in the format LoRA fine-tuning expects.
- **D-04:** Provider interface gets optional adapter methods — OllamaProvider doesn't implement them today, future vLLM/llama.cpp provider will.
- **D-05:** Training pipeline is MUST BUILD with session-count triggers, not a deferred TODO.

---

## 1. Per-System Decision Journals

Each S-level gets its own JSONL journal at `~/.cynco/training/`:

### Journal Entry Schema

```typescript
interface JournalEntry {
  timestamp: number
  sessionId: string
  agentId?: string        // which agent made this decision (null = parent loop)
  system: 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
  input: Record<string, unknown>
  decision: Record<string, unknown>
  outcome?: Record<string, unknown>  // backfilled later for S2/S4
}
```

### What Each Level Captures

**S1 — `s1-decisions.jsonl`** (tool calls)
```
Input:  agent's current messages (summary) + available tools + governance state
Decision: tool name + tool arguments
Outcome: success/error + result snippet + time elapsed
Source: SubAgent.run() after executor.execute(), conversationLoop after executeOneTool()
Volume: ~50-200 entries per session with agents active
```

**S2 — `s2-decisions.jsonl`** (coordinator decisions)
```
Input:  GPU utilization + queue depth + file locks + signal
Decision: run/queue/wait/absorb/escalate/kill + reasoning
Outcome: did the scheduled agent succeed? (backfilled when agent completes)
Source: S2Coordinator.requestSchedule() + handleAlgedonic()
Volume: ~5-20 per session
```
S2 already stores decisions in `s2.getState().decisions` — the journal just flushes them to disk.

**S3 — `s3-decisions.jsonl`** (per-agent governance)
```
Input:  tool success rate (last 20) + stuck count + variety balance + context utilization
Decision: status (healthy/warning/critical) + intervention (none/nudge/escalate/compact)
Outcome: next-turn success rate delta, stuck resolved?
Source: CyberneticsGovernance.onToolResult() per agent
Volume: ~10-50 per session per agent
```

**S4 — `s4-decisions.jsonl`** (strategy evolution)
```
Input:  session summary + strategy config + performance metrics + structural coupling
Decision: strategy mutation (keep/crossover/mutate) + viability assessment
Outcome: next-session performance with this strategy (backfilled)
Source: S4Reflector + ConfigPopulation at session end
Volume: ~1 per session (outcome backfilled when next session with that strategy completes)
```

**S5 — `s5-decisions.jsonl`** (policy decisions)
```
Input:  S5Input (user message, workflow, phase, context%, governance status, latency trend)
Decision: S5Decision (workflow, contextAction, tools, priority, reasoning)
Outcome: session success + task completion + governance stability over next N turns
Source: S5Orchestrator/RuleBasedS5 — already structured in trainingData.ts
Volume: ~5-15 per session
```

---

## 2. Decision Journal Writer

One module: `engine/training/decisionJournal.ts`

### File Layout

```
~/.cynco/training/
├── s1-decisions.jsonl
├── s2-decisions.jsonl
├── s3-decisions.jsonl
├── s4-decisions.jsonl
└── s5-decisions.jsonl
```

### Writer Interface

```typescript
class DecisionJournalWriter {
  constructor(trainingDir: string)  // defaults to ~/.cynco/training/

  /** Append a complete decision record. */
  log(entry: JournalEntry): void

  /** Append a backfill record that adds outcome to a previous entry. */
  backfill(system: JournalEntry['system'], entryTimestamp: number, outcome: Record<string, unknown>): void

  /** Flush all pending writes. */
  flush(): void
}
```

Append-only with fsync after each write, same pattern as the existing audit logger.

### Tap Points

No new data flows — the journal writer taps into existing code:

| System | Tap Location | When |
|--------|-------------|------|
| S1 | `SubAgent.run()` after `executor.execute()` | Every agent tool call |
| S1 | `conversationLoop.ts` after `executeOneTool()` | Parent loop tool calls |
| S2 | `S2Coordinator.requestSchedule()` + `handleAlgedonic()` | Every scheduling/algedonic decision |
| S3 | `CyberneticsGovernance.onToolResult()` | Per governance update |
| S4 | `S4Reflector` at session end | Once per session |
| S5 | `S5Orchestrator.makeDecision()` | Per S5 invocation |

### Outcome Backfill

S2 and S4 decisions need outcomes from later events:
- S2 scheduling outcome: written when `S2Coordinator.completeAgent()` is called
- S4 strategy outcome: written when the next session with that strategy config completes

Backfill records are appended as `{ _backfill: true, entryTimestamp, outcome }`. The training extraction script merges entry + backfill by timestamp during export.

---

## 3. Provider Interface Cleanup

### Additions to `engine/provider.ts`

```typescript
export interface Provider {
  // ... existing methods unchanged ...

  /** Load a LoRA adapter by name (e.g., 's3-lora'). Optional — not all backends support this. */
  loadAdapter?(adapterId: string): Promise<void>

  /** Unload the current LoRA adapter. */
  unloadAdapter?(): Promise<void>

  /** Return the currently loaded adapter ID, or null if none. */
  activeAdapter?(): string | null
}
```

These are optional methods. `OllamaProvider` does not implement them — Ollama doesn't support LoRA hot-swap. When a vLLM or llama.cpp provider is built for v2, it implements all three.

### Usage Pattern (v2)

```typescript
// S5 decides this is an S3 monitoring decision
if (provider.loadAdapter) {
  await provider.loadAdapter('s3-lora')
}
// Make the S3 decision call
const result = await provider.complete(s3Request)
// Unload adapter
if (provider.unloadAdapter) {
  await provider.unloadAdapter()
}
```

The conversation loop checks `if (provider.loadAdapter)` before calling — backward compatible with any provider that doesn't support adapters.

---

## 4. V2 Training Pipeline — MUST BUILD

**This section is a binding commitment, not a nice-to-have.**

### Stage 1: Decision Journals (trigger: 50 sessions)
- Wire the journal writer from Section 2 into the 6 tap points
- Start collecting (input, decision, outcome) triples for all 5 S-levels
- Validate: `wc -l ~/.cynco/training/s*.jsonl` shows data accumulating

### Stage 2: Training Extraction (trigger: 100 sessions)
- Extend existing `scripts/aggregate_training_data.py` to read from decision journals
- Output format: `{"prompt": "<S-level input>", "completion": "<decision JSON>"}` per system
- Split by system: one training set per S-level
- Validate: each training set has 500+ examples with outcome data

### Stage 3: LoRA Fine-tuning (trigger: 200 sessions)
- One LoRA adapter per S-level trained on its decision journal
- Base model: whatever is running at that point
- Training: `scripts/train_lora.py` — wraps unsloth/peft, takes training JSONL + base model, outputs adapter weights
- Validation: hold out 20% of decisions, measure accuracy vs rule-based baseline
- Integration: `provider.loadAdapter()` → S5 routes decisions to correct adapter

### Tracking Mechanism

Add a startup check in `engine/main.ts` that counts sessions in governanceDb. When thresholds are hit, log a prominent message:

```
[v2] 50 sessions reached — decision journals ready to wire
[v2] 100 sessions reached — training extraction pipeline due
[v2] 200 sessions reached — LoRA fine-tuning pipeline due
```

Not a silent TODO. An active reminder every time the engine starts once the threshold is passed.

### Dependencies
- Recursive sub-agents (BUILT — creates the multi-agent decision surface)
- Decision journals (this design, Section 2)
- Serving backend with LoRA hot-swap (vLLM or llama.cpp — selected at Stage 3)

### Timeline
- Stage 1 at ~2 weeks of regular use
- Stage 2 at ~4 weeks (end of Beer viability audit)
- Stage 3 at ~8 weeks

**This is not deferred. This is scheduled. The session counter is the trigger.**

---

## New Files

| File | Purpose |
|------|---------|
| `engine/training/decisionJournal.ts` | JournalEntry type + DecisionJournalWriter class |
| `engine/training/types.ts` | Shared training types (JournalEntry, BackfillRecord) |

## Modified Files

| File | Changes |
|------|---------|
| `engine/provider.ts` | Add 3 optional adapter methods to Provider interface |
| `engine/agents/subAgent.ts` | Tap S1 journal after tool execution |
| `engine/agents/s2Coordinator.ts` | Tap S2 journal after decisions |
| `engine/vsm/cyberneticsGovernance.ts` | Tap S3 journal after governance updates |
| `engine/vsm/s4Reflector.ts` | Tap S4 journal at session end |
| `engine/s5/orchestrator.ts` | Tap S5 journal after decisions |
| `engine/bridge/conversationLoop.ts` | Tap S1 journal for parent loop tool calls |
| `engine/main.ts` | Session count threshold checks + journal initialization |

## Existing Infrastructure (reused)

| Component | File | Role |
|-----------|------|------|
| Training data extraction | `engine/s5/trainingData.ts` | S5 decision pair formatting (extend for all levels) |
| Control vector training | `scripts/train_control_vectors.py` | L2 behavioral steering (extend for LoRA) |
| Governance DB | `engine/vsm/governanceDb.ts` | Session counting for threshold triggers |
| Audit logger | `engine/audit/auditLogger.ts` | Pattern reference for append-only JSONL writing |
| Strategy memory | `engine/vsm/strategyMemory.ts` | S4 outcome backfill source |
