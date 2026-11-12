// F227: an app's launch never starts Docker.
//
// The first dndai recipe began with "Docker Desktop" and `docker compose up -d`, because dndai's own
// documents say its database is a Docker container. The owner had ruled Docker out on this PC long
// before: it takes the memory the larger models need. Nothing had it written down. The owner's words on
// seeing it: "DOCKER IS TOO ... MEMORY HUNGRY TO RUN ALONG SIDE OUR LARGER LLMS".
//
// Three guards: the launcher refuses such a step whatever the registry file says; nothing discovery can
// produce has a recipe at all; and no recipe written in this repository names Docker.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverApp, discoverByFolder } from '../../apps/identify.js'
import { namesDocker, startApp, type Running, type StartDeps, type Startable } from '../../apps/start.js'
import type { AppStep } from '../../apps/registry.js'

const ROOT = 'C:\\Users\\o\\game'
function rig() {
  const said: string[] = []
  const ran: string[] = []
  const checked: string[] = []
  // What a started step binds, so a wait for its port ends; and a clock that moves when the code sleeps.
  const bound = new Set<number>()
  let clock = 0
  const deps: StartDeps = {
    portBound: async port => bound.has(port),
    answers: async () => false,
    identify: async () => ({ owner: 'unknown', detail: 'unread' }),
    check: async (exe, args) => { checked.push([exe, ...args].join(' ')); return false },
    run: async (launch, step) => { ran.push(step.name); if (step.port) bound.add(step.port); const r: Running = { step: step.name, pid: 1, keep: false, alive: () => true, exitCode: () => null, log: '', stop: async () => {} }; void launch; return r },
    say: l => said.push(l),
    sleep: async ms => { clock += ms },
    now: () => clock,
  }
  return { deps, said, ran, checked }
}
const game = (steps: AppStep[], launch?: Startable['launch']): Startable => ({ id: 'game', name: 'game', root: ROOT, ...(launch ? { launch } : {}), start: { steps, open: 'http://localhost:3000' } })

