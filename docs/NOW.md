# NOW — what CynCo is working on

One current objective at a time. Adjacent ideas go to the backlog, not into the current diff.
Changing the first section is the owner's decision. Rules: `AGENTS.md` → "How to change CynCo".

## Current objective

**Wakefulness core (slices 1–3) — built 2026-11-08, live proof pending merge + pull.**

The GPU box sleeps; the doorman mini PC wakes it for a phone knock or a scheduled trigger; the
phone engine keeps the GPU cold until a message needs the model and never kills a running
mission's server. Design: `docs/decisions/2026-11-08-wakefulness-design.md`; record:
`docs/decisions/2026-11-08-wakefulness.md`; hardware log: the owner's `pc-wakefulness` project.
Done when, after merge + pull on the main checkout: (a) `powercfg /requests` shows the SYSTEM
request during a one-shot; (b) the PC sleeps on its own with "Sleep after" set; (c) the next
trigger's wake shows in Power-Troubleshooter ~3 min early and `runs.jsonl` shows the run;
(d) a phone knock on `http://100.110.117.10:9170/` wakes the PC and lands on the dashboard.

Remaining slices, each its own plan: **2b** busy fallback to a 14B model on the 4070 Ti Super
box (`LOCALCODE_LLAMA_FALLBACK_URL`); **4** the phone-sized remote view — BUILT 2026-11-08 (Chat · Projects · Away, `LOCALCODE_BRAIN=off` on the phone engine, the jlens sidecar off everywhere unless `LOCALCODE_JLENS=on`); **5** phone files — BUILT 2026-11-08 (Attach in the chat, docx/xlsx extraction);
**6** ntfy and the NAS watchdog on the doorman — BUILT 2026-11-08 (ntfy container on `100.110.117.10:8090`, `naswatch.service`, PC ntfy task disabled). Then the tiers: the 4070 and 1080 Ti boxes on the
switch as wakeable workers, and S5 choosing the tier (`pc-wakefulness/knowledge/tiering-preview.md`).

Phone access slice 1 (2026-10-22/27) is merged and in use; its design record stands.

Mission schedule control — built 2026-11-08 on branch `mission-schedule-control` (PR pending): the owner moves, switches off or pauses any daemon pass from a Missions tab (desk and phone) and the widget, with no restart; Resume picks up from now. Record: `docs/decisions/2026-11-08-mission-schedule-control.md`.

## Next (in rough order)

1. **The rest of the phone channel the owner decided on 2026-10-05** (the projects-mode brainstorm,
   recorded only in that chat: "phone = a dashboard page over Tailscale", uploads, inbox):
   photos and files from the phone into a project (upload route hardening), and an inbox where
   away-time work lands as drafts the owner accepts. Slice 1 is the page, the Tailscale bind and
   pairing; these two are what make the phone useful for projects rather than only for chat.
