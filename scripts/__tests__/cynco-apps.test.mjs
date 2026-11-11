// A mission dispatch follows the rule a chat turn and a one-shot follow (F219):
// an app's model server on CynCo's port is named, taken, and started again when
// the mission ends. Before this the dispatch killed it by path and nothing
// brought it back.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { runAppsCli } from '../cynco-apps.mjs'

const app = { id: 'dndai', name: 'dndai', root: 'C:\\Users\\o\\dndai', script: 'scripts/start-llm.sh', manage: true, source: 'by hand', launch: { exe: 'bash.exe', args: ['scripts/start-llm.sh'], cwd: 'C:\\Users\\o\\dndai' } }
const listener = { pid: 4242, name: 'llama-server.exe', exe: null, commandLine: 'llama-server.exe --port 8081', created: 1 }

function rig(holder) {
  const calls = { identify: [], displaced: [], gaveBack: 0, ollama: [] }
  const out = []
  const deps = {
    identify: async (port) => { calls.identify.push(port); return holder },
    displace: async (h, ctx) => { calls.displaced.push({ app: h.app.name, port: ctx.port, by: ctx.by }); ctx.say(`${h.app.name}'s model server held port ${ctx.port} (pid ${h.listener.pid}). CynCo stopped it to load its own model.`); return 'displaced' },
    giveBack: async (say) => { calls.gaveBack++; say('CynCo is done with the GPU: dndai\'s model server is started again.') },
    freeOllama: async (ctx) => { calls.ollama.push(ctx.by); return 0 },
    print: (line) => out.push(line),
  }
  return { deps, calls, out }
}

describe('cynco-apps take', () => {
  it('an app\'s server on the model port is taken for the mission by the app module, and what was said is printed', async () => {
    const r = rig({ owner: 'app', app, listener, detail: 'dndai\'s model server (pid 4242)', discovered: false, launcherPid: 4000 })
    expect(await runAppsCli(['take', '--port', '8081', '--by', 'the mission c12-wave1'], r.deps)).toBe(0)
    expect(r.calls.identify).toEqual([8081])
    expect(r.calls.displaced).toEqual([{ app: 'dndai', port: 8081, by: 'the mission c12-wave1' }])
    expect(r.out.join('\n')).toContain('[apps] dndai\'s model server held port 8081 (pid 4242)')
    // Ollama is asked too: a model it holds for an app would leave the mission's model no room.
    expect(r.calls.ollama).toEqual(['the mission c12-wave1'])
  })

  it('an engine\'s, a foreign or an unreadable server is left to the dispatch\'s own sweep', async () => {
    for (const holder of [{ owner: 'engine', detail: 'e', listener }, { owner: 'foreign', detail: 'f', listener }, { owner: 'unknown', detail: 'u' }]) {
      const r = rig(holder)
      expect(await runAppsCli(['take', '--by', 'the mission x'], r.deps)).toBe(0)
      expect(r.calls.displaced).toEqual([])
    }
  })

  it('the port defaults to LOCALCODE_PORT, else 8081', async () => {
    const r = rig({ owner: 'unknown', detail: 'u' })
    await runAppsCli(['take', '--by', 'x'], r.deps, {})
    await runAppsCli(['take', '--by', 'x'], r.deps, { LOCALCODE_PORT: '18081' })
    expect(r.calls.identify).toEqual([8081, 18081])
  })

  it('a failure to identify is said and is not a reason to stop a dispatch: exit 0', async () => {
    const r = rig(null)
    r.deps.identify = async () => { throw new Error('powershell is gone') }
    expect(await runAppsCli(['take', '--by', 'x'], r.deps)).toBe(0)
    expect(r.out.join('\n')).toMatch(/could not ask whose server holds port 8081: powershell is gone/)
  })
})

describe('cynco-apps give-back', () => {
  it('starts again what is owed and prints what was said', async () => {
    const r = rig(null)
    expect(await runAppsCli(['give-back'], r.deps)).toBe(0)
    expect(r.calls.gaveBack).toBe(1)
    expect(r.out.join('\n')).toContain('[apps] CynCo is done with the GPU')
  })

  it('an unknown command is a usage error', async () => {
    const r = rig(null)
    expect(await runAppsCli(['frobnicate'], r.deps)).toBe(2)
  })
})

describe('the mission path uses it', () => {
  const sh = readFileSync('scripts/dispatch-mission.sh', 'utf-8')

  it('dispatch-mission.sh takes the port from an app before its own kill sweep', () => {
    const take = sh.indexOf('bun scripts/cynco-apps.mjs take')
    const sweep = sh.indexOf('lc_llama_pids()')
    expect(take).toBeGreaterThan(0)
    expect(take).toBeLessThan(sweep)
    expect(sh).toMatch(/cynco-apps\.mjs take --by "the mission \$STAMP"/)
  })

  it('the idle engine booted after a mission is lazy: it must not take the GPU straight back from the app the mission engine just restored', () => {
    expect(sh).toMatch(/LOCALCODE_LLAMA_LAZY=true[^\n]*bun engine\/main\.ts > "\$IDLE_LOG"/)
  })

  it('the driver gives back after a teardown that ended in the hand kill, where the engine could not', () => {
    const driver = readFileSync('scripts/cynco-mission-driver.mjs', 'utf-8')
    expect(driver).toMatch(/cynco-apps\.mjs', 'give-back'/)
  })
})
