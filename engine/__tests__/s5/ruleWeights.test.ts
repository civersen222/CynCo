import { describe, it, expect, beforeEach } from 'bun:test'
import { RuleWeightManager } from '../../s5/ruleWeights.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('RuleWeightManager', () => {
  let dir: string
  let mgr: RuleWeightManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ruleweights-'))
    mgr = new RuleWeightManager(dir)
  })

  it('returns default weight 1.0 for unknown rule', () => {
    expect(mgr.getWeight('C1')).toBe(1.0)
  })

  it('adjusts weight positively', () => {
    mgr.recordOutcome('W1', 'positive')
    expect(mgr.getWeight('W1')).toBe(1.1)
  })

  it('adjusts weight negatively on dismiss', () => {
    mgr.recordOutcome('W2', 'dismissed')
    expect(mgr.getWeight('W2')).toBe(0.9)
  })

  it('adjusts weight more negatively on negative outcome', () => {
    mgr.recordOutcome('W3', 'negative')
    expect(mgr.getWeight('W3')).toBe(0.8)
  })

  it('clamps weight to minimum 0.1', () => {
    for (let i = 0; i < 20; i++) mgr.recordOutcome('W4', 'negative')
    expect(mgr.getWeight('W4')).toBe(0.1)
  })

  it('clamps weight to maximum 2.0', () => {
    for (let i = 0; i < 20; i++) mgr.recordOutcome('W5', 'positive')
    expect(mgr.getWeight('W5')).toBe(2.0)
  })

  it('persists and loads weights', () => {
    mgr.recordOutcome('W1', 'positive')
    mgr.save()
    const mgr2 = new RuleWeightManager(dir)
    expect(mgr2.getWeight('W1')).toBe(1.1)
  })
})
