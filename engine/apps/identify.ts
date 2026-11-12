/**
 * engine/apps/identify.ts — whose server is on the model port, by name.
 *
 * `portOwner.ts` (F202) could say "a CynCo engine's" or "not CynCo's". The
 * owner's other local-LLM projects start model servers of their own, and the
 * owner asked CynCo to figure out what those are and manage them
 * (docs/decisions/2026-11-11-local-llm-apps.md). This names the app:
 *
 *   1. A CynCo engine's server is recognised first, exactly as before: the
 *      listener's parent is a running bun that is older than it.
 *   2. Otherwise the nearest ancestor that is a shell or interpreter running a
 *      script is the launcher (`bash scripts/start-llm.sh`).
 *   3. An app in the registry whose launch script that is, is the answer.
 *   4. If none is, the owner's project folders are searched for that script.
 *      Exactly one folder that has it, with a script that starts a model
 *      server, is the app; it is written to the registry with the evidence.
 *   5. Anything else is `foreign`, as before, and what cannot be read is
 *      `unknown`.
 *
 * A server started from an administrator window (F223) gives none of that: the
 * command lines of the server and of the shell that started it read as nothing
 * from an engine that is not elevated. What can still be read is the names in
 * the parent chain and the app's own processes that are not elevated, so when
 * the nearest shell's command line cannot be read:
 *
 *   3a. the registered app whose launcher is that kind of script and which is
 *       running (a process from its folder) is the answer, if there is one;
 *   4a. otherwise the project folders something is running from are looked at
 *       for a script of that kind that starts a model server on this port.
 *       Exactly one such script in exactly one such folder is the app.
 *
 * A process's working directory cannot be read from the process list, which is
 * why step 4 looks for the script instead of asking where it ran.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { classifyPortOwner } from '../llama/portOwner.js'
import { appInUse } from './displace.js'
import { appsFile, loadApps, saveApp, type LocalApp } from './registry.js'
import { listProcesses as readProcessList, readPortTree, type ListedProc, type PortTree, type Proc } from './portTree.js'

export type LauncherKind = 'bash' | 'cmd' | 'powershell' | 'python' | 'node'
export type Launcher = { proc: Proc; kind: LauncherKind; script: string }

export type Holder =
  | { owner: 'engine'; detail: string; listener: Proc }
  | { owner: 'app'; app: LocalApp; detail: string; listener: Proc; discovered: boolean; launcherPid: number | null }
  | { owner: 'foreign'; detail: string; listener: Proc }
  | { owner: 'unknown'; detail: string }

const INTERPRETERS: Array<{ kind: LauncherKind; name: RegExp; script: RegExp; ext: string }> = [
  { kind: 'bash', name: /^(bash|sh|zsh)(\.exe)?$/i, script: /\.(sh|bash)$/i, ext: '.sh' },
  { kind: 'cmd', name: /^cmd(\.exe)?$/i, script: /\.(cmd|bat)$/i, ext: '.cmd' },
  { kind: 'powershell', name: /^(powershell|pwsh)(\.exe)?$/i, script: /\.ps1$/i, ext: '.ps1' },
  { kind: 'python', name: /^(python[\d.]*|pythonw|py)(\.exe)?$/i, script: /\.py$/i, ext: '.py' },
  { kind: 'node', name: /^(node|bun)(\.exe)?$/i, script: /\.(js|mjs|cjs|ts)$/i, ext: '.js' },
]

/** A Windows command line into its arguments: double quotes group, and are dropped. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let cur = '', quoted = false, any = false
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; any = true; continue }
    if (!quoted && /\s/.test(ch)) { if (any || cur) out.push(cur); cur = ''; any = false; continue }
    cur += ch
  }
  if (any || cur) out.push(cur)
  return out
}

/** A drive path (`C:/…`) anywhere, or a rooted path (`/…`), which is what an absolute path is off Windows. */
const isAbsolute = (p: string): boolean => /^[A-Za-z]:\//.test(p) || p.startsWith('/')

/**
 * Forward slashes; leading `./` and `../` dropped from a relative path. On Windows, Git Bash's `/c/Users/…`
 * becomes `C:/Users/…`; elsewhere `/c/Users/…` is simply a path.
 */
export function normalizeScript(raw: string, platform: string = process.platform): string {
  let p = raw.replace(/\\/g, '/')
  const posix = platform === 'win32' ? /^\/([A-Za-z])\/(.*)$/.exec(p) : null
  if (posix) p = `${posix[1].toUpperCase()}:/${posix[2]}`
  if (isAbsolute(p)) return p
  while (p.startsWith('./') || p.startsWith('../')) p = p.slice(p.indexOf('/') + 1)
  return p
}

/** The nearest ancestor that is a shell or interpreter running a script file, with that script. */
export function launcherOf(tree: PortTree, platform: string = process.platform): Launcher | null {
  for (const proc of tree.ancestors) {
    const interp = INTERPRETERS.find(i => i.name.test(proc.name))
    if (!interp || !proc.commandLine) continue
    const script = splitCommandLine(proc.commandLine).slice(1).find(a => interp.script.test(a))
    if (script) return { proc, kind: interp.kind, script: normalizeScript(script, platform) }
  }
  return null
}

