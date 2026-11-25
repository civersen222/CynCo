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
import { basename } from 'node:path'
import { missionEnd, engineListing, engineDeps, runStartTime, ENGINE_GRACE_MS, STARTABLE_TASK_STATES, PHONE_ENGINE_TASK } from '../cynco-mission-end.mjs'

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

// Wave 13c (C4, C7): the watcher hands --engine-pid the CONFIRMED bun.exe's pid. If that engine has ended and Windows
// gave its pid to another program within the watcher's 10 s and the 60 s grace, `process.kill(pid, 0)` still answered
// "alive" and killProcessTree then killed that program's tree. The pid is now asked by image, as the dispatch asks it
// (engine_listing): only a pid tasklist lists as bun.exe is the engine, and only that is killed.
describe('the engine pid is asked by its image: a pid that is not a bun.exe is never killed (wave 13c)', () => {
  const NO_TASK = 'INFO: No tasks are running which match the specified criteria.'
  const row = (image, pid = 4242) => `"${image}","${pid}","Console","1","10 K"\r\n`
  /** A tasklist stand-in: `answers(n)` is what the n-th call prints (0-based); every call is recorded. */
  const fakeTasklist = (answers) => {
    const calls = []
    const run = (pid) => { calls.push(pid); const a = answers(calls.length - 1); return typeof a === 'string' ? { status: 0, stdout: a } : a }
    return { run, calls }
  }

  it('reads tasklist as the dispatch does: listed, gone, held by another image, or unknown', () => {
    const ask = (out) => engineListing(4242, () => (typeof out === 'string' ? { status: 0, stdout: out } : out))
    expect(ask(row('bun.exe'))).toEqual({ state: 'listed' })
    expect(ask(`${NO_TASK}\r\n`)).toEqual({ state: 'gone' })
    expect(ask(row('notepad.exe'))).toEqual({ state: 'other', image: 'notepad.exe' })
    expect(ask(row('bun.exe', 14242))).toEqual({ state: 'unknown', why: 'tasklist printed what this does not read' })
    expect(ask('')).toEqual({ state: 'unknown', why: 'tasklist printed nothing' })
    expect(ask({ status: 1, stdout: '' })).toEqual({ state: 'unknown', why: 'tasklist could not be run or failed (exit 1)' })
    expect(ask({ error: new Error('spawn tasklist ENOENT'), status: null, stdout: '' })).toEqual({ state: 'unknown', why: 'tasklist could not be run or failed (spawn tasklist ENOENT)' })
    // No pid to ask about (the dispatch always hands one; a bad argument is never killed).
    for (const bad of [0, -1, NaN, 1.5]) expect(engineListing(bad, () => { throw new Error('not asked') })).toEqual({ state: 'none' })
  })

  // Wave 13d (R8): the creation time the dispatch read when it confirmed the pid (--engine-started), and a start-time
  // reader that answers it: the same bun.exe.
  const STARTED = '638000000000000001'
  const sameStart = () => ({ ticks: STARTED })

  it('listed: the engine outlived its driver, and only then is its tree killed', async () => {
    const t = fakeTasklist((n) => (n < 20 ? row('bun.exe') : `${NO_TASK}\r\n`))
    const killed = [], logs = []
    // Changed on purpose in wave 13d (R8): a bun.exe is the engine only with the engine's creation time.
    const deps = engineDeps(4242, { tasklist: t.run, startTime: sameStart, started: STARTED, killTree: async (pid) => { killed.push(pid) }, log: (l) => logs.push(l) })
    const r = await missionEnd({ skipIdle: true, pollMs: 5_000 }, { ...deps, dashboardAnswers: async () => false, phoneTaskState: () => 'Ready', sleep: async () => {}, log: (l) => logs.push(l) })
    expect(killed).toEqual([4242])
    expect(r).toMatchObject({ action: 'none', reaped: true })
  })

  it('reused by another image: read as gone with the reuse line, not killed', async () => {
    const t = fakeTasklist(() => row('notepad.exe'))
    const killed = [], logs = []
    const deps = engineDeps(4242, { tasklist: t.run, killTree: async (pid) => { killed.push(pid) }, log: (l) => logs.push(l) })
    expect(deps.engineAlive()).toBe(false)
    const r = await missionEnd({ skipIdle: true }, { ...deps, dashboardAnswers: async () => false, phoneTaskState: () => 'Ready', sleep: async () => {}, log: (l) => logs.push(l) })
    expect(killed).toEqual([])
    expect(r.reaped).toBe(false)
    expect(logs).toContain("pid 4242 is now notepad.exe: the engine's bun.exe has ended and its pid was reused")
    // Asked straight, killEngine refuses that pid too.
    expect(await deps.killEngine()).toBe(false)
    expect(killed).toEqual([])
    expect(logs).toContain("the mission engine was not killed: pid 4242 is now notepad.exe, not the engine's bun.exe")
  })

  it('gone: not killed, nothing waited for', async () => {
    const t = fakeTasklist(() => `${NO_TASK}\r\n`)
    const killed = []
    const deps = engineDeps(4242, { tasklist: t.run, killTree: async (pid) => { killed.push(pid) }, log: () => {} })
    let slept = 0
    const r = await missionEnd({ skipIdle: true }, { ...deps, dashboardAnswers: async () => false, phoneTaskState: () => 'Ready', sleep: async (ms) => { slept += ms }, log: () => {} })
    expect(killed).toEqual([])
    expect(r.reaped).toBe(false)
    expect(slept).toBe(0)
  })

  it('a bun.exe that is still listed at the grace\'s end but ends before the kill is not killed; tasklist that cannot be read waits the grace and kills nothing', async () => {
    // Listed for the whole grace (the first ask, thirteen in the wait, the one after it), then gone at the moment of
    // the kill: the kill asks again first.
    const t = fakeTasklist((n) => (n < 15 ? row('bun.exe') : `${NO_TASK}\r\n`))
    const killed = [], logs = []
    const deps = engineDeps(4242, { tasklist: t.run, startTime: sameStart, started: STARTED, killTree: async (pid) => { killed.push(pid) }, log: (l) => logs.push(l) })
    const r = await missionEnd({ skipIdle: true, pollMs: 5_000 }, { ...deps, dashboardAnswers: async () => false, phoneTaskState: () => 'Ready', sleep: async () => {}, log: (l) => logs.push(l) })
    expect(t.calls.length).toBe(16)
    expect(killed).toEqual([])
    expect(r.reaped).toBe(false)
    expect(logs).toContain('the mission engine was not killed: pid 4242 is gone')
    // Unknown counts as alive (fail closed: it is waited for), and an unknown pid is never killed.
    const u = fakeTasklist(() => ({ status: 1, stdout: '' }))
    const killedU = [], logsU = []
    const depsU = engineDeps(4242, { tasklist: u.run, killTree: async (pid) => { killedU.push(pid) }, log: (l) => logsU.push(l) })
    let slept = 0
    const ru = await missionEnd({ skipIdle: true, pollMs: 5_000 }, { ...depsU, dashboardAnswers: async () => false, phoneTaskState: () => 'Ready', sleep: async (ms) => { slept += ms }, log: (l) => logsU.push(l) })
    expect(slept).toBeGreaterThanOrEqual(ENGINE_GRACE_MS)
    expect(killedU).toEqual([])
    expect(ru.reaped).toBe(false)
    expect(logsU).toContain('the mission engine was not killed: tasklist could not be run or failed (exit 1)')
  })

  it.skipIf(process.platform !== 'win32')('the real tasklist: this process is listed by its own image, a pid nobody holds is gone', () => {
    const own = engineListing(process.pid)
    const image = basename(process.execPath)
    if (image.toLowerCase() === 'bun.exe') expect(own).toEqual({ state: 'listed' })
    else expect(own.state === 'other' && own.image.toLowerCase() === image.toLowerCase(), JSON.stringify(own)).toBe(true)
    // Windows pids are multiples of 4: one that is not can never be held.
    expect(engineListing(2147483646 - 1)).toEqual({ state: 'gone' })
  })

  it('the command line uses it: no process.kill probe of the pid, and the kill goes through engineDeps', () => {
    const src = readFileSync('scripts/cynco-mission-end.mjs', 'utf-8').split('\r\n').join('\n')
    expect(src).not.toMatch(/process\.kill\(/)
    // Changed on purpose in wave 13d (R8): the creation time the dispatch read (--engine-started) goes in with the pid.
    expect(src).toContain('...engineDeps(enginePid, { tasklist: runTasklist, startTime: runStartTime, started: arg(\'--engine-started\'), killTree: killProcessTree, log }),')
    expect(src).toContain('reaped = (await deps.killEngine()) !== false')
  })

  // Wave 13d (R8): a reuse of the engine's pid by ANOTHER bun.exe read as `listed`, so the end of the grace killed that
  // bun.exe's tree. The dispatch now reads the engine's creation time when it confirms the pid and hands it in; a bun.exe
  // on the pid is the engine only with that creation time.
  it('R8: a bun.exe with another creation time is the pid reused: read as gone with the reuse line, never killed', async () => {
    const t = fakeTasklist(() => row('bun.exe'))
    const killed = [], logs = []
    const deps = engineDeps(4242, { tasklist: t.run, startTime: () => ({ ticks: '638000000000000777' }), started: STARTED, killTree: async (pid) => { killed.push(pid) }, log: (l) => logs.push(l) })
    expect(deps.engineAlive()).toBe(false)
    const r = await missionEnd({ skipIdle: true }, { ...deps, dashboardAnswers: async () => false, phoneTaskState: () => 'Ready', sleep: async () => {}, log: (l) => logs.push(l) })
    expect(r.reaped).toBe(false)
    expect(logs.filter(l => l.startsWith('pid 4242 is now '))).toEqual([`pid 4242 is now another bun.exe (created 638000000000000777; the engine was created ${STARTED}): the engine's bun.exe has ended and its pid was reused`])
    expect(await deps.killEngine()).toBe(false)
    expect(killed).toEqual([])
    expect(logs).toContain(`the mission engine was not killed: pid 4242 is now another bun.exe (created 638000000000000777; the engine was created ${STARTED}), not the engine's bun.exe`)
  })

  it('R8: a creation time that cannot be read, or none handed in, is never the engine confirmed: waited for as alive, never killed', async () => {
    for (const [why, opts] of [
      ['unreadable', { startTime: () => ({ error: new Error('PowerShell exit 1') }), started: STARTED }],
      ['not given', { startTime: () => { throw new Error('not asked') }, started: null }],
      ['not a creation time', { startTime: () => { throw new Error('not asked') }, started: 'abc' }],
    ]) {
      const killed = [], logs = []
      const deps = engineDeps(4242, { tasklist: fakeTasklist(() => row('bun.exe')).run, ...opts, killTree: async (pid) => { killed.push(pid) }, log: (l) => logs.push(l) })
      let slept = 0
      const r = await missionEnd({ skipIdle: true, pollMs: 5_000 }, { ...deps, dashboardAnswers: async () => false, phoneTaskState: () => 'Ready', sleep: async (ms) => { slept += ms }, log: (l) => logs.push(l) })
      expect(slept, why).toBeGreaterThanOrEqual(ENGINE_GRACE_MS)
      expect(killed, why).toEqual([])
      expect(r.reaped, why).toBe(false)
      expect(logs, why).toContain(why === 'unreadable'
        ? 'the mission engine was not killed: pid 4242 is a bun.exe, but its start time could not be read (PowerShell exit 1)'
        : 'the mission engine was not killed: pid 4242 is a bun.exe, but no creation time of the engine was given (--engine-started)')
    }
  })

  it.skipIf(process.platform !== 'win32')('R8, the real reader: a live process\'s creation time reads the same each time; a pid nobody holds has none', () => {
    const a = runStartTime(process.pid)
    expect(a.ticks, JSON.stringify(a)).toMatch(/^\d{15,}$/)
    expect(runStartTime(process.pid)).toEqual(a)
    const none = runStartTime(2147483646 - 1)
    expect(none.ticks).toBeUndefined()
    expect(none.error.message).toBe('PowerShell exit 1')
  }, 60_000)

  // Wave 13d (R4): the grace was the sum of the sleeps, so a tasklist that hung until its 20 s timeout on every ask
  // stretched a 60 s grace to about six minutes (16 asks) before ACTION, and the phone engine started that much later.
  it('R4: the grace is wall time: a tasklist that takes 20 s per ask ends the wait after the grace, not after sixteen asks', async () => {
    let clock = 0
    const t = fakeTasklist(() => { clock += 20_000; return row('bun.exe') })
    const killedAt = [], logs = []
    const deps = engineDeps(4242, { tasklist: t.run, startTime: sameStart, started: STARTED, killTree: async () => { killedAt.push(clock) }, log: (l) => logs.push(l) })
    const r = await missionEnd({ skipIdle: true, pollMs: 5_000 }, { ...deps, now: () => clock, dashboardAnswers: async () => false, phoneTaskState: () => 'Ready', sleep: async (ms) => { clock += ms }, log: (l) => logs.push(l) })
    // The first ask, one in the wait before the sleep, one after it (65 s of wall time), the one before the kill and
    // the kill's own: 5 asks and the kill at 105 s; the sum of the sleeps alone made it 16 asks and 380 s.
    expect(t.calls.length).toBe(5)
    expect(killedAt).toEqual([105_000])
    expect(r.reaped).toBe(true)
    expect(logs[0]).toMatch(/^the mission engine outlived its driver by 85s /)
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
  // Changed on purpose in wave 13 (D1): the first read after the start names the npm shim's sh.exe (measured 40 of
  // 40), so the pid is read again right after the start until tasklist shows it as bun.exe; the loop itself is
  // pinned in engine/__tests__/guards/containmentWiring.test.ts.
  it('reads the mission engine\'s Windows pid right after starting it, and takes it only as a confirmed bun.exe', () => {
    // Changed on purpose in wave 19b: every Bun start of the dispatch passes --no-install.
    expect(code).toMatch(/bun --no-install engine\/main\.ts > "\$ENGINE_LOG" 2>&1 &\nENGINE_PID=\$!\nENGINE_WINPID=\nENGINE_TREE_WINPID=\nENGINE_PID_READS=0\nfor _ in \$\(seq 1 120\); do\n {2}_w=\$\(cat "\/proc\/\$ENGINE_PID\/winpid"/)
    // Changed on purpose in wave 13d (R8): the pid is taken with the bun.exe's creation time, read in the same round.
    expect(code).toContain('if [ -n "$PROCESS_STARTED" ]; then ENGINE_STARTED=$PROCESS_STARTED; ENGINE_WINPID=$_w; break; fi')
  })
  it('an abandoned dispatch stops its engine and gives the phone engine back; the trap is set before the phone engine is stopped and cleared once the watcher runs', () => {
    const trapSet = code.indexOf('trap dispatch_abandoned EXIT')
    const phoneStop = code.indexOf('cynco-services.ps1 stop engine')
    // Changed on purpose in wave 19b: every Bun start of the dispatch passes --no-install.
    const watcher = code.indexOf('bun --no-install scripts/cynco-mission-end.mjs')
    const trapCleared = code.indexOf('trap - EXIT')
    expect(watcher).toBeGreaterThan(0)
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
    // Changed on purpose in wave 13b (B1-4): the watcher is reached only after the pid was confirmed as bun.exe (an
    // unconfirmed start is refused before the driver runs), so mission-end is handed that pid, never a 0 for "none".
    // Changed on purpose in wave 13d (R8): with the pid goes the creation time read when it was confirmed.
    // Changed on purpose in wave 19b: --no-install, as at every Bun start of the dispatch.
    expect(code).toMatch(/bun --no-install scripts\/cynco-mission-end\.mjs --engine-pid "\$ENGINE_WINPID" --engine-started "\$ENGINE_STARTED" \$\{CYNCO_SKIP_IDLE_ENGINE:\+--skip-idle\}/)
    // The `esac` after the ACTION read (wave 13, D1: the abandoned-dispatch trap above has a case of its own now).
    const actionAt = code.indexOf("sed -n 's/^ACTION //p'")
    const cases = code.slice(actionAt, code.indexOf('esac', actionAt))
    expect(cases).toMatch(/phone\)\s+powershell -NoProfile -ExecutionPolicy Bypass -File scripts\/cynco-services\.ps1 start engine/)
    expect(cases).toMatch(/idle\)\s+boot_idle_engine/)
    expect(cases).toMatch(/none\)\s+echo "\[dispatch\] mission over/)
  })
  it('the wait for the bind ends when a seat engine refuses and exits, and the refusal quotes its [ws] line', () => {
    // Asked inside the bind wait itself, from its own `for` to the grep that ends it (wave 13b, B1-3): the pid
    // confirmation after the start has the same `kill -0` line, so a match anywhere in the script would still pass
    // with this one deleted, and a seat engine that exits would again sit out the whole two minutes.
    const bindFrom = code.indexOf('for _ in $(seq 1 24); do\n')
    const bindTo = code.indexOf('grep -q "^\\[localcode\\] Ready\\. Waiting for TUI connection" "$ENGINE_LOG" || {', bindFrom)
    expect(bindFrom).toBeGreaterThan(-1)
    expect(bindTo).toBeGreaterThan(bindFrom)
    expect(code.slice(bindFrom, bindTo)).toMatch(/if ! kill -0 "\$ENGINE_PID" 2>\/dev\/null; then break; fi/)
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
