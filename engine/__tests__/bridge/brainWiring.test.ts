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

describe('brain.toolUncertainty wiring (static)', () => {
  it('observeUncertainty accepts tool kind — union includes tool', () => {
    // The batch field type and observeUncertainty signature must include 'tool'
    expect(loop).toMatch(/'thinking'\s*\|\s*'output'\s*\|\s*'tool'/)
  })
  it('flushUncertainty emits brain.toolUncertainty for tool points', () => {
    expect(loop).toMatch(/brain\.toolUncertainty/)
    expect(loop).toMatch(/dashboardBroadcast\(\{ type: 'brain\.toolUncertainty'/)
  })
  it('tool points do NOT leak into brain.uncertainty broadcast', () => {
    // The flush splits by kind: restPts (non-tool) → brain.uncertainty, toolPts → brain.toolUncertainty
    // Verify the split filter is present
    expect(loop).toMatch(/filter\(.*kind.*!==.*'tool'\)/)
    expect(loop).toMatch(/filter\(.*kind.*===.*'tool'\)/)
  })
  it('input_json_delta logprobs are observed as tool uncertainty', () => {
    expect(loop).toMatch(/input_json_delta/)
    // After tokenCount++ there should be an observeUncertainty('tool', ...) call
    expect(loop).toMatch(/observeUncertainty\('tool'/)
  })
  it('content_block_start tool_use logprobs are observed as tool uncertainty', () => {
    // The content_block_start handler for tool_use blocks should call observeUncertainty('tool', ...)
    // when logprobs are present on the content_block
    expect(loop).toMatch(/content_block.*logprobs|logprobs.*content_block/s)
  })
  it('brain.toolUncertainty is dashboard-only — not in protocol.ts or protocol.py', () => {
    const tsProto = readFileSync('engine/bridge/protocol.ts', 'utf-8')
    const pyProto = readFileSync('tui/localcode_tui/protocol.py', 'utf-8')
    expect(tsProto).not.toMatch(/toolUncertainty/)
    expect(pyProto).not.toMatch(/toolUncertainty/)
  })
})
