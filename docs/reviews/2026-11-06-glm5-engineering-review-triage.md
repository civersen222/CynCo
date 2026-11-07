# Triage: GLM 5.3 engineering review of CynCo (2026-11-06)

Source: `CynCo_Engineering_Review` (22 pages, dated 2026-10-30), written by GLM 5.3 against a
static clone at commit `bc7e686` (2026-10-28). The review did not run the engine or the suite.
This record re-checks every finding against HEAD `9190904f` (2026-11-06) by reading the code
path and, for the type-check claim, by running the check. Verdicts: **confirmed**, **partly**,
**already handled**, **wrong**. Where the review's proposed fix is not the right fix for this
repo, the row says why.

Eight commits landed between the reviewed commit and HEAD (F184, cynco-widget, no-logprobs
for one-shots); none touches a finding below, so the review is current.

## What the review got right about the whole

Its headline (periphery solid, centre fragile, docs carrying the code; three systemic gaps:
nothing runs itself, nothing type-checks, one class concentrates change) matches the tree.
Its praise is accurate too (guards, failure log, harness importing engine code, SSRF literal
parsing, timing-safe tokens, NULL-not-zero). Keep the anti-backlog in its chapter 10.

## Architecture (A1–A6)

| # | Claim | Verdict | What the code says |
|---|---|---|---|
| A1 | Nothing type-checks the engine; no tsconfig outside `cybernetics-core`; expect the first strict run to hurt | **confirmed, but smaller than sized** | No root/engine `tsconfig.json`; `package.json` scripts are `start`/`test`/`audit:wiring` only; `typescript` is not a dev dependency. A strict `tsc --noEmit` probe (TypeScript 5.9.3, `strict`, `moduleResolution: bundler`, `types: ["bun-types"]`) over `engine/**` excluding `cybernetics-core/` and `engine/__tests__/` gives **75 errors in 28 files**, not hundreds; 16 of those are in four test files the exclusion missed (`tools/contract*.test.ts`, `tools/__tests__/stderrMerge.test.ts`, `training/__tests__/provider.test.ts`), so **59 in production code**. 19 are in `conversationLoop.ts`. The counts the review quotes are off: 0 `@ts-ignore` outside tests (18 inside), 1 `@ts-expect-error`, 141 lines with `: any`, 241 `as any`. |
| A2 | `ConversationLoop` is a god module; a stub sub-agent runner sits live in the constructor | **confirmed** | 5,996 lines, 51 `private` fields, `runUserMessage` at :1691, `runModelLoop` at :3005, `executeOneTool` at :4883. `this.agentRunner = new SubAgentRunner(async (task) => "[SubAgent completed] …")` at :750 is assigned and **never read** (only :528 declaration and :750). Real sub-agents go through `tools/impl/spawnAgent.ts` → `agents/subAgent.ts`. The field is dead-but-wired; delete it. The split itself is correctly sequenced after A1 and CI. |
| A3 | `main.ts` mixes composition root, CLI multiplexer and the slash-command switch; `globalThis` service locator | **confirmed** | 1,443 lines; `__llamaProcessManager` is set on `globalThis` in `bootstrapProvider.ts:184`, read at `main.ts:167,231,420,719,1387` and deleted at :435. `handleCommand` starts at :645. |
| A4 | Dashboard is one 6,968-line file; one `SyntaxError` takes the page down (F150) | **confirmed; owner already decided** | `docs/NOW.md` backlog: "a split is justified only by a concrete change that it blocks". Leave as is until that change arrives. |
| A5 | Two tool taxonomies (`classifyCall` in `vsm/missionInvariants.ts`, `classifyTool` in `scripts/cynco-ledger.mjs`) will drift | **confirmed; already disagree** | `missionInvariants.ts:105-113` yields `denied-or-error / sourceEdit / inspect / codeIndex / other` plus `bashEffect` for Bash, with `Write` in `EDITOR_TOOLS`. `cynco-ledger.mjs:55-59` yields `sourceEdit / fileWrite / inspect`, with `Write` as `fileWrite` and Bash and CodeIndex both counted as `inspect`. The ledger imports only `bashEffect` from the engine. So the drift the review predicts has happened: `Write` is a source edit to the engine and not to the ledger. One exported classifier, used by both, is the fix. |
| A6 | Root `run-tests.test.ts` imports a missing `./engine/macroShim.js`; vitest never collects it | **confirmed** | `run-tests.test.ts:5` imports `./engine/macroShim.js`; no such file; `DEAD_CODE_AUDIT.md:124` already lists the shim as "MISSING / ALREADY REMOVED". `vitest.config.ts` `include` has no root glob. F6 (`cynco-failure-log.md:44`) says use vitest. No doc references the file. Delete it; keep F6 as history. |

