# VSM Governance Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-based governance dashboard that displays live VSM data (tool activity, contracts, predictions, S5 decisions, context utilization) and provides parameter controls for tuning the system, served by Bun on port 9161.

**Architecture:** Monolithic `engine/dashboard/server.ts` with Bun.serve (HTTP + WS) on port 9161. Internal event fan-out from the conversation loop's emit callback (not a second WS client). Single `engine/dashboard/index.html` with inline CSS/JS, no build step.

**Tech Stack:** TypeScript (Bun), vanilla JS + HTML + CSS (no framework), WebSocket for live events, fetch for config mutations.

**Spec:** `docs/superpowers/specs/2026-05-27-governance-dashboard-design.md`

---

## File Structure

**Create:**
- `engine/dashboard/server.ts` — Bun.serve: HTTP routes + WS broadcast + config POST handlers
- `engine/dashboard/index.html` — entire dashboard UI (vanilla JS, inline CSS)
- `engine/__tests__/dashboard/server.test.ts` — server unit + integration tests

**Modify:**
- `engine/main.ts:300-322` — wire dashboard server into emit fan-out, start after WS server
- `engine/vsm/cyberneticsGovernance.ts:84-811` — add `pause()`, `resume()`, `isPaused()` methods
- `engine/vsm/governanceParams.ts:203-209` — add `exportParamMetadata()` function
- `engine/tools/toolScorer.ts:21` — make demotion threshold configurable
- `engine/tools/toolRouter.ts:36-38` — add runtime routing toggle
- `engine/tools/contract.ts:27-129` — add enforcement toggle
- `engine/vsm/s4Reflector.ts:10-22` — add `setFrequency()` method

---

### Task 1: Add pause/resume to CyberneticsGovernance

**Files:**
- Modify: `engine/vsm/cyberneticsGovernance.ts:128-148`
- Test: `engine/__tests__/vsm/cyberneticsGovernance.test.ts` (existing, add test)

The current ablation toggle (`_ablated`) is readonly and set from an env var at construction time. We need a runtime-mutable `_paused` flag that skips governance processing but retains all internal state.

- [ ] **Step 1: Write the failing test**

Add to `engine/__tests__/vsm/cyberneticsGovernance.test.ts`:

```typescript
describe('pause/resume', () => {
  it('pause() stops governance processing, resume() restores it', () => {
    const gov = new CyberneticsGovernance()
    expect(gov.isPaused()).toBe(false)

    gov.pause()
    expect(gov.isPaused()).toBe(true)

    // getReport() should still work (read-only) but with a 'paused' flag
    const report = gov.getReport()
    expect(report.status).toBeDefined()

    gov.resume()
    expect(gov.isPaused()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/vsm/cyberneticsGovernance.test.ts -t "pause"`
Expected: FAIL — `gov.isPaused is not a function`

- [ ] **Step 3: Implement pause/resume methods**

In `engine/vsm/cyberneticsGovernance.ts`, add after `private readonly _ablated: boolean` (line 129):

```typescript
  // Runtime pause — governance stops processing but retains state
  private _paused: boolean = false
```

Then add these methods before the closing `}` of the class (before line 811):

```typescript
  /** Pause governance — stops emitting decisions/signals but retains all state. */
  pause(): void {
    this._paused = true
    console.log('[vsm] Governance paused — state preserved, processing suspended')
  }

  /** Resume governance — picks up from preserved state. */
  resume(): void {
    this._paused = false
    console.log('[vsm] Governance resumed')
  }

  /** Check if governance is currently paused. */
  isPaused(): boolean {
    return this._paused
  }
```

Update the early-return guards in `recordToolResult()` (line 244) and `onTurnComplete()` (line 329) to also check `_paused`:

At line 244, change:
```typescript
    if (this._ablated) return // Skip all governance when ablated
```
to:
```typescript
    if (this._ablated || this._paused) return // Skip when ablated or paused
```

At line 329, change:
```typescript
    if (this._ablated) return // Skip all governance when ablated
```
to:
```typescript
    if (this._ablated || this._paused) return // Skip when ablated or paused
```

At line 761, change:
```typescript
    if (this._ablated) return // No kill switch when ablated
```
to:
```typescript
    if (this._ablated || this._paused) return // No kill switch when ablated or paused
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/vsm/cyberneticsGovernance.test.ts -t "pause"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/cyberneticsGovernance.ts engine/__tests__/vsm/cyberneticsGovernance.test.ts
git commit -m "feat: add pause/resume to CyberneticsGovernance for dashboard ablation toggle"
```

---

### Task 2: Add S4 reflection frequency setter

**Files:**
- Modify: `engine/vsm/s4Reflector.ts:10-22`
- Test: `engine/__tests__/vsm/s4Reflector.test.ts` (existing or new)

The S4Reflector has `getFrequency()` and `setBounds()` but no way to directly set the frequency. The dashboard needs to set it.

- [ ] **Step 1: Write the failing test**

Create `engine/__tests__/vsm/s4Reflector.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { S4Reflector } from '../../vsm/s4Reflector.js'

describe('S4Reflector.setFrequency', () => {
  it('sets frequency within bounds', () => {
    const r = new S4Reflector(8, 3, 15)
    r.setFrequency(5)
    expect(r.getFrequency()).toBe(5)
  })

  it('clamps to min bound', () => {
    const r = new S4Reflector(8, 3, 15)
    r.setFrequency(1)
    expect(r.getFrequency()).toBe(3)
  })

  it('clamps to max bound', () => {
    const r = new S4Reflector(8, 3, 15)
    r.setFrequency(30)
    expect(r.getFrequency()).toBe(15)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/vsm/s4Reflector.test.ts`
