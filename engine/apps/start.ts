/**
 * engine/apps/start.ts — starting one of the owner's apps from its registry recipe.
 *
 * The owner asked for "some sort of launch icon on the desktop for these apps"
 * after the documented command for dndai's model server ran inside WSL (F222).
 * The recipe is the `start` section of the app's entry in `~/.cynco/apps.json`:
 * what must be running, in order, and the address to open
 * (docs/decisions/2026-11-11-local-llm-apps.md, decision 7). This file is the
 * rule, with every process behind `StartDeps`; `desk.ts` is the launcher a
 * Desktop icon runs.
 *
 * A step that is already running is left alone. A step that is not is started
 * and waited for; the first one that does not come up stops the start, says
 * why, and nothing is opened. The model server is one step among them, with the
 * rule for CynCo's model port: CynCo's own server on the port answers the app
 * (same port, same API), so the app's is not started beside it.
 */
import { posix, win32 } from 'path'
import type { Holder } from './identify.js'
import type { AppLaunch, AppStart, AppStep } from './registry.js'

/** What a launcher needs of a registry entry, whichever kind it is. */
export type Startable = { id: string; name: string; root: string; launch?: AppLaunch; start?: AppStart }

/** A process a step started. */
export type Running = {
  step: string
  pid: number | null
  /** Left running when the launcher ends. */
  keep: boolean
  alive: () => boolean
  /** Its exit code once it has ended; null while it runs, or when it was ended by a signal. */
  exitCode: () => number | null
  /** Where its output goes. */
  log: string
  /** End it and everything it started. Does nothing to a step that stays (`keep`). Never rejects. */
  stop: () => Promise<void>
}

export type StartDeps = {
  portBound: (port: number) => Promise<boolean>
  /** Does a GET of this address answer 2xx? */
  answers: (url: string) => Promise<boolean>
  identify: (port: number) => Promise<Holder>
  /** Does this command exit 0? */
  check: (exe: string, args: string[], cwd: string) => Promise<boolean>
  /** Start one step's process. Rejects when it could not be started. */
  run: (launch: AppLaunch, step: AppStep) => Promise<Running>
  /** The last lines of what a process wrote, for the step that failed. */
  tail?: (running: Running) => string
  say: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type ModelHold = { step: AppStep; launch: AppLaunch; running: Running | null }
export type StartOutcome = { ok: boolean; open?: string; running: Running[]; model?: ModelHold }

/**
 * The owner's rule (2026-11-12, F227): an app's launch may only start what the owner already runs beside
 * the models, and never Docker. Docker Desktop takes the memory the larger models need; the first dndai
 * recipe would have started it. A step that starts Docker, runs `docker`, or asks it whether it is up is
 * refused here, whatever the registry file says.
 */
export function namesDocker(step: Pick<AppStep, 'name' | 'exe' | 'args' | 'check'>): boolean {
  return /docker/i.test([step.name, step.exe ?? '', ...(step.args ?? []), step.check?.exe ?? '', ...(step.check?.args ?? [])].join(' '))
}
const NO_DOCKER = 'CynCo does not start Docker on this PC, or anything that needs it: it takes the memory the models need (the owner\'s rule). Take this step out of the recipe; what an app needs must be something the owner already runs beside the models'

const DEFAULT_WAIT_S = 60
const MODEL_WAIT_S = 240
const POLL_MS = 500

/** The step's folder: `cwd` under the app's folder, in the folder's own path style whatever the host. */
function folderOf(root: string, cwd: string | undefined): string {
  const p = /\\|^[A-Za-z]:/.test(root) ? win32 : posix
  return cwd ? p.resolve(root, cwd) : root
}

const where = (step: AppStep): string => (step.port ? `port ${step.port}` : '')

async function isReady(step: AppStep, cwd: string, deps: StartDeps): Promise<boolean> {
  if (step.url) return deps.answers(step.url)
  if (step.port) return deps.portBound(step.port)
  if (step.check) return deps.check(step.check.exe, step.check.args, cwd)
  return false
}

/** Start a step's process and wait until it is ready. Null: it is up. Otherwise why it is not. */
async function runAndWait(step: AppStep, launch: AppLaunch, deps: StartDeps, waitS: number, into: Running[]): Promise<string | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const cmd = [launch.exe, ...launch.args].join(' ')
  let running: Running
  try {
    running = await deps.run(launch, step)
  } catch (e) {
    return `could not be started (${cmd}): ${e instanceof Error ? e.message : String(e)}`
  }
  into.push(running)
  if (!step.url && !step.port && !step.check) return null
  const began = now()
  const what = step.url ? `${step.url} answered` : step.port ? `anything listened on port ${step.port}` : `${step.check!.exe} ${step.check!.args.join(' ')} succeeded`
  const tail = () => {
    const t = deps.tail?.(running).trim()
    return t ? `\n${t.split('\n').map(l => `    ${l}`).join('\n')}\n    (${running.log})` : ` (${running.log})`
  }
  for (;;) {
    if (await isReady(step, launch.cwd, deps)) return null
    // A command that ends cleanly may have handed over to something that is still coming up (a service start).
    if (!running.alive() && running.exitCode() !== 0) return `its process ended (exit code ${running.exitCode() ?? 'none'}) before ${what}${tail()}`
    if (now() - began >= waitS * 1000) {
      return `${step.url ? `${step.url} did not answer` : step.port ? `nothing was listening on port ${step.port}` : `${step.check!.exe} ${step.check!.args.join(' ')} still failed`} after ${waitS} s${tail()}`
    }
    await sleep(POLL_MS)
  }
}