### What the strict type-check probe found (A1 evidence)

The review sells A1 as insurance. The probe shows it is also a bug finder today. Of the 75
errors, these are runtime defects, not type noise:

1. **S5 rule W2 can never fire in production.** `vsm/types.ts:89` types
   `modelLatencyTrend` as `'stable' | 'rising' | 'falling'`; `cyberneticsGovernance.ts:861`
   fills it from `getLatencyTrend()`, which returns a **number** (mean latency ms, :937-940).
   `ruleBasedS5.ts:217` tests `=== 'rising'`. The guard `everyS5RuleCanFire.test.ts:91` feeds
   `'rising'` by hand, so it passes while the live input never carries that value. The README's
   model-switch claim (`modelSwitchClaim.test.ts`) rests on the same synthetic input.
2. **Two-stage tool routing has never routed.** `conversationLoop.ts:3352` checks
   `evt.type === 'tool_use'` on events from `localCallModel`, which yields only
   `'stream_event' | 'assistant' | 'system'` (`callModel.ts:260`, every `yield`). The branch is
   unreachable, so `routed` stays false and `routingDeclined` is set after one wasted stage-1
   call per session (`:3379-3384`). The guard `routingOneStrikeWiring.test.ts` records the
   original symptom: 56 stage-1 calls, 32% of a wave's model time, `Category selected` printed
   zero times. That was read as the model ignoring the selector. It was this comparison. Active
   whenever `contextLength <= 65536` (`toolRouter.ts:92`): the Ollama path, not the 131072
   llama.cpp default.
3. **Kill-switch telemetry always reports inactive.** `vsm/algedonicIntegration.ts:88` reads
   `this.killSwitch.isActive`; `KillSwitch` (cybernetics-core `algedonic/index.ts:121`) has
   `isHalted()` and no `isActive`. The value is always `undefined`.
4. **Performance health never reports `warning`.** `conversationLoop.ts:2301` compares
   `getHealthStatus()` (`'red' | 'amber' | 'green'`) with `'yellow'`; `amber` therefore maps to
   `'critical'` in the S5 input.
5. **`s5.decision` events carry fields that do not exist.** `conversationLoop.ts:2340-2341,2347`
   read `decision.toolRestriction` / `decision.modelSwitch`; `S5Decision` (`s5/types.ts:55`)
   has `tools` and `model`. The dashboard's `tools=` is always `none`.
6. **Protocol drift the cross-language guard missed.** `main.ts:1236` handles
   `case 'session.end'`, which the TUI sends (`tui/localcode_tui/protocol.py:409`,
   `bridge.py:89`), but the engine's `ClientMessage` union does not declare it.
