import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createProject } from '../../projects/layout.js'
import {
  canonicalJson, ensureImageIgnore, imageKey, INTERRUPTED_REASON, KEY_RE, normPrompt, originKey, ORIGINS_CAP, pngPath, publicSidecar,
  readOrigins, readSidecar, recordOrigins, RUN_ID, seedFor, servedImage, sidecarPath, storeFault, storedImageState, writeSidecar, type ImageSidecar, type KeyFields,
} from '../../imagegen/store.js'
import { canSymlinkFiles, PNG_1X1 } from './mockComfy.js'

const CAN_SYMLINK_FILES = canSymlinkFiles()

let home: string, dir: string, slug: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cynco-imagegen-store-'))
  slug = createProject(home, { name: 'Aliens' }).slug
  dir = join(home, slug)
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const FIELDS: KeyFields = {
  prompt: 'a tall green alien', negative: 'blurry', seed: seedFor('a tall green alien', 'blurry'), width: 1024, height: 1024, steps: 40, cfg: 6,
  sampler: 'dpmpp_2m', scheduler: 'karras', checkpoint: 'auto', workflow: 'builtin-1',
}

function sidecar(key: string, over: Partial<ImageSidecar> = {}): ImageSidecar {
  return {
    schema: 1, key, status: 'done', runId: RUN_ID, prompt: 'a tall green alien', negative: 'blurry', alt: 'Alien', seed: 7, width: 1024, height: 768,
    steps: 40, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras', checkpoint: 'juggernautXL_v9.safetensors', workflow: { source: 'builtin', sha256: 'builtin-1' },
    apiPrompt: { '3': { class_type: 'KSampler', inputs: {} } }, comfy: { host: 'pc:8188', promptId: 'p1', outputs: [{ filename: 'x_00001_.png', subfolder: 'cynco', type: 'output' }] },
    sha256: 'a'.repeat(64), bytes: 68, queuedAt: '2026-10-10T00:00:00.000Z', finishedAt: '2026-10-10T00:00:30.000Z',
    origin: { chatFile: 'c.jsonl', toolId: 't1', elementId: 'img-a', surfaceId: 'aliens' },
    ...over,
  }
}

describe('keys and seeds', () => {
  it('the key is 32 hex, stable, and changes with every field', () => {
    const k = imageKey(FIELDS)
    expect(k).toMatch(KEY_RE)
    expect(imageKey({ ...FIELDS })).toBe(k)
    const changed: Partial<KeyFields>[] = [
      { prompt: 'a short green alien' }, { negative: 'ugly' }, { seed: 1 }, { width: 768 }, { height: 768 }, { steps: 41 }, { cfg: 5.5 },
      { sampler: 'euler' }, { scheduler: 'normal' }, { checkpoint: 'juggernautXL_v9.safetensors' }, { workflow: 'f'.repeat(64) },
    ]
    const keys = changed.map(c => imageKey({ ...FIELDS, ...c }))
    expect(new Set([k, ...keys]).size).toBe(changed.length + 1)
  })

  it('canonical JSON sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}')
  })

  it('the seed is stable, below 2^48, and the prompt is normalised first', () => {
    const s = seedFor('a tall green alien', 'blurry')
    expect(seedFor('a tall green alien', 'blurry')).toBe(s)
    expect(Number.isSafeInteger(s)).toBe(true)
    expect(s).toBeLessThan(2 ** 48)
    expect(seedFor('a tall green alien', 'ugly')).not.toBe(s)
    expect(normPrompt('  a   tall\n\tgreen alien ')).toBe('a tall green alien')
  })
})

describe('sidecars', () => {
  it('round-trips', () => {
    const k = imageKey(FIELDS)
    writeSidecar(dir, sidecar(k))
    expect(readSidecar(dir, k)).toEqual(sidecar(k))
    expect(readSidecar(dir, imageKey({ ...FIELDS, steps: 1 }))).toBeNull()
  })

  it('a tampered sidecar reads as no record', () => {
    const k = imageKey(FIELDS)
    const bad: Array<Record<string, unknown>> = [
      { status: 'painted' }, { width: '1024' }, { key: imageKey({ ...FIELDS, cfg: 1 }) }, { schema: 2 }, { origin: null }, { comfy: { host: 'h', promptId: 'p', outputs: [{ filename: 1 }] } },
      { reason: 42 }, { apiPrompt: 'x' }, { workflow: { source: 'builtin' } },
    ]
    mkdirSync(join(dir, 'images'), { recursive: true })
    for (const over of bad) {
      writeFileSync(sidecarPath(dir, k), JSON.stringify({ ...sidecar(k), ...over }), 'utf8')
      expect(readSidecar(dir, k), JSON.stringify(over)).toBeNull()
    }
    writeFileSync(sidecarPath(dir, k), '{ not json', 'utf8')
    expect(readSidecar(dir, k)).toBeNull()
    expect(readSidecar(dir, '../../project')).toBeNull()
  })

  it('a queued or running record from another engine run reads as interrupted', () => {
    const k = imageKey(FIELDS)
    expect(publicSidecar(sidecar(k, { status: 'running', runId: 'another-run' }))).toMatchObject({ status: 'failed', reason: INTERRUPTED_REASON })
    expect(publicSidecar(sidecar(k, { status: 'queued', runId: RUN_ID }))).toMatchObject({ status: 'queued' })
    expect(publicSidecar(sidecar(k))).toEqual({ status: 'done', w: 1024, h: 768, prompt: 'a tall green alien', alt: 'Alien', checkpoint: 'juggernautXL_v9.safetensors', seed: 7, finishedAt: '2026-10-10T00:00:30.000Z' })
  })
})

