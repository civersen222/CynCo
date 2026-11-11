# engine/dashboard

## Purpose
The governance dashboard: one Bun server on the bridge port + 1 (`server.ts`) that serves the single-page UI (`index.html`, read once at engine start), the token-gated `/ws` and `/api/*` routes, and the phone-access boundary (`access.ts`). The phone-access model (local vs remote peers, pairing, device tokens) is recorded in `docs/decisions/2026-10-22-phone-access.md`; the mission schedule routes and why they are inference-scoped in `docs/decisions/2026-11-08-mission-schedule-control.md`. The page is a view over files the daemon and the owner already write; the dashboard owns `schedule.json`, the daemon owns `state.json`.

## Key files
| File | Role |
|---|---|
| `server.ts` | `DashboardServer`: routing, scope checks (`inference` read, `management` for configuration), WebSocket broadcast, every `/api/*` handler. Its header comment lists the mission schedule routes. |
| `access.ts` | Phone-access boundary: `classifyClient` (local vs remote), host/Origin refusals, `PairingGate`, device-token page. |
| `missionsApi.ts` | File logic behind the Missions tab: reads each mission's `mission.json`, `schedule.json`, `state.json`, `runs.jsonl`, `gpu-busy.json` and `daemon-control.json` into one view; validates and writes per-trigger overrides; writes the pause switch. Pure of HTTP. |
| `index.html` | The whole UI. The Missions tab (`#tab-missions`, hash `#missions`) renders via pure string functions (`missionsListHtml`, `missionsHeaderHtml`) that `__tests__/dashboard/missionsView.test.ts` lifts by text. |

## Important types & functions
- **`classifyClient`** (`access.ts:59`) — a loopback peer on a loopback listener is `local`; everything else is `remote` and gets a page with no token in it.
- **`readMissionsView`** (`missionsApi.ts:158`) — `GET /api/missions`: per mission its triggers with effective cadence in words, `enabled`, `overridden`, `nextFire` (a computed preview with `nextFirePreview: true` until the daemon has seen the new cadence), `lastRun` (newest `runs.jsonl` record per trigger, `kind` from `runKind`), the GPU claim from `gpu-busy.json`, and `scheduleStatus` (`ok`/`absent`/`bad` from `readSchedule`; on `bad` the page shows a warning and locks that card).
- **`patchTrigger`** (`missionsApi.ts:179`) — `PUT /api/missions/<id>/triggers/<tid>`: validates the body (cron must parse and fire within four years, `at` is `HH:MM`, `timeoutMs` 60 000 to 7 200 000), merges it into `schedule.json` atomically (a body naming any cadence field first drops the old override's cadence fields, keeping `enabled` and `timeoutMs`); `{ "reset": true }` removes the override; 409 and no write while `schedule.json` is unreadable.
- **`setPaused`** (`missionsApi.ts:216`) — `POST /api/daemon/pause`: `writeControl` with `by: 'dashboard'`.
- **`DashboardServer.handleMissions`** (`server.ts:1316`) — the three routes' handler.

## Data flow
1. The Missions tab polls `GET /api/missions` every 10 s while visible. A save sends `PUT`, which returns the trigger as `GET` would show it.
2. `schedule.json` changes reach the running daemon on its next 30 s tick; the row's next fire turns from preview to real after that. No restart. See `engine/daemon/CLAUDE.md` § Schedule overrides.
3. Pause and Resume write `daemon-control.json`; the daemon and the desk widget read the same file.

## Gotchas
- The three mission routes gate at the `inference` scope for every method, before the generic method-based split in `server.ts` (the comment at `server.ts:682`). They are operational switches, not configuration: a paired phone and the desk page hold only the inference token. `scopes.test.ts` pins both rules.
- `missionsApi.ts` never writes `mission.json` or `state.json`, and `nextFire` shown for a disabled trigger is the daemon's advancing value; the page shows "off" instead.
- The dashboard is the long-running "CynCo headless engine" Task Scheduler job, not a per-pass process: after a change to `server.ts` or `missionsApi.ts`, restart that job (`cynco-services.ps1`) or the old code keeps serving.
- No empty `catch` blocks (`engine/__tests__/guards/emptyCatch.test.ts` ratchet): `missionsApi.ts` returns a value or logs.
