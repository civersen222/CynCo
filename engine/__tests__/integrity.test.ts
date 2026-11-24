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
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as I from '../integrity.js'
import { mintRunId, testContainment } from '../containment.js'
import { canSymlinkFiles } from './imagegen/mockComfy.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })
afterEach(() => I.stopPresenceTripwire())

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

  it.skipIf(!canSymlinkFiles())('(4) a link is recorded as a link and not followed; retargeting it trips', () => {
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
    for (const p of [join(home, '.cynco', 'profiles'), join(home, '.cynco', 'heldout'), join(other, 'profiles'), join(other, 'heldout'), models, join(home, '.ssh'), join(home, '.ollama', 'models')]) {
      expect(frozen).toContain(resolve(p))
    }
    expect(r.frozen.find(f => f.path === resolve(home, '.ssh'))!.mutable).toEqual(['known_hosts', 'known_hosts.old'])
    expect(r.presence.find(p => p.path === resolve(home))).toMatchObject({ dotOnly: true, files: true, counts: true })
    // The desk tools' folder: the one dot-folder of the home watched by sub-folder name alone.
    const desk = r.presence.filter(p => dirname(p.path) === resolve(home) && p.path !== resolve(home, '.cynco'))
    expect(desk).toHaveLength(1)
    expect(desk[0]).toMatchObject({ dotOnly: false, files: false, counts: false, volume: false })
    expect(r.presence.find(p => p.path === resolve(other, 'authoring'))).toMatchObject({ counts: true })
    expect(r.presence.find(p => p.path === resolve(base, 'D'))).toMatchObject({ volume: true, network: false, files: true })
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
    expect(s.summary).toMatch(/^1 change\(s\) in protected folders; first: FROZEN .*heldout\/g\/planted\.py added$/)
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

  it('(22) a settle whose rename meets ENOENT returns the recorded line', async () => {
    const w = world()
    const id = baseline(w)
    put(join(w.state, 'profiles', 'new.yaml'))
    const other = () => {
      renameSync(before(w, id), join(w.base, 'moved.json'))
      appendFileSync(join(w.guard, 'checks.jsonl'), JSON.stringify({ run: id, kind: 'settle', baselineTakenAt: null, at: 'earlier', by: 'the other settler', changed: true, changeCount: 1, publicSummary: '1 change(s) in protected folders (first: FROZEN)', ms: 1 }) + '\n')
    }
    const s = await I.settleRun(id, opts(w, pager().fn, { sleep: other }))
    expect(s).toMatchObject({ from: 'recorded', by: 'the other settler', settled: true })
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
    expect(I.clearHalt(w.guard, { by: 'test' })).toEqual({ cleared: false, latch: null, archivedTo: null })
    const run = rid()
    await I.tripHalt({ by: 'test', run, reason: 'integrity-change', guard: w.guard, page: pager().fn })
    const r = I.clearHalt(w.guard, { by: 'owner', now: () => new Date('2026-11-23T01:02:03Z') })
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
    const r = I.startPresenceTripwire({ ctx: t.ctx, onLoss: t.onLoss, timer: false, now: () => 0 })
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
