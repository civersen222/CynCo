import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { inPhoneEnginesSeat, servicesArgs, siblingDecision, takeOverFromHeadless } from '../../power/siblingEngine.js'

describe('siblingDecision', () => {
  it('a desk engine (eager, not a one-shot) hands off; the headless engine and one-shots do not', () => {
    expect(siblingDecision({ lazy: false, runTask: false, platform: 'win32', inPhoneSeat: true })).toBe('handoff')
    expect(siblingDecision({ lazy: true, runTask: false, platform: 'win32', inPhoneSeat: true })).toBe('none')
    expect(siblingDecision({ lazy: false, runTask: true, platform: 'win32', inPhoneSeat: true })).toBe('none')
    expect(siblingDecision({ lazy: false, runTask: false, platform: 'linux', inPhoneSeat: true })).toBe('none')
  })

  it('an engine that is not in the phone engine\'s seat stops nobody, whatever else it is (F224)', () => {
    // 2026-11-12: a smoke engine on 19161 with a scratch home ran the hand-off and took the live phone
    // engine down for nine and a half minutes.
    expect(siblingDecision({ lazy: false, runTask: false, platform: 'win32', inPhoneSeat: false })).toBe('none')
  })

  it('main.ts asks whose seat this engine takes before it stops anybody', () => {
    const main = readFileSync('engine/main.ts', 'utf-8')
    expect(main).toMatch(/inPhoneEnginesSeat\(\{ wsPort: process\.env\.LOCALCODE_WS_PORT, cyncoHome: cyncoHome\(\), defaultHome: join\(homedir\(\), '\.cynco'\) \}\)/)
    expect(main).toMatch(/siblingDecision\(\{[^}]*inPhoneSeat[^}]*\}\)/)
  })
})

describe('inPhoneEnginesSeat', () => {
  const HOME = 'C:\\Users\\o\\.cynco'
  it('the desk engine: the phone engine\'s port and home', () => {
    expect(inPhoneEnginesSeat({ wsPort: undefined, cyncoHome: HOME, defaultHome: HOME })).toBe(true)
    expect(inPhoneEnginesSeat({ wsPort: '9160', cyncoHome: 'c:/users/o/.cynco/', defaultHome: HOME })).toBe(true)
  })

  it('a smoke engine: another port, or a scratch home, or both', () => {
    expect(inPhoneEnginesSeat({ wsPort: '19160', cyncoHome: HOME, defaultHome: HOME })).toBe(false)
    expect(inPhoneEnginesSeat({ wsPort: undefined, cyncoHome: 'C:\\tmp\\smoke\\.cynco', defaultHome: HOME })).toBe(false)
    expect(inPhoneEnginesSeat({ wsPort: '19160', cyncoHome: 'C:\\tmp\\smoke\\.cynco', defaultHome: HOME })).toBe(false)
  })
})

describe('takeOverFromHeadless', () => {
  function fakeServices(initial: 'RUNNING' | 'STOPPED' | 'NOT REGISTERED') {
    const calls: string[] = []
    let state = initial
    const run = async (action: string) => {
      calls.push(action)
      if (action === 'status') return `engine    ${state}${state === 'RUNNING' ? ' (pid 1)' : ''}    x\n`
      if (action === 'stop') { state = 'STOPPED'; return 'engine: stopped' }
      if (action === 'start') { state = 'RUNNING'; return 'engine: started' }
      return ''
    }
    return { calls, run, state: () => state }
  }

  it('stops a running phone engine and restarts it on release', async () => {
    const s = fakeServices('RUNNING')
    const logs: string[] = []
    const h = await takeOverFromHeadless({ services: s.run, log: (l) => logs.push(l) })
    expect(h.wasRunning).toBe(true)
    expect(s.state()).toBe('STOPPED')
    await h.release()
    expect(s.state()).toBe('RUNNING')
    expect(s.calls).toEqual(['status', 'stop', 'start'])
    expect(logs.some(l => /phone engine stopped/.test(l))).toBe(true)
  })

  it('does nothing when the phone engine is stopped or not registered, and release is a no-op', async () => {
    for (const init of ['STOPPED', 'NOT REGISTERED'] as const) {
      const s = fakeServices(init)
      const h = await takeOverFromHeadless({ services: s.run, log: () => {} })
      expect(h.wasRunning).toBe(false)
      await h.release()
      expect(s.calls).toEqual(['status'])
    }
  })

  it('release runs once even if called twice', async () => {
    const s = fakeServices('RUNNING')
    const h = await takeOverFromHeadless({ services: s.run, log: () => {} })
    await h.release(); await h.release()
    expect(s.calls.filter(c => c === 'start').length).toBe(1)
  })

  it('a failing services script is logged, never thrown', async () => {
    const logs: string[] = []
    const h = await takeOverFromHeadless({ services: async () => { throw new Error('no powershell') }, log: (l) => logs.push(l) })
    expect(h.wasRunning).toBe(false)
    expect(logs.some(l => /no powershell/.test(l))).toBe(true)
  })
})

describe('servicesArgs', () => {
  it('passes the calling engine pid as -ExcludePid so the services script never matches (or kills) the desk engine itself', () => {
    const args = servicesArgs('C:/x/cynco-services.ps1', 'stop', 4242)
    expect(args.slice(-4)).toEqual(['stop', 'engine', '-ExcludePid', '4242'])
    expect(args).toContain('C:/x/cynco-services.ps1')
  })
})

describe('releaseSync (process exit hook)', () => {
  it('restarts the phone engine through the sync runner when the async release never ran', async () => {
    const sync: string[] = []
    const h = await takeOverFromHeadless({
      services: async (a) => (a === 'status' ? 'engine    RUNNING (pid 1)    x' : ''),
      servicesSync: (a) => { sync.push(a); return 'engine: started' },
      log: () => {},
    })
    h.releaseSync(); h.releaseSync()
    expect(sync).toEqual(['start'])
  })
  it('is a no-op after the async release, and when nothing was running', async () => {
    const sync: string[] = []
    const h = await takeOverFromHeadless({
      services: async (a) => (a === 'status' ? 'engine    RUNNING (pid 1)    x' : ''),
      servicesSync: (a) => { sync.push(a); return '' },
      log: () => {},
    })
    await h.release(); h.releaseSync()
    expect(sync).toEqual([])
    const idle = await takeOverFromHeadless({ services: async () => 'engine    STOPPED    x', servicesSync: (a) => { sync.push(a); return '' }, log: () => {} })
    idle.releaseSync()
    expect(sync).toEqual([])
  })
  it('logs, never throws, when the sync runner fails', async () => {
    const logs: string[] = []
    const h = await takeOverFromHeadless({
      services: async (a) => (a === 'status' ? 'engine    RUNNING (pid 1)    x' : ''),
      servicesSync: () => { throw new Error('no powershell') },
      log: (l) => logs.push(l),
    })
    expect(() => h.releaseSync()).not.toThrow()
    expect(logs.some(l => /no powershell/.test(l))).toBe(true)
  })
})
