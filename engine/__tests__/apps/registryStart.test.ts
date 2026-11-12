// The `start` recipe on a registry entry (docs/decisions/2026-11-11-local-llm-apps.md, decision 7):
// written by hand, so read tolerantly, and kept by everything else that writes the file.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetDebt, readDisplaced } from '../../apps/displace.js'
import { findApp, loadRegistry, saveOllamaApp, saveOllamaFinding, setAppManaged } from '../../apps/registry.js'

let dir = ''
const fresh = (): string => { dir = mkdtempSync(join(tmpdir(), 'cynco-registry-start-')); return dir }
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const ROOT = 'C:\\Users\\o\\dndai'
const dndai = (start: unknown) => ({ id: 'dndai', name: 'dndai', root: ROOT, script: 'scripts/start-llm.sh', launch: { exe: 'bash', args: ['scripts/start-llm.sh'], cwd: ROOT }, source: 'by hand', start })

describe('a start recipe in apps.json', () => {
  it('is read with its steps in order, on either kind of app', () => {
    const file = join(fresh(), 'apps.json')
    const steps = [
      { name: 'search service', check: { exe: 'sc', args: ['query', 'search'] }, exe: 'C:\\Tools\\search.exe', keep: true, waitSeconds: 180 },
      { name: 'database', port: 5433, exe: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu-24.04', '--exec', 'sleep', 'infinity'], always: true },
      { name: 'model server', model: true, port: 8081 },
    ]
    writeFileSync(file, JSON.stringify({
      apps: [dndai({ steps, open: 'http://localhost:3000', icon: 'web/src/app/favicon.ico' })],
      ollamaApps: [{ id: 'game', name: 'game', root: 'C:\\g', models: ['m'], start: { steps: [{ name: 'game', exe: 'python', args: ['-m', 'g'] }] } }],
    }))
    const r = loadRegistry(file)
    expect(r.apps[0].start).toEqual({
      steps: [{ ...steps[0], args: [] }, steps[1], steps[2]],
      open: 'http://localhost:3000',
      icon: 'web/src/app/favicon.ico',
    })
    expect(r.ollamaApps[0].start).toEqual({ steps: [{ name: 'game', exe: 'python', args: ['-m', 'g'] }] })
    expect(findApp('game', r)?.name).toBe('game')
    expect(findApp('dndai', r)?.root).toBe(ROOT)
    expect(findApp('nosuch', r)).toBeNull()
  })

  it('drops what is not a step and what is not a recipe, and keeps the entry', () => {
    const file = join(fresh(), 'apps.json')
    writeFileSync(file, JSON.stringify({
      apps: [dndai({ steps: [null, { port: 1 }, { name: 'web app', port: 'three thousand', exe: 7, args: 'npm', check: { exe: 'x' }, waitSeconds: -1 }, 'x'], open: 5 })],
      ollamaApps: [{ id: 'a', name: 'a', root: 'C:\\a', models: [], start: 'yes' }, { id: 'b', name: 'b', root: 'C:\\b', models: [], start: { steps: 'none' } }],
    }))
    const r = loadRegistry(file)
    expect(r.apps[0].start).toEqual({ steps: [{ name: 'web app' }] })
    expect(r.ollamaApps.map(a => 'start' in a)).toEqual([false, false])
  })

  it('survives the writes that are not about it: a switch of manage, a model added, a search remembered', () => {
    const file = join(fresh(), 'apps.json')
    const start = { steps: [{ name: 'web app', port: 3000, exe: 'cmd.exe', args: ['/c', 'npm', 'run', 'dev'], cwd: 'web' }], open: 'http://localhost:3000' }
    writeFileSync(file, JSON.stringify({ apps: [dndai(start)], ollamaApps: [{ id: 'game', name: 'game', root: 'C:\\g', models: ['m'], start }, { id: 'plain', name: 'plain', root: 'C:\\p', models: [] }] }))
    expect(setAppManaged('dndai', false, file)).toBe(true)
    saveOllamaApp({ id: 'game', name: 'game', root: 'C:\\g', models: ['n'], manage: true, source: 'discovered' }, file)
    saveOllamaFinding({ model: 'm', projects: [], at: '2026-11-11T00:00:00.000Z' }, file)
    const r = loadRegistry(file)
    expect(r.apps[0]).toMatchObject({ manage: false, start })
    expect(r.ollamaApps.find(a => a.id === 'game')).toMatchObject({ models: ['m', 'n'], start })
    // An entry without a recipe is written back without a `start` key at all.
    expect(JSON.parse(readFileSync(file, 'utf-8')).ollamaApps.map((a: { id: string }) => [a.id, 'start' in a]).sort()).toEqual([['game', true], ['plain', false]])
  })
})

describe('forgetDebt', () => {
  it('drops what is owed to one app and leaves the rest', () => {
    const file = join(fresh(), 'displaced-apps.json')
    const debt = (appId: string) => ({ appId, name: appId, root: `C:\\${appId}`, port: 8081, at: '2026-11-11T00:00:00.000Z', by: 'the chat engine', launch: { exe: 'bash', args: ['x.sh'], cwd: `C:\\${appId}` } })
    writeFileSync(file, JSON.stringify([debt('dndai'), debt('other')]))
    expect(forgetDebt('dndai', file)).toBe(true)
    expect(readDisplaced(file).map(d => d.appId)).toEqual(['other'])
    expect(forgetDebt('dndai', file)).toBe(false)
    expect(forgetDebt('dndai', join(dir, 'missing.json'))).toBe(false)
  })
})
