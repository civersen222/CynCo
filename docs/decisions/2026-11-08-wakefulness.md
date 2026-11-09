# Wakefulness core: the GPU box sleeps, the doorman wakes it, the model loads on demand

**Date:** 2026-11-08 · **Status:** built (slices 1–6 of the design; 2b open) · **Design record:** `2026-11-08-wakefulness-design.md` (facts, goals, the six slices, the post-review decisions)
**Guards:** `scripts/doorman/test_doorman.py`; `engine/__tests__/power/{activity,awake}.test.ts`; `engine/__tests__/daemon/{gpuBusyFile,wakeSchedule,taskRunner}.test.ts`; `engine/__tests__/llama/{lazyLoad,processManager}.test.ts` (`describe('ProcessManager.ensureRunningLazy')`).

## Decision

1. **The always-on node is a separate, GPU-less box** (the Beelink "doorman", Ubuntu, tailnet `100.110.117.10`), not the GPU PC and not the NAS. It runs `scripts/doorman/doorman.py` as a systemd unit bound to its Tailscale address: `GET /` wakes the main PC over the basement switch (etherwake burst, every 15 s for 60 s) and hands the phone to the dashboard once it answers; `POST /schedule` takes the daemon's next-fire list and bursts 3 minutes before each.
2. **The llama port is the GPU arbiter and the lazy path never kills a live owner.** Under `LOCALCODE_LLAMA_LAZY` the engine does not load the model at boot; the provider's first request waits while `~/.cynco/gpu-busy.json` names a running one-shot (written by the daemon's `TaskRunner` for the child's lifetime), and kills only a port occupant with no live owner. The F182 class is closed for the lazy path. `LOCALCODE_LLAMA_IDLE_UNLOAD_MS` unloads (slot snapshot first) when nothing has been open for that long. Defaults keep today's eager behaviour.
3. **One activity registry says "busy".** Turns, one-shot children and in-flight model requests register in `engine/power/activity.ts`; the idle-unload timer runs only at zero and a Windows power request (`scripts/hold-awake.ps1`, self-terminating when its parent dies) exists only above zero. Nothing in code sleeps the PC: the owner sets Windows "Sleep after"; the doorman wakes it.
4. **The daemon stays on the GPU PC** and publishes its next-fire times to the doorman (`CYNCO_DOORMAN_URL`). Moving the daemon to the doorman is a later design.
5. **Autostart.** A logon task "CynCo headless engine" (`scripts/run-headless-engine.cmd`, lazy) is registered by `scripts/cynco-services.ps1 register engine`; the desk widget's CynCo row drives it.

## Rejected (see the design record for the full list)
Wi-Fi wake-on-LAN (fails on this board, 3 tests), the NAS as front door (froze twice; cannot reach the PC's wired port), a Pi 4 (SD slot unreadable, USB-reader boot hung), USB-gadget wake from a Pi (works in principle, split-power fiddle), the phone engine interrupting a running mission (owner chose wait + notice + a smaller-model fallback, slice 2b).

## Two engines on one box — decided by the owner 2026-11-08, built the same day
"When I start a desk engine from the TUI or the desktop dashboard, the phone engine is silent and restarted after; if I'm at the machine I won't be using it on my phone." `engine/power/siblingEngine.ts`: an eager interactive engine on Windows runs `cynco-services.ps1 stop engine` before `bootstrapProvider` and `start engine` from `cleanShutdown`; the phone engine (lazy) and one-shot children never hand off. Pinned by `engine/__tests__/power/siblingEngine.test.ts`. The finding, for the record:
**Two engines on one box.** The autostarted headless engine holds 9160/9161 and, when warm, port 8081. A desk engine launched from the TUI falls back to 9162/9163 and its *eager* `ensureRunning()` kills whatever answers on 8081 as stale — the headless engine's warm server — which then spends its restart budget trying to rebind. Not covered by the plan (found in review). Options: the TUI launch (or `cynco-services.ps1`) stops the headless engine first and restarts it after; or the desk engine refuses to start while the headless one is warm; or the desk engine is also lazy. Until decided: stop the headless engine from the widget before a desk session, or use the desk session through the headless engine's own dashboard.

## Slice 6 — ntfy and the NAS watchdog on the doorman (2026-11-08)

**Problem.** ntfy ran on the GPU PC (Windows binary, task "Dynasty ntfy"). Once the PC sleeps, phone
Approve/Reject commands have no server to land on until the next wake, and nothing can say "the NAS is
down" because the only watcher is asleep. **Decision.** ntfy moves to the doorman as a Docker container
bound to its tailnet address (`scripts/doorman/ntfy/`), no auth file (tailnet membership authenticates;
the phone's http actions need anonymous publish), 168 h cache in a volume. A small `naswatch.service`
(`scripts/doorman/naswatch.py`) pings the router first, then the NAS, and publishes to `cynco-alerts`
only on a state change, so a dead router is one alert, not a storm. `deploy.sh` installs both.
**Clients repointed** the same day: the daemon's `CYNCO_NTFY_URL`, the approval listener's `ntfy_url`,
the phone's ntfy app; the PC task is disabled, not deleted (rollback = re-enable + repoint).
`cynco-services.ps1` and the widget show the doorman's ntfy as reachable or not instead of a local task.
**Costs.** Docker on the doorman (already present for the OS image); one more config file
(`/etc/doorman/naswatch.json`); the PC can no longer notify the phone when the doorman is down — the
doorman is the single always-on node by design (decision 1). **Guards.** `scripts/doorman/test_naswatch.py`
(state-change-only, router-first); live check 2026-11-08: a PC publish to `100.110.117.10:8090` read back
in under a second; daemon up against the new URL.

## Verified live (2026-11-08)
Doorman service answers `/status`, `/wake`, `/schedule`, `/` on the tailnet; `etherwake` from the doorman woke the sleeping main PC in 7 s with Power-Troubleshooter naming the USB adapter's host as the wake source, nobody at the desk. The engine-side live proof (cold GPU behind a live dashboard, Sleep-after + wake-before-trigger) runs after merge + pull, since the daemon and the headless engine run from the main checkout; its results go in the PR.
