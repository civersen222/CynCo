# Dead Code Audit — Regenerated 2026-07-12 (Phase 0b)

Grep evidence pass run 2026-07-12 against `engine/`, `tui/`, `scripts/`, `benchmark/`, and
root config files. All `src/src/localcode/*` paths in the original audit predated the
`src/` → `engine/` reorganization; that directory is now empty and gitignored (see evidence
pass below).

> Legend:
> - **IMPORTED-BY: NONE** — no live import found (tests-only imports noted separately)
> - **DECISION: ALREADY REMOVED** — file no longer exists on disk
> - **DECISION: KEEP — in use** — at least one non-test import found
> - **DECISION: REMOVE — pending approval** — exists, no live imports
> - **DECISION: WIRE (Phase 6)** — standing project decision: wire before considering removal

---

## TypeScript Engine — Dead Files (11 in original audit)

### agents/ — 3 files

#### `engine/agents/cascade.ts`

> Original path: `src/src/localcode/agents/cascade.ts`

- **Disk:** EXISTS at `engine/agents/cascade.ts`
- **IMPORTED-BY (live):** NONE
- **IMPORTED-BY (tests only):** `engine/__tests__/agents/cascade.test.ts` (line 2: `import { shouldCascade, type CascadeDecision } from '../../agents/cascade.js'`)
- Note: `engine/main.ts` imports `./cascade/modelPicker.js` — that is `engine/cascade/` (a separate directory), not `engine/agents/cascade.ts`.
- **DECISION: REMOVE — pending approval**

#### `engine/agents/prism.ts`

> Original path: `src/src/localcode/agents/prism.ts`

- **Disk:** EXISTS at `engine/agents/prism.ts`
- **IMPORTED-BY (live):** `engine/agents/subAgent.ts` line 21: `import { AGENT_PERSONAS, buildAgentPrompt } from './prism.js'`
- **DECISION: KEEP — in use**

#### `engine/agents/vocabulary.ts`

> Original path: `src/src/localcode/agents/vocabulary.ts`

- **Disk:** EXISTS at `engine/agents/vocabulary.ts`
- **IMPORTED-BY (live):** `engine/agents/subAgent.ts` line 22: `import { getVocabulary, formatVocabularyPrompt } from './vocabulary.js'`
- **DECISION: KEEP — in use**

---

### engine/ — 1 file

#### `engine/engine/systemPrompt.ts`

> Original path: `src/src/localcode/engine/systemPrompt.ts`

- **Disk:** MISSING — file does not exist at `engine/engine/systemPrompt.ts`; `systemPromptText.ts` is the live replacement.
- **IMPORTED-BY:** N/A
- **DECISION: ALREADY REMOVED**

---

### vsm/ — 6 files

#### `engine/vsm/difficultyClassifier.ts`

> Original path: `src/src/localcode/vsm/difficultyClassifier.ts`

- **Disk:** EXISTS at `engine/vsm/difficultyClassifier.ts`
- **IMPORTED-BY (live):**
  - `engine/bridge/conversationLoop.ts` line 18: `import { DifficultyClassifier } from '../vsm/difficultyClassifier.js'`
  - `engine/s5/orchestrator.ts` line 3: `import type { DifficultyLevel } from '../vsm/difficultyClassifier.js'`
  - `engine/s5/types.ts` line 1: `import type { DifficultyLevel } from '../vsm/difficultyClassifier.js'`
- **DECISION: KEEP — in use**

#### `engine/vsm/governance.ts` *(replaced by cyberneticsGovernance.ts)*

> Original path: `src/src/localcode/vsm/governance.ts`

- **Disk:** MISSING — `engine/vsm/governance.ts` does not exist; `engine/vsm/cyberneticsGovernance.ts` is the live replacement.
- **IMPORTED-BY:** N/A
- **DECISION: ALREADY REMOVED**

#### `engine/vsm/interventionTracker.ts`

> Original path: `src/src/localcode/vsm/interventionTracker.ts`

