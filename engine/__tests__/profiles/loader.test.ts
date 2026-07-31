import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadProfile, listProfiles } from '../../profiles/loader.js'

/**
 * Tests for the YAML profile loader.
 *
 * Uses real temp directories to exercise filesystem logic.
 * The loader searches three locations:
 *   1. .cynco/profiles/<name>.yml (project-local, highest priority)
 *   2. ~/.cynco/profiles/<name>.yml (global)
 *   3. engine/profiles/templates/<name>.yaml (bundled, lowest priority)
 *
 * (3) is why a fresh clone can start. It used to be unreachable: the loader
 * searched only (1) and (2), `engine/profiles/templates/default.yaml` was a path
 * no code read, and `config.ts` resolves the profile named `default` when none
 * is given. So on a clone with no `~/.cynco` the profile resolved to null, the
 * model resolved to undefined, and `main.ts` printed "No model specified" and
 * exited 1 — which is every one of the README's Quick Start commands.
 */

// ---- helpers ----

let tmpDir: string
let origHome: string | undefined
let origCwd: string

function globalDir() {
  return path.join(tmpDir, 'home', '.cynco', 'profiles')
}

function projectDir() {
  return path.join(tmpDir, 'project', '.cynco', 'profiles')
}

function writeGlobal(name: string, content: string) {
  fs.mkdirSync(globalDir(), { recursive: true })
  fs.writeFileSync(path.join(globalDir(), `${name}.yml`), content)
}

function writeProject(name: string, content: string) {
  fs.mkdirSync(projectDir(), { recursive: true })
  fs.writeFileSync(path.join(projectDir(), `${name}.yml`), content)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-profile-test-'))
  fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true })

  origHome = process.env.HOME
  origCwd = process.cwd()
  process.env.HOME = path.join(tmpDir, 'home')
  process.chdir(path.join(tmpDir, 'project'))
})

