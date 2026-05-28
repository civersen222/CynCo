# VSM Governance Dashboard

**Date:** 2026-05-27
**Status:** Approved

## Purpose

A browser-based dashboard that provides real-time visibility into CynCo's VSM governance runtime — monitoring health, tool activity, contracts, predictions, and S5 decisions — plus parameter controls for tuning the system live. Think llama.cpp's web UI, but for cybernetics governance.

The dashboard lets you "look into the brain" of the system: see every tool call, every governance decision, every prediction outcome, every contract assertion, in real time.

## Architecture

### Server

Single file: `engine/dashboard/server.ts`

- `Bun.serve()` on port 9161
- Serves `engine/dashboard/index.html` at `GET /`
- WebSocket endpoint at `/ws` for broadcasting engine events (read-only, multi-client)
- HTTP GET endpoints for snapshot/historical data
- HTTP POST endpoints for parameter mutations (separate per subsystem)
- Started from `engine/main.ts` after the WS server boots

### Event Fan-Out

The dashboard does NOT connect to the existing WS on :9160. Instead, it registers as an internal event listener on the conversation loop's emit path:

```
conversationLoop.emit = (event) => {
  wsServer.emit(event)              // TUI on :9160
  dashboardServer.broadcast(event)  // dashboard clients on :9161
}
```

Zero overhead when no dashboard clients are connected — `broadcast()` is a no-op on an empty client set.

### Files

```
engine/dashboard/
├── server.ts      — Bun.serve: HTTP routes + WS broadcast + config handlers
└── index.html     — entire dashboard UI (vanilla JS + inline CSS)
```

Plus wiring in `engine/main.ts` to start the dashboard server.

## HTTP API

### GET Endpoints (Read-Only)

| Route | Returns | Source |
|-------|---------|--------|
| `GET /` | `index.html` | Static file |
| `GET /api/history` | Last 1000 audit entries from most recent session | `~/.cynco/audit-log/*.jsonl` |
| `GET /api/governance` | Current governance report | `cyberneticsGovernance.getReport()` |
| `GET /api/predictions` | H1-H8 statistics with hit rates | `predictionTracker.getStatistics()` |
| `GET /api/contracts` | Current contract state and assertions | `globalContract` |
| `GET /api/params` | All governance param names, current values, min/max bounds | `governanceParams.exportParams()` + metadata |

### POST Endpoints (Config Mutation)

Each subsystem has its own endpoint. All return `{ applied: {...}, errors: [...] }`.

**`POST /config/engine`** — Engine-level config
| Field | Type | Range | Target |
|-------|------|-------|--------|
| `temperature` | float | 0.0 – 2.0 | `config.update` command |
| `contextLength` | int | 1024 – 2097152 | `config.update` command |
| `timeout` | int | 1000 – 600000 ms | `config.update` command |
| `maxOutputTokens` | int | 1 – 128000 | `config.update` command |

**`POST /config/governance`** — VSM governance parameters (21 total)
| Field | Type | Range | Target |
|-------|------|-------|--------|
| `variety.env_multiplier` | float | 1.0 – 10.0 | `governanceParams.setParam()` |
| `variety.overload_ratio` | float | 0.1 – 1.0 | `governanceParams.setParam()` |
| `homeostat.damping` | float | 0.1 – 2.0 | `governanceParams.setParam()` |
| `homeostat.time_constant` | float | 0.5 – 30.0 | `governanceParams.setParam()` |
| `homeostat.stability_tolerance` | float | 0.001 – 0.5 | `governanceParams.setParam()` |
| `homeostat.perturbation_magnitude` | float | 0.01 – 2.0 | `governanceParams.setParam()` |
| `feedback.context_setpoint` | float | 0.3 – 0.95 | `governanceParams.setParam()` |
| `feedback.context_gain` | float | 0.1 – 2.0 | `governanceParams.setParam()` |
| `feedback.pid_kp` | float | 0.01 – 2.0 | `governanceParams.setParam()` |
| `feedback.pid_ki` | float | 0.001 – 0.5 | `governanceParams.setParam()` |
| `feedback.pid_kd` | float | 0.001 – 1.0 | `governanceParams.setParam()` |
| `feedback.compression_threshold` | float | -0.5 – 0.0 | `governanceParams.setParam()` |
| `algedonic.kill_threshold` | int | 2 – 20 | `governanceParams.setParam()` |
| `algedonic.pain_score` | float | 0.3 – 1.0 | `governanceParams.setParam()` |
| `algedonic.pleasure_score` | float | 0.0 – 0.5 | `governanceParams.setParam()` |
| `metrics.cusum_threshold` | float | 1.0 – 10.0 | `governanceParams.setParam()` |
| `metrics.cusum_slack` | float | 0.1 – 2.0 | `governanceParams.setParam()` |
| `metrics.red_health` | float | 0.1 – 0.5 | `governanceParams.setParam()` |
| `metrics.amber_health` | float | 0.3 – 0.8 | `governanceParams.setParam()` |
| `global.stuck_threshold` | int | 2 – 10 | `governanceParams.setParam()` |
| `global.signal_injection` | float | 0.0 – 1.0 | `governanceParams.setParam()` |

