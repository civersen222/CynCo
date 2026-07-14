import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resetEventBus } from '../../vsm/eventBus.js'
import { globalContract } from '../../tools/contract.js'

describe('snapshot undo stack (P1.4)', () => {
  let tempDir = ''
  const events: any[] = []

  beforeEach(() => {
    delete process.env._ABLATION_VSM_DISABLED
    resetEventBus()
    globalContract.clear()
    globalContract.setEnforcementEnabled(false)
    events.length = 0
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cynco-undo-'))
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'original content\n')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 })
  })

  async function makeLoop() {
    const { ConversationLoop } = await import('../../bridge/conversationLoop.js')
    // Mock provider: never called in this test — throw loudly if it is.
    const provider: any = {
      name: 'mock',
      async healthCheck() { return true },
      async listModels() { return [] },
      async probeCapabilities() {
        return { tier: 'advanced', toolUse: 'native', thinking: 'none', vision: false, jsonMode: true, contextLength: 32768, streaming: true }
      },
      async complete() { throw new Error('unexpected provider call') },
      async *stream(): AsyncGenerator<any> { throw new Error('unexpected provider call') },
    }
    const config: any = {
      baseUrl: 'http://localhost:11434', model: 'test', tier: 'auto',
      temperature: 0.7, maxOutputTokens: 8192, timeout: 120000,
      contextLength: 131072, noScouts: true, approveAll: true,
    }
    // cwd: tempDir — the constructor initSnapshot()s its cwd; without this it
    // would stage the repo root into the live .cynco-snapshots/ (P1.4 hazard fix).
    return new ConversationLoop({ cwd: tempDir, config, provider, emit: (e: any) => events.push(e) })
  }

  it('track-after-batch pushes an undo entry and emits snapshot.taken; undoLastBatch restores and emits snapshot.restored', async () => {
    const loop: any = await makeLoop()

    // Simulate a model write batch
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'modified by model\n')
    loop['trackSnapshotAfterBatch']()

    const taken = events.filter((e) => e.type === 'snapshot.taken')
    expect(taken.length).toBe(1)
    expect(taken[0].filesChanged).toBe(1)
    expect(typeof taken[0].hash).toBe('string')
    expect(typeof taken[0].prevHash).toBe('string')
    expect(taken[0].hash).not.toBe(taken[0].prevHash)

    const result = loop.undoLastBatch()
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(tempDir, 'file.txt'), 'utf8')).toBe('original content\n')
    const restored = events.filter((e) => e.type === 'snapshot.restored')
    expect(restored.length).toBe(1)
    expect(restored[0].hash).toBe(taken[0].prevHash)
  })

  it('no-change batches emit nothing and undo on empty stack refuses politely', async () => {
    const loop: any = await makeLoop()
    loop['trackSnapshotAfterBatch']() // nothing changed
    expect(events.filter((e) => e.type === 'snapshot.taken').length).toBe(0)

    const result = loop.undoLastBatch()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/[Nn]othing to undo/)
  })

  it('undo is stackable: two batches undo in reverse order', async () => {
    const loop: any = await makeLoop()

    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'v2\n')
    loop['trackSnapshotAfterBatch']()
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'v3\n')
    loop['trackSnapshotAfterBatch']()

    // The two snapshot.taken events must chain: batch 2's prevHash is batch 1's hash.
    const taken = events.filter((e) => e.type === 'snapshot.taken')
    expect(taken.length).toBe(2)
    expect(taken[1].prevHash).toBe(taken[0].hash)

    expect(loop.undoLastBatch().ok).toBe(true)
    expect(fs.readFileSync(path.join(tempDir, 'file.txt'), 'utf8')).toBe('v2\n')
    expect(loop.undoLastBatch().ok).toBe(true)
    expect(fs.readFileSync(path.join(tempDir, 'file.txt'), 'utf8')).toBe('original content\n')
    expect(loop.undoLastBatch().ok).toBe(false)
  })
})