/**
 * The nearest ancestor that is a shell or interpreter, when its command line cannot be read: what a
 * launcher started from an administrator window looks like to an engine that is not elevated (F223).
 * Null when that ancestor can be read (then `launcherOf` has the answer, or there is none).
 */
export function unreadableLauncher(tree: PortTree): { proc: Proc; kind: LauncherKind } | null {
  for (const proc of tree.ancestors) {
    const interp = INTERPRETERS.find(i => i.name.test(proc.name))
    if (interp) return proc.commandLine ? null : { proc, kind: interp.kind }
  }
  return null
}

const sameText = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const under = (path: string, root: string): boolean => {
  const p = path.replace(/\\/g, '/').toLowerCase(), r = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return p.startsWith(r + '/')
}

/** The registered app this server belongs to, or null when none or more than one could be. */
export function matchApp(tree: PortTree, apps: LocalApp[]): LocalApp | null {
  const launcher = launcherOf(tree)
  if (!launcher) return null
  const hits = isAbsolute(launcher.script)
    ? apps.filter(a => under(launcher.script, a.root) && sameText(launcher.script.slice(a.root.replace(/\/+$|\\+$/g, '').length + 1), a.script))
    : apps.filter(a => sameText(launcher.script, a.script))
  return hits.length === 1 ? hits[0] : null
}

/** A script that starts a model server says so somewhere in its text. */
const STARTS_MODEL_SERVER = /llama[-_]server|llama\.cpp|ollama\s+serve|vllm|text-generation|koboldcpp|lmstudio|lms\s+server/i

function launchArgs(kind: LauncherKind, script: string): string[] {
  if (kind === 'cmd') return ['/c', script.replace(/\//g, '\\')]
  if (kind === 'powershell') return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
  return [script]
}

export type DiscoverDeps = { roots: string[]; now?: () => Date }

/**
 * The owner's project folder this server was started from, when that can be
 * told without guessing: the launcher's script exists in exactly one of
 * `roots`, and its text starts a model server.
 */
export function discoverApp(tree: PortTree, deps: DiscoverDeps): LocalApp | null {
  const launcher = launcherOf(tree)
  if (!launcher) return null
  const found: Array<{ root: string; script: string }> = []
  for (const root of deps.roots) {
    const script = isAbsolute(launcher.script)
      ? (under(launcher.script, root) ? launcher.script.slice(root.replace(/\/+$|\\+$/g, '').length + 1) : null)
      : launcher.script
    if (!script) continue
    const file = join(root, script)
    // A folder or file that cannot be read throws; `identifyPortHolder` logs it and treats the server as not found.
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue
    if (!STARTS_MODEL_SERVER.test(readFileSync(file, 'utf-8'))) continue
    found.push({ root, script })
  }
  if (found.length !== 1) return null
  const { root, script } = found[0]
  const name = basename(root)
  const when = (deps.now ?? (() => new Date()))().toISOString()
  return {
    id: name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
    name,
    root,
    script,
    launch: { exe: launcher.proc.exe ?? launcher.proc.name, args: launchArgs(launcher.kind, script), cwd: root },
    manage: true,
    source: `discovered ${when}: pid ${tree.listener.pid} (${tree.listener.name}) was started by ${launcher.proc.name} running ${launcher.script}, and ${root} is the only project folder with that script`,
  }
}

/** Where a project keeps the script that starts its model server: its own folder, `scripts`, `bin`. */
const SCRIPT_DIRS = ['', 'scripts', 'bin']
const MAX_SCRIPT_BYTES = 256 * 1024

/**
 * The app behind a server whose launcher cannot be read, from what can be: among the project folders
 * something is running from (not a checkout of CynCo, which has such scripts of its own), the scripts of
 * the launcher's kind that start a model server and name this port. Exactly one script in exactly one
 * folder is the app; anything else is not guessed.
 */
export function discoverByFolder(tree: PortTree, launcher: { proc: Proc; kind: LauncherKind }, port: number, deps: DiscoverDeps & { procs: ListedProc[] }): LocalApp | null {
  const interp = INTERPRETERS.find(i => i.kind === launcher.kind)!
  const namesPort = new RegExp(`(^|[^0-9])${port}([^0-9]|$)`)
  const found: Array<{ root: string; script: string }> = []
  for (const root of deps.roots) {
    if (!appInUse({ root }, -1, deps.procs)) continue
    if (existsSync(join(root, 'docs', 'cynco-failure-log.md'))) continue
    for (const dir of SCRIPT_DIRS) {
      const folder = join(root, dir)
      if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) continue
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !interp.script.test(entry.name)) continue
        const file = join(folder, entry.name)
        if (statSync(file).size > MAX_SCRIPT_BYTES) continue
        const text = readFileSync(file, 'utf-8')
        if (STARTS_MODEL_SERVER.test(text) && namesPort.test(text)) found.push({ root, script: dir ? `${dir}/${entry.name}` : entry.name })
      }
    }
  }
  if (found.length !== 1) return null
  const { root, script } = found[0]
  const name = basename(root)
  const when = (deps.now ?? (() => new Date()))().toISOString()
  return {
    id: name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
    name,
    root,
    script,
    launch: { exe: launcher.proc.exe ?? launcher.proc.name, args: launchArgs(launcher.kind, script), cwd: root },
    manage: true,
    source: `discovered ${when}: pid ${tree.listener.pid} (${tree.listener.name}) was started by ${launcher.proc.name}, whose command line could not be read (as for a process started as administrator); ${root} is the only project folder with a running process and a ${interp.ext} script that starts a model server on port ${port} (${script})`,
  }
}