Expected: FAIL — `r.setFrequency is not a function`

- [ ] **Step 3: Implement setFrequency**

In `engine/vsm/s4Reflector.ts`, add after `getFrequency()` (line 24):

```typescript
  setFrequency(n: number): void {
    this.x = Math.max(this.minX, Math.min(this.maxX, Math.round(n)))
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/vsm/s4Reflector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/vsm/s4Reflector.ts engine/__tests__/vsm/s4Reflector.test.ts
git commit -m "feat: add setFrequency() to S4Reflector for dashboard control"
```

---

### Task 3: Make toolScorer threshold configurable

**Files:**
- Modify: `engine/tools/toolScorer.ts:18-22`
- Test: `engine/__tests__/toolScorer.test.ts` (existing, modify)

The demotion threshold 0.35 is hardcoded on line 21. Add a configurable threshold with getter/setter.

- [ ] **Step 1: Write the failing test**

Add to `engine/__tests__/toolScorer.test.ts`:

```typescript
it('uses configurable demotion threshold', () => {
  const scorer = new ToolScorer()
  // 3 calls, 1 success → confidence = (1+1)/(3+2) = 0.4
  scorer.record('TestTool', true)
  scorer.record('TestTool', false)
  scorer.record('TestTool', false)

  // Default 0.35: confidence 0.4 >= 0.35, NOT demoted
  expect(scorer.shouldDemote('TestTool')).toBe(false)

  // Raise threshold to 0.5: confidence 0.4 < 0.5, IS demoted
  scorer.setDemotionThreshold(0.5)
  expect(scorer.shouldDemote('TestTool')).toBe(true)
  expect(scorer.getDemotionThreshold()).toBe(0.5)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && bun test __tests__/toolScorer.test.ts -t "configurable"`
Expected: FAIL — `scorer.setDemotionThreshold is not a function`

- [ ] **Step 3: Implement configurable threshold**

In `engine/tools/toolScorer.ts`, modify the class:

```typescript
type ToolStats = { successes: number; total: number }

export class ToolScorer {
  private scores = new Map<string, ToolStats>()
  private demotionThreshold: number = 0.35

  setDemotionThreshold(threshold: number): void {
    this.demotionThreshold = Math.max(0, Math.min(1, threshold))
  }

  getDemotionThreshold(): number {
    return this.demotionThreshold
  }

  record(toolName: string, success: boolean): void {
    const stats = this.scores.get(toolName) ?? { successes: 0, total: 0 }
    stats.total++
    if (success) stats.successes++
    this.scores.set(toolName, stats)
  }

  getConfidence(toolName: string): number {
    const stats = this.scores.get(toolName) ?? { successes: 0, total: 0 }
    return (stats.successes + 1) / (stats.total + 2)
  }

  shouldDemote(toolName: string): boolean {
    const stats = this.scores.get(toolName)
    if (!stats || stats.total < 3) return false
    return this.getConfidence(toolName) < this.demotionThreshold
  }

  getDemotedTools(): string[] {
    return [...this.scores.keys()].filter(t => this.shouldDemote(t))
  }

  save(path: string): void {
    const data: Record<string, ToolStats> = {}
    for (const [k, v] of this.scores) data[k] = v
    try {
      const fs = require('fs')
      fs.mkdirSync(require('path').dirname(path), { recursive: true })
      fs.writeFileSync(path, JSON.stringify(data, null, 2))
    } catch {}
  }

  load(path: string): void {
    try {
      const fs = require('fs')
      if (!fs.existsSync(path)) return
      const data = JSON.parse(fs.readFileSync(path, 'utf-8'))
      for (const [k, v] of Object.entries(data)) this.scores.set(k, v as ToolStats)
    } catch {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && bun test __tests__/toolScorer.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add engine/tools/toolScorer.ts engine/__tests__/toolScorer.test.ts
git commit -m "feat: make toolScorer demotion threshold configurable for dashboard"
```

---

### Task 4: Add runtime toggle to toolRouter + enforcement toggle to contract

**Files:**
- Modify: `engine/tools/toolRouter.ts:36-38`
- Modify: `engine/tools/contract.ts:27-129`

- [ ] **Step 1: Add routing override to toolRouter**

In `engine/tools/toolRouter.ts`, add after line 38:

```typescript
let routingOverride: boolean | null = null

export function setRoutingEnabled(enabled: boolean | null): void {
  routingOverride = enabled
}

export function isRoutingEnabled(): boolean {
  return routingOverride !== null ? routingOverride : false
}
```

Modify `shouldUseRouting` to respect the override:

```typescript
export function shouldUseRouting(contextLength: number): boolean {
  if (routingOverride !== null) return routingOverride
  return contextLength <= 65536
}
```

- [ ] **Step 2: Add enforcement toggle to ContractState**

In `engine/tools/contract.ts`, add to the ContractState class after `enforcementRounds` (line 33):

```typescript
  /** When false, enforcement logic should skip contract checks. */
  private enforcementEnabled: boolean = true

  setEnforcementEnabled(enabled: boolean): void {
    this.enforcementEnabled = enabled
  }

  isEnforcementEnabled(): boolean {
    return this.enforcementEnabled
  }
```

- [ ] **Step 3: Commit**

```bash
git add engine/tools/toolRouter.ts engine/tools/contract.ts
git commit -m "feat: add runtime routing toggle and contract enforcement toggle"
```