**`POST /config/tools`** — Tool system
| Field | Type | Range | Target |
|-------|------|-------|--------|
| `trustDecayThreshold` | float | 0.0 – 1.0 | `toolScorer` demotion threshold |
| `toolRouting` | bool | — | `toolRouter` enable/disable |

**`POST /config/system`** — System-level toggles
| Field | Type | Range | Target |
|-------|------|-------|--------|
| `ablation` | bool | — | `governance.pause()` / `governance.resume()` |
| `contractEnforcement` | bool | — | `globalContract` enforcement toggle |
| `s4ReflectionFrequency` | int | 1 – 20 | S4 reflector interval (turns) |

## WebSocket Events (Engine → Dashboard)

The dashboard subscribes to these events on `ws://localhost:9161/ws`:

**Governance:**
- `governance.status` — health, s3s4Balance, toolSuccessRate, stuckTurns, varietyRatio, axiomHealth
- `governance.recommendation` — severity, signal, title, description, action
- `governance.alert` — severity, message, source

**Tools:**
- `tool.start` — toolId, toolName, input
- `tool.complete` — toolId, toolName, result, isError

**S5 Decisions:**
- `s2.decision` — decision, agentId, reason, gpuUtil, queueDepth

**Context:**
- `context.status` — utilization, estimatedTokens, contextLength, action
- `context.warning` — utilization, message

**Vibe Loop:**
- `vibe.state_changed` — fromState, to
- `vibe.confidence_update` — confidence dimensions, overall score

**Session:**
- `session.ready` — model, contextLength, projectPath, version
- `config.current` — full config snapshot
- `config.updated` — applied changes + errors

## Dashboard Layout

