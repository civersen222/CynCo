/**
 * engine/apps/displace.ts — taking the GPU from an app, and giving it back.
 *
 * One rule for a chat turn and for a daemon one-shot
 * (docs/decisions/2026-11-11-local-llm-apps.md): when CynCo needs the GPU and
 * an app's model server holds CynCo's port, CynCo stops that server, says which
 * app, and owes the app its server back. The debt is written to
 * `~/.cynco/displaced-apps.json`, because the process that takes the GPU and
 * the one that later gives it back are not always the same (a one-shot's child,
 * an engine that died). An app that is not running is owed nothing: its server
 * was a leftover (F202), and "if it's not being used the models should not be
 * loaded".
 *
 * Giving back starts the app's own launcher, in the app's folder, outside the
 * engine's kill-on-close job: a process the engine spawned directly would die
 * with the engine (F131), which is right for CynCo's servers and wrong for the
 * owner's game.
 */
import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { cyncoHome } from '../paths.js'
import { throughGitBash } from './gitBash.js'
import { writeJsonAtomic, type AppLaunch, type LocalApp } from './registry.js'
import { listProcesses as readProcessList, type ListedProc, type Proc } from './portTree.js'

export type Displaced = { appId: string; name: string; root: string; port: number; at: string; by: string; launch: AppLaunch }

/** A debt older than this is dropped: the owner has long since moved on, and a 20 GB model must not appear out of nowhere. */
export const MAX_DISPLACED_AGE_MS = 24 * 60 * 60 * 1000

export function displacedFile(): string {
  return join(cyncoHome(), 'displaced-apps.json')
}

export function readDisplaced(file: string = displacedFile(), log: (line: string) => void = console.log): Displaced[] {
  if (!existsSync(file)) return []
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    return Array.isArray(j) ? j.filter((d): d is Displaced => !!d && typeof d.appId === 'string' && typeof d.port === 'number' && !!d.launch) : []
  } catch (e) {
    log(`[apps] ${file} could not be read (${e instanceof Error ? e.message : String(e)}); nothing is owed until it is fixed`)
    return []
  }
}

/**
 * Drop what is owed to one app, because something else has taken over starting its server again
 * (the desk launcher's window, `desk.ts`). True when there was a debt.
 */
export function forgetDebt(appId: string, file: string = displacedFile(), log: (line: string) => void = console.log): boolean {
  const owed = readDisplaced(file, log)
  if (!owed.some(d => d.appId === appId)) return false
  writeJsonAtomic(file, owed.filter(d => d.appId !== appId))
  return true
}

const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase()

/**
 * Is anything of the app running besides its model server? A process whose
 * command line or executable is under the app's folder, other than the server's
 * own tree: `launcherPid` (the script that started the server) and everything it
 * started. Not the launcher's own ancestors: the terminal that ran the launcher
 * very likely ran the app too, and what it started is exactly what is looked for.
 */
export function appInUse(app: Pick<LocalApp, 'root'>, launcherPid: number, procs: ListedProc[]): boolean {
  const tree = new Set<number>([launcherPid])
  for (let grew = true; grew;) {
    grew = false
    for (const p of procs) if (!tree.has(p.pid) && tree.has(p.ppid) && p.ppid !== 0) { tree.add(p.pid); grew = true }
  }
  const root = norm(app.root).replace(/\/+$/, '') + '/'
  return procs.some(p => !tree.has(p.pid) && (norm(p.commandLine).includes(root) || norm(p.exe).startsWith(root)))
}

/** A pid the caller may not signal still exists (EPERM); only "no such process" is gone. */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

/**
 * The other servers the app's launcher started beside the model server: the processes in the launcher's
 * tree, other than the launcher, the server and what the server itself started, whose command line names
 * a port. dndai's launcher starts an embeddings server on 8082 this way and stops it when the chat server
 * ends. A console host or a helper with no port is not something the app is answered by, and is not listed.
 */
export function launcherSiblings(launcherPid: number, listenerPid: number, procs: ListedProc[]): Array<{ pid: number; what: string }> {
  const under = (root: number): Set<number> => {
    const tree = new Set<number>([root])
    for (let grew = true; grew;) {
      grew = false
      for (const p of procs) if (!tree.has(p.pid) && tree.has(p.ppid) && p.ppid !== 0) { tree.add(p.pid); grew = true }
    }
    return tree
  }
  const ofLauncher = under(launcherPid), ofServer = under(listenerPid)
  const out: Array<{ pid: number; what: string }> = []
  for (const p of procs) {
    if (!ofLauncher.has(p.pid) || ofServer.has(p.pid) || p.pid === launcherPid) continue
    const port = /--port[ =](\d+)/.exec(p.commandLine)?.[1]
    if (!port) continue
    const name = /--embeddings?\b/.test(p.commandLine) ? 'its embeddings server' : basename(p.exe.replace(/\\/g, '/')) || 'a process'
    out.push({ pid: p.pid, what: `${name} on port ${port} (pid ${p.pid})` })
  }
  return out
}