- **Disk:** EXISTS at `engine/vsm/interventionTracker.ts`
- **IMPORTED-BY (live):**
  - `engine/vsm/cyberneticsGovernance.ts` line 45: `import { InterventionTracker } from './interventionTracker.js'`
  - `engine/vsm/interventionPersistence.ts` line 4: `import type { InterventionTracker, InterventionCounts } from './interventionTracker.js'`
- **DECISION: KEEP — in use**

#### `engine/vsm/reflexionFeedback.ts`

> Original path: `src/src/localcode/vsm/reflexionFeedback.ts`

- **Disk:** EXISTS at `engine/vsm/reflexionFeedback.ts`
- **IMPORTED-BY (live):** `engine/bridge/conversationLoop.ts` line 19: `import { withReflexion } from '../vsm/reflexionFeedback.js'`
- **DECISION: KEEP — in use**

#### `engine/vsm/testDrivenGov.ts`

> Original path: `src/src/localcode/vsm/testDrivenGov.ts`

- **Disk:** EXISTS at `engine/vsm/testDrivenGov.ts`
- **IMPORTED-BY (live):** `engine/bridge/conversationLoop.ts` line 21: `import { TestDrivenGovernor, shouldNudgeTests } from '../vsm/testDrivenGov.js'`
- **DECISION: KEEP — in use**

#### `engine/vsm/toolGating.ts`

> Original path: `src/src/localcode/vsm/toolGating.ts`

- **Disk:** EXISTS at `engine/vsm/toolGating.ts`
- **IMPORTED-BY (live):** `engine/bridge/conversationLoop.ts` line 20: `import { ToolGating, applyToolGate } from '../vsm/toolGating.js'`
- **DECISION: KEEP — in use**

---

### root — 1 file

#### `engine/macroShim.ts`

> Original path: `src/src/localcode/macroShim.ts`

- **Disk:** MISSING — `engine/macroShim.ts` does not exist; no macro files found at engine root.
- **IMPORTED-BY:** N/A
- **DECISION: ALREADY REMOVED**

---

## Python TUI — Dead Files (4 widgets in original audit)

#### `tui/localcode_tui/widgets/file_preview.py`

- **Disk:** MISSING
- **IMPORTED-BY:** N/A
- **DECISION: ALREADY REMOVED**

#### `tui/localcode_tui/widgets/diff_view.py`

- **Disk:** MISSING
- **IMPORTED-BY:** N/A
- **DECISION: ALREADY REMOVED**
- *Standing note:* diff_view was a Phase 6 WIRE candidate; disk removal means it must be
  rebuilt from scratch in Phase 6 if the feature is reinstated.

#### `tui/localcode_tui/widgets/file_tree.py`

- **Disk:** MISSING
- **IMPORTED-BY:** N/A
- **DECISION: ALREADY REMOVED**

#### `tui/localcode_tui/widgets/project_entry.py`

- **Disk:** EXISTS at `tui/localcode_tui/widgets/project_entry.py`
- **IMPORTED-BY (live):**
  - `tui/localcode_tui/widgets/__init__.py` line 12: `from .project_entry import ProjectEntry`
  - `tui/localcode_tui/screens/vibe_loop.py` line 16: `from ..widgets.project_entry import ProjectEntry`
  - Used at lines 19, 27, 426, 435 of `vibe_loop.py`
- **DECISION: KEEP — in use**

---

## Python TUI — Dead Protocol Types (2 in original audit)

#### `AbortCommand` in `tui/localcode_tui/protocol.py`

- **Defined at:** `protocol.py` line 321
- **IMPORTED-BY (live):**
  - `tui/localcode_tui/screens/vibe_loop.py` line 538: `from ..protocol import AbortCommand` (then called at line 539)
  - `tui/localcode_tui/screens/workspace.py` line 350: `from ..protocol import AbortCommand` (then called at line 351)
  - Also defined as `engine/bridge/protocol.ts` line 364 (TypeScript side, part of union at line 468)
