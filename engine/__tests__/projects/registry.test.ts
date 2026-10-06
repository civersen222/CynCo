import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { readRegistry, rebuildRegistry, upsertRegistry, touchOpened } from '../../projects/registry.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cynco-registry-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('registry', () => {
  it('is empty and rebuilt for a fresh home, then lists created projects', () => {
    const first = readRegistry(home)
    expect(first.registry).toEqual({ version: 1, projects: [] })
    expect(first.rebuilt).toBe(true)
    const a = createProject(home, { name: 'A' })
    upsertRegistry(home, { slug: a.slug, name: a.name, description: '', tags: [], createdAt: a.createdAt, lastOpenedAt: null, path: join(home, a.slug) })
    const second = readRegistry(home)
    expect(second.rebuilt).toBe(false)
    expect(second.registry.projects.map(p => p.slug)).toEqual(['a'])
  })
  it('rebuilds from the folders when the file is corrupt or stale', () => {
    const a = createProject(home, { name: 'A' })
    createProject(home, { name: 'B' })
    writeFileSync(join(home, 'registry.json'), '{not json', 'utf8')
    const r = readRegistry(home)
    expect(r.rebuilt).toBe(true)
    expect(r.registry.projects.map(p => p.slug).sort()).toEqual(['a', 'b'])
    // a folder removed by hand drops out on the next rebuild
    rmSync(join(home, 'b'), { recursive: true, force: true })
    expect(rebuildRegistry(home).projects.map(p => p.slug)).toEqual([a.slug])
  })
  it('treats a registry naming a missing folder as stale and rebuilds', () => {
    createProject(home, { name: 'A' })
    writeFileSync(join(home, 'registry.json'), JSON.stringify({ version: 1, projects: [{ slug: 'ghost', name: 'G', description: '', tags: [], createdAt: 'x', lastOpenedAt: null, path: join(home, 'ghost') }] }), 'utf8')
    const r = readRegistry(home)
    expect(r.rebuilt).toBe(true)
    expect(r.registry.projects.map(p => p.slug)).toEqual(['a'])
  })
  it('touchOpened stamps lastOpenedAt', () => {
    const a = createProject(home, { name: 'A' })
    rebuildRegistry(home)
    touchOpened(home, a.slug, () => '2026-10-05T12:00:00.000Z')
    expect(readRegistry(home).registry.projects[0].lastOpenedAt).toBe('2026-10-05T12:00:00.000Z')
    expect(existsSync(join(home, 'registry.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(home, 'registry.json'), 'utf8')).version).toBe(1)
  })
})
