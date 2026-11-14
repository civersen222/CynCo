// F236: launching and ending a mission leaves exactly one engine serving the dashboard.
//
// 2026-11-14: the t5 wave stalled; a person killed its driver and mission engine
// by hand; the launcher's end step booted a bare idle engine on 9160/9161
// (the phone engine had been stopped by hand before the dispatch, so the F234
// rule "start it again if it was running" did not apply); two seconds later the
// person started the phone engine, which walked to 9162/9163; the phone talked
// to the stand-in. Every decision below is made with fakes: no engine, task or
// port is touched.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { missionEnd, ENGINE_GRACE_MS, STARTABLE_TASK_STATES, PHONE_ENGINE_TASK } from '../cynco-mission-end.mjs'

function world({ engineAliveFor = 0, dashboard = false, task = 'Ready' } = {}) {
  const w = { t: 0, killed: false, logs: [], slept: 0 }
  w.deps = {
    engineAlive: () => !w.killed && w.t < engineAliveFor,
    killEngine: async () => { w.killed = true },
    dashboardAnswers: async () => (typeof dashboard === 'function' ? dashboard(w) : dashboard),
    phoneTaskState: () => task,
    sleep: async (ms) => { w.t += ms; w.slept += ms },
    log: (l) => w.logs.push(l),
  }
  return w
}