describe('origins', () => {
  it('records, re-maps an origin as newest, and caps the index', () => {
    const k1 = imageKey(FIELDS), k2 = imageKey({ ...FIELDS, steps: 2 })
    const o1 = originKey({ chatFile: 'c.jsonl', toolId: 't1', elementId: 'a' }), o2 = originKey({ chatFile: 'c.jsonl', toolId: 't1', elementId: 'b' })
    recordOrigins(dir, [[o1, k1], [o2, k2]])
    recordOrigins(dir, [[o1, k2]])
    const map = readOrigins(dir)
    expect(Object.getPrototypeOf(map)).toBeNull()
    expect(Object.keys(map)).toEqual([o2, o1])
    expect(map[o1]).toBe(k2)
    const many: Array<[string, string]> = Array.from({ length: ORIGINS_CAP + 10 }, (_, i) => [`c.jsonl#t${i}#e`, k1])
    recordOrigins(dir, many)
    const capped = readOrigins(dir)
    expect(Object.keys(capped)).toHaveLength(ORIGINS_CAP)
    expect(Object.hasOwn(capped, o2)).toBe(false)
    expect(Object.hasOwn(capped, `c.jsonl#t${ORIGINS_CAP + 9}#e`)).toBe(true)
  })

  it('a tampered index keeps only well-formed origin → key pairs', () => {
    const k = imageKey(FIELDS)
    mkdirSync(join(dir, 'images'), { recursive: true })
    writeFileSync(join(dir, 'images', 'index.json'), `{"schema":1,"origins":{"__proto__":"${k}","c.jsonl#t#e":"../../etc/passwd","c.jsonl#t#f":"${k.toUpperCase()}","c.jsonl#t#g":"${k}","constructor":"${k}"}}`, 'utf8')
    const map = readOrigins(dir)
    expect(Object.keys(map)).toEqual(['c.jsonl#t#g'])
    expect(storedImageState(dir, slug, '__proto__')).toEqual({ status: 'off', reason: 'this picture was not generated' })
    expect(storedImageState(dir, slug, 'constructor')).toEqual({ status: 'off', reason: 'this picture was not generated' })
    writeFileSync(join(dir, 'images', 'index.json'), '{"schema":1,"origins":[1,2]}', 'utf8')
    expect(Object.keys(readOrigins(dir))).toEqual([])
  })
})

