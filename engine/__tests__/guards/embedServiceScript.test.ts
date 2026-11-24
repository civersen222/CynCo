// The CynCo embedding service (docs/decisions/2026-11-08-embeddings-own-llama-server.md):
// the start script, the services row and the README must name the same server.
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cmd = readFileSync(join(root, 'scripts', 'run-embed-server.cmd'), 'utf8')
const services = readFileSync(join(root, 'scripts', 'cynco-services.ps1'), 'utf8')
const readme = readFileSync(join(root, 'README.md'), 'utf8')

describe('embed service', () => {
  it('serves embeddings on 127.0.0.1:9165 from the engine\'s own llama-server, CPU only, mean pooling for nomic', () => {
    expect(cmd).toContain('.cynco\\bin\\llama-server.exe')
    expect(cmd).toContain('--embeddings')
    expect(cmd).toContain('--host 127.0.0.1 --port 9165')
    expect(cmd).toContain('--pooling mean')
    expect(cmd).toContain('-ngl 0')
    expect(cmd).toContain('nomic-embed-text-v1.5.f16.gguf')
  })
  it('takes its GGUF from LOCALCODE_MODELS_DIR, else .cynco\\models under the profile, and refuses before the launch when it is not there', () => {
    expect(cmd).toContain('if not defined LOCALCODE_MODELS_DIR set "LOCALCODE_MODELS_DIR=%USERPROFILE%\\.cynco\\models"')
    expect(cmd).toContain('set "CYNCO_EMBED_MODEL=%LOCALCODE_MODELS_DIR%\\nomic-embed-text-v1.5.f16.gguf"')
    // Every set of the folder is quoted (a name with & would otherwise run the rest as a command), and a
    // value that is not X:\... is refused before the model line (review 2026-11-23).
    expect(cmd).not.toMatch(/^set (?!")/mi)
    expect(cmd).toContain('if not "%LOCALCODE_MODELS_DIR:~1,2%"==":\\" goto not_full')
    expect(cmd.indexOf('goto not_full')).toBeLessThan(cmd.indexOf('set "CYNCO_EMBED_MODEL='))
    expect(cmd).not.toContain('%USERPROFILE%\\.cynco\\models\\nomic-embed-text')
    expect(cmd.indexOf('REFUSING to start')).toBeGreaterThan(-1)
    expect(cmd.indexOf('REFUSING to start')).toBeLessThan(cmd.indexOf('--embeddings'))
    // Ruling 3.21: the log rotation, once it exists, runs before the evidence line.
    if (cmd.includes('rotate-log.cmd')) expect(cmd.indexOf('rotate-log.cmd')).toBeLessThan(cmd.indexOf('[embed] model'))
  })
  it('starts with no prompt cache and warnings only, after rotating its log first (F242, slice S8)', () => {
    const lines = cmd.split(/\r?\n/)
    const launch = lines.findIndex(l => l.includes('llama-server.exe') && l.includes('--embeddings'))
    expect(launch).toBeGreaterThan(-1)
    // The prompt cache printed its whole listing on every request: the measured cause of the 26 GB log.
    expect(lines[launch]).toMatch(/--no-webui --cache-ram 0 -lv 2 >> /)
    const rotate = lines.findIndex(l => l === 'call "%~dp0rotate-log.cmd" "%USERPROFILE%\\.cynco\\embed-server.log"')
    expect(rotate).toBeGreaterThan(-1)
    // First: before the models-folder lines, before every line that appends to the log, before the launch.
    expect(rotate).toBeLessThan(lines.findIndex(l => l.includes('LOCALCODE_MODELS_DIR') && !/^rem\b/i.test(l)))
    expect(rotate).toBeLessThan(lines.findIndex(l => l.includes('>> "%USERPROFILE%\\.cynco\\embed-server.log"')))
    expect(rotate).toBeLessThan(launch)
    expect(lines.slice(0, rotate).every(l => l === '@echo off' || /^rem\b/i.test(l))).toBe(true)
    // The launch line stays the last line, so the server's exit code reaches Task Scheduler.
    expect(lines.filter(l => l !== '').pop()).toBe(lines[launch])
    // F91's one-decision rule is the chat server's; the reason 0 is not a hand-set budget is on the file.
    expect(cmd).toContain('rem this server has no checkpoints, so 0 here is not a hand-set budget.')
  })
  it.skipIf(process.platform !== 'win32')('refuses without its GGUF and names the model it starts with (run for real in a temporary profile)', () => {
    const P = mkdtempSync(join(tmpdir(), 'cynco-embed-profile-'))
    const M = mkdtempSync(join(tmpdir(), 'cynco-embed-models-'))
    try {
      mkdirSync(join(P, '.cynco'))
      const script = join(root, 'scripts', 'run-embed-server.cmd')
      const run = () => spawnSync('cmd.exe', ['/d', '/c', script], {
        env: { ...process.env, USERPROFILE: P, LOCALCODE_MODELS_DIR: M }, encoding: 'utf8', timeout: 20000,
      })
      const log = join(P, '.cynco', 'embed-server.log')
      // cmd's `echo ... >> file` keeps the space before the redirect, so each line is trimmed at its end.
      const lines = () => readFileSync(log, 'utf8').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l !== '')
      const gguf = join(M, 'nomic-embed-text-v1.5.f16.gguf')

      expect(run().status).toBe(1)
      expect(existsSync(log)).toBe(true)
      const last = lines()[lines().length - 1]
      expect(last.startsWith('[embed] REFUSING to start: "')).toBe(true)
      expect(last).toContain(gguf)

      writeFileSync(gguf, '')
      run()
      const after = lines()
      const refusing = after.findIndex(l => l.startsWith('[embed] REFUSING to start'))
      const model = after.findIndex(l => l === `[embed] model "${gguf}"`)
      expect(model).toBeGreaterThan(refusing)
      // No server can have started: the temporary profile has no llama-server.
      expect(existsSync(join(P, '.cynco', 'bin', 'llama-server.exe'))).toBe(false)
    } finally {
      rmSync(P, { recursive: true, force: true })
      rmSync(M, { recursive: true, force: true })
    }
  })
  it.skipIf(process.platform !== 'win32')('a models folder whose name holds & or ^ is used as written, and a relative one is refused (run for real, review 2026-11-23)', () => {
    const P = mkdtempSync(join(tmpdir(), 'cynco-embed-profile-'))
    const M = mkdtempSync(join(tmpdir(), 'cynco-embed-models-'))
    try {
      mkdirSync(join(P, '.cynco'))
      const script = join(root, 'scripts', 'run-embed-server.cmd')
      const log = join(P, '.cynco', 'embed-server.log')
      const lines = () => readFileSync(log, 'utf8').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l !== '')
      const lastLine = () => lines().pop() ?? ''
      const run = (models: string) => spawnSync('cmd.exe', ['/d', '/c', script], {
        env: { ...process.env, USERPROFILE: P, LOCALCODE_MODELS_DIR: models }, encoding: 'utf8', timeout: 20000,
      })
      for (const name of ['amp & co', 'caret^x']) {
        const dir = join(M, name)
        mkdirSync(dir)
        const gguf = join(dir, 'nomic-embed-text-v1.5.f16.gguf')
        writeFileSync(gguf, '')
        const r = run(dir)
        // The launch line then fails into the log (the temporary profile has no llama-server).
        expect(r.stderr, name).toBe('')
        expect(lines(), name).toContain(`[embed] model "${gguf}"`)
      }
      const rel = run('relmodels')
      expect(rel.status).toBe(1)
      expect(lastLine()).toBe('[embed] REFUSING to start: LOCALCODE_MODELS_DIR "relmodels" is not a full path below a drive letter.')
    } finally {
      rmSync(P, { recursive: true, force: true })
      rmSync(M, { recursive: true, force: true })
    }
  })
  it('is a registered CynCo service the services script can start, stop and register', () => {
    expect(services).toMatch(/Name = 'embed';\s+Task = 'CynCo embed server';\s+Match = 'llama-server\.\*--embeddings'/)
    expect(services).toContain("scripts\\run-embed-server.cmd")
    expect(services).toContain('127.0.0.1:9165')
  })
  it('the README tells an operator the three variables that point the engines at it', () => {
    expect(readme).toContain('LOCALCODE_EMBED_BASE_URL=http://127.0.0.1:9165')
    expect(readme).toContain('LOCALCODE_EMBED_API=openai')
    expect(readme).toContain('LOCALCODE_EMBED_MODEL=nomic-embed-text')
  })
})
