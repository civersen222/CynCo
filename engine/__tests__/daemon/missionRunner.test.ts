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
  commands: { lineup: 'Produce a full suggested starting lineup for {week}.' },
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
      fetchRosterSnapshot: async (_league: string, _year: number, franchise: string) => `roster-for-${franchise}`,
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

  it('task context carries goal, roster snapshot, and last 3 run summaries in handoff format (spec §3/§4)', async () => {
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.recordRun({ ts: '2026-06-10T08:00:00Z', triggerId: 'news', ok: true, summary: 'old run A', recommendationIds: [] })
    ledger.recordRun({ ts: '2026-06-10T10:00:00Z', triggerId: 'news', ok: false, summary: 'old run B', recommendationIds: [] })
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    const ctx = ranTasks[0].context as string
    // Handoff YAML format (engine/memory/handoff.ts)
    expect(ctx).toContain('goal: Win the league')
    expect(ctx).toContain('status: in_progress')
    expect(ctx).toContain('what_was_done:')
    expect(ctx).toContain('old run A')
    expect(ctx).toContain('FAILED: old run B')
    // Roster snapshot per league, fetched by the daemon (no inference)
    expect(ctx).toContain('franchise 0005')
    expect(ctx).toContain('roster-for-0005')
  })

  it('roster snapshot fetch failure does not block the run', async () => {
    const { deps, ranTasks } = makeDeps({
      fetchRosterSnapshot: async () => { throw new Error('MFL down') },
    })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].context).toContain('roster unavailable')
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

  it('GPU busy defers with escalating backoff: 5 → 10 → 20 min, no failure recorded (spec §2/§7)', async () => {
    const { GpuBusyError } = await import('../../daemon/taskRunner.js')
    const { deps } = makeDeps({ runTask: async () => { throw new GpuBusyError() } })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    const expected = [5, 10, 20]
    for (const minutes of expected) {
      ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
      ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
      await runner.tick()
      expect(ledger.state.failureStreak).toBe(0)
      const next = new Date(ledger.state.nextFire['news'])
      expect(next.getTime()).toBe(deps.now().getTime() + minutes * 60000)
    }
  })

  it('GPU backoff caps at 60 min and resets after a successful run', async () => {
    const { GpuBusyError } = await import('../../daemon/taskRunner.js')
    let busy = true
    const { deps } = makeDeps({
      runTask: async (): Promise<TaskOutcome> => {
        if (busy) throw new GpuBusyError()
        return { ok: true, summary: 'ran', recommendations: [] }
      },
    })
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    // Drive past the cap: 5,10,20,40,60,60
    for (let i = 0; i < 6; i++) {
      ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
      ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
      await runner.tick()
    }
    expect(new Date(ledger.state.nextFire['news']).getTime()).toBe(deps.now().getTime() + 60 * 60000)
    // Successful run resets the backoff
    busy = false
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    await runner.tick()
    busy = true
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    await runner.tick()
    expect(new Date(ledger.state.nextFire['news']).getTime()).toBe(deps.now().getTime() + 5 * 60000)
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
    const handled = await runner.handleCommand({ kind: 'approval', recId: 'rec-7', verdict: 'approve' })
    expect(handled).toBe(true)
    expect(ledger.state.pending['rec-7']).toBeUndefined()
    const promo = published.find((p) => p.title?.match(/promot/i))
    expect(promo).toBeDefined()
  })

  it('handleCommand returns false for an unknown recId', async () => {
    const { deps } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    const runner = new MissionRunner(ledger, deps as any)
    expect(await runner.handleCommand({ kind: 'approval', recId: 'nope', verdict: 'approve' })).toBe(false)
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

describe('MissionRunner text commands + on-demand queue', () => {
  function freshRunner(overrides: Partial<any> = {}) {
    const made = makeDeps(overrides)
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    // Park both scheduled triggers in the future so only on-demand work fires
    ledger.setNextFire('news', new Date(2026, 5, 12).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    return { ...made, ledger, runner: new MissionRunner(ledger, made.deps as any) }
  }

  it('handleTextCommand("lineup") queues a request and publishes an ack', async () => {
    const { runner, published, ranTasks } = freshRunner()
    await runner.handleTextCommand('lineup')
    expect(ranTasks.length).toBe(0) // never runs a model from the command handler
    expect(published.length).toBe(1)
    expect(published[0].title).toMatch(/queued/i)
    expect(published[0].message).toContain('upcoming week')
  })

  it('handleTextCommand("lineup 5") parses the week; tick drains it through the fire path', async () => {
    const { runner, ranTasks } = freshRunner()
    await runner.handleTextCommand('lineup 5')
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].triggerId).toBe('on-demand-lineup')
    expect(ranTasks[0].prompt).toBe('Produce a full suggested starting lineup for week 5.')
    // Drained: a second tick must not re-run it
    await runner.tick()
    expect(ranTasks.length).toBe(1)
  })

  it('"lineup" without a week substitutes "the upcoming week" into the template', async () => {
    const { runner, ranTasks } = freshRunner()
    await runner.handleTextCommand('LINEUP') // case-insensitive
    await runner.tick()
    expect(ranTasks[0].prompt).toBe('Produce a full suggested starting lineup for the upcoming week.')
  })

  it('unknown text publishes help and queues nothing', async () => {
    const { runner, published, ranTasks } = freshRunner()
    await runner.handleTextCommand('make me a sandwich')
    await runner.tick()
    expect(ranTasks.length).toBe(0)
    expect(published.length).toBe(1)
    expect(published[0].message).toMatch(/lineup/)
  })

  it('missing commands.lineup template publishes an error and queues nothing', async () => {
    // Rewrite mission.json without commands, reload
    const noCmd = { ...config, commands: undefined }
    writeFileSync(join(dir, 'mfl-dynasty', 'mission.json'), JSON.stringify(noCmd), 'utf-8')
    const { runner, published, ranTasks } = freshRunner()
    await runner.handleTextCommand('lineup')
    await runner.tick()
    expect(ranTasks.length).toBe(0)
    expect(published[0].title).toMatch(/unavailable/i)
  })

  it('GPU busy keeps the request queued with a retry-at backoff, then runs when free', async () => {
    const { GpuBusyError } = await import('../../daemon/taskRunner.js')
    let busy = true
    let nowMs = new Date(2026, 5, 11, 12, 0, 0).getTime()
    const { runner, ranTasks } = freshRunner({
      runTask: async (input: any): Promise<TaskOutcome> => {
        if (busy) throw new GpuBusyError()
        ranTasks.push(input)
        return { ok: true, summary: 'ran', recommendations: [] }
      },
      now: () => new Date(nowMs),
    })
    await runner.handleTextCommand('lineup')
    await runner.tick() // GPU busy → deferred, still queued
    expect(ranTasks.length).toBe(0)
    await runner.tick() // before retry-at → still waiting, no run attempt
    expect(ranTasks.length).toBe(0)
    busy = false
    nowMs += 6 * 60000 // past the 5-min base defer
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].triggerId).toBe('on-demand-lineup')
  })

  it('on-demand outcome with recommendations publishes them as pending', async () => {
    const { runner, ledger, published } = freshRunner()
    await runner.handleTextCommand('lineup')
    await runner.tick()
    // makeDeps default runTask returns rec-1
    expect(ledger.state.pending['rec-1']).toBeDefined()
    const recPublish = published.find((p) => p.id === 'rec-1')
    expect(recPublish).toBeDefined()
  })
})

