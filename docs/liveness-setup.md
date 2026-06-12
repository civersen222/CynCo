# CynCo Liveness Daemon — Setup

The liveness daemon (`engine/daemon/main.ts`) keeps CynCo alive when no session is open:
it schedules mission triggers, polls MFL for changes, wakes the engine for one-shot tasks,
and pushes recommendations to your phone via self-hosted ntfy over Tailscale.
No public ports are opened anywhere in this setup.

## 1. ntfy server (on the CynCo box)

1. Download the Windows binary from https://github.com/binwiederhier/ntfy/releases (or `scoop install ntfy`).
2. Find your Tailscale IP: `tailscale ip -4` (e.g. `100.101.102.103`).
3. Create `ntfy.yml`:

   ```yaml
   listen-http: "100.101.102.103:8090"   # Tailscale interface ONLY — never 0.0.0.0
   auth-file: "C:/cynco/ntfy/auth.db"
   auth-default-access: "deny-all"
   ```

4. Create a user + access tokens:

   ```
   ntfy user add --role=admin cynco
   ntfy token add cynco          # token for the daemon (CYNCO_NTFY_TOKEN)
   ntfy access cynco "cynco-*" rw
   ```

5. Run `ntfy serve --config ntfy.yml` (register it with Task Scheduler the same way as the daemon below).

## 2. Phone

1. Install Tailscale on your phone and join your tailnet.
2. Install the ntfy app, add server `http://100.101.102.103:8090` with the token.
3. Subscribe to `cynco-alerts`. Approve/Reject buttons on recommendations publish back to
   `cynco-commands` automatically — the daemon hears them over its outbound SSE connection.

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

## 5. Daemon autostart (Windows Task Scheduler)

```powershell
schtasks /Create /TN "CynCo Liveness Daemon" /SC ONLOGON /RL LIMITED `
  /TR "cmd /c set CYNCO_NTFY_URL=http://100.101.102.103:8090&& set CYNCO_NTFY_TOKEN=tk_yourtoken&& set LOCALCODE_MODEL=qwen3.6&& set LOCALCODE_PROVIDER=llama-cpp&& cd /d C:\Users\civer\localcode&& bun engine\daemon\main.ts >> %USERPROFILE%\.cynco\daemon.log 2>&1"
```

In Task Scheduler GUI, open the task → Settings → check "If the task fails, restart every 1 minute".
The daemon never loads a model — it spawns `bun engine/main.ts --run-task <file>` per task,
which starts llama-server, runs, and stops it again. If you have an interactive CynCo session
open (llama-server already running), scheduled tasks defer 10 minutes and retry.

## 6. Smoke test

```bash
# Terminal 1: ntfy serve --config ntfy.yml
# Terminal 2:
CYNCO_NTFY_URL=http://100.101.102.103:8090 CYNCO_NTFY_TOKEN=tk_... \
LOCALCODE_MODEL=qwen3.6 LOCALCODE_PROVIDER=llama-cpp \
bun engine/daemon/main.ts
```

Set a trigger's `everyMinutes` to 1 temporarily; within ~90 seconds your phone should get
either recommendations or a digest. Check `~/.cynco/missions/mfl-dynasty/runs.jsonl` for the run record.

## Security posture

- ntfy listens only on the Tailscale interface; phone access requires tailnet membership + token.
- The daemon makes outbound connections only (MFL API, ntfy publish, ntfy SSE).
- The Mfl tool is read-only by whitelist; MFL write endpoints (TYPE=import) are unreachable until Phase C.
- Phone commands are limited to `{recId, verdict}` — free-text commands are not parsed in Phase B.
