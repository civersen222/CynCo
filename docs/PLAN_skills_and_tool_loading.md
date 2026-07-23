# Skills System + On-Demand Tool Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add (1) on-demand tool loading over the existing canonical tool registry and (2) a shareable Skills system ported from Hearth, then wire both into the S5 governance engine so S5 can enforce per-skill tool allowlists and proactively surface tools from governance state.

**Architecture:** The registry (`engine/tools/registry.ts`) already is the single source of truth. We add a `core`/`extended` split, a `load_tools` meta-tool, and a per-turn *loaded-tools set* on the conversation loop. Skills are directories (`SKILL.md` + frontmatter) discovered at startup; only the one-line description enters the prompt until `run_skill` loads the body and surfaces the skill's declared tools through the same load-tools channel. S5 gains an opt-in `PROACTIVE_SURFACING` responsibility that reads governance state + task class and pre-loads a predicted-useful tool set, journaling `(state, surfaced-tools, outcome)` triples for future LoRA training.

**Tech Stack:** TypeScript (strict, ESM), Bun runtime, vitest, `yaml` (already present — promoted dep→runtime), `ws`, existing GitHub-API `fetch` pattern. **No new runtime dependencies.** `zod` is NOT in the repo → frontmatter validated with a hand-written type-guard, not Zod.

---

## GROUNDING CORRECTIONS — premises in the task that the current code has already resolved

Read this first: three things the task asks us to "fix" are **already done** on `main`. The plan does NOT redo them; it verifies and moves on. Ignoring this would mean re-introducing churn and false doc edits.

1. **The 19-vs-25 tool-name drift is already fixed.** `engine/s5/ruleBasedS5.ts:14` is now `export const ALL_TOOL_NAMES = ALL_TOOLS.map(t => t.name)` importing from `../tools/registry.js`. There is **no hardcoded array** left to replace. The registry (`engine/tools/registry.ts:32`) lists **26** tools. → Phase 1's "replace hardcoded ALL_TOOL_NAMES" task is already satisfied; we keep a guard test so it can never regress.
2. **README already says "26 built-in" and the list is correct** (README.md:291-292). The task's "25" is stale. → Phase 5's tool-count "fix" is a **no-op**; we only *add* the new count for `core` vs `extended`.
3. **README already says "21 rules" in all four places** (README.md:15,135,198,310) and there really are 21 rules (C1–C7=7, W1–W9=9, I1–I5=5). The "21 vs 20" drift the task describes **does not exist**. → Phase 5's rule-count "fix" is a **no-op**; verify only.

These are surfaced again in §6 (Assumptions) and §7 (Reordering).

---

## 1. Confirmed understanding of the two features and their coupling

**Feature A — On-demand tool loading.** Today every tool in `ALL_TOOLS` is offered to the model every turn (filtered only *down* by workflow `allowedTools`, caller pins, S5 restrictions, tool-gating, and category routing — see `conversationLoop.ts:769-781, 994-1003, 1713-1861`). We invert the default: a small **core** set is offered up front; **extended** tools stay behind a `load_tools(["Bash",…])` meta-tool the model calls to pull their schemas in. `LOCALCODE_ALL_TOOLS=true` restores today's "everything up front" behavior (Hearth's `HEARTH_ALL_TOOLS=1` parity). S5's *reactive restriction* (doom-loop exclusion, stuck-escape, variety) is unchanged — it still intersects against whatever is currently loaded.

**Feature B — Skills.** A skill is a folder with `SKILL.md` (frontmatter: `name, description, version?, author?, tools[]`) plus optional `scripts/ references/ assets/`. At startup we scan a bundled `engine/skills/builtins/` and a workspace `~/.cynco/skills/`; only each skill's one-line `description` enters the prompt (a **skill-index block**). `run_skill("name")` loads the full `SKILL.md` body into context and surfaces the skill's `tools[]` via Feature A's mechanism. `/skill list|install|new|remove` manage skills; `install` fetches a GitHub repo, validates frontmatter, flags risky tools, and asks for confirmation.

