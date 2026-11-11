// F222: which bash runs an app's launcher script on Windows.
//
// Measured on the owner's PC by starting one stand-in script three ways, the way CynCo restarts an app:
// Git's wrapper `<Git>\bin\bash.exe` ran it; the inner `<Git>\usr\bin\bash.exe` (what the process list
// shows for a running launcher, and so what discovery records) died at `dirname`; a bare `bash` ran it
// inside WSL with HOME=/root, the error the owner got from the documented command.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchOutsideJob } from '../../apps/displace.js'
import { gitBash, throughGitBash } from '../../apps/gitBash.js'

const GIT = 'C:\\Program Files\\Git'
const WRAPPER = `${GIT}\\bin\\bash.exe`
const INNER = `${GIT}\\usr\\bin\\bash.exe`
const has = (...files: string[]) => (p: string) => files.includes(p)
const launch = (exe: string) => ({ exe, args: ['scripts/start-llm.sh'], cwd: 'C:\\Users\\o\\game' })
const win = { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' } }

describe('gitBash', () => {
  it('is the bash beside the git.exe on PATH', () => {
    expect(gitBash({ ...win, gitOnPath: () => `${GIT}\\cmd\\git.exe`, exists: has(WRAPPER) })).toBe(WRAPPER)
    expect(gitBash({ ...win, gitOnPath: () => `${GIT}\\mingw64\\bin\\git.exe`, exists: has(WRAPPER) })).toBe(WRAPPER)
  })

  it('falls back to the usual install folders when git.exe is not on PATH', () => {
    expect(gitBash({ ...win, gitOnPath: () => null, exists: has(WRAPPER) })).toBe(WRAPPER)
  })

  it('is null when there is no Git for Windows', () => {
    expect(gitBash({ ...win, gitOnPath: () => null, exists: () => false })).toBeNull()
  })
})

describe('throughGitBash', () => {
  const deps = { ...win, gitOnPath: () => `${GIT}\\cmd\\git.exe`, exists: has(WRAPPER, INNER) }

  it('turns Git\'s inner bash, which the process list shows, into the wrapper that sets up its tools', () => {
    expect(throughGitBash(launch(INNER), deps)).toEqual(launch(WRAPPER))
  })

  it('never starts a bare bash, which on Windows is the WSL launcher', () => {
    for (const bare of ['bash', 'bash.exe', 'sh', 'C:\\Windows\\System32\\bash.exe', 'C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe']) {
      expect(throughGitBash(launch(bare), deps).exe).toBe(WRAPPER)
    }
  })

  it('refuses, naming the reason, when a bash launcher has no Git Bash to run it', () => {
    expect(() => throughGitBash(launch('bash'), { ...win, gitOnPath: () => null, exists: () => false })).toThrow(/Git Bash.*WSL/)
  })

  it('leaves the wrapper, another real bash, and every other interpreter alone', () => {
    expect(throughGitBash(launch(WRAPPER), deps)).toEqual(launch(WRAPPER))
    const msys = 'C:\\msys64\\usr\\bin\\bash.exe'
    expect(throughGitBash(launch(msys), { ...deps, exists: has(WRAPPER, INNER, msys) })).toEqual(launch(msys))
    expect(throughGitBash(launch('C:\\Windows\\System32\\cmd.exe'), deps)).toEqual(launch('C:\\Windows\\System32\\cmd.exe'))
    expect(throughGitBash(launch('python'), deps)).toEqual(launch('python'))
  })

  it('changes nothing off Windows', () => {
    expect(throughGitBash(launch('bash'), { platform: 'linux' })).toEqual(launch('bash'))
  })
})

// The same thing with nothing injected: the start outside the engine's job that gives an app its server
// back (`launchOutsideJob`), a script that needs Git Bash's own tools, and the two launches that failed
// on the owner's PC. Only where there is a Git for Windows to find.
describe.skipIf(process.platform !== 'win32' || !gitBash())('a bash launcher started the way an app\'s server is started again', () => {
  let dir = ''
  let pid: number | null = null
  const running = (): boolean => { try { process.kill(pid!, 0); return true } catch { return false } }
  afterEach(async () => {
    // The started bash has the folder as its working folder until it has ended: removing it earlier is refused.
    for (let i = 0; pid && running() && i < 100; i++) await new Promise(r => setTimeout(r, 100))
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })
  })

  for (const [what, exe] of [
    ['Git\'s inner bash, as discovery records it', () => gitBash()!.replace(/\\bin\\bash\.exe$/i, '\\usr\\bin\\bash.exe')],
    ['a bare bash, as a hand-written entry names it', () => 'bash'],
  ] as Array<[string, () => string]>) {
    it(`${what}, runs the script on this PC and not inside WSL`, async () => {
      dir = mkdtempSync(join(tmpdir(), 'cynco-gitbash-'))
      mkdirSync(join(dir, 'scripts'))
      // LF line endings: bash reads a CR as part of the command.
      writeFileSync(join(dir, 'scripts', 'start.sh'), ['#!/usr/bin/env bash', 'set -euo pipefail', 'OUT="$(dirname "$0")/../ran.txt"', 'echo "at=$(date +%s) home=$HOME" > "$OUT"', ''].join('\n'))
      pid = await launchOutsideJob({ exe: exe(), args: ['scripts/start.sh'], cwd: dir })
      expect(pid).toBeGreaterThan(0)
      const ran = join(dir, 'ran.txt')
      for (let i = 0; i < 100 && !existsSync(ran); i++) await new Promise(r => setTimeout(r, 200))
      expect(existsSync(ran)).toBe(true)
      const text = readFileSync(ran, 'utf-8')
      expect(text).toMatch(/^at=\d+ home=\/[a-z]\//)
      expect(text).not.toContain('/root')
    }, 40_000)
  }
})
