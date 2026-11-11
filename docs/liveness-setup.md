# CynCo Liveness Daemon — Setup

The liveness daemon (`engine/daemon/main.ts`) keeps CynCo alive when no session is open:
it schedules mission triggers, polls MFL for changes, wakes the engine for one-shot tasks,
and pushes recommendations to your phone via self-hosted ntfy over Tailscale.
No public ports are opened anywhere in this setup.

## 1. ntfy server (on the doorman)

Since 2026-11-08 (wakefulness slice 6) ntfy runs on the always-on doorman, not on the GPU PC: the
PC sleeps, and a server that sleeps with it loses phone commands and cannot carry the NAS alert.
`bash scripts/doorman/deploy.sh` (from the repo root, over the tailnet) starts it as a Docker
container (`scripts/doorman/ntfy/docker-compose.yml`) bound to the doorman's Tailscale address only
(`100.110.117.10:8090`, from `server.template.yml`), with a 168 h message cache in a named volume and
`restart: unless-stopped`. There is no auth file: tailnet membership is the authentication, and the
Approve/Reject http actions on the phone need anonymous publish. Leave `CYNCO_NTFY_TOKEN` unset.

The same deploy installs `naswatch.service` (`scripts/doorman/naswatch.py`): it pings the router first
and then the NAS every minute and publishes to the `cynco-alerts` topic only when a target changes
state (`/etc/doorman/naswatch.json`, from `naswatch.example.json`). To retire either: `docker compose
down` in `/opt/doorman/ntfy`, `sudo systemctl disable --now naswatch`.

The old PC server (Windows binary, Task Scheduler task "Dynasty ntfy", `fantasyman\dynasty\ops\ntfy.yml`)
is disabled, not deleted; re-enable it and point `CYNCO_NTFY_URL` back at it to roll back.

## 2. Phone

1. Install Tailscale on your phone and join your tailnet.
2. Install the ntfy app, add server `http://100.110.117.10:8090` (the doorman; no token).
3. Subscribe to `cynco-alerts`. Approve/Reject buttons on recommendations publish back to
   `cynco-commands` automatically — the daemon hears them over its outbound SSE connection.
4. The same topic carries "CynCo needs your approval" / "CynCo has a question" when the phone
   engine waits on you with nobody connected (`engine/daemon/CLAUDE.md`, "Tell the phone when the
   engine waits"). Tap it to open the dashboard and answer there (it carries the link once the phone has
   opened the dashboard since the engine started); the notification itself has no buttons.

## 3. MFL credentials (optional but recommended)

Create `~/.cynco/credentials/mfl.json`:

```json
{ "apiKey": "<your MFL API key from League Settings → API>" }
```

Public league data works without a key; the key adds franchise-scoped data and higher rate limits.
The key never appears in prompts, outcomes, or notifications (redacted by the Mfl tool).

## 4. Mission

Create `~/.cynco/missions/mfl-dynasty/mission.json`:

```json
{
  "id": "mfl-dynasty",
  "goal": "Manage my MFL dynasty teams: spot waiver targets, evaluate trades, flag injury risks. Recommend, never act — the user executes approved moves.",
  "leagues": [
    { "leagueId": "12345", "year": 2026, "franchiseId": "0005" }
  ],
  "triggers": [
    {
      "id": "transaction-watch", "kind": "interval", "everyMinutes": 120,
      "precheck": "mfl-delta", "missedPolicy": "skip",
      "prompt": "League transactions changed since the last check. Review what happened (Mfl tool: transactions, rosters, pendingTrades). If anything affects my franchise — a player I should claim, a trade I should consider or counter — produce recommendations. Otherwise return an empty recommendations array."
    },
    {
      "id": "morning-brief", "kind": "daily", "at": "08:00",
      "precheck": "none", "missedPolicy": "run-once-on-startup",
      "prompt": "Morning dynasty brief: check injuries (Mfl tool: injuries) and search the web for news on my rostered players (Mfl: rosters with FRANCHISE filter, then WebSearch). Summarize anything that changes my roster outlook. Recommendations only for actionable items."
    },
    {
      "id": "weekly-digest", "kind": "weekly", "day": "mon", "at": "09:00",
      "precheck": "none", "missedPolicy": "skip",
      "prompt": "Weekly state-of-the-roster digest: standings (Mfl: leagueStandings), roster strengths/weaknesses, future draft picks (Mfl: futureDraftPicks), and 1-3 strategic suggestions for the coming week."
    }
  ],
  "trustLadder": {
    "waiver": { "mode": "ask", "promoteAt": 10 },
    "trade":  { "mode": "ask", "promoteAt": 10 },
    "lineup": { "mode": "ask", "promoteAt": 5 }
  }
}
```

Trigger kinds: `interval` (`everyMinutes`), `daily` (`at`), `weekly` (`day` + `at`),
and `cron` — a 5-field cron expression in local time, e.g.
`{ "id": "gameday", "kind": "cron", "cron": "0 11,17 * * 0", ... }` (Sundays 11:00 and 17:00).

The daemon reads `mission.json` once at startup — after editing it (new triggers,
changed intervals, trust ladder), restart the daemon for the changes to take effect.

### Tools and workspace per mission

