import type { SearchEngine } from '../types.js'

let engines: Map<string, SearchEngine> = new Map()

export function registerEngine(engine: SearchEngine): void {
  engines.set(engine.name, engine)
}

export function getEngine(name: string): SearchEngine | undefined {
  return engines.get(name)
}

export function getAllEngines(): SearchEngine[] {
  return [...engines.values()]
}

export async function getHealthyEngines(): Promise<SearchEngine[]> {
  const checks = await Promise.all(
    [...engines.values()].map(async e => ({
      engine: e,
      healthy: await e.healthCheck(),
    }))
  )
  return checks.filter(c => c.healthy).map(c => c.engine)
}

export function resetEngines(): void {
  engines = new Map()
}

/** Register all built-in engines. Call once at startup. */
export function initEngines(): void {
  const { DuckDuckGoEngine } = require('./duckduckgo.js')
  const { WikipediaEngine } = require('./wikipedia.js')
  const { ArXivEngine } = require('./arxiv.js')
  const { PubMedEngine } = require('./pubmed.js')
  const { GitHubEngine } = require('./github.js')
  const { SearXNGEngine } = require('./searxng.js')

  registerEngine(new DuckDuckGoEngine())
  registerEngine(new WikipediaEngine())
  registerEngine(new ArXivEngine())
  registerEngine(new PubMedEngine())
  registerEngine(new GitHubEngine())
  registerEngine(new SearXNGEngine())
}
