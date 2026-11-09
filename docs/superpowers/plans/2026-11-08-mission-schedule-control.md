# Mission Schedule Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner see every pass of every daemon mission and turn it off or change its cadence from the dashboard (desk and phone) and glance/pause from a normal, minimizable desk widget, with the daemon obeying within one tick and no regeneration or restart.

**Architecture:** The daemon (`engine/daemon/`, process A) merges a per-mission `schedule.json` over `mission.json` on every 30 s tick and owns `state.json`. The dashboard (headless engine, process B, `engine/dashboard/`) reads those files plus `runs.jsonl`, `gpu-busy.json` and `daemon-control.json`, and writes only `schedule.json` and `daemon-control.json`, atomically. The widget (`scripts/cynco-widget.ps1`) reads the same files and writes only `daemon-control.json`. No IPC.

**Tech Stack:** TypeScript on Bun (`bunx vitest run` for tests; `bun:test` imports work under vitest here), vanilla JS in `engine/dashboard/index.html`, Windows PowerShell 5.1 + WPF for the widget.

**Spec:** `docs/superpowers/specs/2026-11-08-mission-schedule-control-design.md`

## Global Constraints

- Work happens in the worktree `C:\Users\civer\localcode\.claude\worktrees\mission-schedule-control` (branch `mission-schedule-control`) except Task 0, which uses a second worktree on `daemon-pause-precheck`. Never switch the branch of `C:\Users\civer\localcode` (another session develops there on `main`).
- Task 0 lands by PR before Task 1 starts; Tasks 1–7 rebase onto `main` once Task 0 is merged (`git rebase main` in the worktree after `git -C C:\Users\civer\localcode fetch`), since they build on `control.ts`, `PausedRun`, `precheck: 'command'` and the branch widget.
- `docs/superpowers/` is in `.gitignore`; `git add -f` the spec/plan paths (65 files are already tracked that way).
- Test command: `bunx vitest run <path>`; whole suite `bunx vitest run`. After any `CLAUDE.md` edit: `bun scripts/fix-doc-line-pins.mjs` then `bun engine/__tests__/guards/packageDocSymbolScan.mjs --write`. New env vars need `bun scripts/generate-env-docs.mjs` (this plan adds none).
- File writes shared across processes are atomic: write `<name>.<pid>.tmp` in the same directory, then rename over the target.
- Times shown to the owner are local; cron fields are local already (`scheduler.ts`).
- Daemon/headless-engine restarts and Task Scheduler changes are refused from Claude's shell; they run from the owner's Terminal tab via `scripts\cynco-services.ps1 stop|start daemon|engine`. The daemon's job restarts itself within a minute of a plain stop.
- Keep every string literal in the widget ASCII (PowerShell 5.1 reads it as ANSI).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A `schedule.json` that is deleted (not torn) while the daemon runs — the owner "resets everything" by removing the file: the daemon must treat it as *no overrides* (file absent is a valid, readable state), not keep the last good set. Test in Task 2.
2. A cron override whose grid never reaches the current time today (e.g. `25 9-17/4` saved at 18:00): the next fire must land tomorrow 09:25, never "now". Test in Task 1 via `computeNextFire` and in Task 3's preview.
3. An override for a trigger that `mission.json` no longer declares after regeneration (`orphan`): the daemon ignores it and the API reports it; neither crashes nor fires. Tests in Tasks 2 and 3.
4. Two writers on `daemon-control.json` (widget and page) within the same second: both write `{paused, requestedAt, by}` atomically; the last rename wins; the daemon reads either shape and the old `{paused, requestedAt}` shape. Test in Task 1 (`readControl` on three shapes) and Task 6.
5. The phone layout at 375 px: each trigger row must wrap to two lines and the switch must stay tappable (44 px); `remoteTabSet(true)` must include `missions` or the phone never sees the tab. Test in Task 5 (`remoteView.test.ts`).

---

### Task 0: Land `daemon-pause-precheck` on `main`, with Resume-from-now

**Files:**
- Worktree: `git -C C:\Users\civer\localcode worktree add .claude/worktrees/land-pause daemon-pause-precheck`
- Modify (on that branch): `engine/daemon/missionRunner.ts` (`tick()`, lines ~85–112 on the branch), `engine/daemon/main.ts`, `engine/daemon/taskRunner.ts`, `engine/bridge/conversationLoop.ts`, `engine/__tests__/daemon/taskRunner.test.ts`, eight `CLAUDE.md` files (merge conflicts)
- Test: `engine/__tests__/daemon/missionRunner.test.ts`

**Interfaces:**
- Consumes: `MissionRunnerDeps.isPaused?: () => boolean`, `MissionLedger.setNextFire(id, iso)`, `computeNextFire(t, from)`.
- Produces for later tasks: `engine/daemon/control.ts` (`readControl`, `CONTROL_FILE_NAME`, `defaultControlPath`), `PausedRun`, `MissionState.paused`, `TriggerSpec.precheck: 'command'` + `precheckCommand`, the branch widget with the GPU row, `scripts/fix-doc-line-pins.mjs`.

