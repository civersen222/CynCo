import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  projectsHome, slugify, uniqueSlug, createProject, readProject, readInstructions, writeInstructions,
  readFileIndex, writeFileIndex, appendJournal, readJournal, isInside, sha256Of, projectDir, SLUG_RE,
} from '../../projects/layout.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cynco-projects-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('projectsHome', () => {
  it('reads LOCALCODE_PROJECTS_HOME and falls back to ~/cynco-projects', () => {
    expect(projectsHome({ LOCALCODE_PROJECTS_HOME: 'C:/x/projects' })).toBe('C:/x/projects')
    expect(projectsHome({})).toMatch(/cynco-projects$/)
  })
})

describe('slugs', () => {
  it('lower-cases, strips, collapses and caps at 64', () => {
    expect(slugify('Front Garden Diorama!')).toBe('front-garden-diorama')
    expect(slugify('  --Recipes: Bread & Butter-- ')).toBe('recipes-bread-butter')
    expect(slugify('x'.repeat(100)).length).toBe(64)
    expect(slugify('***')).toBe('project')
  })
  it('de-duplicates with -2, -3', () => {
    const taken = new Set(['diorama', 'diorama-2'])
    expect(uniqueSlug('Diorama', s => taken.has(s))).toBe('diorama-3')
    expect(uniqueSlug('Other', s => taken.has(s))).toBe('other')
  })
})

describe('createProject', () => {
  it('lays out every file and folder the spec names', () => {
    const meta = createProject(home, { name: 'Front Garden Diorama', description: 'a diorama', instructions: 'Be concrete.', tags: ['garden'] })
    expect(meta.slug).toBe('front-garden-diorama')
    const dir = join(home, meta.slug)
    for (const p of ['project.json', 'instructions.md', 'knowledge', 'knowledge/index.json', 'chats', 'artifacts', 'artifacts/index.json', 'plan.md', 'inbox', 'journal.md', '.gitignore']) {
      expect(existsSync(join(dir, p))).toBe(true)
    }
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.cynco/\n')
    expect(readInstructions(home, meta.slug)).toBe('Be concrete.')
    expect(readProject(home, meta.slug)).toEqual(meta)
    expect(readJournal(dir)[0]).toMatchObject({ event: 'created' })
  })
  it('writes a one-line hint when instructions are empty', () => {
    const meta = createProject(home, { name: 'Bare' })
    const text = readFileSync(join(home, meta.slug, 'instructions.md'), 'utf8')
    expect(text).toMatch(/^<!-- /)
    expect(readInstructions(home, meta.slug)).toBe('')
  })
  it('returns null for a missing project and round-trips instructions', () => {
    expect(readProject(home, 'nope')).toBeNull()
    const meta = createProject(home, { name: 'Bread' })
    writeInstructions(home, meta.slug, 'Always metric.')
    expect(readInstructions(home, meta.slug)).toBe('Always metric.')
  })
})

describe('file index and journal', () => {
  it('reads an empty index for a fresh project and round-trips records', () => {
    const meta = createProject(home, { name: 'Idx' })
    const dir = join(home, meta.slug)
    expect(readFileIndex(dir, 'knowledge')).toEqual({ files: {} })
    const idx = { files: { 'a.md': { sha256: 'x', addedAt: '2026-10-05T00:00:00.000Z', origin: 'pasted' as const, indexed: true, chunks: 2 } } }
    writeFileIndex(dir, 'knowledge', idx)
    expect(readFileIndex(dir, 'knowledge')).toEqual(idx)
  })
  it('appends one journal line per event, newest last on disk, newest first on read', () => {
    const meta = createProject(home, { name: 'J' })
    const dir = join(home, meta.slug)
    let n = 0
    const now = () => `2026-10-05T00:00:0${n++}.000Z`
    appendJournal(dir, 'knowledge.added', 'cookbook.pdf (uploaded)', now)
    appendJournal(dir, 'history.failed', 'git: fatal: not a repo', now)
    const lines = readFileSync(join(dir, 'journal.md'), 'utf8').trim().split('\n')
    expect(lines[lines.length - 1]).toBe('- 2026-10-05T00:00:01.000Z history.failed — git: fatal: not a repo')
    expect(readJournal(dir, 2).map(e => e.event)).toEqual(['history.failed', 'knowledge.added'])
  })
})

describe('projectDir and readProject refuse a slug that is not SLUG_RE', () => {
  // Task 8 fix round 1: a slug decoded from `..%2Foutside` (or `..%5Coutside`
  // on win32) must never resolve a path outside the projects home, whatever
  // called it — the dashboard route validates it too (a first layer), but
  // every api.ts function goes through these two so a caller that bypasses
  // the route is covered as well.
  it('projectDir throws a named Error instead of joining outside home', () => {
    expect(() => projectDir(home, '../outside')).toThrow(/bad slug/)
    expect(() => projectDir(home, '..\\outside')).toThrow(/bad slug/)
    expect(SLUG_RE.test('../outside')).toBe(false)
  })
  it('readProject returns null rather than reading outside home', () => {
    expect(readProject(home, '../outside')).toBeNull()
  })
})

describe('isInside and sha256Of', () => {
  it('refuses .. escapes and sibling folders, accepts the root itself', () => {
    const root = join(home, 'p')
    expect(isInside(root, join(root, 'knowledge', 'a.md'))).toBe(true)
    expect(isInside(root, root)).toBe(true)
    expect(isInside(root, join(home, 'p2', 'a.md'))).toBe(false)
    expect(isInside(root, join(root, '..', 'other'))).toBe(false)
  })
  it('hashes strings and bytes identically', () => {
    expect(sha256Of('abc')).toBe(sha256Of(new TextEncoder().encode('abc')))
    expect(sha256Of('abc')).toHaveLength(64)
  })
})