Two-column grid, dark theme (#1e1e1e), monospace font. 8 monitoring panels + parameter controls below.

### Monitoring Panels (2-column grid)

**Row 1:**
- **Connection Status** — live/disconnected indicator with pulse animation, model name, session duration, turn count, tier
- **Context Utilization** — progress bar with gradient (teal → yellow as utilization grows), token count, context length, current action (proceed/compact)

**Row 2:**
- **Governance Health** — overall status badge (Healthy/Warning/Critical/Halted), S3/S4 balance, variety ratio, tool success rate, stuck turns, algedonic alerts, axiom health. Sub-badges for S3/S4/S5 authority state.
- **S5 Decision Log** — scrolling list of decisions with timestamp, action (proceed/compact/restrict tools/switch model), priority, reasoning, rule IDs fired

**Row 3 (full width):**
- **Tool Activity — "The Brain"** — two sub-components:
  - *Stacked bar chart*: one bar per tool (Read, Glob, Grep, Edit, Write, Bash, CodeIndex, Git, Agent, etc.). Green segment = successful calls, red segment = failures. Bar height = total calls. Instant visual of tool reliance patterns and failure hotspots.
  - *Live feed*: scrolling log of individual tool calls — timestamp, success/failure icon, tool name, target (file path or pattern), latency in ms. Real-time view of every "thought" the system has.

**Row 4:**
- **Active Contract** — title, brief, assertion list with pass/fail/pending status, enforcement round counter, overall progress
- **Prediction Tracker (H1–H8)** — table showing each hypothesis name, hit rate percentage, sample size, null baseline, Wilson confidence interval. Color-coded: green = significantly above null, red = below, grey = insufficient data

### Parameter Controls (below monitoring)

**Primary controls** (always visible, two columns):
- Left: Engine Config — Temperature (0–2), Context Length (1K–128K), Timeout (1s–600s) as sliders with numeric readout
- Right: System Controls — Toggle switches for Tool Routing, Contract Enforcement, VSM Governance (ablation pause/resume). Sliders for Kill Switch Threshold (2–20), Trust Decay Threshold (0–1), S4 Reflection Frequency (1–20 turns)

**Advanced section** (collapsed by default):
- Expandable panel with subsystem tabs: Variety, Homeostat, Feedback/PID, Algedonic, Metrics, Global
- Each tab shows its parameters as sliders with min/max bounds from `governanceParams`
- Blue slider color to distinguish from curated controls

**Apply/Reset:**
- Changes batch locally in the browser
- "Apply Changes" POSTs to the appropriate `/config/*` endpoints
- "Reset to Defaults" restores original values from `governanceParams`

**Slider colors:**
- Teal (#4ec9b0) for engine config
- Orange (#ce9178) for safety thresholds
- Blue (#569cd6) for advanced governance params

## Standalone Mode

When no TUI session is active:

1. Browser connects WS, receives no `session.ready` within 2 seconds
2. Falls back to polling GET endpoints for historical data
3. Monitoring panels show data from `~/.cynco/audit-log/*.jsonl` (most recent session), capped at last 1000 entries
4. Tool activity shows historical bar chart from audit data
5. "No active session" badge on connection status (grey, no pulse)
6. Parameter controls greyed out and disabled — nothing to configure
7. When a new session starts, WS receives `session.ready` and dashboard transitions to live mode automatically

## Ablation Toggle Behavior

`POST /config/system { ablation: true }`:
- Calls `governance.pause()` — a new method on `CyberneticsGovernance`
- Governance stops emitting decisions and signals
- Internal state preserved: homeostat weights, variety counters, prediction tracker, algedonic history
- Monitoring panels show "VSM PAUSED" badge with muted overlay
- S5 decisions stop appearing in the log
- Tool activity continues (tools still run, governance just isn't mediating)

`POST /config/system { ablation: false }`:
- Calls `governance.resume()` — picks up from preserved state
- Live updates resume immediately
- No cold-start penalty

## Error Handling

- **Port 9161 in use**: Dashboard server logs warning, engine continues without dashboard. No crash.
- **No clients connected**: `broadcast()` is a no-op. Zero overhead.
- **Invalid POST values**: Returns 400 with `{ errors: [{ field, message }] }`. Valid fields in same request still apply. Browser shows inline validation errors.
- **Session ends**: WS sends `session.end`, dashboard transitions to standalone mode with the just-completed session's historical data.
- **Multiple browser tabs**: All receive same broadcast. Config changes from any tab apply (last write wins), all tabs see `config.updated` event.
- **WS disconnect**: Browser auto-reconnects with exponential backoff (1s, 2s, 4s, max 30s). Yellow "Reconnecting..." banner during disconnect.

## Tech Constraints

- Single HTML file with inline CSS and JS — no build step, no npm dependencies
- Vanilla JS + fetch + WebSocket — no framework
- Dark theme (#1e1e1e background) matching the TUI aesthetic
- Auto-reconnect on disconnect with exponential backoff
- Advanced governance slider bounds fetched from `GET /api/governance` response (which includes param metadata from `governanceParams`), not hardcoded in HTML. Primary control bounds are hardcoded (they're stable, well-known ranges).

## Testing

- **Server unit tests** (`engine/__tests__/dashboard/server.test.ts`): HTTP routes return correct status/content, POST validation rejects out-of-bounds values, WS broadcast reaches connected clients
- **Integration test**: Start dashboard server + mock conversation loop, emit events, verify arrival on WS client. POST config changes, verify they reach `governanceParams.setParam()` and `toolScorer`
- **Standalone mode test**: Start dashboard with no active session, verify `/api/history` reads audit JSONL and returns structured data
- **No browser/E2E tests**: Vanilla JS UI is manually tested in browser. Server-side logic is where automated tests focus.

## New Code Required

1. `engine/dashboard/server.ts` — Bun.serve with HTTP + WS
2. `engine/dashboard/index.html` — full dashboard UI
3. Wiring in `engine/main.ts` — start dashboard after WS server
4. `governance.pause()` / `governance.resume()` methods on `CyberneticsGovernance`
5. Make `toolScorer` demotion threshold configurable (currently hardcoded 0.35)
6. `engine/__tests__/dashboard/server.test.ts` — tests
