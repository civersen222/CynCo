import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const loop = readFileSync('engine/bridge/conversationLoop.ts', 'utf-8')
const main = readFileSync('engine/main.ts', 'utf-8')

describe('brain wiring (static)', () => {
  it('conversationLoop feeds ThinkingRecorder on thinking deltas', () => {
    expect(loop).toMatch(/thinkingRecorder\?\.onThinkingDelta/)
    expect(loop).toMatch(/thinkingRecorder\?\.finalizeTurn/)
  })
  it('conversationLoop observes uncertainty on both delta kinds', () => {
    expect(loop.match(/observeUncertainty\(/g)!.length).toBeGreaterThanOrEqual(3) // 2 call sites + def
  })
  it('brain.uncertainty goes through dashboardBroadcast, not this.emit (protocol guard)', () => {
    expect(loop).toMatch(/dashboardBroadcast\(\{ type: 'brain\.uncertainty'/)
    expect(loop).not.toMatch(/emit\(\{\s*type: 'brain\./)
  })
  it('main.ts passes dashboardBroadcast to the loop', () => {
    expect(main).toMatch(/dashboardBroadcast/)
  })
  it('brain state resets at model-call start and recorder follows resume()', () => {
    expect(loop).toMatch(/resetBrainTurnState\(\)/)
    expect(loop.match(/new ThinkingRecorder\(/g)!.length).toBeGreaterThanOrEqual(2) // init + resume
  })
})
