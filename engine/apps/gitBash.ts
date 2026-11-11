/**
 * engine/apps/gitBash.ts — which bash runs an app's launcher script on Windows (F222).
 *
 * There are three, and they are not interchangeable. Measured on the owner's PC by
 * starting one script each way, as CynCo starts an app's server again:
 *
 *   `<Git>\bin\bash.exe`      Git's wrapper. Sets up Git Bash's own tools and ran the script.
 *   `<Git>\usr\bin\bash.exe`  The bash the wrapper starts. It is what the process list shows
 *                             for a running launcher, so it is what discovery records. Started
 *                             by itself it has no `dirname`, `date` or `cat`: the script died at
 *                             its first one, with a pid returned and nothing listening.
 *   `bash`                    From anything but a Git Bash terminal, `C:\Windows\System32\bash.exe`:
 *                             the WSL launcher (F160). The script ran inside Linux with
 *                             HOME=/root and found none of this PC's files.
 *
 * So a bash launcher is always started through the wrapper, whatever the registry
 * entry says, and when there is no Git for Windows the start is refused by name.
 */
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { win32 } from 'path'
import type { AppLaunch } from './registry.js'

export type GitBashDeps = {
  platform?: string
  exists?: (path: string) => boolean
  /** The first `git.exe` on PATH, or null. */
  gitOnPath?: () => string | null
  env?: Record<string, string | undefined>
}

const IS_BASH = /^(bash|sh)(\.exe)?$/i

/** `where.exe $PATH:git.exe`: PATH only, never the current folder, which a project could plant a `git.exe` in. */
function whereGit(env: Record<string, string | undefined>): string | null {
  const where = env.SystemRoot ? win32.join(env.SystemRoot, 'System32', 'where.exe') : 'where.exe'
  try {
    const out = execFileSync(where, ['$PATH:git.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? null
  } catch {
    // where.exe exits 1 when nothing is found: the usual install folders are tried next.
    return null
  }
}

/** Git for Windows' wrapper bash, or null when there is none on this PC. */
export function gitBash(deps: GitBashDeps = {}): string | null {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const roots: string[] = []
  const git = (deps.gitOnPath ?? (() => whereGit(env)))()
  if (git) {
    // `<root>\cmd\git.exe`, `<root>\bin\git.exe` or `<root>\mingw64\bin\git.exe`
    const up = win32.dirname(win32.dirname(git))
    roots.push(/^mingw(32|64)$/i.test(win32.basename(up)) ? win32.dirname(up) : up)
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) roots.push(win32.join(base, 'Git'))
  }
  return roots.map(r => win32.join(r, 'bin', 'bash.exe')).find(exists) ?? null
}

/** The same launch, with a bash that will run the script on this PC. Throws when a bash script has no Git Bash to run it. */
export function throughGitBash(launch: AppLaunch, deps: GitBashDeps = {}): AppLaunch {
  if ((deps.platform ?? process.platform) !== 'win32') return launch
  const exe = launch.exe.replace(/\//g, '\\')
  if (!IS_BASH.test(win32.basename(exe))) return launch
  const exists = deps.exists ?? existsSync
  const env = deps.env ?? process.env
  if (win32.isAbsolute(exe) && exists(exe)) {
    const dir = win32.dirname(exe)
    // Git's inner bash: the wrapper is two folders up, in `bin`.
    if (/\\usr\\bin$/i.test(dir)) {
      const wrapper = win32.join(win32.dirname(win32.dirname(dir)), 'bin', 'bash.exe')
      if (exists(wrapper)) return { ...launch, exe: wrapper }
    }
    const lower = exe.toLowerCase()
    const wsl = (!!env.SystemRoot && lower.startsWith(env.SystemRoot.toLowerCase() + '\\')) || lower.includes('\\windowsapps\\')
    if (!wsl) return launch
  }
  const found = gitBash(deps)
  if (!found) {
    throw new Error(`F222: ${launch.args.join(' ')} is a bash script and no Git Bash was found on this PC (no git.exe on PATH, none under Program Files); a bare bash on Windows is the WSL launcher, which runs the script inside Linux`)
  }
  return { ...launch, exe: found }
}