- [ ] **Step 1: Merge `main` into the branch in the second worktree**

Run: `cd C:\Users\civer\localcode\.claude\worktrees\land-pause && git merge main`
Expected: conflicts in the files listed above. Resolve keeping both sides' behaviour: the branch's `shouldPause`/`runPrecheck`/`isPaused` wiring plus main's wakefulness (`WakePublisher`, hold-awake, `gpu-busy.json`). In `conversationLoop.ts` keep the branch's `resume()` and main's loop changes.

- [ ] **Step 2: Run the suite and fix doc pins**

Run: `bunx vitest run` then `bun scripts/fix-doc-line-pins.mjs && bun engine/__tests__/guards/packageDocSymbolScan.mjs --write && bunx vitest run engine/__tests__/guards`
Expected: all green. Commit the merge: `git commit -am "merge main into daemon-pause-precheck (wakefulness + pause/precheck)"`.

- [ ] **Step 3: Write the failing test for Resume-from-now**

In `engine/__tests__/daemon/missionRunner.test.ts`, new `describe('MissionRunner resume after a pause')`:

```ts
it('lifting a pause that spanned a due time moves nextFire forward and fires nothing', async () => {
  let paused = true
  const now = { t: new Date(2026, 10, 8, 12, 0, 0) }
  const { deps, ranTasks } = makeDeps({ isPaused: () => paused, now: () => now.t })
  const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
  const runner = new MissionRunner(ledger, deps as any)
  paused = false; await runner.tick()            // init: nextFire = 13:00 for 'poll' (every 60 min)
  paused = true;  now.t = new Date(2026, 10, 8, 15, 30, 0); await runner.tick()
  paused = false; await runner.tick()
  expect(ranTasks).toHaveLength(0)
  expect(new Date(ledger.state.nextFire['poll']).getTime()).toBeGreaterThan(now.t.getTime())
  expect(ledger.recentRuns(5)).toHaveLength(0)
})
it('a parked PausedRun still resumes when the pause lifts', ...) // keep the branch's existing resume test green
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bunx vitest run engine/__tests__/daemon/missionRunner.test.ts -t "resume after a pause"`
Expected: FAIL — `ranTasks` has 1 entry (the catch-up fire).

- [ ] **Step 5: Implement in `tick()`**

In `missionRunner.ts`, where `pauseLogged` flips false ("pause lifted"), before `resumePaused`: for each `trigger` of `this.ledger.config.triggers`, if `state.nextFire[trigger.id]` is defined and `<= now`, call `this.ledger.setNextFire(trigger.id, computeNextFire(trigger, now).toISOString())`; log one line `pause lifted — N trigger(s) moved to their next slot`. Do this only on the first tick after a pause (the `pauseLogged` edge), not on startup.

- [ ] **Step 6: Run tests, commit**

Run: `bunx vitest run engine/__tests__/daemon`
Expected: PASS. `git commit -am "daemon: Resume picks the schedule up from now instead of firing every pass missed during the pause"`.

- [ ] **Step 7: Push, PR, merge**

Run: `git push -u origin daemon-pause-precheck && gh pr create --base main --title "daemon: land pause/resume, precheck by command, widget GPU row on main" --body "<CynCo#184 was merged into daemon-no-logprobs, never main; this brings it to main merged with the wakefulness slices, plus Resume-from-now (owner decision 2026-11-08). 🤖 Generated with [Claude Code](https://claude.com/claude-code)>"`. Merge when CI is green (`gh pr merge --merge`).