describe('MissionRunner taskType plumbing', () => {
  it('trade-scan triggers get a 60-minute timeout and taskType/leagues passthrough', async () => {
    const scanConfig: MissionConfig = {
      ...config,
      triggers: [{ id: 'trade-scan', kind: 'weekly', day: 'tue', at: '09:00', precheck: 'none', missedPolicy: 'skip', prompt: 'Rank trades', taskType: 'trade-scan' }],
    }
    writeFileSync(join(dir, 'mfl-dynasty', 'mission.json'), JSON.stringify(scanConfig), 'utf-8')
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('trade-scan', new Date(2026, 5, 11, 11, 59).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks.length).toBe(1)
    expect(ranTasks[0].taskType).toBe('trade-scan')
    expect(ranTasks[0].timeoutMs).toBe(60 * 60 * 1000)
    expect(ranTasks[0].leagues).toEqual([{ leagueId: '12345', year: 2026, franchiseId: '0005' }])
  })

  it('plain prompt triggers keep the 15-minute timeout and carry leagues', async () => {
    const { deps, ranTasks } = makeDeps()
    const ledger = MissionLedger.load(join(dir, 'mfl-dynasty'))
    ledger.setNextFire('news', new Date(2026, 5, 11, 11, 59).toISOString())
    ledger.setNextFire('poll', new Date(2026, 5, 12).toISOString())
    const runner = new MissionRunner(ledger, deps as any)
    await runner.tick()
    expect(ranTasks[0].timeoutMs).toBe(15 * 60 * 1000)
    expect(ranTasks[0].taskType).toBeUndefined()
    expect(ranTasks[0].leagues).toEqual([{ leagueId: '12345', year: 2026, franchiseId: '0005' }])
  })
})