---

### Task 5: Add exportParamMetadata to governanceParams

**Files:**
- Modify: `engine/vsm/governanceParams.ts:203-209`

The dashboard needs full param metadata (name, value, min, max, system, description) not just the flat values from `exportParams()`.

- [ ] **Step 1: Add the function**

In `engine/vsm/governanceParams.ts`, add after `exportParams()` (after line 209):

```typescript
/**
 * Export full parameter metadata for the dashboard.
 * Includes name, current value, default, min, max, system, and description.
 */
export function exportParamMetadata(): Array<{
  name: string; value: number; default: number;
  min: number; max: number; system: string; description: string;
}> {
  return [...GOVERNANCE_PARAMS.values()].map(p => ({
    name: p.name, value: p.value, default: p.default,
    min: p.min, max: p.max, system: p.system, description: p.description,
  }))
}
```

- [ ] **Step 2: Commit**

```bash
git add engine/vsm/governanceParams.ts
git commit -m "feat: add exportParamMetadata() for dashboard param sliders"
```

---

### Task 6: Dashboard server — HTTP routes + WebSocket broadcast

**Files:**
- Create: `engine/dashboard/server.ts`
- Test: `engine/__tests__/dashboard/server.test.ts`

This is the core server file. It handles:
- `GET /` → serves index.html
- `GET /api/*` → snapshot data endpoints
- `POST /config/*` → parameter mutation endpoints
- `ws://` → broadcasts engine events to connected dashboard clients

- [ ] **Step 1: Write the test file**

Create `engine/__tests__/dashboard/server.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { DashboardServer } from '../../dashboard/server.js'
import { setParam, getParam, resetParams, exportParamMetadata } from '../../vsm/governanceParams.js'

let server: DashboardServer

beforeAll(() => {
  resetParams()
  server = new DashboardServer({ port: 19161 })
})

afterAll(() => {
  server.stop()
})

describe('HTTP GET routes', () => {
  it('GET / returns HTML', async () => {
    const res = await fetch('http://localhost:19161/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('CynCo Governance Dashboard')
  })

  it('GET /api/params returns param metadata', async () => {
    const res = await fetch('http://localhost:19161/api/params')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data[0]).toHaveProperty('name')
    expect(data[0]).toHaveProperty('min')
    expect(data[0]).toHaveProperty('max')
    expect(data[0]).toHaveProperty('system')
  })

  it('GET /api/governance returns null when no session', async () => {
    const res = await fetch('http://localhost:19161/api/governance')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeNull()
  })

  it('GET /api/contracts returns null when no session', async () => {
    const res = await fetch('http://localhost:19161/api/contracts')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toBeNull()
  })
})

describe('POST /config/governance', () => {
  it('sets valid governance params', async () => {
    const res = await fetch('http://localhost:19161/config/governance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'algedonic.kill_threshold': 10 }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.applied['algedonic.kill_threshold']).toBe(10)
    expect(data.errors).toHaveLength(0)
    expect(getParam('algedonic.kill_threshold')).toBe(10)
  })

  it('rejects out-of-bounds values', async () => {
    const res = await fetch('http://localhost:19161/config/governance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'algedonic.kill_threshold': 999 }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    // Value gets clamped by setParam, so it's applied at the max (20)
    expect(data.applied['algedonic.kill_threshold']).toBe(20)
  })

  it('rejects unknown params', async () => {
    const res = await fetch('http://localhost:19161/config/governance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'fake.param': 5 }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.errors.length).toBeGreaterThan(0)
    expect(data.errors[0].field).toBe('fake.param')
  })
})

describe('POST /config/engine', () => {
  it('rejects temperature out of range', async () => {
    const res = await fetch('http://localhost:19161/config/engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature: 5.0 }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.errors[0].field).toBe('temperature')
  })
})

describe('WebSocket broadcast', () => {
  it('broadcasts events to connected clients', async () => {
    const ws = new WebSocket('ws://localhost:19161/ws')
    const received: any[] = []

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve()
    })

    ws.onmessage = (e) => {
      received.push(JSON.parse(e.data))
    }

    // Broadcast an event
    server.broadcast({ type: 'tool.start', toolId: 'test-1', toolName: 'Read', input: {} } as any)

    // Give it a tick to arrive
    await new Promise(r => setTimeout(r, 50))

    expect(received.length).toBe(1)
    expect(received[0].type).toBe('tool.start')
    expect(received[0].toolName).toBe('Read')

    ws.close()
  })

  it('broadcast is no-op when no clients connected', () => {
    // Should not throw
    server.broadcast({ type: 'tool.start', toolId: 'test-2', toolName: 'Grep', input: {} } as any)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine && bun test __tests__/dashboard/server.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create dashboard server**

Create `engine/dashboard/server.ts`:

```typescript
/**
 * CynCo Governance Dashboard Server
 *
 * Bun.serve on port 9161 — serves the dashboard HTML, broadcasts engine events
 * via WebSocket, and handles config mutations via POST endpoints.
 *
 * This is a passive observer: it receives events from the conversation loop's
 * emit fan-out, not by connecting as a second WS client.
 */

