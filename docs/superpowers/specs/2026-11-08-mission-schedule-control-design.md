# Mission schedule control — design

**Date:** 2026-11-08
**Owner's words:** "these passes are happening way too often. i want to be able to see each pass for each mission somewhere where i can set the schedule ... I also thought i paused everything using the widget but recently a trade pass ran while paused ... i cannot minimize or send the widget to the back behind another program."
**Repos touched:** CynCo (`C:\Users\civer\localcode`, branch `mission-schedule-control`) — nearly all of it. fantasyman — none required (its generators keep emitting the defaults; a doc note at most).

## 1. Intent and why

The liveness daemon (`engine/daemon/`) runs two fantasyman missions, `mfl-dynasty` (8 triggers) and `fantasy-digest` (7 triggers), from `~/.cynco/missions/<id>/mission.json`. Per day that is 16 trade passes (two teams, every 2 hours 07:25–21:25), 2 dailies, 4 digest cards plus game-day and Thursday passes. The owner has no place to see this schedule or change it: the times are constants inside two Python generators in fantasyman, and a change means regenerating mission.json and restarting the daemon.

Two faults compound the feeling of "too often":

1. **The pause and precheck code never reached main.** CynCo#184 (`daemon-pause-precheck`: `daemon-control.json` pause/resume, `precheck: 'command'`, widget GPU row with Pause/Hold) was merged into its base branch `daemon-no-logprobs`, not into `main`. The `~/.cynco`-serving checkout at `C:\Users\civer\localcode` is on `main` and the daemon was restarted from it on 2026-11-08 12:19 MT. That daemon ignores the pause file and runs the trade gate inside the model instead of before it, so every trade pass loads the 30 GB model again. The running widget (pid started 2026-11-06 14:23 from the branch's script, still in memory) shows Pause and writes the file; nothing reads it. Three trade passes ran after the owner paused at 14:25 MT on 11-08.
2. **The widget is pinned.** `scripts/cynco-widget.ps1` builds a WPF window with `ResizeMode="NoResize"` (which removes the minimize button) and `Topmost="True"`.

