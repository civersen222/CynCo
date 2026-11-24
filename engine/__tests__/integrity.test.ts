// engine/integrity.ts: the manifests, the compare rules, the baseline pair, the integrity latch,
// unsent pages, the frozen-writer refusal, the models record and the in-run tripwire (F242).
//
// Every tree is under this file's own mkdtemp folders; the home folder, the guard folder, the roots
// and the models folder are always passed as arguments, and every pager is injected. No path here is
// derived from the real home folder (one case below asserts it by scanning this file).
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as I from '../integrity.js'
import { mintRunId, testContainment } from '../containment.js'
import { canSymlinkFiles } from './imagegen/mockComfy.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
afterEach(() => I.resetPresenceTripwireForTests())

const tmp = (label: string) => { const d = mkdtempSync(join(tmpdir(), `cynco-integrity-${label}-`)); dirs.push(d); return d }
/** Every file starts at a whole second, so a test can put a time back exactly. */
const T0 = new Date('2020-01-01T00:00:00Z')
const put = (p: string, text = 'x') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); utimesSync(p, T0, T0) }
const rid = (label = 't') => mintRunId(label)
const noSleep = () => {}
const isWin = process.platform === 'win32'

function pager(result: boolean | 'throw' = true) {
  const calls: I.Page[] = []
  const fn: I.Pager = async p => {
    calls.push(p)
    if (result === 'throw') throw new Error('the sender broke')
    return result
  }
  return { fn, calls }
}

const P = (path: string, o: Partial<I.PresenceRoot> = {}): I.PresenceRoot =>
  ({ path, dotOnly: false, files: false, counts: false, volume: false, network: false, ...o })
const snap = (roots: I.Roots, exclude?: string[]) => I.takeManifest(roots, { runId: rid(), by: 'test', home: 'unused', exclude })
function diffOf(roots: I.Roots, change: () => void, exclude?: string[]) {
  const before = snap(roots, exclude)
  change()
  return I.compareManifests(before, snap(roots, exclude))
}
const kinds = (d: { changes: I.Change[] }) => d.changes.map(c => `${c.path}:${c.kind}`)

/** A fake machine: a home with a state folder, a guard folder, a models folder and a mission folder. */
function world() {
  const base = tmp('w')
  const home = join(base, 'home')
  const guard = join(base, 'guard')
  const models = join(base, 'models')
  const mission = join(base, 'mission')
  for (const d of [home, guard, mission]) mkdirSync(d)
  put(join(models, 'm', 'a.gguf'), 'aaaa')
  put(join(models, 'embed.gguf'), 'eeee')
  const state = join(home, '.cynco')
  put(join(state, 'profiles', 'p.yaml'), 'p')
  put(join(state, 'heldout', 'g', 'gate.py'), 'g')
  put(join(state, 'authoring', 'a1', 'brief.md'), 'b')
  put(join(home, '.config', 'a'), 'a')
  put(join(home, '.config', 'b'), 'b')
  put(join(home, '.dotfile'), 'd')
  const roots = I.protectedRoots({ home, cynco: state, models, volumes: [] })
  return { base, home, guard, models, mission, state, roots }
}
type World = ReturnType<typeof world>

function baseline(w: World, runId = rid(), extra: Partial<Parameters<typeof I.takeBaseline>[0]> = {}) {
  I.takeBaseline({ runId, cwd: w.mission, by: 'test', guard: w.guard, home: w.home, roots: w.roots, checkModels: false, ...extra })
  return runId
}
const before = (w: World, id: string) => join(w.guard, 'manifests', `${id}.before.json`)
const checkLines = (w: World) => readFileSync(join(w.guard, 'checks.jsonl'), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const latchOf = (guard: string) => JSON.parse(readFileSync(join(guard, I.LATCH_FILE), 'utf-8')) as I.Latch

describe('this file', () => {
  it('derives no path from the real home folder', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf-8')
    expect(src.includes('home' + 'dir(')).toBe(false)
  })
})

describe('FROZEN: what changed means', () => {
  const fresh = () => {
    const f = tmp('frozen')
    put(join(f, 'a.txt'), 'aa')
    put(join(f, 'sub', 'b.txt'), 'b')
    return { f, roots: { frozen: [{ path: f, mutable: [] }], presence: [] } as I.Roots }
  }

  it('(1) an unchanged tree is clean; added, removed, grown, touched, replaced and an added empty folder each trip', () => {
    let t = fresh()
    expect(diffOf(t.roots, () => {}).changed).toBe(false)
    t = fresh(); expect(kinds(diffOf(t.roots, () => put(join(t.f, 'new.txt'))))).toEqual(['new.txt:added'])
    t = fresh(); expect(kinds(diffOf(t.roots, () => unlinkSync(join(t.f, 'a.txt'))))).toEqual(['a.txt:removed'])
    t = fresh()
    const grown = diffOf(t.roots, () => writeFileSync(join(t.f, 'a.txt'), 'aaaa'))
    expect(kinds(grown)).toEqual(['a.txt:modified'])
    expect(grown.changes[0]!.detail).toBe('size 2 -> 4')
    t = fresh()
    const touched = diffOf(t.roots, () => utimesSync(join(t.f, 'a.txt'), new Date('2001-01-01'), new Date('2001-01-01')))
    expect(touched.changes[0]).toMatchObject({ path: 'a.txt', kind: 'modified', detail: 'time' })
    t = fresh()
    const replaced = diffOf(t.roots, () => { rmSync(join(t.f, 'sub'), { recursive: true }); put(join(t.f, 'sub'), 'now a file') })
    expect(kinds(replaced)).toContain('sub:kind-changed')
    t = fresh(); expect(kinds(diffOf(t.roots, () => mkdirSync(join(t.f, 'empty'))))).toEqual(['empty:added'])
  })

  it('(2) __pycache__, .git and transient names do not trip; a mutable name trips only when removed', () => {
    let t = fresh()
    put(join(t.f, '.git', 'HEAD'), 'ref')
    const d = diffOf(t.roots, () => {
      put(join(t.f, '__pycache__', 'gate.cpython-312.pyc'), 'bytecode')
      put(join(t.f, '.git', 'index'), 'index')
      writeFileSync(join(t.f, '.git', 'HEAD'), 'another ref')
      put(join(t.f, 'x.tmp'))
      put(join(t.f, 'y.lock'))
    })
    expect(d.changed).toBe(false)
    t = fresh()
    put(join(t.f, 'known_hosts'), 'host-a')
    const roots: I.Roots = { frozen: [{ path: t.f, mutable: ['known_hosts'] }], presence: [] }
    expect(diffOf(roots, () => { writeFileSync(join(t.f, 'known_hosts'), 'host-a host-b'); utimesSync(join(t.f, 'known_hosts'), new Date('2002-01-01'), new Date('2002-01-01')) }).changed).toBe(false)
    expect(kinds(diffOf(roots, () => unlinkSync(join(t.f, 'known_hosts'))))).toEqual(['known_hosts:removed'])
  })

  it('(3) a root absent then present is root-appeared; present then absent is root-gone', () => {
    const base = tmp('roots')
    const f = join(base, 'later')
    const roots: I.Roots = { frozen: [{ path: f, mutable: [] }], presence: [] }
    expect(kinds(diffOf(roots, () => put(join(f, 'a'))))).toEqual([':root-appeared'])
    expect(kinds(diffOf(roots, () => rmSync(f, { recursive: true })))).toEqual([':root-gone'])
  })

  it('(4) a directory junction is recorded as a link and not followed; retargeting it trips (no privilege needed)', () => {
    const t = fresh()
    const other = join(t.f, 'sub2')
    put(join(other, 'c.txt'))
    symlinkSync(join(t.f, 'sub'), join(t.f, 'jn'), 'junction')
    const m = snap(t.roots)
    const entry = m.frozen[0]!.entries.find(e => e[0] === 'jn')!
    expect(entry[1]).toBe('l')
    expect(resolve(entry[4]!)).toBe(resolve(t.f, 'sub'))
    expect(m.frozen[0]!.entries.some(e => e[0].startsWith('jn/'))).toBe(false)
    const d = diffOf(t.roots, () => { unlinkSync(join(t.f, 'jn')); symlinkSync(other, join(t.f, 'jn'), 'junction') })
    expect(d.changes[0]).toMatchObject({ path: 'jn', kind: 'modified', detail: 'link target' })
  })

  it.skipIf(!canSymlinkFiles())('(4b) a file link is recorded as a link and not followed; retargeting it trips', () => {
    const t = fresh()
    symlinkSync(join(t.f, 'a.txt'), join(t.f, 'link'))
    const m = snap(t.roots)
    const entry = m.frozen[0]!.entries.find(e => e[0] === 'link')!
    expect(entry[1]).toBe('l')
    expect(entry[4]).toBe(join(t.f, 'a.txt'))
    const d = diffOf(t.roots, () => { unlinkSync(join(t.f, 'link')); symlinkSync(join(t.f, 'sub', 'b.txt'), join(t.f, 'link')) })
    expect(d.changes[0]).toMatchObject({ path: 'link', kind: 'modified', detail: 'link target' })
  })
})

