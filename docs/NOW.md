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
box — BUILT 2026-11-08 (its existing Ollama + `qwen3:14b`, `LOCALCODE_FALLBACK_URL`/`_MODEL`; no llama-server installed there); **4** the phone-sized remote view — BUILT 2026-11-08 (Chat · Projects · Away, `LOCALCODE_BRAIN=off` on the phone engine, the jlens sidecar off everywhere unless `LOCALCODE_JLENS=on`); **5** phone files — BUILT 2026-11-08 (Attach in the chat, docx/xlsx extraction);
**6** ntfy and the NAS watchdog on the doorman — BUILT 2026-11-08 (ntfy container on `100.110.117.10:8090`, `naswatch.service`, PC ntfy task disabled). Then the tiers: the 4070 and 1080 Ti boxes on the
switch as wakeable workers, and S5 choosing the tier (`pc-wakefulness/knowledge/tiering-preview.md`).

**The image box** (`docs/decisions/2026-11-08-image-box-design.md`, the 4070 Ti Super as CynCo's eyes and sketchpad): Part A vision BUILT 2026-11-08 (`engine/vision/`: one look per attached photo on the box's Ollama, into the turn and into knowledge; owner steps: `ollama pull qwen3-vl:8b-instruct` on the box, `LOCALCODE_VISION_URL`/`_MODEL` as user variables); Part C (the doorman wakes both boxes: `with`/`health` on targets) and Part B (`vary`/`outline` of a project photo on ComfyUI, `Image` `source` + `transform`) BUILT the same day; live checks wait on the owner steps in the three PRs.

Phone access slice 1 (2026-10-22/27) is merged and in use; its design record stands.

Mission schedule control — built 2026-11-08 on branch `mission-schedule-control` (PR pending): the owner moves, switches off or pauses any daemon pass from a Missions tab (desk and phone) and the widget, with no restart; Resume picks up from now. Record: `docs/decisions/2026-11-08-mission-schedule-control.md`.

## Next (in rough order)

1. **The rest of the phone channel the owner decided on 2026-10-05** (the projects-mode brainstorm,
   recorded only in that chat: "phone = a dashboard page over Tailscale", uploads, inbox):
   photos and files from the phone into a project (upload route hardening), and an inbox where
   away-time work lands as drafts the owner accepts. Slice 1 is the page, the Tailscale bind and
   pairing; these two are what make the phone useful for projects rather than only for chat.
2. **HTTPS and an installable page.** Enable certificates on the tailnet and point
   `tailscale serve` at the Tailscale listener (never the loopback one — see the decision
   record), then a web manifest so the phone installs the page. Prerequisite for push.
3. **Rebuild what streamed while the phone was away.** Put the loop's session id on
   `/api/session` so a reconnecting page can fetch the transcript tail instead of showing a gap.
4. **Device hygiene.** `lastSeen` per device, an expiry, "revoke all", and a tailnet ACL note
   limiting the dashboard port to the owner's devices.

## Backlog (worth doing, not started)