Success looks like: the owner opens one page (PC or phone), sees every pass of every mission with its cadence, next fire and last result, flips a pass off or changes its cadence, and the daemon obeys within one tick with no regeneration or restart. Pause from the widget or the page actually stops the daemon. The widget minimizes and goes behind other windows like any program.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. Land the lost pause/precheck/widget work on `main` and restart the daemon from it, today, before anything else.
- G2. One schedule store the daemon owns, per mission, that overrides mission.json's triggers (enabled/disabled, cadence, timeout) and is re-read every tick. Works for every mission the daemon loads, present and future.
- G3. A **Missions** tab on the CynCo dashboard (desk and phone layouts) that shows per mission, per trigger: name, cadence in plain words, next fire, last run (when, go/skip/fail, one-line summary), with an on/off switch, a cadence editor, and a global Pause/Resume header showing "paused since".
- G4. The desk widget becomes a normal window (minimizable, not topmost, in the taskbar) and gains a compact per-mission glance: next pass, last pass result, pause state; Pause/Resume/Hold stay; a **Missions…** button opens the dashboard tab. The widget does **not** edit cadences (owner's answer: glance-plus-pause is enough there).
- G5. Delete the stale branches found in the audit (section 8).

**Non-goals**

- Changing the mission generators' default cadences in fantasyman. The owner sets the cadence they want on the page; the generators keep supplying defaults. (The schedule store survives regeneration.)
- Editing trigger prompts, allowed tools, cwd or trust ladder from the page. Only schedule fields.
- Adding or deleting triggers from the page.
- A second editor in the widget.

**Anti-goals** (failure even if it technically works)

- A schedule change that silently needs a daemon restart to take effect.
- A pause that any code path ignores (a trigger firing while `paused: true`).
- A disabled trigger that fires because its override was lost on regeneration, daemon restart or a torn file.
- The dashboard process reaching into the daemon's `state.json` to write; two writers on one file.
- The page showing a cadence that differs from what the daemon will actually do.

## 3. Constraints

- **Two processes, no IPC.** The daemon (`bun engine/daemon/main.ts`, Task Scheduler job "CynCo liveness daemon", run from `C:\Users\civer\localcode` on `main` via fantasyman's `dynasty/ops/run_cynco_daemon.cmd`) and the dashboard (served by the headless engine, `engine/main.ts` → `engine/dashboard/server.ts` + `index.html`, Task Scheduler job "CynCo headless engine", port `$dashPort`) are separate processes. They already share state through files under `~/.cynco` (the dashboard's `/api/away` tails `runs.jsonl` through `engine/daemon/awayFeed.ts`). All new coordination is file-based: the dashboard writes schedule/control files, the daemon reads them on its 30 s tick. Writes are atomic (temp file + rename, as the widget does for `daemon-control.json`).
- **Daemon owns `state.json`.** The dashboard never writes it. `nextFire` is the daemon's; the page may *preview* a next fire with the shared `computeNextFire` but labels it a preview until the daemon's tick writes the real one.
- **Another session is developing CynCo on `main` in `C:\Users\civer\localcode` right now.** All work happens in the worktree `C:\Users\civer\localcode\.claude\worktrees\mission-schedule-control` (branch `mission-schedule-control`) and lands by PR. Never switch the main checkout's branch. The wakefulness slices touch `engine/daemon/main.ts` and `wakeSchedule.ts`; keep daemon edits small and land G1 as its own PR before the next slice.
- **Phone access policy.** `docs/decisions/2026-10-22-phone-access.md`: a paired phone "can chat and read, never change configuration". Decision for this design (my call, owner may override): schedule fields and pause are *operational switches* for the owner's own missions, not engine configuration, and the owner explicitly wants to set them from the phone. The Missions tab's writes are allowed with the phone token. Mission.json itself stays untouchable from any token.
- **Daemon restart discipline.** `Stop-ScheduledTask` is not a stop (the job restarts within a minute); `Disable-ScheduledTask` first, or use `scripts/cynco-services.ps1`. The classifier refuses to start/stop these jobs from Claude's shell; the owner's Terminal panel tab works. Each pass is a fresh `bun engine/main.ts`, so engine edits take effect next pass; `engine/daemon/*` edits and mission.json changes need a daemon restart (the schedule store is designed so that schedule changes do not).
- **Tests:** `bunx vitest run` (bun's own runner lacks `vi.*`). Doc-line pins: `bun scripts/fix-doc-line-pins.mjs`; ratchet baseline `bun engine/__tests__/guards/packageDocSymbolScan.mjs --write`; README env table `bun scripts/generate-env-docs.mjs` if a new env var is added.
- Times shown to the owner are local (America/Denver), as the cron fields already are.

## 4. The design

### 4.1 Step 0 — land `daemon-pause-precheck` on `main` (G1)

Merge `main` into `daemon-pause-precheck` in a second worktree. A dry `git merge-tree` shows conflicts in `engine/daemon/main.ts`, `missionRunner.ts`, `taskRunner.ts`, `engine/bridge/conversationLoop.ts` (the branch's `resume()`/`repairTail` hook against main's loop changes), `engine/__tests__/daemon/taskRunner.test.ts`, and eight `CLAUDE.md` files (`agents`, `brain`, `bridge`, `daemon`, `engine`, …). `scripts/fix-doc-line-pins.mjs` arrives *with* the branch, so run it after the merge resolves, then the ratchet. Add one small commit on the branch: Resume picks up from now (4.3), with a `MissionRunner` test. Run the suite, open a PR to `main`, merge. Then, with the owner at the terminal tab: `git pull` in `C:\Users\civer\localcode` (it is on `main`; stop if its tree is dirty in files the merge touches), restart the daemon job through `cynco-services.ps1`, and restart the widget (the running one is a stale in-memory copy). Verify: `daemon.log` banner prints `pause switch ...`; the next trade pass records `precheck skipped the pass`; writing `{"paused":true}` keeps a due trigger from firing.

### 4.2 The schedule store (G2)

**File:** `~/.cynco/missions/<id>/schedule.json`, next to `mission.json`. Owned semantically by the owner (written by the dashboard, readable by anything). Survives `make_cynco_mission.py` runs, since those write `mission.json` only.

```json
{
  "updatedAt": "2026-11-08T23:10:00.000Z",
  "triggers": {
    "dynasty-tin-trades":    { "enabled": true,  "cron": "25 9-17/4 * * *" },
    "dynasty-bronze-trades": { "enabled": false },
    "digest-sleeper":        { "at": "13:00" },
    "dynasty-tin-daily":     { "timeoutMs": 2700000 }
  }
}
```

Per-trigger override fields, all optional: `enabled` (default true), and the cadence fields a `TriggerSpec` already has — `kind`, `cron`, `at`, `day`, `everyMinutes` — plus `timeoutMs`. Nothing else from `TriggerSpec` is overridable. Unknown trigger ids are kept in the file (a regeneration may bring the trigger back) but ignored and reported by the API as `orphan: true`.

**Effective trigger** = `mission.json` trigger with the override's fields spread over it. A new pure module `engine/daemon/schedule.ts` provides `readSchedule(dir)`, `applySchedule(triggers, schedule)` → effective `TriggerSpec[]` each tagged `{ enabled, overridden: string[] }`, `writeSchedule(dir, patch)` (atomic), `describeCadence(spec)` → plain words ("every 2 hours, 7:25 AM to 9:25 PM", "daily at 11:15 AM", "Thursdays at 7:45 PM"), and `cadenceFingerprint(spec)` (a stable string of the cadence fields). A torn or malformed file reads as "no overrides" and is logged once per change, never pauses or disables anything (same stance as `control.ts`).

**Daemon behaviour** (`MissionRunner.tick()` in `missionRunner.ts`):

- Each tick re-reads `schedule.json` (one small file per mission per 30 s; cache by mtime) and computes the effective triggers. **Torn or malformed file:** the runner keeps the last successfully read override set in memory and uses it, logging once per bad read; only a daemon that *starts* on a bad file runs with no overrides (logged loudly). So a torn write can never re-enable a disabled trigger mid-run.
- A trigger with `enabled: false` is never fired, but its `nextFire` **keeps advancing**: each tick, if `now >= nextFire`, the runner computes the following fire and stores it, records nothing, runs nothing. Consequence: a disabled trigger's `nextFire` is always in the future, so re-enabling it, or losing its override, simply resumes the normal grid from now — there is no missed fire for `run-once-on-startup` (13 of the 15 live triggers) to catch up on. The page shows "— off" for disabled rows regardless of the advancing value.
- When a trigger's `cadenceFingerprint` differs from the one stored in `state.json` under a new `scheduleSeen: Record<triggerId, fingerprint>` field, `nextFire` is recomputed from now with the new cadence and the fingerprint is stored. On first run with no `scheduleSeen`, the fingerprint is stored without resetting `nextFire`.
- `timeoutMs` override feeds `fire()` where the trigger's timeout is resolved today.
- The wake schedule published to the doorman (`wakeSchedule.ts`) is built from the *effective, enabled* triggers' `nextFire`, so the PC is not woken for a pass that will not run.
- `precheck` and `missedPolicy` are not overridable: they are safety behaviour, not cadence.
- **Disable while a run exists.** A run on the GPU is left to finish (disabling changes scheduling only; the owner has Stop for the run itself). A run parked as `MissionState.paused` for a trigger that is now disabled is dropped on the first unpaused tick: `paused` is cleared and an `ok: true` run is recorded with the summary `dropped on disable: <triggerId>` so the journal is accounted for. A cadence change does not touch a parked or running run.
- `wakeSchedule.ts`'s `collectNextFires` filters to ids that the effective, enabled trigger list declares (today it publishes every id in `state.nextFire`, including four June-2026 ids `mfl-dynasty/state.json` still carries).

### 4.3 Pause (G1, G3, G4)

`~/.cynco/daemon-control.json` from the landed branch stays the single pause switch (`{"paused": bool, "requestedAt": iso}`); `control.ts` gains `writeControl(path, paused, by: 'widget' | 'dashboard')` writing `{paused, requestedAt, by}` atomically, and the widget switches to the same shape. The Missions tab header and the widget both read and write it. The daemon's `tick()` already fires nothing while paused (after step 0).

**Resume picks up from now (owner's decision, 2026-11-08).** On the first tick after the pause lifts, before anything is evaluated, every trigger whose `nextFire` is in the past gets a fresh `nextFire` computed from now, and nothing fires for it; the one exception is the parked `PausedRun`, which resumes as the branch already does (that pass was running when the owner paused, so finishing it is what Resume means). Without this, 13 of the 15 triggers carry `missedPolicy: run-once-on-startup` and a day-long pause followed by Resume would run up to 13 passes back to back. A pass missed by a pause therefore waits for its next slot; the owner can run one on demand with fantasyman's `digest/ops/run_trigger_now.py`. This change ships **inside step 0** (the merge already touches `tick()`), so the very first Resume after the restart behaves this way. Daemon *startup* keeps the `run-once-on-startup` catch-up; only a pause is "from now".

### 4.4 Dashboard API (G3)

All in `engine/dashboard/server.ts` (a new helper module `engine/dashboard/missionsApi.ts` keeps the file logic out of the server switch), reading `CYNCO_MISSIONS_DIR` / `cyncoHome()` exactly as the daemon does.

- `GET /api/missions` →
  ```json
  { "paused": { "paused": true, "requestedAt": "...", "by": "widget" },
    "missions": [ { "id": "mfl-dynasty", "goal": "...", "cwd": "...",
        "running": { "triggerId": "...", "since": "...", "timeoutMs": 2700000 } ,
        "triggers": [ { "id": "dynasty-tin-trades", "kind": "cron", "cron": "25 7-21/2 * * *",
            "cadenceText": "every 2 hours, 7:25 AM to 9:25 PM", "enabled": true,
            "overridden": ["cron"], "timeoutMs": 2700000, "missedPolicy": "skip", "precheck": "command",
            "nextFire": "2026-11-09T02:25:00.000Z", "nextFirePreview": false,
            "lastRun": { "ts": "...", "ok": true, "kind": "skip", "summary": "precheck skipped the pass: ...", "durationMs": null } } ] } ] }
  ```
  `running` comes from `~/.cynco/gpu-busy.json` (fields `task` = mission id, `triggerId`, `startedAt`, `timeoutMs`, `pid`). `lastRun.kind` is derived from the `runs.jsonl` record alone: `fail` if `!ok`; `skip` if the summary starts with `precheck skipped`; `paused` if it starts with `paused on request` (the branch's pause record); `dropped` if it starts with `dropped on disable`; else `go`. A scheduler skip (missed past the grace window) only logs to `daemon.log` and writes no record, so it never appears here; that is acceptable. `lastRun` is the newest `runs.jsonl` record for that trigger (tail-read, bounded, as `awayFeed.ts` does). `nextFire` is `state.json`'s; when the override's fingerprint is not yet in `scheduleSeen`, the API computes a preview with `computeNextFire` and sets `nextFirePreview: true`.
- `PUT /api/missions/<id>/triggers/<triggerId>` body `{ enabled?, kind?, cron?, at?, day?, everyMinutes?, timeoutMs? }` → validates (cron must parse via `scheduler.ts`'s parser and fire within 4 years; `at` is `HH:MM`; `timeoutMs` 60 000–7 200 000), merges into `schedule.json`, returns the trigger as `GET` would show it. Body `{ "reset": true }` removes the override.
- `POST /api/daemon/pause` body `{ paused: bool }` → writes `daemon-control.json` with `by: 'dashboard'`.
- Access: the three routes are gated under the **`inference` scope**, the `/api/projects` precedent. That is the only scope a paired phone's device record holds, and the desk page itself only carries the inference token (a management-scoped route makes the desk page `window.prompt` for a paste once per tab). Consequence, accepted: any desk tab or paired phone can flip schedules and pause with no paste. `scopes.test.ts` pins "changing configuration needs the management scope"; the decision record (4.7) states that mission schedule and pause are operational switches, not configuration, and the test gets a case saying so. Unpaired or no token: 401, as the rest of `/api/*`.
- The dashboard is the long-running "CynCo headless engine" Task Scheduler job (`scripts/run-headless-engine.cmd`, managed by `cynco-services.ps1`), not a per-pass process: after the API lands, restart that job with the same discipline as the daemon's.

### 4.5 The Missions tab (G3)

`engine/dashboard/index.html` gains a `Missions` tab button next to `Away`, shown in both the desk layout and `applyRemoteLayout`'s phone `keep` list. It polls `GET /api/missions` every 10 s while visible (like `/api/mission`).

Layout, top to bottom:

1. **Header:** "Daemon: running" or "Paused since 2:25 PM (widget)" with one button, Pause or Resume. Below it, when a pass is running: "GPU: dynasty-tin-daily since 11:15 AM, up to 45 min".
2. **One card per mission** titled with the mission id and its goal's first line. Each trigger is a row:
   - name (the trigger id with the mission prefix dropped: `tin trades`),
   - cadence in words, with a small "edited" mark when `overridden` is non-empty and a "reset" link,
   - next fire ("today 4:25 PM", "Thu 7:45 PM", or "— off" when disabled; italic when `nextFirePreview`),
   - last run: a coloured dot (go/skip/fail/none) + relative time + the summary truncated to one line, expanding on tap,
   - an on/off switch (`enabled`),
   - an **Edit** control that opens an inline editor.
3. **Inline cadence editor** offers the three shapes the missions use, in plain controls, and writes the matching `TriggerSpec` fields:
   - *Daily at* HH:MM → `kind: 'daily', at`.
   - *Every N hours between* HH:MM *and* HH:MM → `kind: 'cron', cron: "M H1-H2/N * * *"` (minute from the start time; N in 1..12).
   - *Weekly on* day *at* HH:MM → `kind: 'cron', cron: "M H * * D"`.
   - An *Advanced* field shows the resulting cron and accepts a hand-written one.
   - A timeout field in minutes.
   Saving shows the daemon's confirmation state: the row's next fire turns from preview to real on the next poll after the daemon's tick.

Phone layout: the same rows wrap to two lines (name + switch; cadence + next + last). Styling follows the existing `.phone-row` / `.panel` classes; no new framework.

### 4.6 The widget (G4)

`scripts/cynco-widget.ps1` (the branch version after step 0):

- `ResizeMode="CanMinimize"`, `Topmost="False"`, `ShowInTaskbar="True"`, `WindowStyle="SingleBorderWindow"`. The `-WindowStyle Hidden` on the launcher applies to the PowerShell console only and stays. Window position is remembered across restarts in `~/.cynco/widget.json` (my call; cheap and the window is no longer pinned to a corner).
- Below the three existing rows (CynCo, Fantasyman, GPU), one compact row per mission directory found under `~/.cynco/missions` that has a `mission.json`: mission id, then "next: tin trades 4:25 PM · last: bronze daily ✓ 11:46" (last from the tail of `runs.jsonl`, next from `state.json` filtered to triggers that `schedule.json` leaves enabled). When paused: "paused since 2:25 PM". The rows refresh on the existing 10 s timer and reuse `Get-NextFire`/`Format-When`.
- A **Missions…** button that runs `Start-Process "http://127.0.0.1:$dashPort/#missions"` (the page honours a `#missions` hash by switching to the tab on load). If the dashboard is not up, the note line says so.
- Pause/Hold/Resume stay as they are; their write uses the shared `{paused, requestedAt, by:'widget'}` shape.
- Height grows to fit (about 34 px per mission row).

### 4.7 Docs

- `engine/daemon/CLAUDE.md`: a "Schedule overrides (`schedule.json`)" section beside the pause section; the tick's three-way outcome per trigger (disabled / cadence changed / unchanged).
- There is no `engine/dashboard/CLAUDE.md`; the routes are documented in `engine/dashboard/server.ts`'s header comment and in `docs/decisions/*`. Add the three endpoints to the header and the decision record below.
- A decision record `docs/decisions/2026-11-08-mission-schedule-control.md` for the phone-token call and the "daemon owns state.json, dashboard owns schedule.json" split.
- fantasyman: one paragraph in `dynasty/ops/LOCALCODE-BRIEF.md` saying the generators' times are defaults and the owner's overrides live in `schedule.json`; `make_cynco_mission.py`'s docstring points there. (fantasyman change is doc-only; it is the only fantasyman edit.)

## 5. Decided by the owner

- Both a PC window and a dashboard page reachable from the phone.
- The PC window is glance-plus-pause; cadence editing lives on the page.
- Order: land the pause branch and restart the daemon first, then store + API, then page, then widget.
- Stale branches are to be dealt with (section 8).
- Resume after a pause picks the schedule up from now; it does not run the passes that came due while paused (4.3).

## 6. My calls (owner may override)

- Phone token may write schedule and pause; the routes sit under the `inference` scope, so the desk page needs no paste either (section 4.4).
- `precheck` and `missedPolicy` are not overridable from the page.
- A disabled trigger's next fire keeps advancing silently, so re-enabling (or losing the override) never back-fires (4.2).
- A torn `schedule.json` keeps the last good overrides in memory (4.2).
- Disabling a trigger drops its parked paused run and leaves a run on the GPU alone (4.2).
- Widget remembers its position; no "pin on top" toggle.
- The schedule file is per mission (not one global file) so a mission can be removed or regenerated without touching another's overrides.
- Generators' defaults unchanged.

## 7. Left to the builder

- Exact cron-building helper and its tests (round-trip: editor → cron → `describeCadence` must read back the same words).
- Whether `applySchedule` lives in the ledger or the runner; the test seam is `MissionRunner` with a fake `now` and a temp missions dir, as the existing daemon tests do.
- Dashboard CSS details, truncation lengths, the expand affordance.
- Bounded tail size for `runs.jsonl` reads (reuse `awayFeed.ts`'s approach).
- How the widget detects `$dashPort` is already solved in the script; reuse.

## 8. Branch audit (2026-11-08) and cleanup

Only `daemon-pause-precheck` (3 commits, == `origin/daemon-no-logprobs`'s merge) carries live unmerged work; step 0 lands it. To delete after step 0 lands (local and `origin/` where present): `daemon-no-logprobs`, `daemon-pause-precheck`, `daemon-mission-timeout`, `daemon-allowed-tools` (merged), `campaign/c10` (+1 dead verdict commit), `true-benchmark` (+1), `feature/phase-a-summary-injection`, `feature/phase-b-sidebar-overhaul`, `feature/phase-c1-config-pipeline`, `feature/phase-c2-settings-screen`, `feature/phase-c3-profile-wizard`, `feature/phase-d1-expertise-level`, `feature/phase-d2-explain-mode`, `feature/phase-d3-guided-project`, `feature/phase-d4-vibe-guardian`, `feature/vsm-improvements` (April 2026 TUI redesign, superseded), `worktree-agent-a3a1ca95`, `worktree-agent-a4efa78b`, `worktree-agent-ae86953d`. Worktrees under `.claude/worktrees/` and `.worktrees/` that point at these are pruned with `git worktree remove`. fantasyman has no stray branches.

## 9. Verification (what "done" looks like)

1. Daemon banner shows the pause switch; a trade pass records `precheck skipped`; `{"paused":true}` holds a due trigger; lifting a pause that spanned a due time moves that trigger's `nextFire` forward with no run recorded (step 0).
2. With the daemon running, flipping `dynasty-bronze-trades` off on the page: no bronze trades run appears in `runs.jsonl` across its next due time; the doorman schedule omits it; the widget row's "next" skips it.
3. Changing tin trades to "every 4 hours 9:25–17:25": within one tick `state.json` `nextFire` moves to the new grid and `scheduleSeen` carries the fingerprint; the page's italic preview becomes plain.
4. Regenerating mission.json from fantasyman and restarting the daemon keeps every override.
5. Pause from the page stops a running pass (GPU freed) and the widget shows "paused since … (dashboard)"; Resume from the widget resumes it.
6. The widget minimizes, sits behind other windows, appears in the taskbar, and reopens where it was.
7. `bunx vitest run` green; doc pins and ratchet updated.