- [ ] **Step 8: Pull `main` in the live checkout and restart (owner's terminal tab)**

Owner runs, in the Terminal tab: `git -C C:\Users\civer\localcode status --short` (stop if any listed file is one the merge touched), then `git -C C:\Users\civer\localcode pull`, then `C:\Users\civer\localcode\scripts\cynco-services.ps1 stop daemon; C:\Users\civer\localcode\scripts\cynco-services.ps1 start daemon`, then close the old widget (pid from `Get-CimInstance Win32_Process | ? CommandLine -match cynco-widget`) and start `scripts\cynco-widget.cmd`.
Expected: `~/.cynco/daemon.log` tail shows `CynCo liveness daemon up — 2 mission(s) ... pause switch C:\Users\civer\.cynco\daemon-control.json (PAUSED)`.

- [ ] **Step 9: Verify pause and precheck live**

With `daemon-control.json` paused, wait past the next trade slot: `runs.jsonl` gains nothing. Resume from the widget: log shows `pause lifted — N trigger(s) moved`, no burst. Next trade slot: `runs.jsonl` records `precheck skipped the pass`.

- [ ] **Step 10: Delete the stale branches (spec §8)**

Run (local + remote): `git -C C:\Users\civer\localcode branch -D daemon-no-logprobs daemon-pause-precheck daemon-mission-timeout daemon-allowed-tools campaign/c10 true-benchmark feature/phase-a-summary-injection feature/phase-b-sidebar-overhaul feature/phase-c1-config-pipeline feature/phase-c2-settings-screen feature/phase-c3-profile-wizard feature/phase-d1-expertise-level feature/phase-d2-explain-mode feature/phase-d3-guided-project feature/phase-d4-vibe-guardian feature/vsm-improvements worktree-agent-a3a1ca95 worktree-agent-a4efa78b worktree-agent-ae86953d` and `git push origin --delete daemon-no-logprobs daemon-pause-precheck daemon-mission-timeout daemon-allowed-tools true-benchmark`; `git worktree remove .claude/worktrees/land-pause`. Any branch checked out by a worktree listed in `git worktree list` is skipped and reported.

---

### Task 1: `schedule.ts` — the schedule store (pure)

**Files:**
- Create: `engine/daemon/schedule.ts`
- Modify: `engine/daemon/types.ts` (add `scheduleSeen` to `MissionState`), `engine/daemon/control.ts` (add `writeControl`, `by`), `engine/daemon/scheduler.ts` (export `validateCron`)
- Test: `engine/__tests__/daemon/schedule.test.ts`, `engine/__tests__/daemon/control.test.ts` (branch file), `engine/__tests__/daemon/scheduler.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SCHEDULE_FILE_NAME = 'schedule.json'
  export type TriggerOverride = { enabled?: boolean; kind?: TriggerSpec['kind']; cron?: string; at?: string; day?: TriggerSpec['day']; everyMinutes?: number; timeoutMs?: number }
  export type Schedule = { updatedAt?: string; triggers: Record<string, TriggerOverride> }
  export type ReadScheduleResult = { schedule: Schedule; status: 'ok' | 'absent' | 'bad'; mtimeMs: number | null }
  export function readSchedule(missionDir: string): ReadScheduleResult
  export function writeSchedule(missionDir: string, patch: (s: Schedule) => Schedule): Schedule   // atomic, sets updatedAt
  export type EffectiveTrigger = TriggerSpec & { enabled: boolean; overridden: (keyof TriggerOverride)[] }
  export function applySchedule(triggers: TriggerSpec[], schedule: Schedule): { triggers: EffectiveTrigger[]; orphans: string[] }
  export function describeCadence(t: TriggerSpec): string
  export function cadenceFingerprint(t: TriggerSpec): string          // `${kind}|${cron ?? ''}|${at ?? ''}|${day ?? ''}|${everyMinutes ?? ''}`
  export function validateOverride(o: unknown): { ok: true; value: TriggerOverride } | { ok: false; error: string }
  ```
  `scheduler.ts`: `export function validateCron(expr: string): string | null` (null = valid; otherwise the message; reuses `parseCronField` and the 4-year check in `nextCronFire`).
  `control.ts`: `export type DaemonControl = { paused: boolean; requestedAt?: string; by?: 'widget' | 'dashboard' }`, `export function writeControl(path: string, paused: boolean, by: 'widget' | 'dashboard'): DaemonControl` (atomic).
  `types.ts`: `MissionState.scheduleSeen?: Record<string, string>`.

- [ ] **Step 1: Write the failing tests**

`schedule.test.ts` (temp dir per test, as `missionLedger.test.ts` does):

```ts
it('absent file reads as no overrides with status absent', ...)            // { triggers: {} }, 'absent', mtimeMs null
it('a malformed file reads as status bad with empty overrides', ...)
it('applySchedule spreads enabled/cron/timeoutMs over the trigger and lists overridden keys', ...)
   // trigger {id:'t', kind:'cron', cron:'25 7-21/2 * * *'} + override {enabled:false, cron:'25 9-17/4 * * *', timeoutMs: 600000}
   // → enabled false, cron '25 9-17/4 * * *', timeoutMs 600000, overridden ['enabled','cron','timeoutMs']
it('an override for an undeclared trigger is reported as an orphan and applied to nothing', ...)
it('precheck and missedPolicy in an override are ignored', ...)              // validateOverride strips them → not in value
it('writeSchedule is atomic and sets updatedAt; a second write merges', ...)  // no *.tmp left; updatedAt ISO; both trigger keys present
it('describeCadence words', () => {
  expect(describeCadence({ kind:'cron', cron:'25 7-21/2 * * *', ... })).toBe('every 2 hours, 7:25 AM to 9:25 PM')
  expect(describeCadence({ kind:'daily', at:'11:15', ... })).toBe('daily at 11:15 AM')
  expect(describeCadence({ kind:'cron', cron:'45 19 * * 4', ... })).toBe('Thursdays at 7:45 PM')
  expect(describeCadence({ kind:'interval', everyMinutes: 90, ... })).toBe('every 90 minutes')
  expect(describeCadence({ kind:'cron', cron:'5 10 * * 2', ... })).toBe('Tuesdays at 10:05 AM')
})
it('cadenceFingerprint ignores enabled and timeoutMs and changes with cron', ...)
it('validateOverride rejects a cron that never fires, an at that is not HH:MM, timeoutMs outside 60000..7200000', ...)
```
`scheduler.test.ts`: `validateCron('25 9-17/4 * * *')` → null; `validateCron('99 * * * *')` → non-null string. Review Focus 2: `computeNextFire({kind:'cron', cron:'25 9-17/4 * * *'}, new Date(2026,10,8,18,0))` equals `new Date(2026,10,9,9,25)`.
`control.test.ts`: `readControl` on `{"paused":true}`, `{"paused":true,"requestedAt":"..."}`, `{"paused":false,"requestedAt":"...","by":"dashboard"}` → paused flag and `by` where present; `writeControl` leaves no tmp file and round-trips.

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run engine/__tests__/daemon/schedule.test.ts engine/__tests__/daemon/control.test.ts engine/__tests__/daemon/scheduler.test.ts`
Expected: FAIL — module `./schedule.js` not found; `validateCron`/`writeControl` not exported.

- [ ] **Step 3: Implement `schedule.ts`, `validateCron`, `writeControl`, `scheduleSeen`**

`describeCadence` rules: cron `M H1-H2/N * * *` → `every N hours, h:MM AM to h:MM PM` (12-hour, no leading zero); cron `M H * * D` with a single weekday → `<Weekday>s at h:MM AM`; daily → `daily at h:MM AM`; weekly → `<Weekday>s at ...`; interval → `every N minutes`; any other cron → `cron <expr>`.

- [ ] **Step 4: Run tests, commit**

Run: same command. Expected: PASS.
`git add engine/daemon/schedule.ts engine/daemon/types.ts engine/daemon/control.ts engine/daemon/scheduler.ts engine/__tests__/daemon/{schedule,control,scheduler}.test.ts && git commit -m "daemon: schedule.json override store (pure): read/apply/write, cadence words, fingerprint, validation"`

---

### Task 2: The daemon obeys `schedule.json`

**Files:**
- Modify: `engine/daemon/missionRunner.ts` (`tick()`, `timeoutFor()`, `resumePaused()`), `engine/daemon/wakeSchedule.ts` (`collectNextFires`, line 19), `engine/daemon/main.ts` (pass ledgers' effective triggers to the publisher)
- Test: `engine/__tests__/daemon/missionRunner.test.ts`, `engine/__tests__/daemon/wakeSchedule.test.ts`

**Interfaces:**
- Consumes: Task 1's `readSchedule`, `applySchedule`, `cadenceFingerprint`.
- Produces: `MissionRunner.effectiveTriggers(): EffectiveTrigger[]` (public, cached per tick; used by `main.ts` for the wake schedule), `collectNextFires(ledgers: NextFireLedger[], now, allowedIds?: Set<string>)`.

- [ ] **Step 1: Write the failing tests**

`missionRunner.test.ts`, new `describe('MissionRunner schedule.json overrides')`, each writing `schedule.json` into `join(dir,'mfl-dynasty')` before/between ticks:

```ts
it('a disabled trigger never fires and its nextFire keeps advancing past now', ...)   // {triggers:{poll:{enabled:false}}}; tick at 12:00 (init 13:00), tick at 15:30 → ranTasks 0, nextFire > 15:30, recentRuns 0
it('re-enabling resumes the grid from now, no catch-up fire', ...)
it('a cron override resets nextFire from now and records the fingerprint in state.scheduleSeen', ...)
it('an unchanged schedule does not reset nextFire on every tick', ...)               // nextFire identical across two ticks
it('a torn schedule.json keeps the last good overrides (disabled stays disabled)', ...) // write '{"triggers": {"poll": {"ena' → still no fire
it('a deleted schedule.json means no overrides again', ...)                            // Review Focus 1
it('an override for an undeclared trigger is ignored', ...)                             // Review Focus 3
it('timeoutMs override reaches the task input', ...)                                   // ranTasks[0].timeoutMs === 600000
it('disabling a trigger with a parked PausedRun drops it and records "dropped on disable"', ...)
   // seed ledger.state.paused = { triggerId:'poll', input: {...}, remainingMs: 60000, pausedAt: iso }; schedule poll disabled; tick → ranTasks 0, state.paused undefined, recentRuns(1)[0].summary starts with 'dropped on disable: poll'
```
`wakeSchedule.test.ts`: `collectNextFires([ledger], now, new Set(['poll']))` omits `news` and a stale June id present in `state.nextFire`.

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run engine/__tests__/daemon/missionRunner.test.ts -t "schedule.json" ; bunx vitest run engine/__tests__/daemon/wakeSchedule.test.ts`
Expected: FAIL (fires happen; `collectNextFires` ignores the third argument).

- [ ] **Step 3: Implement**

In `MissionRunner`: a private `scheduleCache: { mtimeMs: number | null; schedule: Schedule } | null`. At the top of `tick()` (after the pause gate), `readSchedule(this.ledger.dir)` (make `MissionLedger.dir` a `readonly` public field if the constructor keeps it private): `status 'bad'` → keep cache (log once per distinct mtime); `'absent'` → `{ triggers: {} }`; `'ok'` → replace. `applySchedule(config.triggers, schedule)` gives `effective`; loop over `effective` instead of `config.triggers`. Per trigger: if `!enabled` → while `nextFire <= now` set `nextFire = computeNextFire(t, now)` (no record, no fire), `continue`; compute `fp = cadenceFingerprint(t)`; if `state.scheduleSeen?.[id]` is defined and differs → `setNextFire(computeNextFire(t, now))`; store `scheduleSeen[id] = fp`; then the existing evaluate/fire path. `timeoutFor()` already reads `trigger.timeoutMs`, so passing the effective trigger to `fire()` carries the override. In `resumePaused()`, if the parked trigger is disabled in `effective` → `delete state.paused`, `recordRun({ ts, triggerId, ok: true, summary: \`dropped on disable: ${triggerId}\`, recommendationIds: [], entropy: null })`, return. `collectNextFires` gains `allowedIds?: Set<string>` and filters when given; `main.ts` passes the union of every runner's enabled effective ids. Expose `effectiveTriggers()`.

- [ ] **Step 4: Run tests, commit**

Run: `bunx vitest run engine/__tests__/daemon`
Expected: PASS. `git commit -am "daemon: tick merges schedule.json over mission.json — disabled triggers advance silently, cadence changes reset from now, wake schedule lists only enabled passes"`

---

### Task 3: `missionsApi.ts` — the dashboard's read/write over the files

**Files:**
- Create: `engine/dashboard/missionsApi.ts`
- Test: `engine/__tests__/dashboard/missionsApi.test.ts`

**Interfaces:**
- Consumes: Task 1 (`readSchedule`, `writeSchedule`, `applySchedule`, `describeCadence`, `cadenceFingerprint`, `validateOverride`), `readControl`/`writeControl`, `computeNextFire`, `readGpuBusy` from `engine/daemon/gpuBusyFile.ts`.
- Produces:
  ```ts
  export type MissionsPaths = { missionsDir: string; controlPath: string; gpuBusyPath?: string; now?: () => Date }
  export type LastRun = { ts: string; ok: boolean; kind: 'go' | 'skip' | 'fail' | 'paused' | 'dropped'; summary: string }
  export type TriggerView = { id: string; name: string; kind: TriggerSpec['kind']; cron?: string; at?: string; day?: string; everyMinutes?: number;
    cadenceText: string; enabled: boolean; overridden: string[]; timeoutMs: number | null; missedPolicy: string; precheck: string;
    nextFire: string | null; nextFirePreview: boolean; lastRun: LastRun | null }
  export type MissionView = { id: string; goal: string; cwd: string | null; running: { triggerId: string; since: string; timeoutMs: number } | null; triggers: TriggerView[]; orphans: string[] }
  export type MissionsView = { paused: DaemonControl; missions: MissionView[] }
  export function readMissionsView(p: MissionsPaths): MissionsView
  export function patchTrigger(p: MissionsPaths, missionId: string, triggerId: string, body: unknown): { status: number; json: unknown }  // 200 TriggerView | 400 {error} | 404 {error}
  export function setPaused(p: MissionsPaths, paused: boolean): DaemonControl
  ```
  `name` = trigger id with the `<mission-prefix>-` dropped and dashes to spaces (`dynasty-tin-trades` → `tin trades`, `digest-gameday-thu` → `gameday thu`); the prefix is the id's first dash-segment.

- [ ] **Step 1: Write the failing tests**

Fixture: a temp `missionsDir` with `mfl-dynasty/mission.json` (two triggers: `dynasty-tin-trades` cron `25 7-21/2 * * *` precheck command missedPolicy skip; `dynasty-tin-daily` daily 11:15), `state.json` with `nextFire` for both and `scheduleSeen` for both, `runs.jsonl` with three lines (a `precheck skipped the pass: "skip: no incoming offers"` for trades, an `ok:false` for daily, a `paused on request after 3 min` for daily), plus a `daemon-control.json` and a `gpu-busy.json` at `join(missionsDir, '..', 'gpu-busy.json')` (match `readGpuBusy`'s path rule; if it reads a fixed home path, inject via `MissionsPaths.gpuBusyPath`).

```ts
it('lists missions with cadence words, names, next fire from state and the newest run per trigger', ...)
   // trades.lastRun.kind 'skip'; daily.lastRun.kind 'paused' (newest wins); trades.name 'tin trades'; cadenceText 'every 2 hours, 7:25 AM to 9:25 PM'
it('marks nextFire as a preview when the override fingerprint is not yet in scheduleSeen', ...)   // write schedule cron '25 9-17/4 * * *' → nextFirePreview true, nextFire === computeNextFire(...) at p.now()
it('reports orphans and running', ...)
it('patchTrigger merges, validates and returns the row; reset removes the override', ...)       // {enabled:false} → 200 enabled false; {cron:'99 * * * *'} → 400; {reset:true} → overridden []
it('patchTrigger 404s an unknown mission or trigger', ...)
it('setPaused writes by: dashboard and readMissionsView reflects it', ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run engine/__tests__/dashboard/missionsApi.test.ts` — Expected: FAIL, module missing.

- [ ] **Step 3: Implement `missionsApi.ts`**

Tail-read `runs.jsonl` bounded like `awayFeed.ts` (last 64 KiB), newest record per `triggerId`. `kind` from the summary prefixes in the spec (4.4). `running` from `readGpuBusy()` when its `task` equals the mission id.

- [ ] **Step 4: Run tests, commit**

Expected: PASS. `git add engine/dashboard/missionsApi.ts engine/__tests__/dashboard/missionsApi.test.ts && git commit -m "dashboard: missionsApi reads the daemon's files into a per-trigger view and writes schedule/pause atomically"`

---

### Task 4: Routes and scope

**Files:**
- Modify: `engine/dashboard/server.ts` (deps type ~line 137; route block before the `/api/projects` gate ~line 658; header comment), `engine/main.ts` (~line 489, beside `getAwayRuns`)
- Test: `engine/__tests__/dashboard/scopes.test.ts`, new `engine/__tests__/dashboard/missionsRoutes.test.ts` (model on `awayRoute.test.ts`)

**Interfaces:**
- Consumes: Task 3.
- Produces: `DashboardServerDeps.missions?: MissionsPaths`; routes `GET /api/missions`, `PUT /api/missions/<id>/triggers/<tid>`, `POST /api/daemon/pause`, all under `requireScope(req, 'inference', kind)`; unwired deps → `GET` returns `{ paused: { paused: false }, missions: [] }`, writes return 503 `{ error: 'missions not wired' }`.

- [ ] **Step 1: Write the failing tests**

`missionsRoutes.test.ts`: start a `DashboardServer` with `deps.missions` pointing at the Task 3 fixture; `GET /api/missions` with the inference bearer → 200 and `missions[0].triggers.length === 2`; `PUT .../dynasty-tin-trades` body `{enabled:false}` with inference bearer → 200 `enabled false` and the file on disk changed; same with no token → 401; `POST /api/daemon/pause` `{paused:true}` → 200 and `daemon-control.json` says `by: 'dashboard'`; unknown trigger → 404.
`scopes.test.ts`: in the `changing configuration` describe, add `test('mission schedule and pause are operational switches: inference is enough', ...)` asserting `PUT /api/missions/x/triggers/y` with INFERENCE does **not** return 401/403 (404 is fine), and add a comment line referencing the decision record. Do not add these paths to `WRITE_ROUTES`.

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run engine/__tests__/dashboard/missionsRoutes.test.ts engine/__tests__/dashboard/scopes.test.ts` — Expected: FAIL (404 / 403).

- [ ] **Step 3: Implement**

Route block placed with the `/api/projects` gate (before the method-based scope split), parsing `/api/missions/<id>/triggers/<tid>` with `decodeURIComponent` and rejecting ids not matching `/^[a-z0-9-]+$/i` (400). `engine/main.ts`: `missions: { missionsDir: process.env.CYNCO_MISSIONS_DIR ?? join(cyncoHome(), 'missions'), controlPath: process.env.CYNCO_CONTROL_FILE ?? defaultControlPath(cyncoHome()) }`. Header comment in `server.ts` lists the three routes and their scope.

- [ ] **Step 4: Run tests, commit**

Run: `bunx vitest run engine/__tests__/dashboard` — Expected: PASS. `git commit -am "dashboard: /api/missions read + per-trigger PUT + /api/daemon/pause under the inference scope"`

---

### Task 5: The Missions tab

**Files:**
- Modify: `engine/dashboard/index.html` — tab button (~line 881), new `<div id="tab-missions">` after `#tab-away` (~line 1265), `remoteTabSet`/`initialHashFor` (~3533), `switchTab` (~3580), new functions `loadMissions`, `renderMissions`, `missionTriggerRow`, `cadenceEditor`, `cronFromEditor`, `editorFromTrigger`, `saveTrigger`, `setDaemonPaused`, `whenText`; CSS near `.away-row`/`.phone-row`
- Test: `engine/__tests__/dashboard/remoteView.test.ts` (extend), new `engine/__tests__/dashboard/missionsView.test.ts` (extract functions with the file's `extractFunction` helper pattern, as `campaignAutopoiesisRow.test.ts` does)

**Interfaces:**
- Consumes: Task 4's JSON shapes (`MissionsView`, `TriggerView`).
- Produces (page-level JS, pinned by tests):
  ```js
  function cronFromEditor(e)        // {shape:'daily', at:'11:15'} → {kind:'daily', at:'11:15'}
                                    // {shape:'every', everyHours:4, from:'09:25', to:'17:25'} → {kind:'cron', cron:'25 9-17/4 * * *'}
                                    // {shape:'weekly', day:4, at:'19:45'} → {kind:'cron', cron:'45 19 * * 4'}
                                    // {shape:'advanced', cron:'...'} → {kind:'cron', cron}
  function editorFromTrigger(t)     // inverse for the three recognisable shapes, else {shape:'advanced', cron}
  function whenText(iso, nowIso)    // 'today 4:25 PM' | 'Thu 7:45 PM' | 'Nov 15 9:45 AM' (>6 days) | '—'
  function missionTriggerRow(t, nowIso) // returns an HTML string; contains data-trigger="<id>", a .sw-toggle with aria-checked, .lr-dot.go|skip|fail|paused|dropped|none, 'off' text when disabled, <em> around the next-fire when t.nextFirePreview
  ```

- [ ] **Step 1: Write the failing tests**

`remoteView.test.ts`: `remoteTabSet(true)` contains `'missions'`; `remoteTabSet(false)` contains `'missions'`; `initialHashFor(true, '#missions')` returns `'#missions'`.
`missionsView.test.ts`: round-trip `editorFromTrigger(cronFromEditor(e))` deep-equals `e` for the three shapes; `cronFromEditor({shape:'every', everyHours:2, from:'07:25', to:'21:25'}).cron === '25 7-21/2 * * *'`; `whenText` the three forms with a fixed `nowIso`; `missionTriggerRow` for a disabled trigger includes `off` and `aria-checked="false"`, for a preview wraps the time in `<em>`, and escapes `<` in `lastRun.summary`.

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run engine/__tests__/dashboard/remoteView.test.ts engine/__tests__/dashboard/missionsView.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the tab**

Markup per spec 4.5: header `#missionsHeader` (daemon state + Pause/Resume button + GPU line), then one `.panel` per mission with `.mt-row` per trigger: name · cadence (+ `edited`/`reset`) · next · last (dot + relative time + one-line summary, `title` holds the full text; tap toggles `.open` to show the full summary) · switch · Edit. The editor is an inline `<form>` under the row with a `select` (`daily|every|weekly|advanced`), the matching inputs, a timeout-minutes input (`min=1 max=120`), Save/Cancel; Save `PUT`s and re-renders from the response. `switchTab('missions')` calls `loadMissions()`; a 10 s `setInterval` polls while the tab is active (clear on switch away). On load, `location.hash === '#missions'` opens the tab (desk and remote: `initialHashFor(true, '#missions')` keeps it). Phone CSS: `body.remote .mt-row { flex-wrap: wrap }`, switch `min-height: 44px`. All text through `escHtml`.

- [ ] **Step 4: Run tests, then look at it**

Run: `bunx vitest run engine/__tests__/dashboard` — Expected: PASS. Then start the dashboard from this worktree on a spare port (`LOCALCODE_WS_PORT=9260 bun engine/main.ts` with `CYNCO_MISSIONS_DIR` pointed at a copy of `~/.cynco/missions`) and open `http://127.0.0.1:9261/#missions` in the built-in browser at desktop and at 375 px wide; flip a switch and confirm the copy's `schedule.json` changed.

- [ ] **Step 5: Commit**

`git commit -am "dashboard: Missions tab — every pass of every mission with cadence words, next fire, last run, on/off and an inline cadence editor; desk and phone"`

---

### Task 6: The widget

**Files:**
- Modify: `scripts/cynco-widget.ps1` (XAML ~line 204; `Write-DaemonControl` ~186; `Refresh` ~232; button wiring ~285–330; header comment)
- Test: `scripts/__tests__/cynco-widget.probe.test.ts` if one exists for `-Probe`; otherwise manual steps below

**Interfaces:**
- Consumes: `~/.cynco/missions/*/{mission,state,schedule}.json`, `runs.jsonl`, `daemon-control.json`, `$dashPort`.
- Produces: `Write-DaemonControl([bool]$paused)` now writes `{"paused":..., "requestedAt":"...", "by":"widget"}`; new functions `Get-MissionGlance($mission)` → `@{ Next = '<name> HH:mm' | $null; Last = '<name> ok|skip|FAIL HH:mm' | $null }` honouring `schedule.json` `enabled:false`; `Get-WidgetPos`/`Save-WidgetPos` on `~/.cynco/widget.json` `{left, top}`; `-Probe` output gains one line per mission `mission|<id>|<next>|<last>`.

- [ ] **Step 1: Window chrome**

Set `ResizeMode="CanMinimize" Topmost="False" ShowInTaskbar="True" WindowStyle="SingleBorderWindow"`; read `widget.json` before `ShowDialog` to set `Left/Top` when present and on-screen; save on `Add_LocationChanged` (debounced by the 10 s timer: write if moved).

- [ ] **Step 2: Mission rows and the Missions button**

Add rows 3..3+N (one `RowDefinition Height="30"` per mission found at startup) with `dotMission_<i>`, `txtMission_<i>` (`"<id>: next <name> 16:25 - last <name> ok 11:46"`; `"paused since 14:25 (widget)"` when `daemon-control.json` is paused), and one `btnMissions` ("Missions...") on the first mission row that runs `Start-Process "http://127.0.0.1:$dashPort/#missions"` when `Test-Http` says the dashboard is up, else sets `txtNote` to `dashboard is off - start CynCo first`. Window `Height` = `195 + 30*N`.

- [ ] **Step 3: Verify with `-Probe` and by hand**

Run: `powershell -STA -NoProfile -File scripts\cynco-widget.ps1 -Probe -MissionsDir <copy of ~/.cynco/missions>` → prints the GPU line plus `mission|mfl-dynasty|...` and `mission|fantasy-digest|...`; set `schedule.json` `enabled:false` on the trigger that was `next` and re-probe → `next` moves to another trigger. Launch the widget: minimize it, click another window (it goes behind), find it in the taskbar, move it, close, relaunch → same position. Click Pause → `daemon-control.json` has `"by": "widget"`.

- [ ] **Step 4: Commit**

`git commit -am "cynco-widget: a normal window (minimize, taskbar, not pinned) with a glance row per mission and a Missions... button; control writes carry by:widget"`

---

### Task 7: Docs, pins, fantasyman note

**Files:**
- Modify: `engine/daemon/CLAUDE.md` (section after "Pause and resume"), `engine/dashboard/server.ts` header (done in Task 4; verify), `docs/decisions/2026-10-22-phone-access.md` (one paragraph: the mission routes are operational switches under inference), `docs/NOW.md` (one line)
- Create: `docs/decisions/2026-11-08-mission-schedule-control.md`
- fantasyman (separate repo, worktree `C:\Users\civer\fantasyman\.claude\worktrees\fantasyman-mission-pass-schedule-87de7c`): `dynasty/ops/LOCALCODE-BRIEF.md` + `dynasty/ops/make_cynco_mission.py` docstring + `digest/ops/make_cynco_mission.py` docstring: "the times here are defaults; the owner's overrides live in `~/.cynco/missions/<id>/schedule.json` and survive regeneration; `enabled: false` there turns a pass off without editing this file".

- [ ] **Step 1: Write the daemon doc section** — the tick's per-trigger outcomes (disabled → advance silently; fingerprint changed → reset from now; unchanged → evaluate), the torn/absent/bad semantics, the dropped-on-disable record, Resume-from-now, and that `schedule.json` needs no restart while `mission.json` still does.
- [ ] **Step 2: Decision record** — the two calls: daemon owns `state.json` / dashboard owns `schedule.json`; mission schedule and pause are operational switches reachable with the inference token (phone included); why Resume is from-now.
- [ ] **Step 3: Pins and guards** — `bun scripts/fix-doc-line-pins.mjs && bun engine/__tests__/guards/packageDocSymbolScan.mjs --write && bunx vitest run` → green.
- [ ] **Step 4: Commit both repos** — localcode: `git commit -am "docs: schedule.json overrides, Missions routes, phone-token decision, NOW.md"`; fantasyman: `git commit -am "ops: generators' pass times are defaults; owner overrides live in schedule.json"` (push the fantasyman branch and open its PR to main).

---

### Task 8: Land, restart, verify end to end

- [ ] **Step 1: PR and merge** — `git push -u origin mission-schedule-control && gh pr create --base main --title "mission schedule control: schedule.json overrides, Missions tab, normal widget window" --body "<spec §1 summary>. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"`; merge when CI is green.
- [ ] **Step 2: Owner's terminal tab** — `git -C C:\Users\civer\localcode pull`; `scripts\cynco-services.ps1 stop engine; start engine`; `stop daemon; start daemon`; relaunch the widget.
- [ ] **Step 3: Spec §9 checks** — (2) turn `dynasty-bronze-trades` off on the page, wait past its slot: nothing in `runs.jsonl`, widget "next" skips it, `daemon.log` shows the doorman schedule without it; (3) set tin trades to every 4 hours 9:25–17:25: within 30 s `state.json` `nextFire` is on the new grid and `scheduleSeen` has the fingerprint, the italic preview turns plain; (4) `python dynasty/ops/make_cynco_mission.py` in fantasyman + daemon restart keeps both overrides; (5) Pause from the page during a running pass frees the GPU and the widget says `paused since ... (dashboard)`, Resume from the widget resumes it; (6) widget minimizes/goes behind/taskbar/position.
- [ ] **Step 4: Memory** — update `project-mission-schedule-control.md` in `C:\Users\civer\.claude\projects\C--Users-civer-fantasyman\memory\` with what shipped and anything the checks found.
