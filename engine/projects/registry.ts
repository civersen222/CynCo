/**
 * engine/projects/registry.ts — the cache of projects under a home.
 *
 * `registry.json` is a cache, never the truth: a missing, unparsable or stale
 * file (one that names a folder that is gone, or misses one that exists) is
 * rebuilt by scanning the home for folders with a readable project.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProject, type ProjectMeta } from './layout.js'

export type RegistryEntry = { slug: string; name: string; description: string; tags: string[]; createdAt: string; lastOpenedAt: string | null; path: string }
export type Registry = { version: 1; projects: RegistryEntry[] }

function registryPath(home: string): string { return join(home, 'registry.json') }

function write(home: string, reg: Registry): void {
  mkdirSync(home, { recursive: true })
  const p = registryPath(home)
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
}

function entryFor(home: string, meta: ProjectMeta, lastOpenedAt: string | null): RegistryEntry {
  return { slug: meta.slug, name: meta.name, description: meta.description, tags: meta.tags, createdAt: meta.createdAt, lastOpenedAt, path: join(home, meta.slug) }
}

export function rebuildRegistry(home: string): Registry {
  mkdirSync(home, { recursive: true })
  let previous: Registry | null = null
  try {
    if (existsSync(registryPath(home))) previous = JSON.parse(readFileSync(registryPath(home), 'utf8')) as Registry
  } catch (e) {
    console.log(`[projects] registry unreadable, rebuilding: ${e instanceof Error ? e.message : String(e)}`)
  }
  const opened = new Map((previous?.projects ?? []).map(p => [p.slug, p.lastOpenedAt] as const))
  const projects: RegistryEntry[] = []
  for (const name of readdirSync(home, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const meta = readProject(home, name.name)
    if (meta) projects.push(entryFor(home, meta, opened.get(meta.slug) ?? null))
  }
  projects.sort((a, b) => a.slug.localeCompare(b.slug))
  const reg: Registry = { version: 1, projects }
  write(home, reg)
  return reg
}

function parse(home: string): Registry | null {
  const p = registryPath(home)
  if (!existsSync(p)) return null
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as Registry
    if (!v || v.version !== 1 || !Array.isArray(v.projects)) return null
    return v
  } catch (e) {
    console.log(`[projects] registry.json unparsable: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** Is the cached registry exactly the set of folders on disk? */
function isFresh(home: string, reg: Registry): boolean {
  const onDisk = new Set(
    existsSync(home)
      ? readdirSync(home, { withFileTypes: true }).filter(d => d.isDirectory() && readProject(home, d.name)).map(d => d.name)
      : [],
  )
  const listed = new Set(reg.projects.map(p => p.slug))
  if (onDisk.size !== listed.size) return false
  for (const s of onDisk) if (!listed.has(s)) return false
  return true
}

export function readRegistry(home: string): { registry: Registry; rebuilt: boolean } {
  const cached = parse(home)
  if (cached && isFresh(home, cached)) return { registry: cached, rebuilt: false }
  return { registry: rebuildRegistry(home), rebuilt: true }
}

export function upsertRegistry(home: string, entry: RegistryEntry): void {
  const reg = parse(home) ?? { version: 1, projects: [] }
  const i = reg.projects.findIndex(p => p.slug === entry.slug)
  if (i >= 0) reg.projects[i] = entry; else reg.projects.push(entry)
  reg.projects.sort((a, b) => a.slug.localeCompare(b.slug))
  write(home, reg)
}

export function touchOpened(home: string, slug: string, now: () => string = () => new Date().toISOString()): void {
  const { registry } = readRegistry(home)
  const e = registry.projects.find(p => p.slug === slug)
  if (!e) return
  e.lastOpenedAt = now()
  write(home, registry)
}