describe('PRESENCE: loss only', () => {
  const homeLike = () => {
    const h = tmp('presence')
    put(join(h, '.a', 'x')); put(join(h, '.a', 'y'))
    put(join(h, '.b', 'z'))
    put(join(h, '.f'))
    put(join(h, 'visible', 'v'))
    return { h, roots: { frozen: [], presence: [P(h, { dotOnly: true, files: true, counts: true })] } as I.Roots }
  }

  it('(5) a dot-folder or dot-file removed trips; a non-dot entry removed or a new dot-folder does not', () => {
    let t = homeLike(); expect(kinds(diffOf(t.roots, () => rmSync(join(t.h, '.b'), { recursive: true })))).toEqual(['.b:gone'])
    t = homeLike(); expect(kinds(diffOf(t.roots, () => unlinkSync(join(t.h, '.f'))))).toEqual(['.f:gone'])
    t = homeLike(); expect(diffOf(t.roots, () => rmSync(join(t.h, 'visible'), { recursive: true })).changed).toBe(false)
    t = homeLike(); expect(diffOf(t.roots, () => put(join(t.h, '.new', 'n'))).changed).toBe(false)
  })

  it('(6) a transient name is not recorded, not counted, and its going does not trip', () => {
    const t = homeLike()
    put(join(t.h, '.x.lock'))
    put(join(t.h, '.a', 'z.tmp'))
    const m = snap(t.roots)
    expect(m.presence[0]!.entries['.x.lock']).toBeUndefined()
    expect(m.presence[0]!.entries['.a']!.n).toBe(2)
    const d = diffOf(t.roots, () => { unlinkSync(join(t.h, '.x.lock')); unlinkSync(join(t.h, '.a', 'z.tmp')) })
    expect(d.changed).toBe(false)
  })

  it('(7) a folder empty at the baseline and removed after does not trip', () => {
    const t = homeLike()
    mkdirSync(join(t.h, '.empty'))
    expect(diffOf(t.roots, () => rmSync(join(t.h, '.empty'), { recursive: true })).changed).toBe(false)
  })

  it('(8) counts: fewer than half and by at least two', () => {
    const counted = (n: number, after: number) => {
      const h = tmp('counts')
      for (let i = 0; i < n; i++) put(join(h, '.c', `f${i}`))
      const roots: I.Roots = { frozen: [], presence: [P(h, { dotOnly: true, counts: true })] }
      return diffOf(roots, () => {
        for (let i = after; i < n; i++) unlinkSync(join(h, '.c', `f${i}`))
        for (let i = n; i < after; i++) put(join(h, '.c', `f${i}`))
      })
    }
    expect(counted(34, 16).changes[0]).toMatchObject({ path: '.c', kind: 'emptied', detail: '34 -> 16' })
    expect(counted(34, 17).changed).toBe(false)
    expect(counted(3, 1).changed).toBe(true)
    expect(counted(2, 0).changed).toBe(true)
    expect(counted(1, 0).changed).toBe(false)
    expect(counted(3, 9).changed).toBe(false)
  })

  it('(9) counts and files off: a folder emptied does not trip, removed does; a file removed does not', () => {
    const fresh = () => {
      const h = tmp('nocounts')
      put(join(h, 'sd', 'a')); put(join(h, 'sd', 'b')); put(join(h, 'sd', 'c'))
      put(join(h, 'top.txt'))
      return { h, roots: { frozen: [], presence: [P(h)] } as I.Roots }
    }
    let t = fresh(); expect(diffOf(t.roots, () => { for (const n of ['a', 'b', 'c']) unlinkSync(join(t.h, 'sd', n)) }).changed).toBe(false)
    t = fresh(); expect(kinds(diffOf(t.roots, () => rmSync(join(t.h, 'sd'), { recursive: true })))).toEqual(['sd:gone'])
    t = fresh(); expect(diffOf(t.roots, () => unlinkSync(join(t.h, 'top.txt'))).changed).toBe(false)
  })

  it('(10) a volume root: an entry removed trips; system entries are not recorded; unlistable at the compare is a note', () => {
    const base = tmp('volume')
    const v = join(base, 'vol')
    put(join(v, 'photos', 'p.jpg'))
    put(join(v, 'readme.txt'))
    mkdirSync(join(v, 'System Volume Information'))
    mkdirSync(join(v, '$RECYCLE.BIN'))
    const roots: I.Roots = { frozen: [], presence: [P(v, { files: true, volume: true })] }
    const m = snap(roots)
    expect(Object.keys(m.presence[0]!.entries).sort()).toEqual(['photos', 'readme.txt'])
    expect(kinds(diffOf(roots, () => unlinkSync(join(v, 'readme.txt'))))).toEqual(['readme.txt:gone'])
    const b = snap(roots)
    renameSync(v, join(base, 'detached'))
    const d = I.compareManifests(b, snap(roots))
    expect(d.changed).toBe(false)
    expect(d.notes.join('\n')).toContain('could not be listed')
  })
})

describe('protectedRoots', () => {
  it('(11) holds the default-home state folders AND the redirected ones (4.M6); each once; volumes become volume roots', () => {
    const base = tmp('roots')
    const home = join(base, 'home')
    const other = join(base, 'other-state')
    const models = join(base, 'models')
    const r = I.protectedRoots({ home, cynco: other, models, volumes: [{ root: join(base, 'D'), kind: 'removable' }, { root: join(base, 'N'), kind: 'network' }] })
    const frozen = r.frozen.map(f => f.path)
    for (const p of [join(home, '.cynco', 'profiles'), join(home, '.cynco', 'heldout'), join(other, 'profiles'), join(other, 'heldout'), models, join(home, '.ssh')]) {
      expect(frozen).toContain(resolve(p))
    }
    // Review of wave 5: the local model store is loss-only and counted (a pull outside any run must not latch).
    expect(frozen).not.toContain(resolve(home, '.ollama', 'models'))
    expect(r.presence.find(p => p.path === resolve(home, '.ollama', 'models'))).toMatchObject({ counts: true, files: false, volume: false })
    expect(r.frozen.find(f => f.path === resolve(home, '.ssh'))!.mutable).toEqual(['known_hosts', 'known_hosts.old'])
    expect(r.presence.find(p => p.path === resolve(home))).toMatchObject({ dotOnly: true, files: true, counts: true })
    // The desk tools' folder: the one dot-folder of the home watched by sub-folder name alone.
    const desk = r.presence.filter(p => dirname(p.path) === resolve(home) && p.path !== resolve(home, '.cynco'))
    expect(desk).toHaveLength(1)
    expect(desk[0]).toMatchObject({ dotOnly: false, files: false, counts: false, volume: false })
    expect(r.presence.find(p => p.path === resolve(other, 'authoring'))).toMatchObject({ counts: true })
    expect(r.presence.find(p => p.path === resolve(base, 'D'))).toMatchObject({ volume: true, network: false, files: true, counts: true })
    expect(r.presence.find(p => p.path === resolve(base, 'N'))).toMatchObject({ volume: true, network: true })
    const same = I.protectedRoots({ home, cynco: join(home, '.cynco'), models, volumes: [] })
    const paths = [...same.frozen.map(f => f.path), ...same.presence.map(p => p.path)]
    expect(paths.filter(p => p === resolve(home, '.cynco', 'profiles'))).toHaveLength(1)
    expect(paths.filter(p => p === resolve(home, '.cynco', 'authoring'))).toHaveLength(1)
  })
})

describe('exclusion', () => {
  it('(12) the mission folder inside a PRESENCE root may vanish; a sibling may not', () => {
    const h = tmp('authoring')
    put(join(h, 'a1', 'x')); put(join(h, 'a1', 'y'))
    put(join(h, 'a2', 'z'))
    const roots: I.Roots = { frozen: [], presence: [P(h, { counts: true })] }
    const ex = [join(h, 'a1')]
    expect(diffOf(roots, () => rmSync(join(h, 'a1'), { recursive: true }), ex).changed).toBe(false)
    expect(kinds(diffOf(roots, () => rmSync(join(h, 'a2'), { recursive: true }), ex))).toEqual(['a2:gone'])
  })

  it('(13) a mission folder that is the home, holds a frozen folder, or sits inside one is refused', () => {
    const w = world()
    const refuse = (cwd: string) => { try { baseline(w, rid(), { cwd }); return null } catch (e) { expect(e).toBeInstanceOf(I.ManifestError); return (e as Error).message } }
    expect(refuse(w.home)).toMatch(/^the mission folder .* contains the protected folder /)
    expect(refuse(w.state)).toMatch(/^the mission folder .* contains the protected folder .*profiles/)
    expect(refuse(join(w.state, 'heldout', 'g'))).toMatch(/^the mission folder .* is inside the frozen folder .*heldout$/)
    expect(readdirSync(join(w.guard)).includes('manifests')).toBe(false)
  })
})

describe('takeBaseline', () => {
  it('(14) writes the baseline once per run id, refuses a bad id, never creates the guard folder', () => {
    const w = world()
    const id = baseline(w)
    expect(existsSync(before(w, id))).toBe(true)
    expect(() => baseline(w, id)).toThrow(`a baseline for run ${id} already exists; a run id is used once`)
    expect(() => baseline(w, 'not a run id')).toThrow('not a run id is not a run id')
    const missing = join(w.base, 'no-guard')
    expect(() => baseline(w, rid(), { guard: missing })).toThrow(/does not exist/)
    expect(existsSync(missing)).toBe(false)
  })

  it('(15) refuses on the guard folder, the latch and each models-record sentence', () => {
    const w = world()
    const why = (extra: Partial<Parameters<typeof I.takeBaseline>[0]>) => {
      try { baseline(w, rid(), extra); return 'taken' } catch (e) { return (e as I.ManifestError).message }
    }
    expect(why({ guard: join(w.base, 'nope') })).toMatch(/^the guard folder .* does not exist; scripts\\cynco-containment-setup\.ps1 creates it/)
    put(join(w.base, 'guard-file'))
    expect(why({ guard: join(w.base, 'guard-file') })).toMatch(/is not a folder$/)
    mkdirSync(join(w.home, 'g'))
    expect(why({ guard: join(w.home, 'g') })).toMatch(/resolves inside the home folder/)
    expect(why({ sandboxRoot: w.base })).toMatch(/resolves inside the sandbox root/)
    expect(why({ cwd: w.base })).toMatch(/resolves inside the mission folder/)
    writeFileSync(join(w.guard, I.LATCH_FILE), '')
    expect(why({})).toMatch(/^the integrity latch is present at /)
    unlinkSync(join(w.guard, I.LATCH_FILE))

    const saved = process.env.LOCALCODE_MODELS_DIR
    try {
      process.env.LOCALCODE_MODELS_DIR = join(w.base, 'no-models')
      expect(why({ checkModels: true })).toMatch(/^the models folder .* does not exist/)
      process.env.LOCALCODE_MODELS_DIR = w.models
      expect(why({ checkModels: true })).toMatch(/^there is no models hash record at .*hash-models$/)
      writeFileSync(join(w.guard, 'models-hashes.json'), '{ not json')
      expect(why({ checkModels: true })).toMatch(/^the models hash record .* cannot be read/)
      writeFileSync(join(w.guard, 'models-hashes.json'), JSON.stringify({ schema: 1, taken: 'x', root: join(w.base, 'elsewhere').replace(/\\/g, '/'), files: [] }))
      expect(why({ checkModels: true })).toMatch(/^this process resolves the models folder as .* but .* was taken for /)
      writeFileSync(join(w.guard, 'models-hashes.json'), JSON.stringify({ schema: 1, taken: 'x', root: w.models.replace(/\\/g, '/'), files: [] }))
      expect(why({ checkModels: true })).toMatch(/^the models folder differs from its hash record: 2 file\(s\) \(first: embed\.gguf added\)/)
    } finally {
      if (saved === undefined) delete process.env.LOCALCODE_MODELS_DIR
      else process.env.LOCALCODE_MODELS_DIR = saved
    }
    expect(existsSync(join(w.guard, 'manifests'))).toBe(false)
  })
})

