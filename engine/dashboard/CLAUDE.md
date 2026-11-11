# engine/dashboard

## Purpose
The governance dashboard: one Bun server on the bridge port + 1 (`server.ts`) that serves the single-page UI (`index.html`, read once at engine start), the token-gated `/ws` and `/api/*` routes, and the phone-access boundary (`access.ts`). The phone-access model (local vs remote peers, pairing, device tokens) is recorded in `docs/decisions/2026-10-22-phone-access.md`; the mission schedule routes and why they are inference-scoped in `docs/decisions/2026-11-08-mission-schedule-control.md`. The page is a view over files the daemon and the owner already write; the dashboard owns `schedule.json`, the daemon owns `state.json`.

## Key files
| File | Role |
|---|---|
| `server.ts` | `DashboardServer`: routing, scope checks (`inference` read, `management` for configuration), WebSocket broadcast, every `/api/*` handler. Its header comment lists the mission schedule routes. |
| `access.ts` | Phone-access boundary: `classifyClient` (local vs remote), host/Origin refusals, `PairingGate`, device-token page. |
| `installable.ts` | `webManifest()` and `appIconPng(size)`: what makes the page installable. Static, drawn in code, served without a token. |
| `replay.ts` | `ReplayBuffer`: the numbered frames a page that lost its socket is sent when it comes back; `REPLAYED_TYPES` / `NOT_REPLAYED_TYPES` decide, per frame type the page handles, whether it is kept. Pure of sockets. Design: the phone-access record, amendment 2026-11-11. |
| `missionsApi.ts` | File logic behind the Missions tab: reads each mission's `mission.json`, `schedule.json`, `state.json`, `runs.jsonl`, `gpu-busy.json` and `daemon-control.json` into one view; validates and writes per-trigger overrides; writes the pause switch. Pure of HTTP. |
| `index.html` | The whole UI. The Missions tab (`#tab-missions`, hash `#missions`) renders via pure string functions (`missionsListHtml`, `missionsHeaderHtml`) that `__tests__/dashboard/missionsView.test.ts` lifts by text. |

## Important types & functions
- **`classifyClient`** (`access.ts:59`) — a loopback peer on a loopback listener is `local`; everything else is `remote` and gets a page with no token in it.
- **`readMissionsView`** (`missionsApi.ts:158`) — `GET /api/missions`: per mission its triggers with effective cadence in words, `enabled`, `overridden`, `nextFire` (a computed preview with `nextFirePreview: true` until the daemon has seen the new cadence), `lastRun` (newest `runs.jsonl` record per trigger, `kind` from `runKind`), the GPU claim from `gpu-busy.json`, and `scheduleStatus` (`ok`/`absent`/`bad` from `readSchedule`; on `bad` the page shows a warning and locks that card).
- **`patchTrigger`** (`missionsApi.ts:179`) — `PUT /api/missions/<id>/triggers/<tid>`: validates the body (cron must parse and fire within four years, `at` is `HH:MM`, `timeoutMs` 60 000 to 7 200 000), merges it into `schedule.json` atomically (a body naming any cadence field first drops the old override's cadence fields, keeping `enabled` and `timeoutMs`); `{ "reset": true }` removes the override; 409 and no write while `schedule.json` is unreadable.
- **`setPaused`** (`missionsApi.ts:216`) — `POST /api/daemon/pause`: `writeControl` with `by: 'dashboard'`.
- **`DashboardServer.handleMissions`** (`server.ts:1489`) — the three routes' handler.
- **`DashboardServer.proxyListener`** (`server.ts:1087`) — the HTTPS proxy's listener (`LOCALCODE_DASHBOARD_PROXY_PORT`, unset by default): `127.0.0.1` on its own port, the same routes, and every client on it `remote` (the handler is called with `forceRemote`, so the peer's address is never asked). `tailscale serve` forwards the tailnet's HTTPS name to it; it must never be pointed at the desk's port.
- **`parseProxyPort`** (`access.ts:139`) — the variable as a port (1-65535) or null; anything malformed is no listener.
- **`ReplayBuffer`** (`replay.ts:118`) — `record(event)` numbers a frame that draws the Chat pane and returns the JSON to send (consecutive `stream.token`/`stream.thinking` frames join one entry and share a `seq`, `off` says how far into it a frame reaches); `since(cursor)` is what a returning page has not seen, all of it or none (`gap`); `reset()` starts a new epoch.
- **`DashboardServer.broadcast`** (`server.ts:2365`) — every engine event to every dashboard socket. A `project.opened` resets the replay buffer and tells connected pages (`replay.state`, `reason: 'reset'`) before the frame goes out; a replayed type is numbered and kept even with nobody connected.
- **`DashboardServer.handlePhoneAdmin`** (`server.ts:1158`) — `/api/phone*`, management scope and so desk-only: the pairing code, the listeners, each device with `lastSeenAt` and `expiresAt`, `revoke`, `revoke-all` (also rotates the code) and `rotate`. The device records and their idle expiry live in `engine/security/localToken.ts` (`touchDevice`, `expireIdleDevices`, `revokeAllDevices`).
- **`DashboardServer.authenticate`** (`server.ts:1273`) — who presented the token. Off this machine only a `device-*` record authenticates; it first forgets devices idle past `DEVICE_IDLE_EXPIRY_MS` and then marks the holder seen.

