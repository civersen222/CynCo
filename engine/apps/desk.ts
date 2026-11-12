/**
 * engine/apps/desk.ts — the launcher a Desktop icon runs, and the icons.
 *
 * `bun scripts/cynco-apps.mjs start <id>` (through `scripts/cynco-app.cmd`) reads
 * the app's recipe from `~/.cynco/apps.json` and runs `start.ts` with real
 * processes. It does not ask the running engine for anything, so an icon works
 * whether or not the engine is up, and an engine restart is not needed for it.
 *
 * The window is the app: what it starts are its own children, each owned as a
 * tree from the moment it exists (`engine/processTree.ts`), with their output in
 * `~/.cynco/app-logs/`; closing the window, Ctrl+C, or the launcher ending
 * stops them. That is deliberate. A process started the way the engine starts an app's server
 * again (`launchOutsideJob`) has no window at all (measured: session 1, window
 * handle 0), and a 20 GB model server the owner cannot see or close is the
 * opposite of "if it's not being used the models should not be loaded". A step
 * marked `keep` is started detached and stays.
 *
 * `createIcons` writes one `.lnk` per app that has a recipe. Each runs
 * `cmd /c if exist <launcher> (<launcher> <id>) else (echo why & pause)`: an
 * icon whose checkout has no launcher says so instead of doing nothing.
 */
import { execFile, spawn } from 'child_process'
import { get } from 'http'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { isAbsolute, join, win32 } from 'path'
import { cyncoHome } from '../paths.js'
import { ownProcessTree } from '../processTree.js'
import { forgetDebt } from './displace.js'
import { throughGitBash } from './gitBash.js'
import { portBound } from './gpu.js'
import { identifyPortHolder } from './identify.js'
import { appsFile, findApp, loadRegistry, type AppLaunch, type AppStep, type Registry } from './registry.js'
import { startApp, tendModelOnce, type Running, type StartDeps } from './start.js'

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'step'

/** Where one step's output goes. */
export function stepLog(appId: string, step: string, home: string = cyncoHome()): string {
  return join(home, 'app-logs', `${slug(appId)}-${slug(step)}.log`)
}

/** Start one step's process as a child of this console (or detached, for a step that stays), its output in `logFile`. */
export function runChild(launch: AppLaunch, step: AppStep, logFile: string): Promise<Running> {
  return new Promise<Running>((resolve, reject) => {
    let out = -1
    try {
      const l = throughGitBash(launch)
      mkdirSync(join(logFile, '..'), { recursive: true })
      out = openSync(logFile, 'w')
      let ended = false
      let code: number | null = null
      const child = spawn(l.exe, l.args, { cwd: l.cwd, stdio: ['ignore', out, out], detached: !!step.keep, windowsHide: false })
      // The child has its own copy of the handle once it exists; ours is closed either way.
      const close = () => { if (out >= 0) { closeSync(out); out = -1 } }
      child.once('error', e => { close(); reject(e) })
      child.once('spawn', () => {
        close()
        if (step.keep) child.unref()
        // Owned when it is started, not found when it is stopped (F210): a shell that is still starting its command would be missed.
        const tree = step.keep ? null : ownProcessTree(child.pid, () => {})
        const exited = new Promise<void>(done => child.once('exit', c => { ended = true; code = c; tree?.release(); done() }))
        resolve({
          step: step.name, pid: child.pid ?? null, keep: !!step.keep, alive: () => !ended, exitCode: () => code, log: logFile,
          // Stopped means seen to have ended, not asked to: the kill returns before the exit is reported.
          stop: async () => {
            if (!tree || ended) return
            await tree.kill()
            await Promise.race([exited, new Promise<void>(r => setTimeout(r, 5000))])
          },
        })
      })
    } catch (e) {
      if (out >= 0) closeSync(out)
      reject(e)
    }
  })
}

function exitsZero(exe: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    execFile(exe, args, { cwd, timeout: 15_000, windowsHide: true }, err => resolve(!err))
  })
}

/** Does a GET answer 2xx within three seconds? Plain http: these are addresses on this PC. */
function answers(url: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    try {
      const req = get(url, { timeout: 3000 }, res => { res.resume(); resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) })
      req.once('timeout', () => req.destroy())
      req.once('error', () => resolve(false))
    } catch {
      // Not an http address `get` can use: it does not answer.
      resolve(false)
    }
  })
}

function lastLines(file: string, n = 8): string {
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf-8').replace(/\r/g, '').trimEnd().split('\n').slice(-n).join('\n')
}

/** Open an address in the owner's browser. Only http and https: the registry is a file anyone at the desk can edit. */
export function openAddress(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const [exe, args] = process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
    execFile(exe, args as string[], { windowsHide: true }, err => (err ? reject(err) : resolve()))
  })
}

export type DeskOpts = {
  print: (line: string) => void
  registryFile?: string
  /** `~/.cynco`, for the logs. */
  home?: string
  displacedFile?: string
  open?: (url: string) => Promise<void>
  identify?: StartDeps['identify']
  /** How often the window looks at what it started. */
  pollMs?: number
  /** The window was closed or interrupted: what it started is stopped and the launcher returns. */
  signal?: AbortSignal
}