const SKIP_HOME_CHILDREN = /^(\.|_|AppData$|Application Data$|Local Settings$|My Documents$|NetHood$|PrintHood$|Recent$|SendTo$|Start Menu$|Templates$|Cookies$|NTUSER|ntuser|OneDrive|Documents$|Downloads$|Desktop$|Pictures$|Music$|Videos$|Links$|Favorites$|Contacts$|Searches$|Saved Games$|3D Objects$|Temp$|node_modules$|bin$)/

/** Where the owner's projects live: the folders directly under the home folder and under `CYNCO-PROJECTS`. */
export function projectDirs(home: string = homedir()): string[] {
  const out: string[] = []
  for (const base of [home, join(home, 'CYNCO-PROJECTS')]) {
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_HOME_CHILDREN.test(entry.name)) out.push(join(base, entry.name))
    }
  }
  return out
}

export type IdentifyDeps = {
  readTree?: (port: number) => Promise<PortTree | null>
  registryFile?: string
  /** Project folders to search when the registry does not know the server. Default: `projectDirs()`. */
  roots?: string[]
  /** Every process, for "is this app running": asked only when the launcher's command line cannot be read (F223). */
  listProcesses?: () => Promise<ListedProc[]>
  log?: (line: string) => void
}

const who = (p: Proc): string => `pid ${p.pid} (${p.name})`

export async function identifyPortHolder(port: number, deps: IdentifyDeps = {}): Promise<Holder> {
  const log = deps.log ?? console.log
  const tree = await (deps.readTree ?? ((p: number) => readPortTree(p, undefined, log)))(port)
  if (!tree) return { owner: 'unknown', detail: 'the process listening on the port could not be read' }
  const parent = tree.ancestors[0] ?? null
  // The chain stops at a parent that is gone or younger than its child, so a parent in it is an older, running one.
  const base = classifyPortOwner({ pid: tree.listener.pid, name: tree.listener.name, parentName: parent?.name ?? null, parentIsOlder: parent !== null })
  if (base.owner === 'engine') return { owner: 'engine', detail: base.detail, listener: tree.listener }

  const file = deps.registryFile ?? appsFile()
  const registered = loadApps(file, log)
  const launcher = launcherOf(tree)
  // Only when there is no launcher to read at all: a readable one that matches nothing is somebody else's server.
  const unread = launcher ? null : unreadableLauncher(tree)
  let app = matchApp(tree, registered)
  let discovered = false
  try {
    if (!app && unread) {
      // F223: the shell that started it cannot be read. The app's own processes, which are not elevated, can.
      const procs = await (deps.listProcesses ?? readProcessList)()
      const kind = INTERPRETERS.find(i => i.kind === unread.kind)!
      const running = registered.filter(a => kind.script.test(a.script) && appInUse(a, -1, procs))
      if (running.length === 1) app = running[0]
      else if (running.length === 0) {
        app = discoverByFolder(tree, unread, port, { roots: deps.roots ?? projectDirs(), procs })
        discovered = !!app
      }
    } else if (!app) {
      app = discoverApp(tree, { roots: deps.roots ?? projectDirs() })
      discovered = !!app
    }
  } catch (e) {
    log(`[apps] looking for the project that started pid ${tree.listener.pid} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (app && discovered) {
    try { saveApp(app, file) } catch (e) { log(`[apps] ${app.name} could not be written to ${file}: ${e instanceof Error ? e.message : String(e)}`) }
    log(`[apps] ${app.source}; registered as ${app.name} in ${file}`)
  }
  if (app && app.manage) {
    const by = launcher ? `started by ${launcher.proc.name} ${launcher.script}`
      : unread ? `started by ${unread.proc.name}; its command line cannot be read, as for a process started as administrator`
      : 'its launcher has gone'
    return { owner: 'app', app, detail: `${app.name}'s model server (${who(tree.listener)}, ${by})`, listener: tree.listener, discovered, launcherPid: launcher?.proc.pid ?? unread?.proc.pid ?? null }
  }
  return { owner: 'foreign', detail: base.detail, listener: tree.listener }
}
