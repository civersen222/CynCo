// engine/__tests__/daemon/missionRunner.test.ts
import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MissionRunner } from '../../daemon/missionRunner.js'
import { MissionLedger } from '../../daemon/missionLedger.js'
import type { MissionConfig, TaskOutcome, Recommendation } from '../../daemon/types.js'

const config: MissionConfig = {
  id: 'mfl-dynasty',
  goal: 'Win the league',
  leagues: [{ leagueId: '12345', year: 2026, franchiseId: '0005' }],
  triggers: [
    { id: 'poll', kind: 'interval', everyMinutes: 60, precheck: 'mfl-delta', missedPolicy: 'skip', prompt: 'Check transactions' },
    { id: 'news', kind: 'interval', everyMinutes: 120, precheck: 'none', missedPolicy: 'skip', prompt: 'Check news' },
  ],
  trustLadder: { waiver: { mode: 'ask', promoteAt: 2 } },
}

function makeDeps(overrides: Partial<any> = {}) {
  const published: any[] = []
  const ranTasks: any[] = []
  return {
    published,
    ranTasks,
    deps: {
      runTask: async (input: any): Promise<TaskOutcome> => {
        ranTasks.push(input)
        return {
          ok: true, summary: 'found stuff',
          recommendations: [{ id: 'rec-1', actionType: 'waiver', summary: 'Claim X', detail: 'why' } as Recommendation],
        }
      },
      publish: async (p: any) => { published.push(p); return true },
      publishRecommendation: async (r: Recommendation) => { published.push(r); return true },
      fetchMflSnapshot: async (_league: string, _year: number) => 'hash-1',
      now: () => new Date(2026, 5, 11, 12, 0, 0),
      ...overrides,
    },
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cynco-mr-'))
  mkdirSync(join(dir, 'mfl-dynasty'))
  writeFileSync(join(dir, 'mfl-dynasty', 'mission.json'), JSON.stringify(config), 'utf-8')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('MissionRunner.tick', () => {
  it('initializes nextFire on first tick without firing', async () => {
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(0)
    expect(ledger.state.nextFire['poll']).toBeDefined()
  })

  it('fires a due trigger, records the run, publishes recommendations as pending', async () => {
    const { deps, ranTasks, published } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString()) // not due
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].triggerId).toBe('news')
    expect(published.length).toBe(1) // the recommendation
    expect(ledger.state.pending['rec-1']).toBeDefined()
    expect(ledger.recentRuns(5).length).toBe(1)
    // nextFire advanced
    expect(new Date(ledger.state.nextFire['news']).getTime()).toBeGreaterThan(deps.now().getTime())
  })

  it('mfl-delta precheck: skips the engine when the snapshot is unchanged', async () => {
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setLastSeen('12345', 'hash-1') // matches fetchMflSnapshot
    ledger.setNextFire('poll', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('news', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(0)
    // nextFire still advanced (we checked, found nothing)
    expect(new Date(ledger.state.nextFire['poll']).getTime()).toBeGreaterThan(deps.now().getTime())
  })

  it('mfl-delta precheck: fires when the snapshot changed and updates lastSeen', async () => {
    const { deps, ranTasks } = makeDeps({ fetchMflSnapshot: async () => 'hash-2' })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setLastSeen('12345', 'hash-1')
    ledger.setNextFire('poll', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('news', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ledger.state.lastSeen['12345']).toBe('hash-2')
  })

  it('GPU busy defers: nextFire pushed 10 minutes, no failure recorded', async () => {
    const { GpuBusyError } = await import('../../daemon/taskRunner.js')
    const { deps, ranTasks } = makeDeps({ runTask: async () => { throw new GpuBusyError() } })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ledger.state.failureStreak).toBe(0)
    const next = new Date(ledger.state.nextFire['news'])
    expect(next.getTime()).toBe(deps.now().getTime() + 10 * 60000)
  })

  it('3 consecutive failures publish an algedonic alert', async () => {
    const { deps, published } = makeDeps({
      runTask: async (): Promise<TaskOutcome> => ({ ok: false, summary: '', recommendations: [], error: 'boom' }),
    })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    for (let i = 0; i < 3; i++) {
      ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
      ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
      await runner.tick()
    }
    expect(ledger.state.failureStreak).toBe(3)
    const alert = published.find((p) => p.title?.match(/stuck/i))
    expect(alert).toBeDefined()
  })

  it('handleCommand resolves approval and confirms via publish; promotion proposal at threshold', async () => {
    const { deps, published } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    ledger.state.trust.waiver.approvedStreak = 1 // promoteAt: 2 → next approve hits it
    ledger.addPending({ id: 'rec-7', actionType: 'waiver', summary: 'Claim Z', detail: 'd' })
    const handled = await runner.handleCommand({ recId: 'rec-7', verdict: 'approve' })
    expect(handled).toBe(true)
    expect(ledger.state.pending['rec-7']).toBeUndefined()
    const promo = published.find((p) => p.title?.match(/promot/i))
    expect(promo).toBeDefined()
  })

  it('handleCommand returns false for an unknown recId', async () => {
    const { deps } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    expect(await runner.handleCommand({ recId: 'nope', verdict: 'approve' })).toBe(false)
  })

  it('persists nextFire to disk before firing — a crash mid-run cannot re-fire', async () => {
    const missionDir = join(dir, 'mfl-dynasty')
    let nextFireOnDiskAtRunTime: string | undefined
    const { deps, ranTasks } = makeDeps({
      runTask: async (input: any): Promise<TaskOutcome> => {
        ranTasks.push(input)
        // Reload from disk while the run is in flight
        nextFireOnDiskAtRunTime = MissionLedger.load(missionDir).state.nextFire['news']
        return { ok: true, summary: 'ok', recommendations: [] }
      },
    })
    const ledger = MissionLedger.load(missionDir)
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    ledger.saveState()
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(nextFireOnDiskAtRunTime).toBeDefined()
    expect(new Date(nextFireOnDiskAtRunTime!).getTime()).toBeGreaterThan(deps.now().getTime())
  })

  it('Fix 1: pending is on disk even when publishRecommendation throws', async () => {
    // publishRecommendation throws to simulate a crash/network failure after saveState
    const throwingPublishRec = async (_rec: Recommendation): Promise<boolean> => {
      throw new Error('ntfy network error')
    }
    const { deps } = makeDeps({ publishRecommendation: throwingPublishRec })
    const missionDir = join(dir, 'mfl-dynasty')
    const ledger = MissionLedger.load(missionDir)
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)

    // tick() → fire() → publishRecommendation throws; the throw may propagate — we don't care
    try {
      await runner.tick()
    } catch {
      // acceptable: what matters is the on-disk state, not whether the exception escapes
    }

    // Re-load ledger from disk to verify saveState ran BEFORE the publish
    const reloaded = MissionLedger.load(missionDir)
    expect(reloaded.state.pending['rec-1']).toBeDefined()
  })
})
