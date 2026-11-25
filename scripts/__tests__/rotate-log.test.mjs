// scripts/rotate-log.cmd (F242, slice S8): each service launcher rotates its own log when its service
// starts. The cases that run it start the real cmd.exe, and only on files inside a temporary folder
// each case makes; the refusals for a volume root and a share name a file that is never created and
// the script refuses before it looks at the disk. scripts/run-daemon.cmd is read as text only: it
// starts the daemon, so no test runs it.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(scripts, 'rotate-log.cmd')
const DAEMON = join(scripts, 'run-daemon.cmd')
const text = (p) => readFileSync(p, 'utf8')

const roots = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 })
})
const root = (prefix = 'cynco-rotate-') => {
  const r = mkdtempSync(join(tmpdir(), prefix))
  roots.push(r)
  return r
}

/**
 * Runs `rotate-log.cmd <args>` as a launcher calls it. cmd /s /c with the whole line in one more pair
 * of quotes, so a quoted script path and quoted arguments reach the script as written.
 */
function rotate(args, opts = {}) {
  const line = [SCRIPT, ...args].map(a => (a === '' ? '""' : `"${a}"`)).join(' ')
  // Windows names are case-blind: drop every spelling of a variable before setting it.
  const env = { ...process.env }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === k.toLowerCase()) delete env[key]
    env[k] = v
  }
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true, encoding: 'utf8', timeout: 20000, cwd: opts.cwd, env,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.trim() }
}

function sized(p, bytes, body) {
  if (body !== undefined) { writeFileSync(p, body); return p }
  const fd = openSync(p, 'w')
  try { ftruncateSync(fd, bytes) } finally { closeSync(fd) }
  return p
}