**The coupling (why they ship together):** A skill's `tools[]` is meaningless without on-demand loading — Feature B *is a consumer* of Feature A. `run_skill` calls the same internal "surface these tool names for subsequent turns" function that `load_tools` exposes to the model. And S5 (Feature C, Phase 3) sits above both: it can (a) **enforce** a skill's declared allowlist (restrict the loaded set to the running skill's `tools[]`) and (b) **proactively surface** tools by name through the identical channel — one `surfaceTools(names: string[])` primitive, three callers (`load_tools`, `run_skill`, S5 proactive).

**The single integration point** is a new `LoadedToolSet` owned by `ConversationLoop`: a `Set<string>` of tool names, seeded with core tools each session, mutated only by appends (never per-turn resets), read when computing `activeTools` per turn. All three features write to it; the append-only prompt invariant (§3) governs how its growth reaches the model.

---

## 2. Exact files created / modified / deleted, per phase

### Phase 1 — Core/extended split + load_tools + LOCALCODE_ALL_TOOLS
**Create**
- `engine/tools/loadedToolSet.ts` — `LoadedToolSet` class (seed core, `surface(names)`, `has(name)`, `names()`, `snapshot()`).
- `engine/tools/impl/loadTools.ts` — the `load_tools` meta-tool (`ToolImpl`, `core: true`).
- `engine/__tests__/tools/loadedToolSet.test.ts`, `engine/__tests__/tools/loadTools.test.ts`.
- `engine/__tests__/guards/toolRegistryDrift.test.ts` — guard: `ALL_TOOL_NAMES` equals registry names (locks in the already-fixed drift) **and** every tool has an explicit `core` boolean.
- `engine/__tests__/tools/coreDefault.test.ts` — per-turn tool block = core only by default; extended appear only after `load_tools`.

**Modify**
- `engine/tools/types.ts` — add `core: boolean` to `ToolImpl`.
- `engine/tools/registry.ts` — set `core` on every tool; add `load_tools`; add `getCoreTools()` / `getExtendedTools()` helpers.
- `engine/tools/impl/*.ts` (26 files) — add `core: true|false` to each `ToolImpl` literal. (Mechanical; the guard test enforces completeness.)
- `engine/config.ts` — add `export function isAllToolsEnabled(): boolean` (`LOCALCODE_ALL_TOOLS === 'true'`, default false).
- `engine/bridge/conversationLoop.ts` — construct `this.loadedTools = new LoadedToolSet(...)`; replace the `let activeTools = ALL_TOOLS` seed (line ~770) with core-or-all + loaded; handle a `load_tools` call by `this.loadedTools.surface(names)` and appending the availability block (§3); pass the extended schemas into `iterationTools` after a load.
- `README.md` — document `load_tools`, `LOCALCODE_ALL_TOOLS`, and the core/extended counts (additive; the 26 total stays correct).

**Delete** — none.

### Phase 2 — Skills system
**Create**
- `engine/skills/types.ts` — `SkillFrontmatter`, `Skill`, `SkillIndexEntry` types + `validateFrontmatter()` (§4).
- `engine/skills/loader.ts` — scan dirs, parse frontmatter (via `yaml`), build index; lazy `loadBody(name)`.
- `engine/skills/registry.ts` — in-memory skill registry + `RISKY_TOOLS` set.
- `engine/skills/install.ts` — GitHub fetch (zipball via `fetch`, mirroring `engine/research/engines/github.ts`), validate, risky-tool report, confirm-gate.
- `engine/skills/scaffold.ts` — `/skill new` template writer.
- `engine/tools/impl/runSkill.ts`, `engine/tools/impl/listSkills.ts` — meta-tools (`core: true`).
- `engine/skills/builtins/.gitkeep` (populated in Phase 4).
- Tests: `engine/__tests__/skills/loader.test.ts`, `runSkill.test.ts`, `install.test.ts` (fixture repo), `frontmatter.test.ts`.
- `engine/__tests__/guards/skillWiring.test.ts` — guard: every `skill.*` protocol event emitted is handled.

**Modify**
- `engine/bridge/conversationLoop.ts` — append the skill-index block to the prompt once (first turn, cache-safe like `sessionExtras`); handle `run_skill` (append body + `surface(skill.tools)`).
- `engine/main.ts` — add `/skill list|install|new|remove` to the slash-command switch (near the existing `/tdd…` cases ~581); scan skills at startup.
- `engine/bridge/protocol.ts` — add `skill.status` / `skill.installed` / `skill.list` events.
- `tui/localcode_tui/protocol.py`, `tui/localcode_tui/app.py` — parse + dispatch the new events; `/skill` command entry.
- Dashboard command surface (match wherever the dashboard sends slash commands).
- `package.json` — move `yaml` from `devDependencies` to `dependencies` (justified: skills parse frontmatter at runtime).

**Delete** — none (workflows deleted in Phase 4).

### Phase 3 — S5 proactive tool surfacing
**Create**
- `engine/s5/proactiveSurfacing.ts` — the `PROACTIVE_SURFACING` rule(s) + `surfaceForTask()` heuristic.
- `engine/__tests__/s5/proactiveSurfacing.test.ts`, `engine/__tests__/s5/proactiveJournal.test.ts`.
- `engine/__tests__/guards/proactiveToolsFlag.test.ts` — flag-off byte-identity regression.

**Modify**
- `engine/s5/types.ts` — extend `S5Input` with `taskClass` and `loadedTools: string[]`; extend `S5Decision` with `surfaceTools: string[] | null`.
- `engine/s5/orchestrator.ts` — thread `taskClass`/`loadedTools` in; journal `surfaceTools` in the decision entry.
- `engine/s5/ruleBasedS5.ts` — register the proactive rule tier (only fires when flag on).
- `engine/config.ts` — `export function isProactiveToolsEnabled(): boolean` (`LOCALCODE_S5_PROACTIVE_TOOLS === 'true'`, default false).
- `engine/bridge/conversationLoop.ts` — pass `taskClass`/`loadedTools` into `makeDecision`; apply `decision.surfaceTools` via `this.loadedTools.surface(...)`.

**Delete** — none.

### Phase 4 — Port workflows to skills (**see §7 — this phase is re-scoped**)
**Create**
- `engine/skills/builtins/{tdd,debug,review,plan,research,brainstorm,critique}/SKILL.md` (+ frontmatter).
- `engine/skills/workflowSkill.ts` — adapter that lets a skill wrap a `WorkflowDefinition` (preserves phases/gates).
- `engine/__tests__/skills/workflowParity.test.ts` — golden parity per workflow.

**Modify**
- `engine/main.ts` — `/tdd…` cases become `run_skill` aliases.

**Delete (only after parity green)**
- `engine/workflows/definitions/*.ts` (7 files) — **only if** §7's decision is "flatten"; otherwise retained behind the adapter. Flagged, not forced.

### Phase 5 — Docs, community index stub, polish
**Create** — `docs/skills.md`, `CREDITS.md` (or `CREDITS` header block), `skills/README.md` (community-index stub).
**Modify** — `README.md` (Skills section, env vars), verify (no-op) tool/rule counts.

---

## 3. Tool-availability block format — the riskiest design decision (2 options + recommendation)

**Constraint recap:** the rendered prompt for turn N must be a byte-prefix of turn N+1 (`engine/__tests__/engine/prefixStability.test.ts`). Today the tool list lives in the system prompt's `<TOOLS>` block (`systemPromptText.ts:235`) built once per user message, AND as the structured `tools:` array passed to `localCallModel` (`conversationLoop.ts:1853`). Under llama.cpp native tool calling the `tools:` array is rendered into the prompt prefix by the chat template — so **growing it mid-session breaks the prefix**, exactly like the system `<TOOLS>` text would.

### Option A — Message-tail availability block, structured `tools:` stays core-only
When `load_tools`/`run_skill`/S5 surfaces tools, append a synthetic **tool message** to the conversation tail: `[tool availability] The following tools are now loaded: <name>: <description> \n<json schema>…`. The system prompt's `<TOOLS>` block lists **core only** and never changes; the structured `tools:` array stays **core only**. Extended tools become callable because the executor dispatches by name against `ALL_TOOLS` regardless of the offered array.
- **Pro:** Strict append-only — the prefix (system + core tools + earlier messages) is byte-stable forever; only the message tail grows. Zero re-prefill cost.
- **Con:** Under **native** tool calling (llama.cpp grammar-constrains emitted calls to the `tools:` array), the model *cannot emit* a call for a tool not in the array. So Option A only works in **simulated** tool mode (`LOCALCODE_SIMULATED_TOOLS=true`), which is not the default. In native mode extended tools would be described but un-callable. ✗ for the default config.

### Option B — Grow the structured `tools:` array; treat each surface as a rare blessed prefix break (RECOMMENDED)
Keep the system prompt's `<TOOLS>` text **core-only and append-only** (never rewritten — satisfies the literal constraint "MUST be appended … NOT rewritten into the system prompt"). Surface newly-loaded tools two ways at once: (1) append the human-readable availability block to the message tail (as Option A, for model readability + audit), and (2) add the tools to the structured `iterationTools`/`tools:` array so native calling can emit them. Growth of the structured array breaks the rendered prefix **once, on the surfacing turn** — then it is stable again until the next surface. This mirrors the already-blessed compaction exception (`prefixStability.test.ts:73`: "compaction may break the prefix ONCE, then stability resumes").
- **Pro:** Works with the **default** native tool calling. Prefix breaks are **rare and bounded** (load_tools/run_skill happen a handful of times per session), so amortized cache cost ≈ compaction. System prompt text itself stays append-only.
- **Con:** Not *strictly* append-only at the structured-tools layer — each surface costs one full re-prefill. This is a real deviation from "never break the prefix."

**Recommendation: Option B**, with the prefix-stability test extended to treat a `load_tools`/`run_skill`/proactive-surface event as a second sanctioned break-point (same shape as the existing compaction carve-out), and a new assertion that **no surface event mutates the system prompt** (only the message tail + structured array change). `LOCALCODE_ALL_TOOLS=true` sidesteps breaks entirely by loading everything up front (best for cache-sensitive batch runs).

> **⚠ Constraint checkpoint — requires your explicit sign-off before Phase 1.** The task says: "If you can't preserve [strict] append-only, stop and explain the tradeoff before proceeding." Option B does break the prefix once per surface at the structured-tools layer. I believe this is the only design compatible with default native tool calling, and it is bounded/rare like compaction. **Approve Option B, or direct me to Option A (accepting simulated-tools-only surfacing), before I implement.**

**Block format (both options), appended verbatim as a `user`/tool message so it lands in the append-only tail:**
```
[tool-availability turn <N>] Newly loaded tools (callable from now on):
- Bash: Run a shell command. <one-line desc>
  schema: {"type":"object","properties":{...},"required":[...]}
- Git: ...
```

---

## 4. Skill frontmatter schema (TypeScript type + validator, no Zod)

```ts
// engine/skills/types.ts
export type SkillFrontmatter = {
  name: string          // required, lower-kebab-case, unique
  description: string    // required, single line (the only text loaded into the prompt index)
  version?: string       // optional semver-ish, display-only
  author?: string        // optional, display-only
  tools: string[]        // required (may be empty []); each must be a known registry tool name
}

export type Skill = {
  frontmatter: SkillFrontmatter
  dir: string            // absolute path to the skill folder
  source: 'builtin' | 'workspace'
  bodyPath: string       // path to SKILL.md (body loaded lazily)
}

export type SkillIndexEntry = { name: string; description: string; source: Skill['source'] }

export const RISKY_TOOLS = new Set([
  'Bash', 'Git', 'Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'ReplaceFunction', 'WebFetch',
])

// Hand-written validator (zod is not a dependency). Returns typed frontmatter or throws with a precise message.
export function validateFrontmatter(raw: unknown, knownTools: ReadonlySet<string>): SkillFrontmatter {
  if (raw === null || typeof raw !== 'object') throw new Error('frontmatter: not a mapping')
  const o = raw as Record<string, unknown>
  const name = o.name
  if (typeof name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`frontmatter.name: must be lower-kebab-case (got ${JSON.stringify(name)})`)
  }
  if (typeof o.description !== 'string' || o.description.trim() === '' || o.description.includes('\n')) {
    throw new Error('frontmatter.description: required single-line string')
  }
  const tools = o.tools ?? []
  if (!Array.isArray(tools) || tools.some(t => typeof t !== 'string')) {
    throw new Error('frontmatter.tools: must be an array of tool-name strings')
  }
  const unknown = (tools as string[]).filter(t => !knownTools.has(t))
  if (unknown.length) throw new Error(`frontmatter.tools: unknown tool(s): ${unknown.join(', ')}`)
  if (o.version !== undefined && typeof o.version !== 'string') throw new Error('frontmatter.version: string')
  if (o.author !== undefined && typeof o.author !== 'string') throw new Error('frontmatter.author: string')
  return { name, description: o.description, version: o.version as string | undefined,
           author: o.author as string | undefined, tools: tools as string[] }
}
```
Frontmatter is the leading `---`-fenced YAML block of `SKILL.md`, parsed with the existing `yaml` package (`parse()`), then passed through `validateFrontmatter`. `knownTools` = `new Set(ALL_TOOLS.map(t => t.name))` so a skill can never declare a nonexistent tool.

---

## 5. S5 proactive-surfacing rule shape + decision-journal logging

**Rule shape** (`engine/s5/proactiveSurfacing.ts`), only consulted when `isProactiveToolsEnabled()`:
```ts
// Static heuristic table (NOT a learned model — that's the future LoRA milestone).
const TASK_TOOL_HINTS: Record<string, string[]> = {
  debug:    ['Bash', 'Grep', 'Read'],
  test:     ['Bash'],
  research: ['WebFetch', 'WebSearch'],
  refactor: ['MultiEdit', 'ReplaceFunction'],
}

export const PROACTIVE_SURFACING: S5Rule = {
  id: 'P1', tier: 'info', name: 'Proactive tool surfacing',
  evaluate(input) {
    if (!input.taskClass) return null
    const want = TASK_TOOL_HINTS[input.taskClass] ?? []
    const loaded = new Set(input.loadedTools)
    const missing = want.filter(t => !loaded.has(t))
    if (missing.length === 0) return null
    return { surfaceTools: missing,
             reasoning: `task=${input.taskClass}; surfacing ${missing.join(', ')} proactively` }
  },
}
```
`surfaceTools` is a new **additive** field on `S5Decision` (never restricts — it only pre-loads). `conversationLoop` applies it via `this.loadedTools.surface(decision.surfaceTools)` when the flag is on; with the flag off the rule never fires and no field is set → byte-identical behavior (regression-tested).

**Journal logging** — reuse the existing decision journal (`orchestrator.ts:131-144`, `makeJournalEntry`). Extend the journaled `decision` object to carry the triple for future training:
```ts
decision: {
  workflow, contextAction, priority, reasoning,
  surfaceTools: decision.surfaceTools ?? [],   // the ACTION
}
// input already carries taskClass + loadedTools (the STATE)
// outcome is joined later by sessionId via the existing exportTrainingData reward-filter (P4.4 pipeline)
```
So the `(state, surfaced-tools, outcome)` triple = `input.{taskClass, loadedTools}` (state) + `decision.surfaceTools` (action) + session `outcome` (joined downstream by the already-shipped `engine/s5/exportTrainingData.ts`). No new journal schema — it rides the existing sessionId join. The schema is thereby "designed to capture the triple" as required.

---

## 6. Assumptions (where the repo was ambiguous)

1. **Grounding corrections (see top):** registry-drift, README tool count (26), and README rule count (21) are already correct on `main`. I assume we verify-and-guard rather than re-edit. **If you expected these as real fixes, tell me — otherwise those sub-tasks are no-ops.**
2. **Core vs extended membership** (a judgment call): proposed **core** = `Read, Glob, Grep, Ls, Edit, Write, MultiEdit, ApplyPatch, ReplaceFunction, Bash, Git, AskUser, ContractCreate, ContractAssertPass, ContractAssertFail, ContractStatus`; **extended** = `WebFetch, WebSearch, ImageView, NotebookEdit, CodeIndex, SaveLearning, SpawnAgent, CollectAgent, IndexResearch, Mfl`. Rationale: core = local file/code/edit/exec + governance-critical contracts; extended = network, media, indexing, agent-spawn, niche. **Please confirm the split** — it directly sets the default prompt size.
3. **Task classification source:** the task says "the engine already infers task type for contracts." I could not locate a discrete task-type classifier in the grounded reads (I found `difficultyClassifier` → `promptDifficulty`, not a task *class*). **Assumption:** I will locate the contract task-type inference during Phase 3 (grep `taskType`/`classify` under `engine/tools/contract.ts` + `engine/vsm/`); if none exists, I'll add a minimal keyword classifier (`debug|test|research|refactor|general`) and flag it. **This is the one open dependency for Phase 3.**
4. **`/skill install` transport:** use GitHub **zipball via `fetch`** (`https://codeload.github.com/<owner>/<repo>/zip/<ref>` or the API `zipball` endpoint), mirroring `engine/research/engines/github.ts`'s unauthenticated `fetch`. Avoids requiring `git` on PATH and needs no new dep. Subfolder/`@ref` parsed from the install spec. Unauthenticated GitHub rate limits apply (acceptable for install-time).
5. **`yaml` promotion dep→runtime** is treated as *not a new dependency* (already in the lockfile), just a manifest correction. If you'd rather keep zero manifest changes, I'll hand-parse the frontmatter block instead (still no Zod).
6. **Skill script execution** rides the existing `Bash` tool approval gate (no separate execution path), per the task.
7. **Dashboard `/skill` surface:** I assume the dashboard sends slash commands through the same WebSocket `command` path as the TUI; I'll confirm at Phase 2.

---

## 7. Phases to split / merge / reorder (with reasoning)

1. **Phase 1 shrinks.** Its headline task (build registry / kill hardcoded array) is already done. Phase 1 becomes: core/extended split + `load_tools` + `LOCALCODE_ALL_TOOLS` + the availability-block plumbing (§3). Still first — everything depends on `LoadedToolSet`.
2. **Phase 4 is re-scoped and should NOT flatten workflows into prose skills.** Grounding shows workflows are a **phase state machine with gates** (`WorkflowDefinition` → `phases{instruction, allowedTools, gate, transitions, maxTurns}`, engine at `workflows/engine.ts`), e.g. `/tdd` red→green→refactor with `tool_output` regex gates on test pass/fail. A flat `SKILL.md` body **cannot express phases/gates** → flattening would **regress behavior** and violate the "no behavior change without parity" constraint. **Recommendation:** introduce a `workflowSkill` adapter (Phase 4 create-list) so each of the 7 appears in the skill index (one-line description) and is invocable via `run_skill`, but **execution still drives the existing `WorkflowEngine`**. `/tdd…` slash commands stay as aliases. **We do NOT delete `engine/workflows/definitions/*` unless you accept losing the phase/gate machinery.** This is the "can't be cleanly ported — stop and flag" case the task anticipates; flagging it now.
3. **Phase 3 depends on the Phase 6-of-P4.4 journal** (already shipped) — good; no reorder, but Phase 3's journal write must match the existing sessionId join (see §5), so Phase 3 must land after confirming the exporter's `decision` shape (it did — `exportTrainingData.ts`).
4. **No merges recommended.** Keep 5 phase gates for review cadence as the task requested.

---

## Phase 1 — TDD task breakdown (fully specified; next up)

### Task 1.1: `core` field on `ToolImpl` + registry helpers
**Files:** Modify `engine/tools/types.ts`, `engine/tools/registry.ts`, all `engine/tools/impl/*.ts` + `askUser.ts` + `contract.ts`. Test: `engine/__tests__/guards/toolRegistryDrift.test.ts`.

- [ ] **Step 1: Write the failing guard test**
```ts
// engine/__tests__/guards/toolRegistryDrift.test.ts
import { describe, it, expect } from 'bun:test'
import { ALL_TOOLS, getCoreTools, getExtendedTools } from '../../tools/registry.js'
import { ALL_TOOL_NAMES } from '../../s5/ruleBasedS5.js'

describe('tool registry drift guard', () => {
  it('ALL_TOOL_NAMES equals the registry (never hand-maintained)', () => {
    expect([...ALL_TOOL_NAMES].sort()).toEqual(ALL_TOOLS.map(t => t.name).sort())
  })
  it('every tool declares an explicit core boolean', () => {
    const missing = ALL_TOOLS.filter(t => typeof (t as any).core !== 'boolean').map(t => t.name)
    expect(missing, `tools missing core: ${missing.join(', ')}`).toEqual([])
  })
  it('core ∪ extended partitions the registry', () => {
    expect([...getCoreTools(), ...getExtendedTools()].map(t => t.name).sort())
      .toEqual(ALL_TOOLS.map(t => t.name).sort())
  })
})
```
- [ ] **Step 2:** Run `npx vitest run engine/__tests__/guards/toolRegistryDrift.test.ts` → FAIL (`core` undefined, no helpers).
- [ ] **Step 3:** Add `core: boolean` to `ToolImpl` (`types.ts`); add `core:` to every impl literal per §6.2; add `getCoreTools`/`getExtendedTools` to `registry.ts`.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat(tools): core/extended split on the tool registry + drift guard`.

### Task 1.2: `LoadedToolSet`
**Files:** Create `engine/tools/loadedToolSet.ts`, `engine/__tests__/tools/loadedToolSet.test.ts`.
- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'bun:test'
import { LoadedToolSet } from '../../tools/loadedToolSet.js'
import { getCoreTools } from '../../tools/registry.js'

describe('LoadedToolSet', () => {
  it('seeds with core tool names', () => {
    const s = new LoadedToolSet(getCoreTools().map(t => t.name))
    expect(s.has('Read')).toBe(true)
    expect(s.has('WebFetch')).toBe(false)
  })
  it('surface() appends and is idempotent; never drops', () => {
    const s = new LoadedToolSet(['Read'])
    s.surface(['WebFetch', 'WebFetch'])
    expect(s.has('WebFetch')).toBe(true)
    s.surface(['Bash'])
    expect(s.names().sort()).toEqual(['Bash', 'Read', 'WebFetch'])
  })
})
```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement class (`Set` seeded in ctor; `surface(names)` adds; `has`, `names`, `snapshot`). **Step 4:** PASS. **Step 5:** Commit `feat(tools): LoadedToolSet — append-only per-session tool set`.

### Task 1.3: `LOCALCODE_ALL_TOOLS` guard
**Files:** Modify `engine/config.ts`; test `engine/__tests__/config/allTools.test.ts`.
- [ ] **Step 1:** Failing test asserting `isAllToolsEnabled()` false by default, true when env=`'true'`. **Step 2:** FAIL. **Step 3:** Add exported guard (mirror `isS5EnforcementEnabled`). **Step 4:** PASS. **Step 5:** Commit `feat(config): LOCALCODE_ALL_TOOLS flag`.

### Task 1.4: `load_tools` meta-tool
**Files:** Create `engine/tools/impl/loadTools.ts`; register in `registry.ts` (`core:true`); test `engine/__tests__/tools/loadTools.test.ts`.
- [ ] **Step 1:** Failing test: tool schema takes `{ tools: string[] }`; `execute` returns a confirmation string listing resolved names and ignores unknown names with a note. (Actual surfacing side-effect is wired in the loop — Task 1.6 — so this tool's `execute` returns the parsed/validated set for the loop to consume.) **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(tools): load_tools meta-tool`.

### Task 1.5: prefix-stability test extension (Option B carve-out)
**Files:** Modify `engine/__tests__/engine/prefixStability.test.ts`.
- [ ] **Step 1:** Add a test: a `load_tools` surface event may break the structured-tools prefix ONCE, then append-only resumes; AND assert the **system prompt string is unchanged** across the surface (only message tail + tool array grow). **Step 2:** Run → FAIL (no plumbing). **Step 3:** implemented in Task 1.6. **Step 4:** PASS after 1.6. **Step 5:** committed with 1.6.

### Task 1.6: wire `LoadedToolSet` + availability block into `conversationLoop`
**Files:** Modify `engine/bridge/conversationLoop.ts`; test `engine/__tests__/tools/coreDefault.test.ts`.
- [ ] **Step 1: Failing integration test** — with `LOCALCODE_ALL_TOOLS` unset, the tools passed to the model on turn 1 are exactly the core set; after a simulated `load_tools(['WebFetch'])`, `WebFetch` is in the offered set on the next turn; the **system prompt is byte-identical** before/after.
- [ ] **Step 2:** Run → FAIL. **Step 3:** seed `this.loadedTools` in ctor; compute `activeTools = isAllToolsEnabled() ? ALL_TOOLS : ALL_TOOLS.filter(t => this.loadedTools.has(t.name))` (replacing the `let activeTools = ALL_TOOLS` seed ~770, *before* workflow/pin/S5 filters so those still intersect down); on a `load_tools` result, `this.loadedTools.surface(names)` + append the §3 block as a tail message. **Step 4:** PASS + Task 1.5 passes. **Step 5:** Commit `feat(loop): core-by-default tool loading + on-demand surface`.

### Task 1.7: Phase-1 wire check (BLOCKING)
- [ ] **Step 1:** `grep -rn "LoadedToolSet\|isAllToolsEnabled\|getCoreTools\|getExtendedTools\|load_tools\|loadedTools" engine --include=*.ts | grep -v __tests__` — confirm each new symbol is imported AND called on a live path (not just defined).
- [ ] **Step 2:** Run full suite `npm test`, guards `npm run audit:wiring`, TUI `cd tui && python -m pytest tests/ -q`. All green.
- [ ] **Step 3:** Update README (`load_tools`, `LOCALCODE_ALL_TOOLS`, core/extended counts). **Step 4:** Commit `docs: on-demand tool loading`. **PHASE 1 GATE — summarize, run suites, wait for approval.**

---

## Phase 2 — TDD task breakdown (task-level; expanded at the Phase 1 gate)

- **2.1** `SkillFrontmatter` types + `validateFrontmatter` (§4) — unit tests for every rejection path (bad name, multi-line desc, unknown tool). Commit.
- **2.2** `loader.ts` — scan builtin + workspace dirs, parse frontmatter via `yaml`, build `SkillIndexEntry[]`, lazy `loadBody`. Test with a temp-dir fixture skill. Commit.
- **2.3** `run_skill` + `list_skills` meta-tools (`core:true`); loop appends body + `surface(tools)` on `run_skill`. Round-trip test: body loads ONLY on `run_skill`, tools surface. Commit.
- **2.4** skill-index block appended once (cache-safe, mirror `sessionExtras.ts`); prefix-stability assertion. Commit.
- **2.5** `install.ts` — GitHub zipball `fetch`, unzip, validate frontmatter, risky-tool report, confirm-gate. Test against a checked-in fixture zip (no network in CI). Commit.
- **2.6** `scaffold.ts` (`/skill new`) + `/skill list|install|remove` in `main.ts`; protocol events + TUI parse/dispatch + dashboard. Commit.
- **2.7** `skillWiring.test.ts` guard + full-suite wire check. **PHASE 2 GATE.**

## Phase 3 — TDD task breakdown (task-level)
- **3.1** Locate/確認 task-class source (§6.3); extend `S5Input`(`taskClass`,`loadedTools`) + `S5Decision`(`surfaceTools`). Commit.
- **3.2** `proactiveSurfacing.ts` rule (§5); `isProactiveToolsEnabled()`. Unit tests (flag-gated). Commit.
- **3.3** orchestrator journals the triple (§5); journal test asserts `(taskClass, loadedTools, surfaceTools)` present. Commit.
- **3.4** loop applies `decision.surfaceTools`; **flag-off byte-identity regression test**. Commit.
- **3.5** wire check. **PHASE 3 GATE.**

## Phase 4 — TDD task breakdown (task-level; see §7)
- **4.1** `workflowSkill.ts` adapter (skill wraps `WorkflowDefinition`); 7 `SKILL.md` builtins with frontmatter `tools[]` mirroring each phase's `allowedTools` union. Commit.
- **4.2** `/tdd…` become `run_skill` aliases; slash commands still work. Commit.
- **4.3** `workflowParity.test.ts` — golden behavior per workflow (phase sequence + gates identical). Commit.
- **4.4** Delete `engine/workflows/definitions/*` **only if** §7 flatten-decision approved; else retain. wire check. **PHASE 4 GATE.**

## Phase 5 — Docs + polish
- **5.1** README Skills section + env vars; verify (no-op) tool/rule counts. **5.2** `docs/skills.md` (AGPL reword of Hearth SKILLS.md). **5.3** `CREDITS` attributing the pattern to Hearth (MIT, Ishant Singh / @0pen-sourcer). **5.4** `skills/README.md` community-index stub. **5.5** full-suite + audit:wiring + fresh-clone install round-trip. **PHASE 5 GATE.**

---

## Self-review
- **Spec coverage:** all 5 phases + 7 deliverable items mapped. The two premises that were already true (tool count, rule count) are explicitly called out as no-ops rather than silently dropped.
- **Placeholder scan:** none — concrete code for the risky/foundational pieces; task-level (not micro-step) detail for Phases 2–5 is intentional and gated for expansion at each phase review, per the task's "pause at each phase" instruction.
- **Type consistency:** `LoadedToolSet.surface/has/names`, `getCoreTools/getExtendedTools`, `isAllToolsEnabled/isProactiveToolsEnabled`, `SkillFrontmatter/validateFrontmatter`, `S5Decision.surfaceTools` used consistently across sections.
- **Open gates requiring your decision before Phase 1:** (a) **Option B** for the availability block (§3 ⚠), (b) the **core/extended split** (§6.2), (c) acknowledgment that the tool-count/rule-count "fixes" are **no-ops** (§6.1), and (d) the **Phase 4 no-flatten** recommendation (§7.2).
