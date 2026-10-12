import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createProject } from '../../projects/layout.js'
import {
  annotateFileImages, canonicalJson, ensureImageIgnore, fileImages, FILES_ONLY_REASON, imageKey, INTERRUPTED_REASON, KEY_RE, normPrompt, originKey, ORIGINS_CAP, pngPath, publicSidecar,
  readOrigins, readSidecar, recordOrigins, RUN_ID, seedFor, servedImage, servedProjectFile, sidecarPath, storeFault, storedImageState, SVG_CAP_BYTES, writeSidecar, type ImageSidecar, type KeyFields,
} from '../../imagegen/store.js'
import type { UiSpec } from '../../bridge/protocol.js'
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

// An Image whose src is a relative image path shows a file the model wrote into
// the project (dashboard transcript, 2026-10-11: 1:1 printable SVG templates).
describe('file Images: which Images show a project file, and their annotation', () => {
  const spec = (): UiSpec => ({ root: 'g', elements: Object.assign(Object.create(null), {
    g: { type: 'Grid', props: {}, children: ['a', 'b', 'c', 'd', 'e', 'f'] },
    a: { type: 'Image', props: { src: 'tower/templates/tower_v1.svg', alt: 'Tower' } },
    b: { type: 'Image', props: { prompt: 'a tall alien', alt: 'Alien' } },
    c: { type: 'Image', props: { src: 'https://example.com/a.png', alt: 'URL' } },
    d: { type: 'Image', props: { src: '../secret.png', alt: 'Bad' } },   // validateSpec never lets this through; the rule is checked here again
    e: { type: 'Image', props: { src: 'sketches/front.png', alt: 'Front', caption: 'Front view' } },
    f: { type: 'Text', props: { text: 'x', src: 'x.png' } },
    orphan: { type: 'Image', props: { src: 'x.png', alt: 'x' } },
  }) })

  it('fileImages: every reachable Image with a project-path src and no prompt, in draw order', () => {
    const s = spec()
    expect(fileImages(s).map(f => [f.id, f.path])).toEqual([['a', 'tower/templates/tower_v1.svg'], ['e', 'sketches/front.png']])
    expect(fileImages(s)[0].el).toBe(s.elements.a)
    expect(fileImages({ root: 'none', elements: Object.create(null) })).toEqual([])
    expect(fileImages({ root: 'x', elements: Object.assign(Object.create(null), { x: null as unknown as UiSpec['elements'][string] }) })).toEqual([])
  })

  it('annotateFileImages in a project: the file state with the slug and path, the src taken out of props; outside one: off with the reason', () => {
    const s = spec()
    expect(annotateFileImages(s, 'aliens')).toEqual([{ id: 'a', path: 'tower/templates/tower_v1.svg' }, { id: 'e', path: 'sketches/front.png' }])
    expect(s.elements.a).toEqual({ type: 'Image', props: { alt: 'Tower' }, image: { status: 'file', slug: 'aliens', path: 'tower/templates/tower_v1.svg' } })
    expect(s.elements.e).toEqual({ type: 'Image', props: { alt: 'Front', caption: 'Front view' }, image: { status: 'file', slug: 'aliens', path: 'sketches/front.png' } })
    expect(s.elements.b).toEqual({ type: 'Image', props: { prompt: 'a tall alien', alt: 'Alien' } })
    expect(s.elements.c).toEqual({ type: 'Image', props: { src: 'https://example.com/a.png', alt: 'URL' } })
    expect(s.elements.d).toEqual({ type: 'Image', props: { src: '../secret.png', alt: 'Bad' } })
    expect(s.elements.f.image).toBeUndefined()
    const t = spec()
    expect(annotateFileImages(t, null)).toEqual([{ id: 'a', path: 'tower/templates/tower_v1.svg' }, { id: 'e', path: 'sketches/front.png' }])
    expect(t.elements.a).toEqual({ type: 'Image', props: { alt: 'Tower' }, image: { status: 'off', reason: FILES_ONLY_REASON } })
    expect(t.elements.e.image).toEqual({ status: 'off', reason: FILES_ONLY_REASON })
    expect(FILES_ONLY_REASON).toBe('files are shown in project chats only')
    // annotating again is a no-op: the src is gone and the state stays
    expect(annotateFileImages(s, 'aliens')).toEqual([])
    expect(s.elements.a.image).toEqual({ status: 'file', slug: 'aliens', path: 'tower/templates/tower_v1.svg' })
  })
})