describe('the launcher refuses Docker', () => {
  const dockerSteps: AppStep[] = [
    { name: 'Docker Desktop', check: { exe: 'docker', args: ['info'] }, exe: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', args: [], keep: true },
    { name: 'database', port: 5433, exe: 'docker', args: ['compose', 'up', '-d'], cwd: 'db' },
    { name: 'database', port: 5433, exe: 'docker-compose.exe', args: ['up', '-d'] },
    { name: 'database', port: 5433, exe: 'cmd.exe', args: ['/c', 'npm', 'run', 'db:up', '&&', 'DOCKER', 'ps'] },
    { name: 'engine up', check: { exe: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', args: ['info'] } },
    { name: 'docker', port: 2375 },
  ]

  for (const step of dockerSteps) {
    it(`a step that ${step.exe ? `runs ${step.exe} ${(step.args ?? []).join(' ')}` : step.check ? `asks ${step.check.exe}` : `is called ${step.name}`} is not run, not asked, and ends the start with the reason`, async () => {
      expect(namesDocker(step)).toBe(true)
      const { deps, said, ran, checked } = rig()
      const out = await startApp(game([{ name: 'web app', port: 3000, exe: 'cmd.exe', args: ['/c', 'npm', 'run', 'dev'] }, step]), deps)
      expect(out.ok).toBe(false)
      expect(out.open).toBeUndefined()
      expect(ran).toEqual(['web app'])
      expect(checked).toEqual([])
      expect(said.join('\n')).toMatch(new RegExp(`${step.name}: CynCo does not start Docker on this PC, or anything that needs it: it takes the memory the models need`))
    })
  }

  it('a model server whose launcher is Docker is refused too', async () => {
    const { deps, said, ran } = rig()
    const out = await startApp(game([{ name: 'model server', model: true, port: 8081 }], { exe: 'docker', args: ['run', 'ghcr.io/x/llama-server'], cwd: ROOT }), deps)
    expect(out.ok).toBe(false)
    expect(ran).toEqual([])
    expect(said[0]).toMatch(/model server: CynCo does not start Docker/)
  })

  it('what the owner does run beside the models is not mistaken for it', () => {
    for (const step of [
      { name: 'database', port: 5433, exe: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu-24.04', '--exec', 'sleep', 'infinity'], always: true },
      { name: 'web app', port: 3000, exe: 'cmd.exe', args: ['/c', 'npm', 'run', 'dev'], cwd: 'web' },
      { name: 'game', exe: 'C:\\Python314\\python.exe', args: ['-m', 'gilded'] },
    ] as AppStep[]) expect(namesDocker(step)).toBe(false)
  })
})

describe('a step that is started even when it answers', () => {
  it('holds what would otherwise stop under the app: the WSL distro the database lives in', async () => {
    const { deps, said, ran } = rig()
    deps.portBound = async () => true
    const out = await startApp(game([{ name: 'database', port: 5433, exe: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu-24.04', '--exec', 'sleep', 'infinity'], always: true }]), deps)
    expect(out.ok).toBe(true)
    expect(ran).toEqual(['database'])
    expect(said).toEqual(['database: started (port 5433, 0 s)'])
    expect(out.running.map(r => r.keep)).toEqual([false])
  })

  it('without it, the same step is left alone when the port answers', async () => {
    const { deps, said, ran } = rig()
    deps.portBound = async () => true
    await startApp(game([{ name: 'database', port: 5433, exe: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu-24.04'] }]), deps)
    expect(ran).toEqual([])
    expect(said).toEqual(['database: already running (port 5433)'])
  })
})

describe('no recipe in this repository names Docker', () => {
  it('discovery produces no recipe at all: what it registers is a model server and how to restart it', () => {
    const proc = (pid: number, name: string, commandLine: string | null) => ({ pid, name, exe: null, commandLine, created: pid })
    // Nothing matches in these calls (no project folder is given); the point is the type discovery returns.
    const found = [
      discoverApp({ listener: proc(2, 'llama-server.exe', 'x'), ancestors: [proc(1, 'bash.exe', 'bash scripts/start-llm.sh')] }, { roots: [] }),
      discoverByFolder({ listener: proc(2, 'llama-server.exe', null), ancestors: [proc(1, 'bash.exe', null)] }, { proc: proc(1, 'bash.exe', null), kind: 'bash' }, 8081, { roots: [], procs: [] }),
    ]
    expect(found).toEqual([null, null])
    const identify = readFileSync('engine/apps/identify.ts', 'utf-8')
    // Neither function writes a `start` section: only a person does, in apps.json.
    expect(identify).not.toMatch(/\bstart\s*:/)
  })

  it('the recipes written down in the decision record do not', () => {
    const doc = readFileSync('docs/decisions/2026-11-11-local-llm-apps.md', 'utf-8')
    const blocks = [...doc.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(m => m[1])
    expect(blocks.length).toBeGreaterThan(0)
    for (const b of blocks) expect(b).not.toMatch(/docker/i)
    // ...nor the one-line recipes quoted in its prose.
    for (const m of doc.matchAll(/`"start": \{[^`]*`/g)) expect(m[0]).not.toMatch(/docker/i)
  })

  it('no launcher code starts it: the only mentions in engine/apps are the refusal and the config-file names the model search reads', () => {
    const dir = 'engine/apps'
    for (const f of readdirSync(dir).filter(n => n.endsWith('.ts'))) {
      const lines = readFileSync(join(dir, f), 'utf-8').split(/\r?\n/).filter(l => /docker/i.test(l))
      if (f === 'start.ts') { expect(lines.every(l => /namesDocker|NO_DOCKER|Docker Desktop takes|never Docker|starts Docker|\/docker\/i/.test(l))).toBe(true); continue }
      if (f === 'ollama.ts') { expect(lines.every(l => /CONFIG_FILE/.test(l))).toBe(true); continue }
      expect({ file: f, lines }).toEqual({ file: f, lines: [] })
    }
    for (const f of ['scripts/cynco-apps.mjs', 'scripts/cynco-app.cmd']) expect(readFileSync(f, 'utf-8')).not.toMatch(/docker/i)
  })
})
