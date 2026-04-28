import { describe, expect, it, beforeEach } from 'bun:test'
import {
  GOVERNANCE_PARAMS, getParam, setParam, exportParams,
  importParams, getParamHistory, getSystemParams, resetParams,
} from '../../vsm/governanceParams.js'

describe('GovernanceParams', () => {
  beforeEach(() => {
    resetParams()
  })

  it('has all expected parameter categories', () => {
    const systems = new Set(Array.from(GOVERNANCE_PARAMS.values()).map(p => p.system))
    expect(systems.has('variety')).toBe(true)
    expect(systems.has('homeostat')).toBe(true)
    expect(systems.has('feedback')).toBe(true)
    expect(systems.has('algedonic')).toBe(true)
    expect(systems.has('metrics')).toBe(true)
    expect(systems.has('global')).toBe(true)
  })

  it('getParam returns default value', () => {
    expect(getParam('feedback.context_setpoint')).toBe(0.7)
    expect(getParam('algedonic.kill_threshold')).toBe(5)
  })

  it('getParam throws on unknown parameter', () => {
    expect(() => getParam('bogus')).toThrow()
  })

  it('setParam changes value and logs history', () => {
    const prev = setParam('feedback.pid_kp', 0.5, 'test')
    expect(prev).toBe(0.3) // was default
    expect(getParam('feedback.pid_kp')).toBe(0.5)
    // Restore
    setParam('feedback.pid_kp', 0.3, 'restore')
  })

  it('setParam clamps to bounds', () => {
    setParam('algedonic.kill_threshold', 100, 'test') // max is 20
    expect(getParam('algedonic.kill_threshold')).toBe(20)
    setParam('algedonic.kill_threshold', 5, 'restore')
  })

  it('exportParams returns all values', () => {
    const exported = exportParams()
    expect(exported['variety.env_multiplier']).toBe(3.0)
    expect(exported['feedback.pid_kp']).toBeDefined()
    expect(Object.keys(exported).length).toBe(GOVERNANCE_PARAMS.size)
  })

  it('importParams sets multiple values', () => {
    importParams({ 'feedback.pid_kp': 0.8, 'feedback.pid_ki': 0.1 }, 'bulk')
    expect(getParam('feedback.pid_kp')).toBe(0.8)
    expect(getParam('feedback.pid_ki')).toBe(0.1)
    // Restore
    importParams({ 'feedback.pid_kp': 0.3, 'feedback.pid_ki': 0.05 }, 'restore')
  })

  it('getSystemParams filters by system', () => {
    const variety = getSystemParams('variety')
    expect(variety.length).toBeGreaterThan(0)
    expect(variety.every(p => p.system === 'variety')).toBe(true)
  })

  it('history tracks all changes for Level 4 training', () => {
    setParam('global.stuck_threshold', 4, 'test-history')
    const history = getParamHistory()
    const recent = history.filter(h => h.reason === 'test-history')
    expect(recent.length).toBeGreaterThan(0)
    expect(recent[0].name).toBe('global.stuck_threshold')
    setParam('global.stuck_threshold', 3, 'restore')
  })
})
