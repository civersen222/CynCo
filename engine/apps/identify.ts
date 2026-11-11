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
 * A process's working directory cannot be read from the process list, which is
 * why step 4 looks for the script instead of asking where it ran.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { classifyPortOwner } from '../llama/portOwner.js'
import { appsFile, loadApps, saveApp, type LocalApp } from './registry.js'
import { readPortTree, type PortTree, type Proc } from './portTree.js'

export type LauncherKind = 'bash' | 'cmd' | 'powershell' | 'python' | 'node'
export type Launcher = { proc: Proc; kind: LauncherKind; script: string }

export type Holder =
  | { owner: 'engine'; detail: string; listener: Proc }
  | { owner: 'app'; app: LocalApp; detail: string; listener: Proc; discovered: boolean; launcherPid: number | null }
  | { owner: 'foreign'; detail: string; listener: Proc }
  | { owner: 'unknown'; detail: string }

const INTERPRETERS: Array<{ kind: LauncherKind; name: RegExp; script: RegExp }> = [
  { kind: 'bash', name: /^(bash|sh|zsh)(\.exe)?$/i, script: /\.(sh|bash)$/i },
  { kind: 'cmd', name: /^cmd(\.exe)?$/i, script: /\.(cmd|bat)$/i },
  { kind: 'powershell', name: /^(powershell|pwsh)(\.exe)?$/i, script: /\.ps1$/i },
  { kind: 'python', name: /^(python[\d.]*|pythonw|py)(\.exe)?$/i, script: /\.py$/i },
  { kind: 'node', name: /^(node|bun)(\.exe)?$/i, script: /\.(js|mjs|cjs|ts)$/i },
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

const isAbsolute = (p: string): boolean => /^[A-Za-z]:\//.test(p)

/** Forward slashes; Git Bash's `/c/Users/…` as `C:/Users/…`; leading `./` and `../` dropped from a relative path. */
export function normalizeScript(raw: string): string {
  let p = raw.replace(/\\/g, '/')
  const posix = /^\/([A-Za-z])\/(.*)$/.exec(p)
  if (posix) p = `${posix[1].toUpperCase()}:/${posix[2]}`
  if (isAbsolute(p)) return p
  while (p.startsWith('./') || p.startsWith('../')) p = p.slice(p.indexOf('/') + 1)
  return p
}

/** The nearest ancestor that is a shell or interpreter running a script file, with that script. */
export function launcherOf(tree: PortTree): Launcher | null {
  for (const proc of tree.ancestors) {
    const interp = INTERPRETERS.find(i => i.name.test(proc.name))
    if (!interp || !proc.commandLine) continue
    const script = splitCommandLine(proc.commandLine).slice(1).find(a => interp.script.test(a))
    if (script) return { proc, kind: interp.kind, script: normalizeScript(script) }
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

const SKIP_HOME_CHILDREN = /^(\.|AppData$|Application Data$|NTUSER|ntuser|OneDrive|Documents$|Downloads$|Desktop$|Pictures$|Music$|Videos$|Links$|Favorites$|Contacts$|Searches$|Saved Games$|3D Objects$)/

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
  let app = matchApp(tree, loadApps(file, log))
  let discovered = false
  if (!app) {
    try {
      app = discoverApp(tree, { roots: deps.roots ?? projectDirs() })
    } catch (e) {
      log(`[apps] looking for the project that started pid ${tree.listener.pid} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (app) {
      discovered = true
      try { saveApp(app, file) } catch (e) { log(`[apps] ${app.name} could not be written to ${file}: ${e instanceof Error ? e.message : String(e)}`) }
      log(`[apps] ${app.source}; registered as ${app.name} in ${file}`)
    }
  }
  if (app && app.manage) {
    const launcher = launcherOf(tree)
    const by = launcher ? `started by ${launcher.proc.name} ${launcher.script}` : 'its launcher has gone'
    return { owner: 'app', app, detail: `${app.name}'s model server (${who(tree.listener)}, ${by})`, listener: tree.listener, discovered, launcherPid: launcher?.proc.pid ?? null }
  }
  return { owner: 'foreign', detail: base.detail, listener: tree.listener }
}