/**
 * Start what the recipe lists and is not running. `ok: false` names the step
 * that stopped it; nothing is opened then, and what was started is left to the
 * caller (the desk launcher's window owns it).
 */
export async function startApp(app: Startable, deps: StartDeps): Promise<StartOutcome> {
  const now = deps.now ?? Date.now
  const running: Running[] = []
  let model: ModelHold | undefined
  const fail = (step: AppStep, why: string): StartOutcome => {
    deps.say(`${step.name}: ${why}`)
    if (app.start!.open) deps.say(`${app.name} is not opened.`)
    return { ok: false, running, model }
  }
  for (const step of app.start?.steps ?? []) {
    const began = now()
    const took = () => `${Math.round((now() - began) / 1000)} s`
    if (namesDocker(step) || (step.model && app.launch && namesDocker({ name: '', exe: app.launch.exe, args: app.launch.args }))) return fail(step, NO_DOCKER)
    if (step.model) {
      if (!app.launch || !step.port) return fail(step, `${app.name}'s registry entry has no "launch"${step.port ? '' : ' and the step no "port"'}: CynCo does not know how its model server is started`)
      model = { step, launch: app.launch, running: null }
      if (await deps.portBound(step.port)) {
        const holder = await deps.identify(step.port)
        if (holder.owner === 'engine') {
          deps.say(`${step.name}: CynCo's own model server holds port ${step.port}; ${app.name} is answered by it (same port, same API), and ${app.name}'s own server is started when CynCo lets go of the port`)
        } else if (holder.owner === 'app' && holder.app.id === app.id) {
          deps.say(`${step.name}: already running (port ${step.port}, pid ${holder.listener.pid})`)
        } else {
          deps.say(`${step.name}: port ${step.port} is held by ${holder.detail}; ${app.name}'s own server is not started while it is`)
        }
        continue
      }
      const why = await runAndWait(step, app.launch, deps, step.waitSeconds ?? MODEL_WAIT_S, running)
      if (why) return fail(step, why)
      model.running = running[running.length - 1]
      deps.say(`${step.name}: started (port ${step.port}, ${took()})`)
      continue
    }
    const cwd = folderOf(app.root, step.cwd)
    // `always`: what only stays up while something holds it is started even when it answers right now.
    if (!step.always && await isReady(step, cwd, deps)) {
      deps.say(`${step.name}: already running${step.port ? ` (${where(step)})` : ''}`)
      continue
    }
    if (!step.exe) {
      return fail(step, `${step.port ? `nothing is listening on port ${step.port}` : 'it is not running'}, and CynCo does not start it`)
    }
    const why = await runAndWait(step, { exe: step.exe, args: step.args ?? [], cwd }, deps, step.waitSeconds ?? DEFAULT_WAIT_S, running)
    if (why) return fail(step, why)
    deps.say(step.url || step.port || step.check ? `${step.name}: started (${step.port ? `${where(step)}, ` : ''}${took()})` : `${step.name}: started`)
  }
  return { ok: true, open: app.start?.open, running, model }
}

export type TendDeps = StartDeps & {
  /** Take over what CynCo owes this app (`displaced-apps.json`): true when there was a debt. */
  claimDebt: (appId: string) => boolean
}

/**
 * One look at the model port while the launcher's window is open. The window
 * owns the app's model server: when CynCo took the port for its own work, the
 * debt is taken over here, so the engine does not start a second server that has
 * no window to close; and when the port has stayed free for two looks, the
 * app's own server is started again.
 */
export async function tendModelOnce(app: Startable, model: ModelHold, deps: TendDeps, state: { free: number }): Promise<void> {
  const port = model.step.port!
  if (deps.claimDebt(app.id)) {
    deps.say(`${model.step.name}: CynCo took the GPU for its own work; ${app.name} is answered by CynCo's server meanwhile, and this window starts ${app.name}'s own server again when the port is free`)
  }
  if (model.running?.alive()) { state.free = 0; return }
  if (await deps.portBound(port)) { state.free = 0; return }
  if (++state.free < 2) return
  state.free = 0
  try {
    model.running = await deps.run(model.launch, model.step)
    deps.say(`${model.step.name}: port ${port} is free: ${app.name}'s own model server is started`)
  } catch (e) {
    deps.say(`${model.step.name}: could not be started (${[model.launch.exe, ...model.launch.args].join(' ')}): ${e instanceof Error ? e.message : String(e)}`)
  }
}