- **DECISION: KEEP — in use** *(was dead 2026-04-24; wired since)*

#### `FileOpenCommand` in `tui/localcode_tui/protocol.py`

- **Defined at:** `protocol.py` line 326
- **IMPORTED-BY (live, Python side):** NONE — no screen or widget imports `FileOpenCommand`
- **IMPORTED-BY (TS side):** `engine/bridge/protocol.ts` line 368–469 (defined + in union type); tested in `engine/__tests__/bridge/protocol.test.ts`
- Note: TS protocol defines it and it participates in the `Command` union; Python side does not use it yet.
- **DECISION: REMOVE — pending approval** *(Python class only; TS definition stays as it's in the union)*

---

## Summary

| Decision | Count | Items |
|---|---|---|
| KEEP — in use | 8 | agents/prism.ts, agents/vocabulary.ts, vsm/difficultyClassifier.ts, vsm/interventionTracker.ts, vsm/reflexionFeedback.ts, vsm/testDrivenGov.ts, vsm/toolGating.ts; AbortCommand (protocol) |
| ALREADY REMOVED | 6 | engine/systemPrompt.ts, vsm/governance.ts, engine/macroShim.ts, file_preview.py, diff_view.py, file_tree.py |
| REMOVE — pending approval | 2 | agents/cascade.ts, FileOpenCommand (Python protocol.py only) |
| KEEP — in use (was dead) | 2 | project_entry.py, AbortCommand *(counted above in KEEP)* |
| WIRE (Phase 6) | 0 | diff_view and file_tree were ALREADY REMOVED — must rebuild if Phase 6 reinstates them |

**Surprising finding:** 7 of 11 TypeScript files the original audit called dead are now
actively imported at runtime (5 VSM files + 2 agent files). Only `agents/cascade.ts` remains
genuinely dead in live code. `AbortCommand` and `project_entry.py` were dead in April and are
now live — wired since the audit was written.

---

## Root src/ Evidence Pass (2026-07-12)

The root `src/` directory is listed in `.gitignore` (lines 37–69 cover `src/`,
`src/_archived_claude_code/`, `src/src/`, `src/.claude/`, `src/thoughts/`).

### (a) Live-code imports pointing into root src/

Search: `grep -rn "localcode/src\b" engine/ tui/ scripts/` → **zero results**.

All `../cybernetics-core/src/index.js` imports in `engine/vsm/*.ts` resolve to the vendored
cybernetics library symlinked under `engine/cybernetics-core/`, not the root `src/` directory.

### (b) package.json / tsconfig / pyproject references

- `package.json` entry point: `bun engine/main.ts` — no `src/` reference.
- No `tsconfig.json` at repo root.
- `tui/pyproject.toml` — no `src/` reference.

### (c) Duplicate module names: src/src/localcode vs engine/

`find src/src/localcode -type f` → **0 files** (directory exists but is empty). The
pre-reorganization source was cleared; `engine/` now holds all live TS modules.

### Content of root src/

```
src/
├── .git/               ← standalone git repo from old LocalCode workspace session
├── .claude/cache/      ← CynCo agent output caches (agents: kraken, oracle, scout, spark)
├── .localcode-*.json   ← debug + SSE log files from an old session
├── .localcode-stream.log
├── _archived_claude_code/  ← pre-reorg TS source (bridgeApi, sessionHistory, etc.)
├── docs/               ← old planning docs (2026-04-01 vintage)
├── src/                ← empty directory (was src/src/localcode/ pre-reorg)
└── thoughts/           ← (not explored, presumably design notes)
```

No live code in `engine/`, `tui/`, `scripts/`, or `benchmark/` holds any import path
that resolves into this directory. The directory is a fossil of the pre-reorganization
workspace.

**VERDICT: EVIDENCE SUPPORTS REMOVAL (no live references found)**

Decision goes to the human — do not delete without explicit approval.
