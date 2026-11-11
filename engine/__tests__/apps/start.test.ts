// Starting an app from its registry recipe (docs/decisions/2026-11-11-local-llm-apps.md, decision 7).
// Everything that touches a process is injected: the order, the wording and the rule for the model
// port are what is pinned here. `standIn.test.ts` and the desk launcher's own test use real processes.
import { describe, expect, it } from 'vitest'
import { startApp, tendModelOnce, type Running, type StartDeps, type Startable } from '../../apps/start.js'
import type { Holder } from '../../apps/identify.js'
import type { AppLaunch, AppStep, LocalApp } from '../../apps/registry.js'

const ROOT = 'C:\\Users\\o\\game'
const LAUNCH: AppLaunch = { exe: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['scripts/start-llm.sh'], cwd: ROOT }
const game = (steps: AppStep[], open: string | null = 'http://localhost:3000'): Startable =>
  ({ id: 'game', name: 'game', root: ROOT, launch: LAUNCH, start: { steps, ...(open ? { open } : {}) } })
const asApp = (id: string): LocalApp => ({ id, name: id, root: ROOT, script: 'scripts/start-llm.sh', launch: LAUNCH, manage: true, source: 'by hand' })
const listener = { pid: 77, name: 'llama-server.exe', exe: null, commandLine: null, created: 1 }

type World = {
  bound: Set<number>
  /** What starting a step does: the ports it binds, or how it fails. */
  onRun: Record<string, { binds?: number[]; exit?: number | null; throws?: string }>
  holder?: Holder
  checks: Record<string, boolean>
  /** Addresses that answer; one listed in `answersAfter` starts answering that many looks later. */
  answering?: Set<string>
  answersAfter?: Record<string, number>
  debt?: boolean
}

function harness(world: World) {
  const said: string[] = []
  const ran: Array<{ step: string; launch: AppLaunch }> = []
  let clock = 0
  const deps: StartDeps = {
    portBound: async port => world.bound.has(port),
    answers: async url => {
      if (world.answersAfter && url in world.answersAfter && --world.answersAfter[url] <= 0) (world.answering ??= new Set()).add(url)
      return world.answering?.has(url) ?? false
    },
    identify: async () => world.holder ?? { owner: 'unknown', detail: 'the process listening on the port could not be read' },
    check: async (exe, args) => world.checks[[exe, ...args].join(' ')] ?? false,
    run: async (launch, step) => {
      ran.push({ step: step.name, launch })
      const how = world.onRun[step.name] ?? {}
      if (how.throws) throw new Error(how.throws)
      for (const p of how.binds ?? []) world.bound.add(p)
      const gone = 'exit' in how
      const r: Running = { step: step.name, pid: 100 + ran.length, keep: !!step.keep, alive: () => !gone, exitCode: () => (gone ? how.exit ?? null : null), stop: async () => {}, log: `C:\\logs\\${step.name}.log` }
      return r
    },
    tail: () => 'last line of its log',
    say: line => said.push(line),
    sleep: async ms => { clock += ms },
    now: () => clock,
  }
  return { deps, said, ran }
}

