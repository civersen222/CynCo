# Wakefulness: CynCo reachable from the phone while the GPU boxes sleep

**Date:** 2026-11-08 · **Owner:** civer · **Status:** design, approved in conversation 2026-11-02..08
**Companion material (facts, hardware log, tiering preview):** `C:\Users\civer\cynco-projects\pc-wakefulness\` — `plan.md`, `knowledge/wakefulness-design.md`, `knowledge/tiering-preview.md`, `knowledge/mini-pc-setup.md`.

## Intent

The owner opens the dashboard from the phone over Tailscale, lands in a project (or asks a free research question), gets an answer, closes the tab — while the GPU machines spend the rest of the day asleep. Scheduled fantasy work (digest cards, dynasty runbook) runs on its own and the results are read on the dashboard. The owner prefers checking in to being pinged.

Today an interactive engine must be up for the dashboard to exist (F141), and `bootstrapProvider.ts:186` (`processManager.ensureRunning()`) loads the 27B model at boot and never unloads it: phone access = a loaded model all day. The liveness daemon (`engine/daemon`) is already the "never loads a model" sentinel but runs on the GPU box, so the box can never sleep.

## What exists now (verified 2026-11-08)

- **doorman**: Beelink Mini S12 Pro (N100, Ubuntu 24.04), always on, ~6 W. Tailnet `100.110.117.10`; Wi-Fi `192.168.0.147`; wired `enp1s0` on a basement Netgear GS305 switch that has **no uplink** (an island for wake packets and box-to-box traffic). `etherwake`, `docker`, `tailscale` installed. `ssh -i ~/.ssh/cynco-doorman cynco@100.110.117.10`, NOPASSWD sudo.
- **main PC "longdongsilver"** (RTX 5090, Windows, tailnet `100.101.192.101`, Wi-Fi `192.168.0.139`): S3 + wake timers available; onboard Realtek port dead; wired via an ASIX AX88179 USB adapter **MAC `6C-6E-07-2D-AA-00`** ("Ethernet 2"), whose link survives S3. **Proven 2026-11-08 10:41:** `sudo etherwake -i enp1s0 6C:6E:07:2D:AA:00` from doorman wakes it in ~7 s (Power-Troubleshooter: USB4 host). A packet sent before sleep completes is ignored → senders repeat every ~15 s for a minute. "Sleep after" is currently Never.
- **4070 Ti Super box** (16 GB, Windows, same room, serves ComfyUI at `http://192.168.0.47:8188`) and **1080 Ti box** (11 GB, Windows; corrected by the owner on 2026-11-11: it is a GTX 1070 Ti, an 8 GB card): not yet on the switch; their wired MACs unknown.
- `LOCALCODE_DASHBOARD_HOST=127.0.0.1,100.101.192.101` is permanent on the main PC; phone pairing works (`docs/decisions/2026-10-22-phone-access.md`).
- Missions: `fantasy-digest` (4 daily cards 12:15–13:45), `mfl-dynasty` (08:00, 09:00 weekly, 11:15, Thu cron, gameday cron, `transaction-watch` every 120 min). Daemon = logon task "CynCo liveness daemon" on the main PC; ntfy on the main PC `100.101.192.101:8090`.
- Phone uploads: `/api/projects/:slug` multipart (50 MB) exists; extraction: md/txt/pdf/epub/images; no docx/xlsx.

## Goals (observable)

1. **Knock:** phone (Tailscale on) opens `http://doorman:<port>/` → within ~60 s it is on the main PC's paired dashboard, the PC having been asleep.
2. **Cold GPU behind a live dashboard:** an engine is up, `nvidia-smi` shows no llama-server; first chat message loads the model (~30 s) and answers; after an idle period llama-server is gone again.
3. **Sleep on its own, wake for work:** the main PC sleeps when idle; doorman wakes it before each scheduled trigger; the daemon fires the trigger; the box sleeps again. Power-Troubleshooter shows the USB host as the wake source at those times; the mission ledger shows the runs.
4. **Nothing is lost:** a turn, a one-shot or a mission in progress never has the PC sleep under it.
5. **Phone-sized view:** a remote page lands in projects, chat first, with no governance console, no brain sidecar started for it, and a "while you were away" list of mission results.
6. **Files from the phone:** attach in the chat → the existing upload route; docx and xlsx extract like pdf does.

## Non-goals (this design)

- Moving the daemon off the main PC. Slice 3 keeps it where it is and lets doorman wake the box in time; a remote task runner over SSH is a later design.
- The 4070 / 1080 Ti boxes as tiers, and S5 choosing a tier. Later; needs their MACs, BIOS/driver wake settings and an engine notion of "worker". Recorded in `tiering-preview.md`.
- HTTPS / installable page (`tailscale serve`), push notifications (owner chose pull), the NAS as anything but storage.

