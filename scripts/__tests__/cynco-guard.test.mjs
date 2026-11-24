// scripts/cynco-guard.mjs: the command line over the integrity layer (F242, engine/integrity.ts).
//
// In process through main(argv, deps): every folder (home, guard, models, the mission folder) is
// under this file's own mkdtemp folders, the page sender is injected, and the volume listing is
// injected empty. The state and models folders are named to the integrity module through
// CYNCO_HOME and LOCALCODE_MODELS_DIR for the length of one test and put back after it.
// The spawned round trip runs the script under bun with a fake home (USERPROFILE and HOME), a guard
// folder outside it, and no CYNCO_NTFY_URL, so its page is kept in unsent/ and never sent.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { main, USAGE } from '../cynco-guard.mjs'
import { mintRunId } from '../../engine/containment.js'

const isWin = process.platform === 'win32'
const bunPresent = spawnSync('bun', ['--version'], { encoding: 'utf-8', shell: isWin }).status === 0
const dirs = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
const tmp = (label) => { const d = mkdtempSync(join(tmpdir(), `cynco-guard-cli-${label}-`)); dirs.push(d); return d }
const T0 = new Date('2020-01-01T00:00:00Z')
const put = (p, text = 'x') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); utimesSync(p, T0, T0) }

/** A fake machine: a home with a state folder and its models, a guard folder, a mission folder. */
function machine() {
  const base = tmp('m')
  const home = join(base, 'home')
  const guard = join(base, 'guard')
  const repo = join(base, 'repo')
  for (const d of [home, guard, repo]) mkdirSync(d)
  const state = join(home, '.cynco')
  const models = join(home, 'models')
  put(join(models, 'm', 'a.gguf'), 'aaaa')
  put(join(state, 'profiles', 'p.yaml'), 'p')
  put(join(state, 'heldout', 'g', 'gate.py'), 'g')
  put(join(home, '.config', 'a'))
  put(join(home, '.config', 'b'))
  return { base, home, guard, repo, state, models }
}

const saved = {}
let current = null
beforeEach(() => { for (const k of ['CYNCO_HOME', 'LOCALCODE_MODELS_DIR']) saved[k] = process.env[k] })
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  current = null
})
function use(m) {
  process.env.CYNCO_HOME = m.state
  process.env.LOCALCODE_MODELS_DIR = m.models
  current = m
  return m
}

/** deps for main: this machine's folders, captured output, an injected sender that answers `answer`. */
function io(m = current, over = {}) {
  const o = { lines: [], errs: [], pages: [] }
  o.deps = {
    env: {}, guard: m.guard, home: m.home, volumes: () => [],
    out: l => o.lines.push(l), err: l => o.errs.push(l),
    page: async p => { o.pages.push(p); return true },
    ...over,
  }
  return o
}
const latchOf = (m) => JSON.parse(readFileSync(join(m.guard, 'HALT.json'), 'utf-8'))
async function ready(m) {
  use(m)
  expect(await main(['hash-models'], io(m).deps)).toBe(0)
  return m
}
async function pre(m, id = mintRunId('cli'), extra = []) {
  const o = io(m)
  expect(await main(['pre', id, '--cwd', m.repo, ...extra], o.deps), o.errs.join('\n')).toBe(0)
  return id
}

