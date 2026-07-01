import { RepoGraph, type RankedDefinition } from '../retrieval/repoMap.js'

export type RepoMapDefinition = { file: string; name: string; kind: string }
export type RepoMapRelationship = { sourceFile: string; sourceName: string; target: string }

/**
 * Resolve an import specifier (e.g. './store', '../index/store', 'EventEmitter')
 * to one of the indexed file paths, by extension-insensitive suffix match.
 * Returns null when the specifier points outside the indexed project
 * (third-party packages, base classes that aren't local files).
 */
export function resolveSpecifier(specifier: string, indexedFiles: string[]): string | null {
  // Normalize: drop quotes, leading ./ and ../ segments, and any extension.
  let tail = specifier.trim().replace(/^['"]|['"]$/g, '')
  tail = tail.replace(/^(\.\.?\/)+/, '')
  tail = tail.replace(/\.(ts|tsx|js|jsx|py|rs|go|java)$/, '')
  if (!tail) return null

  let best: string | null = null
  for (const file of indexedFiles) {
    const fileNoExt = file.replace(/\.(ts|tsx|js|jsx|py|rs|go|java)$/, '')
    if (fileNoExt === tail || fileNoExt.endsWith('/' + tail)) {
      // Prefer the most specific (longest) match.
      if (best === null || file.length > best.length) best = file
    }
  }
  return best
}

/**
 * Build a symbol-level RepoGraph from indexed definitions + relationships.
 * Each import edge connects the importing symbol to every symbol defined in the
 * resolved target file, so heavily-imported files accumulate PageRank.
 */
export function buildRepoGraph(
  defs: RepoMapDefinition[],
  rels: RepoMapRelationship[],
  indexedFiles: string[],
): RepoGraph {
  const graph = new RepoGraph()
  for (const d of defs) graph.addDefinition(d.file, d.name, d.kind)

  const defsByFile = new Map<string, RepoMapDefinition[]>()
  for (const d of defs) {
    const list = defsByFile.get(d.file)
    if (list) list.push(d)
    else defsByFile.set(d.file, [d])
  }

  for (const r of rels) {
    const targetFile = resolveSpecifier(r.target, indexedFiles)
    if (!targetFile || targetFile === r.sourceFile) continue
    const targetDefs = defsByFile.get(targetFile)
    if (!targetDefs) continue
    for (const td of targetDefs) {
      graph.addReference(r.sourceFile, r.sourceName, targetFile, td.name)
    }
  }

  return graph
}

/** Format a ranked-definition list as a system-context repo-map block. */
export function formatRepoMap(ranked: RankedDefinition[]): string {
  if (ranked.length === 0) return ''
  const lines = ranked.map(r => `  ${r.file} :: ${r.name} (${r.kind})`)
  return `[Repo map] Most important symbols by reference graph (PageRank):\n${lines.join('\n')}`
}