## Data flow
1. The Missions tab polls `GET /api/missions` every 10 s while visible. A save sends `PUT`, which returns the trigger as `GET` would show it.
2. `schedule.json` changes reach the running daemon on its next 30 s tick; the row's next fire turns from preview to real after that. No restart. See `engine/daemon/CLAUDE.md` § Schedule overrides.
3. Pause and Resume write `daemon-control.json`; the daemon and the desk widget read the same file.
4. Reconnect: the page puts its cursor on the socket URL (`replayQuery`), the server's `open` sends the frames after it and then `replay.state`, the page drops any numbered frame at or before its cursor (`replayAccept`) and applies `/api/session`'s run state only after `replay.state` (`whenReplayed`). Decisions still open come from `/api/session` `pending`, never from the replay.

## Gotchas
- The three mission routes gate at the `inference` scope for every method, before the generic method-based split in `server.ts` (the comment at `server.ts:713`). They are operational switches, not configuration: a paired phone and the desk page hold only the inference token. `scopes.test.ts` pins both rules.
- `missionsApi.ts` never writes `mission.json` or `state.json`, and `nextFire` shown for a disabled trigger is the daemon's advancing value; the page shows "off" instead.
- The dashboard is the long-running "CynCo headless engine" Task Scheduler job, not a per-pass process: after a change to `server.ts` or `missionsApi.ts`, restart that job (`cynco-services.ps1`) or the old code keeps serving.
- No request body is read before it is bounded: `maxRequestBodySize: MAX_REQUEST_BODY_BYTES` (`server.ts:48`, one upload plus its multipart framing) makes Bun refuse a declared length over it, and the handler refuses a `Transfer-Encoding` body with 411 on every route, before the token check, because Bun's cap does not cover a chunked body (measured under Bun 1.3.13: 60 MB chunked reached the handler). The suite's `Bun.serve` shim does not take the option; `requestBodyBound.test.ts` pins the 411 and the option's presence.
- `GET /`, `/manifest.webmanifest`, `/icon-192.png` and `/icon-512.png` are the only routes that answer without a token, on every listener. Nothing else may join them without a reason of the same kind: static, nothing about the engine in it, and fetched by the browser with no Authorization header.
- `tailscale serve` proxies to `127.0.0.1` only. Its target is the proxy listener; on the desk's listener a forwarded request is a loopback peer and would be served the shared token. `/pair` answers 200 on the proxy listener and 404 on a desk listener from this machine, which is how `scripts/phone-https.ps1` tells them apart before it sets anything.
- `DashboardServer.phoneOrigin` (the wait push's link) reads the device records (`TokenSet.lastDeviceOrigin`), not a field of its own: revoking a device removes its address too.
- A new frame type the page handles (`case '…'` in `handleEvent`) must be put on `REPLAYED_TYPES` or `NOT_REPLAYED_TYPES` in `replay.ts`, or `replay.test.ts` fails. Replay a type only if handling it twice in a row is impossible by construction (the cursor guarantees once) and handling it late is still right; a request for a decision is neither.
- The replay buffer is per engine process and per conversation: a restart, a dispatch swap or a `project.opened` empties it, and a returning page then loads as a fresh one. It is memory only (4,000 entries or 8,000,000 characters).
- No empty `catch` blocks (`engine/__tests__/guards/emptyCatch.test.ts` ratchet): `missionsApi.ts` returns a value or logs.