describe('rotate-log.cmd and run-daemon.cmd as text (everywhere)', () => {
  it('both files are ASCII with CRLF line ends', () => {
    for (const p of [SCRIPT, DAEMON]) {
      const raw = readFileSync(p)
      expect([...raw].every(b => b < 0x80), p).toBe(true)
      expect(raw.toString('latin1').replace(/\r\n/g, '').includes('\n'), p).toBe(false)
    }
  })
  it('the default cap is 50 MiB, below the 32-bit ceiling cmd compares at', () => {
    const m = /^if "%MAX%"=="" set "MAX=(\d+)"\r?$/m.exec(text(SCRIPT))
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBe(52428800)
    expect(Number(m[1])).toBeLessThan(2147483647)
  })
  it('the only command that changes a file is the one move of the named log onto <log>.1', () => {
    const lines = text(SCRIPT).split(/\r?\n/).filter(l => !/^\s*(rem\b|::|$)/i.test(l))
    const changing = lines.filter(l => /\b(move|del|erase|rd|rmdir|ren|rename|copy|xcopy|robocopy|mklink|attrib|type)\b/i.test(l.replace(/^echo .*/i, '')))
    expect(changing).toEqual(['move /y "%LOG%" "%LOG%.1" >nul 2>&1 || goto failed'])
    expect(lines.filter(l => /\bbun\b/i.test(l))).toEqual([])
    expect(text(SCRIPT)).not.toMatch(/^\s*\(/m)
  })
  it('run-daemon.cmd rotates daemon.log first, then starts the daemon as its last line with >>', () => {
    const lines = text(DAEMON).split(/\r?\n/).filter(l => l !== '')
    // Changed on purpose in wave 15 (NOW.md:91): the rotation's own line goes to daemon.rotate.log (the case
    // "wave 15: the rotation's own line reaches a file" below says why not to daemon.log itself).
    const rotateAt = lines.indexOf('call "%~dp0rotate-log.cmd" "%USERPROFILE%\\.cynco\\daemon.log" 2>> "%USERPROFILE%\\.cynco\\daemon.rotate.log"')
    // Changed on purpose in wave 19b (B4): Bun is told --no-install, so it never fetches a package by itself.
    const launch = 'bun --no-install engine\\daemon\\main.ts >> "%USERPROFILE%\\.cynco\\daemon.log" 2>&1'
    expect(rotateAt).toBeGreaterThan(-1)
    expect(lines[lines.length - 1]).toBe(launch)
    expect(rotateAt).toBe(lines.length - 2)
    expect(lines.filter(l => l.startsWith('bun '))).toEqual([launch])
    expect(lines).toContain('cd /d "%~dp0.."')
    expect(lines).toContain('if "%CYNCO_NTFY_URL%"=="" set CYNCO_NTFY_URL=http://100.110.117.10:8090')
    // The token is never written into the launcher.
    expect(text(DAEMON)).not.toMatch(/set\s+"?CYNCO_NTFY_TOKEN/i)
    // The services row matches the daemon by this text (scripts/cynco-services.ps1).
    expect(launch).toContain('engine\\daemon\\main')
  })
  // Wave 19b (B4): nothing may be downloaded on this PC without the owner's yes, and Bun's default fetches a
  // missing package from the registry when the folder it runs from holds no installed packages. Every launcher
  // that starts Bun says --no-install, each by its exact line (text only, so it holds on Linux too).
  it('wave 19b: every Bun start of the service launchers and the app launcher says --no-install', () => {
    const starts = {
      'run-box-reporter.cmd': ['bun --no-install engine\\power\\reporter\\main.ts >> "%USERPROFILE%\\.cynco\\box-reporter.log" 2>&1'],
      'run-daemon.cmd': ['bun --no-install engine\\daemon\\main.ts >> "%USERPROFILE%\\.cynco\\daemon.log" 2>&1'],
      'run-headless-engine.cmd': ['bun --no-install engine\\main.ts >> "%USERPROFILE%\\.cynco\\engine-headless.log" 2>&1'],
      'run-embed-server.cmd': [], // it starts llama-server, not Bun
      'cynco-app.cmd': ['call bun --no-install scripts\\cynco-apps.mjs start %*'],
    }
    for (const [name, want] of Object.entries(starts)) {
      const lines = text(join(scripts, name)).split(/\r?\n/).filter(l => !/^\s*(rem\b|::|$)/i.test(l))
      expect(lines.filter(l => /^\s*(call\s+)?bun(\.exe|\.cmd)?\b/i.test(l)), name).toEqual(want)
    }
  })
})

describe.skipIf(process.platform !== 'win32')('rotate-log.cmd, run for real in a temporary folder (Windows)', () => {
  it('a file over the given cap becomes <file>.1 and the original name is gone', () => {
    const d = root()
    const log = sized(join(d, 'svc.log'), 0, 'x'.repeat(200))
    const r = rotate([log, '100'])
    expect(r).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(existsSync(log)).toBe(false)
    expect(text(`${log}.1`)).toBe('x'.repeat(200))
  })
  it('under the cap, and at exactly the cap, nothing changes', () => {
    const d = root()
    const log = sized(join(d, 'svc.log'), 0, 'x'.repeat(100))
    expect(rotate([log, '100'])).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(rotate([log, '1000'])).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(text(log)).toBe('x'.repeat(100))
    expect(existsSync(`${log}.1`)).toBe(false)
  })
  it('a missing file exits 0 and says nothing', () => {
    const d = root()
    expect(rotate([join(d, 'absent.log'), '1'])).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(existsSync(join(d, 'absent.log.1'))).toBe(false)
  })
  it('an existing .1 is replaced: exactly one previous file is kept, and no other generation is touched', () => {
    const d = root()
    const log = sized(join(d, 'svc.log'), 0, 'new'.repeat(50))
    writeFileSync(`${log}.1`, 'old')
    writeFileSync(`${log}.2`, 'not mine')
    writeFileSync(join(d, 'other.log.1'), 'another log')
    expect(rotate([log, '10']).status).toBe(0)
    expect(existsSync(log)).toBe(false)
    expect(text(`${log}.1`)).toBe('new'.repeat(50))
    expect(text(`${log}.2`)).toBe('not mine')
    expect(text(join(d, 'other.log.1'))).toBe('another log')
  })
  it('a path with spaces, &, ^ and ) works', () => {
    const d = join(root(), 'a b & (c) ^d')
    mkdirSync(d)
    const log = sized(join(d, 'my svc.log'), 0, 'y'.repeat(64))
    const r = rotate([log, '10'])
    expect(r).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(existsSync(log)).toBe(false)
    expect(text(`${log}.1`)).toBe('y'.repeat(64))
  })
  it('forward slashes are accepted', () => {
    const d = root()
    const log = sized(join(d, 'svc.log'), 0, 'z'.repeat(64))
    expect(rotate([log.replace(/\\/g, '/'), '10']).status).toBe(0)
    expect(existsSync(`${log}.1`)).toBe(true)
  })
  it('with no argument it exits 0 and says why on stderr', () => {
    expect(rotate([])).toEqual({ status: 0, stdout: '', stderr: '[rotate-log] not rotated: no log was named' })
    expect(rotate([''])).toEqual({ status: 0, stdout: '', stderr: '[rotate-log] not rotated: no log was named' })
  })
  it('the default cap is 50 MiB: one byte over rotates, the cap itself does not', () => {
    const d = root()
    const at = sized(join(d, 'at.log'), 52428800)
    const over = sized(join(d, 'over.log'), 52428801)
    expect(rotate([at]).status).toBe(0)
    expect(rotate([over]).status).toBe(0)
    expect(existsSync(at)).toBe(true)
    expect(existsSync(`${at}.1`)).toBe(false)
    expect(existsSync(over)).toBe(false)
    expect(statSync(`${over}.1`).size).toBe(52428801)
  })
  it('the saturation the default relies on: cmd reads 25990666616 as more than 52428800', () => {
    const r = spawnSync('cmd.exe', ['/d', '/c', 'if 25990666616 GTR 52428800 (echo over)'], { encoding: 'utf8', timeout: 20000 })
    expect(r.stdout.trim()).toBe('over')
    const s = spawnSync('cmd.exe', ['/d', '/c', 'if 25990666616 GTR 3000000000 (echo over) else (echo not)'], { encoding: 'utf8', timeout: 20000 })
    expect(s.stdout.trim()).toBe('not')
  })
  it('a .1 it cannot replace (read-only) leaves both files and prints one line; exit 0', () => {
    const d = root()
    const log = sized(join(d, 'svc.log'), 0, 'q'.repeat(64))
    writeFileSync(`${log}.1`, 'kept')
    chmodSync(`${log}.1`, 0o444)
    try {
      const r = rotate([log, '10'])
      expect(r.status).toBe(0)
      expect(r.stderr).toBe(`[rotate-log] could not rotate "${log}" (it may be held open); the service starts anyway`)
      expect(text(log)).toBe('q'.repeat(64))
      expect(text(`${log}.1`)).toBe('kept')
    } finally {
      chmodSync(`${log}.1`, 0o666)
    }
  })

  describe('refusals: each one says why on stderr, exits 0 and changes nothing', () => {
    const NOT = '[rotate-log] not rotated'
    it('a relative path, a drive-relative path and a path rooted on the current drive', () => {
      const d = root()
      const log = sized(join(d, 'svc.log'), 0, 'r'.repeat(64))
      for (const arg of ['svc.log', '.\\svc.log', `${d.slice(0, 2)}svc.log`, d.slice(2) + '\\svc.log']) {
        const r = rotate([arg, '10'], { cwd: d })
        expect(r.status, arg).toBe(0)
        expect(r.stderr, arg).toBe(`${NOT} "${arg}": it is not a full path below a drive letter`)
      }
      expect(text(log)).toBe('r'.repeat(64))
      expect(existsSync(`${log}.1`)).toBe(false)
    })
    it('a share name (no drive letter)', () => {
      const arg = '\\\\localhost\\nothing-here\\svc.log'
      expect(rotate([arg, '10']).stderr).toBe(`${NOT} "${arg}": it is not a full path below a drive letter`)
    })
    it('a wildcard, * or ?', () => {
      const d = root()
      const a = sized(join(d, 'a.log'), 0, 'w'.repeat(64))
      const b = sized(join(d, 'b.log'), 0, 'w'.repeat(64))
      for (const arg of [join(d, '*.log'), join(d, '?.log')]) {
        expect(rotate([arg, '10']).stderr, arg).toBe(`${NOT} "${arg}": the path holds a wildcard`)
      }
      expect(existsSync(a) && existsSync(b)).toBe(true)
      expect(existsSync(`${a}.1`) || existsSync(`${b}.1`)).toBe(false)
    })
    it('a name that does not end .log', () => {
      const d = root()
      for (const name of ['svc.txt', 'svc.log.1', 'svc']) {
        const p = sized(join(d, name), 0, 'n'.repeat(64))
        expect(rotate([p, '10']).stderr, name).toBe(`${NOT} "${p}": its name does not end .log`)
        expect(text(p)).toBe('n'.repeat(64))
      }
    })
    it('a cap that is not a decimal number from 1 to 2147483646', () => {
      const d = root()
      const log = sized(join(d, 'svc.log'), 0, 'c'.repeat(64))
      for (const max of ['abc', '1e3', '-5', '0', '010', '2147483647', '99999999999']) {
        const r = rotate([log, max])
        expect(r.stderr, max).toBe(`${NOT} "${log}": the cap "${max}" is not a decimal number from 1 to 2147483646`)
      }
      expect(text(log)).toBe('c'.repeat(64))
    })
    it('a file in a volume root (never created: refused before the disk is looked at)', () => {
      const arg = 'C:\\cynco-rotate-test-never-created.log'
      expect(rotate([arg, '10']).stderr).toBe(`${NOT} "${arg}": it lies in a volume root`)
    })
    it('a file in the home folder, or in a folder that contains it', () => {
      const d = root()
      const home = join(d, 'users', 'someone')
      mkdirSync(home, { recursive: true })
      const inHome = sized(join(home, 'svc.log'), 0, 'h'.repeat(64))
      const above = sized(join(d, 'users', 'svc.log'), 0, 'h'.repeat(64))
      const top = sized(join(d, 'svc.log'), 0, 'h'.repeat(64))
      const env = { USERPROFILE: home }
      expect(rotate([inHome, '10'], { env }).stderr).toBe(`${NOT} "${inHome}": its folder is the home folder or contains it`)
      expect(rotate([above, '10'], { env }).stderr).toBe(`${NOT} "${above}": its folder is the home folder or contains it`)
      expect(rotate([top, '10'], { env }).stderr).toBe(`${NOT} "${top}": its folder is the home folder or contains it`)
      // The home folder named with another case and a trailing backslash is still the home folder.
      expect(rotate([inHome, '10'], { env: { USERPROFILE: home.toUpperCase() + '\\' } }).stderr)
        .toBe(`${NOT} "${inHome}": its folder is the home folder or contains it`)
      for (const p of [inHome, above, top]) {
        expect(text(p)).toBe('h'.repeat(64))
        expect(existsSync(`${p}.1`)).toBe(false)
      }
      // A folder below the home (where the launchers' logs are) is rotated.
      const cynco = join(home, '.cynco')
      mkdirSync(cynco)
      const svc = sized(join(cynco, 'svc.log'), 0, 'h'.repeat(64))
      expect(rotate([svc, '10'], { env }).stderr).toBe('')
      expect(existsSync(`${svc}.1`)).toBe(true)
    })
    it('no USERPROFILE: the home folder cannot be ruled out', () => {
      const d = root()
      const log = sized(join(d, 'svc.log'), 0, 'u'.repeat(64))
      // Set empty, not removed: the child-process layer puts a missing USERPROFILE back, and an empty
      // variable is not defined for cmd.
      const r = rotate([log, '10'], { env: { USERPROFILE: '' } })
      expect(r.stderr).toBe(`${NOT} "${log}": USERPROFILE is not set, so the home folder cannot be ruled out`)
      expect(text(log)).toBe('u'.repeat(64))
    })
    it('a folder with a .log name is left, and so is what is in it', () => {
      const d = root()
      const dir = join(d, 'svc.log')
      mkdirSync(dir)
      writeFileSync(join(dir, 'inner.txt'), 'inside')
      expect(rotate([dir, '1']).stderr).toBe(`${NOT} "${dir}": it is a folder`)
      expect(text(join(dir, 'inner.txt'))).toBe('inside')
      expect(existsSync(`${dir}.1`)).toBe(false)
    })
    it('a log whose folder is a junction, and a junction with a .log name', () => {
      const d = root()
      const real = join(d, 'real')
      mkdirSync(real)
      const target = sized(join(real, 'svc.log'), 0, 'j'.repeat(64))
      const jn = join(d, 'jn')
      symlinkSync(real, jn, 'junction')
      const through = join(jn, 'svc.log')
      expect(rotate([through, '10']).stderr).toBe(`${NOT} "${through}": its folder is a link or a junction`)
      const named = join(d, 'named.log')
      symlinkSync(real, named, 'junction')
      expect(rotate([named, '1']).stderr).toBe(`${NOT} "${named}": it is a folder`)
      expect(text(target)).toBe('j'.repeat(64))
      expect(existsSync(`${target}.1`) || existsSync(`${named}.1`)).toBe(false)
    })
    // Review of wave 5: a junction further up was followed, and the previous <log>.1 in its target replaced.
    it('a log below a junction further up its path: nothing is renamed, the previous file is kept', () => {
      const d = root()
      const real = join(d, 'real')
      mkdirSync(join(real, 'sub'), { recursive: true })
      const target = sized(join(real, 'sub', 'svc.log'), 0, 'k'.repeat(100))
      writeFileSync(`${target}.1`, 'PREVIOUS')
      const jn = join(d, 'jn')
      symlinkSync(real, jn, 'junction')
      const through = join(jn, 'sub', 'svc.log')
      expect(rotate([through, '10']).stderr).toBe(`${NOT} "${through}": a folder above it is a link or a junction`)
      expect(text(target)).toBe('k'.repeat(100))
      expect(text(`${target}.1`)).toBe('PREVIOUS')
    })
    it('a log that is a file symbolic link (when this account may make one)', (ctx) => {
      const d = root()
      const real = sized(join(d, 'real.txt'), 0, 's'.repeat(64))
      const link = join(d, 'svc.log')
      try {
        symlinkSync(real, link, 'file')
      } catch (e) {
        ctx.skip(`no symbolic-link privilege here: ${e.code}`)
        return
      }
      expect(rotate([link, '10']).stderr).toBe(`${NOT} "${link}": it is a link`)
      expect(text(real)).toBe('s'.repeat(64))
      expect(existsSync(`${link}.1`)).toBe(false)
    })
    it('a <log>.1 that is a folder or a junction', () => {
      const d = root()
      const log = sized(join(d, 'svc.log'), 0, 'o'.repeat(64))
      mkdirSync(`${log}.1`)
      writeFileSync(join(`${log}.1`, 'inner.txt'), 'inside')
      expect(rotate([log, '10']).stderr).toBe(`${NOT} "${log}": "${log}.1" is a folder or a link`)
      expect(text(log)).toBe('o'.repeat(64))
      expect(text(join(`${log}.1`, 'inner.txt'))).toBe('inside')

      const real = join(d, 'real')
      mkdirSync(real)
      writeFileSync(join(real, 'keep.txt'), 'keep')
      const log2 = sized(join(d, 'two.log'), 0, 'o'.repeat(64))
      symlinkSync(real, `${log2}.1`, 'junction')
      expect(rotate([log2, '10']).stderr).toBe(`${NOT} "${log2}": "${log2}.1" is a folder or a link`)
      expect(text(log2)).toBe('o'.repeat(64))
      expect(text(join(real, 'keep.txt'))).toBe('keep')
    })
  })
})

// Wave 15 (NOW.md:91): the rotation's refusal or failure line no longer goes to the launcher's standard
// error, which Task Scheduler drops. It goes to a small file of its own beside the log, "<svc>.rotate.log",
// NOT to the log itself: measured on 2026-11-24, "2>> <log>" opens the log before the rotation runs and
// holds it, so the rename always fails ("could not rotate ... (it may be held open)") and the log is never
// rotated again. The case below runs both shapes for real.
const LAUNCHERS = [
  ['run-box-reporter.cmd', 'box-reporter'], ['run-daemon.cmd', 'daemon'],
  ['run-embed-server.cmd', 'embed-server'], ['run-headless-engine.cmd', 'engine-headless'],
]
describe('wave 15: the rotation\'s own line reaches a file', () => {
  it('each launcher sends the rotation\'s standard error to <svc>.rotate.log beside the log, never to the log itself', () => {
    for (const [name, svc] of LAUNCHERS) {
      const lines = text(join(scripts, name)).split(/\r?\n/)
      const calls = lines.filter(l => l.startsWith('call "%~dp0rotate-log.cmd" '))
      expect(calls, name).toEqual([`call "%~dp0rotate-log.cmd" "%USERPROFILE%\\.cynco\\${svc}.log" 2>> "%USERPROFILE%\\.cynco\\${svc}.rotate.log"`])
    }
  })
  it.skipIf(process.platform !== 'win32')('run for real: "2>> <log>" holds the log and it is not rotated; a file of its own rotates it and keeps the line', () => {
    const d = root()
    const same = sized(join(d, 'same.log'), 0, 'x'.repeat(200))
    const other = sized(join(d, 'other.log'), 0, 'x'.repeat(200))
    const line = (log, errFile) => `call "${SCRIPT}" "${log}" 10 2>> "${errFile}"`
    const run = (l) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${l}"`], { windowsVerbatimArguments: true, encoding: 'utf8', timeout: 20000 })
    expect(run(line(same, same)).status).toBe(0)
    expect(existsSync(`${same}.1`)).toBe(false)
    expect(text(same)).toContain(`[rotate-log] could not rotate "${same}" (it may be held open); the service starts anyway`)
    expect(run(line(other, join(d, 'other.rotate.log'))).status).toBe(0)
    expect(existsSync(other)).toBe(false)
    expect(text(`${other}.1`)).toBe('x'.repeat(200))
    expect(run(line(join(d, 'bad.txt'), join(d, 'other.rotate.log'))).status).toBe(0)
    expect(text(join(d, 'other.rotate.log'))).toContain(`[rotate-log] not rotated "${join(d, 'bad.txt')}": its name does not end .log`)
  })
})