import { join } from 'path'
import { readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import type { EngineEvent } from '../bridge/protocol.js'
import {
  setParam, getParam, exportParamMetadata,
  GOVERNANCE_PARAMS, resetParams as resetGovernanceParams,
} from '../vsm/governanceParams.js'
import { globalContract } from '../tools/contract.js'
import type { Server, ServerWebSocket } from 'bun'

// ─── Types ───────────────────────────────────────────────────────

export interface DashboardDeps {
  /** Get current governance report (null if no session) */
  getGovernanceReport?: () => any
  /** Get prediction statistics (null if no session) */
  getPredictionStats?: () => any
  /** Get the governance instance for pause/resume */
  getGovernance?: () => any
  /** Get the tool scorer for threshold changes */
  getToolScorer?: () => any
  /** Get the S4 reflector for frequency changes */
  getS4Reflector?: () => any
  /** Apply engine config changes */
  applyEngineConfig?: (patches: Record<string, unknown>) => { applied: Record<string, unknown>; errors: { field: string; message: string }[] }
  /** Get/set tool routing */
  setToolRouting?: (enabled: boolean) => void
  getToolRouting?: () => boolean
}

interface DashboardServerOptions {
  port?: number
  deps?: DashboardDeps
}

// ─── Validation ──────────────────────────────────────────────────

const ENGINE_VALIDATORS: Record<string, { min: number; max: number }> = {
  temperature: { min: 0, max: 2 },
  contextLength: { min: 1024, max: 2097152 },
  timeout: { min: 1000, max: 600000 },
  maxOutputTokens: { min: 1, max: 128000 },
}

const SYSTEM_VALIDATORS: Record<string, 'boolean' | { min: number; max: number }> = {
  ablation: 'boolean',
  contractEnforcement: 'boolean',
  s4ReflectionFrequency: { min: 1, max: 20 },
}

const TOOLS_VALIDATORS: Record<string, 'boolean' | { min: number; max: number }> = {
  trustDecayThreshold: { min: 0, max: 1 },
  toolRouting: 'boolean',
}

// ─── Server ──────────────────────────────────────────────────────

export class DashboardServer {
  private server: Server
  private clients = new Set<ServerWebSocket<unknown>>()
  private deps: DashboardDeps
  private port: number

  constructor(opts: DashboardServerOptions = {}) {
    this.port = opts.port ?? 9161
    this.deps = opts.deps ?? {}

    const htmlPath = join(import.meta.dir, 'index.html')
    let html: string
    try {
      html = readFileSync(htmlPath, 'utf-8')
    } catch {
      html = '<html><body><h1>Dashboard HTML not found</h1></body></html>'
    }

    const self = this

    this.server = Bun.serve({
      port: this.port,
      fetch(req, server) {
        const url = new URL(req.url)

        // WebSocket upgrade
        if (url.pathname === '/ws') {
          const success = server.upgrade(req)
          if (success) return undefined
          return new Response('WebSocket upgrade failed', { status: 500 })
        }

        // CORS headers for local development
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }

        if (req.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders })
        }

        // ── GET routes ──
        if (req.method === 'GET') {
          if (url.pathname === '/' || url.pathname === '/index.html') {
            return new Response(html, {
              headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
            })
          }

          if (url.pathname === '/api/governance') {
            const report = self.deps.getGovernanceReport?.() ?? null
            return Response.json(report, { headers: corsHeaders })
          }

          if (url.pathname === '/api/predictions') {
            const stats = self.deps.getPredictionStats?.() ?? null
            return Response.json(stats, { headers: corsHeaders })
          }

          if (url.pathname === '/api/contracts') {
            if (!globalContract.isActive()) {
              return Response.json(null, { headers: corsHeaders })
            }
            return Response.json({
              status: globalContract.getStatus(),
              isComplete: globalContract.isComplete(),
              isActive: globalContract.isActive(),
            }, { headers: corsHeaders })
          }

          if (url.pathname === '/api/params') {
            return Response.json(exportParamMetadata(), { headers: corsHeaders })
          }

          if (url.pathname === '/api/history') {
            const history = self.readAuditHistory()
            return Response.json(history, { headers: corsHeaders })
          }

          return new Response('Not found', { status: 404, headers: corsHeaders })
        }

        // ── POST routes ──
        if (req.method === 'POST') {
          return self.handlePost(url.pathname, req, corsHeaders)
        }

        return new Response('Method not allowed', { status: 405, headers: corsHeaders })
      },
      websocket: {
        open(ws) {
          self.clients.add(ws)
        },
        message(_ws, _message) {
          // Dashboard WS is read-only — ignore incoming messages
        },
        close(ws) {
          self.clients.delete(ws)
        },
      },
    })

    console.log(`[dashboard] Governance dashboard running at http://localhost:${this.port}`)
  }

  /** Broadcast an engine event to all connected dashboard clients. */
  broadcast(event: EngineEvent): void {
    if (this.clients.size === 0) return
    const json = JSON.stringify(event)
    for (const ws of this.clients) {
      try { ws.send(json) } catch {}
    }
  }

  /** Stop the dashboard server. */
  stop(): void {
    this.server.stop()
    this.clients.clear()
  }

  /** Get the port the server is running on. */
  getPort(): number {
    return this.port
  }

  // ── POST handler ──

  private async handlePost(
    pathname: string,
    req: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return Response.json(
        { applied: {}, errors: [{ field: '_body', message: 'Invalid JSON' }] },
        { status: 400, headers: corsHeaders },
      )
    }

    if (pathname === '/config/engine') {
      return this.handleEngineConfig(body, corsHeaders)
    }
    if (pathname === '/config/governance') {
      return this.handleGovernanceConfig(body, corsHeaders)
    }
    if (pathname === '/config/tools') {
      return this.handleToolsConfig(body, corsHeaders)
    }
    if (pathname === '/config/system') {
      return this.handleSystemConfig(body, corsHeaders)
    }

    return new Response('Not found', { status: 404, headers: corsHeaders })
  }

  private handleEngineConfig(
    body: Record<string, unknown>,
    corsHeaders: Record<string, string>,
  ): Response {
    const applied: Record<string, unknown> = {}
    const errors: { field: string; message: string }[] = []

    for (const [field, value] of Object.entries(body)) {
      const validator = ENGINE_VALIDATORS[field]
      if (!validator) {
        errors.push({ field, message: `Unknown engine config field: ${field}` })
        continue
      }
      if (typeof value !== 'number') {
        errors.push({ field, message: `${field} must be a number` })
        continue
      }
      if (value < validator.min || value > validator.max) {
        errors.push({ field, message: `${field} must be between ${validator.min} and ${validator.max}` })
        continue
      }
      applied[field] = value
    }

    // Apply via the engine config handler if provided
    if (Object.keys(applied).length > 0 && this.deps.applyEngineConfig) {
      const result = this.deps.applyEngineConfig(applied)
      return Response.json(result, { headers: corsHeaders })
    }

    const status = errors.length > 0 && Object.keys(applied).length === 0 ? 400 : 200
    return Response.json({ applied, errors }, { status, headers: corsHeaders })
  }

  private handleGovernanceConfig(
    body: Record<string, unknown>,
    corsHeaders: Record<string, string>,
  ): Response {
    const applied: Record<string, unknown> = {}
    const errors: { field: string; message: string }[] = []

    for (const [field, value] of Object.entries(body)) {
      if (typeof value !== 'number') {
        errors.push({ field, message: `${field} must be a number` })
        continue
      }
      if (!GOVERNANCE_PARAMS.has(field)) {
        errors.push({ field, message: `Unknown governance parameter: ${field}` })
        continue
      }
      try {
        setParam(field, value, 'dashboard')
        applied[field] = getParam(field) // Return clamped value
      } catch (e: any) {
        errors.push({ field, message: e.message })
      }
    }

    const status = errors.length > 0 && Object.keys(applied).length === 0 ? 400 : 200
    return Response.json({ applied, errors }, { status, headers: corsHeaders })
  }

  private handleToolsConfig(
    body: Record<string, unknown>,
    corsHeaders: Record<string, string>,
  ): Response {
    const applied: Record<string, unknown> = {}
    const errors: { field: string; message: string }[] = []

    for (const [field, value] of Object.entries(body)) {
      const validator = TOOLS_VALIDATORS[field]
      if (!validator) {
        errors.push({ field, message: `Unknown tools config field: ${field}` })
        continue
      }
      if (validator === 'boolean') {
        if (typeof value !== 'boolean') {
          errors.push({ field, message: `${field} must be a boolean` })
          continue
        }
        if (field === 'toolRouting' && this.deps.setToolRouting) {
          this.deps.setToolRouting(value)
        }
        applied[field] = value
      } else {
        if (typeof value !== 'number') {
          errors.push({ field, message: `${field} must be a number` })
          continue
        }
        if (value < validator.min || value > validator.max) {
          errors.push({ field, message: `${field} must be between ${validator.min} and ${validator.max}` })
          continue
        }
        if (field === 'trustDecayThreshold') {
          this.deps.getToolScorer?.()?.setDemotionThreshold(value)
        }
        applied[field] = value
      }
    }

    const status = errors.length > 0 && Object.keys(applied).length === 0 ? 400 : 200
    return Response.json({ applied, errors }, { status, headers: corsHeaders })
  }

  private handleSystemConfig(
    body: Record<string, unknown>,
    corsHeaders: Record<string, string>,
  ): Response {
    const applied: Record<string, unknown> = {}
    const errors: { field: string; message: string }[] = []

    for (const [field, value] of Object.entries(body)) {
      const validator = SYSTEM_VALIDATORS[field]
      if (!validator) {
        errors.push({ field, message: `Unknown system config field: ${field}` })
        continue
      }
      if (validator === 'boolean') {
        if (typeof value !== 'boolean') {
          errors.push({ field, message: `${field} must be a boolean` })
          continue
        }
        if (field === 'ablation') {
          const gov = this.deps.getGovernance?.()
          if (gov) {
            value ? gov.pause() : gov.resume()
          }
        }
        if (field === 'contractEnforcement') {
          globalContract.setEnforcementEnabled(value)
        }
        applied[field] = value
      } else {
        if (typeof value !== 'number') {
          errors.push({ field, message: `${field} must be a number` })
          continue
        }
        if (value < validator.min || value > validator.max) {
          errors.push({ field, message: `${field} must be between ${validator.min} and ${validator.max}` })
          continue
        }
        if (field === 's4ReflectionFrequency') {
          this.deps.getS4Reflector?.()?.setFrequency(value)
        }
        applied[field] = value
      }
    }

    const status = errors.length > 0 && Object.keys(applied).length === 0 ? 400 : 200
    return Response.json({ applied, errors }, { status, headers: corsHeaders })
  }

  // ── History reader ──

  private readAuditHistory(): any[] {
    const auditDir = join(homedir(), '.cynco', 'audit-log')
    try {
      const eventsFile = join(auditDir, 'events.jsonl')
      const content = readFileSync(eventsFile, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      // Return last 1000 entries
      return lines.slice(-1000).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
    } catch {
      return []
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine && bun test __tests__/dashboard/server.test.ts`
Expected: Most PASS (HTML test will fail until index.html exists — that's fine, we create it in Task 7)

- [ ] **Step 5: Commit**

```bash
git add engine/dashboard/server.ts engine/__tests__/dashboard/server.test.ts
git commit -m "feat: dashboard server — HTTP routes, WS broadcast, config POST handlers"
```

---

### Task 7: Dashboard HTML — the full UI

**Files:**
- Create: `engine/dashboard/index.html`

This is the entire dashboard frontend in a single HTML file. It contains:
- CSS: dark theme (#1e1e1e), panel grid, sliders, toggles, bar charts
- JS: WebSocket connection with auto-reconnect, event handlers that update DOM, fetch for config POSTs, standalone mode fallback
- HTML: 8 monitoring panels (connection, context, governance, S5, tool activity, contracts, predictions) + parameter controls

- [ ] **Step 1: Create the dashboard HTML**

Create `engine/dashboard/index.html` with the complete dashboard UI. The file is large (~800 lines) because it contains all CSS, JS, and HTML inline per the spec requirement of "single HTML file with inline CSS/JS, no build step, no npm dependencies."

The HTML structure:

```
<!DOCTYPE html>
<html>
<head>
  <title>CynCo Governance Dashboard</title>
  <style>
    /* Dark theme: #1e1e1e background, #252525 panels, #4ec9b0 accent */
    /* Two-column grid layout */
    /* Slider styles (teal/orange/blue per category) */
    /* Toggle switch styles */
    /* Bar chart styles (green #4ec9b0, red #f44747) */
    /* Pulse animation for connection indicator */
    /* Panel styles with #3a3a3a borders */
  </style>
</head>
<body>
  <header>CynCo Governance Dashboard</header>

  <!-- Monitoring Grid -->
  <div class="grid">
    <div id="panel-connection">...</div>
    <div id="panel-context">...</div>
    <div id="panel-governance">...</div>
    <div id="panel-s5">...</div>
    <div id="panel-tools" class="full-width">
      <!-- Bar chart container + live feed -->
    </div>
    <div id="panel-contracts">...</div>
    <div id="panel-predictions">...</div>
  </div>

  <!-- Parameter Controls -->
  <div class="controls-grid">
    <div id="ctrl-engine"><!-- temperature, context, timeout sliders --></div>
    <div id="ctrl-system"><!-- toggles + threshold sliders --></div>
  </div>
  <div id="ctrl-advanced">
    <!-- Collapsible: subsystem tabs + param sliders fetched from /api/params -->
  </div>
  <div class="controls-actions">
    <button id="btn-reset">Reset to Defaults</button>
    <button id="btn-apply">Apply Changes</button>
  </div>

  <script>
    // ── State ──
    const state = {
      connected: false, paused: false, sessionActive: false,
      tools: {},          // { toolName: { success: N, failure: N } }
      toolFeed: [],       // last 50 tool events
      s5Decisions: [],    // last 20 S5 decisions
      governance: null,   // latest governance report
      context: null,      // latest context status
      contract: null,     // latest contract state
      predictions: null,  // latest prediction stats
      config: null,       // latest config snapshot
      pendingChanges: {}, // batched slider changes before Apply
      paramMeta: [],      // from /api/params
    }

    // ── WebSocket ──
    let ws = null
    let reconnectDelay = 1000
    const MAX_RECONNECT = 30000

    function connect() {
      ws = new WebSocket(`ws://${location.hostname}:${location.port}/ws`)
      ws.onopen = () => {
        state.connected = true
        reconnectDelay = 1000
        render()
      }
      ws.onclose = () => {
        state.connected = false
        render()
        setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT)
      }
      ws.onmessage = (e) => {
        const event = JSON.parse(e.data)
        handleEvent(event)
      }
    }

    function handleEvent(event) {
      switch (event.type) {
        case 'session.ready':
          state.sessionActive = true
          state.config = event
          break
        case 'governance.status':
          state.governance = event
          break
        case 'context.status':
          state.context = event
          break
        case 'tool.start':
          // Initialize tool counter if needed
          if (!state.tools[event.toolName]) {
            state.tools[event.toolName] = { success: 0, failure: 0 }
          }
          state.toolFeed.unshift({
            time: new Date().toLocaleTimeString(),
            tool: event.toolName,
            input: summarizeInput(event.input),
            status: 'running',
            id: event.toolId,
          })
          if (state.toolFeed.length > 50) state.toolFeed.pop()
          break
        case 'tool.complete':
          // Update bar chart counters
          if (!state.tools[event.toolName]) {
            state.tools[event.toolName] = { success: 0, failure: 0 }
          }
          if (event.isError) {
            state.tools[event.toolName].failure++
          } else {
            state.tools[event.toolName].success++
          }
          // Update feed entry
          const feedEntry = state.toolFeed.find(f => f.id === event.toolId)
          if (feedEntry) {
            feedEntry.status = event.isError ? 'error' : 'success'
          }
          break
        case 's2.decision':
          state.s5Decisions.unshift({
            time: new Date().toLocaleTimeString(),
            decision: event.decision,
            reason: event.reason,
            agentId: event.agentId,
          })
          if (state.s5Decisions.length > 20) state.s5Decisions.pop()
          break
        case 'config.current':
          state.config = event
          break
        case 'config.updated':
          // Merge applied values into config
          break
      }
      render()
    }

    // ── Rendering ──
    // Each panel has a render function that updates its DOM from state.
    // render() calls all of them.

    function render() { /* calls each panel renderer */ }
    function renderConnection() { /* pulse dot, model, session time */ }
    function renderContext() { /* progress bar, token count */ }
    function renderGovernance() { /* health badge, metrics */ }
    function renderS5() { /* decision log list */ }
    function renderTools() { /* bar chart SVG + feed list */ }
    function renderContracts() { /* assertion list */ }
    function renderPredictions() { /* H1-H8 table */ }

    // ── Config Controls ──
    function onSliderChange(field, value) {
      state.pendingChanges[field] = value
    }
    async function applyChanges() {
      // Group by endpoint, POST each
    }
    async function resetDefaults() {
      // Fetch /api/params, reset sliders
    }

    // ── Standalone Mode ──
    // If no session.ready within 2s, fetch /api/history
    setTimeout(() => {
      if (!state.sessionActive) loadHistoricalData()
    }, 2000)

    async function loadHistoricalData() {
      const [history, params] = await Promise.all([
        fetch('/api/history').then(r => r.json()),
        fetch('/api/params').then(r => r.json()),
      ])
      // Populate tool counters from historical data
      // Disable parameter controls
    }

    // ── Init ──
    connect()
    fetch('/api/params').then(r => r.json()).then(meta => {
      state.paramMeta = meta
      renderAdvancedParams()
    })
  </script>
</body>
</html>
```

The implementing agent should write the full HTML file with complete CSS, complete JS event handlers, and complete panel rendering logic. The pseudocode above shows the architecture; all `render*()` functions must actually update the DOM with `innerHTML` or `textContent` assignments based on the current state object.

Key implementation details for the HTML:
- **Bar chart**: Use `<div>` elements with CSS flexbox, not SVG. Each tool gets a column with green/red stacked divs proportional to success/failure counts. Max height normalized to the highest-count tool.
- **Sliders**: `<input type="range">` with `oninput` that updates a `<span>` showing the current value and records the change in `state.pendingChanges`.
- **Toggles**: CSS-only toggle switches using a checkbox + label pattern.
- **Advanced params**: Built dynamically from `/api/params` response — loop over the metadata array, group by `system` field, create tabs and sliders.
- **Auto-reconnect banner**: A `<div>` at the top that shows/hides based on `state.connected`.
- **Tool feed**: A `<div>` with max-height and overflow-y:auto, entries prepended with `insertBefore`.

- [ ] **Step 2: Run the server test that checks for HTML**

Run: `cd engine && bun test __tests__/dashboard/server.test.ts -t "GET / returns HTML"`
Expected: PASS — the server now finds the index.html file

- [ ] **Step 3: Manual browser test**

Run: `cd engine && bun run dashboard/server.ts`
Open: `http://localhost:9161`
Verify: Dark theme loads, panels visible, WebSocket connects (shows "Disconnected" since no engine session), parameter sliders render.

- [ ] **Step 4: Commit**

```bash
git add engine/dashboard/index.html
git commit -m "feat: dashboard HTML — monitoring panels, tool activity bar charts, parameter controls"
```

---

### Task 8: Wire dashboard into engine/main.ts

**Files:**
- Modify: `engine/main.ts:282-322`

Wire the dashboard server into the engine startup and emit fan-out.

- [ ] **Step 1: Add dashboard import and startup**

In `engine/main.ts`, add the import near the top (with other imports):

```typescript
import { DashboardServer } from './dashboard/server.js'
```

After the WS server creation (after line 290), add:

```typescript
// ─── Dashboard Server (Governance UI) ─────────────────────────
let dashboardServer: DashboardServer | null = null
try {
  dashboardServer = new DashboardServer({
    port: (port ?? 9160) + 1001, // default: 9161 if WS is 9160
    deps: {
      getGovernanceReport: () => loop.getGovernanceReport(),
      getPredictionStats: () => loop.getGovernance().getPredictionTracker().getStatistics(),
      getGovernance: () => loop.getGovernance(),
      getToolScorer: () => loop.getExecutor?.()?.getToolScorer?.(),
      getS4Reflector: () => loop.getGovernance().getReflector(),
      applyEngineConfig: (patches) => {
        const { handleConfigUpdate } = require('./bridge/configHandlers.js')
        return handleConfigUpdate(config, patches)
      },
      setToolRouting: (enabled) => {
        const { setRoutingEnabled } = require('./tools/toolRouter.js')
        setRoutingEnabled(enabled)
      },
      getToolRouting: () => {
        const { isRoutingEnabled } = require('./tools/toolRouter.js')
        return isRoutingEnabled()
      },
    },
  })
} catch (e) {
  console.warn('[dashboard] Failed to start dashboard server:', e)
}
```

Note: The `deps` callbacks use lazy references to `loop` because the dashboard server is created before the loop. The callbacks are only called when HTTP requests arrive, by which time `loop` is initialized.

- [ ] **Step 2: Wire emit fan-out**

Modify the emit callback in the ConversationLoop constructor (lines 303-320). Change:

```typescript
    wsServer.emit(event)
```

to:

```typescript
    wsServer.emit(event)
    dashboardServer?.broadcast(event)
```

Also wire the vibe controller emit (around line 354). Change:

```typescript
        wsServer.emit(event as any)
```

to:

```typescript
        wsServer.emit(event as any)
        dashboardServer?.broadcast(event as any)
```

- [ ] **Step 3: Expose getExecutor on ConversationLoop**

The toolScorer lives on the executor (`this.executor.getToolScorer()`), and ConversationLoop has no public `getExecutor()` method. Add one:

In `engine/bridge/conversationLoop.ts`, near the other getter methods (around line 1553, after `getGovernance()`):

```typescript
  getExecutor() {
    return this.executor
  }
```

This lets the dashboard deps access `loop.getExecutor()?.getToolScorer()` for the trust decay threshold control.

- [ ] **Step 4: Test the wiring manually**

```bash
LOCALCODE_MODEL=qwen3:8b bun engine/main.ts
```

Check console output for: `[dashboard] Governance dashboard running at http://localhost:9161`
Open `http://localhost:9161` in browser — should show the dashboard.

- [ ] **Step 5: Commit**

```bash
git add engine/main.ts engine/bridge/conversationLoop.ts
git commit -m "feat: wire dashboard server into engine — emit fan-out + deps injection"
```

---

### Task 9: Integration test — full event flow

**Files:**
- Modify: `engine/__tests__/dashboard/server.test.ts`

Add an integration test that verifies events flow from broadcast to a WS client, and that standalone mode reads audit history.

- [ ] **Step 1: Add integration tests**

Append to `engine/__tests__/dashboard/server.test.ts`:

```typescript
describe('integration: event flow', () => {
  it('governance.status event reaches WS client and updates panels', async () => {
    const ws = new WebSocket('ws://localhost:19161/ws')
    const received: any[] = []

    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    ws.onmessage = (e) => received.push(JSON.parse(e.data))

    server.broadcast({
      type: 'governance.status',
      health: 'healthy',
      s3s4Balance: 'balanced',
      toolSuccessRate: 0.94,
      stuckTurns: 0,
      varietyRatio: 0.72,
      axiomHealth: { holding: 3, total: 3, violations: [] },
    } as any)

    await new Promise(r => setTimeout(r, 50))
    expect(received[0].type).toBe('governance.status')
    expect(received[0].toolSuccessRate).toBe(0.94)

    ws.close()
  })

  it('tool.start + tool.complete flow for bar chart', async () => {
    const ws = new WebSocket('ws://localhost:19161/ws')
    const received: any[] = []

    await new Promise<void>((resolve) => { ws.onopen = () => resolve() })
    ws.onmessage = (e) => received.push(JSON.parse(e.data))

    server.broadcast({ type: 'tool.start', toolId: 'int-1', toolName: 'Edit', input: { file: 'test.ts' } } as any)
    server.broadcast({ type: 'tool.complete', toolId: 'int-1', toolName: 'Edit', result: 'ok', isError: false } as any)

    await new Promise(r => setTimeout(r, 50))
    expect(received).toHaveLength(2)
    expect(received[0].type).toBe('tool.start')
    expect(received[1].isError).toBe(false)

    ws.close()
  })
})

describe('standalone mode', () => {
  it('GET /api/history returns array (empty if no audit files)', async () => {
    const res = await fetch('http://localhost:19161/api/history')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
  })
})
```

- [ ] **Step 2: Run all tests**

Run: `cd engine && bun test __tests__/dashboard/server.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add engine/__tests__/dashboard/server.test.ts
git commit -m "test: dashboard integration tests — event flow and standalone mode"
```

---

### Task 10: Wire check — verify all symbols are connected

**Files:** None (verification only)

Per project rules: every plan's last step must grep for all new symbols and verify they're actually imported/called/used.

- [ ] **Step 1: Verify DashboardServer is imported and used in main.ts**

```bash
cd engine && grep -n "DashboardServer\|dashboardServer" main.ts
```

Expected: import line + construction + broadcast call

- [ ] **Step 2: Verify pause/resume are called from server.ts**

```bash
cd engine && grep -n "\.pause()\|\.resume()\|isPaused" dashboard/server.ts
```

Expected: `gov.pause()`, `gov.resume()` in handleSystemConfig

- [ ] **Step 3: Verify setDemotionThreshold is called from server.ts**

```bash
cd engine && grep -n "setDemotionThreshold\|getDemotionThreshold" dashboard/server.ts tools/toolScorer.ts
```

Expected: called in handleToolsConfig, defined in toolScorer.ts

- [ ] **Step 4: Verify setFrequency is called from server.ts**

```bash
cd engine && grep -n "setFrequency" dashboard/server.ts vsm/s4Reflector.ts
```

Expected: called in handleSystemConfig, defined in s4Reflector.ts

- [ ] **Step 5: Verify exportParamMetadata is imported in server.ts**

```bash
cd engine && grep -n "exportParamMetadata" dashboard/server.ts vsm/governanceParams.ts
```

Expected: imported in server.ts, defined in governanceParams.ts

- [ ] **Step 6: Verify setRoutingEnabled is called from main.ts or server.ts**

```bash
cd engine && grep -n "setRoutingEnabled\|isRoutingEnabled" dashboard/server.ts tools/toolRouter.ts main.ts
```

Expected: defined in toolRouter.ts, called via deps in server.ts or main.ts

- [ ] **Step 7: Verify setEnforcementEnabled is called from server.ts**

```bash
cd engine && grep -n "setEnforcementEnabled\|isEnforcementEnabled" dashboard/server.ts tools/contract.ts
```

Expected: defined in contract.ts, called in server.ts handleSystemConfig

- [ ] **Step 8: Verify broadcast is called in emit chain**

```bash
cd engine && grep -n "dashboardServer.*broadcast\|\.broadcast(" main.ts
```

Expected: `dashboardServer?.broadcast(event)` in the emit callback

- [ ] **Step 9: Run full test suite**

```bash
cd engine && bun test
```

Expected: All existing tests still pass + new dashboard tests pass

- [ ] **Step 10: Commit final state (if any fixups needed)**

```bash
git add -A && git commit -m "fix: wire check fixups for governance dashboard"
```

Only commit this step if fixups were required. If everything passed, skip.