describe('the early reading and the settling compare (entry 4.B1)', () => {
  const opts = (w: World, page: I.Pager, extra: object = {}) => ({ by: 'test', page, guard: w.guard, sleep: noSleep, ...extra })

  it('(16) a reading writes one line, leaves the baseline open, and latches on a change', async () => {
    const w = world()
    const id = baseline(w)
    const pg = pager()
    const c1 = await I.compareRun(id, opts(w, pg.fn))
    expect(c1).toMatchObject({ kind: 'reading', settled: false, from: 'live', changed: false, latchPath: null })
    expect(checkLines(w)).toHaveLength(1)
    expect(checkLines(w)[0]).toMatchObject({ run: id, kind: 'reading', changed: false })
    expect(existsSync(before(w, id))).toBe(true)
    expect(pg.calls).toHaveLength(0)
    expect((await I.compareRun(id, opts(w, pg.fn))).from).toBe('live')
    expect(checkLines(w)).toHaveLength(2)

    put(join(w.state, 'profiles', 'new.yaml'))
    const c3 = await I.compareRun(id, opts(w, pg.fn))
    expect(c3.changed).toBe(true)
    expect(c3.latchPath).toBe(join(w.guard, I.LATCH_FILE))
    expect(existsSync(c3.latchPath!)).toBe(true)
    expect(pg.calls).toHaveLength(1)
    expect(existsSync(before(w, id))).toBe(true)

    const w2 = world()
    const c4 = await I.compareRun(rid(), opts(w2, pager().fn))
    expect(c4.changed).toBe(true)
    expect(c4.error).toMatch(/there is no baseline and no recorded compare/)
    expect(latchOf(w2.guard).reason).toBe('manifest-error')
  })

  it('(17) a clean settle closes the baseline once; later calls read the record and page nobody', async () => {
    const w = world()
    const id = baseline(w)
    const pg = pager()
    const s = await I.settleRun(id, opts(w, pg.fn))
    expect(s).toMatchObject({ kind: 'settle', settled: true, from: 'live', changed: false })
    expect(existsSync(before(w, id))).toBe(false)
    expect(existsSync(join(w.guard, 'manifests', 'last-clean.json'))).toBe(true)
    expect(checkLines(w).filter(l => l.kind === 'settle')).toHaveLength(1)
    expect((await I.compareRun(id, opts(w, pg.fn))).from).toBe('recorded')
    expect((await I.settleRun(id, opts(w, pg.fn))).from).toBe('recorded')
    expect(pg.calls).toHaveLength(0)
    expect(existsSync(join(w.guard, I.LATCH_FILE))).toBe(false)
  })

  it('(18) a change made after a clean reading is caught by the settle', async () => {
    const w = world()
    const id = baseline(w)
    const pg = pager()
    expect((await I.compareRun(id, opts(w, pg.fn))).changed).toBe(false)
    put(join(w.state, 'heldout', 'g', 'planted.py'))
    const s = await I.settleRun(id, opts(w, pg.fn))
    expect(s.changed).toBe(true)
    expect(s.summary).toMatch(/^1 change\(s\) in protected folders; first: FROZEN .*heldout\/g\/planted\.py added\. If you changed it yourself while a run was open/)
    expect(s.publicSummary).toBe('1 change(s) in protected folders (first: FROZEN)')
    expect(existsSync(join(w.guard, I.LATCH_FILE))).toBe(true)
    expect(pg.calls).toHaveLength(1)
    expect(pg.calls[0]!.priority).toBe(5)
  })

  it('(19) a change moves the baseline and the after-manifest into tripped/', async () => {
    const w = world()
    const id = baseline(w)
    rmSync(join(w.home, '.config'), { recursive: true })
    const s = await I.settleRun(id, opts(w, pager().fn))
    expect(s.changes[0]).toMatchObject({ class: 'PRESENCE', path: '.config', kind: 'gone' })
    expect(existsSync(join(w.guard, 'manifests', 'tripped', `${id}.before.json`))).toBe(true)
    expect(existsSync(join(w.guard, 'manifests', 'tripped', `${id}.after.json`))).toBe(true)
    expect(existsSync(before(w, id))).toBe(false)
    expect(latchOf(w.guard).baseline).toBe(join(w.guard, 'manifests', 'tripped', `${id}.before.json`))
  })

  it('(20) only a change present on both walks counts', async () => {
    const w = world()
    const id = baseline(w)
    const file = join(w.state, 'profiles', 'p.yaml')
    unlinkSync(file)
    let slept = 0
    const back = () => { slept++; put(file, 'p') }
    const s = await I.settleRun(id, opts(w, pager().fn, { sleep: back }))
    expect(slept).toBe(1)
    expect(s.changed).toBe(false)

    const w2 = world()
    const id2 = baseline(w2)
    unlinkSync(join(w2.state, 'profiles', 'p.yaml'))
    const s2 = await I.settleRun(id2, opts(w2, pager().fn))
    expect(kinds(s2)).toEqual(['p.yaml:removed'])
  })

  it('(20b) a path that differs on both walks counts even when its kind of change differs between them', async () => {
    // FROZEN: removed on the first walk, a folder of that name on the second (kind-changed).
    const w = world()
    const id = baseline(w)
    const gate = join(w.state, 'heldout', 'g', 'gate.py')
    unlinkSync(gate)
    const s = await I.settleRun(id, opts(w, pager().fn, { sleep: () => mkdirSync(gate) }))
    expect(s.changed).toBe(true)
    expect(kinds(s)).toEqual(['g/gate.py:kind-changed'])

    // PRESENCE: gone on the first walk, back empty on the second (emptied, 2 -> 0).
    const w2 = world()
    const id2 = baseline(w2)
    rmSync(join(w2.home, '.config'), { recursive: true })
    const s2 = await I.settleRun(id2, opts(w2, pager().fn, { sleep: () => mkdirSync(join(w2.home, '.config')) }))
    expect(s2.changes.map(c => `${c.path}:${c.kind}:${c.detail}`)).toEqual(['.config:emptied:2 -> 0'])
  })

  it('(21) no baseline and no record latches manifest-error; not-confirmed-dead latches on a clean tree and keeps the baseline', async () => {
    const w = world()
    const s = await I.settleRun(rid(), opts(w, pager().fn))
    expect(s.changed).toBe(true)
    expect(latchOf(w.guard).reason).toBe('manifest-error')

    const w2 = world()
    const id = baseline(w2)
    const d = await I.settleRun(id, opts(w2, pager().fn, { notConfirmedDead: 'pid 4242 still listed' }))
    expect(d.notConfirmedDead).toBe('pid 4242 still listed')
    expect(d.summary).toBe('the engine is not confirmed dead (pid 4242 still listed)')
    expect(latchOf(w2.guard)).toMatchObject({ reason: 'engine-not-confirmed-dead', detail: 'pid 4242 still listed' })
    expect(existsSync(before(w2, id))).toBe(true)
    expect(checkLines(w2).map(l => l.kind)).toEqual(['reading'])
  })

  it('(22) a settle whose rename meets ENOENT: a clean walk returns the recorded line; a change this walk saw is returned and latches', async () => {
    const otherSettler = (w: World, id: string, changed: boolean) => () => {
      renameSync(before(w, id), join(w.base, `moved-${id}.json`))
      appendFileSync(join(w.guard, 'checks.jsonl'), JSON.stringify({ run: id, kind: 'settle', baselineTakenAt: null, at: 'earlier', by: 'the other settler', changed, changeCount: changed ? 1 : 0, publicSummary: changed ? '1 change(s) in protected folders (first: FROZEN)' : 'no change in protected folders', ms: 1 }) + '\n')
    }
    // Clean walk: the other caller's record is the answer. The sleep only runs when a walk differs,
    // so the first walk is made to differ and the confirming walk to agree with the baseline.
    const w = world()
    const id = baseline(w)
    const file = join(w.state, 'profiles', 'p.yaml')
    unlinkSync(file)
    const move = otherSettler(w, id, false)
    const s = await I.settleRun(id, opts(w, pager().fn, { sleep: () => { put(file, 'p'); move() } }))
    expect(s).toMatchObject({ from: 'recorded', by: 'the other settler', settled: true, changed: false })

    // A change on both walks, while the other caller recorded clean: before the fix this returned
    // the clean record, and `cynco-guard post` printed "integrity unchanged" with HALT.json on disk.
    const w2 = world()
    const id2 = baseline(w2)
    put(join(w2.state, 'profiles', 'new.yaml'))
    const pg = pager()
    const s2 = await I.settleRun(id2, opts(w2, pg.fn, { sleep: otherSettler(w2, id2, false) }))
    expect(s2).toMatchObject({ from: 'live', changed: true, settled: true, latchPath: join(w2.guard, I.LATCH_FILE) })
    expect(s2.notes).toContain('another caller closed the baseline first; this walk found a change')
    expect(existsSync(join(w2.guard, I.LATCH_FILE))).toBe(true)
    expect(pg.calls).toHaveLength(1)
  })

  it('(22b) a close that fails with anything but ENOENT leaves the baseline open and says settled: false', async () => {
    const w = world()
    const id = baseline(w)
    mkdirSync(join(w.guard, 'manifests', 'last-clean.json', 'in-the-way'), { recursive: true })
    const s = await I.settleRun(id, opts(w, pager().fn))
    expect(s).toMatchObject({ changed: false, settled: false })
    expect(s.notes.some(n => n.startsWith('the baseline could not be closed ('))).toBe(true)
    expect(existsSync(before(w, id))).toBe(true)
  })
})