describe('servedProjectFile', () => {
  const SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!-- 1:1 template -->\n<svg xmlns="http://www.w3.org/2000/svg" width="30in" height="40in"><rect width="1" height="1"/></svg>\n'
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
  const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
  const write = (rel: string, bytes: Buffer | string) => {
    const p = join(dir, ...rel.split('/'))
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, bytes)
  }

  it('serves each type under its fixed content type when the bytes carry its signature', () => {
    write('tower/templates/tower_v1.svg', '\uFEFF' + SVG)
    write('plain.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    write('spaced.svg', '  \n\t<svg>')
    write('front.png', PNG_1X1)
    write('a.jpg', JPEG)
    write('b.JPEG', JPEG)
    write('c.gif', GIF)
    write('d.webp', WEBP)
    write('my tower (v2)/front view.png', PNG_1X1)
    for (const [rel, type, bytes] of [
      ['tower/templates/tower_v1.svg', 'image/svg+xml', Buffer.from('\uFEFF' + SVG)], ['plain.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['spaced.svg', 'image/svg+xml', Buffer.from('  \n\t<svg>')], ['front.png', 'image/png', PNG_1X1], ['a.jpg', 'image/jpeg', JPEG], ['b.JPEG', 'image/jpeg', JPEG],
      ['c.gif', 'image/gif', GIF], ['d.webp', 'image/webp', WEBP], ['./front.png', 'image/png', PNG_1X1], ['my tower (v2)/front view.png', 'image/png', PNG_1X1],
    ] as Array<[string, string, Buffer]>) {
      const r = servedProjectFile(home, slug, rel)
      expect(r.status, rel).toBe(200)
      expect(r.type, rel).toBe(type)
      expect(Buffer.from(r.bytes!).equals(bytes), rel).toBe(true)
    }
  })

  it('refuses a bad path (400), a bad slug, a missing project, a missing file, a folder, a dot-leading segment (404)', () => {
    write('front.png', PNG_1X1)
    for (const rel of ['../project.json', 'project.json', '/front.png', 'C:/front.png', 'tower\\front.png', 'front.png\0', '.cynco/index/x.png', 'x.html', 'front.png/', '', 'a'.repeat(197) + '.png']) {
      expect(servedProjectFile(home, slug, rel), JSON.stringify(rel)).toEqual({ status: 400, json: { error: 'bad file path' } })
    }
    expect(servedProjectFile(home, '../x', 'front.png')).toEqual({ status: 400, json: { error: 'bad slug' } })
    expect(servedProjectFile(home, 'no-such-project', 'front.png')).toEqual({ status: 404, json: { error: 'no such project' } })
    expect(servedProjectFile(home, slug, 'missing.png')).toEqual({ status: 404, json: { error: 'no such file' } })
    mkdirSync(join(dir, 'folder.png'))
    expect(servedProjectFile(home, slug, 'folder.png')).toEqual({ status: 404, json: { error: 'no such file' } })
  })

  it('415: a raster without its signature, an svg that is not one (html, a renamed PNG, a DOCTYPE with an internal subset, a script before the root)', () => {
    write('fake.png', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    write('fake.jpg', PNG_1X1)
    write('fake.gif', PNG_1X1)
    write('fake.webp', Buffer.from('RIFF\x00\x00\x00\x00WAVE'))
    write('page.svg', '<!DOCTYPE html><html><body><script>alert(1)</script></body></html>')
    write('renamed.svg', PNG_1X1)
    write('entities.svg', '<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY x "y"> ]><svg xmlns="http://www.w3.org/2000/svg"/>')
    write('script.svg', '<script>alert(1)</script><svg/>')
    write('half.svg', '<sv')
    write('empty.svg', '')
    for (const [rel, what] of [['fake.png', 'PNG'], ['fake.jpg', 'JPEG'], ['fake.gif', 'GIF'], ['fake.webp', 'WEBP'], ['page.svg', 'SVG'], ['renamed.svg', 'SVG'], ['entities.svg', 'SVG'], ['script.svg', 'SVG'], ['half.svg', 'SVG'], ['empty.svg', 'SVG']]) {
      expect(servedProjectFile(home, slug, rel), rel).toEqual({ status: 415, json: { error: `${rel} is not a ${what} file; refused` } })
    }
  })

  it('413: a raster over 32 MB, an svg over 2 MB — before reading a byte', () => {
    write('big.png', PNG_1X1)
    truncateSync(join(dir, 'big.png'), 32 * 1024 * 1024 + 1)
    expect(servedProjectFile(home, slug, 'big.png')).toEqual({ status: 413, json: { error: 'big.png is larger than 32 MB; refused' } })
    truncateSync(join(dir, 'big.png'), 32 * 1024 * 1024)
    expect(servedProjectFile(home, slug, 'big.png').status).toBe(200)
    write('big.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    truncateSync(join(dir, 'big.svg'), SVG_CAP_BYTES + 1)
    expect(servedProjectFile(home, slug, 'big.svg')).toEqual({ status: 413, json: { error: 'big.svg is larger than 2 MB; refused' } })
    truncateSync(join(dir, 'big.svg'), SVG_CAP_BYTES)
    expect(servedProjectFile(home, slug, 'big.svg').status).toBe(200)
    expect(SVG_CAP_BYTES).toBe(2 * 1024 * 1024)
  })

  it.skipIf(!CAN_SYMLINK_FILES)('a file link or a folder link out of the project is 404', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cynco-imagegen-outside-'))
    try {
      writeFileSync(join(outside, 'secret.png'), PNG_1X1)
      symlinkSync(join(outside, 'secret.png'), join(dir, 'linked.png'))
      expect(servedProjectFile(home, slug, 'linked.png')).toEqual({ status: 404, json: { error: 'no such file' } })
      symlinkSync(outside, join(dir, 'elsewhere'), 'junction')
      expect(servedProjectFile(home, slug, 'elsewhere/secret.png')).toEqual({ status: 404, json: { error: 'no such file' } })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
