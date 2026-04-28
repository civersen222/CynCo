# CynCo Audit Log

Append-only, structured JSONL logging for the Beer viability audit. Captures every governance event needed to answer the five Beer viability tests across a 4-week longitudinal study.

## Directory

All logs live in `~/.cynco/audit-log/`:

| File | What it captures | Written by |
|------|-----------------|------------|
| `events.jsonl` | Every governance/context/S5 event | Engine (auto) |
| `parameters.jsonl` | Governance parameter mutations | Engine (auto) |
| `strategies.jsonl` | Strategy proposals, adoptions, deprecations | Engine (auto) |
| `algedonic.jsonl` | Pain/pleasure signals, kill switch events | Engine (auto) |
| `s5-decisions.jsonl` | Every S5 decision with input/output | Engine (auto) |
| `session-outcomes.jsonl` | One row per session with summary stats | Engine (auto) + human |
| `variety-overflow.jsonl` | Tasks CynCo couldn't handle | Human (manual) |
| `metadata.json` | Audit config (model, hardware, start date) | Human via `/audit-start` |

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/audit-start <model> <hardware>` | Start the 4-week audit. Writes metadata.json. Cannot overwrite. |
| `/audit-summary <text>` | Record what this session's task was |
| `/audit-result success\|fail` | Record whether the session achieved its goal |
| `/audit-status` | Show days elapsed, days remaining, model info |

## Starting the Audit

```bash
# In the TUI, type:
/audit-start qwen3:8b "RTX 4090 24GB, Ryzen 9 7950X, 64GB RAM"
```

This writes `metadata.json` and starts the 28-day clock. All subsequent sessions automatically log to the audit streams.

## What Happens on Crash

If the engine crashes (SIGTERM/SIGINT), the session-outcomes row is written with `crash_reason` field. If SIGKILL (ungraceful), the session row is missing — the next startup can detect orphaned sessions.

## Querying the Logs

```bash
# What strategies have been proposed?
grep '"strategy.propose"' ~/.cynco/audit-log/strategies.jsonl | jq .strategy_text

# When did the kill switch last fire?
grep '"algedonic.killswitch_fire"' ~/.cynco/audit-log/algedonic.jsonl | tail -1

# How many sessions succeeded vs failed?
grep '"session.outcome"' ~/.cynco/audit-log/session-outcomes.jsonl | jq .success | sort | uniq -c

# What S5 decisions were made today?
grep "$(date +%Y-%m-%d)" ~/.cynco/audit-log/s5-decisions.jsonl | jq .output.reasoning

# Total tool calls across all sessions
grep '"session.outcome"' ~/.cynco/audit-log/session-outcomes.jsonl | jq .tool_calls | paste -sd+ | bc

# Parameter drift over time
grep '"param.mutate"' ~/.cynco/audit-log/parameters.jsonl | jq '{param: .param_name, from: .before, to: .after, when: .ts}'
```

## Entry Schema

Every JSONL entry has:
- `ts` — ISO 8601 with milliseconds and timezone
- `session_id` — unique per engine process
- `project_id` — sha256(cwd)[:12], stable per project
- `type` — stream-specific event type

Plus stream-specific fields documented in the build spec.

## Rules

- **Never delete or rotate** logs during the audit
- **Never modify governance behavior** to make logging easier
- Logs are **append-only** — disk is cheap, lost history ends the audit
- Every write is **fsync'd** — entries survive crashes
