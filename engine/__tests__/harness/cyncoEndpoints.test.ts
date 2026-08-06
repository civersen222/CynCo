import { describe, expect, it } from 'bun:test'
// Plain .mjs harness module, used by scripts/cynco-mission-driver.mjs
// @ts-ignore — untyped harness module
import { engineEndpoints } from '../../../scripts/cynco-endpoints.mjs'

describe('mission driver endpoints', () => {
  it('defaults to the engine s own default port', () => {
    const e = engineEndpoints({})
    expect(e.port).toBe(9160)
    expect(e.ws).toBe('ws://localhost:9160')
    expect(e.governance).toBe('http://localhost:9161/api/governance')
    expect(e.run).toBe('http://localhost:9161/api/run')
  })

  it('follows LOCALCODE_WS_PORT, the same variable the engine reads', () => {
    const e = engineEndpoints({ LOCALCODE_WS_PORT: '9170' })
    expect(e.port).toBe(9170)
    expect(e.ws).toBe('ws://localhost:9170')
    // The dashboard is the bridge's bound port plus one (engine/main.ts), so
    // one number has to configure both or a second wave talks to the first
    // wave's governance API while driving its own engine.
    expect(e.governance).toBe('http://localhost:9171/api/governance')
    expect(e.run).toBe('http://localhost:9171/api/run')
  })

  it('lets CYNCO_ENGINE_PORT win, so a driver can target an engine it did not launch', () => {
    const e = engineEndpoints({ LOCALCODE_WS_PORT: '9160', CYNCO_ENGINE_PORT: '9180' })
    expect(e.port).toBe(9180)
    expect(e.ws).toBe('ws://localhost:9180')
  })

  it('treats an empty value as unset rather than as port zero', () => {
    expect(engineEndpoints({ CYNCO_ENGINE_PORT: '', LOCALCODE_WS_PORT: '' }).port).toBe(9160)
  })

  it('refuses a port that is not a port, instead of dialling ws://localhost:NaN', () => {
    // parseInt('abc') is NaN and template interpolation is happy to spell that
    // into a URL. The connection then fails with something that looks like a
    // dead engine, two hours after the only moment it could have been fixed.
    expect(() => engineEndpoints({ CYNCO_ENGINE_PORT: 'abc' })).toThrow(/CYNCO_ENGINE_PORT/)
    expect(() => engineEndpoints({ LOCALCODE_WS_PORT: '70000' })).toThrow(/LOCALCODE_WS_PORT/)
    expect(() => engineEndpoints({ CYNCO_ENGINE_PORT: '0' })).toThrow(/CYNCO_ENGINE_PORT/)
  })

  it('names the variable it read, so a wrong number is traceable to who set it', () => {
    expect(engineEndpoints({ LOCALCODE_WS_PORT: '9170' }).source).toBe('LOCALCODE_WS_PORT')
    expect(engineEndpoints({ CYNCO_ENGINE_PORT: '9180' }).source).toBe('CYNCO_ENGINE_PORT')
    expect(engineEndpoints({}).source).toBe('default')
  })
})