- `engine/__tests__/bridge/abortIsATurnEnd.test.ts` failed once as a file in a full Windows suite run (2026-11-10) with all 8 tests green: its `afterAll` `rmSync` of the temp project got `EPERM` after its five retries, most likely a just-killed Bash child still holding the directory. Passes alone. Wait for the child's exit before the cleanup, or let the cleanup fail quietly. Same shape again that evening in `engine/__tests__/tools/bashAbort.test.ts` (the `afterAll` `EPERM`, plus "the executor hands its caller's signal to the tool" taking 2780 ms against its 2200 ms bound), with two 5000 ms timeouts beside it in the same full run (`snapshot/snapshotUndo.test.ts` "undo is stackable: two batches undo in reverse order", `training/shellWriteVisibility.test.ts` "appending to an already-tracked file is recorded as a modification"); all three files pass alone.
- **Stop does not end a turn that is waiting for the model port** (seen 2026-11-10, the wait push's live check). A lazy engine waits up to 30 minutes behind another engine's server or a one-shot (`ProcessManager.ensureRunningLazy`, the F182 rule), and `LlamaCppProvider` awaits `ensureReady()` with no abort signal, so `abort` is forwarded and nothing ends: `/api/session` stayed `processing: true`, `modelState: "waiting"` after Stop. F201 made Stop a turn end everywhere but here. Two smaller gaps on the same path: the wait reaches the dashboard only as an info `governance.alert` and never the engine log (the log stops at `Model call iteration 1`), and the busy fallback answers only when `gpu-busy.json` names a one-shot, not when another engine's server holds the port. The case that showed it, a server that was not CynCo's (the owner's game), is closed by F202: the engine stops that server and takes the port.
- **The daemon still defers behind a server that is not CynCo's** (left by F202, 2026-11-10). `isGpuBusy` (`engine/daemon/taskRunner.ts`) reads any `/health` answer on `LOCALCODE_PORT` as busy, so a one-shot is deferred for as long as the owner's game leaves its server on 8081. F202 changed the lazy engine only. The same `portOwner` answer (`engine/llama/portOwner.ts`) would settle it; the decision that is the owner's is whether an unattended one-shot may stop their other project's server the way a chat turn they started now does.
- Left by the wait push (`engine/daemon/waitPush.ts`, built 2026-11-10; seen on the phone the same day, the approval given from it): (a) the notification's link is the page address a paired device last opened a socket from, held in memory; until the phone has connected once since the engine started it is the bound phone listener's address (F203), which is the pairing screen for a phone that paired through a `.ts.net` name. Keeping the device's own address across restarts needs a store; do it with the HTTPS/installable-page item, when there is one address. (b) Nothing is sent when a client is connected but nobody is looking: a desk tab left open at 127.0.0.1:9161 counts as a client. Telling a watched tab from an abandoned one needs a visibility signal from the page. (c) A client that disconnects after the 5 s grace, with the wait still open, is not noticed; a check on the last socket closing would cover it.
- Left by real cancellation (F201), each small (the live Stop check is done, see F201): (a) Bash's own timeout kill (`exec`'s `timeout`) reaches only the shell, so a timed-out command's children may run on — unverified; `killProcessTree` is there to reuse; (b) a sub-agent's executor passes no abort signal, so stopping a turn does not kill a sub-agent's running Bash command; (c) `ensureReady` (the lazy model load) is not cancelled by Stop; (d) three process-tree kills now exist (`engine/daemon/taskRunner.ts`, `engine/brain/jlensSidecar.ts`, `engine/tools/impl/bash.ts`) with no shared helper.
- The CI suite job builds the `polyglot-bench` Docker image from the network on every run (`benchmark/true/polyglot/container.test.ts`: the runner has docker, so `skipIf(!dockerPresent)` does not skip it) and nothing bounds the build: `ensureImage` is a `spawnSync` with no timeout, which the test's 900 s deadline cannot interrupt. Seen 2026-11-10 on PR #213 (run 42741117068): `apt` stalled 1,902 s fetching `openjdk-21-jdk-headless` from archive.ubuntu.com, the build took 2,469 s, the suite job went red at 43m54s with that one test failed (588 files green); the six runs before it that day were green in 4–7 minutes. Options: a timeout on the build, a CI-only skip, or caching the image; which one is the owner's call, since a skip also hides a broken Dockerfile.
- The image box can still be left with a model loaded by something the engine cannot see (F198): an engine killed outright while a prompt runs, the ComfyUI page, a hand-run script. A `/free` at engine start when ComfyUI's queue is empty, or an idle sweep, would cover it; either unloads a model somebody else may have loaded on purpose, so it is the owner's call.
- The vision model stays on the image box for 10 minutes after a look (`keep_alive: '10m'`, `engine/vision/lookClient.ts`) unless a transform unloads it first (F194). Unloading right after each look would cost a reload (seconds) on the next one; unmeasured, and the owner's call.
- The owner's "high gpu use pings" from the image box (2026-11-09) are not sent by anything in this repo; what sends them, and whether it reads held memory or utilisation, is untraced.
- A sheet with a request (F197) ran live through the engine from this PC on 2026-11-09 (the cat photo: look 13.9 s, `shown.seen` names what the photo shows, the sheet shows those things and the eye line asked for); it has not yet run from the phone itself.
- The look at attach time (`engine/vision/`) is not coordinated with the picture queue: it can load the vision model while ComfyUI holds a checkpoint mid-queue (measured 2026-11-09: 1.3 GB of the card left with SDXL and the vision model together). F200 covers only the queue's own look.
- Asked on 2026-11-09 for "Just the one picture, no questions", the chat model made the picture, a night variant nobody asked for, a Glob, a Grep, a tracing sheet and a second "corrected" sheet in one turn, with no `LookAt`. Each extra is a minute or more of the image box. Whether the RenderUI prompt section or a per-turn bound on pictures should stop that is undecided.
- Pictures and photos live only in the project folder on this PC. The owner raised keeping them on the Synology NAS (2026-11-09). It was not what made reopened chats lose their pictures (F199: nothing was lost), but a second copy of project folders is a durability question nobody has decided: the owner's call.
- When the look for a sheet fails (F197), the plain sheet is drawn and the request is dropped; why is in the sidecar's `shown.reason` and the engine log only. `publicSidecar` does not carry `shown`, so on the phone the owner gets a sheet without the guides asked for and nothing saying so.
- A redo (`fix`) of a tracing sheet composes on `outlinePrompt(extras)`: the first request rides along without what the photo shows (the F196 look is about the correction only). Whether a request that describes the subject is then drawn instead of the photo is unmeasured.
- An engine with no vision model draws a sheet's request as before F197. The catalog tells the chat model an outline's `prompt` is guides or omissions, never the subject; whether that changes what it writes is unmeasured.
- On a sheet drawn from what the photo shows (F197), things the request asks to leave out are only partly left out: the background panel stayed on most of the measured sheets. The description of the photo names them; a question that names only the subject, or a second pass, is untried.
- The RenderUI prompt section is 4 characters under its 13,000-character bound in project mode (`genui/prompt.test.ts`): the next wording added to the catalog or the prompt must cut elsewhere, or the bound is raised on purpose.
- `dashboard/phoneAccess.test.ts` ("/api/phone tells the desk the code, the listeners…") reads the machine's own `LOCALCODE_DASHBOARD_HOST`: on the owner's PC, where it names the tailnet address, the test sees two listeners and fails; with the variable unset it passes (18/18). The test should set the variable itself, as the block at its line 336 does.
- Redo with a correction (F196) is pinned by unit tests and its wording was measured by hand on the image box, but it has not yet run from the phone end to end: check the first live redo's sidecar (`fix.seen`) against the photo.
- An outline's horizon, vanishing point and sight lines are the edit model's drawing, not a measurement. If the owner paints perspective from them, compute them from the photo (line detection → vanishing point) and draw them over the sheet.
- The RenderUI validator says nothing when a model puts `children` inside `props`: the element renders without them and no note reaches the model.
- The picture queue's activity keeps this PC awake (F196's change); nothing in the engine tells the image box to stay awake through a long queue, and whether its idle timer can fire under a running ComfyUI job is unmeasured.
- The image box's 16 GB is shared by Ollama and ComfyUI: a transform now unloads the vision model first (F194). Still open: the busy-fallback `qwen3:14b` (9 GB) on the same box can collide with an edit while a one-shot runs on the main PC; watch for it before moving the fallback.- The dashboard page does not reload when the engine under it is restarted on new code (F141 keeps the socket alive): on 2026-11-09 the phone's tab kept the old 12 MP downscale rule after the F190 engine restart. The page should compare a build id on `/api/session` after reconnect and reload itself when it changed.
- `writeJsonAtomic` (engine/projects/layout.ts) loses a Windows rename race under load: `EPERM: operation not permitted, rename images/index.json.tmp-… -> images/index.json` while a previous image job's commit still holds the file; seen 2026-11-08 as a ~1-in-5 flake of `service.test` "more than three generating" on the image-box branch (never on Linux CI). A bounded rename retry on EPERM/EBUSY, with a test that injects the failure, would close it.
- Two tests hit vitest's 5000 ms default only inside the full suite on this PC, one per run, and pass alone (2026-11-09): `daemon/oneShot.test.ts` "uses task.cwd as the loop workspace when the caller passes no override" and `bridge/brainWiring.test.ts` "escalation prunes redundant reads and emits brain.toolDivergence + governance.alert" (3 of 3 alone). 2026-11-10: three in one run, the same way (`brainWiring.test.ts` "tool points do NOT leak into any brain.uncertainty broadcast" and "content_block_start tool_use logprobs broadcast brain.toolUncertainty", `bridge/ruleAuthorityWiring.test.ts` "an advisory decision is emitted enforced:false with its authority, and is NOT applied"); both files pass alone. What they wait on under load is untraced.
- Image box, deferred from the 2026-11-08 review: a restart mid-look leaves a knowledge record at "looking at the picture…" until a rescan (a startup pass over pending records); the History tab and a reopened chat do not yet show a picture's `transform`/`source` though the sidecar records them; the doorman's page does not name the companion box `/status` reports under `with`, and `status()` probes companions synchronously (two 2 s timeouts when both boxes sleep); a vary beside an operator generate workflow without `{{checkpoint}}` keys on `''`; `sidecarFault` accepts schema 2 without checking the transform fields' shapes.

- `POST /api/projects/:slug/rescan` outlives Bun.serve's default 10 s `idleTimeout` on a project with a handful of files (found 2026-11-08 rescanning `pc-wakefulness`): the work finishes server-side, the client sees the socket drop. Either raise `idleTimeout` on the dashboard server or make rescan answer at once and report through `project.ingest` events.
- Ollama on the GPU PC is installed but broken and unused since 2026-11-08 (embeddings moved to CynCo's own llama-server, `docs/decisions/2026-11-08-embeddings-own-llama-server.md`); uninstalling it is the owner's step. The 4070 box's Ollama stays (slice 2b fallback).


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
  `SteeringQueue`; (9) cursor-based event buffer for phone reconnect (= Next 3); (10) abort
  threading + Bash child kill with a cancel tombstone (= F201, merged); (11) compaction merge +
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