describe('the mission is over: who serves the dashboard', () => {
  it('the 2026-11-14 sequence: phone engine stopped by hand before the dispatch, driver and engine killed — the phone engine\'s task is started, never a bare stand-in', async () => {
    const w = world({ engineAliveFor: 0, dashboard: false, task: 'Ready' })
    const r = await missionEnd({}, w.deps)
    expect(r.action).toBe('phone')
    expect(r.reaped).toBe(false)
    expect(r.why).toMatch(/the phone engine's task is Ready: it serves the dashboard, not a bare stand-in/)
  })

  it('a phone engine that was running at launch is handed back the same way', async () => {
    expect((await missionEnd({}, world({ task: 'Running' }).deps)).action).toBe('phone')
    expect((await missionEnd({}, world({ task: 'Queued' }).deps)).action).toBe('phone')
  })

  it('a bare idle engine only on a PC with no phone engine, or one whose task the owner disabled', async () => {
    const none = await missionEnd({}, world({ task: '' }).deps)
    expect(none).toMatchObject({ action: 'idle' })
    expect(none.why).toMatch(/no phone engine task is registered/)
    const disabled = await missionEnd({}, world({ task: 'Disabled' }).deps)
    expect(disabled.action).toBe('idle')
    expect(disabled.why).toMatch(/task is Disabled/)
  })

  it('something already answering on the dashboard is left alone', async () => {
    expect(await missionEnd({}, world({ dashboard: true }).deps)).toMatchObject({ action: 'none' })
  })

  it('the caller that owns the dashboard (the campaign runner) is left to it', async () => {
    const r = await missionEnd({ skipIdle: true }, world({ task: 'Ready' }).deps)
    expect(r.action).toBe('none')
    expect(r.why).toMatch(/CYNCO_SKIP_IDLE_ENGINE/)
  })
})

describe('a mission engine that outlives its driver', () => {
  it('is stopped after the grace period, before anything else is decided — it would otherwise keep the dashboard with a mission\'s environment', async () => {
    // Alive forever (the driver was killed; nobody sent /quit). Its port answers until it is killed.
    const w = world({ engineAliveFor: Infinity, dashboard: (w) => !w.killed, task: 'Ready' })
    const r = await missionEnd({ pollMs: 5_000 }, w.deps)
    expect(w.killed).toBe(true)
    expect(r).toMatchObject({ action: 'phone', reaped: true })
    expect(w.slept).toBeGreaterThanOrEqual(ENGINE_GRACE_MS)
    expect(w.logs[0]).toMatch(/the mission engine outlived its driver by 60s .* stopping its tree so it does not keep the dashboard \(F236\)/)
  })

  it('one that exits within the grace (its own teardown) is waited for, not killed', async () => {
    const w = world({ engineAliveFor: 20_000, task: 'Ready' })
    const r = await missionEnd({ pollMs: 5_000 }, w.deps)
    expect(w.killed).toBe(false)
    expect(r.reaped).toBe(false)
    expect(w.slept).toBe(20_000)
  })

  it('is stopped even when the caller owns the dashboard', async () => {
    const w = world({ engineAliveFor: Infinity, task: 'Ready' })
    const r = await missionEnd({ skipIdle: true, pollMs: 10_000 }, w.deps)
    expect(r).toMatchObject({ action: 'none', reaped: true })
  })
})

describe('the constants', () => {
  it('names the task the services script registers, and only startable states start it', () => {
    expect(PHONE_ENGINE_TASK).toBe('CynCo headless engine')
    expect(readFileSync('scripts/cynco-services.ps1', 'utf-8')).toContain(`Task = '${PHONE_ENGINE_TASK}'`)
    expect([...STARTABLE_TASK_STATES].sort()).toEqual(['Queued', 'Ready', 'Running'])
  })
})

describe('dispatch-mission.sh is wired to it', () => {
  const sh = readFileSync('scripts/dispatch-mission.sh', 'utf-8').split('\r\n').join('\n')
  const code = sh.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  it('records the mission engine\'s Windows pid right after starting it', () => {
    expect(code).toMatch(/bun engine\/main\.ts > "\$ENGINE_LOG" 2>&1 &\nENGINE_PID=\$!\nENGINE_WINPID=\$\(cat "\/proc\/\$ENGINE_PID\/winpid"/)
  })
  it('an abandoned dispatch stops its engine and gives the phone engine back; the trap is set before the phone engine is stopped and cleared once the watcher runs', () => {
    const trapSet = code.indexOf('trap dispatch_abandoned EXIT')
    const phoneStop = code.indexOf('cynco-services.ps1 stop engine')
    const watcher = code.indexOf('bun scripts/cynco-mission-end.mjs')
    const trapCleared = code.indexOf('trap - EXIT')
    expect(trapSet).toBeGreaterThan(0)
    expect(trapSet).toBeLessThan(phoneStop)
    expect(trapCleared).toBeGreaterThan(watcher)
    const fn = code.slice(code.indexOf('dispatch_abandoned() {'), code.indexOf('trap dispatch_abandoned EXIT'))
    expect(fn).toMatch(/taskkill \/\/PID "\$ENGINE_WINPID" \/\/T \/\/F/)
    expect(fn).toMatch(/cynco-services\.ps1 start engine/)
  })
  it('the watcher runs for every mission (it reaps even when the caller owns the dashboard) and acts on the decision', () => {
    const watcherAt = code.indexOf('while kill -0 "$DRIVER_PID"')
    expect(code.slice(0, watcherAt)).not.toMatch(/if \[ -z "\$\{CYNCO_SKIP_IDLE_ENGINE:-\}" \]; then\s*\n\s*IDLE_LOG=.*\n\s*\(\s*$/m)
    expect(code).toMatch(/bun scripts\/cynco-mission-end\.mjs --engine-pid "\$\{ENGINE_WINPID:-0\}" \$\{CYNCO_SKIP_IDLE_ENGINE:\+--skip-idle\}/)
    const cases = code.slice(code.indexOf("sed -n 's/^ACTION //p'"), code.indexOf('esac'))
    expect(cases).toMatch(/phone\)\s+powershell -NoProfile -ExecutionPolicy Bypass -File scripts\/cynco-services\.ps1 start engine/)
    expect(cases).toMatch(/idle\)\s+boot_idle_engine/)
    expect(cases).toMatch(/none\)\s+echo "\[dispatch\] mission over/)
  })
  it('the wait for the bind ends when a seat engine refuses and exits, and the refusal quotes its [ws] line', () => {
    expect(code).toMatch(/if ! kill -0 "\$ENGINE_PID" 2>\/dev\/null; then break; fi/)
    expect(code).toMatch(/WS_LAST=\$\(grep '\^\\\[ws\\\]' "\$ENGINE_LOG"/)
  })
})

describe('an engine in the phone engine\'s seat never walks off it (engine/main.ts)', () => {
  const main = readFileSync('engine/main.ts', 'utf-8')
  it('passes walk: false in the seat and exits on SeatTakenError rather than serve a second engine', () => {
    expect(main).toMatch(/inPhoneEnginesSeatHere = inPhoneSeat/)
    expect(main).toMatch(/walk: !inPhoneEnginesSeatHere,/)
    expect(main).toMatch(/if \(!\(e instanceof SeatTakenError\)\) throw e\s+console\.error\(e\.message\)[\s\S]{0,200}process\.exit\(1\)/)
  })
})