afterEach(() => {
  process.env.HOME = origHome
  process.chdir(origCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---- loadProfile ----

describe('loadProfile', () => {
  it('returns null for a nonexistent profile', () => {
    const result = loadProfile('nonexistent')
    expect(result).toBeNull()
  })

  it('parses valid YAML into a Profile object', () => {
    writeGlobal('test-model', `
name: test-model
model: llama3:8b
temperature: 0.5
max_output_tokens: 4096
context_length: 16384
`)
    const profile = loadProfile('test-model')
    expect(profile).not.toBeNull()
    expect(profile!.name).toBe('test-model')
    expect(profile!.model).toBe('llama3:8b')
    expect(profile!.temperature).toBe(0.5)
    expect(profile!.max_output_tokens).toBe(4096)
    expect(profile!.context_length).toBe(16384)
  })

  it('returns project-local profile over global when both exist', () => {
    writeGlobal('my-profile', `
name: my-profile
model: global-model:7b
temperature: 0.7
`)
    writeProject('my-profile', `
name: my-profile
model: project-model:13b
temperature: 0.3
`)
    const profile = loadProfile('my-profile')
    expect(profile).not.toBeNull()
    expect(profile!.model).toBe('project-model:13b')
    expect(profile!.temperature).toBe(0.3)
  })

  it('falls back to global profile when project-local does not exist', () => {
    writeGlobal('global-only', `
name: global-only
model: qwen2:7b
`)
    const profile = loadProfile('global-only')
    expect(profile).not.toBeNull()
    expect(profile!.model).toBe('qwen2:7b')
  })

  it('returns null for malformed YAML', () => {
    writeGlobal('bad-yaml', `
name: bad-yaml
  invalid:
    - [unclosed bracket
  this is not valid yaml: :::
`)
    const result = loadProfile('bad-yaml')
    expect(result).toBeNull()
  })

  it('parses profile with tools and capabilities', () => {
    writeGlobal('full-profile', `
name: full-profile
model: deepseek-coder-v2:33b
tools:
  allowed:
    - Read
    - Write
    - Edit
  denied:
    - WebSearch
capabilities:
  tool_use: native
  thinking: simulated
  vision: false
system_prompt_append: |
  You are a code-focused assistant.
`)
    const profile = loadProfile('full-profile')
    expect(profile).not.toBeNull()
    expect(profile!.tools).toEqual({
      allowed: ['Read', 'Write', 'Edit'],
      denied: ['WebSearch'],
    })
    expect(profile!.capabilities).toEqual({
      tool_use: 'native',
      thinking: 'simulated',
      vision: false,
    })
    expect(profile!.system_prompt_append).toContain('code-focused assistant')
  })

  it('parses profile with extends field', () => {
    writeGlobal('child-profile', `
name: child-profile
extends: base-ollama
model: codellama:13b
`)
    const profile = loadProfile('child-profile')
    expect(profile).not.toBeNull()
    expect(profile!.extends).toBe('base-ollama')
    expect(profile!.model).toBe('codellama:13b')
  })

  it('supports .yaml extension in addition to .yml', () => {
    fs.mkdirSync(globalDir(), { recursive: true })
    fs.writeFileSync(path.join(globalDir(), 'yaml-ext.yaml'), `
name: yaml-ext
model: mistral:7b
`)
    const profile = loadProfile('yaml-ext')
    expect(profile).not.toBeNull()
    expect(profile!.model).toBe('mistral:7b')
  })
})

// ---- the bundled default ----

describe('the profile that ships with the engine', () => {
  // Every test in this block runs with HOME and cwd pointed at empty temp
  // directories, which is the fresh-clone condition: no ~/.cynco, no
  // .cynco/profiles. Nothing here writes a profile file.

  it('resolves without a user profile, an env var, or a home directory', () => {
    const profile = loadProfile('default')
    expect(
      profile,
      'engine/profiles/templates/default.yaml is unreachable again — a fresh clone ' +
        'has no profile, so config.ts resolves null and main.ts exits 1 on "No model specified"',
    ).not.toBeNull()
    expect(profile!.name).toBe('default')
  })

  it('names a model, which is the field main.ts exits on when it is missing', () => {
    const profile = loadProfile('default')
    expect(typeof profile!.model).toBe('string')
    expect(profile!.model!.length).toBeGreaterThan(0)
  })

  it('is found relative to the engine, not to the working directory', () => {
    // cwd is a temp dir with no engine/ in it. A fallback built from
    // process.cwd() would pass every other test in this block while failing
    // for any user who runs the engine from outside the repo — which is all of
    // them.
    expect(process.cwd()).not.toBe(origCwd)
    expect(loadProfile('default')).not.toBeNull()
  })

  it('yields to a project-local profile of the same name', () => {
    writeProject('default', 'name: default\nmodel: project-model:13b\n')
    expect(loadProfile('default')!.model).toBe('project-model:13b')
  })

  it('yields to a global profile of the same name', () => {
    writeGlobal('default', 'name: default\nmodel: global-model:7b\n')
    expect(loadProfile('default')!.model).toBe('global-model:7b')
  })

  it('does not invent profiles it does not ship', () => {
    // Guards the guard: a fallback that returned something for any name would
    // satisfy every assertion above.
    expect(loadProfile('no-such-bundled-profile')).toBeNull()
  })
})

// ---- listProfiles ----

describe('listProfiles', () => {
  it('lists the bundled profiles when the user has none', () => {
    // Not `[]`. A profile the loader will load is a profile `/model` must be
    // able to name, or the picker shows nothing while the engine runs on
    // something.
    expect(listProfiles()).toEqual(['default'])
  })

  it('lists profiles from global directory', () => {
    writeGlobal('alpha', 'name: alpha\nmodel: a\n')
    writeGlobal('beta', 'name: beta\nmodel: b\n')
    const names = listProfiles()
    expect(names.sort()).toEqual(['alpha', 'beta', 'default'])
  })

  it('lists profiles from all directories without duplicates', () => {
    writeGlobal('shared', 'name: shared\nmodel: g\n')
    writeProject('shared', 'name: shared\nmodel: p\n')
    writeProject('local-only', 'name: local-only\nmodel: l\n')
    const names = listProfiles()
    expect(names.sort()).toEqual(['default', 'local-only', 'shared'])
  })

  it('does not repeat a bundled name that the user has overridden', () => {
    writeProject('default', 'name: default\nmodel: mine\n')
    expect(listProfiles().filter(n => n === 'default')).toEqual(['default'])
  })

  it('handles .yaml and .yml extensions', () => {
    fs.mkdirSync(globalDir(), { recursive: true })
    fs.writeFileSync(path.join(globalDir(), 'one.yml'), 'name: one\n')
    fs.writeFileSync(path.join(globalDir(), 'two.yaml'), 'name: two\n')
    const names = listProfiles()
    expect(names.sort()).toEqual(['default', 'one', 'two'])
  })
})