describe('the integrity latch', () => {
  const cmp = (run: string): I.Compare => ({
    run, at: 'now', by: 'test', kind: 'settle', settled: true, from: 'live', changed: true,
    changes: [{ class: 'FROZEN', root: 'C:/secret-root', path: 'x', kind: 'added' }], changeCount: 1,
    summary: '1 change(s) in protected folders; first: FROZEN C:/secret-root/x added',
    publicSummary: '1 change(s) in protected folders (first: FROZEN)',
    firstClass: 'FROZEN', firstRoot: 'C:/secret-root', entries: 3, ms: 1, notes: [], latchPath: null,
  })

  it('(23) haltState: clear, latched (public summary only), unreadable latch, and each unusable folder', async () => {
    const w = world()
    expect(I.haltState(w.guard, w.home)).toEqual({ state: 'clear' })
    await I.tripHalt({ by: 'test', run: rid(), reason: 'integrity-change', page: pager().fn, compare: cmp('r'), guard: w.guard })
    const s = I.haltState(w.guard, w.home)
    expect(s.state).toBe('latched')
    const sentence = I.haltRefusal(w.guard, w.home)!
    expect(sentence).toMatch(/^the integrity latch is present at .*HALT\.json \(1 change\(s\) in protected folders \(first: FROZEN\), set .* by test\); only the owner clears it, at a terminal, with: bun scripts\/cynco-guard\.mjs clear$/)
    expect(sentence).not.toContain('secret-root')
    writeFileSync(join(w.guard, I.LATCH_FILE), '')
    expect(I.haltRefusal(w.guard, w.home)).toContain('(latch unreadable)')

    const b = tmp('unusable')
    expect(I.haltRefusal('relative/guard', b)).toBe('the guard folder relative/guard is not an absolute path on this system; set LOCALCODE_GUARD_DIR to a folder outside the home folder')
    expect(I.haltRefusal(join(b, 'missing'), b)).toBe(`the guard folder ${join(b, 'missing')} does not exist; scripts\\cynco-containment-setup.ps1 creates it, a run never does`)
    const saved = process.env.LOCALCODE_GUARD_DIR
    try {
      process.env.LOCALCODE_GUARD_DIR = join(b, 'from-env')
      expect(I.haltRefusal(undefined, b)).toBe(`the guard folder ${join(b, 'from-env')} does not exist (LOCALCODE_GUARD_DIR is set to ${join(b, 'from-env')}); scripts\\cynco-containment-setup.ps1 creates it, a run never does`)
    } finally {
      if (saved === undefined) delete process.env.LOCALCODE_GUARD_DIR
      else process.env.LOCALCODE_GUARD_DIR = saved
    }
    put(join(b, 'file'))
    expect(I.haltRefusal(join(b, 'file'), b)).toBe(`the guard folder ${join(b, 'file')} is not a folder`)
    mkdirSync(join(b, 'h', 'g'), { recursive: true })
    expect(I.haltRefusal(join(b, 'h', 'g'), join(b, 'h'))).toBe(`the guard folder ${join(b, 'h', 'g')} resolves inside the home folder ${join(b, 'h')}`)
    mkdirSync(join(b, 's', 'g'), { recursive: true })
    expect(I.haltRefusal(join(b, 's', 'g'), join(b, 'h'), { sandboxRoot: join(b, 's') })).toBe(`the guard folder ${join(b, 's', 'g')} resolves inside the sandbox root ${join(b, 's')}`)
    mkdirSync(join(b, 'm', 'g'), { recursive: true })
    expect(I.haltRefusal(join(b, 'm', 'g'), join(b, 'h'), { missionCwd: join(b, 'm') })).toBe(`the guard folder ${join(b, 'm', 'g')} resolves inside the mission folder ${join(b, 'm')}`)
  })

  it('(24) the latch is on disk when the pager runs and when the call returns; the first writer wins; one page per run', async () => {
    const w = world()
    const latch = join(w.guard, I.LATCH_FILE)
    let seen: boolean | null = null
    const runA = rid('a')
    const pending = I.tripHalt({ by: 'test', run: runA, reason: 'presence-lost', compare: cmp(runA), guard: w.guard, page: async () => { seen = existsSync(latch); return true } })
    expect(existsSync(latch)).toBe(true)
    const r1 = await pending
    expect(seen).toBe(true)
    expect(r1).toMatchObject({ latched: true, alreadyLatched: false, paged: true, latchPath: latch })
    const first = readFileSync(latch, 'utf-8')

    // The same run again: no new page; an unsent page is flushed instead.
    mkdirSync(join(w.guard, 'unsent'))
    writeFileSync(join(w.guard, 'unsent', '20200101T000000-1.json'), JSON.stringify({ title: 't', message: 'kept', priority: 5, at: '2020-01-01T00:00:00.000Z' }))
    const same = pager()
    const r2 = await I.tripHalt({ by: 'test', run: runA, reason: 'integrity-change', guard: w.guard, page: same.fn })
    expect(r2.alreadyLatched).toBe(true)
    expect(same.calls.map(c => c.message)).toEqual(['(late) kept'])
    expect(readFileSync(latch, 'utf-8')).toBe(first)

    const another = pager()
    const runB = rid('b')
    await I.tripHalt({ by: 'test', run: runB, reason: 'integrity-change', guard: w.guard, page: another.fn })
    expect(another.calls).toHaveLength(1)
    expect(another.calls[0]!.message).toContain(runB)
    expect(another.calls[0]).toMatchObject({ title: 'CynCo integrity latch', priority: 5 })
    expect(readFileSync(latch, 'utf-8')).toBe(first)
    expect(readFileSync(join(w.guard, 'halt-log.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(3)
  })

  it('(25) a page that returns false or throws is kept in unsent/; the latch stays; tripHalt never throws', async () => {
    for (const mode of [false, 'throw'] as const) {
      const w = world()
      const r = await I.tripHalt({ by: 'test', run: rid(), reason: 'integrity-change', guard: w.guard, page: pager(mode).fn })
      expect(r).toMatchObject({ latched: true, paged: false })
      expect(readdirSync(join(w.guard, 'unsent'))).toHaveLength(1)
      expect(existsSync(join(w.guard, I.LATCH_FILE))).toBe(true)
    }
    const b = tmp('fileguard')
    put(join(b, 'guard'))
    const r = await I.tripHalt({ by: 'test', run: rid(), reason: 'manifest-error', guard: join(b, 'guard'), page: pager(false).fn })
    expect(r.latched).toBe(false)
  })

  it('(26) a delivered page flushes an older unsent one, marked late, into sent/', async () => {
    const w = world()
    await I.tripHalt({ by: 'test', run: rid('a'), reason: 'integrity-change', guard: w.guard, page: pager(false).fn })
    unlinkSync(join(w.guard, I.LATCH_FILE))
    const pg = pager()
    await I.tripHalt({ by: 'test', run: rid('b'), reason: 'integrity-change', guard: w.guard, page: pg.fn })
    expect(pg.calls).toHaveLength(2)
    expect(pg.calls[1]!.message.startsWith('(late) ')).toBe(true)
    expect(readdirSync(join(w.guard, 'unsent'))).toHaveLength(0)
    expect(readdirSync(join(w.guard, 'sent'))).toHaveLength(1)
  })

  it('(27) flushUnsentPages: oldest first, stops at the first failure, missing folders are zero and zero', async () => {
    const w = world()
    mkdirSync(join(w.guard, 'unsent'))
    writeFileSync(join(w.guard, 'unsent', 'a.json'), JSON.stringify({ title: 't', message: 'newer', priority: 5, at: '2026-01-02T00:00:00.000Z' }))
    writeFileSync(join(w.guard, 'unsent', 'b.json'), JSON.stringify({ title: 't', message: 'older', priority: 5, at: '2026-01-01T00:00:00.000Z' }))
    const calls: string[] = []
    const r = await I.flushUnsentPages(w.guard, async p => { calls.push(p.message); return calls.length === 1 })
    expect(calls).toEqual(['(late) older', '(late) newer'])
    expect(r).toEqual({ sent: 1, left: 1 })
    expect(await I.flushUnsentPages(join(w.base, 'no-guard'), pager().fn)).toEqual({ sent: 0, left: 0 })
    const w2 = world()
    expect(await I.flushUnsentPages(w2.guard, pager().fn)).toEqual({ sent: 0, left: 0 })
  })

  it('(28) clearHalt archives the latch into cleared/ and logs it; with no latch it clears nothing', async () => {
    const w = world()
    const atDesk = { terminal: { isTTY: true }, typed: 'CLEAR' }
    expect(I.clearHalt(w.guard, { by: 'test', ...atDesk })).toEqual({ cleared: false, latch: null, archivedTo: null })
    const run = rid()
    await I.tripHalt({ by: 'test', run, reason: 'integrity-change', guard: w.guard, page: pager().fn })
    const r = I.clearHalt(w.guard, { by: 'owner', now: () => new Date('2026-11-23T01:02:03Z'), ...atDesk })
    expect(r.cleared).toBe(true)
    expect(r.latch!.run).toBe(run)
    expect(r.archivedTo).toBe(join(w.guard, 'cleared', 'HALT-20261123T010203.json'))
    expect(existsSync(join(w.guard, I.LATCH_FILE))).toBe(false)
    const log = readFileSync(join(w.guard, 'halt-log.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(log[log.length - 1]).toMatchObject({ cleared: true, by: 'owner' })
    expect(I.haltRefusal(w.guard, w.home)).toBeNull()
  })
})

describe('frozenWriteRefusal (entry 4.M5)', () => {
  it('(29) null without a guard folder, without manifests, or with only last-clean; the sentence while a baseline is open', () => {
    const w = world()
    expect(I.frozenWriteRefusal(join(w.base, 'no-guard'))).toBeNull()
    expect(I.frozenWriteRefusal(w.guard)).toBeNull()
    mkdirSync(join(w.guard, 'manifests'))
    writeFileSync(join(w.guard, 'manifests', 'last-clean.json'), '{}')
    expect(I.frozenWriteRefusal(w.guard)).toBeNull()
    const id = baseline(w)
    expect(I.frozenWriteRefusal(w.guard)).toBe(`a mission or daemon task is running (${id}); this would change a protected folder and stop it. Try again when it has ended. If nothing is running, that run died before its compare: bun scripts/cynco-guard.mjs post ${id}`)
    utimesSync(before(w, id), T0, T0)
    baseline(w)
    expect(I.frozenWriteRefusal(w.guard)).toContain(`(${id}) (and 1 more);`)
  })
})

describe('checkModelsRecord: the models folder against its record', () => {
  it('(30) hashModels writes mtimeMs and no byte-order mark; an unchanged file is not read again unless all', async () => {
    const w = world()
    const seen: string[] = []
    const rec = await I.hashModels({ root: w.models, guard: w.guard, onFile: rel => seen.push(rel) })
    expect(seen.sort()).toEqual(['embed.gguf', 'm/a.gguf'])
    expect(rec.files.every(f => typeof f.mtimeMs === 'number' && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    expect(rec.root).toBe(resolve(w.models).replace(/\\/g, '/'))
    const bytes = readFileSync(join(w.guard, 'models-hashes.json'))
    expect(bytes[0]).toBe('{'.charCodeAt(0))
    seen.length = 0
    await I.hashModels({ root: w.models, guard: w.guard, onFile: rel => seen.push(rel) })
    expect(seen).toEqual([])
    await I.hashModels({ root: w.models, guard: w.guard, all: true, onFile: rel => seen.push(rel) })
    expect(seen).toHaveLength(2)
  })

  it('(31) null when it matches; each sentence otherwise; case and slashes fold for win32 only', async () => {
    const w = world()
    const check = (root: string) => I.checkModelsRecord({ root, guard: w.guard })
    expect(check(w.models)).toMatch(/^there is no models hash record at .*hash-models$/)
    await I.hashModels({ root: w.models, guard: w.guard })
    expect(check(w.models)).toBeNull()
    expect(check(w.models + (isWin ? '\\' : '/'))).toBeNull()
    const other = isWin ? w.models.replace(/\\/g, '/').toUpperCase() : w.models.toUpperCase()
    if (isWin) expect(check(other)).toBeNull()
    else expect(check(other)).not.toBeNull()
    expect(check('models')).not.toBeNull()
    expect(check(join(w.base, 'no-models'))).toMatch(/^the models folder .* does not exist/)

    const rec = I.readModelsRecord(w.guard)!
    const files = rec.files.map(({ rel, bytes, mtimeMs }) => ({ rel, bytes, mtimeMs }))
    expect(I.compareModelsRecord(rec, w.models.toUpperCase(), files, 'win32')).toBeNull()
    expect(I.compareModelsRecord(rec, w.models.toUpperCase(), files, 'linux')).not.toBeNull()

    put(join(w.models, 'new.gguf'))
    expect(check(w.models)).toMatch(/: 1 file\(s\) \(first: new\.gguf added\)/)
    unlinkSync(join(w.models, 'new.gguf'))
    writeFileSync(join(w.models, 'embed.gguf'), 'eeeeee')
    expect(check(w.models)).toMatch(/\(first: embed\.gguf size\)/)
    writeFileSync(join(w.models, 'embed.gguf'), 'eeee')
    utimesSync(join(w.models, 'embed.gguf'), T0, new Date('2003-03-03'))
    expect(check(w.models)).toMatch(/\(first: embed\.gguf time\)/)
    utimesSync(join(w.models, 'embed.gguf'), T0, T0)
    expect(check(w.models)).toBeNull()
    unlinkSync(join(w.models, 'm', 'a.gguf'))
    expect(check(w.models)).toMatch(/\(first: m\/a\.gguf removed\)/)
    writeFileSync(join(w.guard, 'models-hashes.json'), 'nope')
    expect(check(w.models)).toMatch(/^the models hash record .* cannot be read/)
  })

  it('(32) verifyModelsDeep finds a content change whose size and time were put back', async () => {
    const w = world()
    await I.hashModels({ root: w.models, guard: w.guard })
    const f = join(w.models, 'embed.gguf')
    put(f, 'EEEE')
    expect(I.checkModelsRecord({ root: w.models, guard: w.guard })).toBeNull()
    const r = await I.verifyModelsDeep({ root: w.models, guard: w.guard })
    expect(r.ok).toBe(false)
    expect(r.mismatches).toEqual([{ rel: 'embed.gguf', why: 'content differs from the recorded hash' }])
  })
})

describe('the presence tripwire (directive 17)', () => {
  function wired(extraPresence: I.PresenceRoot[] = []) {
    const w = world()
    const roots: I.Roots = { frozen: [], presence: [P(w.home, { dotOnly: true, files: true, counts: true }), ...extraPresence] }
    const id = baseline(w, rid(), { roots })
    const sb = join(w.base, 'sandbox')
    const ctx = testContainment({
      runId: id, missionCwd: w.mission, home: w.home,
      sandbox: { root: join(sb, id), home: join(sb, id, 'home'), tmp: join(sb, id, 'tmp'), scratch: join(sb, id, 'scratch') },
      folders: { state: w.state, models: w.models, guard: w.guard, audit: null },
    })
    const losses: Array<{ kind: string; summary: string; publicSummary: string }> = []
    return { w, id, ctx, losses, onLoss: (l: { kind: 'presence' | 'latch'; summary: string; publicSummary: string }) => { losses.push(l) } }
  }

  it('(33) refuses without a baseline, with an unparsable one, and while the latch is present', () => {
    const t = wired()
    const other = testContainment({ ...t.ctx, runId: rid('other'), sandbox: { ...t.ctx.sandbox }, folders: { ...t.ctx.folders }, extraRoots: [] })
    expect(I.startPresenceTripwire({ ctx: other, onLoss: t.onLoss, timer: false }))
      .toEqual({ ok: false, reason: `no integrity baseline exists for run ${other.runId}; the starter takes it before the engine starts` })
    writeFileSync(before(t.w, other.runId), '{ broken')
    const bad = I.startPresenceTripwire({ ctx: other, onLoss: t.onLoss, timer: false })
    expect(bad.ok).toBe(false)
    expect((bad as { reason: string }).reason).toMatch(new RegExp(`^the integrity baseline of run ${other.runId} cannot be read \\(`))
    writeFileSync(join(t.w.guard, I.LATCH_FILE), '')
    const latched = I.startPresenceTripwire({ ctx: t.ctx, onLoss: t.onLoss, timer: false })
    expect((latched as { reason: string }).reason).toMatch(/^the integrity latch is present at /)
  })

  it('(34) looks at most once in the gap; a removed dot-folder is a loss, reported once and sticky', () => {
    const t = wired()
    const r = I.startPresenceTripwire({ ctx: t.ctx, onLoss: t.onLoss, timer: false, now: () => 0, minGapMs: 10_000 })
    expect(r).toMatchObject({ ok: true, roots: 1 })
    expect((r as { folders: number }).folders).toBe(2)
    expect(I.presenceTripwireCheck(1_000)).toBeNull()
    rmSync(join(t.w.home, '.config'), { recursive: true })
    expect(I.presenceTripwireCheck(5_000)).toBeNull()
    expect(I.presenceTripwireCheck(12_000)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
    expect(t.losses).toHaveLength(1)
    expect(t.losses[0]!.kind).toBe('presence')
    expect(t.losses[0]!.publicSummary).toBe('1 change(s) in protected folders (first: PRESENCE)')
    expect(I.presenceTripwireCheck(12_001)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
    expect(I.presenceTripwireCheck(99_000)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
    expect(t.losses).toHaveLength(1)
  })

  it('(35) a dot-file removed does not trip the tripwire, and does trip the settle', async () => {
    const t = wired()
    I.startPresenceTripwire({ ctx: t.ctx, onLoss: t.onLoss, timer: false })
    unlinkSync(join(t.w.home, '.dotfile'))
    expect(I.presenceTripwireCheck(100_000)).toBeNull()
    const s = await I.settleRun(t.id, { by: 'test', page: pager().fn, guard: t.w.guard, sleep: noSleep })
    expect(kinds(s)).toEqual(['.dotfile:gone'])
  })

  it('(36) a latch written by another process is a loss of kind latch', () => {
    const t = wired()
    I.startPresenceTripwire({ ctx: t.ctx, onLoss: t.onLoss, timer: false })
    writeFileSync(join(t.w.guard, I.LATCH_FILE), '')
    expect(I.presenceTripwireCheck(100_000)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
    expect(t.losses.map(l => l.kind)).toEqual(['latch'])
  })

  it('(37) a mapped network drive is never listed', () => {
    const net = join(tmp('net'), 'nas')
    put(join(net, 'share', 'f'))
    const t = wired([P(net, { files: true, volume: true, network: true })])
    const r = I.startPresenceTripwire({ ctx: t.ctx, onLoss: t.onLoss, timer: false })
    expect(r).toMatchObject({ ok: true, roots: 1 })
    rmSync(join(net, 'share'), { recursive: true })
    expect(I.presenceTripwireCheck(100_000)).toBeNull()
    expect(t.losses).toEqual([])
  })

  it('(38) not started: the check is null', () => {
    expect(I.presenceTripwireCheck()).toBeNull()
  })
})

// ─── The review of 2026-11-23 (w4/integrity-findings.json): one case per finding ────────────────

const icacls = (...a: string[]) => spawnSync('icacls', a, { encoding: 'utf-8', windowsHide: true })
/** A pid no process has: `process.kill(pid, 0)` answers ESRCH. */
function deadPid(): number {
  for (let p = 4_194_000; p < 4_194_300; p++) {
    try { process.kill(p, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return p }
  }
  throw new Error('no unused pid found')
}
const driveOf = (p: string) => `${resolve(p).slice(0, 2).toUpperCase()}\\`

describe('review: a FROZEN root that is a link (finding 1, decision a)', () => {
  it('(39) a FROZEN root that is a junction refuses the baseline; a root replaced by one after the baseline latches', async () => {
    const w = world()
    const real = join(w.base, 'real-profiles')
    put(join(real, 'p.yaml'))
    rmSync(join(w.state, 'profiles'), { recursive: true })
    symlinkSync(real, join(w.state, 'profiles'), 'junction')
    let err: unknown = null
    try { baseline(w) } catch (e) { err = e }
    expect(err).toBeInstanceOf(I.ManifestError)
    expect((err as Error).message).toMatch(/^the frozen folder .*profiles is a link to .*real-profiles.*; a protected folder must be a real folder$/)

    const w2 = world()
    const id = baseline(w2)
    const moved = join(w2.base, 'moved-heldout')
    renameSync(join(w2.state, 'heldout'), moved)
    symlinkSync(moved, join(w2.state, 'heldout'), 'junction')
    const s = await I.settleRun(id, { by: 'test', page: pager().fn, guard: w2.guard, sleep: noSleep })
    expect(s.changed).toBe(true)
    expect(s.error).toMatch(/is a link to/)
    expect(latchOf(w2.guard).reason).toBe('manifest-error')
    expect(existsSync(before(w2, id))).toBe(true)
  })
})

describe('review: the top of a volume (findings 2, 15, 16; decisions b, c)', () => {
  function camera() {
    const w = world()
    const vol = join(w.base, 'vol')
    put(join(vol, 'DCIM', '100_PANA', 'a.jpg')); put(join(vol, 'DCIM', '101_PANA', 'b.jpg'))
    put(join(vol, 'recovery-x', 'f.txt'))
    mkdirSync(join(vol, 'System Volume Information'))
    const roots = I.protectedRoots({ home: w.home, cynco: w.state, models: w.models, volumes: [{ root: vol, kind: 'local' }] })
    return { w, vol, roots }
  }
  const settle = (w: World, id: string, page: I.Pager) => I.settleRun(id, { by: 'test', page, guard: w.guard, sleep: noSleep })

  it('(40) a top-level folder emptied in place is seen (DCIM 2 -> 0)', async () => {
    const c = camera()
    const id = baseline(c.w, rid(), { roots: c.roots })
    for (const d of ['100_PANA', '101_PANA']) rmSync(join(c.vol, 'DCIM', d), { recursive: true })
    const s = await settle(c.w, id, pager().fn)
    expect(s.changes.map(x => `${x.path}:${x.kind}:${x.detail}:${x.volume}`)).toEqual(['DCIM:emptied:2 -> 0:true'])
  })

  it('(41) a loss only at the top of a drive latches, pages one step below top priority, and names the drive and the folder plainly', async () => {
    const c = camera()
    const id = baseline(c.w, rid(), { roots: c.roots })
    rmSync(join(c.vol, 'recovery-x'), { recursive: true })
    const pg = pager()
    const s = await settle(c.w, id, pg.fn)
    const drive = `${resolve(c.vol)}\\`
    expect(s.summary).toBe(`1 change(s) in protected folders, all at the top of drives without integrity labels; first: drive ${drive}, top-level folder "recovery-x" gone. If you removed or emptied it yourself while a run was open, this is your own change, not an attack: look at the drive, then clear the latch`)
    expect(s.publicSummary).toBe('1 change(s) at the top of drives without integrity labels (first: PRESENCE)')
    expect(existsSync(join(c.w.guard, I.LATCH_FILE))).toBe(true)
    expect(pg.calls).toHaveLength(1)
    expect(pg.calls[0]).toMatchObject({ title: 'CynCo integrity latch', priority: 4 })
    expect(pg.calls[0]!.message).toBe(`test ${id}: ${s.summary}. Nothing unattended runs until you clear it at the desk: bun scripts/cynco-guard.mjs clear`)

    // The same loss together with a lost dot-folder of the home: top priority, the ordinary sentence.
    const c2 = camera()
    const id2 = baseline(c2.w, rid(), { roots: c2.roots })
    rmSync(join(c2.vol, 'recovery-x'), { recursive: true })
    rmSync(join(c2.w.home, '.config'), { recursive: true })
    const pg2 = pager()
    const s2 = await settle(c2.w, id2, pg2.fn)
    expect(s2.summary).toMatch(/^2 change\(s\) in protected folders; first: /)
    expect(pg2.calls[0]!.priority).toBe(5)
  })

  it('(42) the tripwire lists no volume root, network or not; the settle still sees the loss there', async () => {
    const c = camera()
    const id = baseline(c.w, rid(), { roots: c.roots })
    const sb = join(c.w.base, 'sandbox')
    const ctx = testContainment({
      runId: id, missionCwd: c.w.mission, home: c.w.home,
      sandbox: { root: join(sb, id), home: join(sb, id, 'home'), tmp: join(sb, id, 'tmp'), scratch: join(sb, id, 'scratch') },
      folders: { state: c.w.state, models: c.w.models, guard: c.w.guard, audit: null },
    })
    const losses: unknown[] = []
    const r = I.startPresenceTripwire({ ctx, onLoss: l => { losses.push(l) }, timer: false })
    expect(r.ok).toBe(true)
    expect((r as { roots: number }).roots).toBe(c.roots.presence.filter(p => !p.volume).length)
    rmSync(join(c.vol, 'DCIM'), { recursive: true })
    expect(I.presenceTripwireCheck(100_000)).toBeNull()
    expect(losses).toEqual([])
    expect(kinds(await settle(c.w, id, pager().fn))).toEqual(['DCIM:gone'])
  })

  it('(43) an empty sub-folder removed from a root without counts is not a loss; a full one is', () => {
    const fresh = () => {
      const h = tmp('desk')
      mkdirSync(join(h, 'paste-cache'))
      put(join(h, 'projects', 'p'))
      return { h, roots: { frozen: [], presence: [P(h)] } as I.Roots }
    }
    let t = fresh()
    expect(snap(t.roots).presence[0]!.entries).toEqual({ 'paste-cache': { k: 'd', n: 0 }, projects: { k: 'd', n: null } })
    expect(diffOf(t.roots, () => rmSync(join(t.h, 'paste-cache'), { recursive: true })).changed).toBe(false)
    t = fresh()
    expect(kinds(diffOf(t.roots, () => rmSync(join(t.h, 'projects'), { recursive: true })))).toEqual(['projects:gone'])
  })
})

describe('review: the guard folder (findings 6, 7, 14; decision d)', () => {
  it.skipIf(!isWin)('(44) a guard folder without a drive letter, a share, a link, or on an unprotected drive is unusable', () => {
    const w = world()
    const noDrive = w.guard.slice(2)
    expect(I.haltRefusal(noDrive, w.home)).toBe(`the guard folder ${noDrive} does not start with a drive letter; set LOCALCODE_GUARD_DIR to a folder on a local NTFS drive, such as C:/cynco-guard`)
    expect(I.haltRefusal('\\\\localhost\\share\\cynco-guard', w.home)).toMatch(/does not start with a drive letter/)
    const link = join(w.base, 'guard-link')
    symlinkSync(w.guard, link, 'junction')
    expect(I.haltRefusal(link, w.home)).toBe(`the guard folder ${link} is a link; the guard folder must be a real folder`)
    const drive = driveOf(w.guard)
    expect(I.haltRefusal(w.guard, w.home, { unprotectedVolumes: [drive] })).toBe(`the guard folder ${w.guard} is on ${drive}, which carries no integrity labels; set LOCALCODE_GUARD_DIR to a folder on a local NTFS drive, outside the home folder`)
    let err: unknown = null
    try { baseline(w, rid(), { volumes: () => [{ root: drive, kind: 'local' }] }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(I.ManifestError)
    expect((err as I.ManifestError).kind).toBe('refusal')
    expect((err as Error).message).toMatch(/carries no integrity labels/)
    expect(existsSync(join(w.guard, 'manifests'))).toBe(false)
    expect(I.haltRefusal(w.guard, w.home, { unprotectedVolumes: ['Q:\\'] })).toBeNull()
  })

  it('(45) anything named HALT.json is the latch, a dangling junction included; nothing is created through it, and clear moves the link itself', async () => {
    const w = world()
    const outside = join(w.base, 'outside-target')
    symlinkSync(outside, join(w.guard, I.LATCH_FILE), 'junction')
    const st = I.haltState(w.guard, w.home)
    expect(st.state).toBe('latched')
    expect((st as { summary: string }).summary).toContain('(latch unreadable: it is a link)')
    const pg = pager()
    const r = await I.tripHalt({ by: 'test', run: rid(), reason: 'integrity-change', guard: w.guard, page: pg.fn })
    expect(r).toMatchObject({ latched: true, alreadyLatched: true })
    expect(existsSync(outside)).toBe(false)
    expect(pg.calls).toHaveLength(1)
    const c = I.clearHalt(w.guard, { by: 'owner', terminal: { isTTY: true }, typed: 'CLEAR' })
    expect(c.cleared).toBe(true)
    expect(I.haltState(w.guard, w.home)).toEqual({ state: 'clear' })
    expect(existsSync(outside)).toBe(false)
  })

  it('(46) a sub-folder of the guard folder that is a link is never written through', async () => {
    const w = world()
    const elsewhere = join(w.base, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(w.guard, 'unsent'), 'junction')
    const r = await I.tripHalt({ by: 'test', run: rid(), reason: 'integrity-change', guard: w.guard, page: pager(false).fn })
    expect(r.latched).toBe(true)
    expect(readdirSync(elsewhere)).toEqual([])
  })
})

describe('review: the baseline pair (findings 8, 9, 13)', () => {
  it('(47) a baseline whose content is another run\'s does not settle; it latches as a compare that cannot be done', async () => {
    const w = world()
    const id1 = baseline(w)
    const id2 = rid('copy')
    writeFileSync(before(w, id2), readFileSync(before(w, id1)))
    put(join(w.state, 'profiles', 'planted.yaml'))
    const s = await I.settleRun(id2, { by: 'test', page: pager().fn, guard: w.guard, sleep: noSleep })
    expect(s.changed).toBe(true)
    expect(s.error).toBe(`the integrity baseline of run ${id2} cannot be read (it is the baseline of run ${id1})`)
    expect(latchOf(w.guard).reason).toBe('manifest-error')
  })

  it('(48) a compare that cannot be done names no path in its public summary, in the latch or in the refusal sentence', async () => {
    const w = world()
    const id = baseline(w)
    const profiles = join(w.state, 'profiles')
    rmSync(profiles, { recursive: true })
    put(profiles, 'now a file')
    const c = await I.compareRun(id, { by: 'test', page: pager().fn, guard: w.guard, sleep: noSleep })
    expect(c.changed).toBe(true)
    expect(c.publicSummary).toBe('the integrity check could not be completed')
    expect(c.summary).toContain(profiles)
    const l = latchOf(w.guard)
    expect(l.publicSummary).toBe('the integrity check could not be completed')
    expect(l.publicSummary).not.toMatch(/[\\/]/)
    expect(I.haltRefusal(w.guard, w.home)).not.toContain(profiles)
  })

  it('(49) a link whose target cannot be read is never equal at a compare', () => {
    const root = resolve(tmp('unreadable'))
    const roots: I.Roots = { frozen: [{ path: root, mutable: [] }], presence: [] }
    const m = (target: string): I.Manifest => ({
      schema: 1, runId: rid(), takenAt: '', by: 'test', home: '', exclude: [], roots, notes: [], presence: [],
      frozen: [{ root, exists: true, entries: [['jn', 'l', 0, 0, target]] }],
    })
    const d = I.compareManifests(m('(unreadable: EPERM)'), m('(unreadable: EPERM)'))
    expect(d.changes).toEqual([{ class: 'FROZEN', root, path: 'jn', kind: 'modified', detail: 'link target cannot be read' }])
    expect(I.compareManifests(m('C:/a'), m('C:/a')).changed).toBe(false)
  })

  it.skipIf(!isWin)('(50) a counted folder whose children can no longer be listed is emptied (uncountable)', () => {
    const h = tmp('acl')
    put(join(h, '.config', 'a')); put(join(h, '.config', 'b'))
    const roots: I.Roots = { frozen: [], presence: [P(h, { dotOnly: true, files: true, counts: true })] }
    const b = snap(roots)
    const user = userInfo().username
    const target = join(h, '.config')
    expect(icacls(target, '/deny', `${user}:(RD)`).status).toBe(0)
    let after: I.Manifest
    try {
      after = snap(roots)
    } finally {
      icacls(target, '/remove:d', user)
    }
    const d = I.compareManifests(b, after)
    expect(d.changes.map(c => `${c.path}:${c.kind}:${c.detail}`)).toEqual(['.config:emptied:2 -> uncountable'])
  })
})

describe('review: pages (finding 5)', () => {
  const page = (msg: string) => JSON.stringify({ title: 't', message: msg, priority: 5, at: '2026-01-01T00:00:00.000Z' })

  it('(51) two flushes at once deliver a kept page once', async () => {
    const w = world()
    mkdirSync(join(w.guard, 'unsent'))
    writeFileSync(join(w.guard, 'unsent', 'a.json'), page('m'))
    const delivered: string[] = []
    const slow: I.Pager = async p => { delivered.push(p.message); await new Promise(r => setTimeout(r, 20)); return true }
    const [r1, r2] = await Promise.all([I.flushUnsentPages(w.guard, slow), I.flushUnsentPages(w.guard, slow)])
    expect(delivered).toEqual(['(late) m'])
    expect(r1.sent + r2.sent).toBe(1)
    expect(readdirSync(join(w.guard, 'sent'))).toEqual(['a.json'])
    expect(readdirSync(join(w.guard, 'unsent'))).toEqual([])
  })

  it('(52) a page claimed by a process that died is sent again; one claimed by a live process is left to it', async () => {
    const w = world()
    mkdirSync(join(w.guard, 'sending'))
    writeFileSync(join(w.guard, 'sending', `dead.json.${deadPid()}`), page('from a dead sender'))
    writeFileSync(join(w.guard, 'sending', `live.json.${process.ppid}`), page('being sent elsewhere'))
    const pg = pager()
    expect(await I.flushUnsentPages(w.guard, pg.fn)).toEqual({ sent: 1, left: 0 })
    expect(pg.calls.map(c => c.message)).toEqual(['(late) from a dead sender'])
    expect(readdirSync(join(w.guard, 'sending'))).toEqual([`live.json.${process.ppid}`])
  })

  it('(53) a latch for the same run that is still being written is read again before a second page is sent', async () => {
    const w = world()
    const run = rid()
    const latch = join(w.guard, I.LATCH_FILE)
    writeFileSync(latch, '')
    const record = JSON.stringify({ schema: 1, at: 'a', by: 'the first tripper', run, publicSummary: 'p', summary: 's', reason: 'presence-lost', changes: [], changeCount: 0 })
    const pg = pager()
    let waited = 0
    await I.tripHalt({ by: 'test', run, reason: 'integrity-change', guard: w.guard, page: pg.fn, sleep: () => { waited++; writeFileSync(latch, record) } })
    expect(waited).toBe(1)
    expect(pg.calls).toEqual([])
    // A latch that stays empty is not "the same run": the page is new information.
    const w2 = world()
    writeFileSync(join(w2.guard, I.LATCH_FILE), '')
    const pg2 = pager()
    await I.tripHalt({ by: 'test', run: rid(), reason: 'integrity-change', guard: w2.guard, page: pg2.fn, sleep: noSleep })
    expect(pg2.calls).toHaveLength(1)
  })
})

describe('review: who clears, and the sticky tripwire (findings 11, 12, 13; decision e)', () => {
  it('(54) clearHalt refuses without an interactive terminal or the typed word, and changes nothing', async () => {
    const w = world()
    await I.tripHalt({ by: 'test', run: rid(), reason: 'integrity-change', guard: w.guard, page: pager().fn })
    expect(() => I.clearHalt(w.guard, { by: 'x', terminal: { isTTY: false }, typed: 'CLEAR' })).toThrow('the integrity latch is cleared only by a person at a terminal; nothing was changed')
    expect(() => I.clearHalt(w.guard, { by: 'x', terminal: undefined, typed: 'CLEAR' })).toThrow(/only by a person at a terminal/)
    expect(() => I.clearHalt(w.guard, { by: 'x', terminal: { isTTY: true }, typed: 'clear' })).toThrow('the integrity latch is cleared only after CLEAR is typed; nothing was changed')
    expect(existsSync(join(w.guard, I.LATCH_FILE))).toBe(true)
    expect(existsSync(join(w.guard, 'cleared'))).toBe(false)
  })

  it('(55) clearHalt and the tripwire reset are called by no other file under engine/ or scripts/', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const found: Record<string, string[]> = { 'clearHalt(': [], 'resetPresenceTripwireForTests(': [] }
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(join(dir, e.name)); continue }
        if (!/\.(ts|mjs|js|cjs)$/.test(e.name)) continue
        const file = join(dir, e.name)
        const src = readFileSync(file, 'utf-8')
        for (const k of Object.keys(found)) if (src.includes(k)) found[k]!.push(file.slice(root.length + 1).replace(/\\/g, '/'))
      }
    }
    walk(join(root, 'engine'))
    walk(join(root, 'scripts'))
    expect(found['clearHalt(']!.sort()).toEqual(['engine/integrity.ts', 'scripts/cynco-guard.mjs'])
    expect(found['resetPresenceTripwireForTests(']).toEqual(['engine/integrity.ts'])
  })

  function wiredHome() {
    const w = world()
    const roots: I.Roots = { frozen: [], presence: [P(w.home, { dotOnly: true, files: true, counts: true })] }
    const id = baseline(w, rid(), { roots })
    const sb = join(w.base, 'sandbox')
    const ctx = testContainment({
      runId: id, missionCwd: w.mission, home: w.home,
      sandbox: { root: join(sb, id), home: join(sb, id, 'home'), tmp: join(sb, id, 'tmp'), scratch: join(sb, id, 'scratch') },
      folders: { state: w.state, models: w.models, guard: w.guard, audit: null },
    })
    return { w, id, ctx }
  }

  it('(56) a loss stays for the life of the process: a second start is refused, and neither stop clears it', () => {
    const t = wiredHome()
    const losses: unknown[] = []
    const r = I.startPresenceTripwire({ ctx: t.ctx, onLoss: l => { losses.push(l) }, timer: false })
    expect(r.ok).toBe(true)
    rmSync(join(t.w.home, '.config'), { recursive: true })
    expect(I.presenceTripwireCheck(100_000)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
    ;(r as { stop: () => void }).stop()
    expect(I.presenceTripwireCheck(200_000)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
    expect(I.startPresenceTripwire({ ctx: t.ctx, onLoss: () => {}, timer: false })).toEqual({ ok: false, reason: I.INTEGRITY_LOSS_TO_MODEL })
    I.stopPresenceTripwire()
    expect(I.presenceTripwireCheck(300_000)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
    expect(losses).toHaveLength(1)
  })

  it('(57) a tripwire check that fails names no path in its public summary; a baseline without entries is refused at the start', () => {
    const t = wiredHome()
    const file = before(t.w, t.id)
    const m = JSON.parse(readFileSync(file, 'utf-8'))
    m.presence[0].entries = null
    writeFileSync(file, JSON.stringify(m))
    expect(I.startPresenceTripwire({ ctx: t.ctx, onLoss: () => {}, timer: false }))
      .toEqual({ ok: false, reason: `the integrity baseline of run ${t.id} cannot be read (not a baseline)` })
    // A malformed entry passes the start and breaks the check itself: the catch-all.
    m.presence[0].entries = { '.config': null }
    writeFileSync(file, JSON.stringify(m))
    const losses: Array<{ publicSummary: string; summary: string }> = []
    expect(I.startPresenceTripwire({ ctx: t.ctx, onLoss: l => { losses.push(l) }, timer: false }).ok).toBe(true)
    expect(I.presenceTripwireCheck(100_000)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
    expect(losses[0]!.publicSummary).toBe('the presence check could not be completed')
    expect(losses[0]!.summary).toMatch(/^the presence check could not be completed \(/)
  })

  it('(58) a tripwire whose baseline belongs to another run is refused', () => {
    const t = wiredHome()
    const other = rid('other')
    writeFileSync(before(t.w, other), readFileSync(before(t.w, t.id)))
    const ctx = testContainment({ ...t.ctx, runId: other, sandbox: { ...t.ctx.sandbox }, folders: { ...t.ctx.folders }, extraRoots: [] })
    expect(I.startPresenceTripwire({ ctx, onLoss: () => {}, timer: false }))
      .toEqual({ ok: false, reason: `the integrity baseline of run ${other} cannot be read (it is the baseline of run ${t.id})` })
  })
})

// ─── Review of wave 5 ───────────────────────────────────────────────────────────────────────────
describe('review of wave 5: a baseline nothing will settle (finding 1, blocker)', () => {
  const opts = (w: World, page: I.Pager, extra: object = {}) => ({ by: 'test', page, guard: w.guard, sleep: noSleep, ...extra })
  const DEAD = 2_000_000_000

  it('(59) a dead holder, a passed time limit and a restart each make an orphan; a live holder, this process and a fresh one do not', () => {
    const w = world()
    const mine = baseline(w, rid('mine'), { holderPid: process.pid })
    const late = baseline(w, rid('late'), { maxRunMs: 5000 })
    const fresh = baseline(w, rid('fresh'))
    const dead = baseline(w, rid('dead'), { holderPid: DEAD })
    const alive = (pid: number) => pid !== DEAD
    const now = Date.now() + 60_000
    const o = I.orphanedBaselines(w.guard, { now, alive, bootTimeMs: Date.now() - 3_600_000 })
    expect(o.map(x => x.runId).sort()).toEqual([dead, late].sort())
    expect(o.find(x => x.runId === dead)!.why).toBe(`its starter (test, pid ${DEAD}) is gone`)
    expect(o.find(x => x.runId === late)!.why).toMatch(/^its time limit passed at \d{4}-/)
    expect(o.every(x => !x.restarted)).toBe(true)
    // A restart after the baselines were taken: every one of them is an orphan whose run is dead.
    const after = I.orphanedBaselines(w.guard, { now, alive: () => true, bootTimeMs: Date.now() + 120_000 })
    expect(after.map(x => x.runId).sort()).toEqual([dead, late, fresh].sort())
    expect(after.every(x => x.restarted)).toBe(true)
    expect(mine).toBeDefined()
  })

  it('(60) takeBaseline refuses while an orphan exists, naming it and the command; the changes the dead run made are then still seen', async () => {
    const w = world()
    const dead = baseline(w, rid('dead'), { holderPid: DEAD })
    rmSync(join(w.home, '.config'), { recursive: true })
    // The probe of the review: run B's baseline used to fold run A's loss in, and nothing ever compared A.
    let refused: unknown = null
    try { baseline(w, rid('next')) } catch (e) { refused = e }
    expect(refused).toBeInstanceOf(I.ManifestError)
    expect((refused as I.ManifestError).kind).toBe('refusal')
    expect((refused as Error).message).toBe(`run ${dead} was never compared (its starter (test, pid ${DEAD}) is gone); nothing new starts until it is. The daemon compares it on its next tick; at the desk: bun scripts/cynco-guard.mjs post ${dead}`)
    // The daemon's answer: not confirmed dead, so it latches, whatever the walk finds (here a loss).
    const pg = pager()
    const settled = await I.settleOrphans({ by: 'daemon', page: pg.fn, guard: w.guard, home: w.home, alive: (p) => p !== DEAD, bootTimeMs: 0, sleep: noSleep })
    expect(settled).toHaveLength(1)
    expect(latchOf(w.guard)).toMatchObject({ run: dead, reason: 'engine-not-confirmed-dead' })
    expect(latchOf(w.guard).summary).toMatch(/PRESENCE .*\.config gone/)
    expect(pg.calls).toHaveLength(1)
    // While the latch stands the daemon does nothing more: no second page every tick.
    expect(await I.settleOrphans({ by: 'daemon', page: pg.fn, guard: w.guard, home: w.home, alive: (p) => p !== DEAD, bootTimeMs: 0, sleep: noSleep })).toEqual([])
    expect(pg.calls).toHaveLength(1)
  })

  it('(61) an orphan from before a restart is settled normally: clean closes it with no latch', async () => {
    const w = world()
    const id = baseline(w, rid('boot'), { holderPid: DEAD })
    const pg = pager()
    const c = await I.settleOrphans({ by: 'daemon', page: pg.fn, guard: w.guard, home: w.home, bootTimeMs: Date.now() + 120_000, sleep: noSleep })
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ run: id, changed: false, settled: true })
    expect(existsSync(join(w.guard, I.LATCH_FILE))).toBe(false)
    expect(pg.calls).toEqual([])
    expect(I.orphanRefusal(w.guard)).toBeNull()
  })

  it('(62) the holder and the deadline are written in the first kilobytes, where openBaselines reads them', () => {
    const w = world()
    const id = baseline(w, rid('head'), { holderPid: 4242, maxRunMs: 60_000 })
    const head = readFileSync(before(w, id), 'utf-8').slice(0, 600)
    expect(head).toMatch(/"holder":\{"pid":4242,"host":"[^"]+"\},"deadline":"\d{4}-/)
    const b = I.openBaselines(w.guard).find(x => x.runId === id)!
    expect(b.holderPid).toBe(4242)
    expect(Date.parse(b.deadline!) - Date.parse(b.takenAt)).toBe(60_000)
  })

  it('(63) settleRun with noLatch closes the baseline and reports the change, and writes no latch and no page', async () => {
    const w = world()
    const id = baseline(w)
    put(join(w.state, 'profiles', 'new.yaml'))
    const pg = pager()
    const c = await I.settleRun(id, opts(w, pg.fn, { noLatch: true }))
    expect(c).toMatchObject({ changed: true, settled: true, latchPath: null })
    expect(existsSync(join(w.guard, I.LATCH_FILE))).toBe(false)
    expect(existsSync(before(w, id))).toBe(false)
    expect(pg.calls).toEqual([])
  })
})

describe('review of wave 5: the record after a settle that could not close (finding 6)', () => {
  const opts = (w: World, page: I.Pager, extra: object = {}) => ({ by: 'test', page, guard: w.guard, sleep: noSleep, ...extra })

  it('(64) a clean compare whose close failed is logged as a reading; the later settle that found a change is the record, even after a clear', async () => {
    const w = world()
    const id = baseline(w)
    mkdirSync(join(w.guard, 'manifests', 'last-clean.json', 'in-the-way'), { recursive: true })
    const first = await I.settleRun(id, opts(w, pager().fn))
    expect(first).toMatchObject({ changed: false, settled: false, kind: 'reading' })
    expect(checkLines(w).filter(l => l.run === id).map(l => l.kind)).toEqual(['reading'])
    put(join(w.state, 'profiles', 'added.yaml'))
    const second = await I.settleRun(id, opts(w, pager().fn))
    expect(second).toMatchObject({ changed: true, settled: true })
    I.clearHalt(w.guard, { by: 'owner', terminal: { isTTY: true }, typed: 'CLEAR' })
    const rec = await I.compareRun(id, opts(w, pager().fn))
    expect(rec).toMatchObject({ from: 'recorded', changed: true })
  })

  it('(65) a clean settle line written before a change line never answers for the run', async () => {
    const w = world()
    const id = rid()
    appendFileSync(join(w.guard, 'checks.jsonl'), JSON.stringify({ run: id, kind: 'settle', baselineTakenAt: null, at: 'a', by: 'x', changed: false, changeCount: 0, publicSummary: 'no change in protected folders', ms: 1 }) + '\n')
    appendFileSync(join(w.guard, 'checks.jsonl'), JSON.stringify({ run: id, kind: 'settle', baselineTakenAt: null, at: 'b', by: 'y', changed: true, changeCount: 2, publicSummary: '2 change(s) in protected folders (first: FROZEN)', ms: 1 }) + '\n')
    const rec = await I.compareRun(id, opts(w, pager().fn))
    expect(rec).toMatchObject({ from: 'recorded', changed: true, changeCount: 2, by: 'y' })
  })
})

describe('review of wave 5: clearing withdraws the latch\'s waiting pages (finding 11)', () => {
  it('(66) the pages still in unsent/ go to cleared/pages/ and are never sent late; the log line counts them', async () => {
    const w = world()
    const run = rid()
    await I.tripHalt({ by: 'test', run, reason: 'integrity-change', guard: w.guard, page: pager(false).fn })
    await I.tripHalt({ by: 'test', run: rid('other'), reason: 'integrity-change', guard: w.guard, page: pager(false).fn })
    expect(readdirSync(join(w.guard, 'unsent'))).toHaveLength(2)
    const r = I.clearHalt(w.guard, { by: 'owner', terminal: { isTTY: true }, typed: 'CLEAR' })
    expect(r.pagesWithdrawn).toBe(2)
    expect(readdirSync(join(w.guard, 'unsent'))).toEqual([])
    expect(readdirSync(join(w.guard, 'cleared', 'pages'))).toHaveLength(2)
    const sent = pager()
    expect(await I.flushUnsentPages(w.guard, sent.fn)).toEqual({ sent: 0, left: 0 })
    expect(sent.calls).toEqual([])
    const log = readFileSync(join(w.guard, 'halt-log.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(log[log.length - 1]).toMatchObject({ cleared: true, pagesWithdrawn: 2 })
  })
})

describe('review of wave 5: the summary says when the change may be the owner\'s own (finding 13)', () => {
  it('(67) a home or frozen change tells the owner how to clear it; a change in the models folder names hash-models', () => {
    const base = tmp('own')
    const models = join(base, 'models')
    put(join(models, 'a.gguf'), 'a')
    const prev = process.env.LOCALCODE_MODELS_DIR
    process.env.LOCALCODE_MODELS_DIR = models
    try {
      const roots: I.Roots = { frozen: [{ path: models, mutable: [] }], presence: [] }
      const d = diffOf(roots, () => put(join(models, 'b.gguf'), 'b'))
      expect(d.summary).toContain("If you changed it yourself while a run was open (open runs: bun scripts/cynco-guard.mjs status), it is your own change: clear the latch, and the next run's baseline takes the folders as they are then; a change in the models folder also needs: bun scripts/cynco-guard.mjs hash-models")
      expect(d.publicSummary).toBe('1 change(s) in protected folders (first: FROZEN)')
    } finally {
      if (prev === undefined) delete process.env.LOCALCODE_MODELS_DIR
      else process.env.LOCALCODE_MODELS_DIR = prev
    }
  })
})

describe('review of wave 5: the tripwire looks again after a second (finding 8)', () => {
  it('(68) by default a removed dot-folder is seen at the first tool call a second after the last look', () => {
    expect(I.TRIPWIRE_MIN_GAP_MS).toBe(1_000)
    const w = world()
    const roots: I.Roots = { frozen: [], presence: [P(w.home, { dotOnly: true, files: true, counts: true })] }
    const id = baseline(w, rid(), { roots })
    const sb = join(w.base, 'sandbox')
    const ctx = testContainment({
      runId: id, missionCwd: w.mission, home: w.home,
      sandbox: { root: join(sb, id), home: join(sb, id, 'home'), tmp: join(sb, id, 'tmp'), scratch: join(sb, id, 'scratch') },
      folders: { state: w.state, models: w.models, guard: w.guard, audit: null },
    })
    const losses: unknown[] = []
    try {
      expect(I.startPresenceTripwire({ ctx, onLoss: l => { losses.push(l) }, timer: false, now: () => 0 }).ok).toBe(true)
      expect(I.presenceTripwireCheck(0)).toBeNull()
      rmSync(join(w.home, '.config'), { recursive: true })
      expect(I.presenceTripwireCheck(500)).toBeNull()
      expect(I.presenceTripwireCheck(1_000)).toBe(I.INTEGRITY_LOSS_TO_MODEL)
      expect(losses).toHaveLength(1)
    } finally {
      I.resetPresenceTripwireForTests()
    }
  })
})
