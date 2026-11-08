# Wakefulness core: the GPU box sleeps, the doorman wakes it, the model loads on demand

**Date:** 2026-11-08 · **Status:** built (slices 1–3 of the design) · **Design record:** `2026-11-08-wakefulness-design.md` (facts, goals, the six slices, the post-review decisions)
**Guards:** `scripts/doorman/test_doorman.py`; `engine/__tests__/power/{activity,awake}.test.ts`; `engine/__tests__/daemon/{gpuBusyFile,wakeSchedule,taskRunner}.test.ts`; `engine/__tests__/llama/{lazyLoad,processManager}.test.ts` (`describe('ProcessManager.ensureRunningLazy')`).

## Decision

1. **The always-on node is a separate, GPU-less box** (the Beelink "doorman", Ubuntu, tailnet `100.110.117.10`), not the GPU PC and not the NAS. It runs `scripts/doorman/doorman.py` as a systemd unit bound to its Tailscale address: `GET /` wakes the main PC over the basement switch (etherwake burst, every 15 s for 60 s) and hands the phone to the dashboard once it answers; `POST /schedule` takes the daemon's next-fire list and bursts 3 minutes before each.
2. **The llama port is the GPU arbiter and the lazy path never kills a live owner.** Under `LOCALCODE_LLAMA_LAZY` the engine does not load the model at boot; the provider's first request waits while `~/.cynco/gpu-busy.json` names a running one-shot (written by the daemon's `TaskRunner` for the child's lifetime), and kills only a port occupant with no live owner. The F182 class is closed for the lazy path. `LOCALCODE_LLAMA_IDLE_UNLOAD_MS` unloads (slot snapshot first) when nothing has been open for that long. Defaults keep today's eager behaviour.
3. **One activity registry says "busy".** Turns, one-shot children and in-flight model requests register in `engine/power/activity.ts`; the idle-unload timer runs only at zero and a Windows power request (`scripts/hold-awake.ps1`, self-terminating when its parent dies) exists only above zero. Nothing in code sleeps the PC: the owner sets Windows "Sleep after"; the doorman wakes it.
4. **The daemon stays on the GPU PC** and publishes its next-fire times to the doorman (`CYNCO_DOORMAN_URL`). Moving the daemon to the doorman is a later design.
5. **Autostart.** A logon task "CynCo headless engine" (`scripts/run-headless-engine.cmd`, lazy) is registered by `scripts/cynco-services.ps1 register engine`; the desk widget's CynCo row drives it.

## Rejected (see the design record for the full list)
Wi-Fi wake-on-LAN (fails on this board, 3 tests), the NAS as front door (froze twice; cannot reach the PC's wired port), a Pi 4 (SD slot unreadable, USB-reader boot hung), USB-gadget wake from a Pi (works in principle, split-power fiddle), the phone engine interrupting a running mission (owner chose wait + notice + a smaller-model fallback, slice 2b).

## Verified live (2026-11-08)
Doorman service answers `/status`, `/wake`, `/schedule`, `/` on the tailnet; `etherwake` from the doorman woke the sleeping main PC in 7 s with Power-Troubleshooter naming the USB adapter's host as the wake source, nobody at the desk. The engine-side live proof (cold GPU behind a live dashboard, Sleep-after + wake-before-trigger) runs after merge + pull, since the daemon and the headless engine run from the main checkout; its results go in the PR.
