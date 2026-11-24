// The models folder has one key, LOCALCODE_MODELS_DIR, read in one place (engine/paths.ts), so the
// models can live outside the home folder a mission deleted on 2026-11-22 (F242). Unset, the folder
// is where it always was. Absolute paths are built with tmpdir(), so the cases mean the same on Linux.
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { cyncoHome, modelsDir, requireModelsDir } from '../paths.js'

const saved = process.env.LOCALCODE_MODELS_DIR
afterEach(() => { if (saved === undefined) delete process.env.LOCALCODE_MODELS_DIR; else process.env.LOCALCODE_MODELS_DIR = saved })

describe('modelsDir', () => {
  it('defaults to <cyncoHome>/models', () => {
    delete process.env.LOCALCODE_MODELS_DIR
    expect(modelsDir()).toBe(join(cyncoHome(), 'models'))
  })

  it('returns the value exactly as written, not joined and not normalised', () => {
    const raw = join(tmpdir(), 'cynco-models-elsewhere') + '/sub/../'
    process.env.LOCALCODE_MODELS_DIR = raw
    expect(modelsDir()).toBe(raw)
  })

  it('treats an empty value as unset', () => {
    process.env.LOCALCODE_MODELS_DIR = ''
    expect(modelsDir()).toBe(join(cyncoHome(), 'models'))
  })

  it('reads the variable on every call', () => {
    const a = join(tmpdir(), 'cynco-models-a')
    const b = join(tmpdir(), 'cynco-models-b')
    process.env.LOCALCODE_MODELS_DIR = a
    expect(modelsDir()).toBe(a)
    process.env.LOCALCODE_MODELS_DIR = b
    expect(modelsDir()).toBe(b)
  })

  it('uses its home argument for the default only', () => {
    const home = join(tmpdir(), 'cynco-other-home')
    delete process.env.LOCALCODE_MODELS_DIR
    expect(modelsDir(home)).toBe(join(home, 'models'))
    const moved = join(tmpdir(), 'cynco-models-moved')
    process.env.LOCALCODE_MODELS_DIR = moved
    expect(modelsDir(home)).toBe(moved)
  })
})

describe('requireModelsDir', () => {
  it('returns an absolute override unchanged', () => {
    const moved = join(tmpdir(), 'cynco-models-moved')
    process.env.LOCALCODE_MODELS_DIR = moved
    expect(requireModelsDir()).toBe(moved)
  })

  it('throws a named error for a relative override', () => {
    process.env.LOCALCODE_MODELS_DIR = 'models-here'
    expect(() => requireModelsDir()).toThrow(
      'LOCALCODE_MODELS_DIR is "models-here", which is not an absolute path. It would be resolved against the working folder of whichever process reads it. Set it to the full path of the models folder.',
    )
  })

  it('on Windows, refuses a path with no drive letter and a network share (review 2026-11-23)', () => {
    for (const v of ['\\cynco-models', '/cynco-models', '\\\\nas\\share\\models']) {
      process.env.LOCALCODE_MODELS_DIR = v
      expect(() => requireModelsDir(cyncoHome(), 'win32'), v).toThrow(/is not a full path below a drive letter/)
    }
    process.env.LOCALCODE_MODELS_DIR = 'C:\\cynco-models'
    expect(requireModelsDir(cyncoHome(), 'win32')).toBe('C:\\cynco-models')
    process.env.LOCALCODE_MODELS_DIR = 'models-here'
    expect(() => requireModelsDir(cyncoHome(), 'win32')).toThrow(/is not an absolute path/)
    process.env.LOCALCODE_MODELS_DIR = '/srv/models'
    expect(requireModelsDir(cyncoHome(), 'linux')).toBe('/srv/models')
  })

  it('does not judge the default, so a relative home behaves as it always has', () => {
    delete process.env.LOCALCODE_MODELS_DIR
    expect(requireModelsDir('rel-home')).toBe(join('rel-home', 'models'))
  })
})

describe('the dispatch names the models folder its shell resolves', () => {
  it('prints LOCALCODE_MODELS_DIR raw, or that it is unset', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const sh = readFileSync(join(root, 'scripts', 'dispatch-mission.sh'), 'utf8')
    expect(sh).toMatch(/echo "\[dispatch\] models folder: \$\{LOCALCODE_MODELS_DIR:-unset/)
  })
})