export type DeskResult = { code: number; running: Running[] }

const list = (names: string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/**
 * Start an app from its recipe, open it, and stay for as long as something this
 * window started is running. Code 0: the app was opened (or was already
 * running). Code 1: it was not, and the lines printed say why.
 */
export async function startFromDesk(id: string, opts: DeskOpts): Promise<DeskResult> {
  const { print } = opts
  const file = opts.registryFile ?? appsFile()
  const registry = loadRegistry(file, print)
  const app = findApp(id, registry)
  if (!app) {
    const known = [...registry.apps, ...registry.ollamaApps].map(a => a.id)
    print(`CynCo knows no app called "${id}". ${known.length ? `It knows: ${list(known)}.` : 'It knows none yet.'}`)
    print(`An app is an entry in ${file} (docs/decisions/2026-11-11-local-llm-apps.md, decision 7).`)
    return { code: 1, running: [] }
  }
  if (!app.start) {
    print(`${app.name} has no "start" section in ${file}: CynCo knows ${'launch' in app ? 'its model server' : 'which models it uses'}, not how the app itself is started.`)
    print('What to add is in docs/decisions/2026-11-11-local-llm-apps.md, decision 7.')
    return { code: 1, running: [] }
  }
  print(`${app.name}  (${app.root})`)
  const say = (line: string) => print(`  ${line}`)
  // Everything this window started, from the moment it exists: a close in the middle of a start stops it too.
  const started: Running[] = []
  const stopAll = (): Promise<void[]> => Promise.all(started.map(r => r.stop()))
  let closed: (() => void) | null = null
  const onClose = () => { void stopAll().then(() => closed?.()) }
  opts.signal?.addEventListener('abort', onClose, { once: true })
  const deps: StartDeps = {
    portBound,
    answers,
    identify: opts.identify ?? (port => identifyPortHolder(port, { registryFile: file, log: () => {} })),
    check: exitsZero,
    run: async (launch, step) => {
      if (opts.signal?.aborted) throw new Error('the window was closed')
      const r = await runChild(launch, step, stepLog(app.id, step.name, opts.home))
      started.push(r)
      return r
    },
    tail: r => lastLines(r.log),
    say,
  }
  const outcome = await startApp({ id: app.id, name: app.name, root: app.root, start: app.start, ...('launch' in app ? { launch: app.launch } : {}) }, deps)
  if (!outcome.ok) return { code: 1, running: outcome.running }
  if (outcome.open) {
    if (/^https?:\/\//i.test(outcome.open)) {
      try {
        await (opts.open ?? openAddress)(outcome.open)
        say(`opened ${outcome.open}`)
      } catch (e) {
        say(`${outcome.open} could not be opened in the browser (${e instanceof Error ? e.message : String(e)}); it is up, open it by hand`)
      }
    } else {
      say(`"${outcome.open}" is not an http address and is not opened`)
    }
  }
  const mine = outcome.running.filter(r => !r.keep)
  const kept = outcome.running.filter(r => r.keep)
  if (kept.length) say(`${list(kept.map(r => r.step))} ${kept.length === 1 ? 'stays' : 'stay'} running after this window is closed`)
  if (mine.length === 0) {
    print(`${app.name} was already running: nothing was started by this window.`)
    return { code: 0, running: outcome.running }
  }
  print('')
  print(`${app.name} is running. Close this window to stop its ${list(mine.map(r => r.step))}.`)
  print(`Their output is in ${join(opts.home ?? cyncoHome(), 'app-logs')}.`)

  // The window stays for as long as something it started runs, and tends the model port meanwhile.
  const told = new Set<Running>()
  const state = { free: 0 }
  const pollMs = opts.pollMs ?? 5000
  const all = (): Running[] => started.filter(r => !r.keep)
  while (!opts.signal?.aborted) {
    for (const r of all()) {
      if (r.alive() || told.has(r)) continue
      told.add(r)
      say(`${r.step}: stopped${r.exitCode() === null ? '' : ` (exit code ${r.exitCode()})`}; its output is in ${r.log}`)
    }
    if (all().every(r => !r.alive())) {
      print(`Everything this window started for ${app.name} has stopped.`)
      break
    }
    if (outcome.model) {
      await tendModelOnce(app, outcome.model, { ...deps, claimDebt: appId => forgetDebt(appId, opts.displacedFile, () => {}) }, state)
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { closed = null; resolve() }, pollMs)
      closed = () => { clearTimeout(timer); resolve() }
      if (opts.signal?.aborted) onClose()
    })
  }
  if (opts.signal?.aborted) {
    await stopAll()
    print(`${app.name}: this window was closed, and what it started is stopped.`)
  }
  return { code: 0, running: all() }
}

// ── the icons ────────────────────────────────────────────────────────────────

/** Text for cmd's `echo` inside a parenthesised block: the characters cmd would act on are escaped. */
const cmdEcho = (s: string): string => s.replace(/[\^&|<>()]/g, c => `^${c}`)