describe('ensureImageIgnore', () => {
  it('appends images/*.png once and keeps every existing line', () => {
    writeFileSync(join(dir, '.gitignore'), '.cynco/\nnotes.tmp', 'utf8')
    ensureImageIgnore(dir)
    ensureImageIgnore(dir)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.cynco/\nnotes.tmp\nimages/*.png\n')
    rmSync(join(dir, '.gitignore'))
    ensureImageIgnore(dir)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('images/*.png\n')
  })
})

describe('servedImage', () => {
  it('serves a PNG and the public sidecar by key', () => {
    const k = imageKey(FIELDS)
    writeSidecar(dir, sidecar(k))
    writeFileSync(pngPath(dir, k), PNG_1X1)
    const png = servedImage(home, slug, `${k}.png`)
    expect(png.status).toBe(200)
    expect(Buffer.from(png.bytes!).equals(PNG_1X1)).toBe(true)
    expect(servedImage(home, slug, `${k}.json`)).toEqual({ status: 200, json: publicSidecar(sidecar(k)) })
  })

  it('refuses bad names, a bad slug and a missing file', () => {
    const k = imageKey(FIELDS)
    for (const name of ['../project.json', `${k.toUpperCase()}.png`, `${k.slice(1)}.png`, `${k}.svg`, `${k}.png\0`, 'index.json', `${k}.png/x`]) {
      expect(servedImage(home, slug, name), name).toEqual({ status: 400, json: { error: 'bad image name' } })
    }
    expect(servedImage(home, '../x', `${k}.png`)).toEqual({ status: 400, json: { error: 'bad slug' } })
    expect(servedImage(home, 'no-such-project', `${k}.png`)).toEqual({ status: 404, json: { error: 'no such project' } })
    expect(servedImage(home, slug, `${k}.png`)).toEqual({ status: 404, json: { error: 'no such image' } })
    expect(servedImage(home, slug, `${k}.json`)).toEqual({ status: 404, json: { error: 'no such image' } })
  })

  it('refuses a planted file that is not a PNG', () => {
    const k = imageKey(FIELDS)
    mkdirSync(join(dir, 'images'), { recursive: true })
    writeFileSync(pngPath(dir, k), '<svg onload="alert(1)"/>', 'utf8')
    expect(servedImage(home, slug, `${k}.png`)).toEqual({ status: 415, json: { error: `images/${k}.png is not a PNG; refused` } })
  })

  it('refuses a picture or record over 32 MB before reading a byte of it', () => {
    const k = imageKey(FIELDS)
    writeSidecar(dir, sidecar(k))
    // A real PNG start, then a sparse tail one byte past the cap.
    writeFileSync(pngPath(dir, k), PNG_1X1)
    truncateSync(pngPath(dir, k), 32 * 1024 * 1024 + 1)
    expect(servedImage(home, slug, `${k}.png`)).toEqual({ status: 413, json: { error: `images/${k}.png is larger than 32 MB; refused` } })
    truncateSync(sidecarPath(dir, k), 32 * 1024 * 1024 + 1)
    expect(servedImage(home, slug, `${k}.json`)).toEqual({ status: 413, json: { error: `images/${k}.json is larger than 32 MB; refused` } })
    // exactly at the cap is served (the cap is inclusive)
    truncateSync(pngPath(dir, k), 32 * 1024 * 1024)
    expect(servedImage(home, slug, `${k}.png`).status).toBe(200)
  })

  it.skipIf(!CAN_SYMLINK_FILES)('refuses a file symlink that escapes the project', () => {
    const k = imageKey(FIELDS)
    const outside = mkdtempSync(join(tmpdir(), 'cynco-imagegen-outside-'))
    try {
      writeFileSync(join(outside, 'secret.png'), PNG_1X1)
      mkdirSync(join(dir, 'images'), { recursive: true })
      symlinkSync(join(outside, 'secret.png'), pngPath(dir, k))
      expect(servedImage(home, slug, `${k}.png`)).toEqual({ status: 404, json: { error: 'no such image' } })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses an images folder linked outside the project', () => {
    const k = imageKey(FIELDS)
    const outside = mkdtempSync(join(tmpdir(), 'cynco-imagegen-outside-'))
    try {
      writeFileSync(join(outside, `${k}.png`), PNG_1X1)
      symlinkSync(outside, join(dir, 'images'), 'junction')
      expect(servedImage(home, slug, `${k}.png`)).toEqual({ status: 404, json: { error: 'no such image' } })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('storedImageState', () => {
  const origin = originKey({ chatFile: 'c.jsonl', toolId: 't1', elementId: 'img-a' })

  it('no origin entry: off, not generated', () => {
    expect(storedImageState(dir, slug, origin)).toEqual({ status: 'off', reason: 'this picture was not generated' })
  })

  it('done with its PNG, done with the PNG deleted, queued in this run, stale from another run', () => {
    const k = imageKey(FIELDS)
    writeSidecar(dir, sidecar(k))
    writeFileSync(pngPath(dir, k), PNG_1X1)
    recordOrigins(dir, [[origin, k]])
    expect(storedImageState(dir, slug, origin)).toEqual({ status: 'done', key: k, slug, w: 1024, h: 768 })
    rmSync(pngPath(dir, k))
    expect(storedImageState(dir, slug, origin)).toEqual({ status: 'failed', key: k, slug, w: 1024, h: 768, reason: `images/${k}.png is missing` })
    writeSidecar(dir, sidecar(k, { status: 'queued' }))
    expect(storedImageState(dir, slug, origin)).toEqual({ status: 'queued', key: k, slug, w: 1024, h: 768 })
    writeSidecar(dir, sidecar(k, { status: 'running', runId: 'an-engine-that-crashed' }))
    expect(storedImageState(dir, slug, origin)).toEqual({ status: 'failed', key: k, slug, w: 1024, h: 768, reason: INTERRUPTED_REASON })
    writeSidecar(dir, sidecar(k, { status: 'failed', reason: 'ComfyUI failed in KSampler (node 3): boom' }))
    expect(storedImageState(dir, slug, origin, readOrigins(dir))).toEqual({ status: 'failed', key: k, slug, w: 1024, h: 768, reason: 'ComfyUI failed in KSampler (node 3): boom' })
    rmSync(sidecarPath(dir, k))
    expect(storedImageState(dir, slug, origin)).toMatchObject({ status: 'off' })
    expect(existsSync(join(dir, 'images', 'index.json'))).toBe(true)
  })
})

describe('links and special files the model planted', () => {
  // The model can write anywhere in a project, links included: the engine's own writes must never follow one out.
  const origin = originKey({ chatFile: 'c.jsonl', toolId: 't1', elementId: 'img-a' })
  let outside: string, victim: string
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'cynco-imagegen-outside-'))
    victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'ORIGINAL\n', 'utf8')
  })
  afterEach(() => { rmSync(outside, { recursive: true, force: true }) })

  it.skipIf(!CAN_SYMLINK_FILES)('a .gitignore linked out of the project is refused by name and the file it points at is untouched', () => {
    rmSync(join(dir, '.gitignore'))
    symlinkSync(victim, join(dir, '.gitignore'))
    expect(ensureImageIgnore(dir)).toBe('.gitignore in the project is a link or not a regular file; the engine will not write through it — refused')
    expect(storeFault(dir)).toBe(ensureImageIgnore(dir))
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL\n')
  })

  it.skipIf(!CAN_SYMLINK_FILES)('an atomic write never follows a link planted at its temp name', () => {
    const k = imageKey(FIELDS)
    mkdirSync(join(dir, 'images'), { recursive: true })
    symlinkSync(victim, join(dir, 'images', `index.json.tmp-${process.pid}`))
    recordOrigins(dir, [[origin, k]])
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL\n')
    expect(lstatSync(join(dir, 'images', 'index.json')).isFile()).toBe(true)
    expect(readOrigins(dir)[origin]).toBe(k)
  })

  it('an images folder that is a link is refused before any write, with the reason', () => {
    const k = imageKey(FIELDS)
    symlinkSync(outside, join(dir, 'images'), 'junction')
    const reason = 'images/ in the project is a link; pictures are written only into a real folder inside it — refused'
    expect(storeFault(dir)).toBe(reason)
    expect(() => writeSidecar(dir, sidecar(k))).toThrow(reason)
    expect(() => recordOrigins(dir, [[origin, k]])).toThrow(reason)
    expect(readdirSync(outside)).toEqual(['victim.txt'])
  })

  it('a .cynco folder linked out of the project is refused: the download folder would land outside', () => {
    mkdirSync(join(outside, 'cynco'))
    rmSync(join(dir, '.cynco'), { recursive: true, force: true })
    symlinkSync(join(outside, 'cynco'), join(dir, '.cynco'), 'junction')
    expect(storeFault(dir)).toMatch(/^\.cynco\/tmp\/ leads outside the project \(to .*\); refused$/)
  })

  it('a record padded past its size cap is not read', () => {
    const k = imageKey(FIELDS)
    mkdirSync(join(dir, 'images'), { recursive: true })
    writeFileSync(join(dir, 'images', 'index.json'), `{"schema":1,"origins":{"${origin}":"${k}"}}` + ' '.repeat(5 * 1024 * 1024), 'utf8')
    expect(Object.keys(readOrigins(dir))).toEqual([])
  })

  // A plain read of a FIFO blocks until a writer comes, and /dev/zero never ends: either would freeze the engine's one thread.
  it.skipIf(process.platform === 'win32')('a FIFO or a device where a record should be reads as no record, at once', () => {
    const k = imageKey(FIELDS)
    const index = join(dir, 'images', 'index.json')
    mkdirSync(join(dir, 'images'), { recursive: true })
    execFileSync('mkfifo', [index])
    expect(Object.keys(readOrigins(dir))).toEqual([])
    rmSync(index)
    symlinkSync('/dev/zero', index)
    expect(Object.keys(readOrigins(dir))).toEqual([])
    rmSync(index)
    recordOrigins(dir, [[origin, k]])
    execFileSync('mkfifo', [sidecarPath(dir, k)])
    expect(readSidecar(dir, k)).toBeNull()
    expect(storedImageState(dir, slug, origin)).toEqual({ status: 'off', reason: `the record of this picture (images/${k}.json) is missing or unreadable` })
    rmSync(join(dir, '.gitignore'))
    execFileSync('mkfifo', [join(dir, '.gitignore')])
    expect(ensureImageIgnore(dir)).toBe('.gitignore in the project is a link or not a regular file; the engine will not write through it — refused')
  })
})
