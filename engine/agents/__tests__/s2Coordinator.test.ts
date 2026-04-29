import { describe, test, expect, beforeEach } from 'bun:test'
import { S2Coordinator } from '../s2Coordinator.js'
import type { SubAgentStatus } from '../types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStatus(overrides: Partial<SubAgentStatus> = {}): SubAgentStatus {
  return {
    id: 'scout-abc123',
    persona: 'scout',
    task: 'scan codebase',
    state: 'queued',
    currentTurn: 0,
    maxTurns: 20,
    tokensUsed: 0,
    startTime: Date.now(),
    ...overrides,
  }
}

function makeCoordinator(gpuUtil: number, opts: { low?: number; high?: number } = {}) {
  return new S2Coordinator({
    pollGpuUtil: async () => gpuUtil,
    gpuLowThreshold: opts.low,
    gpuHighThreshold: opts.high,
  })
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

describe('S2Coordinator — scheduling', () => {
  test('schedules run when GPU < 60%', async () => {
    const s2 = makeCoordinator(0.45)
    const decision = await s2.requestSchedule('scout-abc123')

    expect(decision.decision).toBe('run')
    expect(decision.type).toBe('schedule')
    expect(decision.agentId).toBe('scout-abc123')
    expect(decision.input.gpuUtil).toBe(0.45)
  })

  test('queues when GPU 60-85% with running agents', async () => {
    const s2 = makeCoordinator(0.70)
    // Register a running agent first so the medium-zone bypass does not apply
    s2.registerAgent(makeStatus({ id: 'scout-running', state: 'running' }))
    const decision = await s2.requestSchedule('scout-abc123')

    expect(decision.decision).toBe('queue')
    expect(decision.type).toBe('schedule')
  })

  test('queues when GPU > 85% with running agents', async () => {
    const s2 = makeCoordinator(0.90)
    s2.registerAgent(makeStatus({ id: 'scout-running', state: 'running' }))
    const decision = await s2.requestSchedule('scout-abc123')

    expect(decision.decision).toBe('queue')
    expect(decision.type).toBe('schedule')
  })

  test('allows first agent even in medium zone when no running agents', async () => {
    const s2 = makeCoordinator(0.72)
    // No running agents — bypass should apply
    const decision = await s2.requestSchedule('scout-abc123')

    expect(decision.decision).toBe('run')
  })

  test('allows first agent even in high zone when no running agents', async () => {
    const s2 = makeCoordinator(0.88)
    const decision = await s2.requestSchedule('scout-abc123')

    expect(decision.decision).toBe('run')
  })

  test('records gpuUtil and queueDepth in decision input', async () => {
    const s2 = makeCoordinator(0.50)
    s2.registerAgent(makeStatus({ id: 'q1', state: 'queued' }))
    s2.registerAgent(makeStatus({ id: 'q2', state: 'queued' }))
    const decision = await s2.requestSchedule('scout-abc123')

    expect(decision.input.gpuUtil).toBe(0.50)
    expect(decision.input.queueDepth).toBe(2)
  })

  test('records decisions for training data', async () => {
    const s2 = makeCoordinator(0.30)
    await s2.requestSchedule('scout-a')
    await s2.requestSchedule('scout-b')

    const state = s2.getState()
    expect(state.decisions.length).toBe(2)
    expect(state.decisions[0].type).toBe('schedule')
    expect(state.decisions[1].type).toBe('schedule')
    expect(typeof state.decisions[0].timestamp).toBe('number')
  })
})

// ─── Agent lifecycle ──────────────────────────────────────────────────────────

describe('S2Coordinator — agent lifecycle', () => {
  test('tracks active agents after register', () => {
    const s2 = makeCoordinator(0.50)
    const status = makeStatus({ id: 'scout-lifecycle', state: 'running' })
    s2.registerAgent(status)

    const state = s2.getState()
    expect(state.activeAgents.has('scout-lifecycle')).toBe(true)
    expect(state.activeAgents.get('scout-lifecycle')!.state).toBe('running')
  })

  test('removes agent on complete', () => {
    const s2 = makeCoordinator(0.50)
    s2.registerAgent(makeStatus({ id: 'scout-done', state: 'running' }))
    s2.completeAgent('scout-done')

    const state = s2.getState()
    expect(state.activeAgents.has('scout-done')).toBe(false)
  })

  test('removes agent on kill', () => {
    const s2 = makeCoordinator(0.50)
    s2.registerAgent(makeStatus({ id: 'scout-kill', state: 'running' }))
    s2.killAgent('scout-kill')

    const state = s2.getState()
    expect(state.activeAgents.has('scout-kill')).toBe(false)
  })

  test('updateAgentTurn updates turn and tokens', () => {
    const s2 = makeCoordinator(0.50)
    s2.registerAgent(makeStatus({ id: 'scout-update', state: 'running' }))
    s2.updateAgentTurn('scout-update', 3, 512)

    const state = s2.getState()
    const agent = state.activeAgents.get('scout-update')!
    expect(agent.currentTurn).toBe(3)
    expect(agent.tokensUsed).toBe(512)
  })

  test('getRunningCount returns correct count', () => {
    const s2 = makeCoordinator(0.50)
    s2.registerAgent(makeStatus({ id: 'a1', state: 'running' }))
    s2.registerAgent(makeStatus({ id: 'a2', state: 'running' }))
    s2.registerAgent(makeStatus({ id: 'a3', state: 'queued' }))

    expect(s2.getRunningCount()).toBe(2)
  })

  test('getQueuedCount returns correct count', () => {
    const s2 = makeCoordinator(0.50)
    s2.registerAgent(makeStatus({ id: 'b1', state: 'queued' }))
    s2.registerAgent(makeStatus({ id: 'b2', state: 'queued' }))
    s2.registerAgent(makeStatus({ id: 'b3', state: 'running' }))

    expect(s2.getQueuedCount()).toBe(2)
  })
})

// ─── Algedonic routing ────────────────────────────────────────────────────────

describe('S2Coordinator — algedonic routing', () => {
  test('absorbs when agent has budget remaining', () => {
    const s2 = makeCoordinator(0.50)
    // agent has used 500 / 8192 tokens — well within budget
    s2.registerAgent(makeStatus({ id: 'scout-stuck', state: 'running', tokensUsed: 500, maxTurns: 20, currentTurn: 2 }))
    const decision = s2.handleAlgedonic('scout-stuck', 'STUCK')

    expect(decision.decision).toBe('absorb')
    expect(decision.type).toBe('algedonic')
    expect(decision.input.signal).toBe('STUCK')
  })

  test('escalates when severely stuck (5+ turns without progress)', () => {
    const s2 = makeCoordinator(0.50)
    // near max turns but not near token budget
    s2.registerAgent(makeStatus({ id: 'scout-escalate', state: 'running', tokensUsed: 500, maxTurns: 10, currentTurn: 8 }))
    const decision = s2.handleAlgedonic('scout-escalate', 'STUCK')

    expect(decision.decision).toBe('escalate')
  })

  test('kills when agent near budget limit', () => {
    const s2 = makeCoordinator(0.50)
    // 19/20 turns used — near budget limit
    s2.registerAgent(makeStatus({ id: 'scout-budget', state: 'running', tokensUsed: 500, maxTurns: 20, currentTurn: 19 }))
    const decision = s2.handleAlgedonic('scout-budget', 'STUCK')

    expect(decision.decision).toBe('kill')
  })

  test('algedonic decision recorded in state', () => {
    const s2 = makeCoordinator(0.50)
    s2.registerAgent(makeStatus({ id: 'scout-rec', state: 'running', tokensUsed: 100, maxTurns: 20, currentTurn: 1 }))
    s2.handleAlgedonic('scout-rec', 'FAIL')

    const state = s2.getState()
    const algDecisions = state.decisions.filter(d => d.type === 'algedonic')
    expect(algDecisions.length).toBe(1)
    expect(algDecisions[0].input.signal).toBe('FAIL')
  })
})

// ─── drainQueue ───────────────────────────────────────────────────────────────

describe('S2Coordinator — drainQueue', () => {
  test('promotes queued agent to running when GPU is low', async () => {
    const s2 = makeCoordinator(0.40)
    s2.registerAgent(makeStatus({ id: 'drain-1', state: 'queued' }))
    s2.registerAgent(makeStatus({ id: 'drain-2', state: 'queued' }))

    const promoted = await s2.drainQueue()
    // Both should be promotable at 40% GPU
    expect(promoted.length).toBeGreaterThan(0)
    // Promoted agents should now be running
    const state = s2.getState()
    for (const id of promoted) {
      expect(state.activeAgents.get(id)!.state).toBe('running')
    }
  })

  test('returns empty array when GPU is high and running agents exist', async () => {
    const s2 = makeCoordinator(0.91)
    s2.registerAgent(makeStatus({ id: 'running-1', state: 'running' }))
    s2.registerAgent(makeStatus({ id: 'queued-1', state: 'queued' }))

    const promoted = await s2.drainQueue()
    expect(promoted).toEqual([])
  })
})
