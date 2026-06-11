// engine/__tests__/daemon/integration.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MissionLedger } from '../../daemon/missionLedger.js'
import { MissionRunner } from '../../daemon/missionRunner.js'
import { NtfyChannel } from '../../daemon/ntfyChannel.js'
import { TaskRunner } from '../../daemon/taskRunner.js'
import type { MissionConfig } from '../../daemon/types.js'

const STUB = join(import.meta.dirname, 'fixtures', 'stubEngine.mjs')

// Reuse the mock ntfy pattern from ntfyChannel.test.ts
function startMockNtfy(): Promise<{ url: string; captured: any[]; sendSse: (d: object) => void; close: () => Promise<void> }> {
  const captured: any[] = []
  let sseRes: http.ServerResponse | null = null
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.endsWith('/sse')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': connected\n\n')
        sseRes = res
        return
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        captured.push(body ? JSON.parse(body) : null)
        res.writeHead(200).end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      captured,
      sendSse: (d) => { sseRes?.write(`data: ${JSON.stringify(d)}\n\n`) },
      close: () => new Promise((r) => { sseRes?.end(); server.close(() => r()) }),
    }))
  })
}

let cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups.reverse()) await c(); cleanups = [] })

describe('liveness layer end-to-end', () => {
  it('trigger → delta → engine run → recommendation push → phone approval → trust streak', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-e2e-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const mock = await startMockNtfy()
    cleanups.push(mock.close)

    const config: MissionConfig = {
      id: 'e2e', goal: 'win', leagues: [{ leagueId: '12345', year: 2026, franchiseId: '0001' }],
      triggers: [{ id: 'poll', kind: 'interval', everyMinutes: 60, precheck: 'mfl-delta', missedPolicy: 'skip', prompt: 'check stuff' }],
      trustLadder: { waiver: { mode: 'ask', promoteAt: 1 } },
    }
    const missionDir = join(dir, 'e2e')
    mkdirSync(missionDir)
    writeFileSync(join(missionDir, 'mission.json'), JSON.stringify(config), 'utf-8')

    const ledger = MissionLedger.load(missionDir)
    ledger.setNextFire('poll', new Date(Date.now() - 1000).toISOString()) // due now
    const ntfy = new NtfyChannel({ baseUrl: mock.url, alertTopic: 'cynco-alerts', commandTopic: 'cynco-commands' })
    const taskRunner = new TaskRunner({
      workDir: join(missionDir, 'tasks'),
      spawnCmd: [process.execPath, STUB],
      isGpuBusyImpl: async () => false,
    })
    const runner = new MissionRunner(ledger, {
      runTask: (input) => taskRunner.run(input),
      publish: (p) => ntfy.publish(p),
      publishRecommendation: (rec) => ntfy.publishRecommendation(rec),
      fetchMflSnapshot: async () => 'delta-hash', // differs from empty lastSeen → fires
      now: () => new Date(),
    })

    // 1. Tick: fires, stub engine runs, recommendation published
    await runner.tick()
    expect(ledger.recentRuns(5).length).toBe(1)
    expect(ledger.recentRuns(5)[0].ok).toBe(true)
    expect(ledger.state.pending['rec-stub']).toBeDefined()
    const recPush = mock.captured.find((c) => c?.actions?.length === 2)
    expect(recPush).toBeDefined()
    expect(recPush.title).toContain('Claim X')

    // 2. Phone approval arrives over SSE → trust streak + promotion (promoteAt: 1)
    const stop = ntfy.subscribe(async (cmd) => { await runner.handleCommand(cmd) })
    cleanups.push(stop)
    await new Promise((r) => setTimeout(r, 300)) // SSE connect
    mock.sendSse({ message: JSON.stringify({ recId: 'rec-stub', verdict: 'approve' }) })
    await new Promise((r) => setTimeout(r, 500))

    expect(ledger.state.pending['rec-stub']).toBeUndefined()
    expect(ledger.state.trust.waiver.approvedStreak).toBe(1)
    const promo = mock.captured.find((c) => c?.title?.match(/promot/i))
    expect(promo).toBeDefined()

    // 3. Second tick with unchanged snapshot → engine NOT spawned again
    ledger.setNextFire('poll', new Date(Date.now() - 1000).toISOString())
    await runner.tick()
    expect(ledger.recentRuns(5).length).toBe(1) // still one run
  }, 30000)
})