/**
 * What the shortcut hands to cmd.exe. The launcher is looked for first: a
 * checkout that does not have it yet (not brought up to date, moved) gets a
 * sentence and a pause, never a window that flashes and is gone.
 */
export function shortcutArguments(repo: string, id: string): string {
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`"${id}" cannot be an icon: an app id is lowercase letters, digits, - and _`)
  if (/["%]/.test(repo)) throw new Error(`${repo} cannot be put in a shortcut: it has a quote or a percent sign`)
  const launcher = win32.join(repo, 'scripts', 'cynco-app.cmd')
  const why = `CynCo at ${repo} has no app launcher yet: bring that checkout up to date with main, then use this icon again.`
  return `/d /c if exist "${launcher}" ("${launcher}" ${id}) else (echo ${cmdEcho(why)} & pause)`
}

export type IconPlan = { file: string; target: string; arguments: string; workingDirectory: string; description: string; icon?: string }

/** One shortcut per app that has a recipe, named for the app. */
export function planIcons(registry: Registry, repo: string, desktop: string, env: Record<string, string | undefined> = process.env): IconPlan[] {
  const plans: IconPlan[] = []
  for (const app of [...registry.apps, ...registry.ollamaApps]) {
    if (!app.start) continue
    const icon = app.start.icon ? (isAbsolute(app.start.icon) ? app.start.icon : join(app.root, app.start.icon)) : undefined
    plans.push({
      file: win32.join(desktop, `${app.name.replace(/[\\/:*?"<>|]/g, '-')}.lnk`),
      target: env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      arguments: shortcutArguments(repo, app.id),
      workingDirectory: env.USERPROFILE ?? homedir(),
      description: `CynCo: start ${app.name}`,
      ...(icon && existsSync(icon) ? { icon } : {}),
    })
  }
  return plans
}

/**
 * Writes the shortcuts. A `.lnk` of the same name that is not one of these (its
 * arguments do not name the launcher) is left as it is and reported.
 */
const WRITE_ICONS = [
  `$plans = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:CYNCO_ICON_PLANS | ConvertFrom-Json`,
  `$w = New-Object -ComObject WScript.Shell`,
  `foreach ($p in $plans) {`,
  `  $had = Test-Path -LiteralPath $p.file`,
  `  $s = $w.CreateShortcut($p.file)`,
  `  if ($had -and ($s.Arguments -notlike '*cynco-app.cmd*')) { 'KEPT|' + $p.file; continue }`,
  `  $s.TargetPath = $p.target; $s.Arguments = $p.arguments; $s.WorkingDirectory = $p.workingDirectory; $s.Description = $p.description`,
  `  if ($p.icon) { $s.IconLocation = $p.icon + ',0' }`,
  `  $s.Save()`,
  `  $(if ($had) { 'UPDATED|' } else { 'CREATED|' }) + $p.file`,
  `}`,
].join('\n')

function powershell(script: string, env: Record<string, string | undefined> = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000, windowsHide: true, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0]))
      else resolve(String(stdout))
    })
  })
}

export type IconsOpts = { repo: string; desktop?: string; registryFile?: string; print: (line: string) => void }

/** Create or refresh the Desktop icons. Resolves to the files written. Windows only. */
export async function createIcons(opts: IconsOpts): Promise<string[]> {
  const { print } = opts
  if (process.platform !== 'win32') {
    print('Desktop icons are Windows shortcuts; nothing is created on this system.')
    return []
  }
  const file = opts.registryFile ?? appsFile()
  const desktop = opts.desktop ?? (await powershell(`[Environment]::GetFolderPath('Desktop')`)).trim()
  if (!desktop || !existsSync(desktop)) throw new Error(`the Desktop folder could not be found (${desktop || 'nothing returned'})`)
  const plans = planIcons(loadRegistry(file, print), opts.repo, desktop)
  if (plans.length === 0) {
    print(`No app in ${file} has a "start" section yet, so there is nothing to make an icon for.`)
    return []
  }
  const planFile = join(tmpdir(), `cynco-icons-${process.pid}.json`)
  writeFileSync(planFile, JSON.stringify(plans))
  const written: string[] = []
  try {
    for (const line of (await powershell(WRITE_ICONS, { CYNCO_ICON_PLANS: planFile })).split(/\r?\n/)) {
      const [what, path] = line.trim().split('|')
      if (what === 'CREATED' || what === 'UPDATED') { written.push(path); print(`${what === 'CREATED' ? 'created' : 'updated'} ${path}`) }
      else if (what === 'KEPT') print(`left alone ${path}: a shortcut of that name is already there and is not one of CynCo's`)
    }
  } finally {
    rmSync(planFile, { force: true })
  }
  if (!existsSync(win32.join(opts.repo, 'scripts', 'cynco-app.cmd'))) {
    print(`${opts.repo} does not have scripts\\cynco-app.cmd yet: until that checkout is brought up to date with main, each icon says so when it is used.`)
  }
  return written
}