describe('startApp', () => {
  it('starts what is not running, in the order given, each in its own folder, and names the address to open', async () => {
    const { deps, said, ran } = harness({ bound: new Set(), checks: {}, onRun: { database: { binds: [5433], exit: 0 }, 'model server': { binds: [8081] }, 'web app': { binds: [3000] } } })
    const out = await startApp(game([
      { name: 'database', port: 5433, exe: 'docker', args: ['compose', 'up', '-d'], cwd: 'db' },
      { name: 'model server', model: true, port: 8081 },
      { name: 'web app', port: 3000, exe: 'cmd.exe', args: ['/c', 'npm', 'run', 'dev'], cwd: 'web' },
    ]), deps)
    expect(out.ok).toBe(true)
    expect(out.open).toBe('http://localhost:3000')
    expect(ran.map(r => r.step)).toEqual(['database', 'model server', 'web app'])
    expect(ran[0].launch).toEqual({ exe: 'docker', args: ['compose', 'up', '-d'], cwd: `${ROOT}\\db` })
    expect(ran[1].launch).toEqual(LAUNCH)
    expect(ran[2].launch.cwd).toBe(`${ROOT}\\web`)
    expect(said.join('\n')).toMatch(/database: started \(port 5433/)
    expect(out.model?.running?.step).toBe('model server')
  })

  it('starts nothing that is already running', async () => {
    const { deps, said, ran } = harness({ bound: new Set([5433, 3000]), checks: {}, onRun: {} })
    const out = await startApp(game([
      { name: 'database', port: 5433, exe: 'docker', args: ['compose', 'up', '-d'], cwd: 'db' },
      { name: 'web app', port: 3000, exe: 'cmd.exe', args: ['/c', 'npm', 'run', 'dev'], cwd: 'web' },
    ]), deps)
    expect(out.ok).toBe(true)
    expect(ran).toEqual([])
    expect(said).toEqual(['database: already running (port 5433)', 'web app: already running (port 3000)'])
  })

  it('takes a command that exits 0 as the readiness of what has no port', async () => {
    const { deps, said, ran } = harness({ bound: new Set(), checks: { 'docker info': true }, onRun: {} })
    const out = await startApp(game([{ name: 'Docker Desktop', check: { exe: 'docker', args: ['info'] }, exe: 'C:\\Docker\\Docker Desktop.exe', args: [], keep: true }]), deps)
    expect(out.ok).toBe(true)
    expect(ran).toEqual([])
    expect(said).toEqual(['Docker Desktop: already running'])
  })

  it('stops at the step that did not come up, says how long it waited and shows the end of its log', async () => {
    const { deps, said, ran } = harness({ bound: new Set(), checks: {}, onRun: {} })
    const out = await startApp(game([
      { name: 'database', port: 5433, exe: 'docker', args: ['compose', 'up', '-d'], cwd: 'db', waitSeconds: 20 },
      { name: 'web app', port: 3000, exe: 'cmd.exe', args: ['/c', 'npm', 'run', 'dev'], cwd: 'web' },
    ]), deps)
    expect(out.ok).toBe(false)
    expect(out.open).toBeUndefined()
    expect(ran.map(r => r.step)).toEqual(['database'])
    expect(said.join('\n')).toMatch(/database: nothing was listening on port 5433 after 20 s/)
    expect(said.join('\n')).toContain('last line of its log')
    expect(said.join('\n')).toContain('game is not opened')
  })

  it('does not wait out the time for a step whose process ended with an error', async () => {
    const { deps, said } = harness({ bound: new Set(), checks: {}, onRun: { 'web app': { exit: 1 } } })
    const out = await startApp(game([{ name: 'web app', port: 3000, exe: 'cmd.exe', args: ['/c', 'npm', 'run', 'dev'], cwd: 'web', waitSeconds: 600 }]), deps)
    expect(out.ok).toBe(false)
    expect(said.join('\n')).toMatch(/web app: its process ended \(exit code 1\) before anything listened on port 3000/)
  })

  it('waits for an address to answer when listening is not yet being ready, as a model server that is loading', async () => {
    const url = 'http://127.0.0.1:8081/health'
    const { deps, said } = harness({ bound: new Set(), checks: {}, onRun: { 'model server': { binds: [8081] } }, answersAfter: { [url]: 6 } })
    const out = await startApp(game([{ name: 'model server', model: true, port: 8081, url }]), deps)
    expect(out.ok).toBe(true)
    // Five looks half a second apart came back empty before the sixth answered.
    expect(said).toEqual(['model server: started (port 8081, 3 s)'])
  })

  it('says so when a step is not running and the recipe has no way to start it', async () => {
    const { deps, said } = harness({ bound: new Set(), checks: {}, onRun: {} })
    const out = await startApp(game([{ name: 'Ollama', port: 11434 }]), deps)
    expect(out.ok).toBe(false)
    expect(said[0]).toBe('Ollama: nothing is listening on port 11434, and CynCo does not start it')
  })

  it('reports a process that could not be started, with the reason', async () => {
    const { deps, said } = harness({ bound: new Set(), checks: {}, onRun: { 'web app': { throws: 'F222: no Git Bash' } } })
    const out = await startApp(game([{ name: 'web app', port: 3000, exe: 'bash', args: ['run.sh'] }]), deps)
    expect(out.ok).toBe(false)
    expect(said[0]).toMatch(/web app: could not be started \(bash run\.sh\): F222: no Git Bash/)
  })

  it('starts a window app that has nothing to wait for, and holds it', async () => {
    const { deps, said, ran } = harness({ bound: new Set(), checks: {}, onRun: {} })
    const out = await startApp(game([{ name: 'game', exe: 'C:\\Python314\\python.exe', args: ['-m', 'gilded'] }], null), deps)
    expect(out.ok).toBe(true)
    expect(out.open).toBeUndefined()
    expect(ran[0].launch).toEqual({ exe: 'C:\\Python314\\python.exe', args: ['-m', 'gilded'], cwd: ROOT })
    expect(said).toEqual(['game: started'])
    expect(out.running.map(r => r.step)).toEqual(['game'])
  })

  describe('the model server', () => {
    const steps: AppStep[] = [{ name: 'model server', model: true, port: 8081 }]

    it('is not started when CynCo\'s own server holds the port: the app is answered by it', async () => {
      const { deps, said, ran } = harness({ bound: new Set([8081]), checks: {}, onRun: {}, holder: { owner: 'engine', detail: 'a CynCo engine', listener } })
      const out = await startApp(game(steps), deps)
      expect(out.ok).toBe(true)
      expect(ran).toEqual([])
      expect(said[0]).toMatch(/CynCo's own model server holds port 8081.*game is answered by it/)
      expect(out.model).toMatchObject({ running: null })
    })

    it('is not started twice', async () => {
      const { deps, said, ran } = harness({ bound: new Set([8081]), checks: {}, onRun: {}, holder: { owner: 'app', app: asApp('game'), detail: 'game\'s model server', listener, discovered: false, launcherPid: 5 } })
      expect((await startApp(game(steps), deps)).ok).toBe(true)
      expect(ran).toEqual([])
      expect(said).toEqual(['model server: already running (port 8081, pid 77)'])
    })

    it('leaves another server on the port alone, and says whose', async () => {
      const { deps, said, ran } = harness({ bound: new Set([8081]), checks: {}, onRun: {}, holder: { owner: 'foreign', detail: 'pid 77 (llama-server.exe), not started by a CynCo engine', listener } })
      expect((await startApp(game(steps), deps)).ok).toBe(true)
      expect(ran).toEqual([])
      expect(said[0]).toMatch(/port 8081 is held by pid 77 \(llama-server\.exe\).*game's own server is not started/)
    })

    it('cannot be started for an entry that has no launcher', async () => {
      const { deps, said } = harness({ bound: new Set(), checks: {}, onRun: {} })
      const out = await startApp({ id: 'reader', name: 'reader', root: ROOT, start: { steps } }, deps)
      expect(out.ok).toBe(false)
      expect(said[0]).toMatch(/model server: reader's registry entry has no "launch"/)
    })
  })
})

describe('tendModelOnce', () => {
  const step: AppStep = { name: 'model server', model: true, port: 8081 }
  const tend = (world: World, running: Running | null) => {
    const h = harness(world)
    const model = { step, launch: LAUNCH, running }
    const state = { free: 0 }
    const once = () => tendModelOnce(game([step]), model, { ...h.deps, claimDebt: () => { const d = !!world.debt; world.debt = false; return d } }, state)
    return { ...h, model, once }
  }
  const dead: Running = { step: 'model server', pid: 9, keep: false, alive: () => false, exitCode: () => 1, log: '', stop: async () => {} }

  it('starts the app\'s own server once the port has stayed free, and not while CynCo holds it', async () => {
    const world: World = { bound: new Set([8081]), checks: {}, onRun: { 'model server': { binds: [8081] } } }
    const t = tend(world, null)
    await t.once()
    expect(t.ran).toEqual([])
    world.bound.delete(8081)
    await t.once()
    expect(t.ran).toEqual([])
    await t.once()
    expect(t.ran.map(r => r.step)).toEqual(['model server'])
    expect(t.model.running?.alive()).toBe(true)
    expect(t.said.join('\n')).toMatch(/port 8081 is free: game's own model server is started/)
  })

  it('takes over what CynCo owes the app, so the engine does not start a second, windowless server', async () => {
    const world: World = { bound: new Set([8081]), checks: {}, onRun: {}, debt: true }
    const t = tend(world, dead)
    await t.once()
    expect(world.debt).toBe(false)
    expect(t.said[0]).toMatch(/CynCo took the GPU.*this window starts game's own server again/)
    await t.once()
    expect(t.said).toHaveLength(1)
  })

  it('does nothing while the server it started is alive', async () => {
    const world: World = { bound: new Set(), checks: {}, onRun: {} }
    const alive: Running = { ...dead, alive: () => true, exitCode: () => null }
    const t = tend(world, alive)
    await t.once(); await t.once(); await t.once()
    expect(t.ran).toEqual([])
  })
})