describe('status --quiet', () => {
  it('(1) prints exactly one line: clear, the latch, or the missing folder; and sends nothing', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }))
    const m = use(machine())
    const env = { CYNCO_NTFY_URL: 'http://127.0.0.1:9/' }
    let o = io(m, { env, fetch: fetchSpy, page: undefined })
    expect(await main(['status', '--quiet'], o.deps)).toBe(0)
    expect(o.lines).toEqual(['clear'])
    writeFileSync(join(m.guard, 'HALT.json'), '')
    o = io(m, { env, fetch: fetchSpy, page: undefined })
    expect(await main(['status', '--quiet'], o.deps)).toBe(3)
    expect(o.lines).toHaveLength(1)
    expect(o.lines[0]).toMatch(/^the integrity latch is present at .*HALT\.json \(latch unreadable\); only the owner clears it/)
    o = io(m, { env, fetch: fetchSpy, page: undefined, guard: join(m.base, 'missing') })
    expect(await main(['status', '--quiet'], o.deps)).toBe(3)
    expect(o.lines).toEqual([`the guard folder ${join(m.base, 'missing')} does not exist; scripts\\cynco-containment-setup.ps1 creates it, a run never does`])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('status', () => {
  it('(2) lists an open baseline with its age and re-sends a kept page', async () => {
    const m = await ready(machine())
    const id = await pre(m)
    mkdirSync(join(m.guard, 'unsent'))
    writeFileSync(join(m.guard, 'unsent', '20260101T000000-1.json'), JSON.stringify({ title: 't', message: 'kept page', priority: 5, at: '2026-01-01T00:00:00.000Z' }))
    const o = io(m, { env: { CYNCO_NTFY_URL: 'http://example.invalid' } })
    expect(await main(['status'], o.deps)).toBe(0)
    expect(o.lines[0]).toBe('clear')
    expect(o.lines.some(l => l.startsWith(`[guard] open baseline ${id}: taken `) && / ago$/.test(l))).toBe(true)
    expect(o.lines).toContain('[guard] unsent pages: 1')
    expect(o.lines.some(l => /^\[guard\] models record: ok \(1 files, taken /.test(l))).toBe(true)
    expect(o.lines).toContain('[guard] re-sent 1 page(s), 0 left')
    expect(o.pages.map(p => p.message)).toEqual(['(late) kept page'])
  })
})

describe('pre and post', () => {
  it('(3) pre writes the baseline and one line; a latch refuses it; --also is excluded', async () => {
    const m = await ready(machine())
    const also = join(m.base, 'also')
    mkdirSync(also)
    const id = mintRunId('cli')
    const o = io(m)
    expect(await main(['pre', id, '--cwd', m.repo, '--also', also, '--by', 'dispatch'], o.deps)).toBe(0)
    expect(o.lines[0]).toMatch(new RegExp(`^\\[guard\\] integrity baseline ${id}: \\d+ frozen entries, \\d+ presence entries, \\d+ ms$`))
    const b = JSON.parse(readFileSync(join(m.guard, 'manifests', `${id}.before.json`), 'utf-8'))
    expect(b.by).toBe('dispatch')
    expect(b.exclude.map(p => basename(p))).toEqual(['repo', 'also'])
    writeFileSync(join(m.guard, 'HALT.json'), '')
    const id2 = mintRunId('cli')
    const r = io(m)
    expect(await main(['pre', id2, '--cwd', m.repo], r.deps)).toBe(3)
    expect(r.errs[0]).toMatch(/^\[guard\] REFUSED: integrity: the integrity latch is present at .* — nothing was dispatched$/)
    expect(existsSync(join(m.guard, 'manifests', `${id2}.before.json`))).toBe(false)
  })

  it('(4) post: clean exits 0; a file added to a frozen folder exits 3 with the latch and a priority-5 page', async () => {
    const m = await ready(machine())
    const id = await pre(m)
    let o = io(m)
    expect(await main(['post', id], o.deps)).toBe(0)
    expect(o.lines[0]).toMatch(new RegExp(`^\\[guard\\] integrity unchanged for ${id} \\(\\d+ entries, \\d+ ms\\)$`))
    const id2 = await pre(m)
    put(join(m.state, 'profiles', 'planted.yaml'))
    o = io(m)
    expect(await main(['post', id2, '--by', 'dispatch-watcher'], o.deps)).toBe(3)
    expect(o.lines[0]).toMatch(/^\[guard\] INTEGRITY: 1 change\(s\) in protected folders; first: FROZEN .*planted\.yaml added\. If you changed it yourself while a run was open \(open runs: bun scripts\/cynco-guard\.mjs status\), it is your own change: clear the latch, and the next run's baseline takes the folders as they are then$/)
    expect(o.lines[1]).toBe(`[guard] latch: ${join(m.guard, 'HALT.json')}`)
    expect(latchOf(m)).toMatchObject({ run: id2, reason: 'integrity-change', by: 'dispatch-watcher' })
    expect(o.pages).toHaveLength(1)
    expect(o.pages[0].priority).toBe(5)
  }, 30_000)

  it('(5) post for a run with no baseline exits 3 and latches manifest-error', async () => {
    const m = use(machine())
    const o = io(m)
    expect(await main(['post', mintRunId('cli')], o.deps)).toBe(3)
    expect(latchOf(m).reason).toBe('manifest-error')
  })

  it('(6) --engine-not-confirmed-dead latches with that reason and keeps the baseline open', async () => {
    const m = await ready(machine())
    const id = await pre(m)
    const o = io(m)
    expect(await main(['post', id, '--engine-not-confirmed-dead', 'pid 1 still listed'], o.deps)).toBe(3)
    expect(o.lines[0]).toBe(`[guard] INTEGRITY: the engine of run ${id} is not confirmed dead (pid 1 still listed); the integrity latch is set and the baseline stays open`)
    expect(latchOf(m)).toMatchObject({ reason: 'engine-not-confirmed-dead', detail: 'pid 1 still listed' })
    expect(existsSync(join(m.guard, 'manifests', `${id}.before.json`))).toBe(true)
  })
})

describe('clear', () => {
  const terminal = (answer) => Object.assign(Readable.from([`${answer}\n`]), { isTTY: true })

  it('(7) needs a terminal and the typed word; prints open baselines with the post command', async () => {
    const m = await ready(machine())
    const id = await pre(m)
    writeFileSync(join(m.guard, 'HALT.json'), JSON.stringify({ schema: 1, publicSummary: 'p', summary: 's', at: 'a', by: 'b', run: id, reason: 'integrity-change', changes: [], changeCount: 0 }))
    let o = io(m, { stdin: Readable.from(['CLEAR\n']) })
    expect(await main(['clear'], o.deps)).toBe(3)
    expect(o.errs).toContain('[guard] clear needs a person at a terminal; nothing was changed')
    expect(existsSync(join(m.guard, 'HALT.json'))).toBe(true)
    expect(o.lines.some(l => l.includes(`open baseline ${id}`) && l.endsWith(`bun scripts/cynco-guard.mjs post ${id}`))).toBe(true)
    o = io(m, { stdin: terminal('yes') })
    expect(await main(['clear'], o.deps)).toBe(3)
    expect(o.errs).toContain('[guard] nothing was changed')
    expect(existsSync(join(m.guard, 'HALT.json'))).toBe(true)
    o = io(m, { stdin: terminal('CLEAR') })
    expect(await main(['clear'], o.deps)).toBe(0)
    expect(o.lines).toContain('Type CLEAR to remove the integrity latch:')
    expect(o.lines[o.lines.length - 1]).toMatch(/^\[guard\] cleared; the latch is kept at .*HALT-\d{8}T\d{6}\.json$/)
    expect(existsSync(join(m.guard, 'HALT.json'))).toBe(false)
    expect(readdirSync(join(m.guard, 'cleared'))).toHaveLength(1)
  })
})

// Review of wave 5 (findings 11 and 13): the owner's natural order (clear, tidy up, post) re-latched and
// paged twice, and the waiting page was sent late after the clear.
describe('clear after an engine that was not confirmed dead', () => {
  const terminal = (answer) => Object.assign(Readable.from([`${answer}\n`]), { isTTY: true })

  it('(9) clear withdraws the waiting page, compares the run at the desk with no page, closes its baseline, and a later tidy-up latches nothing', async () => {
    const m = await ready(machine())
    const id = await pre(m)
    rmSync(join(m.home, '.config'), { recursive: true })
    const down = io(m, { page: async () => false })
    expect(await main(['post', id, '--engine-not-confirmed-dead', 'pid 4242 still listed'], down.deps)).toBe(3)
    expect(readdirSync(join(m.guard, 'unsent'))).toHaveLength(1)
    const o = io(m, { stdin: terminal('CLEAR') })
    expect(await main(['clear'], o.deps)).toBe(0)
    expect(o.lines).toContain(`[guard] 1 unsent page(s) about this latch withdrawn (kept in ${join(m.guard, 'cleared', 'pages')})`)
    const said = o.lines.find(l => l.startsWith(`[guard] run ${id} (the latch you cleared said its engine was not confirmed dead): compared now, `))
    expect(said, o.lines.join('\n')).toMatch(/1 change\(s\) in protected folders; first: PRESENCE .*\.config gone/)
    expect(o.lines).toContain('[guard] nothing was latched: you are at the desk; look at these before the next run')
    expect(o.pages).toEqual([])
    expect(existsSync(join(m.guard, 'HALT.json'))).toBe(false)
    expect(existsSync(join(m.guard, 'manifests', `${id}.before.json`))).toBe(false)
    expect(readdirSync(join(m.guard, 'unsent'))).toEqual([])
    // The owner tidies up afterwards: nothing is open, so nothing latches and nothing pages.
    put(join(m.home, '.leftover', 'x'))
    rmSync(join(m.home, '.leftover'), { recursive: true })
    const s = io(m)
    expect(await main(['status', '--quiet'], s.deps)).toBe(0)
  })

  it('(10) without a console it names the remedy for a Git Bash window', async () => {
    const m = await ready(machine())
    writeFileSync(join(m.guard, 'HALT.json'), JSON.stringify({ schema: 1, publicSummary: 'p', summary: 's', at: 'a', by: 'b', run: 'r', reason: 'integrity-change', changes: [], changeCount: 0 }))
    const o = io(m, { stdin: Readable.from(['CLEAR\n']) })
    expect(await main(['clear'], o.deps)).toBe(3)
    expect(o.errs).toContain('[guard] (its input is not a console here: in a Git Bash window run it as winpty bun scripts/cynco-guard.mjs clear, or run it from PowerShell or Windows Terminal)')
  })
})

describe('hash-models and verify', () => {
  it('(8) verify is ok after hash-models, names a touched file, and --deep finds a content change', async () => {
    const m = await ready(machine())
    let o = io(m)
    expect(await main(['verify'], o.deps)).toBe(0)
    expect(o.lines).toEqual(['[guard] models record: ok'])
    const f = join(m.models, 'm', 'a.gguf')
    utimesSync(f, T0, new Date('2021-02-03'))
    o = io(m)
    expect(await main(['verify'], o.deps)).toBe(3)
    expect(o.lines[0]).toMatch(/\(first: m\/a\.gguf time\)/)
    put(f, 'AAAA')
    o = io(m)
    expect(await main(['verify'], o.deps)).toBe(0)
    o = io(m)
    expect(await main(['verify', '--deep'], o.deps)).toBe(3)
    expect(o.lines).toContain('[guard]   m/a.gguf: content differs from the recorded hash')
  })
})

describe('usage', () => {
  it('(9) bad usage exits 2 with the verb list and touches nothing', async () => {
    const m = use(machine())
    for (const argv of [[], ['nonsense'], ['pre'], ['pre', 'x'], ['pre', 'x', '--cwd'], ['post'], ['post', 'a', 'b'], ['status', 'x'], ['verify', '--bogus'], ['clear', 'now'], ['hash-models', '--some']]) {
      const o = io(m)
      expect(await main(argv, o.deps), argv.join(' ')).toBe(2)
      expect(o.errs.join('\n')).toContain(USAGE)
    }
    expect(readdirSync(m.guard)).toEqual([])
  })
})

describe('an unusable guard folder (review finding 14)', () => {
  it('(10) hash-models refuses a guard folder inside the home and writes nothing', async () => {
    const m = use(machine())
    const inHome = join(m.home, 'guard-in-home')
    mkdirSync(inHome)
    const o = io(m, { guard: inHome })
    expect(await main(['hash-models'], o.deps)).toBe(3)
    expect(o.errs[0]).toBe(`[guard] the models record was not written: the guard folder ${inHome} resolves inside the home folder ${m.home}`)
    expect(readdirSync(inHome)).toEqual([])
  })

  it.skipIf(!isWin)('(11) hash-models refuses a guard folder without a drive letter', async () => {
    const m = use(machine())
    const o = io(m, { guard: m.guard.slice(2) })
    expect(await main(['hash-models'], o.deps)).toBe(3)
    expect(o.errs[0]).toMatch(/does not start with a drive letter/)
    expect(readdirSync(m.guard)).toEqual([])
  })

  it('(12) status does not move kept pages in an unusable folder; post says on stderr why the folder is wrong', async () => {
    const m = use(machine())
    const inHome = join(m.home, 'guard-in-home')
    mkdirSync(join(inHome, 'unsent'), { recursive: true })
    writeFileSync(join(inHome, 'unsent', 'a.json'), JSON.stringify({ title: 't', message: 'kept', priority: 5, at: '2026-01-01T00:00:00.000Z' }))
    let o = io(m, { guard: inHome, env: { CYNCO_NTFY_URL: 'http://example.invalid' } })
    expect(await main(['status'], o.deps)).toBe(3)
    expect(o.lines).toContain('[guard] unsent pages were not re-sent: the guard folder cannot be used')
    expect(o.pages).toEqual([])
    expect(readdirSync(join(inHome, 'unsent'))).toEqual(['a.json'])
    o = io(m, { guard: inHome })
    expect(await main(['post', mintRunId('cli')], o.deps)).toBe(3)
    expect(o.errs[0]).toBe(`[guard] the guard folder ${inHome} resolves inside the home folder ${m.home}`)
  })
})

describe.skipIf(!bunPresent)('cynco-guard.mjs as real processes', () => {
  const q = (a) => (isWin ? `"${a}"` : a)
  it('pre then post exit 0; a dot-folder deleted between them exits 3, latches and keeps the page', () => {
    const home = tmp('rt-home')
    const guard = tmp('rt-guard')
    const repo = tmp('rt-repo')
    put(join(home, '.config', 'a'))
    put(join(home, '.config', 'b'))
    put(join(home, '.cynco', 'profiles', 'p.yaml'))
    put(join(home, 'models', 'm.gguf'))
    const env = { ...process.env, USERPROFILE: home, HOME: home, CYNCO_HOME: join(home, '.cynco'), LOCALCODE_MODELS_DIR: join(home, 'models'), LOCALCODE_GUARD_DIR: guard }
    for (const k of Object.keys(env)) if (k.startsWith('CYNCO_NTFY_')) delete env[k]
    const cli = (...args) => {
      const r = spawnSync('bun', ['scripts/cynco-guard.mjs', ...args].map(q), { encoding: 'utf-8', shell: isWin, env, timeout: 60_000 })
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    }
    let r = cli('hash-models')
    expect(r.status, r.out).toBe(0)
    const id1 = mintRunId('rt')
    r = cli('pre', id1, '--cwd', repo)
    expect(r.status, r.out).toBe(0)
    r = cli('post', id1)
    expect(r.status, r.out).toBe(0)
    const id2 = mintRunId('rt')
    r = cli('pre', id2, '--cwd', repo)
    expect(r.status, r.out).toBe(0)
    rmSync(join(home, '.config'), { recursive: true })
    r = cli('post', id2)
    expect(r.status, r.out).toBe(3)
    expect(r.out).toContain('[guard] INTEGRITY: ')
    expect(r.out).toContain('PAGE NOT SENT')
    expect(existsSync(join(guard, 'HALT.json'))).toBe(true)
    expect(readdirSync(join(guard, 'unsent'))).toHaveLength(1)
    r = cli('status', '--quiet')
    expect(r.status).toBe(3)
    expect(r.out.trim().split('\n')).toHaveLength(1)
  }, 120_000)
})
