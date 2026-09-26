import { describe, expect, it } from 'bun:test'
import { MISSION_ENV_KEYS, isUnattendedMission } from '../missionEnv.js'
import { isUnattendedMission as reexported } from '../bootstrapProvider.js'

// Read at file load, before any test sets a key: the suite setup
// (setup/missionEnv.ts) must have cleared an inherited mission env (review I1).
const unattendedAtLoad = isUnattendedMission()

describe('missionEnv', () => {
  it('the suite runs as interactive even when launched inside a mission', () => {
    expect(unattendedAtLoad).toBe(false)
  })

  it('names exactly the four keys dispatch-mission.sh sets', () => {
    expect([...MISSION_ENV_KEYS]).toEqual([
      'LOCALCODE_MISSION_MARKER', 'LOCALCODE_MISSION_CWD', 'LOCALCODE_MISSION_BASE', 'LOCALCODE_MISSION_CHECK',
    ])
  })

  for (const key of ['LOCALCODE_MISSION_MARKER', 'LOCALCODE_MISSION_CWD', 'LOCALCODE_MISSION_BASE', 'LOCALCODE_MISSION_CHECK']) {
    it(`${key} alone marks the engine unattended; empty is unset`, () => {
      expect(isUnattendedMission({ [key]: 'x' })).toBe(true)
      expect(isUnattendedMission({ [key]: '' })).toBe(false)
    })
  }

  it('no key, a prefix look-alike, or all-empty is interactive', () => {
    expect(isUnattendedMission({})).toBe(false)
    expect(isUnattendedMission({ LOCALCODE_MISSIONS: 'x', LOCALCODE_MISSION_OTHER: 'x' })).toBe(false)
    expect(isUnattendedMission(Object.fromEntries(MISSION_ENV_KEYS.map(k => [k, ''])))).toBe(false)
  })

  it('defaults to process.env', () => {
    const prev = process.env.LOCALCODE_MISSION_MARKER
    try {
      process.env.LOCALCODE_MISSION_MARKER = 'M_DONE'
      expect(isUnattendedMission()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.LOCALCODE_MISSION_MARKER; else process.env.LOCALCODE_MISSION_MARKER = prev
    }
  })

  it('bootstrapProvider re-exports the same predicate', () => {
    expect(reexported).toBe(isUnattendedMission)
  })
})