By default a one-shot run may only use `Mfl`, `WebSearch`, `WebFetch` and `Read` (read-only). A
mission can set `"allowedTools": [...]` at the top level, and a trigger can override it with its own
`allowedTools`. Adding `Bash` or `Write` lets the model run commands and change files, so only do it
for a prompt that confines the model to a known command surface, and say what that surface is in the
mission `goal`. `"cwd": "<folder>"` (mission or trigger) makes that folder the run's workspace: the
`Bash` tool runs there and the loop snapshots it. `"timeoutMs": <ms>` (mission or trigger) replaces the
15-minute kill for that mission's prompt triggers (a trigger's own value wins; trade-scan keeps 60 minutes
unless its trigger sets one). All three are read by the daemon at startup — restart it after editing the
mission file.

### Dynasty runbook mission

The owner's MFL dynasty team is run by a scripted runbook in `C:\Users\civer\fantasyman\dynasty`
(see its `README.md`; CynCo is the default runner there). Its mission file is generated by
`python C:\Users\civer\fantasyman\dynasty\ops\make_cynco_mission.py` into
`~/.cynco/missions/mfl-dynasty/mission.json` with `allowedTools` `["Bash", "Write", "Read",
"WebSearch", "WebFetch", "Mfl"]` and `cwd` `C:/Users/civer/fantasyman`. Every pass starts with
`python dynasty/mfl.py gate cynco --pass <name>`, which refuses (prints `skip: ...`) until
`cynco_enabled` is `true` in `fantasyman/dynasty/config.json`; adds, drops, bids and every trade
message go to the owner's phone for a tap before they execute, so the model's `Bash` access cannot
change the team on its own. This mission does not use the daemon's ntfy channel for its proposals (the fantasyman approval
listener owns the phone), but the daemon still requires `CYNCO_NTFY_URL` at startup for its own
halt/failure alerts: point it at the same server (`http://100.101.192.101:8090`); no token is needed
on a server without auth, and the daemon's topics (`cynco-alerts`, `cynco-commands`) do not collide
with the runbook's `dynasty` topics. Autostart with the section 5 command minus `CYNCO_NTFY_TOKEN`.

## 5. Daemon autostart (Windows Task Scheduler)

```powershell
schtasks /Create /TN "CynCo Liveness Daemon" /SC ONLOGON /RL LIMITED `
  /TR "cmd /c set CYNCO_NTFY_URL=http://100.101.102.103:8090&& set CYNCO_NTFY_TOKEN=tk_yourtoken&& set LOCALCODE_PROVIDER=llama-cpp&& cd /d C:\Users\civer\localcode&& bun engine\daemon\main.ts >> %USERPROFILE%\.cynco\daemon.log 2>&1"
```

> The daemon no longer sets `LOCALCODE_MODEL`. With it unset, the engine auto-loads
> `~/.cynco/profiles/default.yaml` (the canonical 27B-Q6_K / 64k / MTP config), so
> the daemon and the interactive TUI provably run the same model.

In Task Scheduler GUI, open the task → Settings → check "If the task fails, restart every 1 minute".
The daemon never loads a model — it spawns `bun engine/main.ts --run-task <file>` per task,
which starts llama-server, runs, and stops it again. If you have an interactive CynCo session
open (llama-server already running), scheduled tasks defer 10 minutes and retry.

## 6. Smoke test

```bash
# ntfy already runs on the doorman (scripts/doorman/deploy.sh) - nothing to start here
# Terminal 2:
CYNCO_NTFY_URL=http://100.101.102.103:8090 CYNCO_NTFY_TOKEN=tk_... \
LOCALCODE_PROVIDER=llama-cpp \
bun engine/daemon/main.ts
```

Set a trigger's `everyMinutes` to 1 temporarily; within ~90 seconds your phone should get
either recommendations or a digest. Check `~/.cynco/missions/mfl-dynasty/runs.jsonl` for the run record.

## 7. Doorman: let the PC sleep between triggers (wakefulness, 2026-11-08)

With the doorman mini PC on the tailnet (`scripts/doorman/`, design `docs/decisions/2026-11-08-wakefulness-design.md`),
the daemon publishes every mission's next-fire times after each tick and the doorman wakes this PC
3 minutes before each one, so Windows' own "Sleep after" timer may sleep the box between triggers.
Add to the daemon's launch script (the one Task Scheduler runs):

| Variable | Default | Purpose |
|---|---|---|
| `CYNCO_DOORMAN_URL` | unset — nothing is published; the PC must stay awake for triggers | The doorman service, e.g. `http://100.110.117.10:9170`. The daemon POSTs `{target, times}` to `/schedule`, re-sends when the list changes and every 10 minutes regardless (a restarted doorman learns it again), and logs one line per failed send. Read in `engine/daemon/main.ts` only. |
| `CYNCO_DOORMAN_TARGET` | `main` | Which target in the doorman's `targets.json` this PC is (`main`; its `"with": ["image"]` makes the doorman wake the 4070 box alongside — image box design §5). Only matters once a second GPU box is on the switch. |

While a one-shot runs, the daemon holds the PC awake (`engine/power/awake.ts`); with nothing running it holds
nothing, and the owner's "Sleep after" setting decides. `scripts/cynco-services.ps1` shows and starts/stops the
daemon, the headless phone engine, the embedding server (`embed`: `llama-server --embeddings` on 127.0.0.1:9165, `docs/decisions/2026-11-08-embeddings-own-llama-server.md`) and the approval listener, and reports whether the doorman's ntfy answers.

## Security posture

- ntfy listens only on the doorman's Tailscale interface; tailnet membership is the authentication (no auth file, no token).
- The daemon makes outbound connections only (MFL API, ntfy publish, ntfy SSE).
- The Mfl tool is read-only by whitelist; MFL write endpoints (TYPE=import) are unreachable until Phase C.
- Phone commands are limited to `{recId, verdict}` — free-text commands are not parsed in Phase B.
