import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import {
  canonicalJson, ensureImageIgnore, imageKey, INTERRUPTED_REASON, KEY_RE, normPrompt, originKey, ORIGINS_CAP, pngPath, publicSidecar,
  readOrigins, readSidecar, recordOrigins, RUN_ID, seedFor, servedImage, sidecarPath, storedImageState, writeSidecar, type ImageSidecar, type KeyFields,
} from '../../imagegen/store.js'
import { PNG_1X1 } from './mockComfy.js'

/** A file symlink needs a privilege on Windows; a directory junction does not. */
function canSymlinkFiles(): boolean {
  const d = mkdtempSync(join(tmpdir(), 'cynco-imagegen-link-'))
  try {
    writeFileSync(join(d, 'a'), '')
    symlinkSync(join(d, 'a'), join(d, 'b'))
    return true
  } catch (e) {
    console.log(`file symlinks need privileges here: ${(e as Error).message}`)
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}
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
