# CynCo Failure Log

Every failure while driving CynCo missions gets an entry: **where** it failed, **how** it failed, **why** (root cause), and the **harness improvement** that prevents recurrence. Goal: never fail the same way twice, and mine this log for engine/driver improvements.

Entry status: `OPEN` (improvement not yet shipped) | `SHIPPED` (fix in engine/driver) | `MITIGATED` (workaround in mission-brief pattern, not enforced by code).

---

## F1 — Embedded chat template rejects mid-conversation system messages
- **Date:** 2026-07-10 · **Context:** NVFP4 model switch, first live mission
- **How it failed:** llama-server returned HTTP 400 mid-mission ("System message must be at the beginning"); CynCo turn died with no useful surface error.
- **Why:** Community NVFP4 GGUF embeds a stricter Jinja template. CynCo's context injection (index chunks, .cynco-state.md) produces mid-conversation system messages. The tool-call probe passed because it only sends system-first prompts — so the probe gave false confidence.
- **Harness improvement:** `runtime.chat_template_file` profile option → `--chat-template-file` (PR #25, merged 2026-07-11). **Follow-up (OPEN):** extend the startup probe to send a mid-conversation system message so template incompatibility is caught at boot, not mid-mission.
- **Status:** SHIPPED (override) / OPEN (probe coverage)

## F2 — Headless approval auto-deny loop
- **Date:** 2026-07-10 · **Context:** Mission 1 (event popup wiring), first headless run
- **How it failed:** Mission stalled ~15 min; CynCo looped Read→Edit→Read with nothing landing on disk.
- **Why:** Risky tools (Edit/Write/Bash) emit `approval.request`; with no TUI connected, requests auto-deny after 5 min (conversationLoop.ts). CynCo saw silent tool failures and retried blindly.
- **Harness improvement:** Run headless engines with `LOCALCODE_APPROVE_ALL=true`. **Follow-up (OPEN):** engine should log a loud warning when an approval.request has no connected approver, and/or the WS driver should answer approval.request messages itself. CynCo should also be told by the model when a tool was denied vs errored — silent denial caused the blind retry loop.
- **Status:** MITIGATED (env var) / OPEN (engine warning + driver auto-approve)

## F3 — Edit anchor fragility on multi-line / whitespace-sensitive anchors
- **Date:** 2026-07-07..10 · **Context:** early CivKings missions
- **How it failed:** CynCo's Edit tool missed anchors when briefs used multi-line or leading-whitespace-dependent old_strings; retries burned turns.
- **Why:** Local model reproduces anchors imperfectly; longer anchors = more degrees of freedom to get wrong.
- **Harness improvement:** Mission-brief pattern: ONE focused task, single-line unique anchor (verified unique with grep before dispatch), full replacement block given verbatim. Missions 1 & 2 landed byte-exact first try with this pattern. **Follow-up (OPEN):** consider fuzzy-anchor matching (whitespace-normalized) in the engine Edit tool.
- **Status:** MITIGATED (brief pattern) / OPEN (fuzzy matching)

## F4 — CRLF smudge corrupts byte-exact artifacts on Windows
- **Date:** 2026-07-10 · **Context:** extracting chat template from Q6_K GGUF
- **How it failed:** Extracted template was 8214 bytes instead of 8057 — silently corrupted (\n→\r\n).
- **Why:** Python text-mode writes convert newlines on Windows.
- **Harness improvement:** Always write byte-exact artifacts in binary mode ('wb'); verify with byte counts. Applies to any harness script that round-trips model/template files.
- **Status:** MITIGATED (practice)

## F5 — Driver can't see which tool CynCo is running
- **Date:** 2026-07-11 · **Context:** Mission 2 driver
- **How it failed:** Driver logged `[cynco] tool: ?` for every tool.start — the protocol field isn't `name`/`tool`. Live observability of the mission was zero; only git polling revealed progress.
- **Why:** Driver guessed protocol field names instead of reading bridge/protocol.ts.
- **Harness improvement:** protocol field is `toolName` (bridge/protocol.ts:57). Canonical parameterized driver committed at `scripts/cynco-mission-driver.mjs` — logs tool names, tool errors, and flags approval.request (F2 detector). Use it instead of writing per-mission drivers.
- **Status:** SHIPPED (2026-07-11)

## F6 — `bun test` crashes on Windows in this repo
- **Date:** 2026-07-10 · **Context:** verifying engine chatTemplateFile change
- **How it failed:** KERNEL32 crash report, zero tests run.
- **Why:** Known bun-on-Windows issue in this repo.
- **Harness improvement:** Use `npx vitest run` for engine tests. (Baseline vitest harness gaps already fixed in cf75f8e.)
- **Status:** MITIGATED (practice)

## F7 — S5 crisis mode locks reused engine sessions to read-only
- **Date:** 2026-07-11 · **Context:** Mission 4 (research pipeline), engine reused across missions 2-4
- **How it failed:** Driver TIMEOUT with ZERO tool.start events — CynCo replied 49 tokens of text and ended the turn. Silent from the driver's perspective; only the engine log revealed it.
- **Why:** VSM S5 accumulated "homeostat unstable 217x" + "agreement ratio 0.00" across the reused session and entered `heterarchy: S5 commanding (crisis)`, enforcing `tool restriction to [Read, Glob, Grep, Ls]` (conversationLoop.ts:855). An edit mission with no write tools is unfulfillable. The governance signals are non-discriminating (s3s4=critical even during successful missions), so "crisis" fires on healthy sessions that simply run long.
- **Harness improvement:** Return to fresh-engine-per-mission (kill bun + llama-server, restart) — deviating from that rhythm caused this. **Follow-up (OPEN):** (a) driver should alert when a mission turn completes with zero tool calls (fast-fail instead of 10-min timeout); (b) S5 read-only enforcement is actively harmful under non-discriminating signals — feed this case into the H1-H8 predictions redesign; consider a headless-mission flag that caps S5 at "recommend" without "enforce".
- **Status:** MITIGATED (fresh engine per mission) / OPEN (driver zero-tool alert, S5 redesign input)

## Latent product bugs found while verifying (not harness failures, future missions)
- **CKEvent._apply_effect prestige AttributeError:** `ruler.prestige += value` on rulers that may lack the attribute (game.py ~line 120s). Found 2026-07-11 via functional test. → FIXED by mission 3 (194b784).

## F8 — Brief author gave a wrong container-type assumption; CynCo debugged it live
- **Date:** 2026-07-12 · **Context:** Mission 8 (random events apply effects), events.py
- **How it failed:** Brief's verbatim replacement iterated `game.cities` as a list (`[c for c in game.cities if c.owner == civ_name]`) but `Game.cities` is `Dict[str, City]` — iteration yields key strings, `.owner` would AttributeError. Cost: 1 Edit anchor miss + several extra turns (9/63 tool errors), plus 2 failed `git commit` attempts (commit-before-add) before landing.
- **Why:** I (mission author) wrote effect-mapping code against grepped attribute names without verifying the container type. CynCo's instructed smoke check caught it at runtime and CynCo correctly self-repaired to `game.cities.values()` — a *good* deviation, caught only by full-diff verification.
- **Harness improvement:** When a brief contains new code touching game state, verify every container's type (`grep "self.X: "` for the annotation) before freezing the verbatim block. Keep instructing the smoke check in every brief — it's what turned this from a broken landing into a self-repair. Diff-vs-brief review must classify deviations (cosmetic | fix | drift) rather than demanding byte-exactness.
- **Status:** MITIGATED (practice: type-check brief code + mandatory smoke checks)

## F9 — Correct edits applied but mission stalled before committing (900s wall)
- **Date:** 2026-07-15 · **Context:** Mission 16 (versioned save schema + migration scaffold), game.py, fresh engine, S5 cap active (`enforce=false`)
- **How it failed:** Driver TIMEOUT without commit at 900s. But CynCo had already applied **all three game.py edits correctly** — the uncommitted `M game.py` diff matched the brief verbatim (`_migrate_save` helper, `"save_version": 1` field, `data = Game._migrate_save(data)` in from_dict) and passed `ast.parse`. Only 8 turns; the governance log shows an early read-loop thrash (5 Reads → read-loop DENIED) then a long stretch of `status=warning stuck=0` with no tool activity — CynCo hung after editing and never reached the Git commit / verification.
- **Why:** NOT a brief defect (all 3 anchors matched, edits clean, work correct). A wall-clock/latency stall: the early re-read thrashing burned turns, and CynCo appears to have stalled mid-turn (long generation or verification hang) before committing. The strict outcome rule (marker in git log = landed, else timeout) correctly labels this a failure regardless of diff correctness — an uncommitted mission is not a landed mission.
- **Harness improvement (candidates, not yet shipped):** (a) driver could detect "edits made but idle N seconds with no tool.start" and nudge "commit now"; (b) raise per-mission timeout for game.py-heavy missions; (c) add an explicit "commit as your FINAL action before you run out of turns" line to briefs. Re-dispatch on a **clean tree** (reset the partial work first, else the EDIT-1 two-line anchor no longer matches) is a legitimate non-blind retry here since the failure is latency, not brief correctness.
- **UPDATE (2026-07-15):** NOT actually a stall — a **LATE LANDING**. Commit `5b63315` (authored 13:45:16) landed *after* the driver's 900s poll window closed, so the driver reported a false-negative timeout. The commit is byte-identical to the brief and passes AST/pytest-25/smoke. Ledger relabeled `verified:true` with `lateLandingCommit:5b63315` (outcome kept `timeout` = honest harness observation). No re-dispatch needed; the "clean tree" reset was a safe no-op (tree already matched the landed HEAD).
- **Real remedy:** the driver's poll window is too short / it stops polling at timeout instead of doing one final `git log` check. **Harness fix candidate:** on timeout, the driver should do a last marker check (and/or keep polling ~60s past the wall) before labeling `timeout` — a mission that commits at 900.x s is a success, not a failure. Also raise default timeout for game.py-heavy missions.
- **Status:** RESOLVED as late-landing (mission shipped). OPEN follow-up: driver final-marker-check on timeout + longer default timeout.

## F10 — Engine relaunched without APPROVE_ALL; every edit blocked on an approval prompt
- **Date:** 2026-07-15 · **Context:** Mission W3 (live audio hookup: app.py + game_screen.py), fresh engine, S5 cap active (`enforce=false`)
- **How it failed:** Driver TIMEOUT without commit. Governance log shows CynCo Read both files fine, then every `Edit`/`ApplyPatch` returned `Tool call denied by user: Edit` / `APPROVAL REQUESTED (Edit) — engine not in APPROVE_ALL mode? (F2)`. Edit circuit-breaker tripped after 3 consecutive denials; CynCo switched to ApplyPatch, same approval wall. No edit ever landed; tree stayed clean at W2 head (`aea9a27`), only untracked `COMPLETION_PLAN.md` present.
- **Why:** Operator harness error, NOT a brief defect. On the fresh-engine relaunch for W3 I set `LOCALCODE_PROFILE=default LOCALCODE_S5_ENFORCE=false` but **omitted `LOCALCODE_APPROVE_ALL=true`**. Unattended missions need approve-all, else every mutating tool call parks on an approval prompt no human answers → circuit breaker → timeout. Prior session missions ran with approve-all; I dropped it when reconstructing the launch env after killing the tree.
- **Harness improvement:** Fresh-engine relaunch for any driver mission MUST include `LOCALCODE_APPROVE_ALL=true`. Add it to a canonical launch snippet so it can't be dropped when reconstructing env by hand. Re-dispatch is a legitimate non-blind retry (clean tree, brief unchanged) — the only variable that changed is the engine's approval mode.
- **Status:** MITIGATED (relaunch with APPROVE_ALL + re-dispatch on clean tree).

## Success observations (validated brief patterns)
- **2026-07-12, mission 7 (CK event choice feedback):** 4-edit, 3-file brief landed first try in ~13 min, byte-exact except the known trailing-blank-line consumption by ReplaceFunction (cosmetic). Fresh engine, S5 cap active (`enforced: false` in ledger row 2).
- **2026-07-11, mission 5 (AI movement):** whole-method replacement pattern again first-try (fresh engine, F7 rhythm respected). Minor deviation: CynCo's replacement also consumed the `# ── Diplomacy management` separator comment + blank lines between methods — harmless, but "replace down to line X" boundaries are approximate; keep verifying by full diff, not just tests.
- **2026-07-11, mission 3:** Less prescriptive brief (whole-method replacement: goal + exact target code, CynCo picks the edit strategy) worked first try — CynCo split it into 2 Edits itself, ran ast.parse + pytest + smoke check as instructed, committed clean. Whole-method rewrites are viable when the final code is given verbatim; no need to spoon-feed anchors for method-scale changes.
- **2026-07-11, missions 2-3:** `scripts/cynco-mission-driver.mjs` end-to-end: tool trace visible (Read×4, Edit×2, Bash×6 for mission 3), commit-marker detection, single-digit-minute missions. NOTE: pass the brief path with forward slashes (`C:/tmp/...`) — bash eats backslashes (mission 3 first dispatch ENOENT'd).

## Standing observations
- Governance dashboard shows `s3s4Balance: critical`, `varietyRatio: 9 (overload)`, `consecutiveUnstable: 14` even during successful missions — signals are not discriminating success from failure (ties into the H1-H8 predictions redesign).
- NVFP4 mission throughput: 115 tok/s eval, 0.83 MTP draft acceptance — missions 1 & 2 each completed in single-digit minutes with the F3 brief pattern.