2. **Real cancellation.** Forward the turn's abort signal into the provider fetch
   (`engine/engine/callModel.ts` → the Ollama / llama.cpp clients) and give the Bash tool a way
   to kill its child, so Stop stops the GPU and the shell, not only the loop (F180's open item).
3. **HTTPS and an installable page.** Enable certificates on the tailnet and point
   `tailscale serve` at the Tailscale listener (never the loopback one — see the decision
   record), then a web manifest so the phone installs the page. Prerequisite for push.
4. **Rebuild what streamed while the phone was away.** Put the loop's session id on
   `/api/session` so a reconnecting page can fetch the transcript tail instead of showing a gap.
5. **Tell the phone when the engine waits.** When an approval card or AskUser question opens and
   no client is connected, push through the existing ntfy channel (`engine/daemon/ntfyChannel.ts`).
6. **Device hygiene.** `lastSeen` per device, an expiry, "revoke all", and a tailnet ACL note
   limiting the dashboard port to the owner's devices.

## Backlog (worth doing, not started)


- **GLM review triage (2026-11-06).** `docs/reviews/2026-11-06-glm5-engineering-review-triage.md` re-checks every finding of the 2026-10-30 GLM 5.3 review against HEAD and orders the work; A1 (strict type-check, F185), S4+S1+S2 (`docs/decisions/2026-11-06-untrusted-content-and-secret-paths.md`) the Ollama `resp.ok` fix with the doc quick wins (O1, O3, S9, O2, A6, the A2 stub) and CI (T1, with T7's shared test ports first: `.github/workflows/ci.yml`, `guards/testPortsDoNotCollide.test.ts`) are done. Next in that order: S3/S5/S6/S7/S8. The CI suite job is advisory until its Linux failures are classified. First Linux run (PR #188, 2026-11-06): 544 files green, 9 red, pytest green. Two were the runner (no git identity for `tools/git.test.ts`; no numpy/scikit-learn for the 17 `scripts/__tests__/cynco-outcome-model` and `cynco-hindcast-signals` tests) and one was a test of ours that leaned on the owner's exported `LOCALCODE_COMFYUI_URL` (`projects/bindingRunsCode.test.ts`) — all three fixed on that PR. The other six were Windows shapes in the tests, made platform-aware on the same PR: `harness/cyncoContract.test.ts` (refusing `&&` is the engine's verdict about PowerShell; on bash the contract must load intact), `projects/binding.test.ts` (`C:/Windows` is a relative path inside the root on Linux; `/etc` there), `tools/bash.test.ts` (`cat` where there is no `Get-Content`), `scripts/__tests__/cynco-gate-author.test.mjs` (the `R:` drive is Windows-only; `/repo` elsewhere), and `lsp/manager.test.ts`, whose "diagnostics" test runs `npx tsc` over the whole repo and needed 30 s, not 5. Once the suite job is green on Linux it can become a required check (branch protection — the owner's switch).
- `engine/agents/runner.ts` and `queue.ts` (`SubAgentRunner`, `AgentQueue`) have no production caller since the loop's never-read stub was removed (GLM A2, 2026-11-06); only their own tests use them, and real sub-agents go through `tools/impl/spawnAgent.ts`. Wire or remove — the owner's call.
- **Dynasty runbook mission (2026-10-27).** CynCo is now the default runner of the owner's MFL team through `C:/Users/civer/fantasyman/dynasty` (per-mission `allowedTools`/`cwd` landed for it; `docs/liveness-setup.md` -> "Dynasty runbook mission"). In the smoke run the model kept going after its first command said `skip:` (the runbook's `done` now refuses in that case). A daemon-side way to end a one-shot run when the prompt's first command says stop would save a model turn per idle trigger.
- `CYNCO.md` still carries an architecture sketch that trails `docs/MANUAL.md`; decide whether it
  stays a conventions file only.
- Repository root carries stray artefacts: eight `preflight_l4*.ts` files, a `Userscivercivkings/`
  folder, an untracked `engine.log`; twelve worktrees under `.claude/worktrees` and `.worktrees`.
- The engine suite has nine files failing on this Windows box before any change (EPERM on temp
  directories, 5 s timeouts in loop-integration tests) — see the baseline in the 2026-10-22 report;
  either fix the temp-dir handling or mark them as needing a clean environment.
- The dashboard page is one 6,900-line file; its tests lift functions by text. Fine while it
  works; a split is justified only by a concrete change that it blocks.
- A remote page's Config tab still shows sliders whose writes are refused; hide them when
  `window.__CYNCO_REMOTE`.
- The management-token prompt on the desk is a `window.prompt`; a small inline field would be
  friendlier.
- **From the locally-uncensored review (2026-10-27, `docs/reviews/2026-10-27-locally-uncensored-review.md`,
  section 5 has the ranked list with file refs).** Running refusal-free, in the order measure →
  prompt → weights: (1) refusal counter in the ledger — built 2026-10-27 (`scripts/cynco-refusal.mjs`,
  the `refusals` row field, ledger README); (2) a house-conduct section
  in the static system prompt behind `LOCALCODE_HOUSE_CONDUCT=true` — built 2026-10-27
  (`HOUSE_CONDUCT` in `engine/engine/systemPromptText.ts`, both prompts), the A/B against the
  counter is the next wave's job: one mission set with the variable, one without; (3) an
  abliterated profile beside the default (`bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF`),
  pre-staged with owner approval, tool-call rate compared in the ledger before it may become a
  default; in-app Heretic abliteration deliberately not now. Engine gaps verified in our source:
  (4) background Bash with status/kill under the F131 job; (5) search failure semantics —
  tri-state tier outcome, DDG bot-check = Failed, shared deadline, `[Tried: …]` line; (6)
  resolve-then-pin SSRF in `WebFetch` (a boundary change, owner's yes first); (7) per-repo rules
  file (`AGENTS.md`/`CLAUDE.md` of the target repo) into the system prompt; (8) sub-agent wake via
  `SteeringQueue`; (9) cursor-based event buffer for phone reconnect (= Next 4); (10) abort
  threading + Bash child kill with a cancel tombstone (= Next 2); (11) compaction merge +
  verbatim-loss check; (12) age-based tool-result decay; (13) stderr failure classifier + GGUF
  precheck + health timeout by file size; (14) `mmproj` sibling pairing in `resolveModel`; (15)
  per-turn memory recall as a turn note with ADD/UPDATE/NOOP; (16) device hygiene (= Next 6);
  (17) phone uploads at `inference` scope (= Next 1); (18) GPU pin by name, only once a second
  card lands in the 5090 box. Side findings: Bash safety does not refuse `--no-verify`; the
  README's kraken/spark personas cannot write (every sub-agent tier is read-only), so the README
  overstates them; `Git` sits in the read-only sub-agent tool set although it can commit.

## Deferred (decided not now, and why)

- **Public-internet access.** Needs TLS termination, stronger authentication, rate limiting and
  abuse handling; the tailnet covers the owner's actual use. Revisit only with a concrete need.
- **A native phone app or a second client codebase.** The dashboard page is the client until it
  meets something it cannot do.
- **A second agent or engine implementation for mobile.** The engine is the engine.
- **A general Origin policy on every dashboard POST.** Bearer tokens are not ambient credentials;
  only the handshake and `POST /api/pair` check Origin. Its own decision record if ever needed.