export type DisplaceCtx = {
  port: number
  /** Who is taking the GPU, for the record: `the chat engine (pid N)`, `the one-shot digest-espn`. */
  by: string
  /** Stop the process. `{ stopped: false, why }` when it is still there; a kill that answers nothing is taken at its word. */
  kill: (pid: number) => Promise<{ stopped: true } | { stopped: false; why: string } | void>
  say: (message: string) => void
  file?: string
  listProcesses?: () => Promise<ListedProc[]>
  /** Is there still a process with this pid? For what the launcher took down with its server. */
  exists?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
  log?: (line: string) => void
}

/**
 * Stop an app's model server for CynCo's work. `displaced`: its server is owed back. `leftover`: the app
 * was not running. `refused`: it could not be stopped (it runs as administrator, F223): that is said, with
 * what the owner can do, nothing is owed, and nothing is called stopped.
 */
export async function displaceApp(holder: { app: LocalApp; listener: Proc; launcherPid?: number | null }, ctx: DisplaceCtx): Promise<'displaced' | 'leftover' | 'refused'> {
  const { app, listener } = holder
  const log = ctx.log ?? console.log
  let inUse = true
  let beside: Array<{ pid: number; what: string }> = []
  try {
    const procs = await (ctx.listProcesses ?? readProcessList)()
    inUse = appInUse(app, holder.launcherPid ?? listener.pid, procs)
    if (holder.launcherPid) beside = launcherSiblings(holder.launcherPid, listener.pid, procs)
  } catch (e) {
    // Not knowing is not a reason to leave the owner's game without its server.
    log(`[apps] could not tell whether ${app.name} is running (${e instanceof Error ? e.message : String(e)}); taking it to be`)
  }
  const held = `${app.name}'s model server held port ${ctx.port} (pid ${listener.pid})`
  const file = ctx.file ?? displacedFile()
  if (inUse) {
    const owed: Displaced = { appId: app.id, name: app.name, root: app.root, port: ctx.port, at: (ctx.now ?? (() => new Date()))().toISOString(), by: ctx.by, launch: app.launch }
    try {
      writeJsonAtomic(file, [...readDisplaced(file, log).filter(d => d.appId !== app.id), owed])
    } catch (e) {
      log(`[apps] the debt to ${app.name} could not be written to ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const result = await ctx.kill(listener.pid)
  if (result && !result.stopped) {
    // The debt was written first so that a crash between the two could not lose it; the server is still there, so nothing is owed.
    if (inUse) {
      try { forgetDebt(app.id, file, log) } catch (e) { log(`[apps] the debt to ${app.name} could not be taken back from ${file}: ${e instanceof Error ? e.message : String(e)}`) }
    }
    const instead = app.start
      ? `start ${app.name} from its Desktop icon, which does not run as administrator and which CynCo can manage`
      : `start ${app.name} again from a window that is not run as administrator`
    ctx.say(`${app.name}'s model server holds port ${ctx.port} (pid ${listener.pid}). CynCo could not stop it: ${result.why}. ${app.name} keeps its server and CynCo's model is not loaded. Close the window ${app.name} was started from, or ${instead}.`)
    return 'refused'
  }
  if (!inUse) {
    ctx.say(`${held} with ${app.name} itself not running. CynCo stopped it to load its own model; it is not started again.`)
    return 'leftover'
  }
  // CynCo's server takes the same port and speaks the same API as a llama-server: the app's next request is answered by it.
  const meanwhile = /^llama-server(\.exe)?$/i.test(listener.name)
    ? `: ${app.name} is answered by CynCo's server on the same port meanwhile, and its own server is started again when CynCo is done.`
    : '; it is started again when CynCo is done.'
  // "Answered by CynCo's server" is true for the port CynCo takes and for nothing else the launcher ran.
  // A launcher that ends with its server takes those down too: seen live 2026-11-12, dndai's embeddings on 8082.
  let lost: typeof beside = []
  if (beside.length > 0) {
    const exists = ctx.exists ?? processExists
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    for (let i = 0; i < 20; i++) {
      lost = beside.filter(b => !exists(b.pid))
      if (lost.length === beside.length) break
      await sleep(100)
    }
  }
  const names = lost.map(l => l.what)
  const also = lost.length === 0 ? ''
    : ` Its launcher also ended ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}: CynCo does not stand in for ${lost.length === 1 ? 'that' : 'those'}, so what ${app.name} does with ${lost.every(l => l.what.startsWith('its embeddings')) ? 'embeddings' : 'them'} is down until its own server is back.`
  ctx.say(`${held}. CynCo stopped it to load its own model${meanwhile}${also}`)
  return 'displaced'
}

export type RestoreDeps = {
  /** A one-shot holds the GPU (`gpu-busy.json` with a live owner). */
  gpuBusy: () => boolean
  isPortOccupied: (port: number) => Promise<boolean>
  say: (message: string) => void
  file?: string
  listProcesses?: () => Promise<ListedProc[]>
  launch?: (launch: AppLaunch) => Promise<number | null>
  now?: () => Date
  log?: (line: string) => void
}

/**
 * CynCo is done with the GPU: start again every app server that is owed, whose
 * app is still running and whose port is free. Never throws; what it could not
 * do stays owed and is tried again the next time CynCo lets go of the GPU.
 */
export async function restoreDisplacedApps(deps: RestoreDeps): Promise<void> {
  const log = deps.log ?? console.log
  const file = deps.file ?? displacedFile()
  const owed = readDisplaced(file, log)
  if (owed.length === 0) return
  const now = (deps.now ?? (() => new Date()))().getTime()
  const keep: Displaced[] = []
  let procs: ListedProc[] | null | undefined
  try {
    for (const d of owed) {
      if (now - Date.parse(d.at) > MAX_DISPLACED_AGE_MS) {
        deps.say(`${d.name}'s model server was stopped more than 24 h ago and is not started again.`)
        continue
      }
      if (deps.gpuBusy() || await deps.isPortOccupied(d.port)) { keep.push(d); continue }
      if (procs === undefined) {
        try { procs = await (deps.listProcesses ?? readProcessList)() } catch (e) {
          log(`[apps] could not tell which apps are running (${e instanceof Error ? e.message : String(e)}); what is owed stays owed`)
          procs = null
        }
      }
      if (procs === null) { keep.push(d); continue }
      // The server is gone, so no pid is its tree: any process from the folder counts.
      if (!appInUse({ root: d.root }, -1, procs)) {
        deps.say(`${d.name} is no longer running: its model server is not started again.`)
        continue
      }
      try {
        const pid = await (deps.launch ?? launchOutsideJob)(d.launch)
        deps.say(`CynCo is done with the GPU: ${d.name}'s model server is started again (${basename(d.launch.exe.replace(/\\/g, '/'))} ${d.launch.args.join(' ')}${pid ? `, pid ${pid}` : ''}).`)
      } catch (e) {
        deps.say(`${d.name}'s model server could not be started again: ${e instanceof Error ? e.message : String(e)}`)
        keep.push(d)
      }
    }
  } finally {
    try {
      writeJsonAtomic(file, keep)
    } catch (e) {
      log(`[apps] ${file} could not be written: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * One argument as the Windows C runtime will read it back (F217). Backslashes are literal unless a double
 * quote follows them, so: the backslashes before a quote are doubled and the quote escaped, and the ones at
 * the end are doubled because the closing quote follows them. Escaping the quote alone turned `C:\my dir\`
 * into an argument that swallowed its closing quote and ran into the next one.
 */
function quoteWindowsArg(arg: string, always = false): string {
  if (!always && arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue }
    out += '\\'.repeat(ch === '"' ? slashes * 2 + 1 : slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

/** One Windows command line from an executable and its arguments. */
export function windowsCommandLine(exe: string, args: string[]): string {
  return [quoteWindowsArg(exe, true), ...args.map(a => quoteWindowsArg(a))].join(' ')
}

/**
 * Start a process that is not the engine's child. On Windows through
 * `Win32_Process.Create`: the WMI service creates it, so it is in nobody's job
 * and outlives the engine. Elsewhere a detached spawn. Resolves to its pid.
 * A bash script goes through Git's wrapper bash, whatever the entry names (F222);
 * with no Git Bash on the PC the start is refused, and the caller says so.
 */
export function launchOutsideJob(asRecorded: AppLaunch): Promise<number | null> {
  let launch: AppLaunch
  try { launch = throughGitBash(asRecorded) } catch (e) { return Promise.reject(e) }
  if (process.platform !== 'win32') {
    return new Promise((resolve, reject) => {
      const child = spawn(launch.exe, launch.args, { cwd: launch.cwd, detached: true, stdio: 'ignore' })
      child.on('error', reject)
      child.on('spawn', () => { child.unref(); resolve(child.pid ?? null) })
    })
  }
  const script = [
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(windowsCommandLine(launch.exe, launch.args))}; CurrentDirectory = ${psQuote(launch.cwd)} }`,
    `if ($r.ReturnValue -ne 0) { Write-Error ('Win32_Process.Create returned ' + $r.ReturnValue); exit 1 }`,
    `$r.ProcessId`,
  ].join('; ')
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { reject(new Error(String(stderr || err.message).trim().split('\n')[0])); return }
      const pid = Number(String(stdout).trim())
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null)
    })
  })
}
