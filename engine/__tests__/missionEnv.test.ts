import { describe, expect, it } from 'bun:test'
import { MISSION_ENV_KEYS, isUnattendedMission, uncertaintyTraceEnabled } from '../missionEnv.js'
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

describe('uncertaintyTraceEnabled', () => {
  // 2026-11-06: the Brain's per-token top-8 logprobs took the daemon's passes from 114 to 44 tok/s
  // (standalone llama-server benchmark, same flags). Nobody watches the trace in a one-shot or an
  // unattended mission, so it is off there unless LOCALCODE_ENTROPY_TRACE says otherwise.
  it('is on by default for an interactive engine', () => {
    expect(uncertaintyTraceEnabled({}, ['bun', 'engine/main.ts'])).toBe(true)
  })
  it('is off for a daemon one-shot (--run-task)', () => {
    expect(uncertaintyTraceEnabled({}, ['bun', 'engine/main.ts', '--run-task', 'C:/x/task.json'])).toBe(false)
  })
  it('is off for an unattended mission', () => {
    expect(uncertaintyTraceEnabled({ LOCALCODE_MISSION_MARKER: 'm' }, ['bun', 'engine/main.ts'])).toBe(false)
  })
  it('LOCALCODE_ENTROPY_TRACE overrides both ways', () => {
    expect(uncertaintyTraceEnabled({ LOCALCODE_ENTROPY_TRACE: '1' }, ['bun', 'engine/main.ts', '--run-task', 't.json'])).toBe(true)
    expect(uncertaintyTraceEnabled({ LOCALCODE_ENTROPY_TRACE: '0' }, ['bun', 'engine/main.ts'])).toBe(false)
  })
})
