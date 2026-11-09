# Mission schedule control: the owner moves, switches off and pauses passes from the desk or the phone

**Date:** 2026-11-08 · **Status:** built on branch `mission-schedule-control` (PR pending) · **Design:** `docs/superpowers/specs/2026-11-08-mission-schedule-control-design.md`
**Guards:** `engine/__tests__/daemon/{schedule,missionRunner,wakeSchedule,control}.test.ts`; `engine/__tests__/dashboard/{missionsApi,missionsRoutes,missionsView,scopes}.test.ts`; `scripts/__tests__/cynco-widget.probe.test.mjs`.

## What was there

Every pass time lived in a fantasyman generator (`make_cynco_mission.py`) that writes `~/.cynco/missions/<id>/mission.json`. Changing a time, or turning one pass off, meant editing a Python file, regenerating, and restarting the daemon. The only live control was the pause switch (`daemon-control.json`), reachable from the desk widget only. The owner wanted to change when passes run, switch single passes off, and pause everything, from the desk or the phone, without a restart.

## Decision

1. **Two owners, one file each.** The daemon owns `state.json` (`nextFire`, `scheduleSeen`, the parked run). The dashboard owns `schedule.json` (per-trigger overrides: `enabled`, the cadence fields, `timeoutMs`). The daemon only reads `schedule.json`; the dashboard never touches `state.json`. `daemon-control.json` is the one file several parties write: the daemon reads it and the dashboard writes it through `control.ts` (`readControl`/`writeControl`), atomically (tmp in the same directory, then rename), recording `by`; the widget, being PowerShell, writes the same `{paused, requestedAt, by}` shape atomically itself (`Write-DaemonControl` in `scripts/cynco-widget.ps1`: its own tmp file, then `Move-Item`). `schedule.json` is separate from `mission.json` so a regeneration cannot lose the owner's changes.
2. **Schedule and pause are operational switches, not engine configuration.** The three routes (`GET /api/missions`, `PUT /api/missions/<id>/triggers/<tid>`, `POST /api/daemon/pause`) sit under the `inference` scope, the `/api/projects` precedent. That is the scope a paired phone's device record holds and the only token the desk page carries. A management-scoped route would make the desk page ask for a paste once per tab and would shut the phone out, which defeats the point. The cost is accepted: any desk tab or paired phone can flip a pass or pause the daemon. The reach is bounded, since an override can change when a pass runs, never what it does (`precheck`, `missedPolicy`, prompts and tools are not overridable), and a bad value cannot stop the daemon. `scopes.test.ts` still pins "changing configuration needs the management scope"; it gains a case saying these routes are not configuration.
3. **Resume picks the schedule up from now** (owner's decision 2026-11-08). The first tick after a pause lifts moves every trigger that came due during the pause to its next slot and fires nothing for it. Thirteen of the fifteen live triggers are `run-once-on-startup`; without this a day-long pause followed by Resume would run up to thirteen passes back to back. The parked run that was interrupted by the pause still resumes. Daemon startup keeps its catch-up; only a pause is "from now". A pass missed by a pause can be run on demand with fantasyman's `run_trigger_now.py`.
4. **A disabled trigger keeps advancing silently.** Its `nextFire` moves to the next slot each time it comes due and nothing is recorded or run. Re-enabling it, or losing the override, resumes the normal grid with nothing missed, so `run-once-on-startup` cannot back-fire it. A run parked for a trigger that gets disabled is dropped with an ok run recorded (`dropped on disable: <id>`); a run on the GPU is left to finish. The schedule is re-read right before each fire, so a pass switched off while an earlier pass in the same tick runs does not fire after it.
5. **A torn file keeps the last good set; a deleted file means no overrides.** `readSchedule` reports `ok`, `absent` or `bad`. `bad` keeps the in-memory set and logs once per mtime, so a half-written file can never re-enable a switched-off pass. `absent` clears it, because deleting the file is how the owner resets. An override that parses but cannot compute a next fire falls back to the trigger's `mission.json` cadence for that trigger only.

## Rejected alternatives

**1. Rewriting `mission.json` from the dashboard.** Rejected: the generator owns it and would overwrite the change on the next run; two writers of one file.
**2. A management-scoped route with a pasted token.** Rejected: the desk page would prompt on every tab and the phone could not do it at all. See decision 2.
**3. Firing the missed passes on Resume.** Rejected by the owner: a burst of passes after a long pause is not what Resume should mean.
**4. A disabled trigger that stops advancing.** Rejected: its `nextFire` goes stale, and re-enabling it makes `run-once-on-startup` fire it at once.

## Not covered, on purpose

`mission.json` changes (prompts, tools, precheck, the trigger list) still need a daemon restart. `schedule.json` needs none. The owner's phone running the Missions tab is a manual check that remains.
