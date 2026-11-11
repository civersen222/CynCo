// scripts/cynco-apps.mjs
// The owner's local-LLM apps, for the scripts that start and end a mission (F219).
//
// A mission dispatch starts from a fresh engine and used to kill whatever chat
// model server it found under ~/.cynco, the owner's game's included, and nothing
// brought that server back. The rule a chat turn and a one-shot follow lives in
// engine/apps (docs/decisions/2026-11-11-local-llm-apps.md); this is how a shell
// script asks for it.
//
//   bun scripts/cynco-apps.mjs take --by "the mission <name>" [--port N]
//       An app's model server on the model port is stopped, named, and owed its
//       server back when the app is in use; Ollama is asked to unload what it
//       holds for the owner's apps. Any other server on the port is left for
//       the dispatch's own sweep. Always exits 0: not knowing whose server it
//       is must not stop a mission, and the sweep that follows is unchanged.
//   bun scripts/cynco-apps.mjs give-back
//       Start again what is owed (for a teardown that ended in the hand kill,
//       where the engine could not do it on its way out).
//   bun scripts/cynco-apps.mjs start <id>
//       Start one of the owner's apps from the "start" section of its entry in
//       ~/.cynco/apps.json, open it, and stay until the window is closed
//       (engine/apps/desk.ts). What a Desktop icon runs, through
//       scripts/cynco-app.cmd. Exits 1, having said why, when the app could not
//       be started.
//   bun scripts/cynco-apps.mjs icons [--repo DIR] [--desktop DIR]
//       Create or refresh one Desktop shortcut per app that has a "start"
//       section. --repo is the checkout the icons run the launcher from
//       (default: this one).
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function realDeps() {
  const [{ identifyPortHolder }, { displaceApp }, gpu, { freeOllamaForCynco }, desk] = await Promise.all([
    import('../engine/apps/identify.js'), import('../engine/apps/displace.js'), import('../engine/apps/gpu.js'), import('../engine/apps/ollama.js'),
    import('../engine/apps/desk.js'),
  ])
  return {
    identify: (port) => identifyPortHolder(port),
    displace: (holder, ctx) => displaceApp(holder, { ...ctx, kill: (pid) => gpu.stopProcess(pid) }),
    giveBack: (say) => gpu.giveGpuBack(say),
    freeOllama: (ctx) => freeOllamaForCynco(ctx),
    start: async (id, print) => {
      // Closing the window (SIGHUP), Ctrl+C and Ctrl+Break all mean the same: stop what this window started.
      const closed = new AbortController()
      for (const signal of ['SIGHUP', 'SIGINT', 'SIGBREAK', 'SIGTERM']) process.on(signal, () => closed.abort())
      return (await desk.startFromDesk(id, { print, signal: closed.signal })).code
    },
    icons: (opts) => desk.createIcons(opts),
    print: (line) => console.log(line),
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/** The command line, with its dependencies injectable. Resolves to the exit code. */
export async function runAppsCli(argv, deps, env = process.env) {
  const say = (message) => deps.print(`[apps] ${message}`)
  const [command] = argv
  if (command === 'take') {
    const port = Number(flag(argv, '--port') ?? env.LOCALCODE_PORT ?? 8081)
    const by = flag(argv, '--by') ?? 'a mission'
    try {
      const holder = await deps.identify(port)
      if (holder.owner === 'app') await deps.displace(holder, { port, by, say })
    } catch (e) {
      say(`could not ask whose server holds port ${port}: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      await deps.freeOllama({ by, say })
    } catch (e) {
      say(`could not ask Ollama to unload: ${e instanceof Error ? e.message : String(e)}`)
    }
    return 0
  }
  if (command === 'give-back') {
    await deps.giveBack(say)
    return 0
  }
  if (command === 'start') {
    const id = argv[1]
    if (!id || id.startsWith('--')) {
      deps.print('usage: bun scripts/cynco-apps.mjs start <app id>')
      return 2
    }
    try {
      return await deps.start(id, deps.print)
    } catch (e) {
      deps.print(`${id} could not be started: ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
  }
  if (command === 'icons') {
    try {
      await deps.icons({ repo: resolve(flag(argv, '--repo') ?? resolve(import.meta.dirname, '..')), desktop: flag(argv, '--desktop'), print: deps.print })
      return 0
    } catch (e) {
      deps.print(`the icons could not be created: ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
  }
  deps.print('usage: bun scripts/cynco-apps.mjs take --by "<who>" [--port N] | give-back | start <app id> | icons [--repo DIR] [--desktop DIR]')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await runAppsCli(process.argv.slice(2), await realDeps()))
}