## Anti-goals (failure even if it "works")

- A second engine, chat implementation or client codebase.
- Anything bound beyond loopback + Tailscale; anything on the NAS in the wake path.
- The PC sleeping under a running turn/mission; the model unloading mid-turn.
- Changing the PC's network adapter settings from code (owner's standing rule); a kill sweep instead of the F131 job.
- A new env var without a read-site in the README inventory; a stub waiting for a caller.

## Constraints

- Follow `AGENTS.md` → "How to change CynCo"; every item of `docs/POST-CHANGE-VERIFICATION.md`; package `CLAUDE.md` is the owning doc; F-numbers for closed failures.
- The daemon and widget run from the **main checkout**; a change is live only after merge + pull.
- The owner is short on Claude tokens: terse reports, no re-running settled hardware tests.
- Windows power: the sleeper is Windows' own idle timer ("Sleep after", owner sets the minutes). Code only *prevents* sleep while busy (a power request) and *schedules* wake (doorman). No code calls `SetSuspendState`.

## Decided design — six slices, each usable alone

### Slice 1 — doorman front door (`scripts/doorman/`, deployed by scp; runs on doorman)
A small Python 3 stdlib HTTP service (`doorman.py`) as a systemd unit, bound to the Tailscale address only, port 9170. Config `targets.json`: `{ "main": { "mac": "6C:6E:07:2D:AA:00", "dashboard": "http://100.101.192.101:9161/", "iface": "enp1s0" } }`. Since the image box (2026-11-08, `docs/decisions/2026-11-08-image-box-design.md` §5) a target may carry `"with": ["image"]` — a knock or a scheduled burst for it bursts those targets too, never doubled — and `"health"`, a URL probed instead of a dashboard for a box that has none (the 4070 box's Ollama `/api/version`); `/status` lists them under `with`.
- `GET /` → starts a **wake burst** for the default target (etherwake every 15 s for 60 s, in a background thread; a burst already running is not doubled) and returns a page: "Waking CynCo…", polls `GET /status?target=main` every 3 s, `location.replace(dashboard)` when `up`.
- `GET /status?target=` → `{ up: bool, lastWakeAt, burstActive }` where `up` = a GET to the target dashboard URL answered 200 within 2 s (doorman reaches the PC over the tailnet; the switch island has no IP).
- `GET /wake?target=` → starts a burst, JSON ack (what the daemon-side scheduler calls in slice 3).
- No auth beyond the tailnet (the dashboard itself still requires pairing). Logs to journald.
- Verified by: a pytest in `scripts/doorman/test_doorman.py` (burst scheduling with a fake clock and fake etherwake; status mapping) run on the PC, and the live knock from the phone.

### Slice 2 — engine: lazy model load, idle unload (`engine/llama/`, `engine/bootstrapProvider.ts`)
- `LOCALCODE_LLAMA_LAZY=true` (default **false** so missions and the TUI are unchanged): `bootstrapProvider` does not call `ensureRunning()`; `LlamaCppProvider` calls `processManager.ensureRunning()` before its first request and whenever the server is not running, serialised so concurrent first calls spawn once. The dashboard shows "model: cold / loading / warm" from existing `EngineEvent`s or one new status field on `/api/session` (no new frame type if the existing status frame can carry it).
- `LOCALCODE_LLAMA_IDLE_UNLOAD_MS` (default **0** = never): after that long with no in-flight request and no open turn, `processManager.stop()`; a slot snapshot is saved first (existing `saveSlot`) so the next load restores context.
- The headless engine the widget launches sets both (`cynco-widget.ps1` → env for the spawned `bun engine/main.ts`), so phone-facing engines are lazy; nothing else changes.
- Verified by: `engine/__tests__/llama/lazyLoad.test.ts` (no spawn at boot under the flag; first call spawns once under concurrency; idle timer stops after N ms with no requests and not while a request is open; timer disabled at 0), the F140 pre-spawn refusal still runs on the lazy path, README env inventory (`npm run audit:wiring`), `engine/llama/CLAUDE.md` updated.

### Slice 3 — sleep policy on the main PC: hold while busy, wake before work
- **Hold:** `engine/power/awake.ts` — `holdAwake(reason): () => void`. On win32 it spawns `scripts/hold-awake.ps1` (calls `SetThreadExecutionState(ES_SYSTEM_REQUIRED|ES_CONTINUOUS)` via Add-Type and sleeps until killed; shows in `powercfg /requests` as a SYSTEM request). Non-Windows: no-op. Callers: `TaskRunner.run()` around the one-shot child (daemon), `ConversationLoop` around a turn (engine; `processing = true` … terminal frame). Refcounted so overlapping holds spawn one helper.
- **Wake before work:** `engine/daemon/wakeSchedule.ts` — from the loaded missions, compute the next due trigger across all missions (pure, reuses `computeNextFire`) and POST it to doorman as `GET /schedule?target=main&at=<iso>` (slice 1 gains this endpoint: a list of future times; doorman runs the wake burst at `at − 2 min`). The daemon refreshes the schedule after every tick that changes `nextFire`. The daemon itself keeps running on the main PC; while the PC sleeps it simply doesn't tick, and on wake it fires what is due (existing `missedPolicy`). `transaction-watch` every 120 min means ~12 wakes/day; the owner may lengthen it in `mission.json`.
- **Sleep:** the owner sets Windows "Sleep after" (AC) once the above is live; nothing in code sleeps the PC.
- Verified by: `engine/__tests__/power/awake.test.ts` (refcount, helper spawned/killed, no-op off win32), `engine/__tests__/daemon/wakeSchedule.test.ts` (next-fire across missions, posted once per change), a manual check: `powercfg /requests` shows the request during a one-shot; a real trigger wakes the PC (Power-Troubleshooter) and the ledger shows the run.

### Slice 4 — remote view (`engine/dashboard/index.html`, `server.ts`)
- When `window.__CYNCO_REMOTE`: default hash `#projects` (not Chat/Governance), the tab strip shows **Chat · Projects · Away** only, the Brain tab is absent, and the page is laid out for a phone (one column, 16 px gutters, send box pinned to the bottom, tool rows collapsed to one line each).
- **Away** = "while you were away": the last N mission runs (`runs.jsonl` of every mission under `CYNCO_MISSIONS_DIR`) via a new `GET /api/away` (inference scope), each with time, mission, trigger, ok/FAILED and the summary; a digest card link where the outcome carries one.
- Engine side: `startJlensSidecar` and the `ActivationsConsumer` are not started when `LOCALCODE_BRAIN=off` (new switch, default on → no behaviour change for the desk); the widget's headless engine sets it off. No per-connection logic in the engine.
- Verified by: `engine/__tests__/dashboard/remoteView.test.ts` (lifted functions as the existing dashboard tests do: tab set under remote, default hash, away rendering), `engine/__tests__/dashboard/awayRoute.test.ts` (scope, shape, missing dir → empty), a phone screenshot in the PR.

### Slice 5 — phone files (`engine/dashboard/index.html`, `engine/projects/extract/`)
- An attach button beside the send box while a project is bound (remote and desk) → `POST /api/projects/:slug` multipart (existing route; the response's ingest event is shown as a row). Camera capture allowed via `accept` on the input.
- `extract/docx.ts` (unzip `word/document.xml`, paragraphs → text; tables → rows) and `extract/xlsx.ts` (`xl/sharedStrings.xml` + each `xl/worksheets/sheetN.xml` → one segment per sheet, CSV-like rows) registered in `extract/index.ts`; no new dependency if Bun's zip handling suffices, else `fflate` (named in the PR as a review trigger).
- Verified by: fixture-based tests for both extractors, an upload-route test with a docx fixture, and a phone upload in the PR.

### Slice 6 — ntfy and the NAS watchdog move to doorman (docker compose in `scripts/doorman/`)
- `ntfy` container bound to the Tailscale address; the daemon's `CYNCO_NTFY_URL` repointed; the phone app repointed. A `naswatch` container: ping the router first, then the NAS; alert only on a state change (the owner's 2026-10-28 ask).
- Verified by: the daemon publishes a digest through the new ntfy (ledger + ntfy log), a simulated NAS outage (block the probe) alerts once.

## Order and why
1 (front door) → 2 (lazy model) → 3 (hold + wake schedule, then the owner sets Sleep-after) → 4 (remote view) → 5 (files) → 6 (ntfy/watchdog). 1–3 deliver goals 1–4 and are each a day; 4–5 make the phone pleasant; 6 removes the last always-on thing from the GPU box.

## Left to the builder
- Exact placement of the lazy `ensureRunning()` in `LlamaCppProvider` (one chokepoint all requests pass through) and how `ctx-size`/checkpoint budget (F91) is preserved on re-spawn (reuse the same `ProcessManager` config object).
- Whether the remote tab set is CSS-only (`body.remote`) or JS; prefer the smallest diff in the 6,900-line page.
- The hold-awake helper: PowerShell P/Invoke vs a 20-line C# compiled once; PowerShell is fine if it starts in < 1 s.
- `GET /schedule` storage on doorman: an in-memory list persisted to `/var/lib/doorman/schedule.json`.
- Test harness for `doorman.py` on Windows (fake etherwake path via env).

## Review triggers present (AGENTS.md)
A separately running process (doorman service; hold-awake helper); three new `LOCALCODE_*` switches (`LLAMA_LAZY`, `LLAMA_IDLE_UNLOAD_MS`, `BRAIN`) — each with a read site, README inventory, default = today's behaviour; a new HTTP route (`/api/away`) at inference scope; possibly one dependency (`fflate`). Decision record: this file + `docs/decisions/2026-11-08-wakefulness.md` (short, pointing here) when slice 3 lands.

## Decisions after the builder check (2026-11-08)

Owner's answers:
- **Phone knocks during a running mission → wait, never kill.** The page and the chat say "GPU busy with `<mission/trigger>`, about N min left" and the model loads when the one-shot ends. The estimate comes from the daemon: `TaskRunner` writes `~/.cynco/gpu-busy.json` `{ task, triggerId, startedAt, timeoutMs, pid }` for the life of a one-shot and removes it after (atomic write, owner = taskRunner.ts); the engine and the widget read it. **Owner also asked for a smaller model on another box to answer meanwhile** → new **slice 2b** below.
- **Headless phone engine autostarts at logon** (a logon task "CynCo headless engine", registered/managed by `cynco-services.ps1` as service `engine`; the widget's CynCo row drives that task). It starts cold (lazy).
- **Brain off on the headless engine is accepted**, desk Brain lives on the TUI-launched engine only.

Builder's calls (mine):
1. **Port 8081 is the GPU arbiter; lazy never kills.** `ensureRunning()` today kills any occupant of its port (processManager.ts:350). Under `LOCALCODE_LLAMA_LAZY` the lazy path instead *waits* while `gpu-busy.json` names a live pid or the port answers a foreign server, polling every 5 s up to `LOCALCODE_LLAMA_LAZY_WAIT_MS` (default 30 min), surfacing the busy notice; it kills only a server that is provably stale (port occupied, no busy file, pid of the recorded owner gone). The daemon's `isGpuBusy` is unchanged: a cold lazy engine reads as free (correct), a warm one as busy (existing backoff). Closes the F182 class for the lazy path.
2. **One activity registry for "busy".** `engine/power/activity.ts`: `beginActivity(kind, label): () => void`, refcounted. Consumers: hold-awake (slice 3) and idle-unload (slice 2: the timer runs only while the count is 0, keyed on turns, one-shots and in-flight provider requests, not on provider requests alone). Idle unload = `saveSlot()` then the deliberate `stop()`; it does not touch the crash-restart budget. The periodic slot-snapshot timer and the activations consumer skip while cold. Capability/context probes and calibration run on first load, not at boot.
3. **Hold-awake helper self-terminates**: it polls its parent pid every 5 s and exits when the parent is gone, in addition to dying with the F131 job. One helper per process (engine, daemon, one-shot child) is fine.
4. **Wake schedule**: the daemon sends the full list of next-fire times (every trigger, every mission) and doorman *replaces* its list; the daemon re-sends whenever any `nextFire` changes and retries on the next tick after a failed send. Lead time **3 min** (7 s wake + Tailscale + engine readiness, measured and tuned later). `missedPolicy` semantics unchanged. Doorman's `/status` and the "waking" page allow up to 3 min for Tailscale to come back after resume.

### Slice 2b — busy fallback to a secondary worker — BUILT 2026-11-08, as Ollama not llama-server
- As designed the owner would install llama.cpp on the 4070 Ti Super box. On 2026-11-08 the box already served Ollama 0.40 on `192.168.0.47:11434` with `qwen3:14b` (9.3 GB Q4_K_M, native tools, 40k ctx; measured 11 tok/s, 24 s cold load), so the existing `OllamaProvider` is the fallback and nothing is installed there (smallest complete solution). The box stays awake for now — its own sleep/wake is the later "tiers" design.
- Engine: `LOCALCODE_FALLBACK_URL` (unset = off) + `LOCALCODE_FALLBACK_MODEL` (default `qwen3:14b`), read in `engine/llama/busyFallback.ts`. `BusyFallbackProvider` wraps the lazy provider: GPU busy (`gpu-busy.json`) and our server cold → if the fallback's health answers within 2 s the request goes there with `model` rewritten and the chat sees "GPU busy with <task> (<trigger>) — about N min left; answering on qwen3:14b at 192.168.0.47:11434 meanwhile" (once per one-shot, same `onWaiting` channel); fallback down → wait as before. Only a lazy engine uses it; the headless engine sets both. Pinned by `engine/__tests__/llama/busyFallback.test.ts`.
- Known limits: the fallback's context is Ollama's `num_ctx` for that model, smaller than the 27B's budget — a very long project chat may be cut on the fallback; the 14B is a weaker model and says so only through the notice. Measured effect on phone answers: unmeasured (hypothesis).
- Order becomes 1 → 2 → 3 → 2b → 4 → 5 → 6.