7. **Vendored theory layer drift.** `vsm/eventBus.ts:44` calls `Timestamp.toMillis` (guarded,
   so harmless); `cybernetics-core/src/events/index.ts:412` reads `NodeId.value`, which does not
   exist. `STATE-AND-VISION-2026-07-12.md` predicted exactly this ("drift … is silent corruption
   of the theory layer").
8. Smaller: `ollama/format.ts:135` builds `usage` with `inputTokens` where `TokenUsage` is
   `input_tokens` (error path only); `providers/openaiCompat.ts:1` imports two types
   `provider.ts` does not export; `cyberneticsGovernance.ts:397,402` pass an argument to
   zero-arg functions; `imagegen/check.ts:57,60` read `.key` off a union member that lacks it.

So the right shape for A1 is not "stand it up and ratchet for weeks": fix to zero in one or two
missions (75 errors, most mechanical, the eight above each a small behaviour fix with a test),
then add `tsc --noEmit` to `audit:wiring` so it stays at zero. A ratchet baseline is only
needed if zero turns out to be further than a day away.

## Tests and CI (T1–T7)

| # | Claim | Verdict | What the code says |
|---|---|---|---|
| T1 | Nothing runs automatically: no workflows, hooks, Makefile | **confirmed** | No `.github/`, `.husky/`, `Makefile`, `justfile`; `core.hooksPath` unset and `.git/hooks` holds only samples. One pre-condition the review did not see: `docs/NOW.md` records **nine engine test files failing on this Windows box before any change** (EPERM on temp dirs, 5 s timeouts). A Linux CI run is therefore also the cheapest way to learn whether those are Windows-only. |
| T2 | `CYNCO_INTEGRATION` gates 12 files that need only mocks | **partly; the gate's reason is stale** | 12 test files plus `harness/liveHarness.ts`; 19 of 20 tests in `tools/conversationLoop.test.ts` are `it.skipIf(SKIP)`. They use scripted `mockProvider`s and never fetch. The gate comment (`conversationLoop.test.ts:6-8`) gives the reason: real loops "hit the filesystem, create JSONL sessions, index DBs" and "run manually with `bun test`". Both halves predate the fixes: `setup/cyncoHome.ts` has redirected `~/.cynco` to a temp dir since F58, and F6 retired `bun test`. Two exceptions the review missed: `tools/grep.test.ts` and `tools/git.test.ts` gate tests that need real `rg`/`git` binaries, which is a different reason and still valid. `POST-CHANGE-VERIFICATION.md` never mentions the variable. |
| T3 | `main.ts` has no boot test | **confirmed** | The only spawn of `engine/main.ts` is `guards/oneShotPreflight.test.ts:38`, which asserts exit 1 *before* `bootstrapProvider()`. `quickStartStartsTheEngine.test.ts` is a static README-vs-profile check. |
| T4 | Dashboard JS never executes in a test | **partly; overstated** | No jsdom or `vm`, and the F150 guard (`dashboardScriptParses.test.ts:57-62`) is parse-only. But `genui.test.ts:1393`, `projectsView.test.ts:457`, `askCard`, `markdown`, `governancePoll` and `campaignProgressRow` lift several functions at once and run them against stub `document` / `ws` / `fetch`. The page's handlers are exercised, the page is not. A whole-script run in a real DOM is still the missing layer, but it is one layer, not the first. |
| T5 | `s5/enforcement.test.ts` is a shadow test | **confirmed** | `enforcement.test.ts:79-108` defines its own `applyS5ToolFilter` "simulating the S5 enforcement logic from conversationLoop.ts ~line 478/631" and asserts on that copy. The real-loop S5 enforcement tests exist (`conversationLoop.test.ts:214,261`) and are `skipIf`-gated, so T2 and T5 are one fix: un-gate, then delete the shadow. |
| T6 | TUI tests are shape checks, no Textual Pilot | not re-checked | Plausible and low-risk; sequence after T1. |
| T7 | Fixed test ports can collide across workers | **confirmed; already colliding** | `vitest.config.ts` sets no `pool`/`fileParallelism`, so files run in parallel. Port 19171 is bound by `bridge/server.test.ts:233` and is `DEFAULT_PORT` in `dashboard/security.test.ts:37`; 19191 is `PORT` in `dashboard/dashboardCommand.test.ts:23` and `SESS_PORT` in `dashboard/server.test.ts:482`. The comment at `dashboard/server.test.ts:25-26` shows the hand-management, and these two overlaps show it slipped. `setup/bunShim.ts:219-223` logs a cross-process bind failure with `console.log` instead of failing. Likely one source of the "5 s timeouts" in the Windows baseline. |

## Security (S1–S9)

All confirmed by reading the paths. Severity calibration (single owner, model output is the
untrusted input) is the repo's own, so the ranking stands.

| # | Claim | Verdict | What the code says |
|---|---|---|---|
| S1 | `Read` is tier `auto` with no path check; `WebFetch` is `auto`; sealed paths are mission-only | **confirmed** (partly in project chat); **done 2026-11-06** (`engine/tools/secretPaths.ts`, decision record of that date) | `read.ts:44 tier: 'auto'`; `approvalGate.ts:18-30` falls back to `tool.tier`; the only path checks in `executor.ts:185-190` are sealed/immutable, and seals come from mission contract instruments (`conversationLoop.ts:1886-1890`), never from an env or a default. `bashSafety.ts:10-13` blocks `.env`, `~/.ssh`, `/etc/shadow` for Bash but **not `tokens.json`**, and Read has no list at all. Project chat confines file tools to the folder (`binding.ts:38,158-160`). |
| S2 | Project chat: `Write evil.py` + `Bash python evil.py` runs with no card | **confirmed**; **done 2026-11-06** (`runsProjectCode` in `binding.ts`) | `executor.ts:202-209` runs `safe` straight through; `guardianRules.ts:83` defaults to `safe`; no interpreter pattern in RISKY/DANGEROUS or in `bash.ts` BLOCKING_PATTERNS. `binding.ts:161-164` fences only the ComfyUI shape of this. |
| S3 | SSRF guard checks the hostname string, never the resolved IP | **confirmed** | `webFetch.ts:63-105`; zero `node:dns` imports in non-test engine code. `fetchGuarded` does re-validate every hop with `redirect: 'manual'` (max 5), so only DNS rebinding passes. |
| S4 | Web content enters tool results raw; the system prompt never says tool output is data | **confirmed**; **done 2026-11-06** (`engine/tools/untrusted.ts`, `TOOL_RESULTS_ARE_DATA`) | `webSearch.ts:78-90`, `webFetch.ts:178-180`; `systemPromptText.ts` has no such line. |
| S5 | llama-server and jlens run with no auth on loopback | **confirmed** | `processManager.ts:71-78` has no `--api-key`; `provider.ts` sends `Content-Type` only; `jlens_service/server.py:87` plain `ThreadingHTTPServer`. |
| S6 | Management token printed every start; no rotation | **confirmed** | `main.ts:330`; `/api/phone/rotate` rotates the pairing code and `/api/phone/revoke` a device, nothing rotates `admin`/`tui`/`dashboard`. |
| S7 | PDF extraction has a size cap but no page or time cap | **confirmed** | `projects/extract/pdf.ts:7-13`; the 50 MiB cap (`api.ts:23`) is upload-route only; `ingest.ts:105` reads dropped files uncapped. |
| S8 | `~/.cynco` created with default permissions | **confirmed, fix must be Windows-aware** | `localToken.ts:278 mkdirSync(base, { recursive: true })`. The file already does `0o600` + `icacls` on win32 (`:98-114`); a bare `chmod 0700` on the directory would be a no-op on this box. Reuse `restrictToOwner` for the directory. |
| S9 | README says nine allowlisted frame types; code admits eleven | **confirmed** | `server.ts:213-226` lists 11 (`project.open`, `ui.action` added); `README.md:348` says nine. Slash count (fifteen) is still right. |

## Onboarding, docs, repo (O1–O8)

| # | Claim | Verdict | What the code says |
|---|---|---|---|
| O1 | Ollama `complete()`/`stream()` never check `resp.ok`; missing model = silent empty reply; `ModelNotFoundError` never thrown | **confirmed** | `ollama/client.ts:34` is the only `.ok` read (the health check). `complete()` (:56-63) goes straight to `resp.json()`; `stream()` (:92-157) logs the status at :97 and then yields `message_start`, finds no `data:` lines in a 404 body, and yields `message_stop`. `ModelNotFoundError` is not even imported into `client.ts`; `ollama/CLAUDE.md:35` says so. No caller lists models before the first chat (`providers/factory.ts:11`, `callModel.ts:86`); `probeCapabilities()` is a static table. `llama/provider.ts:148-151` is the template, with the 2026-06-12 incident comment. The guard `quickStartStartsTheEngine.test.ts:31-32` already predicts the symptom ("would boot and then 404 on its first request"). |
| O2 | README never links USER_GUIDE / MANUAL / BENCHMARKS / MAXIMIZING / docs index, never says the TUI starts the engine or where the log lands, no "returning after a break" line | **confirmed** | README links six `docs/` paths (failure log, phone decision, liveness, serving recipe, paper, a patch); none of the four core docs, not `docs/README.md`, not `NOW.md`. `.cynco-engine.log` appears once, under Phone access (:385), not in Quick Start. `docs/README.md` itself already does the "working on CynCo → AGENTS.md → NOW.md" hand-off; the README just does not point at it. |
| O3a | `-p` path dead-ends with no hint how to start an engine | **confirmed** | `tui/localcode_tui/bridge.py:67` raises `"Could not connect to engine on port {self.port}"`; `app.py:89-90` notifies and pushes the workspace anyway. The neighbouring `InvalidStatus` branch (:58-63) already shows the better shape (names the token file). |
| O3b | USER_GUIDE calls `nomic-embed-text` required; two files still say `qwen3:8b` | **confirmed** | `index/embedClient.ts:103` defaults to `jina-code-embeddings-0.5b`, :93 falls back to `nomic-embed-text`, :182-195 auto-pulls, :244 falls back to keyword search; `docs/USER_GUIDE.md:30,269` say nomic is required. `qwen3:8b` survives in `CYNCO.md:24`, `engine/main.ts:5` (usage docblock) and `AUDIT-LOG-README.md:33`. |
| O3c | Every streamed Ollama turn writes `.cynco-http-debug.json` / `.cynco-sse-debug.json` into the project | **confirmed, unconditional** | `ollama/client.ts:69-88,147-154` write both files to `process.cwd()` inside bare `catch {}` blocks, plus `console.log` at :97 and :145; no env gate in the file. The loop's own debug files go to `debugDir()` (`conversationLoop.ts:1225-1230`, "never the user's project folder itself"), so the client is the outlier. Route them through `debugDir()` or delete them. |
| O6 | 212 MB of ledger rewritten by 141 commits; "sharding exists, the discipline just needs a trigger" | **wrong on the trigger; right on the weight** | `scripts/cynco-ledger-shards.mjs` already rolls: `missions.jsonl` is frozen at 194 rows, `activeShardPath` opens a new shard when the newest is at or over `SHARD_MAX_BYTES = 40 MiB`, and rows never move between shards. Current shards: 0002 (38 rows, 44 MB), 0003 (37, 44 MB), 0004 (18, 22 MB). The review's "rotate at ~100 rows" would be a regression (rows are ~1.2 MB). What remains open is its medium-term question: whether frozen shards should ride every clone. Owner's call; not code. |
| O8 | Zero tags, version frozen at 0.1.0, root files with unclear names | **confirmed** | `git tag` empty; `package.json` and `tui/pyproject.toml` both `0.1.0`. `CYNCO.md`'s identity is already a NOW.md backlog item. Renaming is cheap but touches `CLAUDE.md`, `POST-CHANGE-VERIFICATION.md` and the guard that reads it; do it with the NOW.md decision, not before. |

## Recommended order (differs from the review's)

The review's phases are sound; two things move.

**Move A1 up, and do it as a bug-fix mission, not a ratchet.** (Done 2026-11-06: F185 — zero errors, the eight defects fixed with tests, `typecheck.test.ts` in the guard lane; two more surfaced while fixing: `session.end` was refused by the command schema, and the orchestrator dropped the loop's demoted-tools list.) The probe shows eight live
defects behind a one-day type-check, including a governance rule that cannot fire and a
routing feature that never worked. Zero errors plus `tsc --noEmit` in `audit:wiring` is the
first mission.

**Drop O6's rotation item and the `@ts-ignore` triage.** Both are already handled.

Everything else in the review's Phase 0 and Phase 1 holds, with S1/S2/S4 as the three that
close the exfiltration chain and should land together as one slice:

1. A1 as above (one mission; closes the eight defects; adds the gate).
2. S4 + S1 + S2: untrusted-content delimiters and one prompt line; default seal for
   `tokens.json`, `~/.ssh`, `.env` through the existing `setTaskSealedPaths`; project-chat Bash
   always asks (or at least any interpreter/script invocation grades `risky`).
3. O1 + O3c together (one file, `ollama/client.ts`: `resp.ok` check wired to the existing error
   classes, debug dumps through `debugDir()`), with O3a and the doc fixes (S9, O2, O3b) and the
   two deletions (A6, the A2 stub) as the same small PR.
4. T1: a CI workflow with the guard lane as the required check, the full suite advisory until the
   nine Windows-baseline failures are classified on Linux. T7 (shared ports 19171/19191, loud
   bind failure) goes in first; it is a likely cause of those timeouts.
5. T2 + T5: drop the stale `CYNCO_INTEGRATION` gate on the mock-only files (keep it on the
   `rg`/`git` binary tests), one green run, then delete the shadow filter in
   `enforcement.test.ts`.
6. S3, S5, S6, S7, S8: each an hour or three; sequence by whichever mission is nearest the file.
7. A5 (one exported classifier, `Write` decided once), A3, T3, T4, T6, then the A2 split per the
   review's Phase 2, only after 1 and 4 are green.

## Things the review did not say that matter for the plan

- The engine suite baseline on this machine is not green (`NOW.md` backlog); CI will expose
  that first. Decide up front whether the nine files are fixed or marked.
- `docs/NOW.md`'s current objective is phone access slice 1 (verified 2026-10-27); adopting this
  triage as the next objective is the owner's decision per `AGENTS.md`.
- `everyS5RuleCanFire` proves reachability from a hand-built input. A1's finding 1 shows that
  is not the same as reachability from the live governance report; a second guard that derives
  the input from `cyberneticsGovernance.getReport()` would close that gap.
