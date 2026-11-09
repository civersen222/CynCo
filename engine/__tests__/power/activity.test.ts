import { describe, expect, it } from 'bun:test'
import { ActivityRegistry } from '../../power/activity.js'

describe('ActivityRegistry', () => {
  it('counts open activities and ends them', () => {
    const r = new ActivityRegistry()
    const endA = r.begin('turn', 'chat')
    const endB = r.begin('request')
    expect(r.count()).toBe(2)
    endA()
    expect(r.count()).toBe(1)
    endB()
    expect(r.count()).toBe(0)
  })

  it('fires onBusy once on 0→1 and onIdle once on 1→0 across overlapping activities', () => {
    const r = new ActivityRegistry()
    let busy = 0, idle = 0
    r.onBusy(() => busy++)
    r.onIdle(() => idle++)
    const e1 = r.begin('turn')
    const e2 = r.begin('oneshot', 'digest-espn')
    const e3 = r.begin('request')
    expect(busy).toBe(1)
    e1(); e2()
    expect(idle).toBe(0)
    e3()
    expect(idle).toBe(1)
    expect(busy).toBe(1)
  })

  it('a second end() of the same activity is a no-op', () => {
    const r = new ActivityRegistry()
    let idle = 0
    r.onIdle(() => idle++)
    const end = r.begin('turn')
    const other = r.begin('request')
    end(); end()
    expect(r.count()).toBe(1)
    other()
    expect(idle).toBe(1)
  })

  it('snapshot lists open activities with kind, label and since', () => {
    const r = new ActivityRegistry(() => 1234)
    r.begin('oneshot', 'dynasty-tin-daily')
    const snap = r.snapshot()
    expect(snap).toEqual([{ kind: 'oneshot', label: 'dynasty-tin-daily', since: 1234 }])
  })

  it('listeners can unsubscribe', () => {
    const r = new ActivityRegistry()
    let busy = 0
    const off = r.onBusy(() => busy++)
    off()
    r.begin('turn')
    expect(busy).toBe(0)
  })
})
